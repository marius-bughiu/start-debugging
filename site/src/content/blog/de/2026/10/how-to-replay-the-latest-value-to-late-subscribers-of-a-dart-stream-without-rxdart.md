---
title: "Wie Sie den letzten Wert an spät hinzukommende Abonnenten eines Dart-Streams ausliefern, ohne BehaviorSubject von rxdart"
description: "Ein Broadcast-StreamController verwirft jedes Ereignis, das vor dem Abonnieren ausgelöst wurde. Hier ist ein abhängigkeitsfreier Ersatz für BehaviorSubject auf Basis von Stream.multi, eine replayLatest()-Extension für bestehende Streams, die async*-Abkürzung, die stillschweigend Ereignisse verliert, und das Detail zu initialData bei StreamBuilder, alles verifiziert mit Dart 3.12.2."
pubDate: 2026-10-18
template: how-to
tags:
  - "dart"
  - "flutter"
  - "streams"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-replay-the-latest-value-to-late-subscribers-of-a-dart-stream-without-rxdart"
translatedBy: "claude"
translationDate: 2026-10-18
---

**Kurzantwort:** Verpacken Sie einen `StreamController.broadcast()` in eine kleine Klasse, die zusätzlich den letzten Wert speichert, und stellen Sie den Stream über `Stream.multi` bereit. `Stream.multi` ruft Ihren `onListen`-Callback einmal pro Abonnent auf, mit dem eigenen `MultiStreamController` dieses Abonnenten. So können Sie den zwischengespeicherten Wert per `add` nur an den neuen Listener senden und anschließend die Broadcast-Ereignisse weiterleiten. Das ist das gesamte Verhalten von `BehaviorSubject` aus rxdart, in etwa 40 Zeilen `dart:async`. `Stream.multi` gehört seit Dart 2.9 zum SDK, und jedes Snippet unten wurde mit Dart 3.12.2 ausgeführt (dem SDK, das mit Flutter 3.44 ausgeliefert wird).

Der Rest dieses Beitrags zeigt, warum der einfache Broadcast-Controller scheitert, die vollständige Klasse, eine Extension, die jeden bestehenden Stream in einen wiedergebenden Stream verwandelt, und die Randfälle, die in einer Flutter-App zählen: Fehler, `close()`, Pause, Abbruch und der erste Frame eines `StreamBuilder`.

## Warum ein Broadcast-Stream alles vergisst

Ein `StreamController` mit Einzelabonnement puffert Ereignisse, bis jemand zuhört, erlaubt aber genau einen Listener. Ein Broadcast-Controller erlaubt beliebig viele Listener, und der Preis dafür ist, dass er nichts puffert. Ein Ereignis wird an alle zugestellt, die in dem Moment abonniert sind, in dem es ausgelöst wird, und danach ist es weg.

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

Das ist der richtige Standard für ereignisartige Daten (Taps, Benachrichtigungen, Log-Zeilen) und der falsche für zustandsartige Daten. Wenn der Stream "den aktuellen Benutzer" oder "den Verbindungsstatus" repräsentiert, zeigt ein Widget, das nach der letzten Änderung abonniert, nichts an, bis die nächste Änderung eintrifft, die vielleicht nie kommt. In Flutter zeigt sich das meist als `StreamBuilder`, der im Lade-Zweig hängen bleibt, auf einem Bildschirm, zu dem Sie navigiert sind, nachdem die Daten bereits geladen waren.

rxdart löst das mit `BehaviorSubject`, das das letzte Ereignis speichert und an jeden neuen Abonnenten ausgibt. Wenn Sie bereits von rxdart abhängen, verwenden Sie es. Wenn Sie nur dieses eine Verhalten brauchen, ist eine komplette Reactive-Extensions-Bibliothek dafür überdimensioniert, und das SDK bringt die benötigte Primitive bereits mit.

## Die Primitive: Stream.multi gibt jedem Listener einen eigenen Controller

`Stream<T>.multi(void Function(MultiStreamController<T>) onListen, {bool isBroadcast = false})` erzeugt einen Stream, dem beliebig oft zugehört werden kann. Jeder Aufruf von `listen` ruft `onListen` mit einem frischen `MultiStreamController` auf, und alles, was Sie diesem Controller per `add` übergeben, geht nur an dieses eine Abonnement.

