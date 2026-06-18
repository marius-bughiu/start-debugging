---
title: "Миграция с FutureBuilder на Riverpod AsyncNotifier во Flutter (flutter_riverpod 3.3.2)"
description: "Пошаговая миграция со встроенного виджета FutureBuilder на Riverpod AsyncNotifier в реальном приложении Flutter: вынесите асинхронную работу из build, представьте её как провайдер, выполняйте отрисовку через .when() или сопоставление с образцом switch и добавьте методы обновления и мутации. Проверено на Flutter 3.44, Dart 3.x, flutter_riverpod 3.3.2."
pubDate: 2026-06-18
updatedDate: 2026-06-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "riverpod"
lang: "ru"
translationOf: "2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-18
---

Перевод экрана с `FutureBuilder` на Riverpod `AsyncNotifier` обычно занимает от 30 до 60 минут на экран, и большая часть этого времени уходит на удаление кода, а не на его написание. Что ломается: Future, который вы раньше создавали внутри `build`, переезжает в провайдер, виджет теряет шаблонный код `StatefulWidget`, а любая ручная логика повтора через `setState` заменяется на `ref.invalidate`. Это стоит делать в тот момент, когда тех же данных требует второй виджет, когда вам нужно кеширование между переходами или когда нужно инициировать обновление откуда-то ещё, а не из того виджета, которому принадлежит `FutureBuilder`. Если экран действительно владеет одноразовым Future, который больше никто не трогает, оставьте его как `FutureBuilder` -- эта миграция здесь ничего вам не даёт.

В этом руководстве используются Flutter 3.44, Dart 3.x и `flutter_riverpod` 3.3.2. Сниппеты с генерацией кода предполагают `riverpod_annotation` 3.x и `riverpod_generator` 3.x с `build_runner`.

## Зачем уходить от FutureBuilder

- **Future перестаёт пересоздаваться при каждой перестройке.** `FutureBuilder`, чей `future:` собирается встроенно, повторно запускает свою асинхронную работу каждый раз, когда родитель перестраивается. `AsyncNotifier` собирается один раз и кеширует результат, пока вы его не инвалидируете. (Если вы пока остаётесь на `FutureBuilder`, исправление именно этого бага рассмотрено в [как не дать FutureBuilder пересоздавать свой Future](/ru/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).)
- **Данные становятся общими.** Два виджета, наблюдающие за одним провайдером, попадают в кеш, а не делают два отдельных сетевых вызова.
- **У обновления и мутации появляется настоящее место.** Pull-to-refresh, повтор при ошибке и оптимистичные обновления становятся методами на notifier вместо гимнастики с `setState` в виджете.
- **Ошибки типизированы, а не проглатываются.** `AsyncValue` несёт `loading`, `data` и `error` (с трассировкой стека) как полноценные состояния, с которыми вы выполняете сопоставление с образцом.

## Что ломается

| Область | До (`FutureBuilder`) | После (`AsyncNotifier`) | Серьёзность |
| --- | --- | --- | --- |
| Где живёт Future | Создаётся в `build` или `initState` | Метод `build()` у notifier | высокая |
| Тип виджета | Обычно `StatefulWidget` | `ConsumerWidget` (без состояния) | средняя |
| Отрисовка загрузки/ошибки | `snapshot.connectionState` + `snapshot.hasError` | `AsyncValue.when` или `switch` | средняя |
| Повтор | Перестройка + пересоздание Future | `ref.invalidate(provider)` | низкая |
| Мутации | `setState` после `await` | метод + `AsyncValue.guard` | средняя |
| Отмена при dispose | Ручные проверки `mounted` | Автоматически через `ref.onDispose` | низкая |

Единственный по-настоящему высокосерьёзный пункт -- это где живёт Future: всё остальное следует из его переноса.

## Предполётный чеклист

- `flutter --version` сообщает 3.44 или новее, Dart 3.x.
- `flutter_riverpod: ^3.3.2` присутствует в `pubspec.yaml`. Если вам нужна генерация кода, также добавьте `riverpod_annotation: ^3.0.0`, а в `dev_dependencies` добавьте `riverpod_generator: ^3.0.0` и `build_runner`.
- Ваше приложение обёрнуто в `ProviderScope` на корневом уровне. Если нет, это нулевой шаг:

```dart
// Flutter 3.44, flutter_riverpod 3.3.2
void main() {
  runApp(const ProviderScope(child: MyApp()));
}
```

- Выберите один виджет для миграции первым. Не конвертируйте всё приложение в одном коммите. Прогоняйте дымовой тест каждого экрана по ходу дела.

## Отправная точка: встроенный FutureBuilder

Вот шаблон, от которого мы уходим. Экран профиля загружает пользователя и вручную отрисовывает три состояния. Запечённый в нём баг -- классический: `repo.fetchUser(userId)` запускается снова при каждой перестройке, потому что Future создаётся внутри `build`.

