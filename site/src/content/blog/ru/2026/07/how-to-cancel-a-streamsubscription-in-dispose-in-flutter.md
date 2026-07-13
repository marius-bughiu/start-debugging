---
title: "Как отменить StreamSubscription в dispose, чтобы избежать сбоя setState-после-dispose во Flutter"
description: "Stream продолжает эмитить события после того, как пользователь покинул экран, его onData вызывает setState на уже уничтоженном State, и Flutter выбрасывает исключение. Сохраните подписку, отмените её в dispose перед super.dispose, и колбэк уже никогда не сработает на мёртвом виджете. Полный паттерн для Flutter 3.44."
pubDate: 2026-07-13
template: how-to
tags:
  - "flutter"
  - "dart"
  - "async"
lang: "ru"
translationOf: "2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-13
---

Когда вы вызываете `stream.listen(...)` внутри `State`, вы владеете подпиской и обязаны отменить её в `dispose()`. Если вы этого не сделаете, stream продолжит доставлять события после того, как пользователь покинул экран, колбэк `onData` выполнит `setState` на `State`, который уже был уничтожен, и Flutter выбросит `setState() called after dispose()`. Решение состоит из трёх строк: сохраните `StreamSubscription` в поле, создайте её в `initState` и вызовите `_sub.cancel()` в `dispose()` перед `super.dispose()`. Отмена останавливает доставку, поэтому колбэк вообще никогда не выполняется на мёртвом виджете. В этом руководстве используются Flutter 3.44 (текущая стабильная версия, 2026) и Dart 3.x.

Различие, которое имеет значение: отмена -- это настоящее решение, а проверка `mounted` -- лишь заплатка поверх симптома. `StreamSubscription` -- это живой канал между источником, который переживает ваш виджет (`StreamController`, слушатель снимков Firestore, WebSocket, датчик, `connectivity_plus`), и колбэком, который захватывает `this`. Пока этот канал открыт, ваш `State` достижим, и ваш `onData` выполняется на каждом событии, уничтожен он или нет. Закрытие канала -- это точка, в которой одновременно исчезают и утечка памяти, и сбой.

## Почему колбэк переживает виджет

Жизненный цикл виджета Flutter и жизненный цикл stream полностью независимы. Framework уничтожает ваш `State`, когда его элемент покидает дерево: пользователь делает pop маршрута, родитель перестраивает вас из существования, переключается вкладка. Ничто из этого не затрагивает stream. `StreamController` на другом конце понятия не имеет, что виджет слушал, тем более что виджета уже нет. Он продолжает производить события, а Dart продолжает рассылать их каждой зарегистрированной подписке, включая вашу.

```dart
// Flutter 3.44, Dart 3.x -- the crash waiting to happen
class _PriceTickerState extends State<PriceTicker> {
  double _price = 0;

  @override
  void initState() {
    super.initState();
    priceStream.listen((value) {   // subscription is never stored
      setState(() => _price = value); // runs even after dispose()
    });
  }
}
```

Этот код проходит каждую быструю проверку, потому что при быстрой проверке вы не покидаете экран, пока событие в пути. Протолкните новый маршрут, пока `priceStream` всё ещё эмитит раз в секунду, и следующий тик попадёт в `onData`, который вызовет `setState` на несуществующем `State`. В режиме debug вы получите `FlutterError`: `setState() called after dispose(): _PriceTickerState#4f2a1(lifecycle state: defunct, not mounted)`. Подписка, возвращённая `listen`, была выброшена, поэтому нет дескриптора, который можно отменить, и ничего, что остановило бы событие. `State` также не может быть собран сборщиком мусора, потому что внутренний список подписок stream всё ещё ссылается на замыкание, которое его захватило. Это та же ошибка владения, что стоит за [уничтожением контроллеров ради избегания утечек памяти](/ru/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): ресурс, который вы создали и никогда не освободили.

## Паттерн, шаг за шагом

### Шаг 1: Сохраните подписку в поле

`listen` возвращает `StreamSubscription<T>`. Сохраните его. Этот дескриптор -- единственный способ отменить позже.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';

