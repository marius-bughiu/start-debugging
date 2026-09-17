---
title: "CanvasKit vs skwasm para Flutter web en 2026: ¿qué renderizador deberías publicar?"
description: "Publica skwasm con flutter build web --wasm cuando tus dependencias compilen a Wasm: descarga menos y presentó un 36% más de frames que CanvasKit en una escena pesada. En Flutter 3.47.x, mantenlo en un solo hilo hasta que la corrección del crash de texto multihilo salga de beta."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "flutter"
  - "flutter-web"
  - "webassembly"
  - "performance"
lang: "es"
translationOf: "2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026"
translatedBy: "claude"
translationDate: 2026-09-17
---

Publica skwasm. En Flutter 3.47.4 (el stable actual, Dart 3.13.3), `flutter build web --wasm` les da a los usuarios de Chromium una descarga más pequeña (1.65 MB frente a 1.98 MB con brotli para la app de benchmark de abajo) y 32.7 frames por segundo frente a 24.0 de CanvasKit en una escena pesada. Firefox, Safari y todos los navegadores de iOS siguen recibiendo CanvasKit desde la misma compilación. Quédate con una compilación solo de CanvasKit únicamente si alguna dependencia todavía importa `dart:html` o `package:js`. Una advertencia para 3.47.x: skwasm multihilo puede fallar en frames con mucho texto, así que fuerza el modo de un solo hilo hasta que 3.48 llegue a stable.

"Renderizador" es una palabra un poco engañosa aquí, porque no eliges CanvasKit o skwasm por sí solos. Desde que Flutter 3.29 eliminó el renderizador HTML y el flag `--web-renderer`, el renderizador se deriva del target de compilación. La salida de `dart2js` siempre corre sobre CanvasKit, y la salida de `dart2wasm` siempre corre sobre skwasm. La herramienta lo impone: `flutter build web --wasm --dart-define=FLUTTER_WEB_USE_SKIA=true --dart-define=FLUTTER_WEB_USE_SKWASM=false` termina con `Do not attempt to set a web renderer when using "--wasm"`. Así que la pregunta real es "compilación JavaScript o compilación Wasm", y la respuesta decide qué Skia corre por debajo.

## La matriz de características

| Propiedad (Flutter 3.47.4)          | CanvasKit                                           | skwasm                                                        |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| Target de compilación              | `dart2js`                                           | `dart2wasm` (requiere WasmGC)                                 |
| Comando de compilación             | `flutter build web`                                 | `flutter build web --wasm` (también genera la compilación CanvasKit) |
| Navegadores que lo cargan por defecto | Todos                                            | Solo Blink (Chrome, Edge, Opera, Chrome en Android)           |
| Descarga del motor, brotli         | 1.54 MB (variante Chromium), 2.26 MB (variante completa) | 1.21 MB (`skwasm.wasm`), 1.86 MB (`skwasm_heavy.wasm`)   |
| Rasteriza en                       | Hilo principal                                      | Un Web Worker cuando la página tiene aislamiento cross-origin |
| Headers necesarios para el mejor modo | Ninguno                                          | `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` |
| `dart:html`, `package:js` en el grafo | Sin problema                                     | Error de compilación                                          |
| Depuración con `flutter run -d chrome` | DevTools completo, hot reload con estado (DDC)  | Sin service protocol, el hot reload es un reinicio            |
| Carga diferida                     | Sí                                                  | Desactivada por defecto, flag experimental previsto para 3.50 |
| Problema conocido en el canal stable | Ninguno bloqueante                                | Crash multihilo con cambios de texto, #190039                 |

