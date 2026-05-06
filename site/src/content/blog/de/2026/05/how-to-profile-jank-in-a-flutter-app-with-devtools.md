---
title: "Wie Sie Jank in einer Flutter-App mit DevTools profilen"
description: "Schritt-für-Schritt-Anleitung zum Aufspüren und Beheben von Jank in Flutter 3.27 mit DevTools: Profile Mode, das Performance Overlay, der Frame-Analysis-Tab, der CPU Profiler, Raster vs. UI-Thread, Shader-Aufwärmen und Impeller-spezifische Stolperfallen. Getestet mit Flutter 3.27.1, Dart 3.11, DevTools 2.40."
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "devtools"
  - "performance"
  - "jank"
  - "how-to"
lang: "de"
translationOf: "2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools"
translatedBy: "claude"
translationDate: 2026-05-06
---

Kurze Antwort: kompilieren Sie mit `flutter run --profile` (niemals Debug), öffnen Sie DevTools, wechseln Sie zum Performance-Tab, reproduzieren Sie den Jank und lesen Sie das Frame-Analysis-Diagramm. Frames über dem Budget (16,67 ms bei 60 Hz, 8,33 ms bei 120 Hz) sind eingefärbt. Ist der Balken über dem Budget rot auf dem UI-Thread, wechseln Sie zum CPU Profiler und untersuchen Ihren Dart-Code; ist er rot auf dem Raster-Thread, ist die GPU der Engpass und die Lösung lautet meist Shader-Aufwärmen, kleinere Bilder oder weniger teure Effekte. Diese Anleitung führt durch jede dieser Entscheidungen mit Flutter 3.27.1, Dart 3.11 und DevTools 2.40.

## Warum man Jank nicht im Debug-Modus profilen kann

Debug-Builds sind absichtlich langsam. Sie führen unoptimierten JIT-Code aus, transportieren jede Assertion und überspringen die AOT-Pipeline. Das Framework selbst druckt `"This is a debug build"` über die App, um Sie daran zu erinnern. Im Debug-Modus erfasste Zahlen sind in der Regel 2x bis 10x schlechter als im Release, sodass jeder Jank, den Sie dort "finden", in der Produktion vielleicht gar nicht existiert. Schlimmer noch: echter Jank kann übersehen werden, weil Debug auf einigen Android-Geräten standardmäßig mit niedrigerer Bildrate läuft.

