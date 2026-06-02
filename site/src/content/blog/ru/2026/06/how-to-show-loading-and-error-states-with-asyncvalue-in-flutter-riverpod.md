---
title: "Как показать состояния загрузки и ошибки с AsyncValue в Flutter Riverpod"
description: "Отображайте состояния загрузки, данных и ошибки из единственного AsyncValue в Riverpod 3. Используйте AsyncNotifier и AsyncValue.guard для мутаций, .when() и сопоставление с образцом через switch для UI, сохраняйте предыдущие данные при обновлении и мигрируйте устаревший паттерн StateNotifier. Проверено на flutter_riverpod 3.x, Flutter 3.44, Dart 3.x."
pubDate: 2026-06-02
template: how-to
tags:
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
  - "how-to"
lang: "ru"
translationOf: "2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod"
translatedBy: "claude"
translationDate: 2026-06-02
---

Кратко: асинхронный provider в Riverpod выдаёт вам `AsyncValue<T>` -- единый объект, который всегда находится ровно в одном из трёх состояний (данные, загрузка или ошибка). Вы отображаете все три из одного места через `value.when(data: ..., loading: ..., error: ...)` или через `switch` из Dart 3 по `AsyncData` / `AsyncLoading` / `AsyncError`. Эти состояния вы производите из `AsyncNotifier`, чей `build` возвращает `Future`, и безопасно изменяете их с помощью `AsyncValue.guard`, который превращает выброшенное исключение в `AsyncError` вместо сбоя. Если вы на старом `StateNotifier`, сторона отображения идентична, как только вы выставляете `AsyncValue` в качестве состояния. Это руководство проверено на `flutter_riverpod` 3.x (линейка 3.0 вышла в начале 2026 года), Flutter 3.44 и Dart 3.x.

Этот паттерн важен потому, что почти каждый экран реального приложения асинхронен: он что-то загружает, загрузка может быть в процессе, и загрузка может завершиться неудачей. Команды, пишущие это вручную, заканчивают с тремя отдельными полями (`isLoading`, `data`, `errorMessage`), клубком ветвей `if` и классическим багом, когда `isLoading` равен `false`, но `data` всё ещё `null`, потому что ранний возврат забыл переключить флаг. `AsyncValue` делает недопустимые состояния непредставимыми: не существует "идёт загрузка и при этом есть ошибка и при этом есть данные", потому что тип -- запечатанное объединение. Вы обрабатываете три случая, которые компилятор заставляет вас обработать, и на этом всё.

## Три состояния, и почему объединение лучше трёх булевых значений

`AsyncValue<T>` -- это запечатанный класс с тремя конкретными подтипами:

- `AsyncData<T>` несёт `value` типа `T`.
- `AsyncLoading<T>` означает, что идёт загрузка.
- `AsyncError<T>` несёт `error` (`Object`) и `stackTrace`.

Поскольку класс запечатан, анализатор знает, что список подтипов закрыт, поэтому `switch` по ним является исчерпывающим без ветки по умолчанию. В этом весь замысел: вместо того чтобы при каждой перестройке реконструировать "в каком я состоянии" из мешка полей, допускающих null, вы выполняете сопоставление с образцом по значению, чей тип уже кодирует ответ.

У него также есть удобные геттеры, к которым вы будете обращаться постоянно:

- `isLoading`, `hasValue`, `hasError` -- булевы значения.
- `value` -- это `T?`, допускающий null (он может быть не-null даже пока `isLoading` равен true, что важно при обновлении, см. ниже).
- `valueOrNull` -- безопасный аксессор, который никогда не бросает.
- `requireValue` возвращает значение или бросает `AsyncValueIsLoadingException` / повторно бросает ошибку. Используйте его, только когда вы уже доказали, что находитесь в состоянии данных.
- `isRefreshing` и `isReloading` различают принудительное обновление и пересчёт, вызванный зависимостями.

## Конкретный экран: список статей, который может загружаться и падать

Вот минимальная реалистичная конфигурация: репозиторий, который загружает список, provider, который его выставляет, и виджет, который отображает все три состояния. Я использую вариант с генерацией кода и `riverpod_annotation` -- рекомендуемый способ объявления providers в линейке 3.x.

```dart
// flutter_riverpod 3.x, riverpod_annotation 3.x, Dart 3.x
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'articles_provider.g.dart';

class Article {
  const Article(this.id, this.title);
  final String id;
  final String title;
}

@riverpod
class Articles extends _$Articles {
  @override
  Future<List<Article>> build() async {
    final repo = ref.watch(articleRepositoryProvider);
    return repo.fetchAll(); // may throw on a network failure
  }
}
```

