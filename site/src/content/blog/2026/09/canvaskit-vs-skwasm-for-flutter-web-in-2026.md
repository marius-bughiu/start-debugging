---
title: "CanvasKit vs skwasm for Flutter web in 2026: which renderer should you ship?"
description: "Ship skwasm with flutter build web --wasm when your dependencies compile to Wasm: it downloads less and rendered 36% more frames than CanvasKit on a heavy scene. On Flutter 3.47.x, keep it single-threaded until the multi-threaded text crash fix leaves beta."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "flutter"
  - "flutter-web"
  - "webassembly"
  - "performance"
---

Ship skwasm. On Flutter 3.47.4 (the current stable, Dart 3.13.3), `flutter build web --wasm` gives Chromium users a smaller download (1.65 MB vs 1.98 MB brotli for the bench app below) and 32.7 frames per second vs 24.0 for CanvasKit on a heavy scene. Firefox, Safari, and every iOS browser still get CanvasKit from the same build. Stay on a CanvasKit-only build only if a dependency still imports `dart:html` or `package:js`. One 3.47.x caveat: multi-threaded skwasm can crash on text-heavy frames, so force single-threaded mode until 3.48 reaches stable.

"Renderer" is a slightly misleading word here, because you do not choose CanvasKit or skwasm on their own. Since Flutter 3.29 removed the HTML renderer and the `--web-renderer` flag, the renderer follows from the compile target. `dart2js` output always runs on CanvasKit, and `dart2wasm` output always runs on skwasm. The tool enforces this: `flutter build web --wasm --dart-define=FLUTTER_WEB_USE_SKIA=true --dart-define=FLUTTER_WEB_USE_SKWASM=false` exits with `Do not attempt to set a web renderer when using "--wasm"`. So the real question is "JavaScript build or Wasm build", and the answer decides which Skia runs underneath.

## The feature matrix

| Property (Flutter 3.47.4)          | CanvasKit                                           | skwasm                                                        |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| Compile target                     | `dart2js`                                           | `dart2wasm` (needs WasmGC)                                    |
| Build command                      | `flutter build web`                                 | `flutter build web --wasm` (also emits the CanvasKit build)   |
| Browsers that load it by default   | All                                                 | Blink only (Chrome, Edge, Opera, Chrome on Android)          |
| Engine download, brotli            | 1.54 MB (Chromium variant), 2.26 MB (full variant)  | 1.21 MB (`skwasm.wasm`), 1.86 MB (`skwasm_heavy.wasm`)        |
| Rasterizes on                      | Main thread                                         | A Web Worker when the page is cross-origin isolated           |
| Headers needed for best mode       | None                                                | `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` |
| `dart:html`, `package:js` in graph | Fine                                                | Compile error                                                 |
| `flutter run -d chrome` debugging  | Full DevTools, stateful hot reload (DDC)            | No service protocol, hot reload is a restart                  |
| Deferred loading                   | Yes                                                 | Off by default, experimental flag slated for 3.50             |
| Known stable-channel issue         | None blocking                                       | Multi-threaded crash on text churn, #190039                   |

Two rows need a note. The "Blink only" row is not about WasmGC support: Firefox and Safari both validate WasmGC today. Flutter's loader keeps them off skwasm with a hardcoded allowlist in `browser_environment.js` (`blink: true, gecko: false, webkit: false`). The reason is that multi-threaded skwasm hands frames from the worker to the page with `OffscreenCanvas.transferToImageBitmap`, which is slow in both engines. The tracking bugs, [Mozilla 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206) and [WebKit 267291](https://bugs.webkit.org/show_bug.cgi?id=267291), were both still `NEW` in September 2026.

The debugging row comes straight from `resident_web_runner.dart` at 3.47.4: `supportsServiceProtocol` is `!debuggingOptions.webUseWasm && isRunningDebug && ...`, and `reloadIsRestart` returns `true` whenever `webUseWasm` is set. Day-to-day development therefore stays on the JavaScript path even for teams that ship Wasm.

## What each build actually downloads

A `--wasm` build writes both pipelines into `build/web`, and `flutter_bootstrap.js` carries a `buildConfig` listing them in priority order:

```jsonc
// flutter build web --wasm, Flutter 3.47.4
"builds": [
  {"compileTarget": "dart2wasm", "renderer": "skwasm", "mainWasmPath": "main.dart.wasm", "jsSupportRuntimePath": "main.dart.mjs"},
  {"compileTarget": "dart2js", "renderer": "canvaskit", "mainJsPath": "main.dart.js"}
]
```

