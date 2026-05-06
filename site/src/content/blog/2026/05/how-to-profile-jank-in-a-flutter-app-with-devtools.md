---
title: "How to profile jank in a Flutter app with DevTools"
description: "Step-by-step guide to finding and fixing jank in Flutter 3.27 with DevTools: profile mode, the Performance overlay, the Frame Analysis tab, the CPU Profiler, raster vs UI thread, shader warm-up, and Impeller-specific gotchas. Tested on Flutter 3.27.1, Dart 3.11, DevTools 2.40."
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "devtools"
  - "performance"
  - "jank"
  - "how-to"
---

Short answer: build with `flutter run --profile` (never debug), open DevTools, switch to the Performance tab, reproduce the jank, then read the Frame Analysis chart. Frames over the budget (16.67 ms at 60 Hz, 8.33 ms at 120 Hz) are colored. If the over-budget bar is red on the UI thread, jump into the CPU Profiler and look at your Dart code; if it is red on the raster thread, the GPU is the bottleneck and the fix is usually shader warm-up, smaller images, or fewer expensive effects. This guide walks through each of those decisions on Flutter 3.27.1, Dart 3.11, and DevTools 2.40.

## Why you cannot profile jank in debug mode

Debug builds are slow on purpose. They run unoptimized JIT code, ship every assertion, and skip the AOT pipeline. The framework itself even prints `"This is a debug build"` over the app to remind you. Numbers you collect in debug mode are usually 2x to 10x worse than release, so any jank you "find" there might not exist in production at all. Worse, you can also miss real jank because debug runs at a lower default frame rate on some Android devices.