Profilen Sie immer mit `flutter run --profile` gegen ein echtes Gerät. Der Simulator und der iOS Simulator bilden das tatsächliche GPU-Verhalten nicht ab, insbesondere nicht für die Shader-Kompilierung. Profile Mode behält die DevTools-Hooks bei (Timeline-Ereignisse, Allokationsverfolgung, Observatory), kompiliert Ihren Dart-Code jedoch mit der AOT-Pipeline, sodass die Zahlen innerhalb weniger Prozent vom Release liegen. Die [Flutter-Dokumentation zur App-Performance](https://docs.flutter.dev/perf/ui-performance) ist hier eindeutig.

```bash
# Flutter 3.27.1
flutter run --profile -d <your-device-id>
```

Hängt das Gerät per USB, lässt sich auch `--profile --trace-startup` verwenden, um eine Startup-Timeline-Datei in `build/start_up_info.json` zu erfassen, nützlich speziell zur Messung von Cold-Start-Jank.

## DevTools öffnen und den richtigen Tab wählen

Sobald `flutter run --profile` läuft, druckt die Konsole eine DevTools-URL wie `http://127.0.0.1:9100/?uri=...`. Öffnen Sie sie in Chrome. Die für Jank relevanten Tabs sind, in dieser Reihenfolge:

1. **Performance**: Frame-Timeline, Frame Analysis, Raster Cache, Enhance-Tracing-Schalter.
2. **CPU Profiler**: Sampling-Profiler mit Bottom-up-, Top-down- und Aufrufbaum-Ansichten.
3. **Memory**: Allokationsverfolgung und GC-Ereignisse. Nützlich, wenn Jank mit GC korreliert.
4. **Inspector**: Widget-Baum. Nützlich, um einen Rebuild-Sturm zu bestätigen.

Das "Performance Overlay", das Sie auch aus der laufenden App heraus aktivieren können (`P` im Terminal oder `WidgetsApp.showPerformanceOverlay = true` im Code), ist eine kleinere Fassung derselben Daten, über Ihre UI gezeichnet. Es eignet sich hervorragend, um Jank in Echtzeit auf einem Gerät zu erkennen, doch Sie können von dort nicht in einen einzelnen Frame hineindrillen. Verwenden Sie das Overlay, um ein Jank-Szenario zu finden, und erfassen Sie es dann in DevTools.

## Das Frame-Analysis-Diagramm lesen

In Performance zeigt das obere Diagramm einen Balken pro gerendertem Frame. Jeder Balken hat zwei horizontal gestapelte Segmente: das untere Segment ist der UI-Thread (Ihr Dart-`build`-, `layout`-, `paint`-Durchlauf), das obere Segment ist der Raster-Thread (wo die Engine den Layer-Baum auf der GPU rastert). Überschreitet eines der Segmente das Frame-Budget, wird der Balken rot.

Das Frame-Budget beträgt `1000 ms / refresh_rate`. Auf einem 60-Hz-Gerät sind das 16,67 ms insgesamt, aber nicht 16,67 ms pro Thread. Ein Frame ist nur dann pünktlich, wenn UI und Raster beide innerhalb ihres Budgets fertig werden, was in der Praxis ungefähr unter 8 ms je Thread bedeutet (der Rest ist Engine-Overhead und Vsync-Ausrichtung). Auf einem 120-Hz-Gerät halbieren Sie alles.

Klicken Sie auf einen roten Frame, schaltet das untere Panel auf "Frame Analysis". Das ist die mit Abstand nützlichste Ansicht in DevTools 2.40. Sie zeigt:

- Die Timeline-Ereignisse für genau diesen Frame.
- Ob der dominierende Aufwand `Build`, `Layout`, `Paint` oder `Raster` ist.
- Ob Shader-Kompilierung, Bilddekodierung oder Platform-Channel-Aufrufe beteiligt waren.
- Einen Texthinweis wie "This frame's UI work was dominated by a single Build phase", damit Sie nicht raten müssen.

Wenn der Hinweis sagt, der UI-Thread sei das Problem, liegt die Lösung in Ihrem Dart-Code. Zeigt er auf den Raster-Thread, liegt die Lösung in der Form Ihres Widget-Baums, in den Shadern, den Bildern oder den Effekten.

## Wenn der UI-Thread der Engpass ist

Jank im UI-Thread ist Ihr Code, der zu lange in einem Frame läuft. Die größten Ursachen:

- Eine `build`-Methode, die echte Arbeit verrichtet (JSON parsen, eine 10k-Liste durchlaufen, Regex über einen langen String).
- Ein `setState`, das einen viel größeren Teilbaum als nötig neu aufbaut.
- Ein synchrones `File.readAsStringSync` oder beliebige blockierende I/O.
- Eine schwere `Listenable`-Änderung, die sich auf viele Listener auffächert.

Wechseln Sie in den CPU-Profiler-Tab, während die Jank-Interaktion läuft. Stellen Sie "Profile granularity" für kurze Bursts auf "high" und starten Sie die Aufnahme. Stoppen Sie nach den Jank-Frames. Die Bottom-up-Ansicht ("Heaviest frames at the top") identifiziert den Übeltäter meist in Sekunden.

```dart
// Flutter 3.27.1, Dart 3.11
class ProductList extends StatelessWidget {
  const ProductList({super.key, required this.json});
  final String json;

  @override
  Widget build(BuildContext context) {
    // Bad: parses a 4 MB JSON blob on every rebuild on the UI thread.
    final products = (jsonDecode(json) as List)
        .map((e) => Product.fromJson(e as Map<String, dynamic>))
        .toList();

    return ListView.builder(
      itemCount: products.length,
      itemBuilder: (_, i) => ProductTile(product: products[i]),
    );
  }
}
```

Die Lösung ist, die Arbeit aus dem UI-Thread zu verlagern, entweder mit einem einmaligen `compute(...)`-Aufruf oder, für wiederkehrende CPU-gebundene Arbeit, mit einem langlebigen Isolate. Eine vollständige Erläuterung beider Wege finden Sie in [der dedizierten Anleitung zum Schreiben eines Dart-Isolates für CPU-gebundene Arbeit](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/).

Ein subtilerer UI-Thread-Aufwand ist Überrebuild. Wickeln Sie den Teil, der sich tatsächlich ändert, in ein kleines Widget ein, sodass nur dessen `build` bei `setState` läuft. Der Inspector-Schalter "Highlight Repaints" (unter Performance > More options) zeichnet einen farbigen Rand um jede Schicht, die neu zeichnet, und ist der schnellste Weg, einen `Container` nahe der Wurzel zu entdecken, der den ganzen Bildschirm neu aufbaut.

## Wenn der Raster-Thread der Engpass ist

Raster-Thread-Jank bedeutet, dass die Engine zu viel GPU-Arbeit für den Layer-Baum leistet, den Ihre Widgets erzeugen. Die Lösung lautet selten "nehmen Sie ein schnelleres Telefon". In der Regel ist es eine der folgenden:

1. **Jank durch Shader-Kompilierung**: erstmalige Effekte (Seitenübergänge, Gradienten, Blurs, Custom Painters) kompilieren Shader mitten im Frame, was die Raster-Zeit hochtreibt. Sichtbar als ein oder zwei extreme Frames beim ersten Öffnen eines Bildschirms.
2. **Off-Screen-Layer**: `Opacity`, `ShaderMask`, `BackdropFilter` und `ClipRRect` mit `antiAlias: true` können die Engine zwingen, einen Teilbaum in eine Textur zu rendern und zu komponieren. Für ein Element in Ordnung, für eine Liste teuer.
3. **Übergroße Bilder**: ein 4k-JPEG, das in ein `Image.asset` dekodiert wird, deckt den Telefonbildschirm mit weit mehr Pixeln, als zu sehen sind. Verwenden Sie `cacheWidth` / `cacheHeight`, um beim Dekodieren herunterzurechnen.
4. **`saveLayer`-Aufrufe**: ein verräterisches Muster in der Engine-Timeline. `saveLayer` ist das, was `Opacity` intern verwendet. Ersetzen Sie `Opacity(opacity: 0.5, child: ...)` durch ein `AnimatedOpacity` oder einen Child, der mit vorberechnetem Alpha zeichnet, und der Aufruf entfällt.

DevTools 2.40 macht das direkt sichtbar. Aktivieren Sie unter Performance > "Enhance Tracing" "Track widget builds", "Track layouts" und "Track paints" für mehr Detail in der Timeline. Frame Analysis zeigt zusätzlich ein "Raster cache"-Panel: zeigt es ein hohes Verhältnis "raster cache hits / misses", cached die Engine Layer nicht, die sie cachen könnte.

## Shader-Aufwärmen unter Impeller und Skia

Das ist die häufigste Frage zur Flutter-Performance: "wenn ich diesen Bildschirm zum ersten Mal öffne, ruckelt er". Ursache ist die Shader-Kompilierung. Die Lösung hängt vom Render-Backend ab.

Impeller ist der moderne Renderer der Engine. Ab Flutter 3.27 ist Impeller unter iOS standardmäßig aktiv und unter Android der Standard (mit Skia als Rückfallpfad für ältere Geräte). Impeller kompiliert alle Shader im Voraus, sodass auf reinen Impeller-Geräten Shader-Kompilierungs-Jank nicht existieren sollte. Sehen Sie unter Impeller dennoch Jank im ersten Frame, ist es Bilddekodierung oder Layer-Aufbau, nicht Shader.

Auf dem Skia-Pfad (älteres Android, Web, Desktop) findet die Shader-Kompilierung weiterhin zur Laufzeit statt. Der traditionelle Workflow `flutter build --bundle-sksl-path` nutzte SkSL-Caching, doch ab Flutter 3.7 hat die Engine diesen Pfad als veraltet markiert, weil Impeller ihn überflüssig machte. Müssen Sie heute auf ein Skia-Gerät ausliefern, lautet der empfohlene Weg:

- Rendern Sie jede Seite mit ungewöhnlichen Effekten einmal während des Splashscreens.
- Wärmen Sie Gradienten, Blurs und animierte Übergänge vor, indem Sie sie beim App-Start außerhalb des Bildschirms montieren.
- Testen Sie auf einem Low-End-Android-Gerät, nicht auf einem Flaggschiff.

Welcher Renderer aktiv ist, bestätigt sich in den Logs der laufenden App (`flutter run` druckt `Using the Impeller rendering backend`) oder im DevTools-Tab "Diagnostics".

## Ein wiederholbarer Workflow, der wirklich funktioniert

Das ist die Schleife, die ich verwende, in dieser Reihenfolge:

1. `flutter run --profile -d <real-device>`. Verwerfen Sie jede Jank-Messung vom Simulator.
2. Reproduzieren Sie den Jank. Schalten Sie das In-App-Performance-Overlay (`P` im Terminal) ein, um UI- vs. Raster-Balken in Echtzeit zu sehen. Bestätigen Sie, dass der Jank echt und reproduzierbar ist.
3. Öffnen Sie DevTools > Performance. Drücken Sie vor dem Jank "Record", reproduzieren ihn, drücken "Stop".
4. Klicken Sie auf den schlimmsten roten Frame. Lesen Sie Frame Analysis. Entscheiden Sie UI vs. Raster.
5. Wenn UI: öffnen Sie den CPU-Profiler-Tab, nehmen das gleiche Szenario auf, drillen Bottom-up in die schwerste Funktion. Verlagern Sie Arbeit aus dem UI-Thread oder verkleinern die Rebuild-Fläche.
6. Wenn Raster: aktivieren Sie "Track paints" und "Highlight Repaints", suchen Sie nach `saveLayer`, übergroßen Bildern und Shader-Kompilierungs-Ereignissen. Ersetzen, herunterrechnen oder vorwärmen.
7. Verifizieren Sie die Korrektur auf demselben Gerät. Verankern Sie das Budget in einem Benchmark, damit nichts regrediert.

Für Schritt 7 ist `package:flutter_driver` seit Flutter 3.13 zugunsten von `package:integration_test` mit `IntegrationTestWidgetsFlutterBinding.framework.allReportedDurations` veraltet. Die [Performance-Test-Anleitung des Flutter-Teams](https://docs.flutter.dev/cookbook/testing/integration/profiling) zeigt, wie man das verkabelt und eine JSON-Datei ausgibt, die sich im CI vergleichen lässt. Wer eine CI-Matrix mehrerer Flutter-SDK-Versionen fährt, steckt dasselbe Harness in [eine Flutter-Pipeline mit mehreren Versionen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Eigene Timeline-Ereignisse für knifflige Fälle

Manchmal reichen die Engine-Ereignisse nicht und Sie wollen Ihren eigenen Code in der Timeline sehen. Die `dart:developer`-Bibliothek stellt eine synchrone Trace-API bereit, die DevTools automatisch aufgreift:

```dart
// Flutter 3.27.1, Dart 3.11
import 'dart:developer' as developer;

List<Product> parseCatalog(String json) {
  developer.Timeline.startSync('parseCatalog');
  try {
    return (jsonDecode(json) as List)
        .map((e) => Product.fromJson(e as Map<String, dynamic>))
        .toList();
  } finally {
    developer.Timeline.finishSync();
  }
}
```

Nun erscheint `parseCatalog` als beschrifteter Span in der UI-Thread-Timeline, und Frame Analysis kann ihm Zeit direkt zuordnen. Sparsam einsetzen: jede `Timeline.startSync` hat geringe, aber nicht null Kosten, also wickeln Sie keine heiße innere Schleife damit ein. Setzen Sie sie an groben Grenzen ein (ein Parse, ein Netzwerkantwort-Handler, eine Controller-Methode), wo die Kosten vernachlässigbar sind im Vergleich zur gemessenen Arbeit.

Für asynchrone Arbeit nutzen Sie `Timeline.timeSync` für synchrone Abschnitte innerhalb von async-Funktionen, oder `Timeline.startSync('name', flow: Flow.begin())` zusammen mit `Flow.step` und `Flow.end`, um eine Flusslinie zu zeichnen, die zusammengehörige Ereignisse über Threads hinweg verbindet. Das Frame-Analysis-Panel kann diesen Fluss anzeigen, wenn ein Frame ausgewählt ist.

## Speicherdruck kann wie Jank aussehen

Sehen Sie periodische Aussetzer von 50 bis 100 ms, die im UI-Thread auftauchen, aber zu keinem Code in Ihrem Aufrufstapel passen, ist die Ursache oft eine große Garbage Collection. Öffnen Sie den Memory-Tab und schauen Sie sich die GC-Markerlinie an. Häufige Old-Generation-GCs korrelieren mit der Allokation vieler kurzlebiger Objekte pro Frame.

Die üblichen Kandidaten:

- Neue `TextStyle`- oder `Paint`-Objekte innerhalb von `build` allokieren.
- Unveränderliche Listen (`List.from`, `[...spread]`) pro Frame für `ListView` neu aufbauen.
- `Future.delayed(Duration.zero, () => setState(...))` als Workaround für Reentry verwenden, was pro Frame eine Microtask plant.

Heben Sie Konstanten aus `build` heraus (`const TextStyle(...)` auf Dateiebene ist Ihr Freund) und bevorzugen Sie wachsende Listen, die Sie mutieren, gegenüber Neuaufbau. Die Funktion "Profile Memory" im Memory-Tab erfasst ein Heap-Allokationsprofil, das exakt zeigt, welche Klasse den Müll produziert.

## Native Code aufrufen ist sein eigenes Profiling-Problem

Verwendet Ihre App Platform Channels (ein `MethodChannel`, ein `EventChannel`), sieht Dart diese Aufrufe als einfache `Future`s, doch die eigentliche Arbeit findet in einem Plattform-Thread statt. DevTools zeigt das Warten auf Dart-Seite, kann aber nicht in den nativen Handler hineinsehen. Hat ein Frame Jank wegen einer langsamen Kotlin- oder Swift-Implementierung, müssen Sie einen nativen Profiler (Android Studios CPU Profiler oder Xcode Instruments) an denselben Prozess anhängen.

Die andere Stolperfalle: synchrone Platform-Channel-Aufrufe sind in modernem Flutter unzulässig (sie brechen mit `Synchronous platform messages are not allowed` ab), jedes Blockieren ist also Async-Blockieren auf der Dart-Seite. Dauert ein `MethodChannel.invokeMethod` 200 ms, sind das 200 ms, in denen `await` zurückkehrt und ein Frame fertig werden kann, doch alles, was an das Ergebnis gekettet ist, landet in einem späteren Frame, was nach übersprungenen Frames aussehen kann. Die Lösung: den Channel so architektieren, dass die UI nie auf einem einzigen Round-Trip basiert, um zu rendern. Mehr Details in [der Anleitung zu Platform Channels](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

## Häufige Falsch-Positive

Ein Frame ist nicht "janky", nur weil er lang ist. Einige Muster, die wie Jank aussehen, aber keiner sind:

- Der allererste Frame nach einem Hot Reload. Hot Reload löst Widgets neu auf und ist absichtlich nicht optimiert. Ignorieren Sie den ersten Frame nach jedem Reload.
- Ein Frame, der läuft, während die App in den Hintergrund wechselt. Das Betriebssystem kann den Renderer mitten im Frame pausieren.
- Ein Phantom-Frame während einer Hintergrund-Neukompilierung.

Im Zweifel reproduzieren Sie den Jank zweimal in einem frischen `flutter run --profile` und glauben nur, was über beide Läufe konsistent ist.

## Verwandt

- [Ein Dart-Isolate für CPU-gebundene Arbeit schreiben](/de/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) behandelt das Verlagern schwerer Parses oder Berechnungen aus dem UI-Thread.
- [Plattformspezifischen Code in Flutter ohne Plugins hinzufügen](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) geht tiefer auf `MethodChannel` und das Threading-Modell ein.
- [Mehrere Flutter-Versionen aus einer CI-Pipeline ansprechen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) ist das Harness, das Sie wollen, sobald Sie einen Regressions-Benchmark haben.
- [Eine Flutter-App von GetX auf Riverpod migrieren](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) bespricht den Rebuild-Bereich, eine der größten Quellen von UI-Thread-Jank.
- [Flutter iOS von Windows aus debuggen: ein Workflow mit echtem Gerät](/de/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) zeigt, wie man DevTools an ein remote gebautes iOS-Gerät anhängt, wenn man Xcode nicht lokal ausführen kann.

## Quellen

- [Performance-Übersicht für Flutter-Apps](https://docs.flutter.dev/perf/ui-performance) (docs.flutter.dev)
- [DevTools-Performance-Ansicht](https://docs.flutter.dev/tools/devtools/performance) (docs.flutter.dev)
- [DevTools CPU Profiler](https://docs.flutter.dev/tools/devtools/cpu-profiler) (docs.flutter.dev)
- [App-Performance mit Integrationstests profilen](https://docs.flutter.dev/cookbook/testing/integration/profiling) (docs.flutter.dev)
- [Impeller-Rendering-Engine](https://docs.flutter.dev/perf/impeller) (docs.flutter.dev)
- [`dart:developer`-Timeline-API](https://api.dart.dev/stable/dart-developer/Timeline-class.html) (api.dart.dev)
