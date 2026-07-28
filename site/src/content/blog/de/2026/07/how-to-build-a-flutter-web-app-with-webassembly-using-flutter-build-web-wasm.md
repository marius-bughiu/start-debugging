---
title: "Eine Flutter-Web-App mit WebAssembly kompilieren: flutter build web --wasm"
description: "Vollständige Anleitung zum Ausliefern einer nach WebAssembly kompilierten Flutter-Web-App unter Flutter 3.44: wie die beiden erzeugten Builds aussehen, warum Firefox und Safari wegen der wasmAllowList des Loaders weiterhin JavaScript erhalten, die Migration von dart:html zu dart2wasm, die COOP/COEP-Header, die entscheiden, ob skwasm mit mehreren Threads läuft, und wie Sie zur Laufzeit nachweisen, welchen Build der Browser tatsächlich geladen hat."
pubDate: 2026-07-28
template: how-to
tags:
  - "flutter"
  - "dart"
  - "webassembly"
  - "flutter-web"
  - "performance"
  - "how-to"
lang: "de"
translationOf: "2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm"
translatedBy: "claude"
translationDate: 2026-07-28
---

Um eine Flutter-Web-App mit WebAssembly zu kompilieren, fügen Sie das Flag `--wasm` hinzu: `flutter build web --wasm`. Dieses einzelne Flag lässt das Tool *zwei* Builds nach `build/web` schreiben: einen WasmGC-Build, den `dart2wasm` erzeugt und der den Renderer `skwasm` verwendet, sowie den gewöhnlichen `dart2js`-Build, der `canvaskit` als Fallback nutzt. Ein generiertes `flutter_bootstrap.js` wählt beim Laden der Seite einen davon aus. Zwei Dinge entscheiden dann, ob echte Nutzer den Wasm-Build erhalten: nichts in Ihrem Abhängigkeitsgraph darf `dart:html`, `dart:js`, `dart:js_util` oder `package:js` importieren, und Ihr Server muss `Cross-Origin-Opener-Policy: same-origin` plus `Cross-Origin-Embedder-Policy: credentialless` senden, sonst fällt `skwasm` stillschweigend auf einen einzigen Thread zurück. Dieser Artikel bezieht sich auf Flutter 3.44 stable (veröffentlicht am 2026-05-18, enthält Dart 3.10), und jedes Detail unten ist gegen den `stable`-Branch von `flutter/flutter` geprüft. Die wichtige Einschränkung gleich zu Beginn: ab 3.44 aktiviert der Loader den Wasm-Build nur auf Blink-Browsern, also erhalten Firefox, Safari und jeder Browser unter iOS den JavaScript-Build, unabhängig davon, was Sie kompilieren.

## Was `--wasm` tatsächlich in build/web ablegt

Das mentale Modell, das die meisten haben, ist auf eine nützliche Weise falsch. `--wasm` schaltet Ihren Build nicht von JavaScript auf WebAssembly um. Es *ergänzt* einen WebAssembly-Build neben dem JavaScript-Build. In `packages/flutter_tools/lib/src/commands/build_web.dart` erzeugt das Flag eine zweielementige Liste von Compiler-Konfigurationen, ein `WasmCompilerConfig` und ein `JsCompilerConfig`, und das Tool führt beide Compiler aus. Ohne das Flag erhalten Sie ein echtes `JsCompilerConfig` plus ein `WasmCompilerConfig` mit `dryRun: true`, das kompiliert, aber das Ergebnis verwirft (dazu gleich mehr).

Jedes kompilierte Ziel liefert eine Build-Beschreibung an ein generiertes `flutter_bootstrap.js`. Nach `flutter build web --wasm` unter Flutter 3.44 sieht der Deskriptor so aus:

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

Die Reihenfolge ist entscheidend: `FlutterLoader.load()` ruft `buildConfig.builds.find(buildIsCompatible)` auf und nimmt den *ersten* kompatiblen Eintrag, der Wasm-Build gewinnt also immer dann, wenn die Umgebung es erlaubt. Die Zuordnung des Renderers ist nicht konfigurierbar. `WebRendererMode.defaultForWasm` ist `skwasm` und `defaultForJs` ist `canvaskit`, und das Tool erlaubt keine Mischung, was zur ersten Fallstrick-Notiz weiter unten führt.

Auf der Platte finden Sie `main.dart.wasm` (das Modul), `main.dart.mjs` (die JS-Support-Laufzeit, die es instanziiert) und `main.dart.js` (den Fallback), dazu die Renderer-Nutzlasten: `skwasm.js` und `skwasm.wasm` für den Wasm-Pfad und das CanvasKit-Bundle für den Fallback-Pfad.

## Die fünf Schritte, auf die es ankommt

