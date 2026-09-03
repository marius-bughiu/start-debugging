---
title: "Migrate a Flutter web app from dart:html to package:web and dart:js_interop"
description: "A step-by-step migration off the deprecated dart:html, dart:js_util, and package:js onto package:web 1.1.1 and dart:js_interop: how to find every offending import with the dart2wasm compiler, what dart fix does and does not rename, the JSImmutableListWrapper and innerHTML traps, and how to verify with flutter build web --wasm."
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "flutter-web"
  - "interop"
  - "webassembly"
---

A single-app Flutter web codebase with a handful of `dart:html` calls is a half-day migration. A codebase where `dart:html` leaked into shared packages, mocks, or a plugin you maintain is a week, and the long pole is almost never your own code: it is the transitive dependency that still imports the legacy library. Nothing about this is optional any more. `dart:html`, `dart:js`, `dart:js_util`, and `package:js` were deprecated in Dart 3.7 (February 2025), none of them compile under `dart2wasm`, and the replacement pair, [`package:web`](https://pub.dev/packages/web) 1.1.1 plus `dart:js_interop`, has been stable since July 2024. This guide targets the current stable channel, Flutter 3.47.2 with Dart 3.13.2 (released 2026-08-27), and `package:web` 1.1.1, which requires Dart `^3.4.0`. Every compiler transcript below was captured on a real run with the Flutter 3.44.8 / Dart 3.12.2 stable toolchain and the same `package:web` 1.1.1.

## Why you cannot keep putting this off

- **WebAssembly is gated on it.** `dart2wasm` refuses to compile a program that transitively reaches `dart:html`. If you want the payoff described in [building a Flutter web app with `flutter build web --wasm`](/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), this migration is the entry fee, not an optimization.
- **The deprecation is already load-bearing.** `dart analyze` reports `deprecated_member_use` on the import line itself, so every CI job with `--fatal-infos` is already failing or is one config change away from it.
- **`package:web` is versioned separately from the SDK.** Browser API additions ship as a package release instead of waiting for an SDK release, and `package:web` is generated directly from the Web IDL, so names match MDN instead of matching a 2013-era Dart style guide.
- **If you publish a package, your users cannot compile to Wasm until you move.** One `dart:html` import in a leaf package blocks the whole dependency graph downstream.

## What breaks

| Area | Change | Severity |
| ---- | ------ | -------- |
| Type names | Dart-style names revert to IDL names: `HtmlElement` becomes `HTMLElement`, `InputElement` becomes `HTMLInputElement`, `AnchorElement` becomes `HTMLAnchorElement` | high, but mostly automatable |
| Collections | `querySelectorAll` and `children` return `NodeList` / `HTMLCollection`, which do not implement `List` | high |
| Type tests | `is` and `as` no longer work on browser types, because every `package:web` type erases to `JSObject` | high |
| Mocking | Extension types have no virtual dispatch, so a mock that `implements` a `dart:html` class cannot implement a `package:web` type | high |
| Type signatures | `innerHTML` is `JSAny`, event listeners take `JSFunction`, so call sites need `.toJS` | medium |
| Zones | Callbacks are no longer bound to the current zone automatically | medium |
| Conditional imports | `dart.library.html` must become `dart.library.js_interop` | medium |
| Platform views | View factories must return a `package:web` element and register through `dart:ui_web` | medium |
| `dart:js_util` | `getProperty` / `setProperty` / `callMethod` move to `dart:js_interop_unsafe` with `JSAny` keys | low, mechanical |

## Pre-flight checklist

- Flutter 3.47.2 or newer on the stable channel. Anything from Flutter 3.22 (Dart 3.4) works, but the analyzer fixes below are better in recent SDKs.
- `flutter pub add web`, which resolves to `web: ^1.1.1`.
- A CI job that runs `flutter build web --wasm` even if you do not ship the Wasm build yet. It is the only reliable detector for legacy imports hiding in dependencies.
- A branch, not a series of small commits on `main`. The rename pass touches a lot of files at once and is painful to review in slices.
- An inventory of packages you depend on that were last published before mid-2024. Those are your likely blockers.

## Migration steps

1. **Find every offending import with the compiler, not with grep.** `grep -r "dart:html" lib/` finds your code and misses the dependency three levels down that actually blocks you. `dart2wasm` prints the full import chain instead. Run `flutter build web --wasm` and read the first error:

   ```text
   Target dart2wasm failed: ProcessException: Process exited abnormally with exit code 254:
   lib/legacy_bit.dart:1:8: Error: Dart library 'dart:html' is not available on this platform.
   import 'dart:html' as html;
          ^
   Context: The unavailable library 'dart:html' is imported through these packages:

       main.dart => package:fweb => dart:html

   Detailed import paths for (some of) the these imports:

       main.dart => package:fweb/main.dart => package:fweb/legacy_bit.dart => dart:html
   ```

   The "Detailed import paths" block is the useful part. When the chain ends in a pub package rather than your own `lib/`, you have found a dependency that has to be upgraded, forked, or replaced before your app can move.

   Verification: every path printed by the compiler is written down and classified as "my code", "my package", or "third-party". Nothing is left as "probably fine".

2. **Swap the import and add the dependency.** Per file, `import 'dart:html' as html;` becomes `import 'package:web/web.dart' as web;`. Keep the prefix. An unprefixed `package:web` import drops several hundred top-level names into scope and collides with Flutter's own `Element`, `Image`, and `Text`.

   ```console
   flutter pub add web
   ```

   Verification: `flutter pub deps | grep web` shows `web 1.1.1`, and the file's errors change from "deprecated" to a list of undefined names. Undefined names are progress, they are the rename work made visible.

3. **Run `dart fix` for the type renames, then finish the rest by hand.** `package:web` ships a `lib/fix_data.yaml` with 141 rename transforms, so the analyzer can rewrite most legacy type names once the new import is in place:

   ```console
   dart fix --dry-run
   dart fix --apply
   ```

   On a file containing `InputElement`, `HtmlElement`, and `CheckboxInputElement`, `dart fix --apply` rewrites the first two and leaves the third alone:

   ```dart
   // After dart fix --apply, package:web 1.1.1
   final HTMLInputElement input = HTMLInputElement();
   final HTMLElement box = document.querySelector('#box') as HTMLElement;
   final CheckboxInputElement cb = CheckboxInputElement(); // still undefined
   ```

   `CheckboxInputElement` is not a rename, it is a `dart:html` convenience type with no IDL counterpart. The manual form is `HTMLInputElement()..type = 'checkbox'`. Where a name has no transform, look up the `@Native` annotation on the old `dart:html` class: its value is the `package:web` name.

   Verification: `dart analyze` reports zero `undefined_class` and `undefined_function` diagnostics in the migrated files.

4. **Replace `dart:js_util` and `package:js` with `dart:js_interop`.** The old dynamic accessors move to `dart:js_interop_unsafe` and take `JSAny` keys instead of `String`. Declared interop moves from `@JS()` classes to extension types on `JSObject`. Before:

   ```dart
   // dart:html + dart:js_util, Dart 3.12.2
   import 'dart:convert';
   import 'dart:html';
   import 'dart:js_util' as js_util;

   void downloadCsv(String csv) {
     final blob = Blob([csv], 'text/csv');
     final url = Url.createObjectUrlFromBlob(blob);
     AnchorElement(href: url)
       ..download = 'report.csv'
       ..click();
     Url.revokeObjectUrl(url);
   }

   Future<Map<String, dynamic>> loadJson(String path) async {
     final text = await HttpRequest.getString(path);
     return jsonDecode(text) as Map<String, dynamic>;
   }

   void unsafeAccess() {
     final maybe = js_util.getProperty(window, 'myLegacyGlobal');
     if (maybe != null) {
       js_util.callMethod(maybe, 'init', ['flutter']);
     }
   }
   ```

   After:

   ```dart
   // package:web 1.1.1 + dart:js_interop, Dart 3.12.2
   import 'dart:convert';
   import 'dart:js_interop';
   import 'dart:js_interop_unsafe';
   import 'package:web/web.dart';

   void downloadCsv(String csv) {
     final blob = Blob([csv.toJS].toJS, BlobPropertyBag(type: 'text/csv'));
     final url = URL.createObjectURL(blob);
     final anchor = document.createElement('a') as HTMLAnchorElement
       ..href = url
       ..download = 'report.csv';
     anchor.click();
     URL.revokeObjectURL(url);
   }

   Future<Map<String, dynamic>> loadJson(String path) async {
     final response = await window.fetch(path.toJS).toDart;
     final text = await response.text().toDart;
     return jsonDecode(text.toDart) as Map<String, dynamic>;
   }

   void unsafeAccess() {
     final maybe = globalContext.getProperty<JSObject?>('myLegacyGlobal'.toJS);
     if (maybe != null) {
       maybe.callMethod<JSAny?>('init'.toJS, 'flutter'.toJS);
     }
   }
   ```

   Three patterns to internalize: `allowInterop(fn)` becomes `fn.toJS`, `js_util.promiseToFuture(p)` becomes `p.toDart`, and a `JSPromise<T>` awaited with `.toDart` gives you a `Future<T>`. `HttpRequest` has no direct replacement worth using; `window.fetch` or `package:http` is the answer.

   Verification: `dart analyze` is clean, and no file in the repo still imports `dart:js`, `dart:js_util`, or `package:js`.

5. **Move platform view factories to `dart:ui_web`.** Any code registering an HTML view has to return a `package:web` element now. The registry lives in `dart:ui_web`, and `registerViewFactory` is declared as `registerViewFactory(String viewType, Function viewFactory, {bool isVisible = true})`:

   ```dart
   // Flutter 3.44.8, package:web 1.1.1
   import 'dart:ui_web' as ui_web;

   import 'package:flutter/widgets.dart';
   import 'package:web/web.dart' as web;

   const _viewType = 'startdebugging-iframe';

   void registerIframeFactory() {
     ui_web.platformViewRegistry.registerViewFactory(_viewType, (int viewId) {
       final iframe = web.document.createElement('iframe') as web.HTMLIFrameElement
         ..src = 'https://startdebugging.net/'
         ..style.border = 'none'
         ..style.width = '100%'
         ..style.height = '100%';
       return iframe;
     });
   }

   class EmbeddedSite extends StatelessWidget {
     const EmbeddedSite({super.key});

     @override
     Widget build(BuildContext context) =>
         const HtmlElementView(viewType: _viewType);
   }
   ```

   Verification: the view renders in `flutter run -d chrome`, and `flutter build web --wasm` compiles the file without complaint.

6. **Rewrite conditional imports to key off `dart.library.js_interop`.** The old spelling silently selects the stub implementation under `dart2wasm` because `dart.library.html` is false there, which produces an `UnsupportedError` at runtime instead of a compile error. That is the worst failure mode in this whole migration:

   ```dart
   // lib/platform_open.dart, Dart 3.12.2
   export 'src/open_stub.dart'
       if (dart.library.io) 'src/open_io.dart'
       if (dart.library.js_interop) 'src/open_web.dart';
   ```

   ```dart
   // lib/src/open_web.dart
   import 'package:web/web.dart' as web;

   void openUrl(String url) => web.window.open(url, '_blank');
   ```

   Verification: grep the repo for `dart.library.html` and confirm zero hits, then run the app on both a native target and the web to prove each branch still resolves. The same technique applies to the wider problem of [platform-specific code without a plugin](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

7. **Fix the tests last, because mocks break differently.** `package:web` types are extension types over `JSObject`, so a fake that `implements HTMLElement` will not compile. Replace class-based fakes with real DOM nodes created in the test, or with a JS object you build and hand to the code under test. Anything that reached for `dynamic` to call a DOM member also stops working, because extension type members resolve statically only.

   Verification: `flutter test` passes with no `implements` clause pointing at a `package:web` type left in the suite.

## Verification

Run all four, in this order:

```console
dart analyze --fatal-infos
flutter test
flutter build web
flutter build web --wasm
```

The last command is the real gate. On a migrated app it ends with `Built build/web` and drops `main.dart.wasm`, `main.dart.mjs`, and the `dart2js` fallback `main.dart.js` into `build/web`. If it still fails, the error names the exact import chain that is left. After that, load the app and click through anything that touches the DOM: file downloads, clipboard, iframes, `localStorage`, and any JS SDK you talk to through interop.

## Rollback plan

Per-file rollback is easy and per-repo rollback is not worth planning for. `package:web` and `dart:html` can coexist in the same program, so you can migrate one file, ship it, and revert that file alone if something breaks. What you cannot do is roll back after you have deleted the `dart:html` code paths and shipped a Wasm build, because the Wasm build never supported them in the first place. Keep the `dart2js` build as your production target until the click-through pass above is done; `flutter build web --wasm` emits both, and the loader falls back on its own.

## Gotchas worth knowing before you start

**The official `JSImmutableListWrapper` example does not compile.** `JSImmutableListWrapper<T, U>` cannot infer `U` from its constructor argument, so it falls back to the bound, `JSObject`:

```dart
for (final a in JSImmutableListWrapper(document.querySelectorAll('a'))) {
  a.classList.add('link'); // error: The getter 'classList' isn't defined for the type 'JSObject'
}
```

Pass both type arguments explicitly:

```dart
// package:web 1.1.1
for (final a in JSImmutableListWrapper<NodeList, Element>(
  document.querySelectorAll('a'),
)) {
  a.classList.add('link');
}
```

**`innerHTML` is `JSAny`, in both directions.** Writing needs `.toJS`, and reading needs a cast: `final String s = el.innerHTML;` fails with "A value of type 'JSAny' can't be assigned to a variable of type 'String'". Read it as `(el.innerHTML as JSString).toDart`. The same applies to `outerHTML` and to `insertAdjacentHTML`, whose second parameter is `JSAny`.

**`element.text` is a setter with no getter.** `package:web` keeps a deprecated `text` setter for migration convenience, but reading requires `textContent`, which is `String?` rather than `String`. Code that did `if (el.text.isEmpty)` needs a null check now.

**Callbacks lose their zone.** `dart:html` bound event callbacks to the current zone automatically; `package:web` does not. If you rely on zone-local values or on a zone-based error handler catching what happens inside a listener, bind manually before converting:

```dart
element.addEventListener(
  'click',
  Zone.current.bindUnaryCallback((Event event) {
    // zone-local values are preserved here
  }).toJS,
);
```

**Type tests silently change meaning.** `obj is Window` compiled fine under `dart:html`; under `package:web` every type erases to `JSObject`, so the check is meaningless. Use `element.isA<HTMLInputElement>()` (Dart 3.4 and newer) or `obj.instanceOfString('Window')`.

**Some `dart:html` habits survive as deprecated shims.** `window.localStorage['k'] = 'v'` still analyzes, with "'[]=' is deprecated and shouldn't be used. Use Storage.setItem instead", and a top-level `querySelector` exists with "Directly use document.querySelector instead". They compile today, they are not a destination. Convert them in the same pass or you will do this twice.

**Event streams still exist, and they are the ergonomic path.** `package:web` ships stream helpers, so `input.onClick.listen(...)` works unchanged and returns `ElementStream<MouseEvent>`. Prefer them over raw `addEventListener` plus `.toJS` for anything you need to cancel. Note that the helper streams deliver some events asynchronously where `dart:html` was synchronous, so timing-sensitive code needs a second look.

## Related

- The payoff for this work is described in full in [building a Flutter web app with WebAssembly](/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), including why Firefox and Safari still get the JavaScript build.
- Structurally this is the same kind of wide, mechanical pass as [migrating a Flutter 2 app to Flutter 3.x](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/): a two-hop plan and a compiler that tells you when you are done.
- The conditional-import mechanism in step 6 is the same one behind [platform-specific code without a plugin](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).
- If you are upgrading Flutter at the same time, read [what Flutter 3.47 changed for desktop rendering](/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) before blaming this migration for a visual regression.
- Web is also where [Dart isolates](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) behave differently from every other platform, which is worth knowing before you move CPU-bound work around during the same pass.

## Sources

- [Migrate to package:web](https://dart.dev/interop/js-interop/package-web), dart.dev
- [Past JS interop](https://dart.dev/interop/js-interop/past-js-interop), dart.dev
- [JS types and conversions](https://dart.dev/interop/js-interop/js-types), dart.dev
- [Breaking changes and deprecations](https://dart.dev/resources/breaking-changes), dart.dev
- [package:web on pub.dev](https://pub.dev/packages/web), version 1.1.1
- [EventStreamProviders API reference](https://pub.dev/documentation/web/latest/web/EventStreamProviders-class.html), package:web
- [dart:ui_web PlatformViewRegistry](https://api.flutter.dev/flutter/dart-ui_web/PlatformViewRegistry-class.html), Flutter API docs
- [Announcing Dart 3.13](https://dart.dev/blog/announcing-dart-3-13), the Dart blog
