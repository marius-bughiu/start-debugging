---
title: "Beheben: Bad state: Stream has already been listened to in Flutter"
description: "Ein Single-Subscription-Stream akzeptiert in seiner gesamten Lebensdauer genau einen listen()-Aufruf. Erzeugen Sie den Stream einmal und geben Sie ihn an einen Listener, oder teilen Sie ihn mit asBroadcastStream oder Stream.multi."
pubDate: 2026-10-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "streams"
lang: "de"
translationOf: "2026/10/fix-bad-state-stream-has-already-been-listened-to-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-20
---

`Bad state: Stream has already been listened to.` bedeutet, dass etwas `listen()` ein zweites Mal auf einem Single-Subscription-Stream aufgerufen hat. Dieser Stream-Typ akzeptiert in seiner gesamten Lebensdauer genau ein Abonnement, und das Abbrechen des ersten setzt ihn nicht zurück. In Flutter stammt das zweite `listen()` fast immer von einem `StreamBuilder`: zwei Builder auf demselben Stream, ein Builder, der neu eingehängt wurde, oder ein `.map()`/`.where()` innerhalb von `build()`. Beheben Sie das, indem Sie jeden abgeleiteten Stream einmal erzeugen (in `initState` oder in Ihrem State-Objekt). Wenn tatsächlich mehr als ein Widget die Ereignisse braucht, teilen Sie die Quelle mit `asBroadcastStream()`, einem `StreamController.broadcast()` oder einem `Stream.multi` pro Listener.

Jede Reproduktion und jede Lösung unten wurde mit Flutter 3.44.8 und Dart 3.12.2 ausgeführt: die reinen Dart-Fälle mit `dart run`, die Widget-Fälle als `flutter test`-Widget-Tests.

## Der Fehler im Kontext

In reinem Dart tritt die Exception beim zweiten `listen()` auf, und der oberste Frame ist der Controller, der einen zweiten Abonnenten verweigert:

```text
StateError: Bad state: Stream has already been listened to.
#0      _StreamController._subscribe (dart:async/stream_controller.dart:695:7)
#1      _ControllerStream._createSubscription (dart:async/stream_controller.dart:854:20)
#2      _StreamImpl.listen (dart:async/stream_impl.dart:516:42)
#3      main.<anonymous closure> (file:///.../repro.dart:20:14)
```

In einer Flutter-App wird derselbe `StateError` von der Widgets-Bibliothek abgefangen und dem Widget zugeordnet, das gerade gebaut wurde. Die relevanten Frames sind die beiden `_StreamBuilderBaseState`-Zeilen:

```text
══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞═════════════════════════════════════
The following StateError was thrown building StatefulBuilder(state: _StatefulBuilderState#352fb):
Bad state: Stream has already been listened to.

When the exception was thrown, this was the stack:
#6      _StreamBuilderBaseState._subscribe (package:flutter/src/widgets/async.dart:133:38)
#7      _StreamBuilderBaseState.didUpdateWidget (package:flutter/src/widgets/async.dart:118:7)
#8      StatefulElement.update (package:flutter/src/widgets/framework.dart:5991:55)
```

Ist der Frame unter `_subscribe` `initState`, wurde ein neuer `StreamBuilder`-State erzeugt und auf einen Stream abonniert, der bereits jemand anderem gehört. Ist es `didUpdateWidget`, hat der Builder bei einem Rebuild ein *anderes* Stream-Objekt erhalten und dieses abonniert, und dieses neue Objekt sitzt auf einer Quelle, die bereits vergeben ist. Diese eine Zeile verrät Ihnen, welche der folgenden Ursachen vorliegt.

## Warum ein Stream einen zweiten Listener ablehnt

Dart kennt zwei Arten von Streams. Ein **Single-Subscription**-Stream ist eine einmalige Folge: Er puffert Ereignisse, bis jemand zuhört, liefert sie an diesen einen Listener und ist danach fertig. Ein **Broadcast**-Stream kann beliebig viele Listener haben, puffert aber nichts: Jedes Ereignis geht an diejenigen, die in diesem Moment abonniert sind.

`StreamController()`, `async*`-Generatoren, `Stream.value`, `Stream.periodic`, `Future.asStream()`, `File.openRead()`, `Process.stdout` und der Body einer `http`-`StreamedResponse` sind alle Single-Subscription. Beim zweiten `listen()` wirft der Controller, und er wirft auch dann, wenn das erste Abonnement bereits abgebrochen wurde. Das habe ich explizit geprüft:

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