Метод `build` возвращает `Future<List<Article>>`. Riverpod оборачивает этот future за вас: пока он в ожидании, `ref.watch(articlesProvider)` -- это `AsyncLoading`; когда он завершается, `AsyncData`; если он бросает, `AsyncError`. Вы никогда не конструируете эти состояния вручную для начальной загрузки. Вы просто возвращаете данные или даёте исключению распространиться.

Если вы не используете генерацию кода, ручная форма -- это та же структура класса без аннотации:

```dart
// Manual (no code-gen) equivalent. flutter_riverpod 3.x
final articlesProvider =
    AsyncNotifierProvider<Articles, List<Article>>(Articles.new);

class Articles extends AsyncNotifier<List<Article>> {
  @override
  Future<List<Article>> build() async {
    final repo = ref.watch(articleRepositoryProvider);
    return repo.fetchAll();
  }
}
```

## Отображение всех трёх состояний через `.when()`

`.when()` -- самый прямой способ отобразить `AsyncValue` на виджеты. Он принимает три обязательных колбэка:

```dart
// flutter_riverpod 3.x
class ArticleListView extends ConsumerWidget {
  const ArticleListView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final articles = ref.watch(articlesProvider);

    return articles.when(
      data: (list) => ListView.builder(
        itemCount: list.length,
        itemBuilder: (_, i) => ListTile(title: Text(list[i].title)),
      ),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (err, stack) => ErrorView(
        message: _humanMessage(err),
        onRetry: () => ref.invalidate(articlesProvider),
      ),
    );
  }
}
```

Обратите внимание на три вещи. Во-первых, `ref.invalidate(articlesProvider)` -- это то, как кнопка повтора заново выполняет `build`; она выбрасывает закэшированное состояние и пересчитывает. `ref.refresh` делает то же самое и возвращает новое значение, если оно вам нужно. Во-вторых, колбэк `error` получает как объект ошибки, так и её трассировку стека, поэтому вы можете записать трассировку в журнал и показать пользователю дружелюбное сообщение: никогда не выводите `err.toString()` прямо на экран. В-третьих, `_humanMessage` -- это место, где вы переводите типы исключений в текст, что согласуется с правильной классификацией сбоя; см. [как изящно обрабатывать сетевые ошибки в приложении Flutter](/ru/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) для сопоставления исключения с сообщением, которое относится туда.

## Альтернатива из Dart 3: сопоставление с образцом через `switch`

Поскольку `AsyncValue` запечатан, вы можете выполнять сопоставление с образцом прямо над ним. Многие команды предпочитают это в Riverpod 3, потому что читается оно естественно и позволяет деструктурировать в одну строку:

```dart
// Dart 3.x switch expression over the sealed AsyncValue
Widget build(BuildContext context, WidgetRef ref) {
  final articles = ref.watch(articlesProvider);

  return switch (articles) {
    AsyncData(:final value) => ArticleList(items: value),
    AsyncError(:final error) => ErrorView(message: _humanMessage(error)),
    _ => const Center(child: CircularProgressIndicator()),
  };
}
```

Ветка `_` ловит `AsyncLoading`. Функционально это эквивалентно `.when()`, но лучше компонуется, когда вы хотите добавить охранные условия (например, `AsyncData(:final value) when value.isEmpty => const EmptyState()`). Используйте то, что ваша команда считает более читаемым; они производят одинаковый UI.

## Мутации: почему вам нужен `AsyncValue.guard`

Начальная загрузка автоматическая, но кнопка, создающая или удаляющая статью, -- это ручной переход состояния, и именно там незащищённый код падает. Неправильный способ -- вызвать репозиторий напрямую и дать исключению ускользнуть в дерево виджетов. Правильный способ ставит состояние в загрузку, выполняет работу внутри `AsyncValue.guard` и присваивает результат:

```dart
// flutter_riverpod 3.x
@riverpod
class Articles extends _$Articles {
  @override
  Future<List<Article>> build() => ref.watch(articleRepositoryProvider).fetchAll();

  Future<void> add(String title) async {
    final repo = ref.read(articleRepositoryProvider);

    // Show loading while keeping the current list visible (see "refresh" below).
    state = const AsyncLoading<List<Article>>().copyWithPrevious(state);

    // guard converts a thrown exception into AsyncError instead of crashing.
    state = await AsyncValue.guard(() async {
      await repo.create(title);
      return repo.fetchAll();
    });
  }
}
```