The loader takes the first compatible entry. Within each renderer it then picks a variant from the browser's features. `canvaskit_loader.js` loads `canvaskit/chromium/canvaskit.wasm` when the browser has both `ImageDecoder` and `Intl.v8BreakIterator`. That variant leaves image codecs and ICU data to the browser, and Flutter 3.47.0 dropped the remaining codecs from it ([#178133](https://github.com/flutter/flutter/pull/178133)). Everything else gets the full `canvaskit.wasm`. `skwasm_loader.js` has the same split: `skwasm.wasm` on Chromium, and the larger `skwasm_heavy.wasm` anywhere those two APIs are missing. In practice you only see `skwasm_heavy` if you override the allowlist to put Firefox or Safari on Wasm.

I measured what a first visit costs on each path, using the release build of the benchmark app described below (a Material app of about 180 lines). Sizes are `brotli -q 11` and `gzip -9` of the files each path fetches. `flutter.js`, `flutter_bootstrap.js`, fonts, and assets are the same on every path, so they are left out:

| Path (Flutter 3.47.4)       | App code                              | Renderer JS + Wasm | Total brotli | Total gzip |
| --------------------------- | ------------------------------------- | ------------------ | ------------ | ---------- |
| CanvasKit, Chromium variant | `main.dart.js` 413 KB                 | 1,564 KB           | **1,977 KB** | 2,612 KB   |
| CanvasKit, full variant     | `main.dart.js` 413 KB                 | 2,281 KB           | **2,695 KB** | 3,465 KB   |
| skwasm                      | `main.dart.wasm` 416 KB + `.mjs` 6 KB | 1,225 KB           | **1,647 KB** | 2,083 KB   |

The app code is a wash at this size: 1.42 MB of raw Wasm and 1.79 MB of raw minified JavaScript compress to almost the same brotli size. The saving comes from the engine, since `skwasm.wasm` is about 330 KB smaller than the Chromium CanvasKit. One caveat for large apps: `dart2wasm` does not split deferred imports by default, so an app that relies on `deferred as` to keep its first load small can see the Wasm path lose that advantage.

## The benchmark

Download size is only half of the story. The other half is frame time, so I rendered the same scenes with every configuration.