Genau diesen Hook pro Listener hat ein Broadcast-Controller nicht. `StreamController.broadcast(onListen: ...)` ruft `onListen` nur auf, wenn die Zahl der Listener von null auf eins steigt. Der zweite, dritte und hundertste Abonnent bekommt also nie einen Callback, in dem Sie ihm den zwischengespeicherten Wert übergeben könnten.

Das Flag `isBroadcast` ändert das Verhalten nicht. Es setzt nur den Getter `Stream.isBroadcast`, den manche Konsumenten prüfen. Setzen Sie es auf `true`, wenn sich Ihr Stream wie ein Broadcast-Stream verhält (mehrere Listener erlaubt, keine Pufferung der Vergangenheit pro Listener über das hinaus, was Sie wiedergeben), was hier der Fall ist.

## Schritt für Schritt: ein abhängigkeitsfreies BehaviorSubject

1. Halten Sie einen Broadcast-`StreamController` als Ereignis-Hub.
2. Speichern Sie den letzten Wert (und ob es einen gibt) daneben.
3. Stellen Sie eine einzelne `Stream.multi`-Instanz bereit, deren `onListen` zuerst den zwischengespeicherten Wert zum Controller des neuen Abonnenten hinzufügt und dann die Hub-Ereignisse an ihn weiterleitet.
4. Verbinden Sie Pause, Resume und Cancel des Controllers pro Listener mit dem Hub-Abonnement, damit nichts leckt.

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

Die Verwendung sieht so aus:

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

`B` hat nach der Ausgabe von `2` abonniert und diese trotzdem erhalten, gefolgt von allen späteren Ereignissen. `A` bekam kein doppeltes `2`, als `B` hinzukam, weil die Wiedergabe an den eigenen Controller von `B` ging.

Einige bewusste Entscheidungen in dieser Klasse:

- **`stream` ist ein `late final`-Feld, kein Getter.** Eine `Stream.multi`-Instanz kann beliebig oft abonniert werden, es gibt also keinen Grund, bei jedem Zugriff eine neue zu erzeugen. So bleibt außerdem `identical(store.stream, store.stream)` wahr, was für `StreamBuilder` wichtig ist (dazu unten mehr).
- **Die Wiedergabe verwendet `add`, nicht `addSync`.** `MultiStreamController` hat `addSync`, `addErrorSync` und `closeSync`, die sofort zustellen. Die API-Dokumentation sagt, sie nur zu verwenden, wenn der Listener bereit ist, Ereignisse zu empfangen, typischerweise innerhalb eines anderen asynchronen Callbacks. Würden sie in `onListen` aufgerufen, würde ein Ereignis zugestellt, bevor `listen()` das Abonnement überhaupt zurückgegeben hat. Das verletzt die Dart-Konvention, dass Streams während `listen` nie synchron Ereignisse ausgeben. Ein normales `add` reiht das Ereignis ein und bewahrt die Reihenfolge: In meinem Test lieferte ein `listen`, gefolgt von zwei synchronen `add`-Aufrufen, die Ausgabe `100, 101, 102`, in dieser Reihenfolge.
- **Fehler werden ebenfalls wiedergegeben.** Wenn das Letzte, was passiert ist, ein Fehler war, sieht ein später hinzukommender Abonnent den Fehler statt eines veralteten Werts. Entfernen Sie den `_error`-Zweig, wenn Sie lieber den letzten guten Wert wiedergeben möchten. `BehaviorSubject` gibt das letzte Ereignis wieder, Fehler eingeschlossen, daher entspricht dies seinem Verhalten.

## Einen bestehenden Stream in einen wiedergebenden verwandeln

Oft besitzen Sie den Controller nicht. Sie erhalten einen `Stream<T>` von einem Plugin, einem Firestore-Snapshot oder einem `Socket`, und mehrere Widgets sollen ihn mit wiedergegebenem letzten Wert gemeinsam nutzen. Die SDK-Dokumentation zu `Stream.multi` enthält ein Beispiel `repeatLatest()` in dieser Art. Hier ist eine Version, die zusätzlich Fehler, Abschluss und verzögerte Verbindung behandelt:

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