Dos filas necesitan una nota. La fila "Solo Blink" no tiene que ver con el soporte de WasmGC: Firefox y Safari ya validan WasmGC hoy. El loader de Flutter los mantiene fuera de skwasm con una allowlist fija en `browser_environment.js` (`blink: true, gecko: false, webkit: false`). La razón es que skwasm multihilo pasa los frames del worker a la página con `OffscreenCanvas.transferToImageBitmap`, que es lento en ambos motores. Los bugs de seguimiento, [Mozilla 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206) y [WebKit 267291](https://bugs.webkit.org/show_bug.cgi?id=267291), seguían ambos en `NEW` en septiembre de 2026.

La fila de depuración sale directamente de `resident_web_runner.dart` en 3.47.4: `supportsServiceProtocol` es `!debuggingOptions.webUseWasm && isRunningDebug && ...`, y `reloadIsRestart` devuelve `true` siempre que `webUseWasm` está activado. Por eso el desarrollo del día a día se queda en la ruta de JavaScript incluso para equipos que publican Wasm.

## Qué descarga realmente cada compilación

Una compilación `--wasm` escribe ambos pipelines en `build/web`, y `flutter_bootstrap.js` lleva un `buildConfig` que los lista en orden de prioridad:

```jsonc
// flutter build web --wasm, Flutter 3.47.4
"builds": [
  {"compileTarget": "dart2wasm", "renderer": "skwasm", "mainWasmPath": "main.dart.wasm", "jsSupportRuntimePath": "main.dart.mjs"},
  {"compileTarget": "dart2js", "renderer": "canvaskit", "mainJsPath": "main.dart.js"}
]
```

El loader toma la primera entrada compatible. Dentro de cada renderizador elige luego una variante según las características del navegador. `canvaskit_loader.js` carga `canvaskit/chromium/canvaskit.wasm` cuando el navegador tiene tanto `ImageDecoder` como `Intl.v8BreakIterator`. Esa variante deja los códecs de imagen y los datos de ICU al navegador, y Flutter 3.47.0 le quitó los códecs restantes ([#178133](https://github.com/flutter/flutter/pull/178133)). Todo lo demás recibe el `canvaskit.wasm` completo. `skwasm_loader.js` tiene la misma división: `skwasm.wasm` en Chromium, y el más grande `skwasm_heavy.wasm` en cualquier lugar donde falten esas dos APIs. En la práctica solo ves `skwasm_heavy` si sobrescribes la allowlist para poner Firefox o Safari en Wasm.

Medí lo que cuesta una primera visita en cada ruta, usando la compilación release de la app de benchmark descrita más abajo (una app Material de unas 180 líneas). Los tamaños son `brotli -q 11` y `gzip -9` de los archivos que descarga cada ruta. `flutter.js`, `flutter_bootstrap.js`, las fuentes y los assets son iguales en todas las rutas, así que quedan fuera:

| Ruta (Flutter 3.47.4)       | Código de la app                      | JS + Wasm del renderizador | Total brotli | Total gzip |
| --------------------------- | ------------------------------------- | ------------------ | ------------ | ---------- |
| CanvasKit, variante Chromium | `main.dart.js` 413 KB                | 1,564 KB           | **1,977 KB** | 2,612 KB   |
| CanvasKit, variante completa | `main.dart.js` 413 KB                | 2,281 KB           | **2,695 KB** | 3,465 KB   |
| skwasm                      | `main.dart.wasm` 416 KB + `.mjs` 6 KB | 1,225 KB           | **1,647 KB** | 2,083 KB   |

A este tamaño el código de la app queda empatado: 1.42 MB de Wasm sin comprimir y 1.79 MB de JavaScript minificado sin comprimir se comprimen casi al mismo tamaño con brotli. El ahorro viene del motor, ya que `skwasm.wasm` es unos 330 KB más pequeño que el CanvasKit de Chromium. Una advertencia para apps grandes: `dart2wasm` no divide los imports diferidos por defecto, así que una app que depende de `deferred as` para mantener pequeña su primera carga puede ver cómo la ruta Wasm pierde esa ventaja.

## El benchmark

El tamaño de descarga es solo la mitad de la historia. La otra mitad es el tiempo por frame, así que rendericé las mismas escenas con cada configuración.

**Entorno.** Apple M4, 16 GB de RAM, macOS 26. Google Chrome 153.0.8010.48 lanzado con `--headless=new --use-angle=metal` (WebGL reportó `ANGLE Metal Renderer: Apple M4`), una ventana de 1280x800 con DPR 1 y un perfil nuevo por ejecución. La app se compiló en modo release con Flutter 3.47.4 y con 3.48.0-0.5.pre, usando `flutter build web --wasm --no-web-resources-cdn`, y se sirvió desde localhost con `Cache-Control: no-store`. Un puerto enviaba `Cross-Origin-Opener-Policy: same-origin` y `Cross-Origin-Embedder-Policy: require-corp`, y otro no enviaba ninguno.

**Metodología.** Una sola compilación `--wasm` sirvió todas las configuraciones. Un `flutter_bootstrap.js` personalizado leía el renderizador desde el query string, así que las ejecuciones de CanvasKit usaron exactamente el mismo fallback `main.dart.js` que descargan los usuarios reales de Firefox:

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

Dentro de la app, `SchedulerBinding.instance.addTimingsCallback` recolectó `FrameTiming`s durante 10 segundos después de un calentamiento de 3 segundos. En la web, el `FrameTimingRecorder` del motor los registra alrededor de cada llamada `draw` del rasterizador. "Fps presentados" es el número de timings (frames que terminaron de rasterizarse) por segundo, y cada celda es la mediana de 3 ejecuciones (5 para skwasm multihilo en 3.48). En 3.48.0-0.5.pre, CanvasKit (24.0 fps) y skwasm de un solo hilo (32.3 fps) quedaron dentro de un 2% de sus números en 3.47.4, así que las tablas muestran 3.47.4 donde corrió sin problemas. La escena "tiles" son 600 `Container`s rotando con un degradado, esquinas redondeadas, un `BoxShadow` y un `Text` cuyo contenido cambia en cada frame. La escena "paths" es un `CustomPainter` trazando 400 paths animados de 40 segmentos.

**Escena tiles (pesada):**

| Configuración                          | Fps presentados | Build p50 | Raster p50 | Frame span p90 | Primer frame |
| -------------------------------------- | ------------- | --------- | ---------- | -------------- | ----------- |
| CanvasKit, variante Chromium (3.47.4)  | 24.0          | 24.2 ms   | 17.1 ms    | 44.0 ms        | 285 ms      |
| CanvasKit, variante completa (3.47.4)  | 24.3          | 23.7 ms   | 17.2 ms    | 42.9 ms        | 286 ms      |
| skwasm, un solo hilo (3.47.4)          | **32.7**      | 13.6 ms   | 16.0 ms    | 31.4 ms        | 193 ms      |
| skwasm, multihilo (3.47.4)             | detenido      | n/a       | n/a        | n/a            | 245 ms      |
| skwasm, multihilo (3.48.0-0.5.pre)     | **39.3**      | 14.7 ms   | 22.5 ms    | 48.0 ms        | 238 ms      |

**Escena paths (ligera):**

| Configuración (3.47.4)      | Fps presentados | Build p50 | Raster p50 |
| --------------------------- | ------------- | --------- | ---------- |
| CanvasKit, variante Chromium | 60.4         | 3.3 ms    | 3.0 ms     |
| skwasm, un solo hilo        | 60.0          | 1.2 ms    | 3.9 ms     |
| skwasm, multihilo           | 59.9          | 1.1 ms    | 4.1 ms     |

Destacan cuatro cosas:

1. **La mayor parte de la ganancia es `dart2wasm`, no Skia.** El tiempo de rasterización es casi idéntico (17.1 ms frente a 16.0 ms en tiles, y CanvasKit es de hecho más rápido en paths). La fase de build, es decir, tu código Dart de widgets, layout y paint, corre aproximadamente el doble de rápido cuando se compila a WasmGC. Cuanto más trabajo del framework por frame, mayor la diferencia.
2. **El multihilo cambia latencia por throughput.** En la beta 3.48, la compilación multihilo presentó un 22% más de frames que la de un solo hilo (39.3 frente a 32.3 fps), mientras que su raster p50 subió a 22.5 ms. El hilo de UI construye el siguiente frame mientras el worker todavía rasteriza el anterior. `Renderer.renderScene` conserva solo la escena pendiente más reciente y descarta el resto. El resultado son más frames en total y un span más largo por frame.
3. **Las escenas ligeras topan en vsync de cualquier forma.** Si tu app son formularios y listas, no verás la diferencia de renderizador en la tasa de frames. Verás la diferencia en descarga y arranque.
4. **El primer frame en localhost favorece a skwasm de un solo hilo por unos 90 ms** (193 ms frente a 285 ms; en modo multihilo, levantar el worker de renderizado devuelve parte de esa ventaja). Sin la red de por medio, esa diferencia es costo de compilación e instanciación. En una conexión real, la diferencia de 330 KB con brotli se suma.

Toma los números absolutos como específicos de un M4 corriendo Metal. Lo que se transfiere son las proporciones.

## Cuándo elegir skwasm

- **Tu audiencia es mayormente Chrome o Edge de escritorio, o Chrome en Android.** Esos son los usuarios que realmente reciben la compilación Wasm, y obtienen gratis la descarga más pequeña y la fase de build más rápida. Todos los demás vuelven a CanvasKit de forma transparente.
- **Tus frames son intensivos en framework.** Dashboards, grillas de datos y listas animadas pasan su tiempo en build y layout, que es exactamente donde `dart2wasm` tomó la delantera en el benchmark.
- **Controlas los headers de respuesta.** El modo multihilo necesita `Cross-Origin-Opener-Policy: same-origin` y `Cross-Origin-Embedder-Policy: credentialless` (o `require-corp`). Sin ellos skwasm sigue funcionando, en un solo hilo, y registra una advertencia que puedes silenciar con `suppressMultithreadingWarning: true`.
- **Todo tu grafo de dependencias está en `package:web` y `dart:js_interop`.** Un `flutter build web` normal ejecuta un dry run de Wasm en cada compilación e imprime "Wasm dry run succeeded" o los imports problemáticos, así que ya lo sabes.

## Cuándo elegir CanvasKit

- **Una dependencia todavía importa `dart:html`, `dart:js` o `package:js`.** `dart2wasm` se niega a compilarla, así que la decisión está tomada hasta que ese paquete migre.
- **La mayor parte de tu tráfico es iOS o Safari.** Esos usuarios reciben CanvasKit de una compilación `--wasm` de todos modos. La compilación Wasm solo añade tiempo de compilación y un segundo pipeline que probar, sin ningún beneficio para ellos.
- **Incrustas contenido cross-origin y no puedes adoptar COEP.** Iframes de terceros, scripts de anuncios o imágenes sin headers CORS pueden romperse bajo `require-corp`, y `credentialless` elimina las cookies de esas solicitudes. skwasm de un solo hilo no necesita headers, pero pierdes la ganancia de throughput.
- **Necesitas carga diferida para el tamaño de la primera carga.** Hasta que la carga diferida de Wasm deje su flag experimental, una compilación JavaScript con imports `deferred as` puede arrancar más pequeña que un `main.dart.wasm` monolítico.

## La trampa que decide por ti en 3.47.x

En la escena tiles, skwasm multihilo en Flutter 3.47.4 se detuvo en 6 de 7 ejecuciones. En cuatro de ellas, `requestAnimationFrame` siguió disparándose y el framework siguió construyendo a 60 fps, pero no llegaron `FrameTiming`s después de los primeros frames, así que nada nuevo llegó a la pantalla. En las otras dos, la página dejó de ejecutar por completo los timers de Dart. La consola de Chrome mostró `Uncaught RuntimeError: null function` y `table index is out of bounds` desde `skwasm.wasm` en algunas ejecuciones, y nada en absoluto en otras. La misma escena en un solo hilo, y la escena paths sin texto en multihilo, corrieron sin problemas todas las veces.

Eso coincide con [flutter/flutter#190039](https://github.com/flutter/flutter/issues/190039). Según la descripción de la corrección, skwasm multihilo se compila con `-sWASM_WORKERS` pero sin `-pthread`, así que enlaza las bibliotecas de sistema de un solo hilo de emscripten, donde los mutex no hacen nada. El layout de texto en el hilo principal y el worker de rasterización comparten entonces el `SkStrikeCache` global de Skia y corrompen el heap cuando el texto cambia en cada frame. La corrección, [PR #190048](https://github.com/flutter/flutter/pull/190048) ("Use thread local strike caches in skwasm"), se fusionó el 2026-08-05 y forma parte de 3.48.0-0.5.pre. Con la misma app recompilada en esa beta, 5 de 5 ejecuciones fueron estables sin ningún `RuntimeError`. Una solicitud de cherry-pick a stable ([#192115](https://github.com/flutter/flutter/pull/192115)) se cerró sin fusionarse el 2026-09-01, y ninguna versión 3.47.x hasta 3.47.4 incluye la corrección.

Hasta que estés en 3.48 stable, mantén la compilación Wasm y desactiva el multihilo en `web/flutter_bootstrap.js`:

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

skwasm de un solo hilo aun así superó a CanvasKit por un 36% en frames presentados, así que esto te cuesta el bono del multihilo, no la ganancia de Wasm. Omitir los headers COOP/COEP tiene el mismo efecto, pero el flag de configuración es más fácil de revertir después.

Vale la pena conocer dos vías de escape en la misma configuración. `renderer: 'canvaskit'` hace que el loader se salte la entrada Wasm y cargue la compilación `dart2js`. En mis ejecuciones en 3.47.4 eso funcionó desde una compilación `--wasm` y reportó `dart.tool.dart2wasm == false`, así que un interruptor por query string como el de arriba te da un kill switch para producción. Y `verboseBuildSelection: true` (nuevo en 3.47.0) registra por qué se descartó cada compilación candidata, que es la forma más rápida de responder "por qué este usuario está en CanvasKit".

## La recomendación, de nuevo

Compila con `flutter build web --wasm` y deja que el loader le entregue skwasm a Chromium y CanvasKit a todos los demás. En 3.47.x, añade `forceSingleThreadedSkwasm: true` y quítalo cuando pases a 3.48 stable con los headers COOP/COEP configurados. Recurre a una compilación CanvasKit simple solo cuando una dependencia bloquee `dart2wasm`. Los motores rasterizan a una velocidad similar. Lo que realmente estás eligiendo es `dart2wasm` para tu propio código Dart, y en 2026 esa es la opción más rápida y más pequeña donde el navegador lo permite.

## Relacionado

- [Cómo compilar una app de Flutter web con WebAssembly](/es/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) recorre la compilación `--wasm` de principio a fin, incluido cómo comprobar qué compilación cargó un navegador.
- [Migrar una app de Flutter web de `dart:html` a `package:web`](/es/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/) es el requisito previo si el dry run de Wasm señala tu código.
- [Solución: Flutter web sirve una compilación en caché obsoleta después de recargar](/es/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) cubre los headers `Cache-Control` que viven junto a COOP/COEP en la misma configuración del host.
- [Flutter 3.47 convierte a Impeller en el renderizador por defecto en escritorio](/es/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) cubre el otro cambio de renderizador en la misma versión.

## Fuentes

- [Support for WebAssembly (Wasm)](https://docs.flutter.dev/platform-integration/web/wasm): soporte de navegadores, headers requeridos, flag de carga diferida.
- [Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization): `canvasKitVariant`, `forceSingleThreadedSkwasm` y las demás opciones de configuración del loader.
- Código fuente del loader y del motor en 3.47.4: [`browser_environment.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js), [`loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/loader.js), [`skwasm_loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/skwasm_loader.js), [`canvaskit_loader.js`](https://github.com/flutter/flutter/blob/3.47.4/engine/src/flutter/lib/web_ui/flutter_js/src/canvaskit_loader.js).
- Código fuente de la herramienta en 3.47.4: [`build_web.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/commands/build_web.dart), [`compile.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/web/compile.dart), [`resident_web_runner.dart`](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/isolated/resident_web_runner.dart).
- [flutter/flutter#190039](https://github.com/flutter/flutter/issues/190039), [PR #190048](https://github.com/flutter/flutter/pull/190048) y [PR #192115](https://github.com/flutter/flutter/pull/192115): el crash de skwasm multihilo, su corrección y el cherry-pick a stable cerrado.
- [Notas de la versión de Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0): `verboseBuildSelection`, eliminación de códecs de la variante Chromium de CanvasKit.
- [PR #159314](https://github.com/flutter/flutter/pull/159314): eliminación del flag `--web-renderer`.
- [Bug de Mozilla 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206) y [bug de WebKit 267291](https://bugs.webkit.org/show_bug.cgi?id=267291): por qué Firefox y Safari no están en la allowlist de Wasm.
