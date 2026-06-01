---
title: "Controller in Flutter freigeben, um Speicherlecks zu vermeiden"
description: "AnimationController, TextEditingController und ScrollController halten Ressourcen, die der GC von Dart nicht freigeben kann, bevor Sie sie disposen. Hier sind das richtige Muster, die Reihenfolgeregeln und wie Sie Lecks vor der Veröffentlichung erkennen."
pubDate: 2026-06-01
template: how-to
tags:
  - "flutter"
  - "dart"
  - "memory"
lang: "de"
translationOf: "2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks"
translatedBy: "claude"
translationDate: 2026-06-01
---

Wenn ein Controller eine `dispose()`-Methode bereitstellt, müssen Sie sie aus Ihrem `State.dispose()` aufrufen, und zwar vor `super.dispose()`. Konkret: Erstellen Sie den Controller in `initState` (oder als `late final`-Feld), rufen Sie `controller.dispose()` in `dispose()` auf, und für `AnimationController` fügen Sie ein `SingleTickerProviderStateMixin` hinzu, damit der Ticker stoppt, sobald das Widget den Baum verlässt. Wird einer dieser Schritte ausgelassen, bleibt ein `Ticker`, eine Listener-Liste oder eine Stream-Subscription am Leben und erreichbar, was den gesamten Widget-Teilbaum im Speicher festhält. Dieser Leitfaden verwendet Flutter 3.44 (stable, Mai 2026) und Dart 3.x.

Die Garbage Collection rettet Sie hier nicht. Der GC von Dart gibt Objekte frei, die nicht mehr erreichbar sind, aber ein laufender `AnimationController` ist über die Ticker-Liste des `SchedulerBinding` erreichbar, und ein `TextEditingController`, den Sie an ein `TextField` übergeben haben, ist über den Listener-Graphen erreichbar, solange irgendetwas den Controller hält. Das Leck ist kein GC-Fehler. Es ist ein Eigentumsfehler: Sie haben eine Ressource erstellt und nie freigegeben.

## Warum ein Controller sein Widget überlebt

Ein `StatefulWidget` ist billig und wegwerfbar. Flutter baut das Widget-Objekt ständig neu auf. Das `State`-Objekt ist das, was einen Lebenszyklus hat, und die Controller, die Sie erstellen, gehören zu diesem `State`. Wenn das Widget aus dem Baum entfernt wird, ruft Flutter `State.dispose()` genau einmal auf. Dieser Aufruf ist Ihre einzige Gelegenheit, native und Framework-Ressourcen freizugeben.

Drei Kategorien von Controllern lecken auf unterschiedliche Weise:

`AnimationController` registriert einen `Ticker` beim `SchedulerBinding`. Der Ticker feuert in jedem Frame eine Callback, solange die Animation läuft. Bis Sie den Controller disposen (was den Ticker disposed), hält das `SchedulerBinding` eine Referenz auf den Ticker, der Ticker hält eine Referenz auf Ihre Callback, und Ihre Callback schließt `this`, Ihren `State` und darüber den gesamten Teilbaum ein. In Debug-Builds löst Flutter dazu tatsächlich eine Assertion aus: Wenn Sie das `dispose` vergessen, erhalten Sie `AnimationController.dispose() called more than once` oder eine Assertion über einen noch aktiven Ticker beim Abbau des Widgets.

`TextEditingController`, `ScrollController` und `FocusNode` sind `ChangeNotifier` (oder halten einen). Sie führen eine Liste von Listenern. Ein `TextField` fügt sich selbst als Listener hinzu, um neu zeichnen zu können, wenn sich der Text ändert. Wenn Sie zusätzlich `controller.addListener(...)` aufrufen und nie disposen, bleiben der Controller, seine Listener-Liste und jede Closure in dieser Liste am Leben. Der Controller hält die Listener, nicht umgekehrt, sodass der GC keinen von ihnen einsammeln kann.

`StreamSubscription` und `Timer` haben dieselbe Form ohne den Namen `dispose()`: Sie rufen `subscription.cancel()` und `timer.cancel()` auf. Eine lebende Subscription wird vom Stream referenziert, der Ihre `onData`-Callback am Leben hält.

