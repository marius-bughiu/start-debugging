---
title: "Flutter 3.44 Splits Material and Cupertino Out of the SDK and Defaults to SwiftPM"
description: "Flutter 3.44 stable freezes Material and Cupertino inside the SDK and points new work at the material_ui and cupertino_ui packages on pub.dev. SwiftPM also becomes the default for iOS and macOS, finally retiring CocoaPods."
pubDate: 2026-05-16
tags:
  - "flutter"
  - "dart"
  - "swiftpm"
  - "material-design"
---

Flutter 3.44 hit the stable channel this week, and the headline is structural rather than visual. The Material and Cupertino libraries are no longer pinned to the SDK release train. Going forward, the canonical home for `package:flutter/material.dart` and `package:flutter/cupertino.dart` is two new pub.dev packages, `material_ui` and `cupertino_ui`, and the in-SDK copies enter a long deprecation window. At the same time, `flutter config --enable-swift-package-manager` is the new default for iOS and macOS builds, which finally lets you drop Ruby and CocoaPods from a fresh Flutter setup.

## Why the UI libraries are leaving the SDK

Material and Cupertino have always shipped on Flutter's own 3-month cadence. That meant every Material 3 token tweak, every Cupertino keyboard fix, and every new `MenuAnchor` argument waited for the next quarterly cut. With the move to standalone packages, those teams own their own release rhythm. Pin `material_ui: ^1.0.0` in `pubspec.yaml` and you get Material updates as soon as they land on pub.dev, decoupled from whatever Dart SDK version your CI is on.

The migration is intentionally low-friction. In 3.44 the existing imports still work, but you will see a deprecation warning on `package:flutter/material.dart`. The recommended swap is mechanical:

```dart
// Before (still works in 3.44, deprecated)
import 'package:flutter/material.dart';

// After (new home on pub.dev)
import 'package:material_ui/material_ui.dart';
```

Add the package the usual way:

```yaml
dependencies:
  flutter:
    sdk: flutter
  material_ui: ^1.0.0
  cupertino_ui: ^1.0.0
```

The second-order benefit is binary size. Apps that only use Cupertino can stop dragging Material's theming, typography, and icon set into the tree-shaken bundle once the SDK copies are removed in a future release. Flutter's own [release notes for 3.44.0](https://docs.flutter.dev/release/release-notes/release-notes-3.44.0) call this the "code freeze" of the bundled libraries: bug fixes only, no new APIs.

## SwiftPM is now the default on iOS and macOS

The other big switch is `flutter config --enable-swift-package-manager` being on by default for new projects. `flutter create` no longer generates a `Podfile`. Plugins resolved through pub still get a `Package.swift` shim, and Xcode opens the project as a Swift package graph directly. For existing apps, the upgrade path is short:

```sh
flutter upgrade
flutter config --enable-swift-package-manager
cd ios && rm -rf Pods Podfile.lock
flutter run -d ios
```

CocoaPods is not removed; it stays as the fallback when you opt out, or when a plugin has not published a `Package.swift`. The deprecation warnings now flag plugins that still ship Pods-only.

## What else landed in 3.44

The release also introduces `Form.clearError()` for resetting validation state without rebuilding the form, `RoundedSuperellipseInputBorder` for iOS-style input fields, tooltip windows on Win32, macOS, and Linux, and predictive back support for `FlutterFragment` and `FlutterFragmentActivity` on Android. Plenty to dig into, but the package split is the change that will reshape `pubspec.yaml` files across the ecosystem first.

If you maintain a Flutter package that re-exports Material or Cupertino widgets, now is the time to add `material_ui` to your dev dependencies and start dual-publishing imports. The deprecation warnings will get louder fast.