Always profile with `flutter run --profile` against a real device. The simulator and the iOS Simulator do not represent real GPU behavior, especially for shader compilation. Profile mode keeps DevTools hooks (timeline events, allocation tracking, observatory) but compiles your Dart with the AOT pipeline, so the numbers you see are within a few percent of release. The [Flutter docs on app performance](https://docs.flutter.dev/perf/ui-performance) are explicit about this.

```bash
# Flutter 3.27.1
flutter run --profile -d <your-device-id>
```

If the device is plugged in over USB, you can also use `--profile --trace-startup` to capture a startup timeline file at `build/start_up_info.json`, useful for measuring cold-start jank specifically.

## Open DevTools and pick the right tab

Once `flutter run --profile` is up, the console prints a DevTools URL like `http://127.0.0.1:9100/?uri=...`. Open it in Chrome. The relevant tabs for jank are, in order:

1. **Performance**: frame timeline, Frame Analysis, raster cache, enhance tracing toggles.
2. **CPU Profiler**: sampling profiler with bottom-up, top-down, and call tree views.
3. **Memory**: allocation tracking and GC events. Useful if jank correlates with GC.
4. **Inspector**: widget tree. Useful to confirm a rebuild storm.

The "Performance overlay" you can also toggle from inside the running app (`P` in the terminal, or `WidgetsApp.showPerformanceOverlay = true` in code) is a smaller version of the same data drawn on top of your UI. It is great for spotting jank in real time on a device, but you cannot drill into a specific frame from there. Use the overlay to find a janky scenario, then capture it in DevTools.

## Reading the Frame Analysis chart

In Performance, the top chart shows a bar per rendered frame. Each bar has two segments stacked horizontally: the lower segment is the UI thread (your Dart `build`, `layout`, `paint` walk), the upper segment is the raster thread (where the engine rasterizes the layer tree on the GPU). If either segment exceeds the frame budget, the bar turns red.

The frame budget is `1000 ms / refresh_rate`. On a 60 Hz device that is 16.67 ms total, but you do not get to spend 16.67 ms on each thread. A frame is only on time if both UI and raster finish within their budgets, which roughly means under 8 ms each in practice (the remaining time is engine overhead and vsync alignment). On a 120 Hz device, halve everything.

Click a red frame and the lower panel switches to "Frame Analysis". This is the single most useful view in DevTools 2.40. It shows:

- The timeline events for that one frame.
- Whether the dominant cost is `Build`, `Layout`, `Paint`, or `Raster`.
- Whether shader compilation, image decoding, or platform channel calls were involved.
- A textual hint like "This frame's UI work was dominated by a single Build phase" so you do not have to guess.

If the hint says the UI thread was the problem, your fix lives in your Dart code. If it points at the raster thread, the fix lives in your widget tree shape, your shaders, your images, or your effects.

## When the UI thread is the bottleneck

UI-thread jank is your code running too long inside one frame. The biggest sources are:

- A `build` method that does real work (parsing JSON, walking a 10k-element list, regex on a long string).
- A `setState` that rebuilds a much larger subtree than necessary.
- A synchronous `File.readAsStringSync` or any blocking I/O.
- A heavy `Listenable` change that fans out to many listeners.

Drop into the CPU Profiler tab while the janky interaction is happening. Set "Profile granularity" to "high" for short bursts and start recording. Stop recording after the janky frames. The bottom-up view ("Heaviest frames at the top") usually identifies the culprit in seconds.

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

The fix is to move the work off the UI thread, either with a one-shot `compute(...)` call or, for repeated CPU-bound work, a long-lived isolate. There is a full walkthrough of both in [the dedicated guide on writing a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/).

A more subtle UI-thread cost is rebuilding too much. Wrap the part that actually changes in a small widget so its `build` is the only one that runs on `setState`. The Inspector's "Highlight Repaints" toggle (under Performance > More options) draws a colored border around every layer that repaints, which is the fastest way to spot a `Container` near the root rebuilding the whole screen.

## When the raster thread is the bottleneck

Raster-thread jank means the engine is doing too much GPU work for the layer tree your widgets produced. The fix is rarely "use a faster phone". The fix is usually one of:

1. **Shader compilation jank**: first-time effects (page transitions, gradients, blurs, custom painters) compile shaders mid-frame, which spikes raster time. Visible as one or two extreme frames the first time a screen opens.
2. **Off-screen layers**: `Opacity`, `ShaderMask`, `BackdropFilter`, and `ClipRRect` with `antiAlias: true` can force the engine to render a subtree to a texture and composite it. This is fine for one element, expensive for a list of them.
3. **Oversized images**: a 4k JPEG decoded into an `Image.asset` covers your phone screen with way more pixels than you can see. Use `cacheWidth` / `cacheHeight` to downsample at decode time.
4. **`saveLayer` calls**: a tell-tale pattern in the engine timeline. `saveLayer` is what `Opacity` uses internally. Replacing `Opacity(opacity: 0.5, child: ...)` with an `AnimatedOpacity` or a child that paints with the alpha pre-baked will avoid it.

DevTools 2.40 surfaces these directly. In Performance > "Enhance Tracing", turn on "Track widget builds", "Track layouts", and "Track paints" to get more detail in the timeline. Frame Analysis also lights up a "Raster cache" panel: if it shows a high "raster cache hits / misses" ratio, the engine is failing to cache layers it could be caching.

## Shader warm-up on Impeller and Skia

This is the single most-asked question about Flutter performance: "the first time I open this screen, it stutters". The cause is shader compilation. The fix differs based on the rendering backend.

Impeller is the engine's modern renderer. As of Flutter 3.27, Impeller is on by default for iOS and is the default on Android (with Skia available as a fallback for older devices). Impeller compiles all shaders ahead of time, so on Impeller-only devices, shader compilation jank should not exist. If you still see first-frame jank on Impeller, it is image decoding or layer setup, not shaders.

On the Skia path (older Android, web, desktop), shader compilation still happens at runtime. The traditional `flutter build --bundle-sksl-path` workflow used SkSL caching, but as of Flutter 3.7 the engine deprecated that flow because Impeller made it unnecessary. If you have to ship to a Skia device today, the recommended path is:

- Render every page that uses unusual effects once during the splash screen.
- Pre-warm gradients, blurs, and animated transitions by mounting them off-screen on app start.
- Test on a low-end Android device, not a flagship.

You can confirm which renderer is active in the running app's logs (`flutter run` prints `Using the Impeller rendering backend`) or in DevTools' "Diagnostics" tab.

## A repeatable workflow that actually works

This is the loop I use, in order:

1. `flutter run --profile -d <real-device>`. Reject any jank measurement that came from the simulator.
2. Reproduce the jank. Toggle the in-app Performance overlay (`P` in the terminal) so you can see UI vs raster bars in real time. Confirm the jank is real and reproducible.
3. Open DevTools > Performance. Hit "Record" before the jank, reproduce it, hit "Stop".
4. Click the worst red frame. Read Frame Analysis. Decide UI vs raster.
5. If UI: open the CPU Profiler tab, record the same scenario, drill bottom-up into the heaviest function. Move work off the UI thread or shrink the rebuild surface.
6. If raster: turn on "Track paints" and "Highlight Repaints", look for `saveLayer`, oversized images, and shader compilation events. Replace, downsample, or pre-warm.
7. Verify the fix on the same device. Lock the budget into a benchmark so it does not regress.

For step 7, `package:flutter_driver` is deprecated since Flutter 3.13 in favor of `package:integration_test` with `IntegrationTestWidgetsFlutterBinding.framework.allReportedDurations`. The Flutter team's [performance testing guide](https://docs.flutter.dev/cookbook/testing/integration/profiling) shows how to wire it up and emit a JSON file you can compare in CI. If you run a CI matrix of Flutter SDK versions, the same harness slots into [a multi-version Flutter pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Custom timeline events for tricky cases

Sometimes the engine's events are not enough and you want to see your own code in the timeline. The `dart:developer` library exposes a sync trace API that DevTools picks up automatically:

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

Now `parseCatalog` shows up as a labeled span on the UI-thread timeline, and Frame Analysis can attribute time to it directly. Use sparingly: every `Timeline.startSync` has a small but non-zero cost, so do not wrap your hot inner loop with one. Use them at coarse boundaries (a parse, a network response handler, a controller method) where the cost is negligible compared to the work being measured.

For async work, use `Timeline.timeSync` for sync sections inside async functions, or `Timeline.startSync('name', flow: Flow.begin())` paired with `Flow.step` and `Flow.end` to draw a flow line that stitches related events across threads. The Frame Analysis panel can show this flow when a frame is selected.

## Memory pressure can look like jank

If you are seeing periodic 50 to 100 ms hiccups that show up on the UI thread but do not match any code in your call stack, the cause is often a major garbage collection. Open the Memory tab and look at the GC marker line. Frequent old-generation GCs correlate with allocating a lot of short-lived objects per frame.

The usual offenders are:

- Allocating new `TextStyle` or `Paint` objects inside `build`.
- Rebuilding immutable lists (`List.from`, `[...spread]`) every frame for `ListView`.
- Using `Future.delayed(Duration.zero, () => setState(...))` as a workaround for re-entry, which schedules a microtask each frame.

Hoist constants out of `build` (`const TextStyle(...)` at file scope is your friend) and prefer growable lists you mutate over rebuilding. The Memory tab's "Profile Memory" feature captures a heap allocation profile that pinpoints which class is producing the garbage.

## Calling native code is its own profiling problem

If your app uses platform channels (a `MethodChannel`, an `EventChannel`), Dart sees those calls as plain `Future`s but the actual work happens on a platform thread. DevTools shows the Dart-side wait but cannot see inside the native handler. If a frame is jank-y because of a slow Kotlin or Swift implementation, you have to attach a native profiler (Android Studio's CPU Profiler or Xcode Instruments) to the same process.

The other gotcha is that synchronous platform-channel calls are illegal in modern Flutter (they crash with `Synchronous platform messages are not allowed`), so any blocking is async-blocking on the Dart side. If a `MethodChannel.invokeMethod` takes 200 ms, that is 200 ms during which `await` returns and a frame can complete, but anything chained off the result will land in a later frame, which can look like skipped frames. The fix is to architect the channel so the UI never depends on a single round-trip to render. There is more nuance in [the platform channels guide](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

## Common false positives

A frame is not "janky" just because it is long. A few patterns that look like jank but are not:

- The very first frame after a hot reload. Hot reload re-resolves widgets and is intentionally not optimized. Ignore the first frame after any reload.
- A frame that runs while the app is backgrounding. The OS can pause the renderer mid-frame.
- A phantom frame during background recompilation.

When in doubt, reproduce the jank twice on a fresh `flutter run --profile` and only believe what is consistent across both runs.

## Related

- [Writing a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) covers moving heavy parsing or computation off the UI thread.
- [Adding platform-specific code in Flutter without plugins](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) goes deeper on `MethodChannel` and the threading model.
- [Targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) is the harness you want once you have a regression benchmark.
- [Migrating a Flutter app from GetX to Riverpod](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) discusses rebuild scope, which is one of the biggest UI-thread jank sources.
- [Debugging Flutter iOS from Windows: a real device workflow](/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) shows how to attach DevTools to a remote-built iOS device when you cannot run Xcode locally.

## Source links

- [Flutter app performance overview](https://docs.flutter.dev/perf/ui-performance) (docs.flutter.dev)
- [DevTools Performance view](https://docs.flutter.dev/tools/devtools/performance) (docs.flutter.dev)
- [DevTools CPU Profiler](https://docs.flutter.dev/tools/devtools/cpu-profiler) (docs.flutter.dev)
- [Profiling app performance with integration tests](https://docs.flutter.dev/cookbook/testing/integration/profiling) (docs.flutter.dev)
- [Impeller rendering engine](https://docs.flutter.dev/perf/impeller) (docs.flutter.dev)
- [`dart:developer` Timeline API](https://api.dart.dev/stable/dart-developer/Timeline-class.html) (api.dart.dev)
