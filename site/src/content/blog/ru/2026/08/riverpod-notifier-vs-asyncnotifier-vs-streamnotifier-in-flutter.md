---
title: "Riverpod Notifier vs AsyncNotifier vs StreamNotifier во Flutter: какой класс наследовать?"
description: "Выбор определяется типом возврата build(): T означает Notifier, FutureOr<T> означает AsyncNotifier, Stream<T> означает StreamNotifier. Здесь матрица выбора, иерархия типов, которая это объясняет, и подводные камни фильтрации по == и перезаписи состояния. Проверено на flutter_riverpod 3.4.2 и Flutter 3.44.2."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "riverpod"
  - "state-management"
lang: "ru"
translationOf: "2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-15
---

Выбор между `Notifier`, `AsyncNotifier` и `StreamNotifier` определяется одной вещью: типом возврата вашего метода `build()`. Если он возвращает `T`, наследуйте `Notifier<T>`. Если он возвращает `Future<T>` или обычный `T`, который вы, возможно, захотите позже сделать асинхронным, наследуйте `AsyncNotifier<T>`. Если ваш источник данных продолжает присылать новые значения после первого, наследуйте `StreamNotifier<T>`. Всё остальное (методы мутации, `ref.watch` внутри `build`, семейства, автоматическое освобождение) во всех трёх работает одинаково. Всё в этой статье проверено на `flutter_riverpod` 3.4.2 и Flutter 3.44.2 (stable, 2026-06-10) с Dart 3.12.2, а для раздела о генерации кода использован `riverpod_generator` 4.0.4.

## Матрица выбора

| | `Notifier<T>` | `AsyncNotifier<T>` | `StreamNotifier<T>` |
| --- | --- | --- | --- |
| `build()` возвращает | `T` | `FutureOr<T>` | `Stream<T>` |
| Провайдер отдаёт | `T` | `AsyncValue<T>` | `AsyncValue<T>` |
| Класс провайдера | `NotifierProvider` | `AsyncNotifierProvider` | `StreamNotifierProvider` |
| Состояние загрузки | никогда | сначала `AsyncLoading` | сначала `AsyncLoading` |
| Значения после первого | пишете вы | пишете вы | пишет поток |
| Модификатор `.future` | нет | да | да |
| Помощник `update()` | нет | да | да |
| Сигнатура `updateShouldNotify` | `(T, T)` | `(AsyncValue<T>, AsyncValue<T>)` | `(AsyncValue<T>, AsyncValue<T>)` |
| Заменяет (Riverpod 2.x) | `StateNotifier`, `StateProvider` | `FutureProvider` + методы | `StreamProvider` + методы |

Именно на последней строке чаще всего спотыкаются. `AsyncNotifier` не является "асинхронной версией `Notifier`" в смысле надмножества. Это `FutureProvider`, у которого есть куда положить методы мутации. `StreamNotifier` это `StreamProvider` с тем же дополнением. Если методы мутации вам не нужны, обычный `FutureProvider` или `StreamProvider` остаётся более компактным ответом.

## Почему тип возврата и есть всё правило

Это не стилистическое соглашение. Это навязано иерархией классов в `riverpod` 3.4.2. Каждый из трёх публичных классов объявляет абстрактный `build()` с фиксированным типом возврата:

```dart
// package:riverpod/src/providers/notifier/orphan.dart, riverpod 3.4.2
abstract class Notifier<ValueT> extends $Notifier<ValueT> {
  @visibleForOverriding
  ValueT build();
}

// package:riverpod/src/providers/async_notifier/orphan.dart
abstract class AsyncNotifier<StateT> extends $AsyncNotifier<StateT> {
  @visibleForOverriding
  FutureOr<StateT> build();
}

// package:riverpod/src/providers/stream_notifier/orphan.dart
abstract class StreamNotifier<ValueT> extends $StreamNotifier<ValueT> {
  @visibleForOverriding
  Stream<ValueT> build();
}
```

При неверном выборе вы получите ошибку компиляции, а не сюрприз во время выполнения. Вот точные диагностики `flutter analyze` на Flutter 3.44.2:

```text
error - 'WrongOne.build' ('Future<int> Function()') isn't a valid override of
        'Notifier.build' ('int Function()') - invalid_override

error - 'WrongTwo.build' ('Stream<int> Function()') isn't a valid override of
        'AsyncNotifier.build' ('FutureOr<int> Function()') - invalid_override

error - 'Ok' doesn't conform to the bound 'AsyncNotifier<int>' of the type
        parameter 'NotifierT' - type_argument_not_matching_bounds
```

Третья ошибка это несовпадение пары: подкласс `Notifier`, переданный в `AsyncNotifierProvider`. Класс notifier и класс провайдера связаны обобщённым ограничением, так что смешать их не получится.

## Когда выбирать Notifier

Берите `Notifier<T>`, когда начальное состояние доступно синхронно и ничто за пределами ваших собственных методов его не меняет.

```dart
// flutter_riverpod 3.4.2, Flutter 3.44.2, Dart 3.12.2
class Counter extends Notifier<int> {
  @override
  int build() => 0;

  void increment() => state++;
}

final counterProvider = NotifierProvider<Counter, int>(Counter.new);
```

`ref.watch(counterProvider)` даёт вам `int`, а не `AsyncValue<int>`. Нет ветки загрузки, которую надо отрисовывать, нет и ветки ошибки, и в этом весь смысл: выбранный фильтр, флаг изменённости формы, индекс выбранной вкладки, корзина покупок в памяти. Если вы ловите себя на том, что пишете `AsyncData(...)` вокруг значения, которое у вас уже есть, вы выбрали не тот базовый класс.

Что удивляет тех, кто пришёл со `StateNotifier`: `build()` может выполниться повторно. Если вы внутри него делаете `ref.watch` другого провайдера, изменение выше по цепочке заново выполняет `build()` и сбрасывает ваше состояние. Сам экземпляр notifier при этом сохраняется, поэтому поля экземпляра выживают:

```dart
// Verified: constructed once, built twice after the dependency changed.
expect(Instanced.built, 2);        // build() re-ran
expect(Instanced.constructed, 1);  // the object was not recreated
```

## Когда выбирать AsyncNotifier

Берите `AsyncNotifier<T>`, когда начальное состояние приходит из `Future`, а каждое следующее значение приходит из ваших собственных методов мутации.

```dart
// flutter_riverpod 3.4.2
class AsyncCounter extends AsyncNotifier<int> {
  @override
  Future<int> build() async {
    await Future<void>.delayed(const Duration(milliseconds: 10));
    return 0;
  }

  Future<void> increment() async {
    final current = await future;      // resolves to the latest non-loading value
    state = AsyncData(current + 1);
  }
}

final asyncCounterProvider =
    AsyncNotifierProvider<AsyncCounter, int>(AsyncCounter.new);
```

Геттер `future` внутри notifier и модификатор `.future` у провайдера оба приходят из миксина `$AsyncClassModifier`. Оттуда же и `update()`, эргономичная версия приведённого выше чтения-изменения-записи:

```dart
Future<void> increment() => update((current) => current + 1);
```

Одна деталь стоит внимания, потому что она меняет то, что ваш виджет отрисует на первом кадре: `build()` возвращает `FutureOr<T>`, поэтому вернуть значение синхронно допустимо, и в этом случае провайдер никогда не проходит через `AsyncLoading`.

```dart
class SyncishAsync extends AsyncNotifier<int> {
  @override
  int build() => 42;   // legal: FutureOr<int> accepts int
}

// Verified: the very first read is AsyncData(42), not AsyncLoading.
expect(container.read(syncishProvider), isA<AsyncData<int>>());
```

Это делает `AsyncNotifier` разумным вариантом по умолчанию для состояния, которое сегодня синхронно, но которое вы планируете позже спрятать за сетевым вызовом. Платой становится обёртка `AsyncValue`, которую придётся разворачивать в каждом виджете, поэтому для индекса вкладки я бы её не использовал. Механика аккуратной отрисовки этой обёртки та же, что описана в статье про [отображение состояний загрузки и ошибки через AsyncValue](/ru/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/).

## Когда выбирать StreamNotifier