Sie funktioniert mit Quellen mit Einzelabonnement, und genau das ist der Sinn: Die Extension hört der Quelle genau einmal zu und verteilt die Ereignisse.

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

Beachten Sie, was diese Extension bewusst nicht tut: Sie bricht das Abonnement der Quelle nie ab, auch wenn alle Listener weg sind. Das unterscheidet sich von `shareValue()` aus rxdart, das referenzgezählt ist und die Quelle abbricht, wenn der letzte Listener geht. Diese Extension verhält sich wie `publishValue()`, einmal verbunden und am Leben gehalten, was Sie für Zustand mit App-Lebensdauer wollen. Wenn die Quelle teuer ist (ein GPS-Stream, ein WebSocket), fügen Sie Referenzzählung hinzu: Zählen Sie die aktiven Controller pro Listener in `onListen` und `onCancel` mit und brechen Sie `source` ab, wenn die Zahl auf null fällt. Entscheiden Sie vorab, ob ein Abonnent, der danach hinzukommt, noch den alten zwischengespeicherten Wert erhalten oder auf eine neue Verbindung warten soll.

## Die async*-Abkürzung, die Ereignisse verliert

Das Erste, was die meisten versuchen, ist ein Generator:

```dart
// Dart 3.12.2 - looks right, is racy
Stream<T> withLatest<T>(T Function() current, Stream<T> updates) async* {
  yield current();
  yield* updates;
}
```

Das liest sich einwandfrei und ist falsch. Eine `async*`-Funktion pausiert bei `yield`, bis das Ereignis zugestellt wurde, und fährt erst dann mit der Zeile `yield*` fort, also in dem Moment, in dem sie den Broadcast-Stream `updates` abonniert. Alles, was zwischen dem `listen`-Aufruf und diesem Abonnement ausgegeben wird, fällt in die Lücke. Ich habe das mit einem Ereignis reproduziert, das einen Microtask nach `listen` eingeplant wurde:

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

Die `21` wird nie ausgegeben. Der Abonnent zeigt nun `20`, während der echte Zustand `21` ist, und kein späteres Ereignis korrigiert das, bis sich etwas anderes ändert. Die `Stream.multi`-Version hat diese Lücke nicht, weil sie den Hub synchron innerhalb von `onListen` abonniert, bevor ein eingereihtes Ereignis feuern kann.

## Fallstricke in einer Flutter-App

**`StreamBuilder` zeigt weiterhin einen Frame "waiting".** Die Wiedergabe ist asynchron (das ist die Wahl zwischen `add` und `addSync` von oben), und `StreamBuilder` baut seinen ersten Frame direkt nach dem Abonnieren in `initState`. Ohne Hilfe hat dieser erste Frame `ConnectionState.waiting` und keine Daten, was sich als einen Frame langes Aufblitzen Ihres Ladeindikators zeigt. Da `ValueStream` den aktuellen Wert synchron bereitstellt, übergeben Sie ihn als `initialData`:

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

**Bauen Sie den Stream nicht innerhalb von `build`.** `StreamBuilder` abonniert neu, wenn er einen Stream erhält, der nicht dasselbe Objekt wie zuvor ist. Ein Getter, der bei jedem Zugriff `Stream.multi(...)` oder `source.replayLatest()` zurückgibt, erzeugt pro Rebuild einen neuen Stream, sodass jeder Rebuild abbricht und neu abonniert, und mit `replayLatest()` öffnet er zusätzlich ein neues Abonnement der Quelle. Erzeugen Sie den Stream einmal, in einem Feld, einem Service oder `initState`. Dieselbe Regel gilt für Futures, wie in [wie Sie ein Future initialisieren, damit FutureBuilder es nicht bei jedem Rebuild neu erzeugt](/de/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) beschrieben.

**Das Abbrechen ist verdrahtet, aber Sie müssen trotzdem abbrechen.** Weil `onCancel` an das Hub-Abonnement weitergeleitet wird, wird ein abgebrochener Listener aus dem Broadcast-Controller entfernt. In meinem Test ging `_hub.hasListener` nach `cancel()` von `true` auf `false`. Listener, auf denen Sie `listen` manuell aufrufen, brauchen weiterhin ein `StreamSubscription`-Feld und ein `cancel()` in `dispose`, genau wie in [StreamSubscription in dispose abbrechen](/de/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/). `StreamBuilder` erledigt das für Sie.

