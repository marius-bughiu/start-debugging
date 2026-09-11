---
title: "Fix: Flutter web serves a stale cached build after reloading the browser tab"
description: "A reload only revalidates index.html, so an unhashed main.dart.js keeps coming from the browser cache. Send Cache-Control: no-cache for the Flutter build output, stamp a build id where you cannot set headers, and let the self-cleaning service worker retire pre-3.41 caches."
pubDate: 2026-09-11
template: how-to
tags:
  - "flutter"
  - "flutter-web"
  - "deployment"
  - "caching"
  - "how-to"
---

**Short answer:** Flutter web emits entry points with fixed file names (`flutter_bootstrap.js`, `main.dart.js`, `main.dart.wasm`, `canvaskit/...`), and a normal browser reload only revalidates the HTML document. If your host sends any freshness lifetime for those files (Firebase Hosting sends `max-age=3600`, GitHub Pages sends `max-age=600`), the reloaded page gets a fresh `index.html` and a cached, old `main.dart.js`. Fix it by serving the whole `build/web` folder with `Cache-Control: no-cache`, or, on hosts where you cannot set headers, by stamping a build id onto `flutter_bootstrap.js` and `main.dart.js` after `flutter build web`. If users still have the offline-first service worker from Flutter 3.38 or earlier, keep deploying the default `flutter_service_worker.js`: since Flutter 3.41 it is a self-cleaning worker that unregisters the old one and reloads the tab.

Everything below was reproduced with Flutter 3.44.8 (Dart 3.12.2) and checked against the 3.47.3 tool and engine source, which behave the same for this problem. The browser tests ran in a Chromium-based browser against a small Node server that can switch its `Cache-Control` policy.

## Two different caches, depending on when you first shipped

Search results for this problem mix two eras, and the fix differs:

- **Flutter 3.38.x and earlier** generated an offline-first service worker. It served every file listed in its `RESOURCES` map straight from Cache Storage, only fetched `index.html` online-first, and needed a second load before a new deployment took over. That is where the classic "I have to reload twice" advice comes from.
- **Flutter 3.41.0 and later** no longer install a caching service worker for new visitors. [PR #176834](https://github.com/flutter/flutter/pull/176834) (merged October 2025, first stable in 3.41.0) replaced the 6 KB worker with a 784-byte cleanup worker, and the loader in `flutter.js` only registers it when the origin already has a registration. On a fresh 3.41+ app, the only cache left in play is the ordinary HTTP cache, and that is what this post is mostly about.

You can confirm which world you are in by opening DevTools, Application, Service workers. No registration means the HTTP cache is the culprit.

## Why a reload does not fetch the new main.dart.js

Look at what `flutter build web` puts in `build/web` on 3.44.8:

```text
# flutter build web, Flutter 3.44.8
index.html
flutter_bootstrap.js
flutter.js
flutter_service_worker.js
main.dart.js
version.json
manifest.json
assets/AssetManifest.bin
assets/FontManifest.json
assets/fonts/MaterialIcons-Regular.otf
canvaskit/canvaskit.js
canvaskit/canvaskit.wasm
```

None of these names contain a content hash. `index.html` loads `flutter_bootstrap.js`, which carries a `_flutter.buildConfig` whose `mainJsPath` is the literal string `"main.dart.js"`. Every deployment reuses the same URLs, so the browser cannot tell a new build from an old one by URL alone.

Now combine that with how reload works. Chrome's reload revalidates the main resource and then does a regular page load. The Chromium team's 2017 write-up says the browser chose to "only validate the main resource and continue with a regular page load" ([Chromium blog](https://blog.chromium.org/2017/01/reload-reloaded-faster-and-leaner-page_26.html)). Subresources that are still fresh according to their `Cache-Control` come straight from the disk cache without a request. On a plain navigation (a bookmark, a typed URL, a link), every browser reuses fresh copies, including `index.html` itself.

So whether the reload shows the new build depends entirely on what your host sends for those files:

| Host | Default `Cache-Control` for static files | Stale window after a deploy |
| --- | --- | --- |
| Firebase Hosting | `max-age=3600` (observed on `*.firebaseapp.com`) | up to 1 hour |
| GitHub Pages | `max-age=600`, not configurable | up to 10 minutes |
| Netlify, Vercel, Cloudflare Pages | `public, max-age=0, must-revalidate` | none |
| Nginx, Apache, `python -m http.server` with no config | no header, but `Last-Modified` is sent | heuristic, see below |

The last row catches people. A missing `Cache-Control` header does not mean "do not cache". With a `Last-Modified` header, [RFC 9111 section 4.2.2](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.2) lets the browser pick a heuristic freshness lifetime, typically 10% of the time since the file was last modified. A `main.dart.js` that was last deployed ten days ago can be treated as fresh for a whole day.

Firebase does purge its CDN on every deploy, so the edge serves the new files immediately. The browser's own cache is not purged, and that is the copy a reload uses.

## Minimal repro

This server serves `build/web` with a switchable policy. `firebase` mimics Firebase Hosting's default, `fixed` is the fix:

```js
// server.mjs, Node 22. Usage: MODE=firebase node server.mjs build/web
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json' };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const stat = fs.statSync(file);
  const headers = {
    'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
    'ETag': `"${stat.size}-${stat.mtimeMs}"`,
    'Cache-Control': process.env.MODE === 'fixed' ? 'no-cache' : 'max-age=3600',
  };
  if (req.headers['if-none-match'] === headers.ETag) { res.writeHead(304, headers); return res.end(); }
  console.log(200, p);
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}).listen(8765);
```

And an app whose only job is to show which build is running:

```dart
// lib/main.dart, Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

const build = 'A';

void main() => runApp(
  const MaterialApp(home: Scaffold(body: Center(child: Text('Build $build')))),
);
```

Steps: build with `build = 'A'`, start the server with `MODE=firebase`, open `http://localhost:8765/`. Change the constant to `'B'`, run `flutter build web` again, and reload the tab. The page still says "Build A". The server log for that reload shows a single request:

```text
200 /index.html
```

`flutter_bootstrap.js`, `main.dart.js`, CanvasKit and the fonts were all served from the browser cache. Repeat the whole sequence with `MODE=fixed` on a fresh origin and the reload shows "Build B". A second reload without a new deploy then costs one conditional request per file, each answered with a `304` and no body.

## The fix, step by step

1. **Serve the Flutter build output with `Cache-Control: no-cache`.** `no-cache` does not disable caching. It tells the browser to keep the file but revalidate it with `If-None-Match` or `If-Modified-Since` before every use. Unchanged files cost a round trip and a `304`. Changed files are downloaded. Apply it to `index.html`, `flutter_bootstrap.js`, `flutter.js`, `flutter_service_worker.js`, `main.dart.js`, `main.dart.mjs`, `main.dart.wasm`, `version.json`, `manifest.json`, everything under `assets/`, and the local `canvaskit/` folder. The simplest correct rule is "everything in `build/web`".
2. **Put the rule in your host's config.** Examples follow below for Firebase Hosting, Nginx, and the `_headers` file used by Netlify and Cloudflare Pages.
3. **Wait out one old lifetime.** New headers only apply to responses fetched after the change. Browsers that cached `main.dart.js` under `max-age=3600` keep using it until that hour is up. Ship the header change a deployment before you need it, or combine it with a build id (step 4) for the first rollout.
4. **Where you cannot set headers, stamp a build id.** GitHub Pages is the common case. Rewrite the entry point URLs after every build so each deployment has new URLs.
5. **Tell tabs that are already open.** Headers only help on the next load. A long-lived tab keeps running the old build until the user reloads, so poll a small build id file and offer a reload.

### Firebase Hosting

The [Flutter web FAQ](https://docs.flutter.dev/platform-integration/web/faq) suggests `max-age=0,s-maxage=604800` for `js`, `mjs`, `wasm` and `json`, which keeps the CDN warm while forcing the browser to revalidate. Its pattern leaves out HTML and `.bin`, and it gives images and fonts `max-age=3600`, so `index.html`, `assets/AssetManifest.bin`, and any image you replaced under the same name stay stale for an hour. This `firebase.json` covers the whole build:

```json
{
  "hosting": {
    "public": "build/web",
    "headers": [
      {
        "source": "**",
        "headers": [
          { "key": "Cache-Control", "value": "no-cache" }
        ]
      }
    ]
  }
}
```

Because Firebase purges its CDN on deploy, you do not need `s-maxage` to keep the edge correct. Add it back only if you measure a latency problem.

### Nginx

```nginx
# nginx 1.27, serving the output of flutter build web
server {
    listen 80;
    root /var/www/app/build/web;

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache" always;
        etag on;
    }
}
```

Keep `etag on` (the default). Without a validator the browser has nothing to revalidate with and downloads the full file every time.

### Netlify and Cloudflare Pages

Both already default to `max-age=0, must-revalidate`, which behaves correctly. If a previous config or a framework preset added a longer lifetime, override it with a `_headers` file in `web/` so that `flutter build web` copies it into `build/web`:

```text
# web/_headers, copied to build/web by flutter build web (Flutter 3.44)
/*
  Cache-Control: no-cache
```

### GitHub Pages and other headerless hosts

Run a small post-build script. It appends `?v=<id>` to the bootstrap script tag and to the build paths inside `_flutter.buildConfig`, and writes the id to `build_id.txt` for step 5:

```bash
#!/usr/bin/env bash
# bust.sh, run after `flutter build web` (Flutter 3.44 output layout)
set -euo pipefail
ID="${1:-$(git rev-parse --short HEAD 2>/dev/null || date +%s)}"
OUT=build/web
sed -i.bak "s|src=\"flutter_bootstrap.js\"|src=\"flutter_bootstrap.js?v=$ID\"|" "$OUT/index.html"
sed -i.bak -E "s#\"(main\.dart\.(js|wasm|mjs))\"#\"\1?v=$ID\"#g" "$OUT/flutter_bootstrap.js"
rm "$OUT"/*.bak
echo "$ID" > "$OUT/build_id.txt"
```

Under a `max-age=600` policy, a reload after deploying a stamped build requested exactly three files (`index.html`, `flutter_bootstrap.js?v=...`, `main.dart.js?v=...`) and showed the new build, while CanvasKit and the fonts kept coming from cache. This is the approach the Flutter FAQ describes, noting that Flutter does not append build ids automatically. `index.html` itself is still subject to the 10-minute lifetime on a plain navigation (a reload always revalidates it), and assets you replace under the same name are not covered, so rename changed images instead of overwriting them.

### Offer a reload to open tabs

Pass the same id to the app at compile time and compare it with the deployed `build_id.txt`. `cache: 'no-store'` keeps the check itself out of the HTTP cache:

```dart
// lib/update_check.dart, Flutter 3.44.8, Dart 3.12.2, package:web 1.1.1
import 'dart:async';
import 'dart:js_interop';

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

/// flutter build web --dart-define=BUILD_ID=$(git rev-parse --short HEAD)
const buildId = String.fromEnvironment('BUILD_ID', defaultValue: 'dev');

Future<bool> newBuildAvailable() async {
  try {
    final response = await web.window
        .fetch('build_id.txt'.toJS, web.RequestInit(cache: 'no-store'))
        .toDart;
    if (!response.ok) return false;
    final deployed = (await response.text().toDart).toDart.trim();
    return deployed.isNotEmpty && deployed != buildId;
  } catch (_) {
    return false; // offline or blocked: keep running the current build
  }
}

void startUpdateCheck(GlobalKey<ScaffoldMessengerState> messenger) {
  if (buildId == 'dev') return;
  Timer.periodic(const Duration(minutes: 5), (timer) async {
    if (!await newBuildAvailable()) return;
    timer.cancel();
    messenger.currentState?.showSnackBar(
      SnackBar(
        duration: const Duration(days: 1),
        content: const Text('A new version is available.'),
        action: SnackBarAction(
          label: 'Reload',
          onPressed: () => web.window.location.reload(),
        ),
      ),
    );
  });
}
```

Give `MaterialApp` a `scaffoldMessengerKey` and call `startUpdateCheck` with it from `main`. When building with `--dart-define=BUILD_ID=A` and deploying a `build_id.txt` containing `B`, `newBuildAvailable()` returned `true` on the first check. If you do not use `bust.sh`, write `build_id.txt` in CI with the same id. This matters most when your backend API changes together with the frontend, because an old tab calling a new API is a worse bug than an old UI.

## If you shipped the service worker before Flutter 3.41

Users who first opened your app when it was built with 3.38.x or earlier still have the offline-first worker and its `flutter-app-cache` in their browser. Here is what happens the first time they load a deployment built with 3.41 or later, according to the 3.44.8 and 3.47.3 source:

1. The old worker is still in control, so it answers the navigation online-first (new `index.html`) but serves `flutter_bootstrap.js` and `main.dart.js` from Cache Storage. The user may briefly see the old build.
2. The browser's service worker update check fetches `flutter_service_worker.js` from the network. The file is byte-different (it is now the 784-byte cleanup worker), so it installs.
3. The cleanup worker calls `skipWaiting()`, then in `activate` calls `self.registration.unregister()` and navigates every window it controls to its current URL.
4. That navigation happens without a service worker, so the page loads the current build through the HTTP cache. With the headers from the previous section, that is the new build.

The cleanup worker does not delete `flutter-app-cache`, `flutter-temp-cache` or `flutter-app-manifest`. Without a worker nothing reads them, but they keep occupying storage. If that matters to you, delete them once at startup through the Cache Storage API (`caches.delete('flutter-app-cache')` and so on, via `package:web`).

Two deploy mistakes block this handoff:

- **Removing `flutter_service_worker.js` from the deployment.** If the update check gets a `404`, the browser keeps the existing worker, and the old worker keeps serving the old `main.dart.js` from Cache Storage. Keep shipping the file for as long as you might have legacy visitors.
- **Building with `--pwa-strategy=none` too early.** The flag is hidden and deprecated in 3.44 and prints a pointer to [flutter/flutter#156910](https://github.com/flutter/flutter/issues/156910). With `none`, the tool writes an empty `flutter_service_worker.js` and drops `serviceWorkerSettings` from `flutter_bootstrap.js`, so nothing unregisters the old worker. The browser eventually installs the empty script, but it only takes over after every tab of the app is closed, and the registration never goes away. The default build is the one that includes the cleanup path.

If you need real offline support, the [Flutter FAQ](https://docs.flutter.dev/platform-integration/web/faq) now says to bring your own worker, for example with Workbox. Give it a versioned cache name and a network-first strategy for `index.html` and `flutter_bootstrap.js`, or you will rebuild the old problem.

## Gotchas and lookalikes

- **Hard reload hides the bug.** Ctrl+Shift+R (Cmd+Shift+R on macOS) bypasses the HTTP cache and the service worker for that load, so developers rarely see this themselves. Test with a normal reload, or with "Disable cache" turned off in DevTools.
- **CanvasKit from the CDN is safe, local CanvasKit is not.** By default the loader fetches CanvasKit from `gstatic.com` under a URL that contains the engine revision, so a Flutter upgrade changes the URL. With `--no-web-resources-cdn`, CanvasKit is served from `canvaskit/` with the same name on every release. An aggressive lifetime there can pair a new `main.dart.js` with an old CanvasKit after a Flutter upgrade.
- **Long lifetimes on "static" assets.** Some hosts and CDN presets give `.js` files `max-age` values of 30 days, assuming hashed names. That assumption is false for Flutter output. Check the actual response headers with `curl -I https://your.app/main.dart.js`.
- **Wasm builds have more entry points.** A `--wasm` build also loads `main.dart.mjs` and `main.dart.wasm`, and the loader falls back to `main.dart.js` for browsers outside its allowlist. All three need the same treatment, which is why `bust.sh` rewrites all of them.
- **Stale behaviour that is not the cache.** If the new build loads but routes 404 on refresh, that is a missing SPA rewrite (`try_files ... /index.html` or `"rewrites"` in `firebase.json`). If assets 404 only under a sub-path, check `--base-href`.

## Related

- [How to build a Flutter web app with WebAssembly](/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), which covers the extra Wasm entry points and the COOP/COEP headers that sit next to `Cache-Control` in the same host config.
- [Migrating a Flutter web app from `dart:html` to `package:web`](/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/), for the interop style used in the update check.
- [Fix: Flutter Text renders off-screen in an Android WebView](/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/), another Flutter web issue that only shows up after deployment.
- [Output caching vs response caching in ASP.NET Core 11](/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/), if your Flutter web build is served by an ASP.NET Core backend and you set the `Cache-Control` headers there.

## Sources

- [Flutter web FAQ](https://docs.flutter.dev/platform-integration/web/faq): service worker removal, `Cache-Control` guidance, and the build id technique.
- [Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization): `flutter_bootstrap.js` template tokens.
- [flutter/flutter#156910](https://github.com/flutter/flutter/issues/156910): deprecating and removing `flutter_service_worker.js`.
- [flutter/flutter PR #176834](https://github.com/flutter/flutter/pull/176834): the self-cleaning service worker, first shipped in 3.41.0.
- [`service_worker_loader.js` at 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/engine/src/flutter/lib/web_ui/flutter_js/src/service_worker_loader.js) and [`flutter_service_worker.js` at 3.38.10](https://github.com/flutter/flutter/blob/3.38.10/packages/flutter_tools/lib/src/web/file_generators/js/flutter_service_worker.js) for the old and new worker behaviour.
- [Chromium blog: Reload, reloaded](https://blog.chromium.org/2017/01/reload-reloaded-faster-and-leaner-page_26.html): reload only revalidates the main resource.
- [RFC 9111, section 4.2.2](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.2): heuristic freshness when no explicit lifetime is sent.
- [Firebase Hosting cache behavior](https://firebase.google.com/docs/hosting/manage-cache): CDN purge on redeploy.
