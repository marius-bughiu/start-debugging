---
title: "Переход с Riverpod 2.x на Riverpod 3.0 во Flutter"
description: "Пошаговое обновление с flutter_riverpod 2.x до 3.x: поднимите версии пакетов, перенесите StateProvider и его собратьев в legacy-импорт, откажитесь от ref-типов AutoDispose и Family, обработайте оборачивание в ProviderException и автоматический повтор, а также исправьте фильтрацию уведомлений по ==, которая молча теряет события StreamProvider. Проверено на Flutter 3.44, Dart 3.x, flutter_riverpod 3.3.2."
pubDate: 2026-07-09
updatedDate: 2026-07-09
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "ru"
translationOf: "2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-09
---

Обновление реального приложения с `flutter_riverpod` 2.x до 3.x обычно занимает полдня, и большая часть работы -- это механический поиск и замена. Линейка 3.0 вышла в сентябре 2025 года, а текущий релиз -- 3.3.2 (июнь 2026); это руководство проверено на этой версии с Flutter 3.44 (stable, май 2026) и Dart 3.x. Что действительно ломается: `StateProvider`, `StateNotifierProvider` и `ChangeNotifierProvider` переезжают за импорт `legacy.dart`, каждый подтип `Ref` (`FutureProviderRef`, `AutoDisposeNotifier`, `FamilyNotifier`) сворачивается в один тип, ошибки провайдеров теперь приходят обёрнутыми в `ProviderException`, а сами провайдеры теперь фильтруют уведомления по `==`. Последние два пункта вызывают сюрпризы во время выполнения, а не ошибки компиляции, поэтому читайте эти разделы внимательно. Если ваша кодовая база уже использует генерацию кода (`@riverpod`), менять придётся меньше, чем при написанных вручную объявлениях провайдеров.

## Зачем вообще обновляться

Riverpod 2.x всё ещё работает, поэтому доводы в пользу перехода должны быть конкретными:

- **Автоматический повтор** с экспоненциальной выдержкой встроен из коробки. `FutureProvider`, который падает на нестабильной сети, больше не остаётся в состоянии ошибки до тех пор, пока вы вручную не вызовете `ref.invalidate`.
- **`Ref.mounted`** заменяет самописный примесь "жив ли ещё этот провайдер после await", который таскало с собой каждое нетривиальное приложение. Полный шаблон смотрите в [проверке Ref.mounted после асинхронного разрыва](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/).
- **Единый тип `Ref`** и один `Notifier` на каждую форму. Больше никаких имён вроде `AutoDisposeFamilyAsyncNotifier`, которые читаются как стресс-тест для компилятора.
- **Офлайн-персистентность** и **мутации** появляются как экспериментальные API, так что состояние отправки форм и кеширование между перезапусками перестают быть тем, что вы строите вручную.

## Что ломается

| Область                     | Изменение                                                                           | Серьёзность |
| --------------------------- | ----------------------------------------------------------------------------------- | -------- |
| Legacy-провайдеры           | `StateProvider`, `StateNotifierProvider`, `ChangeNotifierProvider` требуют `legacy.dart` | высокая     |
| Подтипы Ref                 | `FutureProviderRef`, `StreamProviderRef` и т. д. все становятся единым `Ref`         | высокая     |
| Типы AutoDispose / Family   | `AutoDisposeNotifier`, `FamilyNotifier` удалены; используйте модификаторы на `Notifier` | высокая     |
| Распространение ошибок       | Чтения перебрасывают `ProviderException`, оборачивающий вашу исходную ошибку         | высокая     |
| Фильтрация уведомлений      | Все провайдеры используют `==`, чтобы решить, нужно ли уведомлять слушателей         | средняя   |
| Автоматический повтор       | Упавшие провайдеры по умолчанию повторяются с выдержкой                              | средняя   |
| `ProviderObserver`          | Колбэки принимают единый `ProviderObserverContext`                                   | средняя   |
| `AsyncValue.valueOrNull`    | Переименован в `value`; старый геттер `value`, бросавший исключение, убран           | низкая      |

