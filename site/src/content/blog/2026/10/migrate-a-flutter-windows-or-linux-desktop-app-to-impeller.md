---
title: "Migrate a Flutter Windows or Linux desktop app to Impeller (Flutter 3.47)"
description: "Flutter 3.47 makes Impeller the default renderer on Windows and Linux. What actually changes underneath (it is still OpenGL ES, not Vulkan), how to A/B test against Skia on a built binary, a per-machine kill switch for release builds, and why your golden tests will not notice."
pubDate: 2026-10-08
updatedDate: 2026-10-08
template: migration
tags:
  - "migration"
  - "flutter"
  - "impeller"
  - "windows"
  - "linux"
---

Flutter 3.47.0 (stable since August 12, 2026, Dart 3.13) switches Windows and Linux desktop apps from Skia to Impeller without changing a line of your runner code. For most apps the migration is an afternoon: upgrade, confirm the engine log says `Using the Impeller rendering backend (OpenGLESSDF)`, compare screenshots and frame times against a `--no-enable-impeller` run, and only then decide whether to ship with Impeller or pin Skia temporarily in `windows/runner/main.cpp` or `linux/runner/my_application.cc`. What breaks is mostly visual: text rasterization (Impeller forces signed distance field text on desktop, plus new gamma correction), anti-aliasing on GPUs without implicit MSAA, and the odd custom shader. Everything below was checked against the Flutter 3.47.0 engine and `flutter_tools` source.

## What actually changes under your app

The first thing worth knowing is what does **not** change: the graphics API. The Windows embedder still renders through OpenGL ES via ANGLE, which translates to Direct3D 11. `flutter_windows_engine.cc` in 3.47.0 creates an `egl::Manager` and a `CompositorOpenGL` regardless of the renderer, and the Linux embedder only knows two renderer types, `opengl` and `software`. There is no Vulkan path in either desktop embedder. Impeller on desktop is Impeller's GLES backend running on the same GL context Skia used before. On macOS it is Impeller's Metal backend.

What changes is everything above the GL calls:

- **Shaders are precompiled.** Impeller ships a fixed, pre-built shader set instead of generating and compiling shaders on first use, which is where Skia's first-run jank came from.
- **Text is drawn with SDFs.** On Windows the embedder appends `--impeller-use-sdfs=true` whenever Impeller is on, unless you pass the switch yourself. On Linux it appends `--impeller-use-sdfs` unconditionally. The 3.47 release notes also add glyph gamma correction on both platforms ([#187122](https://github.com/flutter/flutter/pull/187122), [#187871](https://github.com/flutter/flutter/pull/187871)).
- **The default is in engine code, not your project.** `ImpellerSwitch::Default` means "whatever the engine decides", and in 3.47 that is `true` on Windows ([#188140](https://github.com/flutter/flutter/pull/188140)) and `TRUE` in `fl_dart_project_init` on Linux ([#187573](https://github.com/flutter/flutter/pull/187573)). Your generated runner is byte for byte the same as on 3.44.

That last point is why this needs a deliberate migration pass. Nothing in your diff tells reviewers the renderer changed.

## What breaks

| Area | Change in 3.47 | Severity |
| --- | --- | --- |
| Text rendering | SDF glyphs plus gamma correction; glyph edges and weights shift slightly | medium |
| Anti-aliasing | Windows GPUs without implicit MSAA need the offscreen MSAA path ([#190374](https://github.com/flutter/flutter/pull/190374), cherry-picked into 3.47) | medium |
| Integration screenshots | Pixel diffs against baselines captured on Skia | medium |
| Custom fragment shaders | Compiled by `impellerc` for the GLES target; driver-specific bugs surface differently | low to medium |
| `flutter test` goldens | Unaffected by default (see gotchas) | none |
| Runner code | No template change; opt-out requires a manual edit | low |

## Pre-flight checklist

- Flutter 3.44.x still installed somewhere (FVM, a second checkout, or a CI image) so you can build a Skia baseline. If you already run [several Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), add 3.47 as a new leg rather than replacing the old one.
- A list of the machines you actually support: at minimum one Windows box with an integrated Intel GPU, one with a discrete NVIDIA or AMD GPU, and one Linux machine with Mesa drivers. VMs and RDP sessions are worth a row of their own.
- A handful of screens that stress rendering: dense text, rotated or scaled text, custom painters, blurs and shadows, any `FragmentProgram` shader.
- If you also ship macOS from the same codebase, note that 3.47 raises the floor to macOS 12. That is a [separate migration](/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/) you will hit in the same SDK bump.

## Migration steps

1. **Capture a Skia baseline on 3.44.** Build profile binaries and screenshot your stress screens on each target machine:

   ```bash
   # Flutter 3.44.x
   flutter build windows --profile
   flutter build linux --profile
   ```

   Record frame times too. A [DevTools performance trace](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) of the first 10 seconds after launch and of your heaviest scroll is enough. Verify: you have one trace and one set of screenshots per machine.

2. **Upgrade to 3.47 and rebuild.**

   ```bash
   flutter upgrade
   flutter --version   # expect Flutter 3.47.x, Dart 3.13.x
   flutter clean
   flutter build windows --profile
   ```

   Verify: `git status` shows no changes under `windows/runner/` or `linux/runner/`. If it does, someone ran `flutter create .` and you should review that diff separately.

3. **Confirm which backend the engine picked.** Run the app with `flutter run -d windows` (or `-d linux`) and look for the engine's startup line:

   ```text
   [IMPORTANT:flutter/shell/platform/embedder/embedder_surface_gl_impeller.cc(126)] Using the Impeller rendering backend (OpenGLESSDF).
   ```

   `OpenGLESSDF` means Impeller with SDF text, which is the expected result on both platforms. If you instead see `Could not create Impeller context.`, the GL context could not satisfy Impeller and you have a driver problem to chase before anything else. Note that there is no silent fallback to Skia in the embedder surface: the Impeller surface is simply invalid. Verify: the line appears exactly once per window.

4. **A/B the same binary against Skia.** For `flutter run`, the flag works on all desktop platforms:

   ```bash
   flutter run -d windows --profile --no-enable-impeller
   ```

   For an already built debug or profile binary you can flip the renderer with the engine-switch environment variables, which both desktop embedders read through `GetSwitchesFromEnvironment()`:

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

   This is the fastest way to hand a tester one build and two shortcuts. Verify: the startup log line disappears when the switch is set, and comes back when it is not.

5. **Compare screenshots and traces.** Put the 3.44 Skia screenshots, the 3.47 Skia screenshots, and the 3.47 Impeller screenshots side by side. The useful comparison is 3.47 Skia vs 3.47 Impeller, because it isolates the renderer from every other change in the release. Expect text to look slightly different everywhere. Look for things that are wrong rather than different: clipped glyphs, missing shadows, jagged edges on rounded rectangles, black regions. Verify: every difference is either accepted or has a minimal repro.

6. **Decide, and if needed pin Skia in the runner.** If you found a real regression, disable Impeller in the deployed build. On Windows, in `windows/runner/main.cpp`:

   ```cpp
   // Flutter 3.47, windows/runner/main.cpp
   flutter::DartProject project(L"data");
   project.set_impeller_switch(flutter::ImpellerSwitch::Disabled);
   ```

   On Linux, in `linux/runner/my_application.cc`, before `fl_view_new(project)`:

   ```c
   // Flutter 3.47, linux/runner/my_application.cc
   g_autoptr(FlDartProject) project = fl_dart_project_new();
   fl_dart_project_set_enable_impeller(project, FALSE);
   ```

   Verify: rebuild, run, and confirm the `Using the Impeller rendering backend` line is gone.

7. **File the bug the same day.** The [Impeller docs](https://docs.flutter.dev/perf/impeller) say the opt-out will be removed in a future release, as it was on iOS. Open an issue with an `[Impeller]` title prefix, a minimal repro, the GPU and driver version, screenshots, and a zipped performance trace. Verify: the issue link is in a comment next to the opt-out line, so whoever removes it later knows why it is there.

## A per-machine kill switch for release builds

The `FLUTTER_ENGINE_SWITCHES` trick from step 4 does not work in release builds. `engine_switches.cc` wraps the whole lookup in `#ifndef FLUTTER_RELEASE`, so a shipped app ignores it. If you want to ship Impeller but keep an escape hatch for the one customer whose 2017 laptop draws a black window, read your own environment variable in the runner:

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

Support can then tell an affected user to set one variable instead of waiting for a new build. A registry value or a line in a config file next to the executable works the same way if environment variables are awkward for your users. Treat this as temporary scaffolding with the same lifespan as the engine's opt-out.

## Verification

After the migration, on every machine in your matrix:

- The app launches and the log shows `OpenGLESSDF` (or no Impeller line at all if you pinned Skia).
- Your integration tests pass. Screenshot-based ones need new baselines; regenerate them on 3.47 deliberately rather than letting a bulk "update goldens" run hide a real regression.
- The first launch after a fresh install has no shader-compilation jank in the timeline. This is the improvement you are paying for, so measure it.
- Steady-state frame times on your heaviest screen are within your budget. Impeller is not uniformly faster on every frame; it is more predictable.
- Resizing the window rapidly does not crash on Linux (a resize crash was fixed during the 3.47 cycle in [#187626](https://github.com/flutter/flutter/pull/187626), which is a good reason not to cherry-pick an older beta).

## Rollback plan

Rollback is cheap and reversible in both directions. Either downgrade to 3.44.x, which never enabled Impeller on Windows or Linux by default, or stay on 3.47 and add the runner opt-out from step 6. The second option is better: you keep every other 3.47 fix and you can flip back by deleting one line. Just do not plan on the opt-out existing forever.

## Gotchas

**Environment switches beat the project switch on Windows.** In `FlutterWindowsEngine`'s constructor the project's `ImpellerSwitch` is read first, then the loop over environment switches overwrites it. A developer with `FLUTTER_ENGINE_SWITCH_1=enable-impeller=true` left in their shell profile will see Impeller even on a branch that pinned `Disabled`. Check `env` before you debug anything else.

**`ImpellerSwitch::Default` is not `Enabled`.** If you want Impeller locked on no matter what a future release decides, set `ImpellerSwitch::Enabled` explicitly. `Default` follows the engine, which is exactly what flipped under you in 3.47.

**`flutter test` goldens do not see Impeller.** `flutter_tester_device.dart` launches the test shell with `--enable-software-rendering --skia-deterministic-rendering` unless you pass `--enable-impeller`. Your widget-test goldens keep passing after the upgrade, which tells you nothing about the desktop renderer. Only integration tests running the real `.exe` or Linux bundle exercise Impeller.

**The Linux opt-out has to happen before the view exists.** `fl_dart_project_set_enable_impeller` sets a field that `FlEngine` reads when it starts. Call it right after `fl_dart_project_new()` and before `fl_view_new(project)`, not later in `my_application_activate`.

**Hybrid-GPU laptops pick a GPU before the renderer matters.** On Windows, `DartProject::set_gpu_preference` with `flutter::GpuPreference::HighPerformancePreference` or `LowPowerPreference` decides which adapter ANGLE uses. If a regression only reproduces on a laptop with both an Intel and an NVIDIA GPU, test both preferences before blaming Impeller.

**VMs and remote sessions.** Machines without implicit MSAA support hit a black screen on Windows earlier in the 3.47 cycle; [#187288](https://github.com/flutter/flutter/pull/187288) and the offscreen MSAA fallback in [#190374](https://github.com/flutter/flutter/pull/190374) addressed it. If you see a black window in a VM, confirm you are on the latest 3.47 patch before filing a new issue.

**Custom shaders.** `FragmentProgram` shaders keep working, but they are now run by Impeller's GLES backend on whatever driver ANGLE or Mesa exposes. Re-test every `.frag` file on your oldest supported GPU, and avoid relying on precision behavior that happened to work under Skia.

**The opt-out is on a timer.** Every opt-out you add is debt with a deadline you do not control. Put the issue link next to it and revisit it on each Flutter upgrade.

## Related

- The launch-day summary of this change: [Flutter 3.47 makes Impeller the default renderer on Windows, Linux, and macOS](/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).
- Measuring the before and after: [how to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/).
- Running 3.44 and 3.47 side by side: [targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- The other desktop migration in the same release: [raising a Flutter macOS app's deployment target to macOS 12](/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/).
- The equivalent renderer decision on the web: [CanvasKit vs skwasm for Flutter web in 2026](/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/).

## Sources

- [Impeller rendering engine](https://docs.flutter.dev/perf/impeller) on docs.flutter.dev (desktop status, opt-out snippets, bug-report checklist).
- [Flutter 3.47.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0).
- [flutter/flutter#188140](https://github.com/flutter/flutter/pull/188140): makes Impeller the default renderer on Windows.
- [flutter/flutter#187573](https://github.com/flutter/flutter/pull/187573): turns Linux Impeller on by default.
- [flutter/flutter#188044](https://github.com/flutter/flutter/pull/188044): adds the Windows project switch.
- [flutter/flutter#187288](https://github.com/flutter/flutter/pull/187288): fixes the black screen on the Windows OpenGL path.
- Flutter 3.47.0 source: `engine/src/flutter/shell/platform/windows/flutter_windows_engine.cc`, `engine/src/flutter/shell/platform/linux/fl_engine.cc`, `engine/src/flutter/shell/platform/common/engine_switches.cc`, and `packages/flutter_tools/lib/src/test/flutter_tester_device.dart`.