**Environment.** Apple M4, 16 GB RAM, macOS 26. Google Chrome 153.0.8010.48 launched with `--headless=new --use-angle=metal` (WebGL reported `ANGLE Metal Renderer: Apple M4`), a 1280x800 window at DPR 1, and a fresh profile per run. The app was built in release mode with Flutter 3.47.4 and with 3.48.0-0.5.pre, using `flutter build web --wasm --no-web-resources-cdn`, and served from localhost with `Cache-Control: no-store`. One port sent `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, and one sent neither.

**Methodology.** A single `--wasm` build served every configuration. A custom `flutter_bootstrap.js` read the renderer from the query string, so CanvasKit runs used the exact same `main.dart.js` fallback that real Firefox users download:

```js
// web/flutter_bootstrap.js, Flutter 3.47.4
{{flutter_js}}
{{flutter_build_config}}
const q = new URLSearchParams(location.search);
const config = {suppressMultithreadingWarning: true};
if (q.get('renderer')) config.renderer = q.get('renderer');   // 'skwasm' or 'canvaskit'
if (q.get('st')) config.forceSingleThreadedSkwasm = true;
if (q.get('variant')) config.canvasKitVariant = q.get('variant'); // 'full' to skip the Chromium variant
_flutter.loader.load({config});
```

Inside the app, `SchedulerBinding.instance.addTimingsCallback` collected `FrameTiming`s for 10 seconds after a 3-second warm-up. On the web these are recorded by the engine's `FrameTimingRecorder` around each rasterizer `draw` call. "Presented fps" is the number of timings (frames that finished rasterizing) per second, and every cell is the median of 3 runs (5 for multi-threaded skwasm on 3.48). On 3.48.0-0.5.pre, CanvasKit (24.0 fps) and single-threaded skwasm (32.3 fps) landed within 2% of their 3.47.4 numbers, so the tables show 3.47.4 wherever it ran cleanly. The "tiles" scene is 600 rotating `Container`s with a gradient, rounded corners, a `BoxShadow`, and a `Text` whose content changes every frame. The "paths" scene is a `CustomPainter` stroking 400 animated 40-segment paths.

**Tiles scene (heavy):**

| Configuration                          | Presented fps | Build p50 | Raster p50 | Frame span p90 | First frame |
| -------------------------------------- | ------------- | --------- | ---------- | -------------- | ----------- |
| CanvasKit, Chromium variant (3.47.4)   | 24.0          | 24.2 ms   | 17.1 ms    | 44.0 ms        | 285 ms      |
| CanvasKit, full variant (3.47.4)       | 24.3          | 23.7 ms   | 17.2 ms    | 42.9 ms        | 286 ms      |
| skwasm, single-threaded (3.47.4)       | **32.7**      | 13.6 ms   | 16.0 ms    | 31.4 ms        | 193 ms      |
| skwasm, multi-threaded (3.47.4)        | stalled       | n/a       | n/a        | n/a            | 245 ms      |
| skwasm, multi-threaded (3.48.0-0.5.pre) | **39.3**     | 14.7 ms   | 22.5 ms    | 48.0 ms        | 238 ms      |

**Paths scene (light):**

| Configuration (3.47.4)      | Presented fps | Build p50 | Raster p50 |
| --------------------------- | ------------- | --------- | ---------- |
| CanvasKit, Chromium variant | 60.4          | 3.3 ms    | 3.0 ms     |
| skwasm, single-threaded     | 60.0          | 1.2 ms    | 3.9 ms     |
| skwasm, multi-threaded      | 59.9          | 1.1 ms    | 4.1 ms     |

Four things stand out:

1. **Most of the win is `dart2wasm`, not Skia.** Rasterization time is almost identical (17.1 ms vs 16.0 ms on tiles, and CanvasKit is actually faster on paths). The build phase, meaning your Dart widget, layout, and paint code, runs roughly twice as fast when compiled to WasmGC. The more framework work per frame, the bigger the gap.
2. **Multi-threading trades latency for throughput.** On 3.48 beta the multi-threaded build presented 22% more frames than the single-threaded one (39.3 vs 32.3 fps), while its raster p50 went up to 22.5 ms. The UI thread builds the next frame while the worker still rasterizes the previous one. `Renderer.renderScene` keeps only the newest pending scene and drops the rest. The result is more frames overall and a longer span per frame.
3. **Light scenes cap at vsync either way.** If your app is forms and lists, you will not see the renderer difference in frame rate. You will see the download and startup difference.
4. **First frame on localhost favors single-threaded skwasm by about 90 ms** (193 ms vs 285 ms; spinning up the render worker gives some of that back in multi-threaded mode). With the network taken out, that gap is compile and instantiation cost. On a real connection, the 330 KB brotli difference adds to it.

Treat the absolute numbers as specific to an M4 running Metal. The ratios are what transfer.

## When to pick skwasm

- **Your audience is mostly desktop Chrome or Edge, or Chrome on Android.** Those are the users who actually receive the Wasm build, and they get the smaller download and faster build phase for free. Everyone else transparently falls back to CanvasKit.
- **Your frames are framework-heavy.** Dashboards, data grids, and animated lists spend their time in build and layout, which is exactly where `dart2wasm` pulled ahead in the benchmark.
- **You control the response headers.** Multi-threaded mode needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` (or `require-corp`). Without them skwasm still works, single-threaded, and logs a warning you can silence with `suppressMultithreadingWarning: true`.
- **Your whole dependency graph is on `package:web` and `dart:js_interop`.** Plain `flutter build web` runs a Wasm dry run on every build and prints "Wasm dry run succeeded" or the offending imports, so you already know.

## When to pick CanvasKit

- **A dependency still imports `dart:html`, `dart:js`, or `package:js`.** `dart2wasm` refuses to compile it, so the choice is made for you until that package migrates.
- **Most of your traffic is iOS or Safari.** Those users get CanvasKit from a `--wasm` build anyway. The Wasm build only adds build time and a second pipeline to test, with no benefit for them.
- **You embed cross-origin content and cannot adopt COEP.** Third-party iframes, ad scripts, or images without CORS headers can break under `require-corp`, and `credentialless` strips cookies from those requests. Single-threaded skwasm needs no headers, but you lose the throughput gain.
- **You need deferred loading for first-load size.** Until Wasm deferred loading leaves its experimental flag, a JavaScript build with `deferred as` imports can start smaller than a monolithic `main.dart.wasm`.

## The gotcha that picks for you on 3.47.x

In the tiles scene, multi-threaded skwasm on Flutter 3.47.4 stalled in 6 of 7 runs. In four of them, `requestAnimationFrame` kept firing and the framework kept building at 60 fps, but no `FrameTiming`s arrived after the first frames, so nothing new reached the screen. In the other two, the page stopped running Dart timers entirely. Chrome's console showed `Uncaught RuntimeError: null function` and `table index is out of bounds` from `skwasm.wasm` in some runs, and nothing at all in others. The same scene single-threaded, and the text-free paths scene multi-threaded, ran cleanly every time.