`AsyncValue.guard` -- это аналог автоматической обёртки в `build`. Он выполняет ваш колбэк, возвращает `AsyncData` при успехе и `AsyncError` (с захваченной трассировкой стека) при сбое, поэтому обрыв сети во время `add` переключает экран на ваш UI ошибки вместо выброса необработанного исключения. Вызов `copyWithPrevious(state)` -- это то, что позволяет списку оставаться на экране во время мутации вместо мигания полноэкранного спиннера; новый `AsyncLoading` несёт старое значение, поэтому `value` всё ещё заполнен.

## Сохранение данных на экране во время обновления

Это деталь, на которой спотыкаются все. Когда вы делаете `ref.refresh` асинхронного provider, состояние ненадолго возвращается к загрузке. Если вы наивно показываете спиннер для каждого состояния загрузки, "потяните для обновления" оставляет весь экран пустым на один кадр. Riverpod 3 обрабатывает это с помощью двух флагов в `.when()`:

- `skipLoadingOnRefresh` по умолчанию равен `true`. Во время `ref.refresh` (явного обновления, инициированного пользователем) `.when()` продолжает вызывать ваш колбэк `data` с предыдущим значением вместо `loading`.
- `skipLoadingOnReload` по умолчанию равен `false`. Когда provider перезагружается из-за изменения зависимости, вы по умолчанию получаете колбэк `loading`.

Так что из коробки "потяните для обновления" сохраняет старый список видимым, пока загружается новый, чего вы и хотите. Если же вы хотите, чтобы спиннер появлялся при обновлении, отключите это:

```dart
articles.when(
  skipLoadingOnRefresh: false, // show the loading callback even on refresh
  data: (list) => ArticleList(items: list),
  loading: () => const Center(child: CircularProgressIndicator()),
  error: (err, _) => ErrorView(message: _humanMessage(err)),
);
```

Конкретно для элемента "потяните для обновления" идиоматичная комбинация -- сохранить `skipLoadingOnRefresh: true` (чтобы список оставался на месте) и управлять `RefreshIndicator` через возвращаемый future:

```dart
RefreshIndicator(
  onRefresh: () => ref.refresh(articlesProvider.future),
  child: articles.when(
    data: (list) => ListView(/* ... */),
    loading: () => const Center(child: CircularProgressIndicator()),
    error: (err, _) => ErrorView(message: _humanMessage(err)),
  ),
);
```

Ожидание `articlesProvider.future` через `await` заставляет спиннер самого `RefreshIndicator` крутиться, пока не придут новые данные, в то время как тело продолжает показывать старые данные под ним. Это то поведение, которого ожидают пользователи.

