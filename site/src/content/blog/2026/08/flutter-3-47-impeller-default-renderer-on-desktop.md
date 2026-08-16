---
title: "Flutter 3.47 Makes Impeller the Default Renderer on Windows, Linux, and macOS"
description: "Flutter 3.47.0 stable flips desktop apps from Skia to Impeller without touching a line of your runner code. Here is what moves, how to opt out on each platform, and why that opt-out is temporary."
pubDate: 2026-08-16
tags:
  - "flutter"
  - "dart"
  - "impeller"
  - "windows"
---

Flutter 3.47.0 landed on the stable channel on August 12, 2026, carrying Dart 3.13.0. Most of the attention is going to the standalone `material_ui` and `cupertino_ui` 1.0 packages, which continue the split that started in [Flutter 3.44](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/). The change that will actually alter how your app draws is quieter: Impeller is now the default renderer on Windows, Linux, and macOS.

## Nothing in your project changes, which is exactly the problem

The desktop runner is generated code that lives in your repository, so it is tempting to assume a renderer swap would arrive as a template diff you can review. It does not. On Flutter 3.44, the Windows entry point looks like this, and there is no renderer selection anywhere in it:

```cpp
flutter::DartProject project(L"data");

std::vector<std::string> command_line_arguments = GetCommandLineArguments();
project.set_dart_entrypoint_arguments(std::move(command_line_arguments));
```

`ImpellerSwitch` does not exist anywhere in the 3.44 SDK. Upgrading to 3.47 leaves `windows\runner\main.cpp` byte for byte identical and changes the default underneath it. If a Windows or Linux build starts showing visual regressions after the upgrade, the renderer is the first thing to check, not your widget tree.

## Opting out, per platform

For local debugging, one flag covers all three desktop platforms:

```bash
flutter run --no-enable-impeller
```

For a deployed build you have to edit the runner. Windows, in `windows\runner\main.cpp`:

```cpp
flutter::DartProject project(L"data");
project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
```

Linux, in `linux/runner/my_application.cc`:

```c
g_autoptr(FlDartProject) project = fl_dart_project_new();
fl_dart_project_set_enable_impeller(project, FALSE);
```

macOS, in the top level `<dict>` of `Info.plist`:

```xml
<key>FLTEnableImpeller</key>
<false />
```

Treat all three as a stopgap. The [Impeller documentation](https://docs.flutter.dev/perf/impeller) states that the ability to opt out will be removed in a future release, which is the same sequence iOS and Android went through. Use the switch to unblock a release, then file the rendering bug.

## What the switch buys you

Impeller targets Metal on macOS and Vulkan on Windows and Linux rather than routing through Skia's OpenGL path. The concrete win is shader handling: Impeller compiles its shaders ahead of time at build time instead of on first use, which is what removes the first run jank that desktop and mobile users have complained about for years. Flutter 3.47 also enables signed distance field rendering for text and vector curves on macOS, Linux, and Windows, so glyph edges and curves come out sharper, and wide gamut color is on by default on macOS.

## The rest of 3.47 worth reading before you upgrade

- Minimum deployment targets move to iOS 15 and macOS 12 for Xcode 27 compatibility.
- Widget Previews graduate to stable.
- Win32 and Linux both get popup window support, and the windowing API renames `preferredSize` to `size` and `preferredConstraints` to `constraints`.
- New Android projects use AGP 9 or later templates with built in Kotlin support.

The full list is in the [Flutter 3.47.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0) and the [announcement post](https://flutter.dev/blog/whats-new-in-flutter-3-47). If you ship a desktop Flutter app, run your visual regression suite before you merge the SDK bump.
