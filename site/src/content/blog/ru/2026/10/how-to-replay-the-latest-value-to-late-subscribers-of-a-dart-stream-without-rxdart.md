---
title: "Как повторять последнее значение для поздних подписчиков потока Dart без BehaviorSubject из rxdart"
description: "Broadcast StreamController теряет все события, произошедшие до подписки. Вот замена BehaviorSubject без зависимостей на основе Stream.multi, расширение replayLatest() для уже существующих потоков, ускоренный вариант на async*, который молча теряет события, и нюанс с initialData у StreamBuilder. Всё проверено на Dart 3.12.2."
pubDate: 2026-10-18
template: how-to
tags:
  - "dart"
  - "flutter"
  - "streams"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart"
translatedBy: "claude"
translationDate: 2026-10-18
---

**Короткий ответ:** оберните `StreamController.broadcast()` в небольшой класс, который дополнительно хранит последнее значение, и отдавайте поток через `Stream.multi`. `Stream.multi` вызывает ваш обратный вызов `onListen` один раз для каждого подписчика и передаёт ему собственный `MultiStreamController`, поэтому вы можете выполнить `add` с кешированным значением только для нового слушателя, а затем пробрасывать события broadcast-потока. Это и есть всё поведение `BehaviorSubject` из rxdart, примерно в 40 строках на `dart:async`. `Stream.multi` есть в SDK с Dart 2.9, а каждый фрагмент ниже был запущен на Dart 3.12.2 (SDK, который поставляется с Flutter 3.44).

Дальше в статье показано, почему обычный broadcast-контроллер не справляется, приведён полный класс, расширение, которое превращает любой существующий поток в повторяющий, и граничные случаи, важные в приложении Flutter: ошибки, `close()`, пауза, отмена и первый кадр `StreamBuilder`.

## Почему broadcast-поток всё забывает

`StreamController` с одной подпиской буферизует события, пока кто-то не подпишется, но допускает ровно одного слушателя. Broadcast-контроллер допускает любое число слушателей, а платой за это становится отсутствие буферизации. Событие доставляется тем, кто подписан в момент его возникновения, и после этого исчезает.

```dart
// Dart 3.12.2
import 'dart:async';

Future<void> main() async {
  final controller = StreamController<int>.broadcast();
  controller.add(1);                 // nobody is listening: dropped
  await Future(() {});

  controller.stream.listen((v) => print('late listener got $v'));
  controller.add(2);
  await Future(() {});
}
// Output:
// late listener got 2
```

Это правильное поведение по умолчанию для данных в виде событий (нажатия, уведомления, строки журнала) и неправильное для данных в виде состояния. Если поток представляет "текущего пользователя" или "состояние соединения", виджет, подписавшийся после последнего изменения, ничего не покажет до следующего изменения, которого может и не случиться. В Flutter это обычно проявляется как `StreamBuilder`, застрявший на ветке загрузки на экране, на который вы перешли после того, как данные уже загрузились.

rxdart решает это с помощью `BehaviorSubject`, который помнит последнее событие и отправляет его каждому новому подписчику. Если вы уже зависите от rxdart, используйте его. Если вам нужно только это одно поведение, подключать ради него целую библиотеку реактивных расширений избыточно, а нужный примитив уже есть в SDK.

## Примитив: Stream.multi даёт каждому слушателю собственный контроллер

`Stream<T>.multi(void Function(MultiStreamController<T>) onListen, {bool isBroadcast = false})` создаёт поток, на который можно подписываться любое число раз. Каждый вызов `listen` запускает `onListen` с новым `MultiStreamController`, и всё, что вы передаёте в `add` этого контроллера, попадает только в эту одну подписку.

Именно такого обработчика на каждого слушателя и не хватает broadcast-контроллеру. `StreamController.broadcast(onListen: ...)` вызывает `onListen` только тогда, когда число слушателей меняется с нуля на один, поэтому второй, третий и сотый подписчики не получают обратного вызова, в котором можно было бы передать им кешированное значение.

Флаг `isBroadcast` не меняет поведение. Он лишь задаёт геттер `Stream.isBroadcast`, который проверяют некоторые потребители. Устанавливайте его в `true`, когда ваш поток ведёт себя как broadcast-поток (допускает нескольких слушателей, не буферизует прошлое для каждого слушателя сверх того, что вы повторяете), как и происходит здесь.

## Пошагово: BehaviorSubject без зависимостей