Zwei weniger offensichtliche Tatsachen verursachen den größten Teil der Verwirrung:

1. **Operatoren hören für Sie zu.** `map`, `where`, `expand`, `asyncMap`, `transform`, `distinct` und Verwandte liefern einen neuen Stream, der seine Quelle abonniert, sobald *er* abgehört wird. `c.stream.where(...)` und `c.stream.map(...)` sind also zwei verschiedene Stream-Objekte, aber beide abzuhören bedeutet dennoch zwei `listen()`-Aufrufe auf `c.stream`, und der zweite wirft.
2. **Konsumierende Methoden hören ebenfalls zu.** `first`, `last`, `length`, `toList()`, `forEach`, `drain`, `await for`, `pipe` und `bytesToString()` auf einem `http`-Body sind intern alle `listen()`. Wer `await stream.first` und danach `await stream.toList()` auf einem `async*`-Stream aufruft, bekommt beim zweiten Aufruf eine Exception.

Auch der Typ verrät nicht zuverlässig, was Sie vor sich haben. Unter Dart 3.12.2 ist `isBroadcast` bei `Stream.fromIterable` `false`, dennoch kann dieser Stream mehrfach abgehört werden (jeder Listener bekommt seinen eigenen Durchlauf über das Iterable), während `Stream.value(1)` und `Future.value(1).asStream()` beim zweiten `toList()` werfen. Behandeln Sie jeden Stream, den Sie nicht selbst erzeugt haben, als Single-Subscription, sofern die Dokumentation nichts anderes sagt.

## Minimale Reproduktion: drei Wege, wie ein StreamBuilder den Fehler auslöst

Alle drei scheitern mit dem obigen Fehler. Der Helper ist lediglich ein `StreamBuilder`, der den letzten Wert ausgibt:

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

Fall B trifft die meisten Leute am häufigsten, weil der erste Frame funktioniert. `StreamBuilder` abonniert nur dann neu, wenn `oldWidget.stream != widget.stream` gilt (das ist die `didUpdateWidget`-Prüfung in `async.dart`), und `c.stream.map(...)` liefert bei jedem `build()` ein neues Objekt. Der erste Build abonniert `map` Nr. 1 auf den Controller. Der nächste Rebuild, ausgelöst etwa durch einen Theme-Wechsel, eine geöffnete Tastatur oder ein `setState` im Parent, erzeugt `map` Nr. 2, `StreamBuilder` kündigt Nr. 1 und abonniert Nr. 2, und Nr. 2 versucht, den Controller ein zweites Mal mit `listen()` abzuhören.

Fall C ist die reale Form von "es stürzt ab, wenn ich zu diesem Tab zurückkehre" oder "es stürzt ab, nachdem ich die Seite verlassen und erneut geöffnet habe". Der Stream lebt an einem langlebigen Ort (ein Service, eine Top-Level-Variable, ein Parent-Widget), der Screen mit dem `StreamBuilder` wird verworfen und neu erzeugt, und der neue `State` ruft `listen()` auf einem Stream auf, der seinen einen Listener bereits hatte. Alles, was die Form des Element-Baums um den Builder herum verändert, löst das aus: Navigation, `IndexedStack`-Alternativen, die Kinder neu aufbauen, bedingte Widgets oder ein `Key`-Wechsel.

Zum Vergleich: Dasselbe Stream-Objekt über Rebuilds hinweg zu übergeben, ohne neu einzuhängen, ist unproblematisch. `StreamBuilder` sieht in `didUpdateWidget` einen identischen Stream und behält sein bestehendes Abonnement. Dieser Fall bestand in derselben Testdatei.

## Die Lösung, nach Priorität geordnet

### 1. Abgeleitete Streams einmal erzeugen, nicht in build()

Wird der Stream nur von einem Widget verwendet, ist Ursache B das ganze Problem, und die Lösung besteht darin, nicht mehr bei jedem Build einen neuen Stream zu erzeugen. Halten Sie ihn im `State`:

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

Die `didUpdateWidget`-Überschreibung ist wichtig: Reicht der Parent eine tatsächlich neue Quelle durch, brauchen Sie dafür einen neuen abgeleiteten Stream, und nur dann. Es ist dieselbe Regel wie bei `FutureBuilder`, und die Argumentation aus [einem Future so initialisieren, dass FutureBuilder es nicht bei jedem Rebuild neu erzeugt](/de/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) lässt sich eins zu eins übertragen. In meinem Test lieferte `c.stream.map(...)`, in einem `final` zwischengespeichert und durch einen Rebuild des Parents gereicht, nach `c.add(21)` den Wert `42`, ohne Fehler.

