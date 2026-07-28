---
title: "How to build a Flutter web app with WebAssembly using flutter build web --wasm"
description: "A complete guide to shipping a Flutter web app compiled to WebAssembly on Flutter 3.44: what the two emitted builds look like, why Firefox and Safari still get JavaScript because of the loader's wasmAllowList, migrating off dart:html for dart2wasm, the COOP/COEP headers that decide whether skwasm runs multi-threaded, and how to prove at runtime which build the browser actually loaded."
pubDate: 2026-07-28
template: how-to
tags:
  - "flutter"
  - "dart"
  - "webassembly"
  - "flutter-web"
  - "performance"
  - "how-to"
---

To build a Flutter web app with WebAssembly, add the `--wasm` flag: `flutter build web --wasm`. That single flag makes the tool emit *two* builds into `build/web`: a WasmGC build compiled by `dart2wasm` that uses the `skwasm` renderer, and the ordinary `dart2js` build that uses `canvaskit` as a fallback. A generated `flutter_bootstrap.js` picks one at page load. Two things then decide whether real users get the Wasm build: nothing in your dependency graph may import `dart:html`, `dart:js`, `dart:js_util`, or `package:js`, and your server must send `Cross-Origin-Opener-Policy: same-origin` plus `Cross-Origin-Embedder-Policy: credentialless` or `skwasm` silently drops to a single thread. This post targets Flutter 3.44 stable (released 2026-05-18, ships Dart 3.10) and every detail below is checked against the `stable` branch of `flutter/flutter`. The important caveat up front: as of 3.44 the loader only enables the Wasm build on Blink browsers, so Firefox, Safari, and every browser on iOS get the JavaScript build no matter what you compile.

## What `--wasm` actually puts in build/web

The mental model most people have is wrong in a useful way. `--wasm` does not switch your build from JavaScript to WebAssembly. It *adds* a WebAssembly build alongside the JavaScript one. In `packages/flutter_tools/lib/src/commands/build_web.dart`, passing the flag produces a two-element list of compiler configs, a `WasmCompilerConfig` and a `JsCompilerConfig`, and the tool runs both compilers. Without the flag you get one real `JsCompilerConfig` plus a `WasmCompilerConfig` marked `dryRun: true`, which compiles but throws the output away (more on that in a moment).

Each compiled target contributes a build description to a generated `flutter_bootstrap.js`. After `flutter build web --wasm` on Flutter 3.44, the descriptor looks like this:

```javascript
// Excerpt from build/web/flutter_bootstrap.js, Flutter 3.44 stable
if (!window._flutter) {
  window._flutter = {};
}
_flutter.buildConfig = {
  "engineRevision": "...",
  "builds": [
    {
      "compileTarget": "dart2wasm",
      "renderer": "skwasm",
      "mainWasmPath": "main.dart.wasm",
      "jsSupportRuntimePath": "main.dart.mjs"
    },
    {
      "compileTarget": "dart2js",
      "renderer": "canvaskit",
      "mainJsPath": "main.dart.js"
    }
  ]
};
```

Order matters: `FlutterLoader.load()` calls `buildConfig.builds.find(buildIsCompatible)` and takes the *first* compatible entry, so the Wasm build wins whenever the environment allows it. The renderer pairing is not configurable. `WebRendererMode.defaultForWasm` is `skwasm` and `defaultForJs` is `canvaskit`, and the tool refuses to let you mix them, which is the first gotcha below.

On disk you get `main.dart.wasm` (the module), `main.dart.mjs` (the JS support runtime that instantiates it), and `main.dart.js` (the fallback), plus the renderer payloads: `skwasm.js` and `skwasm.wasm` for the Wasm path, and the CanvasKit bundle for the fallback path.

## The five steps that actually matter

1. **Get on Flutter 3.24 or later.** Wasm compilation landed in stable in 3.24; 3.44 is what I tested here. If you juggle SDK versions per project, my notes on [running one Flutter project against several SDK versions in CI](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) apply unchanged to Wasm builds.
2. **Regenerate `web/index.html` if it predates Flutter 3.22.** The Wasm path depends entirely on the `flutter_bootstrap.js` loader, so the old `serviceWorkerVersion` bootstrap will not work. `flutter create . --platforms web` after deleting `web/` gives you the current template.
3. **Clear the `dart2wasm` incompatibilities out of your dependency graph.** Run `flutter build web` without `--wasm` first and read the dry-run findings.
4. **Build it:** `flutter build web --wasm`.
5. **Serve it with cross-origin isolation headers.** Without them the app still runs, but single-threaded, which throws away most of the reason to use Wasm.

## Why your app still runs JavaScript in Firefox and Safari

This is the part that surprises people, and the official Wasm support page is stale enough (its `last-update` front matter reads Nov 6, 2024) that reading it does not explain the current behaviour. WasmGC itself is no longer the constraint: it reached Baseline across Chrome 119, Firefox 120, and Safari 18.2. The constraint is a hard-coded allowlist in the engine's loader.

`engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js` on `stable` contains exactly this:

```javascript
// engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js
export const defaultWasmSupport = {
  "blink": true,
  "gecko": false,
  "webkit": false,
  "unknown": false,
}
```

And `loader.js` gates the `skwasm` build on it:

```javascript
// engine/src/flutter/lib/web_ui/flutter_js/src/loader.js
const supportsDart2Wasm = browserEnvironment.supportsWasmGC;
const supportsSkwasm = supportsDart2Wasm && browserEnvironment.webGLVersion > 0;

const enableWasm = config.wasmAllowList?.[browserEnvironment.browserEngine]
  ?? defaultWasmSupport[browserEnvironment.browserEngine];
```

So on Firefox, `supportsWasmGC()` returns `true` (the detector validates a tiny WasmGC module and Firefox passes), but `enableWasm` resolves to `false` from the `gecko` entry, the `skwasm` build is rejected as incompatible, and the loader falls through to `dart2js` + `canvaskit`. Same story for Safari via `webkit`. The reason is not WasmGC but the renderer: Flutter's multi-threaded `skwasm` leans on `OffscreenCanvas.transferToImageBitmap`, and the Firefox bug (Bugzilla 1788206) and WebKit bug (267291) tracking its cost were both still open when I checked in July 2026.

You can override the allowlist yourself, which is worth doing behind a query parameter if you want real numbers rather than opinions:

```javascript
// web/flutter_bootstrap.js, Flutter 3.44
{{flutter_js}}
{{flutter_build_config}}

const params = new URLSearchParams(window.location.search);
_flutter.loader.load({
  config: {
    // Only opt gecko/webkit in deliberately. Expect rendering artifacts.
    wasmAllowList: params.has('force_wasm')
      ? { blink: true, gecko: true, webkit: true, unknown: false }
      : undefined,
  },
});
```

Do not ship that to production on a hunch. Measure it first with the workflow in [profiling jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/), because on the affected engines the failure mode is degraded frame times, not a clean error.

One limit has no override at all: every browser on iOS is required to use WebKit, so a Flutter app compiled to Wasm cannot run on iOS Safari, iOS Chrome, or anything else on that platform.

## Getting your dependencies to compile

`dart2wasm` supports only Dart's static JS interop. Any transitive import of `dart:html`, `dart:js`, `dart:js_util`, or `package:js` fails the compile with messages like these:

```output
Dart library 'dart:html' is not available on this platform.
JS interop library 'dart:js_util' can't be imported when compiling to Wasm.
Try using 'dart:js_interop' or 'dart:js_interop_unsafe' instead.
```

The good news is you do not have to discover this by trying. `--wasm-dry-run` defaults to `true`, so a plain `flutter build web` already runs `dart2wasm` in dry-run mode and reports what it found:

```output
Wasm dry run findings:
...
Consider addressing these issues to enable wasm builds. See docs for more info:
https://docs.flutter.dev/platform-integration/web/wasm
```

If your app is already clean, the same mechanism nudges you the other way with `Wasm dry run succeeded. Consider building and testing your application with the --wasm flag.` Either way, `flutter build web --no-wasm-dry-run` suppresses it once you have made your decision.

For code you own, the migration is `package:web` in place of `dart:html` and `dart:js_interop` in place of `package:js`:

```dart
// Dart 3.10, Flutter 3.44 -- wasm-compatible
import 'dart:js_interop';
import 'package:web/web.dart' as web;

@JS('navigator.clipboard.writeText')
external JSPromise<JSAny?> _writeText(String text);

Future<void> copy(String text) async {
  await _writeText(text).toDart;
  web.document.querySelector('#status')?.textContent = 'Copied';
}
```

Three differences bite during the migration. Names follow the browser IDL, so `HtmlElement` becomes `HTMLElement` and `innerHtml` becomes `innerHTML`. `querySelectorAll` returns a non-`List` iterable. And because interop types are extension types, `is` and `as` do not do what you expect; use `isA<T>()` instead. Conditional imports also need updating: the guard is now `dart.library.js_interop`, not `dart.library.html`. If you are hand-rolling interop rather than pulling a plugin, the patterns in [adding platform-specific code in Flutter without plugins](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) carry over directly.

For code you do not own, filter pub.dev by `is:wasm-ready`. When a dependency is the blocker, upgrading it is often the whole fix, and the usual constraint-solving pain applies; if you land in resolver hell, [Fix: Version solving failed in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/) covers the way out.

## COOP and COEP decide whether you get threads

Flutter compiles `skwasm` with shared memory. You can see it in the compile invocation in `build_system/targets/web.dart`, which appends `--import-shared-memory` and `--shared-memory-max-pages=32768` for the `skwasm` renderer. Shared memory in a browser requires cross-origin isolation, which requires two response headers. The tool hard-codes the pair it wants:

```dart
// packages/flutter_tools/lib/src/web/web_constants.dart, Flutter 3.44
const kCrossOriginIsolationHeaders = <String, String>{
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};
```

`flutter run -d chrome --wasm` sets these on its own dev server, which is exactly why the problem never shows up locally and then shows up in production. There is no error when they are missing. `skwasm_loader.js` computes `skwasmSingleThreaded: ... || !browserEnvironment.crossOriginIsolated || ...` and quietly starts a single-threaded engine.