class _PriceTickerState extends State<PriceTicker> {
  StreamSubscription<double>? _sub;
  double _price = 0;
  // ...
}
```

Используйте поле, допускающее null (`StreamSubscription<double>?`), когда подписка создаётся условно, чтобы `dispose` мог безопасно вызвать `_sub?.cancel()`. Если вы всегда подписываетесь ровно один раз в `initState`, вариант `late final StreamSubscription<double> _sub;` чище, потому что он документирует, что поле всегда присваивается, и позволяет отменять без условий.

### Шаг 2: Подписывайтесь в initState, а не в build

Создавайте подписку в `initState` (или в `didChangeDependencies`, если stream приходит из inherited-виджета), но никогда в `build`. `build` выполняется на каждом кадре, поэтому подписка там наслаивает новый слушатель при каждой перестройке, и каждый из них вызывает `setState`, который планирует ещё одну перестройку. Этот цикл обратной связи -- отдельный класс ошибок, отличный от темы этого поста, и проявляется как [setState() or markNeedsBuild() called during build](/ru/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/).

```dart
// Flutter 3.44, Dart 3.x
@override
void initState() {
  super.initState();
  _sub = priceStream.listen(
    (value) => setState(() => _price = value),
    onError: (Object e, StackTrace s) => setState(() => _price = -1),
  );
}
```

### Шаг 3: Отменяйте в dispose, перед super.dispose

Это та строка, которая на самом деле устраняет сбой.

```dart
// Flutter 3.44, Dart 3.x
@override
void dispose() {
  _sub?.cancel();
  super.dispose();
}
```

Порядок важен так же, как и для контроллеров: сначала освободите собственные ресурсы, затем передайте управление framework через `super.dispose()`. После того как `cancel()` вернёт управление, подписка мертва. Она не доставит ни одного последующего колбэка `onData`, `onError` или `onDone`, даже для событий, которые источник уже произвёл, но ещё не разослал. Это гарантия, которую вы покупаете: замыкание, вызывающее `setState`, больше не может выполниться, поэтому уничтоженный `State` неприкосновенен.

## Почему не нужно ожидать cancel в dispose

`StreamSubscription.cancel()` возвращает `Future<void>`, а `dispose()` возвращает `void`, поэтому вы не можете применить к нему `await`. Это сбивает людей с толку, но это не проблема. Future завершается, когда колбэк `onCancel` stream заканчивает любую нужную ему очистку (закрытие сокета, освобождение файлового дескриптора). Доставка вашему колбэку прекращается немедленно, независимо от того, когда этот future разрешится. Для цели не вызывать `setState` на мёртвом виджете неожидаемый `cancel()` полностью эффективен в тот момент, когда он вызван.

Future важен только если вам конкретно нужно знать, когда источник завершил очистку, что редко бывает внутри виджета. Если вы сами владеете `StreamController` и хотите гарантировать, что его `onCancel` выполнился прежде, чем продолжить, выполните эту очистку вне `dispose`, где вы можете дождаться её через await.

## Несколько подписок в одном виджете

Экран часто слушает несколько stream: подключение, поток данных, stream видимости клавиатуры. Отмените каждый. Два чистых подхода.

Отдельные поля, когда подписки разных типов и вы ссылаетесь на них по отдельности:

```dart
// Flutter 3.44, Dart 3.x
StreamSubscription<ConnectivityResult>? _connSub;
StreamSubscription<Order>? _orderSub;

@override
void dispose() {
  _connSub?.cancel();
  _orderSub?.cancel();
  super.dispose();
}
```

Список, когда вам нужно просто снести их все вместе:

```dart
// Flutter 3.44, Dart 3.x
final _subs = <StreamSubscription<dynamic>>[];

@override
void initState() {
  super.initState();
  _subs.add(connectivity.onConnectivityChanged.listen(_onConn));
  _subs.add(orders.stream.listen(_onOrder));
}

@override
void dispose() {
  for (final s in _subs) {
    s.cancel();
  }
  super.dispose();
}
```

Список масштабируется без необходимости помнить о добавлении соответствующей строки `cancel` для каждого нового поля, а именно такое упущение снова вносит сбой месяцы спустя.

## Переподписка без утечки старой подписки

Если stream, который вы слушаете, зависит от свойства виджета или унаследованного значения, источник может измениться, пока виджет остаётся смонтированным. Обработайте это в `didUpdateWidget` или `didChangeDependencies` и отмените предыдущую подписку перед открытием новой. Пропуск отмены приводит к утечке старой и сохраняет её `setState` живым на том же `State`.

```dart
// Flutter 3.44, Dart 3.x
@override
void didUpdateWidget(PriceTicker old) {
  super.didUpdateWidget(old);
  if (old.symbol != widget.symbol) {
    _sub?.cancel();                       // drop the old stream
    _sub = priceStreamFor(widget.symbol)  // subscribe to the new one
        .listen((v) => setState(() => _price = v));
  }
}
```

## Когда вы владеете StreamController, закройте его тоже

Отмена подписки и закрытие контроллера -- разные обязанности. Отменяйте свою подписку, когда вы лишь потребитель чужого stream. Если ваш виджет ещё и создал `StreamController`, лежащий в основе stream, закройте контроллер в `dispose` тоже, иначе контроллер и его буфер утекут.

```dart
// Flutter 3.44, Dart 3.x
final _controller = StreamController<String>();
StreamSubscription<String>? _sub;

