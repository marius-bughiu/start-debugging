---
title: "Multi-Window-Unterstützung in einer Flutter-Desktop-App aktivieren"
description: "Flutter 3.44.8 stable liefert noch keine öffentliche Multi-Window-API. So aktivieren Sie das experimentelle Windowing-Feature-Flag im main-Kanal, nutzen RegularWindowController und WindowManager für echte Top-Level-Fenster, und das ist die Alternative, wenn Sie heute aus stable ausliefern müssen."
pubDate: 2026-08-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "desktop"
  - "multi-window"
  - "windowing"
  - "how-to"
lang: "de"
translationOf: "2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app"
translatedBy: "claude"
translationDate: 2026-08-04
---

Flutters Multi-Window-Unterstützung existiert, sie funktioniert, und aus einem stable Build können Sie sie nicht nutzen. Seit Flutter 3.44.8 (veröffentlicht am 2026-07-23) enthält das Framework eine vollständige Windowing-API in `packages/flutter/lib/src/widgets/_window.dart`, doch jede Klasse darin ist mit `@internal` markiert, die Datei wird nicht aus `package:flutter/widgets.dart` exportiert, und jeder Konstruktor wirft `UnsupportedError`, solange das Feature Flag `windowing` nicht gesetzt ist. Dieses Flag ist ausschließlich im `main`-Kanal verfügbar. Es gibt also genau zwei ehrliche Antworten: auf `main` wechseln, `flutter config --enable-windowing` ausführen und die echte Framework-API zum Prototyping nutzen, oder auf stable bleiben und das Plugin `desktop_multi_window` verwenden, das separate Fenster liefert, allerdings um den Preis separater Engines und separater Isolates. Dieser Beitrag behandelt beides, mit der exakten API-Oberfläche im Stand von 3.44.

## Warum `runApp` immer nur ein Fenster liefern kann

Der Grund, warum ein einzelnes Fenster so lange der Standard war, ist nicht Bequemlichkeit, sondern dass `runApp` Ihren Widget-Baum an die *implizite View* hängt: die eine `FlutterView`, die der Plattform-Embedder für Sie erzeugt hat, bevor Dart überhaupt gestartet ist. In diesem Aufruf gibt es keine Naht für eine zweite View, und die gab es nie.

Der Ausweg heißt seit einiger Zeit `runWidget`. Diese Funktion nimmt einen Widget-Baum entgegen, dessen Wurzel `View` oder `ViewCollection` ist, statt die implizite View vorauszusetzen. Was fehlte, war die andere Hälfte: eine Möglichkeit, die Plattform um die *Erzeugung* eines nativen Fensters zu bitten und dafür eine daran gebundene `FlutterView` zurückzubekommen. Genau das ergänzt die Windowing-API. Canonical führt die Implementierung an, und Flutter 3.44 brachte Tooltip-Fenster auf allen drei Desktop-Plattformen, Popup-Fenster auf macOS, Controller für Satellitenfenster sowie ein windowing-basiertes `showDialog`.

Die Design-Entscheidung mit der größten Wirkung auf Ihre Architektur: **alle Fenster teilen sich eine Engine und ein Isolate**. Zwei Fenster sind zwei Teilbäume desselben Widget-Baums. Ein `ValueNotifier`, den ein gemeinsamer Vorfahre hält, ist für beide sichtbar, ohne Serialisierung, ohne Method Channel, ohne `SendPort`. Das ist der größte Unterschied zu jedem plugin-basierten Ansatz, und deshalb ist Warten auf diese API oft die richtige Entscheidung.

## Das Windowing-Feature-Flag aktivieren

Das Flag ist in `flutter_tools` so definiert:

```dart
// packages/flutter_tools/lib/src/features.dart, Flutter 3.44.8
const windowingFeature = Feature(
  name: 'support for windowing on macOS, Linux, and Windows',
  configSetting: 'enable-windowing',
  environmentOverride: 'FLUTTER_WINDOWING',
  runtimeId: 'windowing',
  master: FeatureChannelSetting(available: true),
);
```

Achten Sie darauf, was fehlt: Es gibt keinen `beta:`- und keinen `stable:`-Eintrag, beide fallen also auf den Standardwert `FeatureChannelSetting()` mit `available: false` zurück. Auch Beta wird nicht funktionieren. Es ist `main` oder gar nichts.

Die Aktivierung erfolgt in drei Schritten:

1. **Wechseln Sie in den main-Kanal.** Führen Sie `flutter channel main` und anschließend `flutter upgrade` aus. Wenn Ihre bestehende stable Toolchain unangetastet bleiben soll, pinnen Sie ein zweites SDK mit FVM, statt Ihren einzigen Checkout zu verschieben; die Technik aus [ein Projekt gegen mehrere Flutter-SDKs in CI ausführen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) funktioniert lokal genauso.
2. **Schalten Sie das Flag ein.** Führen Sie `flutter config --enable-windowing` aus. Das schreibt eine dauerhafte Einstellung, Sie tun es also einmal pro SDK. Setzen Sie in CI stattdessen die Umgebungsvariable `FLUTTER_WINDOWING=true`, die das Werkzeug als Override liest.
3. **Neu kompilieren, kein Hot Restart.** Das Werkzeug reicht aktivierte Flags als Compile-Time-Define namens `FLUTTER_ENABLED_FEATURE_FLAGS` an das Framework weiter. Das Framework liest es in `packages/flutter/lib/src/foundation/_features.dart`:

```dart
// packages/flutter/lib/src/foundation/_features.dart, Flutter 3.44.8
final Set<String> debugEnabledFeatureFlags = <String>{
  ...const String.fromEnvironment('FLUTTER_ENABLED_FEATURE_FLAGS').split(','),
};

bool isWindowingEnabled = debugEnabledFeatureFlags.contains('windowing');
```

`String.fromEnvironment` wird zur Kompilierzeit als Konstante ausgewertet, ein Hot Restart nach dem Umlegen der Einstellung greift also nicht. Beenden Sie die App und starten Sie `flutter run -d windows` (oder `macos`, oder `linux`) erneut.

Wenn Sie Schritt 2 überspringen, erhalten Sie einen sehr konkreten Fehler, den man kennen sollte, denn er wird aus dem Konstruktor geworfen und nicht beim Rendern:

```
Windowing APIs are not enabled.

Windowing APIs are currently experimental. Do not use windowing APIs in
production applications or plugins published to pub.dev.

To try experimental windowing APIs:
1. Switch to Flutter's main release channel.
2. Turn on the windowing feature flag.
```

## Eine nicht exportierte API importieren

Da `_window.dart` eine private Bibliothek innerhalb von `package:flutter` ist, erreichen Sie sie nicht über `package:flutter/widgets.dart`. Sie importieren die Implementierungsdatei direkt und deaktivieren zwei Analyzer-Regeln. Genau das tut Flutters eigene App `examples/multiple_windows`:

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
// ignore_for_file: invalid_use_of_internal_member
// ignore_for_file: implementation_imports

import 'package:flutter/material.dart';
import 'package:flutter/src/widgets/_window.dart';
```

Ja, das ist hässlich, und ja, es ist der offiziell abgesegnete Weg, die Funktion derzeit auszuprobieren. Die Regel `implementation_imports` existiert, um genau das in einem veröffentlichten Paket zu verhindern, und das ist auch die Vorgabe im Dateikopf: nicht in Produktions-Apps importieren und in nichts, was Sie auf pub.dev veröffentlichen, denn Breaking Changes kommen auch in Patch-Versionen.

## Eine minimale App mit zwei Fenstern

Das kleinste vollständige Programm: Erzeugen Sie einen `RegularWindowController`, verpacken Sie ihn in ein `RegularWindow` und übergeben Sie das Ganze an `runWidget` statt an `runApp`.

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
// ignore_for_file: invalid_use_of_internal_member, implementation_imports
import 'package:flutter/material.dart';
import 'package:flutter/src/widgets/_window.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  final RegularWindowController controller = RegularWindowController(
    preferredSize: const Size(900, 640),
    preferredConstraints: const BoxConstraints(minWidth: 640, minHeight: 480),
    title: 'Main window',
  );

  runWidget(
    WindowManager(
      child: RegularWindow(
        controller: controller,
        child: const MaterialApp(home: HomePage()),
      ),
    ),
  );
}
```

Drei Dinge sind hier tragend.

`WidgetsFlutterBinding.ensureInitialized()` muss zuerst kommen. Die Factory von `RegularWindowController` löst sofort `WidgetsBinding.instance.windowingOwner` auf, und der plattformseitige `WindowingOwner` prüft per Assertion, dass die Engine bereits initialisiert ist. Einen Controller vor Existenz des Bindings zu konstruieren ist die Ursache der Assertion `WindowingOwner[Platform] must be created after the engine has been initialized`, die in flutter/flutter#178706 erfasst ist.