## Предполётный чеклист

Прежде чем трогать хоть один провайдер:

1. Закоммитьте или спрячьте всё в stash. Эта миграция затрагивает много файлов, и вам нужен чистый `git diff` для ревью.
2. Убедитесь, что ваш Dart SDK версии 3.x. Riverpod 3.0 этого требует. Запустите `dart --version` и проверьте.
3. Если вы используете генерацию кода, убедитесь, что `build_runner` сначала чисто отрабатывает на текущем коде 2.x. Вам не нужно отлаживать ошибки генератора и ошибки миграции одновременно.
4. Отметьте, используете ли вы `riverpod_lint`. Он поставляет правила линтинга и помощник миграции `dart fix`, который автоматизирует несколько шагов ниже, так что его установка экономит ручные правки.

## Шаг 1: Поднимите версии пакетов

Обновите каждый пакет Riverpod в `pubspec.yaml` до линейки 3.x за один раз. Смесь пакетов 2.x и 3.x не разрешится.

```yaml
# pubspec.yaml -- flutter_riverpod 3.3.2, Dart 3.x
dependencies:
  flutter_riverpod: ^3.3.2
  riverpod_annotation: ^3.3.2   # only if you use code-generation

dev_dependencies:
  riverpod_generator: ^3.3.2    # only if you use code-generation
  riverpod_lint: ^3.3.2
  custom_lint: ^0.8.0
  build_runner: ^2.4.0
```

Затем разрешите зависимости:

```bash
# Flutter 3.44
flutter pub get
```

**Проверка:** `flutter pub deps | grep riverpod` показывает каждый пакет Riverpod на версии 3.x. Если pub жалуется на конфликт версий, значит транзитивная зависимость всё ещё удерживает `riverpod` на 2.x; запустите `flutter pub deps`, чтобы найти виновника.

## Шаг 2: Сначала запустите автоматические исправления

Riverpod 3.0 поставляет правила миграции `dart fix` через `riverpod_lint`. Запустите их прежде, чем делать что-либо вручную, потому что они справляются с нудными механическими переписываниями (переименования подтипов `Ref`, удаление префикса `AutoDispose`) сразу по всем файлам.

```bash
# preview the changes without writing them
dart fix --dry-run

# apply them
dart fix --apply
```

**Проверка:** перезапустите `dart fix --dry-run` и убедитесь, что специфичные для Riverpod исправления пропали из списка. Затем сделайте `git diff` и прочитайте, что изменилось. Инструмент хорош, но не всеведущ, поэтому оставшиеся шаги -- это части, которые он не может вывести сам.

## Шаг 3: Перенесите legacy-провайдеры за legacy-импорт

`StateProvider`, `StateNotifierProvider` и `ChangeNotifierProvider` всё ещё существуют, но теперь живут в отдельной библиотеке, чтобы основная поверхность импорта показывала только современный API. Если вы импортируете их из основного пакета, вы получите ошибку "undefined name".

```dart
// Riverpod 3.x
// Add this import wherever you still use the legacy providers:
import 'package:flutter_riverpod/legacy.dart';

// StateProvider itself is unchanged in behaviour:
final counterProvider = StateProvider<int>((ref) => 0);
```

Это осознанный толчок, а не предупреждение об устаревании, которое можно игнорировать вечно. Долгосрочный шаг -- переписать каждый `StateProvider` как `Notifier`, а каждый `StateNotifierProvider` как `Notifier` или `AsyncNotifier`, та же целевая форма, к которой вы придёте при [переходе с пакета provider](/2026/06/migrate-from-provider-to-riverpod-in-flutter/). Но делать это переписывание во время подъёма версии не обязательно. Добавьте импорт, добейтесь зелёного результата и конвертируйте позже.

