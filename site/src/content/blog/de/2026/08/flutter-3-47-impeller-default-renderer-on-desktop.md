---
title: "Flutter 3.47 macht Impeller zum Standard-Renderer unter Windows, Linux und macOS"
description: "Flutter 3.47.0 stable stellt Desktop-Apps von Skia auf Impeller um, ohne eine Zeile Ihres Runner-Codes anzufassen. Was sich ändert, wie Sie es pro Plattform abschalten und warum diese Abschaltung nur vorübergehend ist."
pubDate: 2026-08-16
tags:
  - "flutter"
  - "dart"
  - "impeller"
  - "windows"
lang: "de"
translationOf: "2026/08/flutter-3-47-impeller-default-renderer-on-desktop"
translatedBy: "claude"
translationDate: 2026-08-16
---

Flutter 3.47.0 ist am 2026-08-12 im Stable-Kanal erschienen und bringt Dart 3.13.0 mit. Die meiste Aufmerksamkeit gilt den eigenständigen Paketen `material_ui` und `cupertino_ui` in Version 1.0, die die mit [Flutter 3.44](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) begonnene Aufteilung fortsetzen. Die Änderung, die tatsächlich beeinflusst, wie Ihre App zeichnet, ist leiser: Impeller ist jetzt der Standard-Renderer unter Windows, Linux und macOS.

## In Ihrem Projekt ändert sich nichts, und genau das ist das Problem

Der Desktop-Runner ist generierter Code, der in Ihrem Repository liegt. Deshalb liegt die Annahme nahe, ein Renderer-Wechsel käme als Template-Diff, den Sie prüfen können. Das tut er nicht. In Flutter 3.44 sieht der Windows-Einstiegspunkt so aus, und eine Renderer-Auswahl gibt es darin nicht:

```cpp
flutter::DartProject project(L"data");

std::vector<std::string> command_line_arguments = GetCommandLineArguments();
project.set_dart_entrypoint_arguments(std::move(command_line_arguments));
```

`ImpellerSwitch` existiert im SDK 3.44 an keiner Stelle. Ein Update auf 3.47 lässt `windows\runner\main.cpp` Byte für Byte unverändert und ändert den Standardwert darunter. Wenn ein Windows- oder Linux-Build nach dem Update visuelle Regressionen zeigt, prüfen Sie zuerst den Renderer und nicht Ihren Widget-Baum.

## Abschalten, pro Plattform

Für lokales Debugging deckt ein Flag alle drei Desktop-Plattformen ab:

```bash
flutter run --no-enable-impeller
```

Für einen bereitgestellten Build müssen Sie den Runner bearbeiten. Windows, in `windows\runner\main.cpp`:

```cpp
flutter::DartProject project(L"data");
project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
```

Linux, in `linux/runner/my_application.cc`:

```c
g_autoptr(FlDartProject) project = fl_dart_project_new();
fl_dart_project_set_enable_impeller(project, FALSE);
```

macOS, im `<dict>` der obersten Ebene von `Info.plist`:

```xml
<key>FLTEnableImpeller</key>
<false />
```

Behandeln Sie alle drei als Übergangslösung. Die [Impeller-Dokumentation](https://docs.flutter.dev/perf/impeller) stellt fest, dass die Möglichkeit zum Abschalten in einer künftigen Version entfällt, dieselbe Abfolge wie zuvor bei iOS und Android. Nutzen Sie den Schalter, um ein Release freizugeben, und melden Sie dann den Rendering-Fehler.

## Was der Wechsel bringt

Impeller adressiert Metal unter macOS und Vulkan unter Windows und Linux, statt über den OpenGL-Pfad von Skia zu laufen. Der konkrete Gewinn liegt beim Umgang mit Shadern: Impeller kompiliert sie vorab zur Build-Zeit statt bei der ersten Verwendung, und genau das beseitigt das Ruckeln beim ersten Start, über das sich Desktop- und Mobile-Nutzer seit Jahren beschweren. Flutter 3.47 aktiviert zusätzlich Signed-Distance-Field-Rendering für Text und Vektorkurven unter macOS, Linux und Windows, wodurch Glyphenkanten und Kurven schärfer werden. Wide-Gamut-Farbe ist unter macOS standardmäßig aktiv.

## Der Rest von 3.47, den Sie vor dem Update lesen sollten

- Die minimalen Bereitstellungsziele steigen auf iOS 15 und macOS 12 wegen Xcode 27.
- Widget Previews erreicht Stable.
- Win32 und Linux erhalten Unterstützung für Popup-Fenster, und die Windowing-API benennt `preferredSize` in `size` und `preferredConstraints` in `constraints` um.
- Neue Android-Projekte nutzen Templates mit AGP 9 oder neuer und integrierter Kotlin-Unterstützung.

Die vollständige Liste steht in den [Release Notes zu Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0) und im [Ankündigungsbeitrag](https://flutter.dev/blog/whats-new-in-flutter-3-47). Wenn Sie eine Flutter-Desktop-App ausliefern, führen Sie Ihre visuelle Regressionssuite aus, bevor Sie den SDK-Bump mergen.