**Schließen Sie den Hub, wenn der Besitzer verschwindet.** Ein `ValueStream`, der dem `State` eines Widgets gehört, sollte in `dispose()` geschlossen werden, neben Ihren anderen Controllern, wie in [Controller freigeben, um Speicherlecks zu vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) beschrieben. Das Abonnieren nach `close()` ist sicher: Der Abonnent erhält den letzten Wert und danach ein Done-Ereignis.

**Nicht behandelte wiedergegebene Fehler bleiben nicht behandelt.** Wenn Sie einen Fehler an einen Listener ohne `onError` wiedergeben, wird er zu einem nicht abgefangenen asynchronen Fehler und geht an den Fehler-Handler der Zone, in Flutter `PlatformDispatcher.instance.onError`. Siehe [nicht abgefangene asynchrone Fehler in Flutter abfangen](/de/2026/10/how-to-catch-uncaught-async-errors-in-flutter-with-runzonedguarded-and-platformdispatcher/), um zu sehen, wo das landet.

**Gleichheitsfilterung ist eine separate Entscheidung.** `BehaviorSubject` dedupliziert nicht, und diese Klasse ebenfalls nicht. Wenn Sie "nur ausgeben, wenn sich der Wert ändert" wollen, fügen Sie in `add` eine Absicherung `if (value == _value) return;` hinzu, und beachten Sie die Kompromisse bei veränderlichen Objekten, die denselben Fehler machen wie [der Gleichheitsfilter von Riverpods StreamProvider](/de/2026/07/fix-riverpod-3-0-streamprovider-stops-emitting-filtered-by-equality/).

## Wann Sie gar keinen Stream brauchen

Wenn der Wert nur Widgets speist und nie eine asynchrone Grenze überquert, ist ein `ValueNotifier<T>` mit `ValueListenableBuilder` einfacher als jeder Stream: Er hat einen synchronen `value`, benachrichtigt Listener bei Änderungen, und der Builder liest den aktuellen Wert im ersten Frame, sodass es kein Aufblitzen der Ladeanzeige gibt. Greifen Sie zum wiedergebenden Stream, wenn Sie Stream-Operatoren brauchen (`where`, `asyncMap`, `debounce`-artige Transformationen), wenn die Daten aus einer bestehenden `Stream`-API kommen oder wenn eine State-Management-Bibliothek wie Riverpods `StreamProvider` einen Stream erwartet. Einen breiteren Vergleich dieser Optionen finden Sie unter [FutureBuilder und StreamBuilder im Vergleich zu Riverpods AsyncValue](/de/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).

Und wenn Sie mehr als den letzten Wert brauchen, etwa "die letzten 10 Ereignisse wiedergeben" oder "alles wiedergeben", funktioniert dieselbe `Stream.multi`-Struktur mit einer begrenzten `Queue<T>` statt eines einzelnen Felds. An diesem Punkt implementieren Sie `ReplaySubject` aus rxdart neu, und das Hinzufügen des Pakets ist ein vernünftiger Kompromiss.

## Quellen

- [Stream.multi constructor, Dart API docs](https://api.dart.dev/stable/dart-async/Stream/Stream.multi.html)
- [MultiStreamController class, Dart API docs](https://api.dart.dev/stable/dart-async/MultiStreamController-class.html)
- [StreamController.broadcast, Dart API docs](https://api.dart.dev/stable/dart-async/StreamController/StreamController.broadcast.html)
- [Dart SDK 2.9 changelog entry for Stream.multi](https://dart.googlesource.com/sdk/+/refs/tags/2.9.1/CHANGELOG.md)
- [rxdart on pub.dev (BehaviorSubject, ReplaySubject, shareValue)](https://pub.dev/packages/rxdart)
- [Asynchronous programming: streams, dart.dev](https://dart.dev/libraries/async/using-streams)
- [StreamBuilder class, Flutter API docs](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html)