Die vereinheitlichende Regel, direkt aus der [State.dispose-API-Dokumentation](https://api.flutter.dev/flutter/widgets/State/dispose.html) des Flutter-Teams: "Wenn die build-Methode eines State von einem Objekt abhängt, das selbst seinen Zustand ändern kann, ... abonnieren Sie dieses Objekt während initState ... und kündigen Sie das Abonnement in dispose."

## Ein minimaler Repro, der leckt

Hier ist ein Widget, das alle drei Ressourcentypen leckt. Es kompiliert und läuft. Es lässt nur nie los.

```dart
// Flutter 3.44, Dart 3.x -- DO NOT COPY, this leaks on purpose.
import 'dart:async';
import 'package:flutter/material.dart';

class LeakyScreen extends StatefulWidget {
  const LeakyScreen({super.key});

  @override
  State<LeakyScreen> createState() => _LeakyScreenState();
}

class _LeakyScreenState extends State<LeakyScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim =
      AnimationController(vsync: this, duration: const Duration(seconds: 1))
        ..repeat();
  final TextEditingController _text = TextEditingController();
  final ScrollController _scroll = ScrollController();
  late final StreamSubscription<int> _ticks =
      Stream.periodic(const Duration(seconds: 1), (i) => i).listen((_) {});

  // No dispose() override. Every push/pop of this screen leaks
  // one AnimationController, one ticker, one TextEditingController,
  // one ScrollController, and one live StreamSubscription.

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        controller: _scroll,
        children: [
          TextField(controller: _text),
          RotationTransition(turns: _anim, child: const FlutterLogo()),
        ],
      ),
    );
  }
}
```

Pushen und poppen Sie diesen Screen 50 Mal, und Sie haben 50 Ticker, die in jedem Frame feuern, 50 Stream-Subscriptions, die Events liefern, und 50 abgelöste Widget-Teilbäume, die der GC nie anrührt. Allein die Animations-Ticker verschlechtern sichtbar die Frame-Zeiten, weil jeder von ihnen weiterhin in jedem vsync laufen will.

## Das Freigabe-Muster, vollständig

Die Korrektur ist mechanisch, sobald Sie sie verinnerlicht haben. Spiegeln Sie jede Ressource, die Sie erstellen, mit einem Freigabe-Aufruf in `dispose()`, und stellen Sie `super.dispose()` ans Ende.

```dart
// Flutter 3.44, Dart 3.x
import 'dart:async';
import 'package:flutter/material.dart';

class StableScreen extends StatefulWidget {
  const StableScreen({super.key});

  @override
  State<StableScreen> createState() => _StableScreenState();
}

class _StableScreenState extends State<StableScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim;
  late final TextEditingController _text;
  late final ScrollController _scroll;
  late final FocusNode _focus;
  StreamSubscription<int>? _ticks;

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    )..repeat();
    _text = TextEditingController();
    _scroll = ScrollController()..addListener(_onScroll);
    _focus = FocusNode();
    _ticks = Stream.periodic(const Duration(seconds: 1), (i) => i)
        .listen(_onTick);
  }

  void _onScroll() {/* react to scroll offset */}
  void _onTick(int value) {/* react to each tick */}

  @override
  void dispose() {
    // Cancel subscriptions and remove listeners first.
    _ticks?.cancel();
    _scroll.removeListener(_onScroll);
    // Then dispose every controller you own.
    _anim.dispose();
    _text.dispose();
    _scroll.dispose();
    _focus.dispose();
    // super.dispose() LAST, always.
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        controller: _scroll,
        children: [
          TextField(controller: _text, focusNode: _focus),
          RotationTransition(turns: _anim, child: const FlutterLogo()),
        ],
      ),
    );
  }
}
```

Einige Dinge in diesem Code sind tragend, daher lohnt es sich, jedes davon explizit zu machen.

### In initState erstellen, nicht in build

`build` läuft viele Male. Wenn Sie `final _text = TextEditingController()` als Feldinitialisierer mit einem Wert ohne `late` schreiben, ist das in Ordnung, weil Feldinitialisierer einmal laufen. Aber sobald Sie einen Controller innerhalb von `build` konstruieren, allozieren Sie bei jedem Neuaufbau einen frischen und verwaisen den vorherigen sofort. Konstruieren Sie Controller in `initState` oder als `late final`-Felder, nie in `build`.

### Warum super.dispose() ans Ende gehört

Die Konvention ist die Umkehrung von `initState`. In `initState` rufen Sie zuerst `super.initState()` auf, dann richten Sie Ihren Zustand ein. In `dispose` bauen Sie zuerst Ihren Zustand ab, dann rufen Sie `super.dispose()` zuletzt auf. Das `State.dispose()` der Basisklasse markiert das Objekt als ausgemustert; danach auf eigene Felder zuzugreifen ist ein Fehler, und der Debug-Build des Frameworks meldet ein `dispose`, das auf einem bereits freigegebenen `State` aufgerufen wurde. Ihre Ressourcen abzubauen, bevor Sie die Kontrolle an die Basisklasse zurückgeben, hält die Reihenfolge konsistent.

### removeListener vor dispose, oder einfach dispose

Wenn Sie `addListener` auf einem Controller aufgerufen haben, können Sie entweder `removeListener` mit derselben Callback vor `dispose` aufrufen oder sich darauf verlassen, dass `dispose()` die gesamte Listener-Liste verwirft. Das Disposen eines `ChangeNotifier` leert seine Listener, sodass ein explizites `removeListener` unmittelbar vor `dispose` desselben Objekts redundant ist. Der Grund, das explizite `removeListener` beizubehalten, liegt vor, wenn Sie sich als Listener bei einem Controller hinzugefügt haben, der Ihnen nicht gehört (einer, der von einem Elternteil übergeben wurde). Sie müssen Ihren Listener von diesem Controller in `dispose` entfernen, weil nicht Sie es sind, der ihn freigibt.

## AnimationController braucht einen TickerProvider

`AnimationController` ist der einzige Controller, der mehr als einen `dispose`-Aufruf braucht: Er braucht ein `vsync`-Argument, das ein `TickerProvider` ist. Der `TickerProvider` ist das, was den Ticker des Controllers an die Bildwiederholrate des Bildschirms und, entscheidend, an den Widget-Lebenszyklus bindet.

Verwenden Sie `SingleTickerProviderStateMixin`, wenn der `State` genau einen `AnimationController` besitzt. Verwenden Sie `TickerProviderStateMixin`, wenn er mehrere besitzt. Das Single-Ticker-Mixin ist eine kleine Optimierung und löst eine Assertion aus, wenn Sie versehentlich zwei Controller dagegen erstellen, was eine nützliche Absicherung ist.

```dart
// Flutter 3.44 -- one controller
class _OneAnim extends State<OneAnim>
    with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: ...);
  @override
  void dispose() { _c.dispose(); super.dispose(); }
}

// Flutter 3.44 -- multiple controllers
class _ManyAnim extends State<ManyAnim>
    with TickerProviderStateMixin {
  late final _a = AnimationController(vsync: this, duration: ...);
  late final _b = AnimationController(vsync: this, duration: ...);
  @override
  void dispose() { _a.dispose(); _b.dispose(); super.dispose(); }
}
```

Wenn Ihre Animation einfach ist, besteht der sauberste Weg, nie einen Controller zu lecken, darin, keinen zu besitzen. Implizite Animations-Widgets wie `AnimatedContainer`, `AnimatedOpacity` und `TweenAnimationBuilder` verwalten ihre eigenen Controller intern und disposen sie für Sie. Greifen Sie nur dann zu einem expliziten `AnimationController`, wenn Sie die Animation selbst antreiben, umkehren, wiederholen oder verketten müssen. Animations-Jank zu profilen ist eine eigene Fähigkeit: Wenn Ihre Animationen flüssig sind, die App aber trotzdem ruckelt, liegt die Ursache meist in Arbeit auf dem UI-Thread, was ich in [dem Leitfaden zum Profilen von Jank in einer Flutter-App mit DevTools](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) behandle.

## Wer den Controller besitzt, entscheidet, wer ihn freigibt

Das häufigste reale Leck (und der häufigste Doppel-Dispose-Absturz) kommt von unklarem Eigentum. Die Regel: Wer den Controller erstellt, gibt ihn frei. Wird ein Controller in Widget A erstellt und an Widget B übergeben, dann gibt A ihn frei, und B darf es nicht.

Das ist wichtig, weil Flutter-Widgets häufig einen Controller als Konstruktor-Parameter akzeptieren, genau damit ein Elternteil sie steuern kann. `TextField`, `ListView`, `PageView` und `TabBar` nehmen alle einen optionalen Controller. Wenn Sie einen übergeben, behalten Sie die Verantwortung, ihn freizugeben:

```dart
// Flutter 3.44, Dart 3.x
class FormSection extends StatefulWidget {
  // This widget OWNS the controller, so it disposes it.
  const FormSection({super.key});
  @override
  State<FormSection> createState() => _FormSectionState();
}

class _FormSectionState extends State<FormSection> {
  final _name = TextEditingController();

  @override
  void dispose() {
    _name.dispose(); // owner disposes
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // The child widget receives the controller but must NOT dispose it.
    return NameField(controller: _name);
  }
}

class NameField extends StatelessWidget {
  final TextEditingController controller;
  const NameField({super.key, required this.controller});

  @override
  Widget build(BuildContext context) =>
      TextField(controller: controller); // no dispose here
}
```

Würde `NameField` einen Controller freigeben, den es nicht erstellt hat, würde der Elternteil später versuchen, einen freigegebenen Controller zu verwenden, und mit `A TextEditingController was used after being disposed` abstürzen. Dieser genaue Fehler hat seine eigene Diagnose, aber die Grundursache sind fast immer zwei Widgets, die um den Lebenszyklus eines Controllers streiten.

Der umgekehrte Fehler hebt einen Controller in eine State-Management-Schicht (einen `ChangeNotifier`, einen Riverpod-`Notifier`, einen GetX-Controller) und vergisst dann, dass nun die Schicht die Freigabe besitzt. Wenn Sie einen `TextEditingController` aus einem `State` heraus in einen Riverpod-Provider verschieben, ist das `onDispose`/`dispose` des Providers der Ort, an dem der `controller.dispose()`-Aufruf jetzt lebt, nicht das Widget. Wenn Sie das Eigentum am Lebenszyklus während einer State-Management-Migration umstrukturieren, ist das genau die Art von Sache, die stillschweigend bricht, was mit ein Grund ist, warum ich [die Migration einer Flutter-App von GetX zu Riverpod](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) als sorgfältigen, schrittweisen Umzug statt als Suchen-und-Ersetzen geschrieben habe.

## Randfälle, die beißen

**Bedingte Erstellung.** Wird ein Controller nur auf einigen Codepfaden erstellt, machen Sie das Feld nullbar und sichern Sie die Freigabe ab: `_optional?.dispose();`. Lassen Sie einen `late final`-Controller nicht uninitialisiert und rufen dann `dispose` darauf auf, was `LateInitializationError` auslöst.

**Einen Controller bei Widget-Aktualisierung neu erstellen.** Hängt Ihr Controller von einer `widget`-Eigenschaft ab, müssen Sie eventuell den alten in `didUpdateWidget` freigeben und einen neuen erstellen. Das Muster ist: In `didUpdateWidget` vergleichen Sie `oldWidget.x` mit `widget.x`, und wenn sie sich unterscheiden, `_controller.dispose()`, dann weisen Sie einen frischen zu. Die Freigabe in `didUpdateWidget` zu vergessen, leckt einen Controller pro relevanter Eigenschaftsänderung.

**GlobalKey und Controller sind verschiedene Dinge.** Ein `GlobalKey` braucht keine Freigabe, aber ein über einen Key erreichter Controller schon. Verwechseln Sie die beiden nicht.

**Hot Reload verbirgt Lecks.** Hot Reload bewahrt den `State`, sodass ein vergessenes `dispose` während der Entwicklung möglicherweise nicht auftaucht. Sie bemerken es erst, wenn der Screen tatsächlich gepusht und gepoppt wird, oder unter dem Leak-Tracker. Testen Sie den echten Navigationspfad, nicht nur Hot Reload.

**Schwere Arbeit in einer Controller-Callback gehört aus dem UI-Thread heraus.** Wenn Ihr `ScrollController`- oder `AnimationController`-Listener nennenswerte Berechnung anstellt, läuft diese Arbeit im UI-Isolate und konkurriert mit dem Rendern. Verschieben Sie sie in ein Hintergrund-Isolate; ich gehe das in [Schreiben eines Dart-Isolate für CPU-gebundene Arbeit](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) durch.

## Lecks vor der Veröffentlichung erkennen

Sie müssen sie nicht durch Lesen von Code finden. Flutter liefert `leak_tracker`, und seit Flutter 3.x integriert sich das Test-Framework damit, sodass Freigabe-Lecks Ihre Widget-Tests automatisch fehlschlagen lassen, wenn das Leck-Tracking aktiviert ist. Das Flutter-Team dokumentiert den Ablauf im [offiziellen Leak-Tracking-Leitfaden](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/OVERVIEW.md). Das mentale Modell: Von jedem disposbaren Objekt wird erwartet, dass es disposed wird; sammelt der GC eines ein, das nie disposed wurde, ist das ein "nicht disposed"-Leck, und wird eines disposed, aber nie eingesammelt, ist das ein "nicht vom GC eingesammelt"-Leck. Beide werden mit dem Allokations-Stack-Trace gemeldet, sodass Sie direkt auf das `initState` gezeigt werden, das den Waisen erstellt hat.

Für eine laufende App öffnen Sie DevTools und verwenden die Memory-Ansicht. Pushen und poppen Sie den verdächtigen Screen mehrmals, erzwingen Sie einen GC und beobachten Sie die Instanzanzahl von `AnimationController`, `TextEditingController` oder Ihrer `State`-Klasse. Steigt die Anzahl und fällt nie, haben Sie ein Leck, und die Retaining-Path-Ansicht zeigt Ihnen, was noch auf das Objekt zeigt. Dieselbe DevTools-Sitzung ist der Ort, an dem Sie das Frame-Timing untersuchen würden, was sich mit dem Jank-Profiling-Ablauf überschneidet.

Die Disziplin ist einfach genug, um sie in einer Zeile zu formulieren, und es lohnt sich, sie zu einem Code-Review-Reflex zu machen: Für jeden `Controller`, `FocusNode`, jede `StreamSubscription` und jeden `Timer`, den Sie in einem `State` erstellen, gibt es genau einen passenden Freigabe-Aufruf in `dispose()`, und `super.dispose()` ist die letzte Anweisung der Methode. Verdrahten Sie `leak_tracker` in Ihre Widget-Tests, und das Framework hält Sie daran.

## Verwandt

- [Jank in einer Flutter-App mit DevTools profilen](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) behandelt die Memory- und Performance-Ansichten, mit denen Sie ein Leck bestätigen.
- [Ein Dart-Isolate für CPU-gebundene Arbeit schreiben](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) ist der Ort, an dem Controller-Callbacks mit echter Arbeit laufen sollten.
- [Eine Flutter-App von GetX zu Riverpod migrieren](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) zeigt, wie sich das Eigentum an der Freigabe verschiebt, wenn Sie die State-Management-Schicht wechseln.
- [Lösung: RenderFlex overflowed in Flutter](/de/2026/05/fix-renderflex-overflowed-in-flutter/) ist der andere klassische Flutter-Fehler, auf den Sie beim Bauen derselben Screens stoßen.

## Quellen

- [State.dispose, Flutter-API-Referenz](https://api.flutter.dev/flutter/widgets/State/dispose.html)
- [AnimationController, Flutter-API-Referenz](https://api.flutter.dev/flutter/animation/AnimationController-class.html)
- [TextEditingController, Flutter-API-Referenz](https://api.flutter.dev/flutter/widgets/TextEditingController-class.html)
- [leak_tracker-Überblick, dart-lang/leak_tracker](https://github.com/dart-lang/leak_tracker/blob/main/doc/leak_tracking/OVERVIEW.md)
- [Die Memory-Ansicht verwenden, Flutter-DevTools-Dokumentation](https://docs.flutter.dev/tools/devtools/memory)
