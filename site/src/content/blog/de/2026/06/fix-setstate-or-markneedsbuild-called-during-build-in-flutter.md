---
title: "Lösung: setState() or markNeedsBuild() called during build in Flutter"
description: "Dieser Fehler bedeutet, dass Sie den Zustand während des Build geändert haben. Verlagern Sie setState aus build heraus oder verschieben Sie es mit addPostFrameCallback. Hier sind die Ursache und die richtige Lösung."
pubDate: 2026-06-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "de"
translationOf: "2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-02
---

Sie haben `setState()` aufgerufen (oder etwas, das `notifyListeners()`, `markNeedsBuild()` oder `Navigator.push` aufruft), während sich Flutter mitten in seiner Build-Phase befand. Die Lösung besteht darin, den Zustand während `build` nicht zu ändern. Wenn der Auslöser wirklich ein synchroner Callback ist, der mitten im Build ausgeführt wird, verschieben Sie die Mutation mit `WidgetsBinding.instance.addPostFrameCallback((_) => setState(...))` auf den nächsten Frame. Diese Anleitung verwendet Flutter 3.44 (stabil, Mai 2026) und Dart 3.x.

Der Fehler ist eine Schutzvorrichtung, kein Defekt. Flutter kompiliert Eltern vor Kindern in einem einzigen synchronen Durchlauf. Ein Widget mitten im Durchlauf als veraltet zu markieren, würde das Framework auffordern, eine Neukompilierung für etwas zu planen, das es möglicherweise bereits besucht hat, was im aktuellen Frame nicht erfüllt werden kann. Daher wirft es eine Ausnahme, anstatt Ihre Aktualisierung stillschweigend zu verwerfen.

## Der Fehler im Kontext

Die vollständige Meldung, die Flutter in der Konsole ausgibt, sieht so aus:

```
======== Exception caught by widgets library =======================
The following assertion was thrown while dispatching notifications for ProductModel:
setState() or markNeedsBuild() called during build.

This _MyHomePageState widget cannot be marked as needing to build because the
framework is already in the process of building widgets. A widget can be marked
as needing to be built during the build phase only if one of its ancestors is
currently building. This exception is allowed because the framework builds parent
widgets before children, which means a dirty descendant will always be built.
Otherwise, the framework might not visit this widget during this build phase.

The widget on which setState() or markNeedsBuild() was called was: _MyHomePageState
The widget which was currently being built when the offending call was made was: Consumer<ProductModel>
====================================================================
```

Die beiden Zeilen, die zählen, stehen am Ende. "The widget on which setState() ... was called" ist das, was Sie neu kompilieren wollen. "The widget which was currently being built" ist der Ursprung des problematischen Aufrufs. Die Lücke zwischen diesen beiden Widgets ist der Bug.

## Warum das passiert

Es gibt vier häufige Auslöser, grob in der Reihenfolge, wie oft sie zuschlagen:

Ein Listener benachrichtigt während des Build. Ein `ChangeNotifier`, `ValueNotifier` oder Provider ruft `notifyListeners()` aus einer Methode auf, die Sie aufgerufen haben, während Sie sie in `build` gelesen haben. Die Benachrichtigung fordert jedes lauschende Widget synchron zur Neukompilierung auf, aber Sie kompilieren bereits eines davon.

Sie haben `setState` direkt in `build` aufgerufen. Meist aus Versehen: Eine Methode, die einen Wert berechnet, setzt auch ein Flag und ruft `setState` auf, und Sie rufen diese Methode aus `build` auf.

Sie haben einen Provider mit `listen: true` während eines Build gelesen, der ihn auch mutiert. `Provider.of<T>(context)` (lauschend) registriert eine Abhängigkeit. Wenn derselbe Frame in diesen Provider schreibt, versucht der Schreibvorgang, den abhängigen Bestandteil neu zu kompilieren, der noch kompiliert wird.