Берите `StreamNotifier<T>`, когда источник продолжает присылать данные. Слушатель снимков Firestore, WebSocket, `Stream` из плагина, периодический таймер.

```dart
// flutter_riverpod 3.4.2
class Ticker extends StreamNotifier<int> {
  @override
  Stream<int> build() {
    final controller = StreamController<int>();
    var i = 0;
    final timer = Timer.periodic(const Duration(milliseconds: 5), (_) {
      controller.add(i++);
    });
    ref.onDispose(() {
      timer.cancel();
      controller.close();
    });
    return controller.stream;
  }
}

final tickerProvider = StreamNotifierProvider<Ticker, int>(Ticker.new);
```

Отличительное поведение в том, что состояние продолжает меняться без вашей записи в `state`. Если подписаться на такой провайдер и собрать эмиссии, получится `[0, 1, 2, ...]`, тогда как `AsyncNotifier` выдал бы ровно один `AsyncData` и на этом остановился.

Riverpod управляет подпиской за вас. Когда `build()` выполняется повторно из-за изменения отслеживаемой зависимости, предыдущая подписка отменяется до подписки на новый поток:

```dart
// Verified with a StreamController whose onCancel increments a counter.
expect(Feed.subscribes, 2);  // build re-ran, new stream
expect(Feed.cancels, 1);     // Riverpod cancelled the old subscription
```