**Проверка:** приложение компилируется. Сделайте grep по `legacy.dart` и убедитесь, что каждый файл, использующий legacy-провайдер, имеет импорт, и ни один файл не импортирует его без надобности (линтер отметит неиспользуемый импорт).

## Шаг 4: Сверните подтипы Ref и варианты Notifier

В 2.x провайдер, сгенерированный из кода, выдавал вам типизированный ref вроде `CounterRef`, а написанные вручную провайдеры использовали `FutureProviderRef<T>`, `StreamProviderRef<T>` и так далее. В 3.0 есть единый `Ref`. Проход `dart fix` обычно справляется с этим, но написанные вручную объявления, которые инструмент пропустил, нуждаются в правке.

```dart
// Riverpod 2.x
int example(ExampleRef ref) => 0;

Future<User> user(UserRef ref) async => fetchUser();
```

```dart
// Riverpod 3.x -- one Ref type for everything
int example(Ref ref) => 0;

Future<User> user(Ref ref) async => fetchUser();
```

То же объединение затрагивает нотификаторы на основе классов. `AutoDisposeNotifier`, `FamilyNotifier` и комбинаторный взрыв имён между ними исчезли. Вы выражаете то же поведение с помощью модификаторов на базовом `Notifier`:

```dart
// Riverpod 2.x
class TodosNotifier extends AutoDisposeAsyncNotifier<List<Todo>> {
  @override
  Future<List<Todo>> build() => fetchTodos();
}
final todosProvider =
    AutoDisposeAsyncNotifierProvider<TodosNotifier, List<Todo>>(
  TodosNotifier.new,
);
```

```dart
// Riverpod 3.x -- autoDispose is a modifier, not a base class
class TodosNotifier extends AsyncNotifier<List<Todo>> {
  @override
  Future<List<Todo>> build() => fetchTodos();
}
final todosProvider =
    AsyncNotifierProvider.autoDispose<TodosNotifier, List<Todo>>(
  TodosNotifier.new,
);
```

Параметры Family, которые раньше жили в `FamilyNotifier`, теперь приходят как обычные аргументы `build` (кодогенерация) или через модификатор `.family` (вручную). Если вы используете `@riverpod`, генератор берёт на себя всю обвязку, и вам нужно только перезапустить его.

**Проверка (для тех, кто использует кодогенерацию):** удалите сгенерированные файлы и пересоберите.

```bash
dart run build_runner build --delete-conflicting-outputs
```

Убедитесь, что ошибок генератора нет и что перегенерированные файлы `.g.dart` ссылаются на `Ref`, а не на старые типизированные ref.

## Шаг 5: Обработайте оборачивание в ProviderException

Это изменение с наибольшей вероятностью проскользнёт мимо проверки компиляции и сломается во время выполнения. В 3.0, когда `build` провайдера бросает исключение, а другой участок кода читает провайдер императивно, чтение не перебрасывает ваше исходное исключение. Оно перебрасывает `ProviderException`, который оборачивает его. Любой блок `on MyException catch`, который ловил исходный тип, перестаёт срабатывать.

```dart
// Riverpod 2.x -- this used to work
try {
  final user = await ref.read(userProvider.future);
} on NotFoundException catch (e) {
  showNotFound();
}
```

```dart
// Riverpod 3.x -- catch the wrapper, inspect .exception
try {
  final user = await ref.read(userProvider.future);
} on ProviderException catch (e) {
  if (e.exception is NotFoundException) {
    showNotFound();
  } else {
    rethrow;
  }
}
```

Развёрнутый путь -- это `AsyncValue`. Когда вы рендерите провайдер через `.when(error: ...)` или сопоставляете с образцом `AsyncError`, ошибка, которую вы там получаете, -- это ваше исходное исключение, а не обёртка. Так что UI-код, читающий состояние реактивно, не затронут; изменения нужны только императивному `ref.read(...future)` внутри `try`/`catch`. Отдельная статья про [ProviderException в Riverpod 3.0](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/) разбирает угловые случаи.