Der Controller erzeugt das native Fenster in seinem Konstruktor, nicht beim Mounten des Widgets. `RegularWindow` rendert nur in ein bereits existierendes Fenster, weshalb die Dokumentation ausdrücklich festhält, dass Sie die Lebensdauer besitzen und `destroy()` selbst aufrufen müssen.

`WindowManager` ist bei einem einzigen Fenster optional, Sie wollen ihn aber von Anfang an. Er installiert eine `WindowRegistry` im Baum, und darüber öffnen Nachfahren weitere Fenster, ohne dass Sie einen Controller manuell durchreichen.

## Ein zweites Fenster zur Laufzeit öffnen

Das Muster lautet: Controller bauen, in einen `WindowEntry` mit einem Builder für dessen Inhalt verpacken, registrieren. `WindowManager` lauscht auf die Registry und rendert jeden Eintrag mit dem passenden Widget für den jeweiligen Controller-Typ.

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    final WindowRegistry registry = WindowRegistry.of(context);

    return Scaffold(
      body: Center(
        child: FilledButton(
          onPressed: () {
            late final WindowEntry entry;
            final RegularWindowController controller = RegularWindowController(
              title: 'Inspector',
              preferredSize: const Size(480, 720),
              delegate: _UnregisterOnDestroy(
                onDestroyed: () => registry.unregister(entry),
              ),
            );
            entry = WindowEntry(
              controller: controller,
              builder: (BuildContext context) => const InspectorPane(),
            );
            registry.register(entry);
          },
          child: const Text('Open inspector'),
        ),
      ),
    );
  }
}

class _UnregisterOnDestroy with RegularWindowControllerDelegate {
  _UnregisterOnDestroy({required this.onDestroyed});

  final VoidCallback onDestroyed;

  @override
  void onWindowDestroyed() {
    super.onWindowDestroyed();
    onDestroyed();
  }
}
```

Der Tanz um `late final WindowEntry entry` ist kein Zufall: Das Delegate muss den Eintrag abmelden, und der Eintrag braucht den Controller, an dem das Delegate hängt. Flutters eigene Referenz-App nutzt dieselbe Vorwärtsreferenz.

Das Abmelden ist wichtig. `WindowRegistry.unregister` entfernt den Eintrag nur aus der Liste, damit `WindowManager` ihn nicht mehr rendert; das Fenster wird dadurch nicht zerstört. Umgekehrt reißt `destroy()` das native Fenster ab, lässt aber einen veralteten Eintrag in der Registry zurück. Das Delegate ist die Verbindungsstelle: Lassen Sie das voreingestellte `onWindowCloseRequested` das Fenster zerstören und räumen Sie die Registry anschließend in `onWindowDestroyed` auf.

## Das Schließen abfangen, und der Rest der Controller-Oberfläche

`RegularWindowControllerDelegate` hat genau zwei Hooks, und die Standardimplementierung des ersten ist das, was Ihre Fenster tatsächlich schließt:

```dart
// packages/flutter/lib/src/widgets/_window.dart, Flutter 3.44.8
void onWindowCloseRequested(RegularWindowController controller) {
  controller.destroy();
}

void onWindowDestroyed() { }
```

Überschreiben Sie `onWindowCloseRequested` und rufen Sie `super` *nicht* auf, wenn Sie eine Rückfrage wegen ungespeicherter Änderungen wollen; rufen Sie danach `controller.destroy()` selbst auf, sobald der Benutzer bestätigt. Zu vergessen, dass `super` das Fenster schließt, ist der wahrscheinlichste Weg, ein Fenster auszuliefern, das niemand schließen kann.

Der Controller stellt den erwartbaren Zustand bereit, und zwar durchgehend änderungsbenachrichtigend, weil `BaseWindowController` von `ChangeNotifier` erbt: `contentSize`, `title`, `isActivated`, `isMaximized`, `isMinimized`, `isFullscreen` und `rootView`. Die Mutatoren sind `setSize`, `setConstraints`, `setTitle`, `setMaximized`, `setMinimized`, `setFullscreen(bool fullscreen, {Display? display})`, `activate` und `destroy`. Jeder davon ist als *Anfrage* dokumentiert: Die Plattform darf sie ignorieren. Steuern Sie Ihre Oberfläche daher über den gemeldeten Zustand, niemals über das, was Sie angefordert haben.

Innerhalb des Teilbaums eines Fensters erreichen Sie den Controller über das Inherited Model `WindowScope`:

```dart
// Flutter 3.44.8 (main channel), Dart 3.12
final BaseWindowController window = WindowScope.of(context);