Приведённый выше `ref.onDispose` всё равно нужен для ресурсов, которыми сам поток не владеет, например для `Timer`. Riverpod отменяет свою подписку на ваш поток; про таймер, который этот поток питает, он ничего не знает. Дисциплина здесь та же, что и при [освобождении контроллеров во Flutter во избежание утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

## AsyncNotifier и StreamNotifier это братья, а не родитель и потомок

В dartdoc `StreamNotifier` назван "вариантом `AsyncNotifier`", что читается как наследование. Это не так. Оба наследуют одну и ту же внутреннюю базу и различаются лишь одним обобщённым аргументом:

```dart
// package:riverpod/src/providers/async_notifier.dart, riverpod 3.4.2
abstract class $AsyncNotifier<ValueT> extends $AsyncNotifierBase<ValueT>
    with $AsyncClassModifier<ValueT, FutureOr<ValueT>> {}

// package:riverpod/src/providers/stream_notifier.dart
abstract class $StreamNotifier<ValueT> extends $AsyncNotifierBase<ValueT>
    with $AsyncClassModifier<ValueT, Stream<ValueT>> {}
```

`$AsyncNotifierBase<ValueT>` в обоих случаях наследует `AnyNotifier<AsyncValue<ValueT>, ValueT>`, поэтому оба отдают `AsyncValue<T>` и оба получают `future` и `update()`. Единственное различие в `CreatedT`: `FutureOr<ValueT>` против `Stream<ValueT>`. При этом `$Notifier<StateT>` наследует `$SyncNotifierBase<StateT>`, который наследует `AnyNotifier<StateT, StateT>`, поэтому у него тип состояния и тип значения совпадают.

Практическое следствие в том, что проверка типа на `AsyncNotifier` не сработает для `StreamNotifier`, и обобщённый вспомогательный код с `if (notifier is AsyncNotifier)` молча пропустит ваши провайдеры на основе потоков:

```dart
// Verified on riverpod 3.4.2
expect(Ticker(), isNot(isA<AsyncNotifier<int>>()));
expect(AsyncCounter(), isNot(isA<StreamNotifier<int>>()));
```

## Фильтрация по == задевает все три класса

В Riverpod 3.0 решение о том, уведомлять ли слушателей, унифицировали через `==`. Обычно об этом пишут как о проблеме `Notifier`, потому что классический симптом это изменение `List` на месте без перестроения UI. Это не проблема `Notifier`. Она касается `AsyncNotifier` и `StreamNotifier` тоже, потому что `AsyncValue.operator ==` сравнивает обёрнутое значение через `==`:

```dart
// package:riverpod/src/core/async_value.dart, riverpod 3.4.2
@override
bool operator ==(Object other) {
  return runtimeType == other.runtimeType &&
      other is AsyncValue<ValueT> &&
      other._loading == _loading &&
      other.valueFilled == valueFilled &&
      other._errorFilled == _errorFilled;
}
```

Поэтому оборачивание того же экземпляра `List` в свежий `AsyncData` даёт значение, которое `==` предыдущему состоянию, и уведомление отбрасывается:

```dart
// Verified: both of these are silent no-ops for listeners.
class AsyncTodoList extends AsyncNotifier<List<String>> {
  @override
  List<String> build() => <String>[];

  void addMutating(String v) {
    final list = state.requireValue..add(v);
    state = AsyncData(list);            // same list instance, == is true
  }

  void addReplacing(String v) =>
      state = AsyncData([...state.requireValue, v]);   // new list, notifies
}

final list = ['x'];
expect(AsyncData(list) == AsyncData(list), isTrue);
expect(AsyncData(['x']) == AsyncData(['x']), isFalse);
```

Решение одинаково во всех трёх классах: всегда присваивайте новый экземпляр коллекции вместо изменения и повторного присваивания. Аварийный выход тоже одинаков, но обратите внимание, что сигнатура меняется вместе с базовым классом, потому что `updateShouldNotify` принимает тип *состояния*, а не тип значения:

```dart
// Notifier<List<String>>
@override
bool updateShouldNotify(List<String> previous, List<String> next) => true;

// AsyncNotifier<List<String>> or StreamNotifier<List<String>>
@override
bool updateShouldNotify(
  AsyncValue<List<String>> previous,
  AsyncValue<List<String>> next,
) => true;
```

Если вы попали сюда после того, как поток загадочно перестал обновлять UI, та же первопричина подробнее разобрана в статье про [события StreamProvider, отфильтрованные по равенству в Riverpod 3.0](/ru/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## Подводный камень StreamNotifier: ваши записи перезаписываются

`StreamNotifier` наследует сеттер `state`, так что ничто не мешает вам туда присвоить. Но поток по-прежнему живой, и следующее событие побеждает:

```dart
// Verified against a StreamNotifier whose build() emits every 5ms.
container.read(tickerProvider.notifier).poke();       // state = AsyncData(999)
expect(container.read(tickerProvider).value, 999);    // holds, briefly

await Future<void>.delayed(const Duration(milliseconds: 20));
expect(container.read(tickerProvider).value, isNot(999));  // the stream won
```

Это не баг и не повод избегать методов мутации у `StreamNotifier`. Это повод сделать мутацию оптимистичной и дать потоку её подтвердить. Пишите в `state` ради немедленного отклика UI, отправляйте изменение на бэкенд и позвольте пришедшему обратно событию потока стать источником истины:

```dart
// flutter_riverpod 3.4.2
Future<void> send(String message) async {
  state = AsyncData([...(state.value ?? const []), message]);  // optimistic
  await _api.post(message);   // the server echoes this back down the stream
}
```

Если поток не возвращает ваши мутации обратно, ваша задача не имеет формы потока. Возьмите `AsyncNotifier` и управляйте состоянием сами.

## Генерация кода выбирает за вас

С `riverpod_generator` вы вообще не называете базовый класс. Вы ставите аннотацию `@riverpod`, наследуете сгенерированный `_$Foo`, а генератор читает тип возврата `build()`. Вот три класса, различающиеся только этим типом возврата, и соответствующие сгенерированные объявления от `riverpod_generator` 4.0.4:

```dart
// gen.dart
@riverpod
class Counter extends _$Counter {
  @override
  int build() => 0;
}

@riverpod
class AsyncCounter extends _$AsyncCounter {
  @override
  Future<int> build() async => 0;
}

@riverpod
class Ticker extends _$Ticker {
  @override
  Stream<int> build() => Stream.value(0);
}
```

```dart
// gen.g.dart, generated
final class CounterProvider extends $NotifierProvider<Counter, int> { ... }
abstract class _$Counter extends $Notifier<int> { ... }

final class AsyncCounterProvider
    extends $AsyncNotifierProvider<AsyncCounter, int> { ... }
abstract class _$AsyncCounter extends $AsyncNotifier<int> { ... }

final class TickerProvider extends $StreamNotifierProvider<Ticker, int> { ... }
abstract class _$Ticker extends $StreamNotifier<int> { ... }
```

Замените `Future<int> build()` на `Stream<int> build()`, перезапустите builder, и базовый класс сменится под вами без единой другой правки. Это самый весомый практический аргумент в пользу генерации кода именно в этом вопросе.

Одну асимметрию сгенерированный вывод делает наглядной: сгенерированные провайдеры освобождаются автоматически, написанные вручную нет.

```dart
// gen.g.dart: every generated provider passes isAutoDispose: true
CounterProvider._() : super(..., isAutoDispose: true, ...);

// Hand-written, verified on riverpod 3.4.2:
expect(counterProvider.isAutoDispose, isFalse);
expect(asyncCounterProvider.isAutoDispose, isFalse);
expect(tickerProvider.isAutoDispose, isFalse);
```

Для `StreamNotifier` эта разница обходится дорого: написанный вручную потоковый провайдер держит подписку открытой навсегда, как только кто-то его прочитал, потому что `NotifierProvider`, `AsyncNotifierProvider` и `StreamNotifierProvider` по умолчанию ставят `isAutoDispose` в `false`. Передайте `NotifierProvider(..., isAutoDispose: true)`, если хотите поведение как у сгенерированного, но без генерации.

## Ещё одна оговорка про версии

На Flutter 3.44.2 самые свежие пакеты сейчас не разрешаются вместе. `flutter_riverpod` 3.4.2 плюс любая версия `riverpod_generator` проваливает разрешение версий из-за `matcher` 0.12.19 и `test_api` 0.7.11, которые этот Flutter SDK фиксирует через `flutter_test`. Чисто разрешается комбинация `flutter_riverpod` 3.3.2 с `riverpod_annotation` 4.0.3 и `riverpod_generator` 4.0.4, именно из неё получен приведённый выше сгенерированный вывод. В правиле выбора класса между 3.3.2 и 3.4.2 нет никакой разницы, но при генерации кода ожидайте отставания на одну минорную версию от рантайм-пакета, пока ограничение SDK не догонит.

## Рекомендация

По умолчанию берите `AsyncNotifier` для всего, что затрагивает ввод-вывод, `Notifier` для всего остального, а `StreamNotifier` только тогда, когда источник действительно присылает больше одного значения. Цена выбора `AsyncNotifier` там, где хватило бы `Notifier`, это немного шума с разворачиванием `AsyncValue` в виджетах. Цена выбора `Notifier` там, где данные асинхронны, это поле `late`, `LateInitializationError` и ручной булев флаг загрузки, что строго хуже. А если вы используете генерацию кода, перестаньте об этом думать вовсе: пишите тот `build()`, который вам нужен, и пусть генератор выбирает.

## Похожие статьи

- [Какой пакет Riverpod ставить: riverpod, flutter_riverpod или hooks_riverpod](/ru/2026/07/riverpod-vs-flutter-riverpod-vs-hooks-riverpod-which-package-do-i-need/)
- [FutureBuilder и StreamBuilder в сравнении с AsyncValue из Riverpod](/ru/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
- [Полное руководство по миграции с Riverpod 2.x на 3.0](/ru/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/)
- [Перевод StatefulWidget с setState на Notifier из Riverpod](/ru/2026/07/migrate-a-setstate-statefulwidget-to-a-riverpod-notifier-in-flutter/)
- [Превращение FutureBuilder в AsyncNotifier из Riverpod](/ru/2026/06/migrate-from-futurebuilder-to-a-riverpod-asyncnotifier-in-flutter/)

## Источники

- [Что нового в Riverpod 3.0](https://riverpod.dev/docs/whats_new), про объединение notifier-классов и переход на `==` при фильтрации уведомлений.
- [riverpod 3.4.2 на pub.dev](https://pub.dev/packages/riverpod/versions/3.4.2), источник процитированных выше объявлений `Notifier`, `AsyncNotifier` и `StreamNotifier`.
- [flutter_riverpod 3.4.2 на pub.dev](https://pub.dev/packages/flutter_riverpod/versions/3.4.2).
- [riverpod_generator 4.0.4 на pub.dev](https://pub.dev/packages/riverpod_generator/versions/4.0.4), генератор, чей вывод показан в разделе о генерации кода.