```dart
// Flutter 3.44, Dart 3.x -- the BEFORE
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context) {
    final repo = UserRepository();
    return FutureBuilder<User>(
      future: repo.fetchUser(userId), // re-runs on every rebuild
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return Center(child: Text('Failed: ${snapshot.error}'));
        }
        final user = snapshot.data!;
        return Text(user.name);
      },
    );
  }
}
```

## Шаги миграции

1. **Объявите провайдер.** Перенесите асинхронный вызов в notifier. Есть два способа его написать; выберите один и придерживайтесь его по всей кодовой базе.

**Стиль с генерацией кода (рекомендуется для нового кода):**

```dart
// flutter_riverpod 3.3.2, riverpod_annotation 3.x
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'profile_controller.g.dart';

@riverpod
class ProfileController extends _$ProfileController {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }
}
```

Параметр `userId` у `build` делает это семейством: `profileControllerProvider(userId)` даёт вам один кешированный notifier на каждый id. Запустите генератор и убедитесь, что он создаёт файл `.g.dart` без ошибок:

```bash
# verify: the build completes and emits profile_controller.g.dart
dart run build_runner build --delete-conflicting-outputs
```

**Ручной стиль (без генерации кода):**

```dart
// flutter_riverpod 3.3.2
final profileControllerProvider =
    AsyncNotifierProvider.family<ProfileController, User, String>(
  ProfileController.new,
);

class ProfileController extends FamilyAsyncNotifier<User, String> {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }
}
```

Оба варианта создают провайдер, значением которого является `AsyncValue<User>`. Метод `build` у notifier запускается один раз на каждый `userId`, и результат кешируется до инвалидации. Обратите внимание, что вы больше не конструируете `UserRepository()` вручную: внедрите его через другой провайдер, чтобы он был тестируемым и общим.

2. **Преобразуйте виджет в `ConsumerWidget`.** `StatefulWidget`/`StatelessWidget` становится `ConsumerWidget`, а `build` получает `WidgetRef`. Прочитайте провайдер через `ref.watch`, затем отрисуйте `AsyncValue`.

```dart
// flutter_riverpod 3.3.2 -- the AFTER
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key, required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final userAsync = ref.watch(profileControllerProvider(userId));
    return userAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (err, stack) => Center(child: Text('Failed: $err')),
      data: (user) => Text(user.name),
    );
  }
}
```

Проверьте: выполните горячий перезапуск экрана. Он должен загрузить данные ровно один раз. Перейдите на другой экран и обратно -- повторной загрузки быть не должно (кеш жив, пока что-то удерживает провайдер смонтированным). Это поведение с единственной загрузкой и есть весь смысл миграции.

3. **Отрисовка через сопоставление с образцом switch (необязательно, но чище).** Сопоставление с образцом Dart 3 читается лучше, чем `.when()`, для некоторых команд и позволяет держать устаревшие данные видимыми во время обновления. Полный разбор этих шаблонов находится в [показе состояний загрузки и ошибки с AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), но коротко:

```dart
// Dart 3.x switch over AsyncValue
final userAsync = ref.watch(profileControllerProvider(userId));
return switch (userAsync) {
  AsyncData(:final value) => Text(value.name),
  AsyncError(:final error) => Text('Failed: $error'),
  _ => const Center(child: CircularProgressIndicator()),
};
```

Проверьте: это компилируется без предупреждения `non-exhaustive switch`. Ветка `_` обрабатывает `AsyncLoading`.

4. **Замените повтор на `ref.invalidate`.** Старый путь повтора пересоздавал Future перестройкой. Теперь повтор -- одна строка. Добавьте кнопку в ветку ошибки:

```dart
// flutter_riverpod 3.3.2
error: (err, stack) => Center(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text('Failed: $err'),
      ElevatedButton(
        onPressed: () => ref.invalidate(profileControllerProvider(userId)),
        child: const Text('Retry'),
      ),
    ],
  ),
),
```

`ref.invalidate` сбрасывает кешированное значение и заново запускает `build`, что переводит `AsyncValue` обратно в `loading`, а затем в `data` или `error`. Проверьте: вызовите ошибку (отключите сеть), нажмите Retry с включённой сетью, убедитесь, что происходит переход из loading в data.

5. **Добавьте мутации через `AsyncValue.guard`.** Это возможность, которой у `FutureBuilder` никогда не было. Чтобы обновить пользователя и отразить результат, добавьте метод к notifier. `AsyncValue.guard` оборачивает асинхронный вызов так, что выброшенное исключение становится `AsyncError` вместо необработанного падения.

```dart
// flutter_riverpod 3.3.2
@riverpod
class ProfileController extends _$ProfileController {
  @override
  Future<User> build(String userId) {
    return ref.watch(userRepositoryProvider).fetchUser(userId);
  }

  Future<void> rename(String newName) async {
    final repo = ref.read(userRepositoryProvider);
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() async {
      await repo.rename(userId, newName);
      return repo.fetchUser(userId);
    });
  }
}
```