For nginx:

```nginx
# nginx, serving build/web
location / {
    add_header Cross-Origin-Opener-Policy   same-origin   always;
    add_header Cross-Origin-Embedder-Policy credentialless always;
    try_files $uri $uri/ /index.html;
}
```

For Firebase Hosting:

```json
{
  "hosting": {
    "public": "build/web",
    "headers": [
      {
        "source": "**",
        "headers": [
          { "key": "Cross-Origin-Opener-Policy",   "value": "same-origin" },
          { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" }
        ]
      }
    ]
  }
}
```

Verify in the browser console with `window.crossOriginIsolated`, which must be `true`. Note that GitHub Pages cannot send custom headers at all, so a Wasm build hosted there will always run single-threaded.

Cross-origin isolation is not free. `require-corp` breaks any cross-origin subresource that does not opt in with `Cross-Origin-Resource-Policy`, which in practice means third-party images, fonts, analytics beacons, and embedded iframes. `credentialless` is the softer of the two: it loads cross-origin subresources without credentials instead of blocking them. Start with `credentialless`, then audit the network panel for requests that lost their cookies.

## Proving which build the browser loaded

Do not infer this from a stopwatch. The compiler sets an environment variable you can read:

```dart
// Flutter 3.44, Dart 3.10
const isRunningWithWasm = bool.fromEnvironment('dart.tool.dart2wasm');
```

There is also a behavioural probe that works without a rebuild, based on Wasm using the native number representation:

```dart
final isRunningWithWasm = identical(double.nan, double.nan);
```

The network panel is the third check: a `main.dart.wasm` request means the Wasm build, `main.dart.js` means the fallback.

## Gotchas worth knowing before you ship

**Setting a renderer with `--wasm` is a hard error.** `build_web.dart` calls `throwToolExit('Do not attempt to set a web renderer when using "--wasm"')` when the resolved renderer is not `skwasm`. So `--wasm` combined with `--dart-define=FLUTTER_WEB_USE_SKIA=true` fails at the CLI, by design.

**`config.renderer: 'canvaskit'` in a Wasm build fails at runtime.** `buildIsCompatible` rejects any build whose `renderer` does not equal the configured value, and a `--wasm` build contains no `dart2wasm` + `canvaskit` entry. Every candidate gets filtered out and the loader throws `FlutterLoader could not find a build compatible with configuration and environment.` This is tracked as flutter/flutter#183265. Remove the `renderer` key, or set it to `skwasm`.

**Non-Chromium engines load a heavier renderer payload.** `loadSkwasm` picks `skwasm_heavy` instead of `skwasm` when the browser lacks `ImageDecoder` or Chromium's break iterators, so if you do force the allowlist open, you also pay a larger download.

**Chrome extensions are forced single-threaded.** The loader detects `chrome.runtime.id` and disables threading, because extension CSP blocks the dynamic script loading that the workers need.

**Symbol names are stripped by default.** `--strip-wasm` defaults to `true`. Pass `--no-strip-wasm` when you need readable stack traces from a profile build, and `--source-maps` to emit `main.dart.wasm.map`.

**Wasm does not fix SEO.** Both builds paint to a canvas, so crawlers still see almost no semantic HTML. Wasm makes a Flutter web app faster; it does not make it a document.

**The tool still calls this new.** `flutter build web --wasm` prints a box reading `WebAssembly compilation is new. Understand the details before deploying to production.` Treat that as accurate rather than boilerplate: pin your Flutter version, and keep the JavaScript fallback path in your test matrix, because on today's allowlist that is the path most of your users are on.

## Related

- [How to profile jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)
- [How to add platform-specific code in Flutter without plugins](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Fix: Version solving failed in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Migrate a Flutter 2 app to Flutter 3.x: the null safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)

## Sources

- Flutter docs, [Support for WebAssembly (Wasm)](https://docs.flutter.dev/platform-integration/web/wasm)
- Flutter docs, [Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization)
- Flutter docs, [Build and release a web app](https://docs.flutter.dev/deployment/web)
- Flutter source, [`packages/flutter_tools/lib/src/commands/build_web.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/build_web.dart)
- Flutter source, [`engine/src/flutter/lib/web_ui/flutter_js/src/loader.js`](https://github.com/flutter/flutter/blob/stable/engine/src/flutter/lib/web_ui/flutter_js/src/loader.js) and [`browser_environment.js`](https://github.com/flutter/flutter/blob/stable/engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js)
- Flutter issue [#183265, FlutterLoader could not find a build compatible with configuration and environment](https://github.com/flutter/flutter/issues/183265)
- Dart docs, [Migrate to package:web](https://dart.dev/interop/js-interop/package-web) and [WebAssembly (Wasm) compilation](https://dart.dev/web/wasm)
- web.dev, [WasmGC and Wasm tail call optimizations are now Baseline Newly available](https://web.dev/blog/wasmgc-wasm-tail-call-optimizations-baseline)
- Chrome for Developers, [COEP: credentialless](https://developer.chrome.com/blog/coep-credentialless-origin-trial)