Одна оговорка, которую стоит знать: есть [открытый issue](https://github.com/rrousselGit/riverpod/issues/4670), где `skipLoadingOnRefresh` и `skipLoadingOnReload` не всегда ведут себя так, как задокументировано, потому что обновление может также запустить перезагрузку. Если ваше обновление неожиданно мигает спиннером, это взаимодействие -- первое, что нужно проверить.

## Где вписывается устаревший `StateNotifier`

Поисковый запрос, который приводит сюда людей, часто сочетает `AsyncValue` со `StateNotifier`, поэтому стоит быть точным насчёт положения дел в 2026 году. Начиная с Riverpod 2.0, `Notifier` и `AsyncNotifier` заменили `StateNotifier`, а в Riverpod 3 старые типы `StateNotifier` и `StateNotifierProvider` были вынесены из основного barrel-файла в `package:flutter_riverpod/legacy.dart`. Они всё ещё работают, но больше не являются рекомендуемым API.

Если у вас есть `StateNotifier`, выставляющий асинхронные данные, трюк, делающий отображение идентичным всему вышеописанному, -- сделать его состояние `AsyncValue` самостоятельно:

```dart
// Legacy pattern. Import from the legacy barrel in flutter_riverpod 3.x.
import 'package:flutter_riverpod/legacy.dart';

class ArticlesNotifier extends StateNotifier<AsyncValue<List<Article>>> {
  ArticlesNotifier(this._repo) : super(const AsyncLoading()) {
    _load();
  }
  final ArticleRepository _repo;

  Future<void> _load() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(_repo.fetchAll);
  }
}

final articlesProvider =
    StateNotifierProvider<ArticlesNotifier, AsyncValue<List<Article>>>(
  (ref) => ArticlesNotifier(ref.watch(articleRepositoryProvider)),
);
```

Поскольку `state` -- это `AsyncValue<List<Article>>`, код виджета вообще не меняется: `ref.watch(articlesProvider).when(...)` работает в точности как раньше. Урок в том, что `AsyncValue` -- это контракт UI; `AsyncNotifier` против `StateNotifier` -- лишь о том, как вы его производите. Когда вы всё же мигрируете, `AsyncNotifier` устраняет шаблонный код (нет ручного конструктора `_load`, нет ручного `AsyncLoading` в конструкторе), потому что `build` делает это за вас. [Официальное руководство по миграции со StateNotifier](https://riverpod.dev/docs/migration/from_state_notifier) проходит механическую замену, а более широкое руководство [как мигрировать приложение Flutter с GetX на Riverpod](/ru/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) охватывает тот же перевод `Notifier` / `AsyncNotifier` в контексте полной миграции.

## Распространённые подводные камни

**Не читайте `requireValue` в состоянии загрузки.** Он бросает `AsyncValueIsLoadingException`. Используйте его только внутри ветки `data` или после проверки `hasValue`. Когда вам просто нужно запасное значение, используйте `valueOrNull ?? const []`.

**`isLoading` равен true при обновлении, а не только при начальной загрузке.** Если вы напишете `if (value.isLoading) return Spinner()` до проверки `hasValue`, вы будете очищать экран при каждом обновлении. Предпочитайте `.when()` (который уважает `skipLoadingOnRefresh`) или проверяйте `value.isLoading && !value.hasValue`, чтобы отличить "первую загрузку" от "обновления с уже присутствующими данными".

**Пустой список -- это данные, а не загрузка.** Успешная загрузка, возвращающая `[]`, -- это `AsyncData([])`, поэтому обрабатывайте пустой случай внутри ветки `data` (представление "Добавьте свою первую статью"), а не трактуя пустоту как всё-ещё-загружается.

**Ошибкам во время мутации нужен `guard`, а ошибкам в `build` -- нет.** Внутри `build` просто `throw` (или дайте репозиторию бросить); Riverpod их захватывает. Внутри императивного метода вроде `add` вы должны обернуть в `AsyncValue.guard`, иначе исключение ускользнёт из notifier и станет необработанной ошибкой.

**Используйте типизированную модель ошибок, а не `toString()`.** Сопоставляйте типы исключений с обращённым к пользователю текстом в одном вспомогательном методе. Если ваша модель данных использует запечатанные классы или `Freezed`, та же выгода исчерпываемости, которую вы получаете от `AsyncValue`, применима и к вашим доменным ошибкам; см. [Dart records против классов Freezed](/ru/2026/05/dart-records-vs-freezed-classes/), чтобы понять, когда каждый из них -- правильный инструмент для их моделирования.

## Тестирование трёх состояний

Поскольку состояние -- это просто значение, тесты прямолинейны: создайте `ProviderContainer`, переопределите репозиторий подделкой и сделайте утверждения о `AsyncValue`.

```dart
// flutter_test + flutter_riverpod 3.x
test('emits AsyncError when the repository throws', () async {
  final container = ProviderContainer(overrides: [
    articleRepositoryProvider.overrideWithValue(ThrowingRepository()),
  ]);
  addTearDown(container.dispose);

  // Wait for the first build to settle.
  await container.read(articlesProvider.future).catchError((_) => <Article>[]);

  final state = container.read(articlesProvider);
  expect(state, isA<AsyncError>());
});
```

Переопределите репозиторий так, чтобы он возвращал данные, ошибку или никогда не завершающийся future, и вы сможете делать утверждения о каждой ветке, которую отображает ваш UI. В этом практическая выгода от вталкивания всех трёх состояний в одно типизированное значение: provider, виджет и тест говорят на одном языке. Когда вы выясняете, почему переход состояния дёргается, а не неверен, временная шкала кадров в DevTools подсказывает, является ли причиной перестройка; см. [как профилировать рывки в приложении Flutter с помощью DevTools](/ru/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/), чтобы её читать.

## Источники

- [Справочник класса AsyncValue](https://pub.dev/documentation/riverpod/latest/riverpod/AsyncValue-class.html), документация API Riverpod (`when`, `guard`, `requireValue`, `copyWithPrevious`).
- [Что нового в Riverpod 3.0](https://riverpod.dev/docs/whats_new) и [руководство по миграции с 2.0 на 3.0](https://riverpod.dev/docs/3.0_migration), riverpod.dev.
- [Миграция со StateNotifier](https://riverpod.dev/docs/migration/from_state_notifier), riverpod.dev.
- [Issue #4670 о поведении skipLoadingOnRefresh / skipLoadingOnReload](https://github.com/rrousselGit/riverpod/issues/4670), rrousselGit/riverpod.
