---
title: "Wie man ein StreamSubscription in dispose abbricht, um einen setState-nach-dispose-Absturz in Flutter zu vermeiden"
description: "Ein Stream emittiert weiter, nachdem der Nutzer den Bildschirm verlassen hat, sein onData ruft setState auf einem bereits zerstörten State auf, und Flutter wirft eine Exception. Speichern Sie die Subscription, brechen Sie sie in dispose vor super.dispose ab, und der Callback kann niemals auf einem toten Widget feuern. Das vollständige Muster für Flutter 3.44."
pubDate: 2026-07-13
template: how-to
tags:
  - "flutter"
  - "dart"
  - "async"
lang: "de"
translationOf: "2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-13
---

Wenn Sie `stream.listen(...)` innerhalb eines `State` aufrufen, besitzen Sie die Subscription und müssen sie in `dispose()` abbrechen. Tun Sie das nicht, liefert der Stream weiter Ereignisse aus, nachdem der Nutzer den Bildschirm verlassen hat, der `onData`-Callback führt `setState` auf einem `State` aus, der bereits zerstört wurde, und Flutter wirft `setState() called after dispose()`. Die Lösung sind drei Zeilen: Speichern Sie das `StreamSubscription` in einem Feld, erstellen Sie es in `initState`, und rufen Sie `_sub.cancel()` in `dispose()` vor `super.dispose()` auf. Das Abbrechen stoppt die Auslieferung, sodass der Callback überhaupt nie auf einem toten Widget läuft. Diese Anleitung verwendet Flutter 3.44 (aktuelle stabile Version, 2026) und Dart 3.x.

Die Unterscheidung, auf die es ankommt: Abbrechen ist die echte Lösung, und eine `mounted`-Prüfung ist nur ein Pflaster über dem Symptom. Ein `StreamSubscription` ist eine lebende Leitung zwischen einer Quelle, die Ihr Widget überlebt (ein `StreamController`, ein Firestore-Snapshot-Listener, ein WebSocket, ein Sensor, `connectivity_plus`), und einem Callback, der `this` erfasst. Solange diese Leitung offen ist, ist Ihr `State` erreichbar und Ihr `onData` läuft bei jedem Ereignis, zerstört oder nicht. Das Schließen der Leitung ist der Punkt, an dem das Speicherleck und der Absturz zugleich verschwinden.

## Warum der Callback das Widget überlebt

Der Widget-Lebenszyklus von Flutter und der Lebenszyklus eines Streams sind vollständig unabhängig. Das Framework zerstört Ihren `State`, wenn dessen Element den Baum verlässt: Der Nutzer entfernt die Route per Pop, ein Elternteil baut Sie aus der Existenz heraus, ein Tab wechselt. Nichts davon berührt den Stream. Der `StreamController` am anderen Ende hat keine Ahnung, dass ein Widget zugehört hat, geschweige denn, dass das Widget weg ist. Er produziert weiter Ereignisse, und Dart verteilt sie weiter an jede registrierte Subscription, einschließlich Ihrer.

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

Dieser Code besteht jeden schnellen Test, denn in einem schnellen Test verlassen Sie den Bildschirm nicht, während ein Ereignis unterwegs ist. Schieben Sie eine neue Route auf den Stack, während `priceStream` noch einmal pro Sekunde emittiert, und der nächste Tick landet in `onData`, das `setState` auf einem toten `State` aufruft. Im Debug erhalten Sie einen `FlutterError`: `setState() called after dispose(): _PriceTickerState#4f2a1(lifecycle state: defunct, not mounted)`. Die von `listen` zurückgegebene Subscription wurde weggeworfen, also gibt es kein Handle zum Abbrechen und nichts, was das Ereignis stoppt. Der `State` kann auch nicht per Garbage Collection eingesammelt werden, weil die interne Subscription-Liste des Streams noch immer die Closure referenziert, die ihn erfasst hat. Das ist derselbe Besitz-Fehler hinter [dem Zerstören von Controllern, um Speicherlecks zu vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/): eine Ressource, die Sie erstellt und nie freigegeben haben.

## Das Muster, Schritt für Schritt

### Schritt 1: Speichern Sie die Subscription in einem Feld

`listen` gibt ein `StreamSubscription<T>` zurück. Behalten Sie es. Dieses Handle ist der einzige Weg, später abzubrechen.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';