// Rebuilds only on size changes, not on title or activation changes.
final Size size = WindowScope.contentSizeOf(context);
```

`WindowScope` ist ein `InheritedModel`, das nach Aspekten schlüsselt (Inhaltsgröße, Titel, aktiviert, maximiert, minimiert, Vollbild), daher baut `contentSizeOf` Ihr Widget nicht neu auf, wenn das Fenster lediglich den Fokus erhält. Verwenden Sie `maybeOf`, wenn der Teilbaum auch im impliziten Fenster laufen kann: Fenster, die vom nativen Entrypoint erzeugt werden, an den sich `runApp` hängt, haben kein `WindowScope`, und `of` wirft dort eine Ausnahme.

## Die anderen vier Fenstertypen

Reguläre Fenster sind einer von fünf Controller-Typen, alle versiegelt unter `BaseWindowController` und alle vom `WindowManager` über ein Switch gerendert:

- `DialogWindowController({BaseWindowController? parent, ...})`. Mit einem `parent` ungleich null ist der Dialog dazu modal, hat kein Systemmenü, ist im Fensterwechsler verborgen und schließt sich, wenn das Elternfenster schließt. Mit `parent: null` ist er nicht modal, lässt sich minimieren, aber nicht maximieren, und bekommt einen **deaktivierten Schließen-Button**. Dieses letzte Detail überrascht viele; wenn Sie ein eigenständiges, schließbares Fenster wollen, brauchen Sie ein reguläres Fenster und keinen elternlosen Dialog.
- `PopupWindowController`, positioniert relativ zu einem Anker-Rechteck. In 3.44 für macOS implementiert; Windows und Linux folgen noch.
- `TooltipWindowController`, in 3.44 auf allen drei Desktop-Plattformen implementiert.
- `SatelliteWindowController`, der neueste im Bunde, für Paletten und Werkzeugleisten, die einem Elternfenster folgen.

Flutter 3.44 ergänzte außerdem ein windowing-basiertes `showDialog`, das ein echtes natives Fenster statt eines Overlays öffnet, hinter einem `useWindowing`-Flag an `MaterialApp`.

## Was tun, wenn Sie das auf stable brauchen

Wenn Sie jetzt ausliefern, scheidet die Framework-API aus: Implementation Imports plus `@internal` plus dokumentierte Breaking Changes in Patch-Versionen sind keine Grundlage für eine Produktions-App. Die praktische Antwort bleibt `desktop_multi_window` 0.3.0 (veröffentlicht am 2025-10-28) mit Unterstützung für Windows, Linux und macOS.

```dart
// desktop_multi_window 0.3.0, Flutter 3.44.8 stable
Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();

  final windowController = await WindowController.fromCurrentEngine();
  final arguments = parseArguments(windowController.arguments);

  switch (arguments.type) {
    case WindowType.main:
      runApp(const MainWindow());
    case WindowType.inspector:
      runApp(const InspectorWindow());
  }
}
```

Neue Fenster entstehen über `WindowController.create(WindowConfiguration(...))`, und die Kommunikation zwischen Fenstern läuft über `WindowMethodChannel`, also über einen Method Channel und damit asynchron und codec-gebunden:

```dart
// desktop_multi_window 0.3.0
const channel = WindowMethodChannel('inspector');
channel.setMethodCallHandler((call) async {
  return switch (call.method) {
    'refresh' => 'ok',
    _ => throw MissingPluginException('Not implemented: ${call.method}'),
  };
});
```

Der architektonische Preis ist das, was Sie einplanen müssen. Jedes Fenster ist eine eigene Flutter-Engine, also ein eigenes Isolate, ein eigener Heap und eine eigene Kopie jedes Singletons, das Sie in `main` initialisiert haben. Gemeinsamer Zustand muss über einen Channel serialisiert werden, genau wie bei der Kommunikation mit [plattformspezifischem Code über einen MethodChannel](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/). Wer schon einmal eine App um [ein langlebiges Dart-Isolate mit SendPort und ReceivePort](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) herum gebaut hat, kennt die Einschränkungen: keine gemeinsamen veränderlichen Objekte, alles über Nachrichten.

Planen Sie jetzt dafür, dann wird die spätere Migration billig. Halten Sie einen einzigen Eigentümer des Anwendungszustands, legen Sie ihn über ein Interface offen, und setzen Sie den Transport hinter dieses Interface (heute direkte Referenz unter der Framework-API, heute Method Channel unter dem Plugin). Es ist dasselbe Argument "Architektur zuerst, Politur danach", das [Flutter-Desktop-Apps immer wieder belegen](/de/2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later/).

## Fallstricke, die echte Zeit kosten

**Controller sind `ChangeNotifier`, und Sie sind für ihre Freigabe verantwortlich.** Ein `RegularWindowController` in einem `State` braucht `controller.dispose()` in `dispose()`, zusätzlich zu `destroy()` für das native Fenster. Dieselbe Disziplin, die Sie ohnehin auf [`AnimationController` und Verwandte](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) anwenden, gilt hier, mit einer zusätzlichen nativen Ressource daran.

**Widget-Tests haben kein Windowing.** Im Test-Binding existiert kein `WindowingOwner`, jeder Test, der einen Windowing-Konstruktor erreicht, wirft also `UnsupportedError`. Flutters eigenes API-Beispiel umschließt `main` genau deshalb mit einem `try`/`on UnsupportedError`-Block, damit die Smoke Tests durchlaufen. Halten Sie die Fenstererzeugung aus dem Widget-Code heraus und hinter einer Naht, die Sie stubben können.

**`preferredSize` und `preferredConstraints` müssen zusammenpassen.** Die Factory prüft per Assertion `preferredConstraints.isSatisfiedBy(preferredSize)`, wenn beide ungleich null sind. In Release-Builds fällt die Assertion weg, und die Plattform wählt still etwas anderes.

**`decorated: false` heißt, Sie zeichnen den Rahmen.** Undekorierte Fenster kamen in 3.44 (`Allow windows to be created undecorated`). Sie bekommen keine Titelleiste, keinen Rand und keine Ziehfläche, bis Sie sie selbst bauen.

Das Tracking-Issue für das gesamte Vorhaben ist flutter/flutter#30701, und die verbleibende Arbeit bis zur Veröffentlichung der API ist erfreulich überschaubar: flutter/flutter#177586, die Pre-Launch-Checkliste, reduziert sich darauf, TODOs aus Dokumentations-Snippets zu entfernen und die `invalid_use_of_internal_member`-Ignores aus den Beispielen zu streichen. Nichts davon ist architektonisch. Bauen Sie gegen die Form dieser API, halten Sie sie hinter einem Interface, und an dem Tag, an dem sie in stable erscheint, ist Ihre Migration ein Import-Wechsel.

## Verwandte Beiträge

- [Plattformspezifischen Code in Flutter ohne Plugins hinzufügen](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [Ein Dart-Isolate für CPU-gebundene Arbeit schreiben](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)
- [Controller in Flutter freigeben und Speicherlecks vermeiden](/de/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Mehrere Flutter-Versionen aus einer CI-Pipeline ansprechen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [TypeMonkey ist eine gute Erinnerung: Flutter-Desktop-Apps brauchen erst Architektur, dann Politur](/de/2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later/)

## Quellen

- [flutter/flutter#30701, das Tracking-Issue für Multi-Window](https://github.com/flutter/flutter/issues/30701)
- [flutter/flutter#177586, die Pre-Launch-Checkliste für Multi-Window](https://github.com/flutter/flutter/issues/177586)
- [`packages/flutter/lib/src/widgets/_window.dart` am Tag 3.44.0](https://github.com/flutter/flutter/blob/3.44.0/packages/flutter/lib/src/widgets/_window.dart)
- [`packages/flutter_tools/lib/src/features.dart`, wo `windowingFeature` deklariert wird](https://github.com/flutter/flutter/blob/3.44.0/packages/flutter_tools/lib/src/features.dart)
- [Flutters Referenz-App `examples/multiple_windows`](https://github.com/flutter/flutter/tree/3.44.0/examples/multiple_windows)
- [Release Notes zu Flutter 3.44.0](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0)
- [Canonical über multiple Fenster für Flutter Desktop](https://canonical.com/blog/multiple-window-flutter-desktop)
- [`desktop_multi_window` auf pub.dev](https://pub.dev/packages/desktop_multi_window)