Sie haben aus `build` heraus navigiert oder einen Dialog angezeigt. `Navigator.push`, `showDialog` und `Scaffold.of(context).showSnackBar` markieren Vorfahren als veraltet. Sie aus `build` aufzurufen (statt aus einem Event-Handler) löst dieselbe Assertion aus.

Die vereinheitlichende Regel des Flutter-Teams ist einfach: `build` muss eine reine Funktion der Widget-Konfiguration und des Zustands sein. Es gibt einen Widget-Baum zurück und macht nichts anderes. Seiteneffekte, die den Zustand ändern, gehören in die Lebenszyklus-Methoden (`initState`, `didChangeDependencies`) oder die Event-Handler (`onPressed`, `onTap`), niemals in `build`.

## So finden Sie den problematischen Aufruf

Die Konsolenmeldung nennt zwei Widgets, aber die Zeile, die Sie ändern müssen, befindet sich meist in keinem von beiden. Sie befindet sich in dem, was synchron dazwischen ausgeführt wurde. Lesen Sie die Meldung von unten nach oben:

1. "The widget which was currently being built" nennt Ihnen den laufenden Build. Suchen Sie in Ihrem Code nach der `build`-Methode dieses Widgets oder nach dem `builder`-Callback, wenn es ein `Consumer`, `Builder`, `LayoutBuilder` oder `ValueListenableBuilder` ist.
2. Suchen Sie innerhalb dieses Build jeden Methodenaufruf, der keine reine Leseoperation ist. Ein Getter, der einen Zähler erhöht, eine Methode namens `load`, `refresh`, `fetch` oder `update`, alles, was einen `ChangeNotifier` berührt. Dieser Aufruf ist Ihr Verdächtiger.
3. Wenn im Build nichts unrein aussieht, ist der Auslöser ein Listener. Sehen Sie sich die Zeile "dispatching notifications for X" ganz oben an: `X` ist der Notifier, der ausgelöst hat. Finden Sie, wo `X.notifyListeners()` aufgerufen wird, und verfolgen Sie zurück, was ihn während dieses Frames aufgerufen hat.

In Debug-Builds zeigt der Stack Trace unter der Meldung direkt auf die Aufrufstelle von `notifyListeners` oder `setState`. In Release-Builds wird die Assertion herauskompiliert, sodass sich der Bug als verworfene Aktualisierung oder veralteter Frame statt als Absturz äußert. Genau deshalb sollten Sie die Ursache beheben und nicht das Symptom unterdrücken: Das Symptom existiert nur im Debug.

## Eine minimale Reproduktion

Dieses Widget wirft die Ausnahme bei seinem ersten Frame. Das Modell benachrichtigt seine Listener aus einer Methode, die ausgeführt wird, während ein `Consumer` kompiliert.

```dart
// Flutter 3.44, Dart 3.x -- throws "setState() or markNeedsBuild() called during build".
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class ProductModel extends ChangeNotifier {
  int _count = 0;
  int get count => _count;

  // Looks like a harmless getter-with-side-effect. It is not.
  int countAndTrack() {
    _count++;
    notifyListeners(); // fires synchronously, during build
    return _count;
  }
}

class CounterText extends StatelessWidget {
  const CounterText({super.key});

  @override
  Widget build(BuildContext context) {
    return Consumer<ProductModel>(
      builder: (context, model, _) {
        // Calling a method that notifies, from inside build:
        return Text('Seen ${model.countAndTrack()} times');
      },
    );
  }
}
```

Der `Consumer` kompiliert. Sein `builder` ruft `countAndTrack()` auf, das `notifyListeners()` aufruft, das den `Consumer` zur Neukompilierung auffordert, während er noch kompiliert. Flutter wirft die Ausnahme.

Dieselbe Form tritt ohne Provider auf. Jeder `addListener`-Callback, der `setState` während des Build eines Elternteils synchron aufruft, löst sie aus.

## Lösung im Detail

Die Lösungen sind danach geordnet, wie sehr ich sie empfehle. Die erste ist fast immer die eigentliche Antwort.