1. **Verwenden Sie Flutter 3.24 oder neuer.** Die Wasm-Kompilierung erreichte stable in 3.24; getestet habe ich hier 3.44. Wenn Sie pro Projekt mit SDK-Versionen jonglieren, gelten meine Notizen zu [einem Flutter-Projekt gegen mehrere SDK-Versionen in CI](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) unverändert für Wasm-Builds.
2. **Erzeugen Sie `web/index.html` neu, wenn es älter als Flutter 3.22 ist.** Der Wasm-Pfad hängt vollständig am Loader `flutter_bootstrap.js`, das alte Bootstrap mit `serviceWorkerVersion` funktioniert also nicht. `flutter create . --platforms web` nach dem Löschen von `web/` liefert das aktuelle Template.
3. **Entfernen Sie die `dart2wasm`-Inkompatibilitäten aus Ihrem Abhängigkeitsgraph.** Kompilieren Sie zuerst mit `flutter build web` ohne `--wasm` und lesen Sie die Dry-Run-Befunde.
4. **Kompilieren:** `flutter build web --wasm`.
5. **Ausliefern mit Headern für Cross-Origin-Isolation.** Ohne sie läuft die App zwar, aber mit einem einzigen Thread, was den größten Teil des Grundes für Wasm zunichtemacht.

## Warum Ihre App unter Firefox und Safari weiterhin JavaScript ausführt

Das ist der Punkt, der überrascht, und die offizielle Wasm-Seite ist alt genug (ihr Frontmatter `last-update` nennt Nov 6, 2024), dass ihre Lektüre das aktuelle Verhalten nicht erklärt. WasmGC ist nicht mehr die Einschränkung: es erreichte Baseline über Chrome 119, Firefox 120 und Safari 18.2. Die Einschränkung ist eine fest codierte Allowlist im Loader der Engine.

`engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js` im `stable`-Branch enthält genau dies:

```javascript
// engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js
export const defaultWasmSupport = {
  "blink": true,
  "gecko": false,
  "webkit": false,
  "unknown": false,
}
```

Und `loader.js` koppelt den `skwasm`-Build daran:

```javascript
// engine/src/flutter/lib/web_ui/flutter_js/src/loader.js
const supportsDart2Wasm = browserEnvironment.supportsWasmGC;
const supportsSkwasm = supportsDart2Wasm && browserEnvironment.webGLVersion > 0;

const enableWasm = config.wasmAllowList?.[browserEnvironment.browserEngine]
  ?? defaultWasmSupport[browserEnvironment.browserEngine];
```

Unter Firefox liefert `supportsWasmGC()` also `true` (der Detektor validiert ein winziges WasmGC-Modul, und Firefox besteht das), doch `enableWasm` ergibt aus dem `gecko`-Eintrag `false`, der `skwasm`-Build wird als inkompatibel verworfen, und der Loader fällt auf `dart2js` + `canvaskit` zurück. Dieselbe Geschichte für Safari über `webkit`. Der Grund ist nicht WasmGC, sondern der Renderer: das mehrfädige `skwasm` von Flutter stützt sich auf `OffscreenCanvas.transferToImageBitmap`, und sowohl der Firefox-Bug (Bugzilla 1788206) als auch der WebKit-Bug (267291), die dessen Kosten verfolgen, waren bei meiner Prüfung im Juli 2026 noch offen.

Sie können die Allowlist selbst überschreiben, was sich hinter einem Query-Parameter lohnt, wenn Sie echte Zahlen statt Meinungen wollen:

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

Liefern Sie das nicht auf Vermutung hin in die Produktion aus. Messen Sie zuerst mit dem Vorgehen aus [Jank in einer Flutter-App mit DevTools profilen](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/), denn auf den betroffenen Engines besteht der Fehlerfall in verschlechterten Frame-Zeiten, nicht in einem klaren Fehler.

Eine Grenze lässt sich überhaupt nicht überschreiben: jeder Browser unter iOS muss WebKit verwenden, eine nach Wasm kompilierte Flutter-App kann daher nicht in iOS Safari, iOS Chrome oder irgendetwas anderem auf dieser Plattform laufen.

## Die Abhängigkeiten zum Kompilieren bringen

`dart2wasm` unterstützt nur das statische JS-Interop von Dart. Jeder transitive Import von `dart:html`, `dart:js`, `dart:js_util` oder `package:js` bricht die Kompilierung mit Meldungen wie diesen ab:

```output
Dart library 'dart:html' is not available on this platform.
JS interop library 'dart:js_util' can't be imported when compiling to Wasm.
Try using 'dart:js_interop' or 'dart:js_interop_unsafe' instead.
```

Die gute Nachricht: Sie müssen das nicht durch Ausprobieren herausfinden. `--wasm-dry-run` steht standardmäßig auf `true`, ein einfaches `flutter build web` führt `dart2wasm` also bereits im Dry-Run-Modus aus und berichtet die Befunde:

```output
Wasm dry run findings:
...
Consider addressing these issues to enable wasm builds. See docs for more info:
https://docs.flutter.dev/platform-integration/web/wasm
```

Ist Ihre App bereits sauber, schiebt derselbe Mechanismus in die andere Richtung mit `Wasm dry run succeeded. Consider building and testing your application with the --wasm flag.` In beiden Fällen unterdrückt `flutter build web --no-wasm-dry-run` die Ausgabe, sobald Sie sich entschieden haben.

Für eigenen Code lautet die Migration `package:web` anstelle von `dart:html` und `dart:js_interop` anstelle von `package:js`:

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

Drei Unterschiede tun bei der Migration weh. Die Namen folgen dem Browser-IDL, aus `HtmlElement` wird also `HTMLElement` und aus `innerHtml` wird `innerHTML`. `querySelectorAll` gibt ein Iterable zurück, das keine `List` ist. Und weil Interop-Typen Extension Types sind, tun `is` und `as` nicht das Erwartete; verwenden Sie stattdessen `isA<T>()`. Auch bedingte Imports ändern sich: die Bedingung lautet nun `dart.library.js_interop`, nicht `dart.library.html`. Wenn Sie das Interop selbst schreiben statt ein Plugin einzubinden, lassen sich die Muster aus [plattformspezifischem Code in Flutter ohne Plugins](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) direkt übertragen.

Für fremden Code filtern Sie pub.dev nach `is:wasm-ready`. Wenn eine Abhängigkeit blockiert, ist ihr Upgrade oft die gesamte Lösung, und der übliche Schmerz beim Auflösen von Constraints kommt dazu; landen Sie in der Resolver-Hölle, beschreibt [Fix: Version solving failed in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/) den Ausweg.

## COOP und COEP entscheiden, ob Sie Threads bekommen

Flutter kompiliert `skwasm` mit Shared Memory. Sichtbar wird das im Compiler-Aufruf in `build_system/targets/web.dart`, der für den Renderer `skwasm` die Optionen `--import-shared-memory` und `--shared-memory-max-pages=32768` anhängt. Shared Memory im Browser erfordert Cross-Origin-Isolation, und die erfordert zwei Response-Header. Das Tool codiert das gewünschte Paar fest:

```dart
// packages/flutter_tools/lib/src/web/web_constants.dart, Flutter 3.44
const kCrossOriginIsolationHeaders = <String, String>{
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};
```

`flutter run -d chrome --wasm` setzt diese Header auf seinem eigenen Entwicklungsserver, genau deshalb zeigt sich das Problem lokal nie und dann in der Produktion. Fehlen sie, gibt es keinen Fehler. `skwasm_loader.js` berechnet `skwasmSingleThreaded: ... || !browserEnvironment.crossOriginIsolated || ...` und startet stillschweigend eine Engine mit einem einzigen Thread.

Für nginx:

```nginx
# nginx, serving build/web
location / {
    add_header Cross-Origin-Opener-Policy   same-origin   always;
    add_header Cross-Origin-Embedder-Policy credentialless always;
    try_files $uri $uri/ /index.html;
}
```

Für Firebase Hosting:

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

Prüfen Sie in der Browser-Konsole mit `window.crossOriginIsolated`, das `true` sein muss. Beachten Sie, dass GitHub Pages überhaupt keine eigenen Header senden kann, ein dort gehosteter Wasm-Build läuft also immer mit einem einzigen Thread.

Cross-Origin-Isolation ist nicht kostenlos. `require-corp` bricht jede Cross-Origin-Subressource, die nicht per `Cross-Origin-Resource-Policy` zustimmt, praktisch also Bilder Dritter, Schriftarten, Analytics-Beacons und eingebettete iframes. `credentialless` ist die mildere Variante: es lädt Cross-Origin-Subressourcen ohne Credentials statt sie zu blockieren. Beginnen Sie mit `credentialless` und prüfen Sie dann im Netzwerk-Panel, welche Anfragen ihre Cookies verloren haben.

## Nachweisen, welchen Build der Browser geladen hat

Schließen Sie das nicht per Stoppuhr. Der Compiler setzt eine Umgebungsvariable, die Sie lesen können:

```dart
// Flutter 3.44, Dart 3.10
const isRunningWithWasm = bool.fromEnvironment('dart.tool.dart2wasm');
```

Es gibt außerdem eine Verhaltensprobe, die ohne Neukompilierung funktioniert, weil Wasm die native Zahlendarstellung verwendet:

```dart
final isRunningWithWasm = identical(double.nan, double.nan);
```