class _PriceTickerState extends State<PriceTicker> {
  StreamSubscription<double>? _sub;
  double _price = 0;
  // ...
}
```

Verwenden Sie ein nullbares Feld (`StreamSubscription<double>?`), wenn die Subscription bedingt erstellt wird, damit `dispose` sicher `_sub?.cancel()` aufrufen kann. Wenn Sie sich immer genau einmal in `initState` anmelden, ist ein `late final StreamSubscription<double> _sub;` sauberer, weil es dokumentiert, dass das Feld immer zugewiesen wird, und Ihnen erlaubt, bedingungslos abzubrechen.

### Schritt 2: Melden Sie sich in initState an, nicht in build

Erstellen Sie die Subscription in `initState` (oder in `didChangeDependencies`, wenn der Stream von einem Inherited Widget kommt), niemals in `build`. `build` läuft bei jedem Frame, sodass das Anmelden dort bei jedem Rebuild einen neuen Listener stapelt, und jeder feuert `setState`, das einen weiteren Rebuild einplant. Diese Rückkopplungsschleife ist eine andere Fehlerklasse als die dieses Beitrags und tritt als [setState() or markNeedsBuild() called during build](/de/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) auf.

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

### Schritt 3: Brechen Sie in dispose ab, vor super.dispose

Dies ist die Zeile, die den Absturz tatsächlich behebt.

```dart
// Flutter 3.44, Dart 3.x
@override
void dispose() {
  _sub?.cancel();
  super.dispose();
}
```

Die Reihenfolge ist genauso wichtig wie bei Controllern: Geben Sie zuerst Ihre eigenen Ressourcen frei, übergeben Sie dann die Kontrolle mit `super.dispose()` an das Framework. Nachdem `cancel()` zurückgekehrt ist, ist die Subscription tot. Sie liefert keinen weiteren `onData`-, `onError`- oder `onDone`-Callback aus, selbst für Ereignisse, die die Quelle bereits produziert, aber noch nicht verteilt hat. Das ist die Garantie, die Sie erkaufen: Die Closure, die `setState` aufruft, kann nicht mehr laufen, sodass der zerstörte `State` unberührbar ist.

## Warum Sie cancel in dispose nicht abwarten

`StreamSubscription.cancel()` gibt ein `Future<void>` zurück, und `dispose()` gibt `void` zurück, sodass Sie es nicht mit `await` abwarten können. Das bringt Leute durcheinander, aber es ist kein Problem. Das Future wird abgeschlossen, wenn der `onCancel`-Callback des Streams jegliches Aufräumen beendet hat, das er benötigt (ein Socket schließen, ein File Handle freigeben). Die Auslieferung an Ihren Callback stoppt sofort, unabhängig davon, wann dieses Future aufgelöst wird. Für den Zweck, `setState` nicht auf einem toten Widget aufzurufen, ist das nicht abgewartete `cancel()` in dem Moment voll wirksam, in dem es aufgerufen wird.

Das Future ist nur wichtig, wenn Sie speziell wissen müssen, wann die Quelle mit dem Aufräumen fertig war, was innerhalb eines Widgets selten ist. Wenn Sie den `StreamController` selbst besitzen und garantieren wollen, dass sein `onCancel` gelaufen ist, bevor Sie fortfahren, führen Sie dieses Aufräumen außerhalb von `dispose` durch, wo Sie es mit await abwarten können.

## Mehrere Subscriptions in einem Widget

Ein Bildschirm hört oft mehreren Streams zu: Konnektivität, ein Datenfeed, ein Stream für die Tastatur-Sichtbarkeit. Brechen Sie jeden ab. Zwei saubere Ansätze.

Getrennte Felder, wenn die Subscriptions von unterschiedlichen Typen sind und Sie sie einzeln referenzieren:

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

Eine Liste, wenn Sie sie nur alle zusammen abbauen müssen:

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

Die Liste skaliert, ohne dass Sie daran denken müssen, für jedes neue Feld eine passende `cancel`-Zeile hinzuzufügen, was genau die Art von Auslassung ist, die den Absturz Monate später wieder einführt.

## Erneut anmelden, ohne die alte Subscription zu lecken

Wenn der Stream, dem Sie zuhören, von einer Widget-Eigenschaft oder einem geerbten Wert abhängt, kann sich die Quelle ändern, während das Widget montiert bleibt. Behandeln Sie das in `didUpdateWidget` oder `didChangeDependencies`, und brechen Sie die vorherige Subscription ab, bevor Sie eine neue öffnen. Das Auslassen des Abbrechens leckt die alte und hält deren `setState` auf demselben `State` am Leben.

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

## Wenn Sie den StreamController besitzen, schließen Sie ihn auch

Eine Subscription abzubrechen und einen Controller zu schließen sind verschiedene Verantwortlichkeiten. Brechen Sie Ihre Subscription ab, wenn Sie nur Konsument des Streams einer anderen Instanz sind. Wenn Ihr Widget auch den `StreamController` erstellt hat, der den Stream stützt, schließen Sie den Controller ebenfalls in `dispose`, sonst lecken der Controller und sein Buffer.

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

Ein Controller mit einzelner Subscription lässt keinen zweiten Listener andocken, also erstellen Sie ihn mit `StreamController.broadcast()`, falls Sie diesen Stream auch anderswo bereitstellen, und denken Sie daran, dass jeder Listener auf einem Broadcast-Stream sein eigenes `cancel` braucht.

## Warum StreamBuilder oft die bessere Antwort ist

Wenn das Einzige, was Ihre Subscription tut, das Einspeisen eines Werts in die Oberfläche ist, müssen Sie wahrscheinlich überhaupt keine Subscription verwalten. `StreamBuilder` meldet sich an, wenn er eingefügt wird, baut bei jedem Ereignis über seinen `builder` neu, und bricht automatisch ab, wenn er aus dem Baum entfernt wird. Es gibt kein `setState`, kein Feld, keine Buchhaltung in `dispose` und damit keine Möglichkeit, eine Subscription über die Zerstörung hinaus laufen zu lassen.

```dart
// Flutter 3.44, Dart 3.x
StreamBuilder<double>(
  stream: priceStream,
  builder: (context, snap) => Text('${snap.data ?? 0}'),
)
```

Greifen Sie nur dann zu einem manuellen `listen` plus `setState`, wenn das Ereignis etwas anderes tut als zu rendern: bei einem Abschlussereignis navigieren, eine `SnackBar` zeigen, in einen anderen Controller schreiben, einen Nebeneffekt auslösen. Das sind genau die Fälle, in denen ein veralteter Callback gefährlich ist, und genau dort ist das Abbrechen in `dispose` nicht verhandelbar. Derselbe Kompromiss zwischen manueller und verwalteter Handhabung tritt beim `TextEditingController` auf, weshalb [ein nach der Zerstörung verwendeter Controller](/de/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/) den analogen Fehler wirft.

## pause ist nicht cancel, und mounted ist kein Ersatz

Zwei Abkürzungen sehen so aus, als würden sie das lösen, und tun es nicht.

`StreamSubscription.pause()` stoppt die Auslieferung vorübergehend, aber eine pausierte Subscription bleibt registriert und hält weiterhin Ihren `State`. Das Pausieren in `dispose` leckt; Sie müssen `cancel` verwenden.

Ein `if (!mounted) return;` am Anfang von `onData` verhindert den `setState`-Aufruf, aber es stoppt den Stream nicht. Die Subscription bleibt am Leben, verteilt weiter Ereignisse und hält Ihren `State` weiter erreichbar. Der Absturz wird maskiert, während das Leck weiterläuft. Verwenden Sie die `mounted`-Prüfung nur für den Fall, für den sie gedacht ist, ein `await` innerhalb des Callbacks, das fortgesetzt wird, nachdem das Widget weg ist, und decken Sie das gründlich ab, indem Sie lernen, [setState mit der mounted-Prüfung nach einer async-Lücke abzusichern](/de/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/). Für den einfachen Fall "der Stream emittiert weiter" ist cancel die korrekte und vollständige Lösung.

Wenn Ihr `onData` selbst asynchron ist, können Sie auf beide Probleme gleichzeitig stoßen: Die Subscription liefert ein Ereignis, Sie verwenden `await` im Handler, und das Widget wird während des await zerstört. Cancel behandelt die Auslieferung; die `mounted`-Prüfung behandelt die Fortsetzung nach dem await. Dort ist doppelte Absicherung gerechtfertigt.

## Die Ein-Datei-Version zum Kopieren

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

Speichern Sie die Subscription, brechen Sie sie vor `super.dispose()` ab, und der `setState()-nach-dispose()`-Absturz wird strukturell unmöglich statt nur wahrscheinlichkeitsbedingt vermieden. Streaming-State, der aus dem Netzwerk kommt, verdient dieselbe Sorgfalt auf dem Fehlerpfad, was einen Blick darauf wert ist, wie man [Netzwerkfehler in einer Flutter-App elegant behandelt](/de/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/), damit ein fehlgeschlagener Stream einen Zustand zeigt, auf den der Nutzer reagieren kann, statt eines Spinners, der sich nie auflöst.

## Quellen

- [StreamSubscription.cancel API](https://api.flutter.dev/flutter/dart-async/StreamSubscription/cancel.html) - der cancel-Vertrag und sein `Future<void>`-Rückgabewert.
- [State.dispose API](https://api.flutter.dev/flutter/widgets/State/dispose.html) - "subclasses should override this method to release any resources retained by this object (e.g., stop any active animations)".
- [StreamBuilder class](https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html) - automatisches An- und Abmelden, gebunden an den Widget-Lebenszyklus.
- [Dart streams tutorial](https://dart.dev/libraries/async/using-streams) - Streams mit einzelner Subscription gegenüber Broadcast und Listener-Verwaltung.