### 1. Verlagern Sie die Zustandsänderung aus build heraus (empfohlen)

Mutieren Sie nicht während des Build. Berechnen Sie abgeleitete Werte in `build`, aber führen Sie die tatsächliche Zustandsänderung in einer Lebenszyklus-Methode oder einem Event-Handler durch. In der Reproduktion gehört die Mutation in `initState`, nicht in den `builder`:

```dart
// Flutter 3.44, Dart 3.x -- correct: mutate once, off the build path.
class CounterText extends StatefulWidget {
  const CounterText({super.key});

  @override
  State<CounterText> createState() => _CounterTextState();
}

class _CounterTextState extends State<CounterText> {
  @override
  void initState() {
    super.initState();
    // Mutate here, before the first build, not during it.
    context.read<ProductModel>().countAndTrack();
  }

  @override
  Widget build(BuildContext context) {
    // build only reads; it does not write.
    final count = context.watch<ProductModel>().count;
    return Text('Seen $count times');
  }
}
```

`context.read<T>()` holt das Modell, ohne sich zu abonnieren, ist also in `initState` sicher. `context.watch<T>()` abonniert und ist in `build` sicher, weil es nur liest. Der Schreibvorgang erfolgt einmal, vor dem Frame, und die Leseoperation steuert danach die Neukompilierungen.

### 2. Verschieben Sie die Mutation mit addPostFrameCallback

Verwenden Sie dies, wenn der Auslöser wirklich außerhalb Ihrer Kontrolle liegt: ein Drittanbieter-Callback, ein Stream-Ereignis, das mitten im Build eintrifft, oder ein `LayoutBuilder`, der auf eine gemessene Größe im selben Frame reagieren muss. `WidgetsBinding.instance.addPostFrameCallback` führt Ihren Closure aus, nachdem der aktuelle Frame vollständig kompiliert und gezeichnet ist, sodass `setState` wieder zulässig ist.

```dart
// Flutter 3.44, Dart 3.x -- defer the rebuild to after this frame.
@override
Widget build(BuildContext context) {
  if (_needsRefresh) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return; // the widget may have been disposed
      setState(() => _needsRefresh = false);
    });
  }
  return Text(_label);
}
```

Zwei Schutzmaßnahmen machen dies sicher. Die `mounted`-Prüfung verhindert einen `setState after dispose`-Absturz, falls das Widget den Baum verlassen hat, bevor der Callback lief. Und der Callback muss bedingt sein (hier durch `_needsRefresh` gesteuert), sonst planen Sie bei jedem Frame eine neue Neukompilierung und verbrennen die CPU in einer Endlosschleife. `addPostFrameCallback` ist eine Verschiebung, keine Lizenz, bei jedem Zeichnen neu zu kompilieren.

### 3. Teilen Sie ein synchrones notify in einen Microtask auf

Wenn Ihnen der Notifier gehört und eine Methode legitim benachrichtigen muss, Sie aber nicht garantieren können, dass sie niemals während des Build aufgerufen wird, schieben Sie die Benachrichtigung aus dem synchronen Pfad heraus:

```dart
// Flutter 3.44, Dart 3.x -- notify after the current synchronous work unwinds.
int countAndTrack() {
  _count++;
  // scheduleMicrotask runs after the current build call stack returns,
  // but before the next frame -- so the UI updates without a frame of lag.
  scheduleMicrotask(notifyListeners);
  return _count;
}
```

Dies ist ein letztes Mittel. Es verbirgt den Design-Geruch (ein Getter mit Seiteneffekt), anstatt ihn zu entfernen, und Microtasks können immer noch mit der Freigabe konkurrieren. Bevorzugen Sie Lösung 1.

## Fallstricke und Varianten

