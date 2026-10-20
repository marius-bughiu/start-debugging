---
title: "Исправление: Bad state: Stream has already been listened to во Flutter"
description: "Односписочный (single-subscription) поток допускает ровно один вызов listen() за всё время жизни. Создавайте поток один раз и отдавайте его одному слушателю, либо делитесь им через asBroadcastStream или Stream.multi."
pubDate: 2026-10-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "streams"
lang: "ru"
translationOf: "2026/10/fix-bad-state-stream-has-already-been-listened-to-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-20
---

`Bad state: Stream has already been listened to.` означает, что кто-то вызвал `listen()` второй раз на потоке с одной подпиской (single-subscription). Такой поток принимает ровно одну подписку за всё время жизни, и отмена первой подписки его не сбрасывает. Во Flutter второй `listen()` почти всегда приходит из `StreamBuilder`: два билдера на одном потоке, билдер, который был смонтирован заново, или `.map()`/`.where()`, написанные прямо в `build()`. Исправление: создавайте каждый производный поток один раз (в `initState` или в объекте состояния), а если события действительно нужны нескольким виджетам, делитесь источником через `asBroadcastStream()`, `StreamController.broadcast()` или `Stream.multi` для каждого слушателя.

Все примеры воспроизведения и исправления ниже запускались на Flutter 3.44.8 с Dart 3.12.2: чистые Dart-примеры через `dart run`, примеры с виджетами как виджет-тесты `flutter test`.

## Ошибка в контексте

В чистом Dart исключение возникает на втором `listen()`, а верхний кадр стека показывает, как контроллер отказывает второму подписчику:

```text
StateError: Bad state: Stream has already been listened to.
#0      _StreamController._subscribe (dart:async/stream_controller.dart:695:7)
#1      _ControllerStream._createSubscription (dart:async/stream_controller.dart:854:20)
#2      _StreamImpl.listen (dart:async/stream_impl.dart:516:42)
#3      main.<anonymous closure> (file:///.../repro.dart:20:14)
```

Во Flutter-приложении тот же `StateError` перехватывается библиотекой виджетов и сообщается относительно того виджета, который строился в этот момент. Важны две строки `_StreamBuilderBaseState`:

```text
══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞═════════════════════════════════════
The following StateError was thrown building StatefulBuilder(state: _StatefulBuilderState#352fb):
Bad state: Stream has already been listened to.

When the exception was thrown, this was the stack:
#6      _StreamBuilderBaseState._subscribe (package:flutter/src/widgets/async.dart:133:38)
#7      _StreamBuilderBaseState.didUpdateWidget (package:flutter/src/widgets/async.dart:118:7)
#8      StatefulElement.update (package:flutter/src/widgets/framework.dart:5991:55)
```

Если кадр под `_subscribe` это `initState`, значит, было создано новое состояние `StreamBuilder`, которое подписалось на поток, уже занятый кем-то другим. Если это `didUpdateWidget`, билдер получил при перестроении *другой* объект потока и подписался на него, а этот новый объект опирается на источник, который уже занят. Эта одна строка подсказывает, какая из причин ниже ваша.

## Почему поток отказывает второму слушателю

В Dart есть два вида потоков. Поток **single-subscription** это одноразовая последовательность: он буферизует события, пока никто не слушает, доставляет их единственному слушателю и на этом заканчивается. Поток **broadcast** может иметь любое число слушателей, но ничего не буферизует: каждое событие получает тот, кто подписан в этот момент.

`StreamController()`, генераторы `async*`, `Stream.value`, `Stream.periodic`, `Future.asStream()`, `File.openRead()`, `Process.stdout` и тело `StreamedResponse` из пакета `http` являются односписочными. При втором `listen()` контроллер бросает исключение, причём даже если первая подписка уже была отменена. Я проверил это явно:

```dart
// Dart 3.12.2
import 'dart:async';

Future<void> main() async {
  final c = StreamController<int>();
  final first = c.stream.listen((_) {});
  await first.cancel();
  c.stream.listen((_) {}); // StateError: Bad state: Stream has already been listened to.
}
```

Два неочевидных факта порождают большую часть путаницы:

1. **Операторы слушают за вас.** `map`, `where`, `expand`, `asyncMap`, `transform`, `distinct` и им подобные возвращают новый поток, который подписывается на свой источник, когда слушают *его*. Поэтому `c.stream.where(...)` и `c.stream.map(...)` это два разных объекта потока, но прослушивание обоих всё равно означает два вызова `listen()` на `c.stream`, и второй бросит исключение.
2. **Потребляющие методы тоже слушают.** `first`, `last`, `length`, `toList()`, `forEach`, `drain`, `await for`, `pipe` и `bytesToString()` для тела `http` под капотом вызывают `listen()`. Если вызвать `await stream.first`, а затем `await stream.toList()` на потоке `async*`, второй вызов бросит исключение.

Тип потока тоже не всегда говорит, с чем вы имеете дело. В Dart 3.12.2 `isBroadcast` равен `false` для `Stream.fromIterable`, но такой поток можно слушать несколько раз (каждый слушатель получает свой проход по итерируемому объекту), тогда как `Stream.value(1)` и `Future.value(1).asStream()` бросают исключение на втором `toList()`. Считайте любой поток, который вы не создавали сами, односписочным, если документация не говорит обратного.

## Минимальное воспроизведение: три способа сломать StreamBuilder

Все три случая падают с ошибкой выше. Вспомогательная функция это просто `StreamBuilder`, который выводит последнее значение:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget sb(Stream<int> s) => StreamBuilder<int>(
      stream: s,
      builder: (context, snap) =>
          Text('${snap.data}', textDirection: TextDirection.ltr),
    );

void main() {
  // A: two StreamBuilders on one single-subscription stream (throws in initState)
  testWidgets('A', (t) async {
    final c = StreamController<int>();
    await t.pumpWidget(Column(children: [sb(c.stream), sb(c.stream)]));
  });

  // B: .map() inside build, then the parent rebuilds (throws in didUpdateWidget)
  testWidgets('B', (t) async {
    final c = StreamController<int>();
    late StateSetter rebuild;
    await t.pumpWidget(StatefulBuilder(builder: (context, set) {
      rebuild = set;
      return sb(c.stream.map((x) => x * 2));
    }));
    rebuild(() {});
    await t.pump();
  });

  // C: same stream object, but the StreamBuilder is remounted (throws in initState)
  testWidgets('C', (t) async {
    final stream = StreamController<int>().stream;
    await t.pumpWidget(KeyedSubtree(key: const ValueKey(1), child: sb(stream)));
    await t.pumpWidget(KeyedSubtree(key: const ValueKey(2), child: sb(stream)));
  });
}
```

Случай B кусает людей чаще всего, потому что первый кадр работает. `StreamBuilder` переподписывается только когда `oldWidget.stream != widget.stream` (это проверка в `didUpdateWidget` в `async.dart`), а `c.stream.map(...)` возвращает новый объект при каждом `build()`. Первая сборка подписывает `map` №1 на контроллер. Следующее перестроение, будь то смена темы, открытие клавиатуры или `setState` родителя, создаёт `map` №2, `StreamBuilder` отписывается от №1 и подписывается на №2, а №2 пытается второй раз вызвать `listen()` на контроллере.

Случай C это реальная форма жалоб "падает, когда я возвращаюсь на эту вкладку" или "падает, когда я закрываю страницу и открываю её снова". Поток живёт в чём-то долгоживущем (сервис, переменная верхнего уровня, родительский виджет), экран с `StreamBuilder` уничтожается и создаётся заново, и новый `State` вызывает `listen()` на потоке, у которого уже был свой единственный слушатель. К этому приводит всё, что меняет форму дерева элементов вокруг билдера: навигация, альтернативы `IndexedStack`, перестраивающие дочерние элементы, условные виджеты или смена `Key`.

Для сравнения: передача *того же* объекта потока через перестроения без повторного монтирования работает нормально. `StreamBuilder` видит в `didUpdateWidget` тот же поток и сохраняет существующую подписку. Этот случай прошёл в том же тестовом файле.

## Исправление, в порядке предпочтения

### 1. Создавайте производные потоки один раз, а не в build()

Если поток используется только одним виджетом, вся проблема в причине B, и исправление состоит в том, чтобы перестать создавать новый поток на каждую сборку. Храните его в `State`:

```dart
// Flutter 3.44.8, Dart 3.12.2
class PriceLabel extends StatefulWidget {
  const PriceLabel({super.key, required this.ticks});
  final Stream<int> ticks;

  @override
  State<PriceLabel> createState() => _PriceLabelState();
}

class _PriceLabelState extends State<PriceLabel> {
  late Stream<String> _formatted;