@override
void initState() {
  super.initState();
  _sub = _controller.stream.listen((msg) => setState(() => _last = msg));
}

@override
void dispose() {
  _sub?.cancel();       // stop consuming
  _controller.close();  // release the source you own
  super.dispose();
}
```

Контроллер с одиночной подпиской не позволит подключиться второму слушателю, поэтому если вы также предоставляете этот stream в другом месте, создайте его через `StreamController.broadcast()` и помните, что каждому слушателю на broadcast-stream нужен свой `cancel`.

## Почему StreamBuilder часто является лучшим ответом

Если единственное, что делает ваша подписка, -- это подаёт значение в интерфейс, вам, вероятно, вообще не нужно управлять подпиской. `StreamBuilder` подписывается при вставке, перестраивается на каждом событии через свой `builder` и отменяет автоматически при удалении из дерева. Нет `setState`, нет поля, нет учёта в `dispose`, и, следовательно, нет способа оставить подписку работающей после уничтожения.

```dart
// Flutter 3.44, Dart 3.x
StreamBuilder<double>(
  stream: priceStream,
  builder: (context, snap) => Text('${snap.data ?? 0}'),
)
```

Прибегайте к ручному `listen` вместе с `setState` только когда событие делает что-то помимо отрисовки: навигация по событию завершения, показ `SnackBar`, запись в другой контроллер, запуск побочного эффекта. Это как раз те случаи, когда устаревший колбэк опасен, и именно там отмена в `dispose` не подлежит обсуждению. Тот же компромисс между ручным и управляемым обращением возникает с `TextEditingController`, поэтому [контроллер, использованный после уничтожения](/ru/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/), выбрасывает аналогичную ошибку.

## pause -- это не cancel, а mounted -- не замена

Два коротких пути выглядят так, будто решают это, но не решают.

`StreamSubscription.pause()` временно останавливает доставку, но приостановленная подписка остаётся зарегистрированной и продолжает удерживать ваш `State`. Приостановка в `dispose` приводит к утечке; вы должны использовать `cancel`.

`if (!mounted) return;` в начале `onData` предотвращает вызов `setState`, но не останавливает stream. Подписка остаётся живой, продолжает рассылать события и продолжает удерживать ваш `State` достижимым. Сбой замаскирован, пока утечка продолжается. Используйте проверку `mounted` только для случая, для которого она предназначена, -- `await` внутри колбэка, который возобновляется после того, как виджет исчез, -- и покройте это основательно, научившись [защищать setState проверкой mounted после асинхронного разрыва](/ru/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/). Для простого случая "stream продолжает эмитить" cancel -- правильное и полное решение.

Если ваш `onData` сам асинхронный, вы можете столкнуться с обеими проблемами сразу: подписка доставляет событие, вы используете `await` внутри обработчика, и виджет уничтожается во время await. Cancel обрабатывает доставку; проверка `mounted` обрабатывает возобновление после await. Там двойная страховка оправдана.

## Версия из одного файла для копирования

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'package:flutter/material.dart';

class PriceTicker extends StatefulWidget {
  const PriceTicker({super.key, required this.stream});
  final Stream<double> stream;

  @override
  State<PriceTicker> createState() => _PriceTickerState();
}

class _PriceTickerState extends State<PriceTicker> {
  StreamSubscription<double>? _sub;
  double _price = 0;

  @override
  void initState() {
    super.initState();
    _sub = widget.stream.listen(
      (value) => setState(() => _price = value),
      onError: (Object e, StackTrace s) => setState(() => _price = -1),
    );
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Text(_price.toStringAsFixed(2));
}
```

Сохраните подписку, отмените её перед `super.dispose()`, и сбой `setState()-после-dispose()` становится структурно невозможным, а не избегаемым по вероятности. Потоковое состояние, приходящее из сети, заслуживает такой же заботы на пути ошибок, что стоит совместить с изучением того, как [грамотно обрабатывать сетевые ошибки в приложении Flutter](/ru/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/), чтобы упавший stream показывал состояние, на которое пользователь может отреагировать, а не спиннер, который никогда не разрешается.

## Источники

- [StreamSubscription.cancel API](https://api.flutter.dev/flutter/dart-async/StreamSubscription/cancel.html) - контракт cancel и его возврат `Future<void>`.
- [State.dispose API](https://api.flutter.dev/flutter/widgets/State/dispose.html) - "subclasses should override this method to release any resources retained by this object (e.g., stop any active animations)".
- [StreamBuilder class](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html) - автоматические подписка и отмена, привязанные к жизненному циклу виджета.
- [Dart streams tutorial](https://dart.dev/libraries/async/using-streams) - stream с одиночной подпиской против broadcast и управление слушателями.