**Проверка:** сделайте grep по `ref.read(` в сочетании с `.future` внутри блоков `try`, а также по любой конструкции `catch`, которая называет доменное исключение. Добавьте тест, который заставляет провайдер бросить исключение, и проверяет, что ваш обработчик по-прежнему выполняется.

## Шаг 6: Исправьте фильтрацию уведомлений по ==

В 2.x у разных типов провайдеров были разные правила решения о том, когда уведомлять слушателей. В 3.0 все они используют `==`. Для состояния `Notifier` это обычно нормально, но больно бьёт по `StreamProvider` и `StreamNotifier`: если ваш поток эмитит объекты, равные по `==` (например, изменяемые классы, не переопределяющие равенство, или два значения, которые случайно оказываются равными), вторая эмиссия теперь отбрасывается как дубликат.

Проявление сбоя -- это UI, который перестаёт обновляться, хотя поток явно эмитит. Исправление в том, чтобы эмитируемый тип имел корректную семантику равенства. Если вы эмитите доменные объекты, дайте им равенство по значению (`record`, класс Freezed или написанные вручную `==`/`hashCode`). См. [записи Dart против классов Freezed](/2026/05/dart-records-vs-freezed-classes/), чтобы понять, к чему тянуться.

```dart
// Riverpod 3.x -- two distinct ticks that are == would be collapsed.
// A record gives structural equality so each tick is treated as new.
Stream<({int count, DateTime at})> ticks(Ref ref) async* {
  var n = 0;
  await for (final _ in Stream.periodic(const Duration(seconds: 1))) {
    yield (count: n++, at: DateTime.now());
  }
}
```

Если вам действительно нужно пропускать каждую эмиссию независимо от равенства, переопределите `updateShouldNotify` на `StreamNotifier`, чтобы он возвращал `true`.

**Проверка:** запустите приложение, понаблюдайте за любым виджетом, работающим от потока, и убедитесь, что он по-прежнему обновляется при каждой ожидаемой эмиссии. Здесь нет сигнала на этапе компиляции, поэтому нужен ручной дымовой тест.

## Шаг 7: Определитесь с автоматическим повтором

Упавшие провайдеры теперь повторяются автоматически: начальная задержка 200 мс, удваивающаяся вплоть до 6.4 секунды. Для большинства провайдеров, работающих с сетью, это улучшение. Но если у вас есть провайдер, чей сбой постоянен (ошибка валидации, 404, который никогда не станет 200), тихие повторы тратят вызовы и могут маскировать ошибку в UI на несколько секунд.

Отключите глобально на уровне области или для каждого провайдера:

```dart
// Riverpod 3.x -- disable retry everywhere
ProviderScope(
  retry: (retryCount, error) => null, // null delay = do not retry
  child: MyApp(),
)
```

```dart
// Or keep it, but stop retrying non-transient errors
ProviderScope(
  retry: (retryCount, error) {
    if (error is NotFoundException) return null;
    if (retryCount >= 3) return null;
    return Duration(milliseconds: 200 * (1 << retryCount));
  },
  child: MyApp(),
)
```

**Проверка:** направьте провайдер на эндпоинт, возвращающий 404, и убедитесь, что он не долбит сервер или что ваш предикат повтора замыкается накоротко, как задумано.

## Шаг 8: Обновите ProviderObserver и переименование valueOrNull

Если у вас есть кастомный `ProviderObserver` (аналитика, логирование), сигнатура его колбэков изменилась. Аргументы контейнера и провайдера слились в единый `ProviderObserverContext`.

```dart
// Riverpod 3.x
class LoggingObserver extends ProviderObserver {
  @override
  void didUpdateProvider(
    ProviderObserverContext context,
    Object? previousValue,
    Object? newValue,
  ) {
    debugPrint('${context.provider.name} -> $newValue');
  }
}
```

