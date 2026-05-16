---
title: "Flutter 3.44 trennt Material und Cupertino vom SDK und macht SwiftPM zum Standard"
description: "Flutter 3.44 stable friert Material und Cupertino innerhalb des SDK ein und verweist neue Arbeit auf die Pakete material_ui und cupertino_ui auf pub.dev. SwiftPM wird außerdem der Standard für iOS und macOS und löst damit endgültig CocoaPods ab."
pubDate: 2026-05-16
tags:
  - "flutter"
  - "dart"
  - "swiftpm"
  - "material-design"
lang: "de"
translationOf: "2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default"
translatedBy: "claude"
translationDate: 2026-05-16
---

Flutter 3.44 hat diese Woche den Stable-Channel erreicht, und die Schlagzeile ist strukturell statt visuell. Die Material- und Cupertino-Bibliotheken sind nicht mehr an den Release-Zug des SDK gebunden. Das kanonische Zuhause von `package:flutter/material.dart` und `package:flutter/cupertino.dart` sind ab jetzt zwei neue pub.dev-Pakete, `material_ui` und `cupertino_ui`, und die Kopien im SDK treten in ein langes Deprecation-Fenster ein. Gleichzeitig ist `flutter config --enable-swift-package-manager` der neue Standard für iOS- und macOS-Builds, was Ihnen endlich erlaubt, Ruby und CocoaPods aus einem frischen Flutter-Setup zu entfernen.

## Warum die UI-Bibliotheken das SDK verlassen

Material und Cupertino sind immer im Drei-Monats-Takt von Flutter selbst ausgeliefert worden. Das bedeutete, dass jede Material-3-Token-Anpassung, jede Cupertino-Tastaturkorrektur und jedes neue `MenuAnchor`-Argument auf den nächsten Quartalsschnitt wartete. Mit dem Wechsel zu eigenständigen Paketen besitzen diese Teams ihren eigenen Release-Rhythmus. Pinnen Sie `material_ui: ^1.0.0` in `pubspec.yaml`, und Sie erhalten Material-Updates, sobald sie auf pub.dev landen, entkoppelt von der Dart-SDK-Version, auf der Ihr CI läuft.

Die Migration ist absichtlich reibungsarm. In 3.44 funktionieren die bestehenden Imports weiterhin, aber Sie werden eine Deprecation-Warnung auf `package:flutter/material.dart` sehen. Der empfohlene Tausch ist mechanisch:

```dart
// Before (still works in 3.44, deprecated)
import 'package:flutter/material.dart';

// After (new home on pub.dev)
import 'package:material_ui/material_ui.dart';
```

Fügen Sie das Paket auf die übliche Weise hinzu:

```yaml
dependencies:
  flutter:
    sdk: flutter
  material_ui: ^1.0.0
  cupertino_ui: ^1.0.0
```

Der Vorteil zweiter Ordnung ist die Binärgröße. Apps, die nur Cupertino verwenden, müssen das Theming, die Typografie und das Icon-Set von Material nicht mehr in das tree-shaked Bundle ziehen, sobald die SDK-Kopien in einer zukünftigen Version entfernt werden. Die [Release Notes zu 3.44.0](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0) selbst bezeichnen das als "Code Freeze" der gebündelten Bibliotheken: nur Bugfixes, keine neuen APIs.

## SwiftPM ist nun der Standard auf iOS und macOS

Die andere große Umstellung ist, dass `flutter config --enable-swift-package-manager` bei neuen Projekten standardmäßig aktiv ist. `flutter create` erzeugt kein `Podfile` mehr. Plugins, die über pub aufgelöst werden, erhalten weiterhin einen `Package.swift`-Shim, und Xcode öffnet das Projekt direkt als Swift-Paketgraph. Für bestehende Apps ist der Upgrade-Pfad kurz:

```sh
flutter upgrade
flutter config --enable-swift-package-manager
cd ios && rm -rf Pods Podfile.lock
flutter run -d ios
```

CocoaPods wird nicht entfernt; es bleibt als Fallback, wenn Sie sich dagegen entscheiden oder wenn ein Plugin kein `Package.swift` veröffentlicht hat. Die Deprecation-Warnungen markieren jetzt Plugins, die immer noch nur Pods ausliefern.

## Was sonst noch in 3.44 gelandet ist

Das Release führt außerdem `Form.clearError()` zum Zurücksetzen des Validierungsstatus ohne Rebuild des Formulars ein, `RoundedSuperellipseInputBorder` für Eingabefelder im iOS-Stil, Tooltip-Fenster auf Win32, macOS und Linux sowie Predictive-Back-Unterstützung für `FlutterFragment` und `FlutterFragmentActivity` auf Android. Es gibt viel zu erkunden, aber der Paket-Split ist die Änderung, die die `pubspec.yaml`-Dateien im Ökosystem zuerst umformen wird.

Wer ein Flutter-Paket pflegt, das Material- oder Cupertino-Widgets re-exportiert, sollte jetzt `material_ui` zu den Dev-Dependencies hinzufügen und mit dem Dual-Publishing der Imports beginnen. Die Deprecation-Warnungen werden schnell lauter.
