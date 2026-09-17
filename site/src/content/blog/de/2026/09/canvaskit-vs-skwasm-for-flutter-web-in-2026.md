---
title: "CanvasKit vs. skwasm für Flutter Web in 2026: Welchen Renderer sollten Sie ausliefern?"
description: "Liefern Sie skwasm mit flutter build web --wasm aus, wenn Ihre Abhängigkeiten nach Wasm kompilieren: Der Download ist kleiner, und bei einer aufwendigen Szene wurden 36 % mehr Frames gerendert als mit CanvasKit. Bleiben Sie auf Flutter 3.47.x beim Single-Threaded-Modus, bis der Fix für den Multi-Threaded-Absturz bei Text die Beta verlässt."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "flutter"
  - "flutter-web"
  - "webassembly"
  - "performance"
lang: "de"
translationOf: "2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026"
translatedBy: "claude"
translationDate: 2026-09-17
---

Liefern Sie skwasm aus. Auf Flutter 3.47.4 (dem aktuellen Stable-Release, Dart 3.13.3) bekommen Chromium-Nutzer mit `flutter build web --wasm` einen kleineren Download (1,65 MB statt 1,98 MB brotli für die Benchmark-App weiter unten) und bei einer aufwendigen Szene 32,7 Frames pro Sekunde statt 24,0 mit CanvasKit. Firefox, Safari und jeder iOS-Browser erhalten aus demselben Build weiterhin CanvasKit. Bleiben Sie nur dann bei einem reinen CanvasKit-Build, wenn eine Abhängigkeit noch `dart:html` oder `package:js` importiert. Eine Einschränkung für 3.47.x: Multi-Threaded-skwasm kann bei textlastigen Frames abstürzen, erzwingen Sie also den Single-Threaded-Modus, bis 3.48 den Stable-Kanal erreicht.

"Renderer" ist hier ein etwas irreführendes Wort, denn CanvasKit oder skwasm wählen Sie nicht direkt. Seit Flutter 3.29 den HTML-Renderer und das Flag `--web-renderer` entfernt hat, ergibt sich der Renderer aus dem Kompilierziel. Die Ausgabe von `dart2js` läuft immer auf CanvasKit, die Ausgabe von `dart2wasm` immer auf skwasm. Das Tool erzwingt das: `flutter build web --wasm --dart-define=FLUTTER_WEB_USE_SKIA=true --dart-define=FLUTTER_WEB_USE_SKWASM=false` bricht mit `Do not attempt to set a web renderer when using "--wasm"` ab. Die eigentliche Frage lautet also "JavaScript-Build oder Wasm-Build", und die Antwort entscheidet, welches Skia darunter läuft.

## Die Funktionsmatrix

| Eigenschaft (Flutter 3.47.4)       | CanvasKit                                           | skwasm                                                        |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| Kompilierziel                      | `dart2js`                                           | `dart2wasm` (benötigt WasmGC)                                 |
| Build-Befehl                       | `flutter build web`                                 | `flutter build web --wasm` (erzeugt auch den CanvasKit-Build) |
| Browser, die ihn standardmäßig laden | Alle                                              | Nur Blink (Chrome, Edge, Opera, Chrome auf Android)           |
| Engine-Download, brotli            | 1.54 MB (Chromium-Variante), 2.26 MB (volle Variante) | 1.21 MB (`skwasm.wasm`), 1.86 MB (`skwasm_heavy.wasm`)      |
| Rasterisiert auf                   | Hauptthread                                         | Einem Web Worker, wenn die Seite cross-origin isolated ist    |
| Nötige Header für den besten Modus | Keine                                               | `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` |
| `dart:html`, `package:js` im Graphen | Kein Problem                                      | Kompilierfehler                                               |
| Debugging mit `flutter run -d chrome` | Volle DevTools, zustandserhaltendes Hot Reload (DDC) | Kein Service Protocol, Hot Reload ist ein Neustart        |
| Deferred Loading                   | Ja                                                  | Standardmäßig aus, experimentelles Flag für 3.50 geplant      |
| Bekanntes Problem im Stable-Kanal  | Nichts Blockierendes                                | Multi-Threaded-Absturz bei häufig wechselndem Text, #190039   |