That matches [flutter/flutter#190039](https://github.com/flutter/flutter/issues/190039). Per the fix's description, multi-threaded skwasm is built with `-sWASM_WORKERS` but without `-pthread`, so it links emscripten's single-threaded system libraries, where mutexes are no-ops. Text layout on the main thread and the raster worker then share Skia's global `SkStrikeCache` and corrupt the heap when text changes every frame. The fix, [PR #190048](https://github.com/flutter/flutter/pull/190048) ("Use thread local strike caches in skwasm"), merged on 2026-08-05 and is part of 3.48.0-0.5.pre. With the same app rebuilt on that beta, 5 of 5 runs were stable with no `RuntimeError`. A stable cherry-pick request ([#192115](https://github.com/flutter/flutter/pull/192115)) was closed without merging on 2026-09-01, and no 3.47.x release through 3.47.4 carries the fix.

Until you are on 3.48 stable, keep the Wasm build and turn threading off in `web/flutter_bootstrap.js`:

```js
// web/flutter_bootstrap.js, Flutter 3.47.x: avoid #190039
{{flutter_js}}
{{flutter_build_config}}
_flutter.loader.load({
  config: {
    forceSingleThreadedSkwasm: true,
    suppressMultithreadingWarning: true,
  },
});
```

Single-threaded skwasm still beat CanvasKit by 36% in presented frames, so this costs you the multi-threading bonus, not the Wasm win. Leaving out the COOP/COEP headers has the same effect, but the config flag is easier to revert later.

Two escape hatches in the same config are worth knowing. `renderer: 'canvaskit'` makes the loader skip the Wasm entry and load the `dart2js` build. In my runs on 3.47.4 that worked from a `--wasm` build and reported `dart.tool.dart2wasm == false`, so a query-string switch like the one above gives you a production kill switch. And `verboseBuildSelection: true` (new in 3.47.0) logs why each candidate build was skipped, which is the fastest way to answer "why is this user on CanvasKit".

## The recommendation, restated

Build with `flutter build web --wasm` and let the loader hand skwasm to Chromium and CanvasKit to everyone else. On 3.47.x, add `forceSingleThreadedSkwasm: true` and remove it when you move to 3.48 stable with COOP/COEP headers in place. Fall back to a plain CanvasKit build only when a dependency blocks `dart2wasm`. The engines rasterize at about the same speed. What you are really choosing is `dart2wasm` for your own Dart code, and in 2026 that is the faster and smaller option wherever the browser allows it.

## Related

- [How to build a Flutter web app with WebAssembly](/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) walks through the `--wasm` build end to end, including how to prove which build a browser loaded.
- [Migrating a Flutter web app from `dart:html` to `package:web`](/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/) is the prerequisite if the Wasm dry run flags your code.
- [Fix: Flutter web serves a stale cached build after reload](/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) covers the `Cache-Control` headers that live next to COOP/COEP in the same host config.
- [Flutter 3.47 makes Impeller the default renderer on desktop](/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) covers the other renderer switch in the same release.

## Sources

- [Support for WebAssembly (Wasm)](https://docs.flutter.dev/platform-integration/web/wasm): browser support, required headers, deferred loading flag.
- [Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization): `canvasKitVariant`, `forceSingleThreadedSkwasm`, and the other loader config options.
- Loader and engine source at 3.47.4: [`browser_environment.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js), [`loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/loader.js), [`skwasm_loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/skwasm_loader.js), [`canvaskit_loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/canvaskit_loader.js).
- Tool source at 3.47.4: [`build_web.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/commands/build_web.dart), [`compile.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/web/compile.dart), [`resident_web_runner.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/isolated/resident_web_runner.dart).
- [flutter/flutter#190039](https://github.com/flutter/flutter/issues/190039), [PR #190048](https://github.com/flutter/flutter/pull/190048), and [PR #192115](https://github.com/flutter/flutter/pull/192115): the multi-threaded skwasm crash, its fix, and the closed stable cherry-pick.
- [Flutter 3.47.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0): `verboseBuildSelection`, CanvasKit Chromium variant codec removal.
- [PR #159314](https://github.com/flutter/flutter/pull/159314): removal of the `--web-renderer` flag.
- [Mozilla bug 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206) and [WebKit bug 267291](https://bugs.webkit.org/show_bug.cgi?id=267291): why Firefox and Safari are not on the Wasm allowlist.