Вызывайте его из виджета через `ref.read(...).rename(...)` внутри колбэка (используйте `read`, а не `watch`, в колбэках). Проверьте: запустите переименование, посмотрите, как UI переходит в loading, а затем показывает новое имя; запустите неудачное переименование и убедитесь, что отрисовывается состояние ошибки, а не выбрасывается исключение.

## Проверка

Прогоните этот чеклист после миграции экрана:

- `flutter analyze` не сообщает новых предупреждений, и если вы использовали генерацию кода, `dart run build_runner build` завершается чисто.
- Экран загружает данные ровно один раз при первом открытии (добавьте print в репозиторий или понаблюдайте за вкладкой сети).
- Переход на другой экран и обратно не вызывает повторной загрузки, если вы не инвалидируете.
- Ветка ошибки отрисовывается при принудительном сбое, а Retry восстанавливает работу.
- `flutter test` проходит. Провайдеры тривиально тестируемы: переопределите `userRepositoryProvider` фейком в `ProviderContainer` и проверьте `AsyncValue`.

```dart
// flutter_test + flutter_riverpod 3.3.2
test('loads the user', () async {
  final container = ProviderContainer(overrides: [
    userRepositoryProvider.overrideWithValue(FakeUserRepository()),
  ]);
  addTearDown(container.dispose);

  final user = await container.read(profileControllerProvider('42').future);
  expect(user.name, 'Ada');
});
```

## План отката

Эта миграция обратима для каждого экрана, потому что вы можете конвертировать по одному виджету за раз. Чтобы откатить один экран, восстановите виджет `FutureBuilder` и удалите его провайдер; ничто другое от него не зависит, если вы выполняли миграцию инкрементально. Единственная дверь в одну сторону -- это удаление старой обвязки `StatefulWidget` сразу на множестве экранов в одном коммите -- не делайте так. Держите миграцию каждого экрана в его собственном коммите, чтобы откат был однострочным `git revert`.

## Подводные камни, на которые мы наткнулись

**`ref.watch` внутри колбэков не перестраивает ничего полезного.** В обработчике `onPressed` используйте `ref.read`. `watch` предназначен для `build`; использование его в колбэке подписывает в неподходящий момент и часто становится источником путаницы «моя кнопка не обновляет экран».

**Параметр семейства должен быть стабильным.** `profileControllerProvider(userId)` ключует кеш по `userId`. Если вы случайно передадите свежесконструированный объект (новый экземпляр `User`, map) вместо ключа, равного по значению, вы будете получать свежий notifier при каждой перестройке, и кеш никогда не сработает. Используйте примитивы или типы с корректным `==`.

**Уничтоженный `ref` после await.** Если мутация выполняет await и провайдер уничтожается на лету (пользователь ушёл с экрана), обращение к `ref` после этого выбрасывает исключение. Riverpod 3 ясно сигнализирует об этом; исправление и точное сообщение приведены в [исправлении «Cannot use ref after the widget was disposed»](/ru/2026/06/fix-cannot-use-ref-after-the-widget-was-disposed-in-flutter-riverpod/). Защититесь через `ref.mounted`, если вам нужно обратиться к `ref` после await в длинной мутации.

**Провайдер уничтожается слишком рьяно.** По умолчанию провайдер без слушателей уничтожается. Если вы уходите с экрана и возвращаетесь и видите нежелательную повторную загрузку, это auto-dispose делает свою работу. Намеренно держите его живым через `ref.keepAlive()` внутри `build` или примите повторную загрузку как корректное поведение кеша.

**Не смешивайте это с состоянием пакета `provider`.** Если ваше приложение где-то ещё использует устаревший пакет `provider`, мигрируйте его отдельно; два варианта сосуществуют, но размывают ментальную модель. [Миграция с provider на Riverpod](/ru/2026/06/migrate-from-provider-to-riverpod-in-flutter/) рассматривает этот путь. А если вы всё ещё решаете, является ли `AsyncNotifier` вообще правильным выбором для конкретного виджета, [руководство по выбору между FutureBuilder и Riverpod AsyncValue](/ru/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) проводит границу.

## Источники

- [Migrating from 2.0 to 3.0](https://riverpod.dev/docs/3.0_migration) -- официальное руководство по миграции Riverpod для унифицированного `Ref` и изменений notifier.
- [(Async)NotifierProvider](https://riverpod.dev/docs/providers/notifier_provider) -- канонический контракт `AsyncNotifier` и `build()`.
- [What's new in Riverpod 3.0](https://riverpod.dev/docs/whats_new) -- список возможностей и ломающих изменений 3.0.
- [flutter_riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod) -- подтверждение версии 3.3.2.
</content>
</invoke>