1. Держите broadcast-`StreamController` в качестве центра событий.
2. Рядом храните последнее значение (и признак того, что оно есть).
3. Отдавайте один экземпляр `Stream.multi`, у которого `onListen` сначала добавляет кешированное значение в контроллер нового подписчика, а затем пробрасывает ему события центра.
4. Подключите паузу, возобновление и отмену контроллера слушателя к подписке на центр, чтобы ничего не утекло.

```dart
// Dart 3.12.2 (Stream.multi requires Dart 2.9+)
import 'dart:async';

class ValueStream<T> {
  ValueStream(T initial) : _value = initial, _hasValue = true;
  ValueStream.empty();

  final _hub = StreamController<T>.broadcast();
  late T _value;
  bool _hasValue = false;
  Object? _error;
  StackTrace? _stackTrace;

  /// Synchronous access, like BehaviorSubject.value.
  T get value => _value;
  bool get hasValue => _hasValue;

  void add(T value) {
    _value = value;
    _hasValue = true;
    _error = null;
    _hub.add(value);
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    _error = error;
    _stackTrace = stackTrace;
    _hub.addError(error, stackTrace);
  }

  Future<void> close() => _hub.close();

  late final Stream<T> stream = Stream.multi((controller) {
    // 1. Replay the latest event to this listener only.
    if (_error != null) {
      controller.addError(_error!, _stackTrace);
    } else if (_hasValue) {
      controller.add(_value);
    }

    // 2. Already closed: replay, then finish.
    if (_hub.isClosed) {
      controller.close();
      return;
    }

    // 3. Forward future events.
    final sub = _hub.stream.listen(
      controller.add,
      onError: controller.addError,
      onDone: controller.close,
    );
    controller
      ..onPause = sub.pause
      ..onResume = sub.resume
      ..onCancel = sub.cancel;
  }, isBroadcast: true);
}
```

Использование выглядит так:

```dart
// Dart 3.12.2
Future<void> main() async {
  final status = ValueStream<int>(0);
  status.add(1);

  status.stream.listen((v) => print('A got $v'));
  await Future(() {});
  status.add(2);
  await Future(() {});

  status.stream.listen((v) => print('B got $v'));   // subscribes late
  await Future(() {});
  status.add(3);
  await Future(() {});
}
// Output:
// A got 1
// A got 2
// B got 2
// A got 3
// B got 3
```

`B` подписался после того, как было отправлено `2`, и всё равно получил его, а затем и все последующие события. `A` не получил дубликат `2`, когда подключился `B`, потому что повтор ушёл в собственный контроллер `B`.

Несколько намеренных решений в этом классе:

- **`stream` это поле `late final`, а не геттер.** Один экземпляр `Stream.multi` можно слушать много раз, поэтому нет причин создавать новый при каждом обращении. Это также сохраняет `identical(store.stream, store.stream)` истинным, что важно для `StreamBuilder` (подробнее ниже).
- **Повтор использует `add`, а не `addSync`.** У `MultiStreamController` есть `addSync`, `addErrorSync` и `closeSync`, которые доставляют событие немедленно. В документации API сказано использовать их, только когда слушатель готов получать события, как правило изнутри другого асинхронного обратного вызова. Вызов их внутри `onListen` доставил бы событие раньше, чем `listen()` успел вернуть подписку, что нарушает соглашение Dart о том, что потоки никогда не отправляют события синхронно во время `listen`. Обычный `add` ставит событие в очередь и сохраняет порядок: в моём тесте `listen`, за которым сразу следовали два синхронных вызова `add`, дал `100, 101, 102` именно в таком порядке.
- **Ошибки тоже повторяются.** Если последним событием была ошибка, поздний подписчик увидит ошибку, а не устаревшее значение. Уберите ветку `_error`, если предпочитаете повторять последнее корректное значение. `BehaviorSubject` повторяет последнее событие, включая ошибку, так что этот вариант ему соответствует.

## Превращение существующего потока в повторяющий

Часто контроллер вам не принадлежит. Вы получаете `Stream<T>` из плагина, снимка Firestore или `Socket` и хотите, чтобы несколько виджетов разделяли его с повтором последнего значения. В документации SDK для `Stream.multi` есть пример `repeatLatest()` примерно такого рода. Ниже версия, которая дополнительно обрабатывает ошибки, завершение и ленивое подключение:

```dart
// Dart 3.12.2
import 'dart:async';

extension ReplayLatest<T> on Stream<T> {
  Stream<T> replayLatest() {
    final hub = StreamController<T>.broadcast();
    StreamSubscription<T>? source;
    var hasLatest = false;
    late T latest;
    var done = false;

    void connect() {
      source ??= listen(
        (value) {
          hasLatest = true;
          latest = value;
          hub.add(value);
        },
        onError: hub.addError,
        onDone: () {
          done = true;
          hub.close();
        },
      );
    }

    return Stream.multi((controller) {
      connect();                       // subscribe to the source on first listen
      if (hasLatest) controller.add(latest);
      if (done) {
        controller.close();
        return;
      }
      final sub = hub.stream.listen(
        controller.add,
        onError: controller.addError,
        onDone: controller.close,
      );
      controller
        ..onPause = sub.pause
        ..onResume = sub.resume
        ..onCancel = sub.cancel;
    }, isBroadcast: true);
  }
}
```

Оно работает с источниками с одной подпиской, в чём и смысл: расширение слушает источник ровно один раз и раздаёт события дальше.

```dart
// Dart 3.12.2
Future<void> main() async {
  final source = StreamController<int>();          // single-subscription
  final shared = source.stream.replayLatest();

  shared.listen((v) => print('first: $v'));
  source.add(1);
  source.add(2);
  await Future(() {});

  shared.listen((v) => print('late: $v'), onDone: () => print('late: done'));
  await Future(() {});
  source.add(3);
  await source.close();
  await Future(() {});

  shared.listen((v) => print('after close: $v'),
      onDone: () => print('after close: done'));
  await Future(() {});
}
// Output:
// first: 1
// first: 2
// late: 2
// first: 3
// late: 3
// late: done
// after close: 3
// after close: done
```

Обратите внимание на то, чего это расширение намеренно не делает: оно никогда не отменяет подписку на источник, даже когда все слушатели ушли. Этим оно отличается от `shareValue()` из rxdart, который считает ссылки и отменяет источник, когда уходит последний слушатель; это расширение ведёт себя как `publishValue()`, подключённый один раз и поддерживаемый живым, что и нужно для состояния на всё время жизни приложения. Если источник затратный (поток GPS, WebSocket), добавьте подсчёт ссылок: отслеживайте число активных контроллеров слушателей в `onListen` и `onCancel` и отменяйте `source`, когда оно падает до нуля. Заранее решите, должен ли поздний подписчик после этого момента всё ещё получать старое кешированное значение или ждать переподключения.

## Ускоренный вариант на async*, который теряет события

Первое, что пробует большинство, это генератор:

```dart
// Dart 3.12.2 - looks right, is racy
Stream<T> withLatest<T>(T Function() current, Stream<T> updates) async* {
  yield current();
  yield* updates;
}
```

Читается он прекрасно и при этом неверен. Функция `async*` приостанавливается на `yield`, пока событие не будет доставлено, и только потом переходит к строке `yield*`, то есть к моменту подписки на broadcast-поток `updates`. Всё, что было отправлено между вызовом listen и этой подпиской, попадает в зазор. Я воспроизвёл это с событием, запланированным через один микротаск после `listen`:

```dart
// Dart 3.12.2
Future<void> main() async {
  final updates = StreamController<int>.broadcast();
  var current = 20;

  withLatest(() => current, updates.stream)
      .listen((v) => print('got $v'));

  scheduleMicrotask(() {
    current = 21;
    updates.add(21);
  });
  await Future(() {});
  await Future(() {});
}
// Output:
// got 20
```

`21` так и не выводится. Подписчик застревает на показе `20`, хотя реальное состояние равно `21`, и никакое последующее событие это не исправит, пока не изменится что-то ещё. У версии на `Stream.multi` такого зазора нет, потому что она синхронно подписывается на центр внутри `onListen`, прежде чем успеет сработать любое событие из очереди.

## Подводные камни в приложении Flutter

**`StreamBuilder` всё ещё показывает один кадр "ожидания".** Повтор асинхронный (это тот самый выбор между `add` и `addSync` выше), а `StreamBuilder` строит первый кадр сразу после подписки в `initState`. Без доработки у этого первого кадра `ConnectionState.waiting` и нет данных, что выглядит как мигание индикатора загрузки на один кадр. Поскольку `ValueStream` отдаёт текущее значение синхронно, передайте его как `initialData`:

```dart
// Flutter 3.44, Dart 3.12.2
StreamBuilder<int>(
  stream: status.stream,
  initialData: status.hasValue ? status.value : null,
  builder: (context, snapshot) {
    if (!snapshot.hasData) return const CircularProgressIndicator();
    return Text('Status: ${snapshot.data}');
  },
)
```

**Не создавайте поток внутри `build`.** `StreamBuilder` переподписывается, когда получает поток, не являющийся тем же объектом, что в прошлый раз. Геттер, который при каждом обращении возвращает `Stream.multi(...)` или `source.replayLatest()`, создаёт новый поток при каждой перестройке, так что каждая перестройка отменяет подписку и подписывается заново, а с `replayLatest()` ещё и открывает новую подписку на источник. Создавайте поток один раз: в поле, в сервисе или в `initState`. То же правило действует для futures, как описано в статье [как инициализировать Future, чтобы FutureBuilder не пересоздавал его при каждой перестройке](/ru/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).

**Отмена подключена, но отменять всё равно нужно.** Поскольку `onCancel` пробрасывается в подписку на центр, отменённый слушатель удаляется из broadcast-контроллера. В моём тесте `_hub.hasListener` изменился с `true` на `false` после `cancel()`. Слушатели, на которых вы вызываете `listen` вручную, по-прежнему требуют поля `StreamSubscription` и `cancel()` в `dispose`, ровно как в статье [отмена StreamSubscription в dispose](/ru/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/). `StreamBuilder` делает это за вас.

**Закрывайте центр, когда владелец уходит.** `ValueStream`, принадлежащий `State` виджета, нужно закрывать в `dispose()` рядом с другими контроллерами, как описано в статье [освобождение контроллеров во избежание утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/). Подписываться после `close()` безопасно: подписчик получит последнее значение, а затем событие завершения.

**Необработанные повторённые ошибки остаются необработанными.** Если вы повторяете ошибку слушателю без `onError`, она становится неперехваченной асинхронной ошибкой и попадает в обработчик ошибок зоны, а во Flutter это `PlatformDispatcher.instance.onError`. О том, куда она в итоге попадает, см. [перехват неперехваченных асинхронных ошибок во Flutter](/ru/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/).

**Фильтрация по равенству это отдельное решение.** `BehaviorSubject` не убирает дубликаты, и этот класс тоже. Если нужно "отправлять только при изменении значения", добавьте в `add` проверку `if (value == _value) return;` и учитывайте компромиссы с изменяемыми объектами, где возникает та же ошибка, что и у [фильтра по равенству в StreamProvider из Riverpod](/ru/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## Когда поток вообще не нужен

Если значение только питает виджеты и никогда не пересекает асинхронную границу, `ValueNotifier<T>` с `ValueListenableBuilder` проще любого потока: у него есть синхронное `value`, он уведомляет слушателей при изменении, а builder читает текущее значение уже в первом кадре, так что мигания загрузки нет. Обращайтесь к повторяющему потоку, когда вам нужны операторы потоков (`where`, `asyncMap`, преобразования в стиле `debounce`), когда данные приходят из существующего API на `Stream` или когда библиотека управления состоянием, например `StreamProvider` из Riverpod, ожидает поток. Более широкое сравнение этих вариантов см. в статье [FutureBuilder и StreamBuilder против AsyncValue из Riverpod](/ru/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).

А когда нужно больше, чем последнее значение, например "повторять последние 10 событий" или "повторять всё", та же структура на `Stream.multi` работает с ограниченной `Queue<T>` вместо одного поля. На этом этапе вы заново реализуете `ReplaySubject` из rxdart, и подключить пакет будет разумным компромиссом.

## Источники

- [Stream.multi constructor, Dart API docs](https://api.dart.dev/stable/dart-async/Stream/Stream.multi.html)
- [MultiStreamController class, Dart API docs](https://api.dart.dev/stable/dart-async/MultiStreamController-class.html)
- [StreamController.broadcast, Dart API docs](https://api.dart.dev/stable/dart-async/StreamController/StreamController.broadcast.html)
- [Dart SDK 2.9 changelog entry for Stream.multi](https://dart.googlesource.com/sdk/+/refs/tags/2.9.1/CHANGELOG.md)
- [rxdart on pub.dev (BehaviorSubject, ReplaySubject, shareValue)](https://pub.dev/packages/rxdart)
- [Asynchronous programming: streams, dart.dev](https://dart.dev/libraries/async/using-streams)
- [StreamBuilder class, Flutter API docs](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html)
