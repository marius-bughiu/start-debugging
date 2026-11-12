---
title: "Flutter 3.50 Opens WebAssembly to Safari and Firefox and Adds --web-content-hash"
description: "Flutter 3.50 and Dart 3.14 shipped on November 11, 2026. On the web, Safari 26.2+ and Firefox 147+ can now run the Wasm build behind an opt-in wasmAllowList, and flutter build web gets built-in content hashing for long-lived caching."
pubDate: 2026-11-12
tags:
  - "flutter"
  - "dart"
  - "webassembly"
  - "flutter-web"
---

Flutter 3.50 reached the stable channel on November 11, 2026, together with Dart 3.14. Most of the headlines will be about the formal deprecation of `package:flutter/material.dart` and `package:flutter/cupertino.dart` in favour of the standalone `material_ui` and `cupertino_ui` packages (the import migration is covered in [migrating Flutter Material and Cupertino imports to standalone packages](/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)). For anyone shipping Flutter web, two smaller changes matter more: WebAssembly is no longer a Chromium-only story, and `flutter build web` can now fingerprint its own output.

## Wasm on WebKit and Gecko, behind an allow list

Until now, `flutter build web --wasm` produced a Wasm bundle that only Chromium browsers actually used. Everything else silently fell back to dart2js with CanvasKit. According to the [Flutter 3.50 announcement](https://flutter.dev/blog/whats-new-in-flutter-3-50), Chrome and Edge 137+ keep running Wasm by default, while Safari 26.2+ (macOS and iOS) and Firefox 147+ are now supported but off by default. The blog reports "over 2x the frame rate of JavaScript on heavy widget benchmarks" on those two engines.

The switch is a new `wasmAllowList` entry in the loader config, keyed by browser engine rather than by browser name. In `web/flutter_bootstrap.js`:

```js
{{flutter_js}}
{{flutter_build_config}}
_flutter.loader.load({
  config: {
    wasmAllowList: {
      blink: true,   // Chrome, Edge (already the default)
      webkit: true,  // Safari 26.2+, opt-in in 3.50
      gecko: true,   // Firefox 147+, opt-in in 3.50
    },
  },
});
```

Then build as before:

```bash
flutter build web --wasm
```

The [Wasm docs](https://docs.flutter.dev/platform-integration/web/wasm) list the defaults as `blink: true`, `webkit: false`, `gecko: false`. Older Safari and Firefox versions still get the dart2js fallback, so turning the flags on does not break users who have not updated. The Flutter team says WebKit and Gecko will become default in a future stable release, so this is the time to run your app on them and file bugs, not after the default flips.

If your app still imports `dart:html` or `package:js`, it cannot compile to Wasm at all. Dart 3.14 formally deprecates `dart:html`, `dart:js`, `dart:js_util` and `package:js`, and Flutter 3.50 adds `flutter build web --no-deprecated-js-interop` to fail the build on any remaining usage. Running that flag in CI is the quickest way to find what is blocking a Wasm build. The [earlier guide to building with --wasm](/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) still applies for the rest of the setup.

## Content-hashed builds without a custom pipeline

The second change targets a long-standing caching problem: `main.dart.js` kept the same filename on every deploy, so you had to choose between aggressive caching and users stuck on a stale bundle. In 3.50:

```bash
flutter build web --wasm --web-content-hash
```

The blog says this embeds content hashes into the compiled JavaScript, WebAssembly and `build/web/assets/**` filenames, updates `flutter_bootstrap.js` to point at them, and writes `build/web/precache_manifest.json` for custom service workers and Workbox setups. That manifest replaces the template tokens in `flutter_service_worker.js`, which are now deprecated.

The practical result is a two-tier cache policy. Hashed files can be served immutable for a year, and only the entry points need revalidation. A simplified nginx example (keep any other unhashed files, such as `manifest.json`, on `no-cache` too):

```nginx
location = /index.html          { add_header Cache-Control "no-cache"; }
location = /flutter_bootstrap.js { add_header Cache-Control "no-cache"; }
location / {
  add_header Cache-Control "public, max-age=31536000, immutable";
}
```

Upgrade with `flutter upgrade`, check that `dart --version` reports 3.14, then try both flags on a staging deploy. The full list of 3.50 breaking changes is on the [breaking changes page](https://docs.flutter.dev/release/breaking-changes), and the deployment details for hashing live in the [web deployment docs](https://docs.flutter.dev/deployment/web#web-content-hashing).