Dieselbe Disziplin gilt außerhalb von Widgets. Brauchen Sie sowohl den ersten Wert als auch den Rest, entnehmen Sie beides einem einzigen Abonnement, statt `first` und danach `listen` aufzurufen:

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

### 2. Eine Factory statt eines Feldes, wenn jeder Listener frisch beginnen soll

Soll jeder Konsument seine eigene unabhängige Folge erhalten (eine Abfrage, ein Dateilesevorgang, ein Generator), speichern Sie den Stream gar nicht. Speichern Sie eine Funktion, die einen erzeugt, und rufen Sie sie pro Listener auf. Eine `async*`-Funktion ist bereits genau das:

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

Zweimal `countdown(3)` aufzurufen lief ohne Fehler und gab jedem Aufrufer `[3, 2, 1, 0]`. Ein einziges `final s = countdown(3)` für zwei `toList()`-Aufrufe wiederzuverwenden, warf. Die meisten Flutter-Daten-APIs funktionieren bereits so: Eine Repository-Methode wie `watchOrders()`, die bei jedem Aufruf einen neuen Stream liefert, kann bedenkenlos von jedem Widget aufgerufen werden, das sie braucht, solange Sie sie in `initState` aufrufen und nicht in `build()`.

Wünschen Sie ein einzelnes Objekt, das sich wiederholt abhören lässt und sich dennoch pro Listener verhält, bietet `Stream.multi` genau das. Sein Callback läuft einmal pro `listen()` mit dem eigenen Controller dieses Listeners:

```dart
// Dart 3.12.2
final Stream<int> config = Stream<int>.multi((controller) {
  controller.add(1);
  controller.close();
});

// await config.toList(); // [1]
// await config.toList(); // [1] again, no StateError
```

### 3. Eine Quelle mit asBroadcastStream() oder einem Broadcast-Controller teilen

Müssen mehrere Widgets dieselbe *Live*-Quelle beobachten (ein Socket, eine BLE-Characteristic, ein `Process.stdout`), wandeln Sie sie einmal in einen Broadcast-Stream um und geben Sie diesen umgewandelten Stream weiter:

```dart
// Flutter 3.44.8, Dart 3.12.2
class ConnectionService {
  ConnectionService(Stream<int> socketEvents)
      : events = socketEvents.asBroadcastStream();

  final Stream<int> events;
}
```

Mit `final shared = c.stream.asBroadcastStream()` zeigten zwei `StreamBuilder` auf `shared` nach `c.add(5)` beide `5` an, und das erneute Einhängen eines von beiden warf nicht. Wenn Sie den Producer selbst besitzen, erzeugen Sie ihn stattdessen von Anfang an als `StreamController<T>.broadcast()`.

Der Aufruf darf nur **einmal** erfolgen. `widget.stream.asBroadcastStream()` innerhalb von `build()` ist wieder Fall B: Jeder Aufruf erzeugt einen neuen Broadcast-Wrapper, der versucht, dieselbe Single-Subscription-Quelle zu abonnieren.

## Stolperfallen und Varianten

**Broadcast-Streams verwerfen Ereignisse, für die niemand zugehört hat.** Das ist der Preis von Lösung 3, und er zeigt sich als leerer Bildschirm statt als Exception. In meinen Tests erhielt ein später hinzugekommener Listener auf `asBroadcastStream()` nur `[3]`, während der erste Listener `[1, 2, 3]` bekam, und ein auf einem Broadcast-Stream neu eingehängter `StreamBuilder` zeigte `null` bis zum nächsten Ereignis, obwohl `7` zuvor ausgesendet worden war. Ein Single-Subscription-Controller dagegen puffert die `1`, die vor dem ersten Zuhören hinzugefügt wurde. Braucht ein Widget beim Erscheinen den aktuellen Wert, übergeben Sie entweder `initialData` oder verwenden Sie einen wiedergebenden Stream; [den letzten Wert ohne rxdart an spät hinzukommende Abonnenten wiedergeben](/de/2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart/) baut einen solchen auf `Stream.multi` auf.