И маленькое: `AsyncValue.valueOrNull` переименован в `value`. Старый геттер `value` (который бросал исключение при загрузке/ошибке) убран. Если вы полагались на поведение с исключением, сопоставляйте с образцом случай `AsyncData`.

**Проверка:** анализатор отмечает каждое место вызова `valueOrNull`; проход `dart fix` из шага 2 обычно переписывает их, но убедитесь, что ни одного не осталось.

## Проверка: полный дымовой тест

После всех шагов пройдите чеклист от начала до конца:

- `flutter pub get` разрешается со всеми пакетами Riverpod на 3.x.
- `dart run build_runner build --delete-conflicting-outputs` выдаёт ноль ошибок (для пользователей кодогенерации).
- `flutter analyze` чист, никаких оставшихся ссылок на `AutoDispose`/`valueOrNull`/типизированные ref.
- `flutter test` проходит, включая новые тесты, которые вы добавили для обработки `ProviderException` и эмиссии потока.
- Вручную прогоните: экран, работающий от потока, экран ошибки и экран, вызывающий сбой провайдера, чтобы убедиться, что повтор, оборачивание и фильтрация по `==` ведут себя корректно.

## План отката

На практике эта миграция -- дверь в одну сторону. Как только вы напишете `import 'package:flutter_riverpod/legacy.dart'` и примете единый тип `Ref`, откат означает отмену изменений в каждом файле. Чистый откат -- это `git`, а не код: делайте всю миграцию в ветке, оставьте ветку 2.x нетронутой и сливайте только после того, как дымовой тест пройдёт. Не делайте полумиграцию и не выкатывайте её; кодовая база, где часть файлов на семантике 3.x, а часть -- на допущениях 2.x (особенно вокруг оборачивания ошибок), хуже, чем любая из версий по отдельности.

## Подводные камни, на которые мы наткнулись

- **Фильтрация по `==` невидима, пока не станет заметной.** `StreamProvider<List<Item>>`, работающий от списка, который тот же код изменяет на месте, эмитит один и тот же экземпляр списка дважды, и 3.0 отбрасывает второе уведомление. Эмитируйте свежий список (или тип, равный по значению) каждый раз.
- **`ref.read(provider.future)` в `catch` -- вот коварный случай.** Он нормально компилируется и выдаёт себя только тогда, когда провайдер действительно падает в продакшене. Ищите его на опережение.
- **`dart fix` не трогает ссылки на провайдеры, заданные строкой или собранные динамически.** Всё, что анализатор не видит статически, вы правите вручную.
- **Не обновляйте `riverpod`, не обновив `riverpod_generator` в связке.** Runtime 3.x с генератором 2.x производит код, ссылающийся на старые подтипы `Ref`, и не компилируется путаными способами.

## Похожее

- [Переход с provider на Riverpod во Flutter](/2026/06/migrate-from-provider-to-riverpod-in-flutter/)
- [Как проверить Ref.mounted после асинхронного разрыва во Flutter Riverpod 3](/2026/07/how-to-check-ref-mounted-after-an-async-gap-in-flutter-riverpod-3/)
- [Исправление: Riverpod 3.0 бросает ProviderException вместо исходной ошибки](/2026/07/fix-riverpod-3-0-throws-providerexception-instead-of-the-original-error/)
- [Provider против Riverpod против Bloc для управления состоянием во Flutter в 2026 году](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)
- [Переход с FutureBuilder на Riverpod AsyncNotifier во Flutter](/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)

## Источники

- [Migrating from 2.0 to 3.0, Riverpod docs](https://riverpod.dev/docs/3.0_migration)
- [What's new in Riverpod 3.0, Riverpod docs](https://riverpod.dev/docs/whats_new)
- [riverpod on pub.dev](https://pub.dev/packages/flutter_riverpod)