  @override
  void initState() {
    super.initState();
    _formatted = widget.ticks.map((cents) => '\$${(cents / 100).toStringAsFixed(2)}');
  }

  @override
  void didUpdateWidget(PriceLabel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.ticks != widget.ticks) {
      _formatted = widget.ticks.map((cents) => '\$${(cents / 100).toStringAsFixed(2)}');
    }
  }

  @override
  Widget build(BuildContext context) => StreamBuilder<String>(
        stream: _formatted,
        builder: (context, snap) => Text(snap.data ?? '...'),
      );
}
```

Переопределение `didUpdateWidget` важно: если родитель передаёт действительно новый источник, вам нужен новый производный поток для него, и только тогда. Это то же правило, что и для `FutureBuilder`, и рассуждения из статьи [как инициализировать Future, чтобы FutureBuilder не пересоздавал его при каждом перестроении](/ru/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) переносятся один в один. В моём тесте кеширование `c.stream.map(...)` в `final` и передача его через перестроение родителя отобразило `42` после `c.add(21)`, без ошибки.

Та же дисциплина действует и вне виджетов. Если вам нужны и первое значение, и остальные, берите их из одной подписки, а не вызывайте `first`, а затем `listen`:

```dart
// Dart 3.12.2
Future<void> readAll(Stream<int> source) async {
  var isFirst = true;
  await for (final value in source) {
    if (isFirst) {
      print('first: $value');
      isFirst = false;
    }
    print('value: $value');
  }
}
```

### 2. Делайте фабрику, а не поле, если каждый слушатель должен начинать с нуля

Если каждый потребитель должен получать свою независимую последовательность (запрос, чтение файла, генератор), не храните поток вообще. Храните функцию, которая его создаёт, и вызывайте её для каждого слушателя. Функция `async*` уже является такой функцией:

```dart
// Dart 3.12.2
Stream<int> countdown(int from) async* {
  for (var i = from; i >= 0; i--) {
    yield i;
    await Future<void>.delayed(const Duration(seconds: 1));
  }
}

// Two independent subscriptions, no error:
// countdown(3).listen(print);
// countdown(3).listen(print);
```

Двукратный вызов `countdown(3)` выполнился без ошибки и дал каждому вызывающему `[3, 2, 1, 0]`. Повторное использование одного `final s = countdown(3)` для двух вызовов `toList()` бросило исключение. Большинство API данных во Flutter уже работают так: метод репозитория вроде `watchOrders()`, возвращающий новый поток при каждом вызове, безопасно вызывать из каждого виджета, которому он нужен, при условии что вы вызываете его в `initState`, а не в `build()`.

Когда нужен один объект, который можно слушать многократно, но который при этом ведёт себя отдельно для каждого слушателя, именно это даёт `Stream.multi`. Его колбэк выполняется один раз на каждый `listen()` с собственным контроллером этого слушателя:

```dart
// Dart 3.12.2
final Stream<int> config = Stream<int>.multi((controller) {
  controller.add(1);
  controller.close();
});

// await config.toList(); // [1]
// await config.toList(); // [1] again, no StateError
```

### 3. Делитесь одним источником через asBroadcastStream() или broadcast-контроллер

Когда несколько виджетов должны наблюдать *один и тот же* живой источник (один сокет, одна характеристика BLE, один `Process.stdout`), один раз преобразуйте его в broadcast и раздавайте уже преобразованный поток:

```dart
// Flutter 3.44.8, Dart 3.12.2
class ConnectionService {
  ConnectionService(Stream<int> socketEvents)
      : events = socketEvents.asBroadcastStream();

