---
title: "Flutter 3.47.1 Stops a Transitive Package From Injecting Native Code Into Your App"
description: "The 3.47.1 hotfix validates plugin class and package identifiers before they land in GeneratedPluginRegistrant. Here is the hole it closes, the regex that closes it, and the other 11 fixes in the release."
pubDate: 2026-08-21
tags:
  - "flutter"
  - "dart"
  - "security"
  - "flutter-tools"
---

Flutter 3.47.1 landed on the stable channel on August 19, 2026, carrying Dart 3.13.1, exactly one week after [3.47.0 made Impeller the default desktop renderer](/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/). Twelve issues is a large hotfix by Flutter's standards, and one of them is not a crash fix at all. It is a build-time supply chain hole in `flutter_tools`.

## Plugin identifiers went into generated native source unescaped

When you run `flutter pub get` or `flutter build`, the tool walks your transitive dependency graph and writes a `GeneratedPluginRegistrant` for each platform. The `pluginClass` and Android `package` values from every plugin's `pubspec.yaml` get interpolated into that file verbatim, into templates that look like `new {{package}}.{{class}}()` for Java, `{{prefix}}{{class}}.register(...)` for Swift, and `#import <{{name}}/{{class}}.h>` for Objective-C. The template renderer runs with `htmlEscapeValues` set to `false`, so nothing is escaped on the way through.

Validation only checked that those fields were strings. I confirmed this against a local 3.44.2 SDK, where `AndroidPlugin.validate` is still just a type test:

```dart
static bool validate(YamlMap yaml) {
  return (yaml['package'] is String && yaml[kPluginClass] is String) ||
      yaml[kDartPluginClass] is String ||
      yaml[kFfiPlugin] == true ||
      yaml[kDefaultPackage] is String;
}
```

A string containing semicolons, braces, and newlines passes that check. So a dependency declaring this compiles arbitrary native code into any app that depends on it:

```yaml
flutter:
  plugin:
    platforms:
      macos:
        pluginClass: "SomePlugin(); evilInjectedCall(); if (false) { SomePlugin"
```

The part that makes this worth patching quickly is reach. Plugins are collected over `computeTransitiveDependencies`, with no opt-in from the consuming app. A package three levels down your dependency tree can trigger it, and the payload runs at build time on a developer machine or a CI runner, not at app runtime where a review might catch it.

## What 3.47.1 enforces instead

[PR 191294](https://github.com/flutter/flutter/pull/191294) adds an identifier pattern and applies it to every identifier field that is present, not only the ones that made the declaration valid:

```dart
final RegExp _pluginIdentifierPattern = RegExp(
  r'^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$',
);
```

Dart source paths get a separate rule, since `fileName` and `dartFileName` are interpolated into an `import` statement: `RegExp(r'^\w[\w./-]*\.dart$')`, plus an explicit rejection of any value containing `..`.

The failure modes differ by platform. A bad Android, iOS, macOS, Linux, or Windows identifier makes `validate` return false, and you get `Invalid plugin specification <name>`. Web plugins fail with a more specific tool exit, `The plugin <name> has an invalid pluginClass in its web plugin declaration.` If you maintain a plugin and your build suddenly fails on 3.47.1, check that your declared class is a plain dotted identifier.

## The other eleven

The rest of the hotfix is mostly tooling papercuts, and two are worth upgrading for on their own: hot restart is fixed for WASM web builds ([flutter/186445](https://github.com/flutter/flutter/issues/186445)), and hot reload no longer ignores edits in pub workspace member packages that sit under the root package's `lib/` ([flutter/190284](https://github.com/flutter/flutter/issues/190284)). Also in: a SwiftPM race that threw `FileSystemException` during parallel iOS and macOS multi-target builds, an `impellerc` crash on Windows paths containing Unicode characters, a debug adapter deadlock when the target process exits before the VM service connects, and project-level opt-in for Flutter GPU in release builds on Linux and Windows.

```bash
flutter channel stable
flutter upgrade
```

The full list is in the [Flutter hotfix changelog](https://github.com/flutter/flutter/blob/main/CHANGELOG.md).