**`asBroadcastStream()` hält das Quell-Abonnement am Leben.** Standardmäßig pausiert der Wrapper nur, wenn der letzte Broadcast-Listener kündigt, und das `onCancel` der Quelle läuft nie. Meine Messung gab `sourceCancelled(default)=false` aus. Mit `onCancel: (sub) => sub.cancel()` wird die Quelle zwar abgebrochen, ist dann aber endgültig verbraucht: Der nächste Listener auf dem Wrapper erhielt nur `done`. Für einen Socket oder Sensor, den Sie schließen möchten, wenn der Screen verschwindet, verwalten Sie den Lebenszyklus lieber explizit, statt sich auf den Wrapper zu verlassen.

**Abbrechen ist kein Zurücksetzen.** Manche Lösungen im Netz schlagen vor, das alte Abonnement abzubrechen, bevor erneut zugehört wird. Das vermeidet Lecks, und Sie sollten es tun (siehe [eine StreamSubscription in dispose abbrechen](/de/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)), aber es macht einen Single-Subscription-Stream nicht wiederverwendbar. Das schafft nur ein neuer Stream.

**Hot Reload behält den kaputten Stream.** Hot Reload bewahrt `State` und Top-Level-Variablen, sodass ein bereits konsumierter Stream in der laufenden App auch nach der Korrektur des Codes weiterhin konsumiert ist. Führen Sie einen Hot Restart durch oder stoppen und starten Sie die App, bevor Sie entscheiden, dass die Lösung nicht funktioniert hat.

**`http`-Bodies sind einmalig verwendbar.** `StreamedResponse.stream` kann nur einmal gelesen werden. Logging-Middleware, die `response.stream.bytesToString()` aufruft und dieselbe Response dann an den Aufrufer zurückgibt, lässt den Lesevorgang des Aufrufers diesen Fehler werfen. Lesen Sie den Body einmal in Bytes ein und bauen Sie daraus eine neue `http.Response`, falls weiter unten im Ablauf noch jemand sie braucht.

**State-Management-Bibliotheken nehmen Ihnen das meist ab.** Der `stream` eines `Bloc` und Riverpods `StreamProvider` stellen bereits Broadcast- oder Pro-Listener-Streams bereit, der Fehler bedeutet daher meist, dass daneben ein roher Controller herumgereicht wurde. Wenn Sie einen Screen von rohen `StreamBuilder`n wegmigrieren, behandeln [FutureBuilder und StreamBuilder im Vergleich zu Riverpods AsyncValue](/de/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/) und [Notifier vs AsyncNotifier vs StreamNotifier](/de/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/), welcher Provider-Typ den Stream-Lebenszyklus besitzt.

**Ähnlicher Fehler: `Bad state: Cannot add new events after calling close`.** Derselbe `StateError`-Typ, aber auf der anderen Seite des Streams: Der Producer hat `add` auf einem geschlossenen Controller aufgerufen, meist aus einem Timer oder Callback, der `dispose()` überlebt hat. **Ähnlicher Fehler: `Bad state: No element`.** Er stammt von `first`, `single` oder `last` auf einem Stream (oder Iterable), der leer abgeschlossen wurde. Keiner von beiden wird durch Broadcast-Streams behoben.

## Verwandte Artikel

- [Eine StreamSubscription in dispose abbrechen, um einen Absturz durch setState nach dispose in Flutter zu vermeiden](/de/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/)
- [Den letzten Wert ohne rxdart an spät hinzukommende Abonnenten eines Dart-Streams wiedergeben](/de/2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart/)
- [Ein Future so initialisieren, dass FutureBuilder es nicht bei jedem Rebuild neu erzeugt](/de/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/)
- [FutureBuilder und StreamBuilder im Vergleich zu Riverpod AsyncValue in Flutter](/de/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/)
- [Riverpod Notifier vs AsyncNotifier vs StreamNotifier](/de/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/)

## Quellen

- [Asynchronous programming: Streams](https://dart.dev/libraries/async/using-streams) auf dart.dev, der Abschnitt zu Single-Subscription und Broadcast.
- [Creating streams in Dart](https://dart.dev/libraries/async/creating-streams), das `async*`, `StreamController` und deren jeweiligen Einsatz behandelt.
- API-Referenz zu [`Stream.asBroadcastStream`](https://api.dart.dev/stable/dart-async/Stream/asBroadcastStream.html) und [`Stream.multi`](https://api.dart.dev/stable/dart-async/Stream/Stream.multi.html).
- API-Referenz zu [`StreamBuilder`](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html) sowie die Implementierung von `_StreamBuilderBaseState.didUpdateWidget` in `packages/flutter/lib/src/widgets/async.dart` von Flutter 3.44.8.