  final Stream<int> events;
}
```

С `final shared = c.stream.asBroadcastStream()` два `StreamBuilder` на `shared` оба отобразили `5` после `c.add(5)`, а повторное монтирование одного из них не бросило исключение. Если вы владеете производителем, лучше сразу создайте его как `StreamController<T>.broadcast()`.

Вызов должен произойти **один раз**. `widget.stream.asBroadcastStream()` внутри `build()` это снова случай B: каждый вызов создаёт новую broadcast-обёртку, которая пытается подписаться на тот же односписочный источник.

## Подводные камни и варианты

**Broadcast-потоки теряют события, которых никто не ждал.** Это цена исправления 3, и проявляется она пустым экраном, а не исключением. В моих тестах поздний слушатель `asBroadcastStream()` получил только `[3]`, тогда как первый слушатель получил `[1, 2, 3]`, а `StreamBuilder`, смонтированный заново на broadcast-потоке, показывал `null` до следующего события, хотя `7` было отправлено раньше. Односписочный контроллер, напротив, буферизовал `1`, добавленную до того, как кто-либо начал слушать. Если виджету нужно текущее значение в момент появления, либо передайте `initialData`, либо используйте поток с повтором последнего значения; в статье [как воспроизводить последнее значение для поздних подписчиков потока Dart без rxdart](/ru/2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart/) такой поток строится на `Stream.multi`.

**`asBroadcastStream()` держит подписку на источник живой.** По умолчанию, когда отменяется последний broadcast-слушатель, обёртка только приостанавливается, а `onCancel` источника не вызывается. Мой пробный код вывел `sourceCancelled(default)=false`. Передача `onCancel: (sub) => sub.cancel()` действительно отменяет источник, но тогда источник израсходован навсегда: следующий слушатель обёртки получил только `done`. Для сокета или датчика, которые нужно закрывать при уходе с экрана, управляйте жизненным циклом явно, а не полагайтесь на обёртку.

**Отмена не равна сбросу.** Некоторые советы в сети предлагают отменить старую подписку перед повторным прослушиванием. Это предотвращает утечки, и это стоит делать (см. [отмена StreamSubscription в dispose](/ru/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)), но односписочный поток от этого не становится пригодным для повторного использования. Помогает только новый поток.

**Hot reload сохраняет сломанный поток.** Hot reload сохраняет `State` и переменные верхнего уровня, поэтому после исправления кода поток, уже израсходованный в работающем приложении, остаётся израсходованным. Сделайте hot restart или остановите и запустите заново, прежде чем решать, что исправление не сработало.

**Тела `http` одноразовые.** `StreamedResponse.stream` можно прочитать один раз. Middleware для журналирования, которое вызывает `response.stream.bytesToString()`, а затем возвращает тот же ответ вызывающему коду, заставляет чтение вызывающего бросить эту ошибку. Прочитайте тело один раз в байты, а затем постройте новый `http.Response` из них, если нижестоящему коду оно нужно снова.

**Библиотеки управления состоянием в основном решают это за вас.** `stream` у `Bloc` и `StreamProvider` в Riverpod уже отдают broadcast-потоки или потоки на каждого слушателя, поэтому ошибка обычно означает, что рядом с ними пустили гулять сырой контроллер. Если вы переводите экран с сырых `StreamBuilder` на что-то другое, статьи [FutureBuilder и StreamBuilder против AsyncValue из Riverpod](/ru/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) и [Notifier, AsyncNotifier и StreamNotifier](/ru/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/) объясняют, какой тип провайдера владеет жизненным циклом потока.

**Похожая ошибка: `Bad state: Cannot add new events after calling close`.** Тот же тип `StateError`, но с противоположной стороны потока: производитель вызвал `add` на закрытом контроллере, обычно из таймера или колбэка, пережившего `dispose()`. **Похожая ошибка: `Bad state: No element`.** Она приходит от `first`, `single` или `last` на потоке (или итерируемом объекте), который завершился пустым. Ни одну из них не исправляют broadcast-потоки.

## Связанные материалы

- [How to cancel a StreamSubscription in dispose to avoid a setState-after-dispose crash in Flutter](/ru/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)
- [How to replay the latest value to late subscribers of a Dart stream without rxdart](/ru/2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart/)
- [How to initialize a Future so FutureBuilder does not recreate it on every rebuild](/ru/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [FutureBuilder and StreamBuilder vs Riverpod AsyncValue in Flutter](/ru/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier](/ru/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/)

## Источники

- [Asynchronous programming: Streams](https://dart.dev/libraries/async/using-streams) на dart.dev, раздел про single-subscription и broadcast.
- [Creating streams in Dart](https://dart.dev/libraries/async/creating-streams), где описаны `async*`, `StreamController` и когда что использовать.
- Справочник API [`Stream.asBroadcastStream`](https://api.dart.dev/stable/dart-async/Stream/asBroadcastStream.html) и [`Stream.multi`](https://api.dart.dev/stable/dart-async/Stream/Stream.multi.html).
- Справочник API [`StreamBuilder`](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html) и реализация `_StreamBuilderBaseState.didUpdateWidget` в `packages/flutter/lib/src/widgets/async.dart` Flutter 3.44.8.
