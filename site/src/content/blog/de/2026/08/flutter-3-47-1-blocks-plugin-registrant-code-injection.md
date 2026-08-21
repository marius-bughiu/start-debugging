---
title: "Flutter 3.47.1 verhindert, dass ein transitives Paket nativen Code in Ihre App injiziert"
description: "Der Hotfix 3.47.1 validiert Plugin-Klassen- und Paket-Identifier, bevor sie im GeneratedPluginRegistrant landen. Hier sind die Lücke, die geschlossen wird, der zuständige reguläre Ausdruck und die weiteren 11 Korrekturen des Release."
pubDate: 2026-08-21
tags:
  - "flutter"
  - "dart"
  - "security"
  - "flutter-tools"
lang: "de"
translationOf: "2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection"
translatedBy: "claude"
translationDate: 2026-08-21
---

Flutter 3.47.1 erschien am 2026-08-19 im Stable-Channel und bringt Dart 3.13.1 mit, genau eine Woche nachdem [3.47.0 Impeller zum Standardrenderer auf dem Desktop gemacht hat](/de/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/). Zwölf Issues sind für Flutter-Verhältnisse ein großer Hotfix, und eines davon ist gar keine Absturzkorrektur. Es ist eine Supply-Chain-Lücke zur Buildzeit in `flutter_tools`.

## Plugin-Identifier landeten ungeschützt im generierten nativen Code

Bei `flutter pub get` oder `flutter build` durchläuft das Tool den transitiven Abhängigkeitsgraphen und schreibt für jede Plattform einen `GeneratedPluginRegistrant`. Die Werte `pluginClass` und das Android-`package` aus der `pubspec.yaml` jedes Plugins werden wörtlich in diese Datei interpoliert, in Templates wie `new {{package}}.{{class}}()` für Java, `{{prefix}}{{class}}.register(...)` für Swift und `#import <{{name}}/{{class}}.h>` für Objective-C. Der Template-Renderer läuft mit `htmlEscapeValues` auf `false`, es wird also unterwegs nichts escaped.

Die Validierung prüfte nur, ob diese Felder Strings sind. Ich habe das gegen ein lokales 3.44.2 SDK bestätigt, wo `AndroidPlugin.validate` weiterhin nur ein Typtest ist:

```dart
static bool validate(YamlMap yaml) {
  return (yaml['package'] is String && yaml[kPluginClass] is String) ||
      yaml[kDartPluginClass] is String ||
      yaml[kFfiPlugin] == true ||
      yaml[kDefaultPackage] is String;
}
```

Ein String mit Semikolons, geschweiften Klammern und Zeilenumbrüchen besteht diese Prüfung. Eine Abhängigkeit mit dieser Deklaration kompiliert also beliebigen nativen Code in jede App, die von ihr abhängt:

```yaml
flutter:
  plugin:
    platforms:
      macos:
        pluginClass: "SomePlugin(); evilInjectedCall(); if (false) { SomePlugin"
```

Dringlich wird das durch die Reichweite. Plugins werden über `computeTransitiveDependencies` eingesammelt, ohne jede Zustimmung der konsumierenden App. Ein Paket drei Ebenen tiefer im Abhängigkeitsbaum kann das auslösen, und die Nutzlast läuft zur Buildzeit auf einer Entwicklermaschine oder einem CI-Runner, nicht zur Laufzeit der App, wo ein Review sie noch abfangen könnte.

## Was 3.47.1 stattdessen erzwingt

[PR 191294](https://github.com/flutter/flutter/pull/191294) ergänzt ein Identifier-Muster und wendet es auf jedes vorhandene Identifier-Feld an, nicht nur auf die, welche die Deklaration gültig gemacht haben:

```dart
final RegExp _pluginIdentifierPattern = RegExp(
  r'^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$',
);
```

Für Dart-Quellpfade gilt eine eigene Regel, da `fileName` und `dartFileName` in eine `import`-Anweisung interpoliert werden: `RegExp(r'^\w[\w./-]*\.dart$')`, dazu die explizite Ablehnung jedes Werts, der `..` enthält.

Die Fehlerbilder unterscheiden sich je Plattform. Ein ungültiger Identifier für Android, iOS, macOS, Linux oder Windows lässt `validate` false zurückgeben, und Sie erhalten `Invalid plugin specification <name>`. Web-Plugins scheitern mit einer spezifischeren Tool-Meldung: `The plugin <name> has an invalid pluginClass in its web plugin declaration.` Wenn Sie ein Plugin pflegen und Ihr Build unter 3.47.1 plötzlich fehlschlägt, prüfen Sie, ob die deklarierte Klasse ein einfacher punktgetrennter Identifier ist.

## Die anderen elf

Der Rest des Hotfix besteht überwiegend aus Tooling-Ärgernissen, zwei davon rechtfertigen das Update für sich: Hot Restart funktioniert wieder für WASM-Web-Builds ([flutter/186445](https://github.com/flutter/flutter/issues/186445)), und Hot Reload ignoriert keine Änderungen mehr in Pub-Workspace-Mitgliedspaketen unterhalb des `lib/` des Root-Pakets ([flutter/190284](https://github.com/flutter/flutter/issues/190284)). Ebenfalls enthalten: eine SwiftPM-Race-Condition, die bei parallelen Multi-Target-Builds für iOS und macOS eine `FileSystemException` warf, ein `impellerc`-Absturz unter Windows bei Pfaden mit Unicode-Zeichen, ein Deadlock im Debug-Adapter, wenn der Zielprozess vor dem Verbinden des VM Service endet, und projektweites Opt-in für Flutter GPU in Release-Builds unter Linux und Windows.

```bash
flutter channel stable
flutter upgrade
```

Die vollständige Liste steht im [Flutter-Hotfix-Changelog](https://github.com/flutter/flutter/blob/main/CHANGELOG.md).