`setState() called after dispose()`. Andere Assertion, verwandte Ursache. Sie haben `setState` aus einem asynchronen Callback (einem `Future.then`, einem `Timer`, einem Stream-Listener) aufgerufen, der abgeschlossen wurde, nachdem das Widget aus dem Baum entfernt wurde. Schützen Sie jedes asynchrone `setState` mit `if (!mounted) return;`. Die Freigabemuster finden Sie im [Leitfaden zur Freigabe von Controllern](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/).

`setState` in `initState`. `setState` synchron in `initState` aufzurufen ist kein Fehler, aber sinnlos: Der erste Build hat noch nicht stattgefunden, der Zustand wird also ohnehin gelesen. Weisen Sie das Feld einfach direkt zu. Flutter wirft hier keine Ausnahme, anders als im Fall der Build-Phase.

`Navigator.push` aus `build`. Eine häufige Variante dieses Fehlers. Wenn Sie als Seiteneffekt des Zustands navigieren möchten (etwa eine Umleitung, wenn sich ein Benutzer abmeldet), tun Sie das in `addPostFrameCallback` oder, besser, mit einem Routing-Paket, das Umleitungen deklarativ statt imperativ aus `build` modelliert.

`FutureBuilder` / `StreamBuilder`, das ewig neu kompiliert. Wenn das `future` oder der `stream` innerhalb von `build` erzeugt wird, erzeugt jede Neukompilierung ein neues, das abgeschlossen wird, das intern `setState` aufruft, das neu kompiliert. Erzeugen Sie das future oder den stream einmal in `initState` und speichern Sie es in einem Feld. Dies ist nicht streng dieselbe Ausnahme, aber es führt Sie in dasselbe Gebiet von "Ich kompiliere während einer Neukompilierung neu" und ist eine häufige Ursache von [Jank in Flutter, den Sie in DevTools erkennen können](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).

Riverpod-Nutzer. Einen Provider mit `ref.watch` innerhalb eines Callbacks zu lesen, der während des Build ausgeführt wird, und dann im selben synchronen Durchlauf in ihn zu schreiben, stößt gegen dieselbe Wand. Riverpods `AsyncValue` plus ein `Notifier` halten Lesen und Schreiben auf getrennten Pfaden; siehe [Lade- und Fehlerzustände mit AsyncValue](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/) für das Muster.

Der tiefere Punkt: `build` wird oft aufgerufen, unvorhersehbar und möglicherweise viele Male pro Frame. Alles, was Sie dort hineinlegen, läuft nach Flutters Zeitplan, nicht nach Ihrem. Leseoperationen sind in Ordnung, weil sie idempotent sind. Schreiboperationen nicht, weil sie ändern, was die nächste Leseoperation zurückgibt, und Flutter hat keinen sicheren Ort, um diese Änderung mitten im Build aufzufangen. Halten Sie `build` rein, und der Fehler verschwindet für immer. Dieselbe Disziplin macht nicht verwandte Bugs wie [den RenderFlex-Überlauf](/de/2026/05/fix-renderflex-overflowed-in-flutter/) leichter nachvollziehbar, weil Ihr Layout eine saubere Funktion des Zustands statt eines beweglichen Ziels ist. Wenn Ihr Widget wirklich auf asynchrone Daten reagieren muss, modellieren Sie diese Daten als Zustand und lassen Sie [die elegante Fehler- und Ladebehandlung](/de/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) die Neukompilierungen für Sie steuern.

## Quellen

- [State.setState API docs](https://api.flutter.dev/flutter/widgets/State/setState.html) -- der Vertrag, wann setState zulässig ist.
- [State.build API docs](https://api.flutter.dev/flutter/widgets/State/build.html) -- "build should be a pure function of the widget's configuration and the State."
- [WidgetsBinding.addPostFrameCallback API docs](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/addPostFrameCallback.html) -- Arbeit nach dem aktuellen Frame planen.
- [ChangeNotifier.notifyListeners API docs](https://api.flutter.dev/flutter/foundation/ChangeNotifier/notifyListeners.html) -- wann Listener synchron aufgerufen werden.