Das Netzwerk-Panel ist die dritte Prüfung: eine Anfrage nach `main.dart.wasm` bedeutet den Wasm-Build, `main.dart.js` bedeutet den Fallback.

## Fallstricke, die Sie vor dem Ausliefern kennen sollten

**Einen Renderer zusammen mit `--wasm` zu setzen ist ein harter Fehler.** `build_web.dart` ruft `throwToolExit('Do not attempt to set a web renderer when using "--wasm"')` auf, wenn der ermittelte Renderer nicht `skwasm` ist. `--wasm` in Kombination mit `--dart-define=FLUTTER_WEB_USE_SKIA=true` scheitert also bereits in der CLI, und das ist Absicht.

**`config.renderer: 'canvaskit'` in einem Wasm-Build scheitert zur Laufzeit.** `buildIsCompatible` verwirft jeden Build, dessen `renderer` nicht dem konfigurierten Wert entspricht, und ein `--wasm`-Build enthält keinen Eintrag `dart2wasm` + `canvaskit`. Alle Kandidaten fallen heraus, und der Loader wirft `FlutterLoader could not find a build compatible with configuration and environment.` Verfolgt wird das als flutter/flutter#183265. Entfernen Sie den Schlüssel `renderer` oder setzen Sie ihn auf `skwasm`.

**Engines außerhalb von Chromium laden eine schwerere Renderer-Nutzlast.** `loadSkwasm` wählt `skwasm_heavy` statt `skwasm`, wenn dem Browser `ImageDecoder` oder die Break-Iteratoren von Chromium fehlen. Wenn Sie die Allowlist also erzwingen, zahlen Sie zusätzlich einen größeren Download.

**Chrome-Erweiterungen werden auf einen Thread gezwungen.** Der Loader erkennt `chrome.runtime.id` und deaktiviert Threads, weil die CSP von Erweiterungen das dynamische Skriptladen blockiert, das die Worker benötigen.

**Symbolnamen werden standardmäßig entfernt.** `--strip-wasm` ist standardmäßig `true`. Übergeben Sie `--no-strip-wasm`, wenn Sie lesbare Stack Traces aus einem Profiling-Build brauchen, und `--source-maps`, um `main.dart.wasm.map` zu erzeugen.

**Wasm behebt kein SEO.** Beide Builds zeichnen auf ein Canvas, Crawler sehen also weiterhin fast kein semantisches HTML. Wasm macht eine Flutter-Web-App schneller; es macht sie nicht zu einem Dokument.

**Das Tool nennt das immer noch neu.** `flutter build web --wasm` gibt einen Kasten mit dem Text `WebAssembly compilation is new. Understand the details before deploying to production.` aus. Nehmen Sie das ernst statt als Floskel: pinnen Sie Ihre Flutter-Version und behalten Sie den JavaScript-Fallback-Pfad in Ihrer Testmatrix, denn mit der heutigen Allowlist ist das der Pfad, auf dem die meisten Ihrer Nutzer unterwegs sind.

## Verwandte Beiträge

- [Wie Sie Jank in einer Flutter-App mit DevTools profilen](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)
- [Plattformspezifischen Code in Flutter ohne Plugins hinzufügen](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [Wie Sie aus einer einzigen CI-Pipeline mehrere Flutter-Versionen ansteuern](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Fix: Version solving failed in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Eine Flutter-2-App auf Flutter 3.x migrieren: die Null-Safety-Checkliste](/de/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)

## Quellen

- Flutter-Dokumentation, [Support for WebAssembly (Wasm)](https://docs.flutter.dev/platform-integration/web/wasm)
- Flutter-Dokumentation, [Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization)
- Flutter-Dokumentation, [Build and release a web app](https://docs.flutter.dev/deployment/web)
- Flutter-Quellcode, [`packages/flutter_tools/lib/src/commands/build_web.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/build_web.dart)
- Flutter-Quellcode, [`engine/src/flutter/lib/web_ui/flutter_js/src/loader.js`](https://github.com/flutter/flutter/blob/stable/engine/src/flutter/lib/web_ui/flutter_js/src/loader.js) und [`browser_environment.js`](https://github.com/flutter/flutter/blob/stable/engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js)
- Flutter-Issue [#183265, FlutterLoader could not find a build compatible with configuration and environment](https://github.com/flutter/flutter/issues/183265)
- Dart-Dokumentation, [Migrate to package:web](https://dart.dev/interop/js-interop/package-web) und [WebAssembly (Wasm) compilation](https://dart.dev/web/wasm)
- web.dev, [WasmGC and Wasm tail call optimizations are now Baseline Newly available](https://web.dev/blog/wasmgc-wasm-tail-call-optimizations-baseline)
- Chrome for Developers, [COEP: credentialless](https://developer.chrome.com/blog/coep-credentialless-origin-trial)
