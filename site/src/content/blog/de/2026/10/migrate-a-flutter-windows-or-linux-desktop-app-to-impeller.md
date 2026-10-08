---
title: "Eine Flutter-Desktop-App für Windows oder Linux auf Impeller migrieren (Flutter 3.47)"
description: "Flutter 3.47 macht Impeller zum Standard-Renderer unter Windows und Linux. Was sich darunter tatsächlich ändert (es bleibt OpenGL ES, nicht Vulkan), wie Sie auf einem fertigen Binary gegen Skia A/B-testen, ein Kill Switch pro Rechner für Release-Builds und warum Ihre Golden Tests nichts bemerken."
pubDate: 2026-10-08
updatedDate: 2026-10-08
template: migration
tags:
  - "migration"
  - "flutter"
  - "impeller"
  - "windows"
  - "linux"
lang: "de"
translationOf: "2026/10/migrate-a-flutter-windows-or-linux-desktop-app-to-impeller"
translatedBy: "claude"
translationDate: 2026-10-08
---

Flutter 3.47.0 (stabil seit 2026-08-12, Dart 3.13) stellt Desktop-Apps unter Windows und Linux von Skia auf Impeller um, ohne dass Sie eine Zeile Ihres Runner-Codes ändern müssen. Für die meisten Apps ist die Migration eine Sache von einem Nachmittag: aktualisieren, prüfen, dass das Engine-Log `Using the Impeller rendering backend (OpenGLESSDF)` ausgibt, Screenshots und Frame-Zeiten mit einem Lauf mit `--no-enable-impeller` vergleichen und erst dann entscheiden, ob Sie mit Impeller ausliefern oder Skia vorübergehend in `windows/runner/main.cpp` bzw. `linux/runner/my_application.cc` festschreiben. Was kaputtgeht, ist meist visuell: die Text-Rasterisierung (Impeller erzwingt auf dem Desktop Signed-Distance-Field-Text, dazu eine neue Gamma-Korrektur), Anti-Aliasing auf GPUs ohne implizites MSAA und der eine oder andere eigene Shader. Alles unten wurde gegen die Engine von Flutter 3.47.0 und den Quellcode von `flutter_tools` geprüft.

## Was sich unter Ihrer App tatsächlich ändert

Zuerst sollten Sie wissen, was sich **nicht** ändert: die Grafik-API. Der Windows-Embedder rendert weiterhin über OpenGL ES via ANGLE, das nach Direct3D 11 übersetzt. `flutter_windows_engine.cc` in 3.47.0 erzeugt unabhängig vom Renderer einen `egl::Manager` und ein `CompositorOpenGL`, und der Linux-Embedder kennt nur zwei Renderer-Typen, `opengl` und `software`. In keinem der beiden Desktop-Embedder gibt es einen Vulkan-Pfad. Impeller auf dem Desktop ist das GLES-Backend von Impeller auf demselben GL-Kontext, den zuvor Skia verwendet hat. Unter macOS ist es das Metal-Backend von Impeller.

Was sich ändert, ist alles oberhalb der GL-Aufrufe:

- **Shader sind vorkompiliert.** Impeller liefert einen festen, vorab gebauten Shader-Satz mit, statt Shader bei der ersten Verwendung zu erzeugen und zu kompilieren. Genau daher kam das Ruckeln von Skia beim ersten Start.
- **Text wird mit SDFs gezeichnet.** Unter Windows hängt der Embedder `--impeller-use-sdfs=true` an, sobald Impeller aktiv ist, sofern Sie den Schalter nicht selbst übergeben. Unter Linux wird `--impeller-use-sdfs` bedingungslos angehängt. Die Release Notes von 3.47 fügen auf beiden Plattformen außerdem eine Gamma-Korrektur für Glyphen hinzu ([#187122](https://github.com/flutter/flutter/pull/187122), [#187871](https://github.com/flutter/flutter/pull/187871)).
- **Der Standardwert liegt im Engine-Code, nicht in Ihrem Projekt.** `ImpellerSwitch::Default` bedeutet "das entscheidet die Engine", und in 3.47 ist das unter Windows `true` ([#188140](https://github.com/flutter/flutter/pull/188140)) und unter Linux `TRUE` in `fl_dart_project_init` ([#187573](https://github.com/flutter/flutter/pull/187573)). Ihr generierter Runner ist Byte für Byte derselbe wie unter 3.44.

Dieser letzte Punkt ist der Grund, warum es einen bewussten Migrationsdurchlauf braucht. Nichts in Ihrem Diff verrät Reviewern, dass sich der Renderer geändert hat.

## Was kaputtgeht

| Bereich | Änderung in 3.47 | Schweregrad |
| --- | --- | --- |
| Text-Rendering | SDF-Glyphen plus Gamma-Korrektur; Glyphenkanten und Strichstärken verschieben sich leicht | mittel |
| Anti-Aliasing | Windows-GPUs ohne implizites MSAA benötigen den Offscreen-MSAA-Pfad ([#190374](https://github.com/flutter/flutter/pull/190374), in 3.47 per Cherry-Pick enthalten) | mittel |
| Integrations-Screenshots | Pixel-Diffs gegen Baselines, die unter Skia erstellt wurden | mittel |
| Eigene Fragment-Shader | Werden von `impellerc` für das GLES-Ziel kompiliert; treiberspezifische Fehler treten anders zutage | gering bis mittel |
| `flutter test`-Goldens | Standardmäßig nicht betroffen (siehe Stolperfallen) | keiner |
| Runner-Code | Keine Änderung an der Vorlage; das Abschalten erfordert eine manuelle Anpassung | gering |

## Checkliste vor dem Start

- Flutter 3.44.x ist noch irgendwo installiert (FVM, ein zweiter Checkout oder ein CI-Image), damit Sie eine Skia-Baseline bauen können. Wenn Sie bereits [mehrere Flutter-Versionen aus einer CI-Pipeline](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) betreiben, fügen Sie 3.47 als neuen Zweig hinzu, statt den alten zu ersetzen.
- Eine Liste der Rechner, die Sie tatsächlich unterstützen: mindestens ein Windows-Rechner mit integrierter Intel-GPU, einer mit dedizierter NVIDIA- oder AMD-GPU und ein Linux-Rechner mit Mesa-Treibern. VMs und RDP-Sitzungen verdienen eine eigene Zeile.
- Eine Handvoll Bildschirme, die das Rendering fordern: dichter Text, gedrehter oder skalierter Text, eigene Painter, Weichzeichner und Schatten sowie jeder `FragmentProgram`-Shader.
- Wenn Sie aus derselben Codebasis auch macOS ausliefern: 3.47 hebt die Untergrenze auf macOS 12 an. Das ist eine [separate Migration](/de/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/), die Ihnen im selben SDK-Update begegnet.

## Migrationsschritte

1. **Eine Skia-Baseline unter 3.44 erfassen.** Bauen Sie Profile-Binaries und machen Sie auf jedem Zielrechner Screenshots Ihrer anspruchsvollen Bildschirme:

   ```bash
   # Flutter 3.44.x
   flutter build windows --profile
   flutter build linux --profile
   ```

   Erfassen Sie auch die Frame-Zeiten. Ein [DevTools-Performance-Trace](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) der ersten 10 Sekunden nach dem Start und Ihres aufwendigsten Scrollvorgangs genügt. Prüfung: Sie haben pro Rechner einen Trace und einen Satz Screenshots.

2. **Auf 3.47 aktualisieren und neu bauen.**

   ```bash
   flutter upgrade
   flutter --version   # expect Flutter 3.47.x, Dart 3.13.x
   flutter clean
   flutter build windows --profile
   ```

   Prüfung: `git status` zeigt keine Änderungen unter `windows/runner/` oder `linux/runner/`. Falls doch, hat jemand `flutter create .` ausgeführt, und Sie sollten diesen Diff gesondert prüfen.

3. **Bestätigen, welches Backend die Engine gewählt hat.** Starten Sie die App mit `flutter run -d windows` (oder `-d linux`) und suchen Sie die Startzeile der Engine:

   ```text
   [IMPORTANT:flutter/shell/platform/embedder/embedder_surface_gl_impeller.cc(126)] Using the Impeller rendering backend (OpenGLESSDF).
   ```

   `OpenGLESSDF` bedeutet Impeller mit SDF-Text, das erwartete Ergebnis auf beiden Plattformen. Sehen Sie stattdessen `Could not create Impeller context.`, konnte der GL-Kontext Impeller nicht erfüllen, und Sie haben ein Treiberproblem, dem Sie vor allem anderen nachgehen müssen. Beachten Sie, dass es in der Embedder-Oberfläche keinen stillen Fallback auf Skia gibt: Die Impeller-Oberfläche ist schlicht ungültig. Prüfung: Die Zeile erscheint genau einmal pro Fenster.

4. **Dasselbe Binary per A/B-Test gegen Skia laufen lassen.** Für `flutter run` funktioniert das Flag auf allen Desktop-Plattformen:

   ```bash
   flutter run -d windows --profile --no-enable-impeller
   ```

   Bei einem bereits gebauten Debug- oder Profile-Binary können Sie den Renderer über die Umgebungsvariablen für Engine-Schalter umlegen, die beide Desktop-Embedder über `GetSwitchesFromEnvironment()` lesen:

   ```powershell
   # Flutter 3.47, Windows, debug or profile build only
   $env:FLUTTER_ENGINE_SWITCHES = "1"
   $env:FLUTTER_ENGINE_SWITCH_1 = "enable-impeller=false"
   .\build\windows\x64\runner\Profile\my_app.exe
   ```

   ```bash
   # Flutter 3.47, Linux, debug or profile build only
   FLUTTER_ENGINE_SWITCHES=1 FLUTTER_ENGINE_SWITCH_1=enable-impeller=false \
     ./build/linux/x64/profile/bundle/my_app
   ```

   So geben Sie Testern am schnellsten einen Build und zwei Verknüpfungen. Prüfung: Die Startzeile im Log verschwindet, wenn der Schalter gesetzt ist, und kehrt zurück, wenn er fehlt.

5. **Screenshots und Traces vergleichen.** Legen Sie die Skia-Screenshots von 3.44, die Skia-Screenshots von 3.47 und die Impeller-Screenshots von 3.47 nebeneinander. Der aussagekräftige Vergleich ist 3.47 Skia gegen 3.47 Impeller, weil er den Renderer von allen anderen Änderungen des Releases isoliert. Rechnen Sie damit, dass Text überall leicht anders aussieht. Achten Sie auf Dinge, die falsch statt nur anders sind: abgeschnittene Glyphen, fehlende Schatten, gezackte Kanten an abgerundeten Rechtecken, schwarze Bereiche. Prüfung: Jeder Unterschied ist entweder akzeptiert oder hat einen minimalen Repro.

6. **Entscheiden und bei Bedarf Skia im Runner festschreiben.** Haben Sie eine echte Regression gefunden, deaktivieren Sie Impeller im ausgelieferten Build. Unter Windows in `windows/runner/main.cpp`:

   ```cpp
   // Flutter 3.47, windows/runner/main.cpp
   flutter::DartProject project(L"data");
   project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
   ```

   Unter Linux in `linux/runner/my_application.cc`, vor `fl_view_new(project)`:

   ```c
   // Flutter 3.47, linux/runner/my_application.cc
   g_autoptr(FlDartProject) project = fl_dart_project_new();
   fl_dart_project_set_enable_impeller(project, FALSE);
   ```

   Prüfung: Neu bauen, starten und bestätigen, dass die Zeile `Using the Impeller rendering backend` verschwunden ist.

7. **Den Bug am selben Tag melden.** Die [Impeller-Dokumentation](https://docs.flutter.dev/perf/impeller) besagt, dass das Abschalten in einem künftigen Release entfernt wird, wie schon unter iOS. Eröffnen Sie ein Issue mit dem Titelpräfix `[Impeller]`, einem minimalen Repro, GPU und Treiberversion, Screenshots und einem gezippten Performance-Trace. Prüfung: Der Issue-Link steht als Kommentar neben der Zeile zum Abschalten, damit derjenige, der sie später entfernt, weiß, warum sie dort steht.

## Ein Kill Switch pro Rechner für Release-Builds

Der Trick mit `FLUTTER_ENGINE_SWITCHES` aus Schritt 4 funktioniert in Release-Builds nicht. `engine_switches.cc` kapselt die gesamte Abfrage in `#ifndef FLUTTER_RELEASE`, sodass eine ausgelieferte App ihn ignoriert. Wenn Sie Impeller ausliefern, aber einen Notausgang für den einen Kunden behalten wollen, dessen Laptop von 2017 ein schwarzes Fenster zeichnet, lesen Sie im Runner eine eigene Umgebungsvariable:

```cpp
// Flutter 3.47, windows/runner/main.cpp
#include <cwchar>

flutter::DartProject project(L"data");

wchar_t value[8];
DWORD length = ::GetEnvironmentVariableW(L"MYAPP_DISABLE_IMPELLER", value, 8);
if (length > 0 && length < 8 && std::wcscmp(value, L"1") == 0) {
  project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
}
```

```c
// Flutter 3.47, linux/runner/my_application.cc
g_autoptr(FlDartProject) project = fl_dart_project_new();
if (g_strcmp0(g_getenv("MYAPP_DISABLE_IMPELLER"), "1") == 0) {
  fl_dart_project_set_enable_impeller(project, FALSE);
}
```

Der Support kann betroffenen Nutzern dann sagen, eine Variable zu setzen, statt auf einen neuen Build zu warten. Ein Registry-Wert oder eine Zeile in einer Konfigurationsdatei neben der ausführbaren Datei funktioniert genauso, falls Umgebungsvariablen für Ihre Nutzer unpraktisch sind. Behandeln Sie das als temporäres Gerüst mit derselben Lebensdauer wie das Abschalten in der Engine.

## Verifizierung

Nach der Migration, auf jedem Rechner Ihrer Matrix:

- Die App startet, und das Log zeigt `OpenGLESSDF` (oder gar keine Impeller-Zeile, wenn Sie Skia festgeschrieben haben).
- Ihre Integrationstests laufen durch. Screenshot-basierte brauchen neue Baselines; erzeugen Sie diese bewusst unter 3.47 neu, statt einen Massenlauf "update goldens" eine echte Regression verdecken zu lassen.
- Der erste Start nach einer frischen Installation zeigt in der Timeline kein Ruckeln durch Shader-Kompilierung. Das ist die Verbesserung, für die Sie den Aufwand betreiben, also messen Sie sie.
- Die Frame-Zeiten im eingeschwungenen Zustand auf Ihrem aufwendigsten Bildschirm liegen innerhalb Ihres Budgets. Impeller ist nicht bei jedem Frame schneller; es ist berechenbarer.
- Schnelles Ändern der Fenstergröße führt unter Linux nicht zum Absturz (ein Absturz beim Ändern der Größe wurde im 3.47-Zyklus in [#187626](https://github.com/flutter/flutter/pull/187626) behoben, ein guter Grund, keine ältere Beta per Cherry-Pick zu verwenden).

## Rollback-Plan

Der Rollback ist günstig und in beide Richtungen umkehrbar. Entweder Sie gehen auf 3.44.x zurück, das Impeller unter Windows oder Linux nie standardmäßig aktiviert hat, oder Sie bleiben auf 3.47 und fügen das Abschalten im Runner aus Schritt 6 hinzu. Die zweite Variante ist besser: Sie behalten alle anderen Fixes von 3.47 und können durch Löschen einer einzigen Zeile zurückwechseln. Verlassen Sie sich nur nicht darauf, dass das Abschalten ewig existiert.

## Stolperfallen

**Umgebungsschalter schlagen den Projektschalter unter Windows.** Im Konstruktor von `FlutterWindowsEngine` wird zuerst der `ImpellerSwitch` des Projekts gelesen, danach überschreibt die Schleife über die Umgebungsschalter ihn. Ein Entwickler, in dessen Shell-Profil noch `FLUTTER_ENGINE_SWITCH_1=enable-impeller=true` steht, sieht Impeller selbst auf einem Branch, der `Disabled` festgeschrieben hat. Prüfen Sie `env`, bevor Sie irgendetwas anderes debuggen.

**`ImpellerSwitch::Default` ist nicht `Enabled`.** Wenn Sie Impeller unabhängig von künftigen Entscheidungen eines Releases fest einschalten wollen, setzen Sie `ImpellerSwitch::Enabled` ausdrücklich. `Default` folgt der Engine, und genau das hat sich in 3.47 unter Ihnen umgedreht.

**`flutter test`-Goldens sehen Impeller nicht.** `flutter_tester_device.dart` startet die Test-Shell mit `--enable-software-rendering --skia-deterministic-rendering`, solange Sie nicht `--enable-impeller` übergeben. Ihre Widget-Test-Goldens bestehen nach dem Upgrade weiterhin, was nichts über den Desktop-Renderer aussagt. Nur Integrationstests, die die echte `.exe` oder das Linux-Bundle ausführen, belasten Impeller.

**Das Abschalten unter Linux muss erfolgen, bevor die View existiert.** `fl_dart_project_set_enable_impeller` setzt ein Feld, das `FlEngine` beim Start liest. Rufen Sie es direkt nach `fl_dart_project_new()` und vor `fl_view_new(project)` auf, nicht erst später in `my_application_activate`.

**Laptops mit Hybrid-GPU wählen eine GPU, bevor der Renderer eine Rolle spielt.** Unter Windows entscheidet `DartProject::set_gpu_preference` mit `flutter::GpuPreference::HighPerformancePreference` oder `LowPowerPreference`, welchen Adapter ANGLE verwendet. Tritt eine Regression nur auf einem Laptop mit Intel- und NVIDIA-GPU auf, testen Sie beide Einstellungen, bevor Sie Impeller beschuldigen.

**VMs und Remote-Sitzungen.** Rechner ohne implizite MSAA-Unterstützung zeigten früher im 3.47-Zyklus unter Windows einen schwarzen Bildschirm; [#187288](https://github.com/flutter/flutter/pull/187288) und der Offscreen-MSAA-Fallback in [#190374](https://github.com/flutter/flutter/pull/190374) haben das behoben. Sehen Sie in einer VM ein schwarzes Fenster, bestätigen Sie, dass Sie den neuesten 3.47-Patch verwenden, bevor Sie ein neues Issue eröffnen.

**Eigene Shader.** `FragmentProgram`-Shader funktionieren weiter, laufen aber nun im GLES-Backend von Impeller auf dem Treiber, den ANGLE oder Mesa bereitstellt. Testen Sie jede `.frag`-Datei auf Ihrer ältesten unterstützten GPU erneut und verlassen Sie sich nicht auf Präzisionsverhalten, das unter Skia zufällig funktionierte.

**Das Abschalten läuft auf Zeit.** Jedes Abschalten, das Sie hinzufügen, ist Schuld mit einer Frist, die Sie nicht kontrollieren. Legen Sie den Issue-Link daneben und prüfen Sie es bei jedem Flutter-Upgrade erneut.

## Weiterführend

- Die Zusammenfassung dieser Änderung zum Launch: [Flutter 3.47 macht Impeller zum Standard-Renderer unter Windows, Linux und macOS](/de/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).
- Vorher und nachher messen: [Jank in einer Flutter-App mit DevTools profilieren](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).
- 3.44 und 3.47 nebeneinander betreiben: [mehrere Flutter-Versionen aus einer CI-Pipeline ansprechen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- Die andere Desktop-Migration im selben Release: [das Deployment-Ziel einer Flutter-macOS-App auf macOS 12 anheben](/de/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/).
- Dieselbe Renderer-Entscheidung im Web: [CanvasKit vs. skwasm für Flutter Web 2026](/de/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/).

## Quellen

- [Impeller rendering engine](https://docs.flutter.dev/perf/impeller) auf docs.flutter.dev (Desktop-Status, Snippets zum Abschalten, Checkliste für Fehlerberichte).
- [Flutter 3.47.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0).
- [flutter/flutter#188140](https://github.com/flutter/flutter/pull/188140): macht Impeller zum Standard-Renderer unter Windows.
- [flutter/flutter#187573](https://github.com/flutter/flutter/pull/187573): schaltet Impeller unter Linux standardmäßig ein.
- [flutter/flutter#188044](https://github.com/flutter/flutter/pull/188044): fügt den Windows-Projektschalter hinzu.
- [flutter/flutter#187288](https://github.com/flutter/flutter/pull/187288): behebt den schwarzen Bildschirm auf dem Windows-OpenGL-Pfad.
- Flutter-3.47.0-Quellcode: `engine/src/flutter/shell/platform/windows/flutter_windows_engine.cc`, `engine/src/flutter/shell/platform/linux/fl_engine.cc`, `engine/src/flutter/shell/platform/common/engine_switches.cc` und `packages/flutter_tools/lib/src/test/flutter_tester_device.dart`.