Zwei Zeilen brauchen eine Anmerkung. Die Zeile "Nur Blink" hat nichts mit WasmGC-Unterstützung zu tun: Firefox und Safari validieren WasmGC heute beide. Der Loader von Flutter hält sie mit einer fest codierten Allowlist in `browser_environment.js` (`blink: true, gecko: false, webkit: false`) von skwasm fern. Der Grund: Multi-Threaded-skwasm übergibt Frames vom Worker an die Seite mit `OffscreenCanvas.transferToImageBitmap`, und das ist in beiden Engines langsam. Die zugehörigen Bugs, [Mozilla 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206) und [WebKit 267291](https://bugs.webkit.org/show_bug.cgi?id=267291), standen im September 2026 beide noch auf `NEW`.

Die Debugging-Zeile stammt direkt aus `resident_web_runner.dart` in 3.47.4: `supportsServiceProtocol` ist `!debuggingOptions.webUseWasm && isRunningDebug && ...`, und `reloadIsRestart` gibt `true` zurück, sobald `webUseWasm` gesetzt ist. Die tägliche Entwicklung bleibt deshalb auch bei Teams, die Wasm ausliefern, auf dem JavaScript-Pfad.

## Was jeder Build tatsächlich herunterlädt

Ein `--wasm`-Build schreibt beide Pipelines nach `build/web`, und `flutter_bootstrap.js` enthält eine `buildConfig`, die sie nach Priorität auflistet:

```jsonc
// flutter build web --wasm, Flutter 3.47.4
"builds": [
  {"compileTarget": "dart2wasm", "renderer": "skwasm", "mainWasmPath": "main.dart.wasm", "jsSupportRuntimePath": "main.dart.mjs"},
  {"compileTarget": "dart2js", "renderer": "canvaskit", "mainJsPath": "main.dart.js"}
]
```

Der Loader nimmt den ersten kompatiblen Eintrag. Innerhalb jedes Renderers wählt er dann anhand der Browserfunktionen eine Variante. `canvaskit_loader.js` lädt `canvaskit/chromium/canvaskit.wasm`, wenn der Browser sowohl `ImageDecoder` als auch `Intl.v8BreakIterator` besitzt. Diese Variante überlässt Bild-Codecs und ICU-Daten dem Browser, und Flutter 3.47.0 hat die verbliebenen Codecs daraus entfernt ([#178133](https://github.com/flutter/flutter/pull/178133)). Alle anderen erhalten das volle `canvaskit.wasm`. `skwasm_loader.js` trennt genauso: `skwasm.wasm` auf Chromium und das größere `skwasm_heavy.wasm` überall dort, wo diese beiden APIs fehlen. In der Praxis sehen Sie `skwasm_heavy` nur, wenn Sie die Allowlist überschreiben, um Firefox oder Safari auf Wasm zu bringen.

Ich habe gemessen, was ein erster Besuch auf jedem Pfad kostet, und dazu den Release-Build der unten beschriebenen Benchmark-App verwendet (eine Material-App mit etwa 180 Zeilen). Die Größen sind `brotli -q 11` und `gzip -9` der Dateien, die jeder Pfad abruft. `flutter.js`, `flutter_bootstrap.js`, Schriften und Assets sind auf jedem Pfad gleich und daher nicht enthalten:

| Pfad (Flutter 3.47.4)       | App-Code                              | Renderer JS + Wasm | Gesamt brotli | Gesamt gzip |
| --------------------------- | ------------------------------------- | ------------------ | ------------- | ----------- |
| CanvasKit, Chromium-Variante | `main.dart.js` 413 KB                | 1,564 KB           | **1,977 KB**  | 2,612 KB    |
| CanvasKit, volle Variante   | `main.dart.js` 413 KB                 | 2,281 KB           | **2,695 KB**  | 3,465 KB    |
| skwasm                      | `main.dart.wasm` 416 KB + `.mjs` 6 KB | 1,225 KB           | **1,647 KB**  | 2,083 KB    |

Beim App-Code herrscht bei dieser Größe Gleichstand: 1,42 MB rohes Wasm und 1,79 MB rohes, minifiziertes JavaScript komprimieren auf fast dieselbe brotli-Größe. Die Ersparnis kommt von der Engine, denn `skwasm.wasm` ist etwa 330 KB kleiner als das Chromium-CanvasKit. Eine Einschränkung für große Apps: `dart2wasm` teilt Deferred Imports standardmäßig nicht auf, sodass eine App, die sich auf `deferred as` verlässt, um den ersten Ladevorgang klein zu halten, diesen Vorteil auf dem Wasm-Pfad verlieren kann.

## Der Benchmark

Die Downloadgröße ist nur die halbe Geschichte. Die andere Hälfte ist die Frame-Zeit, daher habe ich dieselben Szenen mit jeder Konfiguration gerendert.

**Umgebung.** Apple M4, 16 GB RAM, macOS 26. Google Chrome 153.0.8010.48, gestartet mit `--headless=new --use-angle=metal` (WebGL meldete `ANGLE Metal Renderer: Apple M4`), ein 1280x800-Fenster bei DPR 1 und ein frisches Profil pro Lauf. Die App wurde im Release-Modus mit Flutter 3.47.4 und mit 3.48.0-0.5.pre kompiliert, mit `flutter build web --wasm --no-web-resources-cdn`, und von localhost mit `Cache-Control: no-store` ausgeliefert. Ein Port sendete `Cross-Origin-Opener-Policy: same-origin` und `Cross-Origin-Embedder-Policy: require-corp`, ein anderer keinen der beiden Header.

**Methodik.** Ein einziger `--wasm`-Build bediente alle Konfigurationen. Ein angepasstes `flutter_bootstrap.js` las den Renderer aus dem Query-String, sodass die CanvasKit-Läufe genau denselben `main.dart.js`-Fallback nutzten, den echte Firefox-Nutzer herunterladen:

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

In der App sammelte `SchedulerBinding.instance.addTimingsCallback` nach 3 Sekunden Aufwärmphase 10 Sekunden lang `FrameTiming`s. Im Web zeichnet der `FrameTimingRecorder` der Engine diese rund um jeden `draw`-Aufruf des Rasterizers auf. "Dargestellte fps" ist die Anzahl der Timings (fertig rasterisierte Frames) pro Sekunde, und jede Zelle ist der Median aus 3 Läufen (5 für Multi-Threaded-skwasm auf 3.48). Auf 3.48.0-0.5.pre lagen CanvasKit (24,0 fps) und Single-Threaded-skwasm (32,3 fps) innerhalb von 2 % ihrer Werte unter 3.47.4, daher zeigen die Tabellen 3.47.4, wo immer es sauber lief. Die Szene "Tiles" besteht aus 600 rotierenden `Container`s mit Farbverlauf, abgerundeten Ecken, einem `BoxShadow` und einem `Text`, dessen Inhalt sich in jedem Frame ändert. Die Szene "Paths" ist ein `CustomPainter`, der 400 animierte Pfade mit je 40 Segmenten zeichnet.

**Szene Tiles (aufwendig):**

| Konfiguration                          | Dargestellte fps | Build p50 | Raster p50 | Frame-Spanne p90 | Erster Frame |
| -------------------------------------- | ---------------- | --------- | ---------- | ---------------- | ------------ |
| CanvasKit, Chromium-Variante (3.47.4)  | 24.0             | 24.2 ms   | 17.1 ms    | 44.0 ms          | 285 ms       |
| CanvasKit, volle Variante (3.47.4)     | 24.3             | 23.7 ms   | 17.2 ms    | 42.9 ms          | 286 ms       |
| skwasm, Single-Threaded (3.47.4)       | **32.7**         | 13.6 ms   | 16.0 ms    | 31.4 ms          | 193 ms       |
| skwasm, Multi-Threaded (3.47.4)        | hängt            | n. v.     | n. v.      | n. v.            | 245 ms       |
| skwasm, Multi-Threaded (3.48.0-0.5.pre) | **39.3**        | 14.7 ms   | 22.5 ms    | 48.0 ms          | 238 ms       |

**Szene Paths (leicht):**

| Konfiguration (3.47.4)       | Dargestellte fps | Build p50 | Raster p50 |
| ---------------------------- | ---------------- | --------- | ---------- |
| CanvasKit, Chromium-Variante | 60.4             | 3.3 ms    | 3.0 ms     |
| skwasm, Single-Threaded      | 60.0             | 1.2 ms    | 3.9 ms     |
| skwasm, Multi-Threaded       | 59.9             | 1.1 ms    | 4.1 ms     |

Vier Dinge fallen auf:

1. **Der größte Teil des Gewinns kommt von `dart2wasm`, nicht von Skia.** Die Rasterisierungszeit ist fast identisch (17,1 ms gegenüber 16,0 ms bei Tiles, und bei Paths ist CanvasKit sogar schneller). Die Build-Phase, also Ihr Dart-Code für Widgets, Layout und Paint, läuft kompiliert nach WasmGC ungefähr doppelt so schnell. Je mehr Framework-Arbeit pro Frame anfällt, desto größer der Abstand.
2. **Multi-Threading tauscht Latenz gegen Durchsatz.** Auf der 3.48-Beta stellte der Multi-Threaded-Build 22 % mehr Frames dar als der Single-Threaded-Build (39,3 gegenüber 32,3 fps), während sein Raster-p50 auf 22,5 ms stieg. Der UI-Thread baut den nächsten Frame, während der Worker noch den vorherigen rasterisiert. `Renderer.renderScene` behält nur die neueste ausstehende Szene und verwirft den Rest. Das Ergebnis sind insgesamt mehr Frames und eine längere Spanne pro Frame.
3. **Leichte Szenen enden so oder so bei vsync.** Besteht Ihre App aus Formularen und Listen, sehen Sie den Renderer-Unterschied nicht in der Framerate. Sie sehen ihn beim Download und beim Start.
4. **Der erste Frame auf localhost fällt um etwa 90 ms zugunsten von Single-Threaded-skwasm aus** (193 ms gegenüber 285 ms; das Hochfahren des Render-Workers kostet im Multi-Threaded-Modus einen Teil davon wieder). Ohne Netzwerk ist dieser Abstand reiner Kompilier- und Instanziierungsaufwand. Über eine echte Verbindung kommt der brotli-Unterschied von 330 KB noch hinzu.

Betrachten Sie die absoluten Zahlen als spezifisch für einen M4 mit Metal. Übertragbar sind die Verhältnisse.

## Wann Sie skwasm wählen sollten

- **Ihr Publikum nutzt überwiegend Chrome oder Edge auf dem Desktop oder Chrome auf Android.** Genau diese Nutzer erhalten den Wasm-Build, und sie bekommen den kleineren Download und die schnellere Build-Phase gratis dazu. Alle anderen fallen transparent auf CanvasKit zurück.
- **Ihre Frames sind Framework-lastig.** Dashboards, Datenraster und animierte Listen verbringen ihre Zeit in Build und Layout, und genau dort lag `dart2wasm` im Benchmark vorn.
- **Sie kontrollieren die Antwort-Header.** Der Multi-Threaded-Modus braucht `Cross-Origin-Opener-Policy: same-origin` und `Cross-Origin-Embedder-Policy: credentialless` (oder `require-corp`). Ohne sie funktioniert skwasm weiterhin, allerdings Single-Threaded, und protokolliert eine Warnung, die Sie mit `suppressMultithreadingWarning: true` unterdrücken können.
- **Ihr gesamter Abhängigkeitsgraph nutzt `package:web` und `dart:js_interop`.** Ein einfaches `flutter build web` führt bei jedem Build einen Wasm-Probelauf durch und gibt "Wasm dry run succeeded" oder die problematischen Imports aus, Sie wissen es also bereits.

## Wann Sie CanvasKit wählen sollten

- **Eine Abhängigkeit importiert noch `dart:html`, `dart:js` oder `package:js`.** `dart2wasm` verweigert die Kompilierung, die Entscheidung ist also gefallen, bis dieses Paket migriert.
- **Der Großteil Ihres Traffics kommt von iOS oder Safari.** Diese Nutzer erhalten aus einem `--wasm`-Build ohnehin CanvasKit. Der Wasm-Build bringt nur zusätzliche Build-Zeit und eine zweite Pipeline zum Testen, ohne Nutzen für sie.
- **Sie betten Cross-Origin-Inhalte ein und können COEP nicht einführen.** Iframes von Drittanbietern, Werbeskripte oder Bilder ohne CORS-Header können unter `require-corp` brechen, und `credentialless` entfernt Cookies aus diesen Anfragen. Single-Threaded-skwasm braucht keine Header, aber der Durchsatzgewinn geht verloren.
- **Sie brauchen Deferred Loading für eine kleine erste Ladegröße.** Solange Deferred Loading für Wasm hinter seinem experimentellen Flag steckt, kann ein JavaScript-Build mit `deferred as`-Imports kleiner starten als ein monolithisches `main.dart.wasm`.

## Der Stolperstein, der auf 3.47.x die Wahl für Sie trifft

In der Szene Tiles blieb Multi-Threaded-skwasm auf Flutter 3.47.4 in 6 von 7 Läufen hängen. In vier davon feuerte `requestAnimationFrame` weiter und das Framework baute weiter mit 60 fps, aber nach den ersten Frames kamen keine `FrameTiming`s mehr an, es erreichte also nichts Neues den Bildschirm. In den anderen beiden führte die Seite überhaupt keine Dart-Timer mehr aus. Die Chrome-Konsole zeigte in manchen Läufen `Uncaught RuntimeError: null function` und `table index is out of bounds` aus `skwasm.wasm`, in anderen gar nichts. Dieselbe Szene Single-Threaded und die textfreie Szene Paths Multi-Threaded liefen jedes Mal sauber.

Das passt zu [flutter/flutter#190039](https://github.com/flutter/flutter/issues/190039). Laut Beschreibung des Fixes wird Multi-Threaded-skwasm mit `-sWASM_WORKERS`, aber ohne `-pthread` kompiliert und linkt daher die Single-Threaded-Systembibliotheken von emscripten, in denen Mutexe No-ops sind. Das Text-Layout auf dem Hauptthread und der Raster-Worker teilen sich dann den globalen `SkStrikeCache` von Skia und beschädigen den Heap, wenn sich der Text in jedem Frame ändert. Der Fix, [PR #190048](https://github.com/flutter/flutter/pull/190048) ("Use thread local strike caches in skwasm"), wurde am 2026-08-05 gemergt und ist Teil von 3.48.0-0.5.pre. Mit derselben App, neu kompiliert auf dieser Beta, waren 5 von 5 Läufen stabil und ohne `RuntimeError`. Eine Cherry-Pick-Anfrage für Stable ([#192115](https://github.com/flutter/flutter/pull/192115)) wurde am 2026-09-01 ohne Merge geschlossen, und kein 3.47.x-Release bis einschließlich 3.47.4 enthält den Fix.

Bis Sie auf 3.48 Stable sind, behalten Sie den Wasm-Build und schalten das Threading in `web/flutter_bootstrap.js` ab:

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

Single-Threaded-skwasm schlug CanvasKit bei den dargestellten Frames immer noch um 36 %, Sie verzichten also auf den Multi-Threading-Bonus, nicht auf den Wasm-Gewinn. Das Weglassen der COOP/COEP-Header hat denselben Effekt, aber das Config-Flag lässt sich später leichter zurücknehmen.

Zwei Notausgänge in derselben Konfiguration sind wissenswert. `renderer: 'canvaskit'` lässt den Loader den Wasm-Eintrag überspringen und den `dart2js`-Build laden. In meinen Läufen auf 3.47.4 funktionierte das aus einem `--wasm`-Build heraus und meldete `dart.tool.dart2wasm == false`, ein Query-String-Schalter wie der oben liefert Ihnen also einen Notschalter für die Produktion. Und `verboseBuildSelection: true` (neu in 3.47.0) protokolliert, warum jeder Kandidaten-Build übersprungen wurde, was der schnellste Weg ist, die Frage "warum ist dieser Nutzer auf CanvasKit" zu beantworten.

## Die Empfehlung, noch einmal zusammengefasst

Kompilieren Sie mit `flutter build web --wasm` und lassen Sie den Loader skwasm an Chromium und CanvasKit an alle anderen ausliefern. Fügen Sie auf 3.47.x `forceSingleThreadedSkwasm: true` hinzu und entfernen Sie es, wenn Sie mit eingerichteten COOP/COEP-Headern auf 3.48 Stable umsteigen. Greifen Sie nur dann auf einen reinen CanvasKit-Build zurück, wenn eine Abhängigkeit `dart2wasm` blockiert. Die Engines rasterisieren etwa gleich schnell. Was Sie eigentlich wählen, ist `dart2wasm` für Ihren eigenen Dart-Code, und 2026 ist das die schnellere und kleinere Option, wo immer der Browser es zulässt.

## Verwandte Artikel

- [Eine Flutter-Web-App mit WebAssembly kompilieren](/de/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) führt von Anfang bis Ende durch den `--wasm`-Build, einschließlich des Nachweises, welchen Build ein Browser geladen hat.
- [Eine Flutter-Web-App von `dart:html` zu `package:web` migrieren](/de/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/) ist die Voraussetzung, wenn der Wasm-Probelauf Ihren Code bemängelt.
- [Fix: Flutter Web liefert nach dem Neuladen einen veralteten, gecachten Build aus](/de/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) behandelt die `Cache-Control`-Header, die in derselben Host-Konfiguration neben COOP/COEP stehen.
- [Flutter 3.47 macht Impeller zum Standard-Renderer auf dem Desktop](/de/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) behandelt den anderen Renderer-Wechsel im selben Release.

## Quellen

- [Support for WebAssembly (Wasm)](https://docs.flutter.dev/platform-integration/web/wasm): Browserunterstützung, erforderliche Header, Flag für Deferred Loading.
- [Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization): `canvasKitVariant`, `forceSingleThreadedSkwasm` und die übrigen Konfigurationsoptionen des Loaders.
- Quellcode von Loader und Engine in 3.47.4: [`browser_environment.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js), [`loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/loader.js), [`skwasm_loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/skwasm_loader.js), [`canvaskit_loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/canvaskit_loader.js).
- Quellcode des Tools in 3.47.4: [`build_web.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/commands/build_web.dart), [`compile.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/web/compile.dart), [`resident_web_runner.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/isolated/resident_web_runner.dart).
- [flutter/flutter#190039](https://github.com/flutter/flutter/issues/190039), [PR #190048](https://github.com/flutter/flutter/pull/190048) und [PR #192115](https://github.com/flutter/flutter/pull/192115): der Multi-Threaded-Absturz von skwasm, sein Fix und der geschlossene Cherry-Pick für Stable.
- [Flutter 3.47.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0): `verboseBuildSelection`, Entfernung der Codecs aus der Chromium-Variante von CanvasKit.
- [PR #159314](https://github.com/flutter/flutter/pull/159314): Entfernung des Flags `--web-renderer`.
- [Mozilla-Bug 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206) und [WebKit-Bug 267291](https://bugs.webkit.org/show_bug.cgi?id=267291): warum Firefox und Safari nicht auf der Wasm-Allowlist stehen.
