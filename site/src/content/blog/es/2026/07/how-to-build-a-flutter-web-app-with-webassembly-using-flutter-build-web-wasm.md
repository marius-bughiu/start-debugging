---
title: "Cómo compilar una app web de Flutter con WebAssembly usando flutter build web --wasm"
description: "Guía completa para publicar una app web de Flutter compilada a WebAssembly en Flutter 3.44: cómo son las dos compilaciones que se emiten, por qué Firefox y Safari siguen recibiendo JavaScript por el wasmAllowList del loader, la migración desde dart:html hacia dart2wasm, los headers COOP/COEP que deciden si skwasm corre multihilo, y cómo comprobar en runtime qué compilación cargó realmente el navegador."
pubDate: 2026-07-28
template: how-to
tags:
  - "flutter"
  - "dart"
  - "webassembly"
  - "flutter-web"
  - "performance"
  - "how-to"
lang: "es"
translationOf: "2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm"
translatedBy: "claude"
translationDate: 2026-07-28
---

Para compilar una app web de Flutter con WebAssembly, agrega el flag `--wasm`: `flutter build web --wasm`. Ese único flag hace que la herramienta emita *dos* compilaciones en `build/web`: una compilación WasmGC generada por `dart2wasm` que usa el renderer `skwasm`, y la compilación habitual de `dart2js` que usa `canvaskit` como respaldo. Un `flutter_bootstrap.js` generado elige una al cargar la página. Después, dos cosas deciden si los usuarios reales obtienen la compilación Wasm: nada en tu grafo de dependencias puede importar `dart:html`, `dart:js`, `dart:js_util` ni `package:js`, y tu servidor debe enviar `Cross-Origin-Opener-Policy: same-origin` más `Cross-Origin-Embedder-Policy: credentialless` o `skwasm` cae en silencio a un solo hilo. Este artículo apunta a Flutter 3.44 stable (publicado el 2026-05-18, incluye Dart 3.10) y cada detalle está verificado contra la rama `stable` de `flutter/flutter`. La advertencia importante desde el principio: a partir de 3.44 el loader solo habilita la compilación Wasm en navegadores Blink, así que Firefox, Safari y todos los navegadores en iOS reciben la compilación JavaScript sin importar qué compiles.

## Qué pone realmente `--wasm` en build/web

El modelo mental que la mayoría tiene es incorrecto de una forma útil. `--wasm` no cambia tu compilación de JavaScript a WebAssembly. *Agrega* una compilación WebAssembly junto a la de JavaScript. En `packages/flutter_tools/lib/src/commands/build_web.dart`, pasar el flag produce una lista de dos configuraciones de compilador, un `WasmCompilerConfig` y un `JsCompilerConfig`, y la herramienta ejecuta ambos compiladores. Sin el flag obtienes un `JsCompilerConfig` real más un `WasmCompilerConfig` marcado con `dryRun: true`, que compila pero descarta el resultado (más sobre eso en un momento).

Cada objetivo compilado aporta una descripción de compilación a un `flutter_bootstrap.js` generado. Después de `flutter build web --wasm` en Flutter 3.44, el descriptor se ve así:

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

El orden importa: `FlutterLoader.load()` llama a `buildConfig.builds.find(buildIsCompatible)` y toma la *primera* entrada compatible, así que la compilación Wasm gana siempre que el entorno lo permita. El emparejamiento del renderer no es configurable. `WebRendererMode.defaultForWasm` es `skwasm` y `defaultForJs` es `canvaskit`, y la herramienta no te deja mezclarlos, lo que constituye el primer detalle problemático más abajo.

En disco obtienes `main.dart.wasm` (el módulo), `main.dart.mjs` (el runtime de soporte JS que lo instancia) y `main.dart.js` (el respaldo), además de las cargas de cada renderer: `skwasm.js` y `skwasm.wasm` para la ruta Wasm, y el bundle de CanvasKit para la ruta de respaldo.

## Los cinco pasos que realmente importan

1. **Usa Flutter 3.24 o posterior.** La compilación a Wasm llegó a stable en 3.24; aquí probé con 3.44. Si haces malabares con versiones del SDK por proyecto, mis notas sobre [ejecutar un mismo proyecto de Flutter contra varias versiones del SDK en CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) se aplican sin cambios a las compilaciones Wasm.
2. **Regenera `web/index.html` si es anterior a Flutter 3.22.** La ruta Wasm depende por completo del loader `flutter_bootstrap.js`, así que el viejo bootstrap con `serviceWorkerVersion` no funcionará. `flutter create . --platforms web` después de borrar `web/` te da la plantilla actual.
3. **Saca de tu grafo de dependencias las incompatibilidades con `dart2wasm`.** Compila primero con `flutter build web` sin `--wasm` y lee los hallazgos del dry run.
4. **Compila:** `flutter build web --wasm`.
5. **Sírvelo con headers de aislamiento de origen cruzado.** Sin ellos la app igual funciona, pero con un solo hilo, lo que desperdicia la mayor parte de la razón para usar Wasm.

## Por qué tu app sigue ejecutando JavaScript en Firefox y Safari

Esta es la parte que sorprende a la gente, y la página oficial de soporte de Wasm está lo bastante desactualizada (su frontmatter `last-update` dice Nov 6, 2024) como para que leerla no explique el comportamiento actual. WasmGC ya no es la restricción: alcanzó Baseline en Chrome 119, Firefox 120 y Safari 18.2. La restricción es una lista de permitidos codificada en el loader del engine.

`engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js` en `stable` contiene exactamente esto:

```javascript
// engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js
export const defaultWasmSupport = {
  "blink": true,
  "gecko": false,
  "webkit": false,
  "unknown": false,
}
```

Y `loader.js` condiciona la compilación `skwasm` a esa lista:

```javascript
// engine/src/flutter/lib/web_ui/flutter_js/src/loader.js
const supportsDart2Wasm = browserEnvironment.supportsWasmGC;
const supportsSkwasm = supportsDart2Wasm && browserEnvironment.webGLVersion > 0;

const enableWasm = config.wasmAllowList?.[browserEnvironment.browserEngine]
  ?? defaultWasmSupport[browserEnvironment.browserEngine];
```

Así que en Firefox, `supportsWasmGC()` devuelve `true` (el detector valida un módulo WasmGC mínimo y Firefox lo pasa), pero `enableWasm` resuelve a `false` por la entrada `gecko`, la compilación `skwasm` se rechaza como incompatible, y el loader cae a `dart2js` + `canvaskit`. La misma historia para Safari vía `webkit`. La razón no es WasmGC sino el renderer: el `skwasm` multihilo de Flutter se apoya en `OffscreenCanvas.transferToImageBitmap`, y tanto el bug de Firefox (Bugzilla 1788206) como el de WebKit (267291) que rastrean su costo seguían abiertos cuando lo verifiqué en julio de 2026.

Puedes sobrescribir la lista de permitidos tú mismo, algo que vale la pena hacer detrás de un parámetro de query si quieres números reales en vez de opiniones:

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

No lo publiques en producción por intuición. Mídelo primero con el flujo de [perfilar jank en una app de Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/), porque en los engines afectados el modo de falla es un tiempo de frame degradado, no un error limpio.

Hay un límite que no admite ninguna sobrescritura: todos los navegadores en iOS están obligados a usar WebKit, así que una app de Flutter compilada a Wasm no puede correr en iOS Safari, iOS Chrome ni nada más en esa plataforma.

## Hacer que tus dependencias compilen

`dart2wasm` solo admite el interop estático de JS de Dart. Cualquier import transitivo de `dart:html`, `dart:js`, `dart:js_util` o `package:js` hace fallar la compilación con mensajes como estos:

```output
Dart library 'dart:html' is not available on this platform.
JS interop library 'dart:js_util' can't be imported when compiling to Wasm.
Try using 'dart:js_interop' or 'dart:js_interop_unsafe' instead.
```

La buena noticia es que no tienes que descubrirlo intentándolo. `--wasm-dry-run` está en `true` por defecto, así que un `flutter build web` normal ya ejecuta `dart2wasm` en modo dry run e informa lo que encontró:

```output
Wasm dry run findings:
...
Consider addressing these issues to enable wasm builds. See docs for more info:
https://docs.flutter.dev/platform-integration/web/wasm
```

Si tu app ya está limpia, el mismo mecanismo te empuja en la otra dirección con `Wasm dry run succeeded. Consider building and testing your application with the --wasm flag.` En cualquier caso, `flutter build web --no-wasm-dry-run` lo silencia una vez que tomaste tu decisión.

Para el código que te pertenece, la migración es `package:web` en lugar de `dart:html` y `dart:js_interop` en lugar de `package:js`:

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

Tres diferencias muerden durante la migración. Los nombres siguen el IDL del navegador, así que `HtmlElement` pasa a ser `HTMLElement` e `innerHtml` pasa a ser `innerHTML`. `querySelectorAll` devuelve un iterable que no es una `List`. Y como los tipos de interop son extension types, `is` y `as` no hacen lo que esperas; usa `isA<T>()` en su lugar. Los imports condicionales también cambian: la guarda ahora es `dart.library.js_interop`, no `dart.library.html`. Si escribes el interop a mano en vez de usar un plugin, los patrones de [agregar código específico de plataforma en Flutter sin plugins](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) se trasladan directamente.

Para el código que no te pertenece, filtra pub.dev por `is:wasm-ready`. Cuando una dependencia es el bloqueo, actualizarla suele ser toda la solución, y aplica el dolor habitual de resolución de restricciones; si terminas en el infierno del resolver, [Solución: Version solving failed en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/) cubre la salida.

## COOP y COEP deciden si obtienes hilos

Flutter compila `skwasm` con memoria compartida. Se ve en la invocación del compilador en `build_system/targets/web.dart`, que agrega `--import-shared-memory` y `--shared-memory-max-pages=32768` para el renderer `skwasm`. La memoria compartida en un navegador requiere aislamiento de origen cruzado, que requiere dos headers de respuesta. La herramienta codifica el par que quiere:

```dart
// packages/flutter_tools/lib/src/web/web_constants.dart, Flutter 3.44
const kCrossOriginIsolationHeaders = <String, String>{
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};
```

`flutter run -d chrome --wasm` los envía desde su propio servidor de desarrollo, que es exactamente la razón por la que el problema nunca aparece en local y después aparece en producción. No hay ningún error cuando faltan. `skwasm_loader.js` calcula `skwasmSingleThreaded: ... || !browserEnvironment.crossOriginIsolated || ...` y arranca en silencio un engine de un solo hilo.

Para nginx:

```nginx
# nginx, serving build/web
location / {
    add_header Cross-Origin-Opener-Policy   same-origin   always;
    add_header Cross-Origin-Embedder-Policy credentialless always;
    try_files $uri $uri/ /index.html;
}
```

Para Firebase Hosting:

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

Verifica en la consola del navegador con `window.crossOriginIsolated`, que debe ser `true`. Ten en cuenta que GitHub Pages no puede enviar headers personalizados en absoluto, así que una compilación Wasm alojada ahí siempre correrá con un solo hilo.

El aislamiento de origen cruzado no es gratis. `require-corp` rompe cualquier subrecurso de origen cruzado que no se adhiera con `Cross-Origin-Resource-Policy`, lo que en la práctica significa imágenes de terceros, fuentes, beacons de analítica e iframes embebidos. `credentialless` es el más suave de los dos: carga subrecursos de origen cruzado sin credenciales en vez de bloquearlos. Empieza con `credentialless` y luego audita el panel de red buscando solicitudes que perdieron sus cookies.

## Comprobar qué compilación cargó el navegador

No lo deduzcas con un cronómetro. El compilador define una variable de entorno que puedes leer:

```dart
// Flutter 3.44, Dart 3.10
const isRunningWithWasm = bool.fromEnvironment('dart.tool.dart2wasm');
```

También hay una sonda de comportamiento que funciona sin recompilar, basada en que Wasm usa la representación nativa de números:

```dart
final isRunningWithWasm = identical(double.nan, double.nan);
```

El panel de red es la tercera comprobación: una solicitud de `main.dart.wasm` significa la compilación Wasm, `main.dart.js` significa el respaldo.

## Detalles que conviene conocer antes de publicar

**Fijar un renderer con `--wasm` es un error fatal.** `build_web.dart` llama a `throwToolExit('Do not attempt to set a web renderer when using "--wasm"')` cuando el renderer resuelto no es `skwasm`. Así que `--wasm` combinado con `--dart-define=FLUTTER_WEB_USE_SKIA=true` falla en la CLI, por diseño.

**`config.renderer: 'canvaskit'` en una compilación Wasm falla en runtime.** `buildIsCompatible` rechaza cualquier compilación cuyo `renderer` no coincida con el valor configurado, y una compilación `--wasm` no contiene ninguna entrada `dart2wasm` + `canvaskit`. Todos los candidatos quedan filtrados y el loader lanza `FlutterLoader could not find a build compatible with configuration and environment.` Esto se rastrea como flutter/flutter#183265. Quita la clave `renderer`, o ponla en `skwasm`.

**Los engines que no son Chromium cargan una carga de renderer más pesada.** `loadSkwasm` elige `skwasm_heavy` en lugar de `skwasm` cuando al navegador le faltan `ImageDecoder` o los iteradores de saltos de Chromium, así que si fuerzas la apertura de la lista de permitidos, también pagas una descarga mayor.

**Las extensiones de Chrome se fuerzan a un solo hilo.** El loader detecta `chrome.runtime.id` y desactiva los hilos, porque la CSP de las extensiones bloquea la carga dinámica de scripts que necesitan los workers.

**Los nombres de símbolos se eliminan por defecto.** `--strip-wasm` es `true` por defecto. Pasa `--no-strip-wasm` cuando necesites trazas de pila legibles de una compilación de perfilado, y `--source-maps` para emitir `main.dart.wasm.map`.

**Wasm no arregla el SEO.** Ambas compilaciones pintan en un canvas, así que los crawlers siguen viendo casi nada de HTML semántico. Wasm hace que una app web de Flutter sea más rápida; no la convierte en un documento.

**La herramienta sigue llamando a esto nuevo.** `flutter build web --wasm` imprime un cuadro que dice `WebAssembly compilation is new. Understand the details before deploying to production.` Trátalo como algo preciso y no como texto de relleno: fija tu versión de Flutter y mantén la ruta de respaldo de JavaScript en tu matriz de pruebas, porque con la lista de permitidos actual esa es la ruta en la que está la mayoría de tus usuarios.

## Relacionados

- [Cómo perfilar jank en una app de Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)
- [Cómo agregar código específico de plataforma en Flutter sin plugins](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [Cómo apuntar a múltiples versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Solución: Version solving failed en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Migra una app Flutter 2 a Flutter 3.x: la lista de null safety](/es/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)

## Fuentes

- Documentación de Flutter, [Support for WebAssembly (Wasm)](https://docs.flutter.dev/platform-integration/web/wasm)
- Documentación de Flutter, [Flutter web app initialization](https://docs.flutter.dev/platform-integration/web/initialization)
- Documentación de Flutter, [Build and release a web app](https://docs.flutter.dev/deployment/web)
- Código de Flutter, [`packages/flutter_tools/lib/src/commands/build_web.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/build_web.dart)
- Código de Flutter, [`engine/src/flutter/lib/web_ui/flutter_js/src/loader.js`](https://github.com/flutter/flutter/blob/stable/engine/src/flutter/lib/web_ui/flutter_js/src/loader.js) y [`browser_environment.js`](https://github.com/flutter/flutter/blob/stable/engine/src/flutter/lib/web_ui/flutter_js/src/browser_environment.js)
- Issue de Flutter [#183265, FlutterLoader could not find a build compatible with configuration and environment](https://github.com/flutter/flutter/issues/183265)
- Documentación de Dart, [Migrate to package:web](https://dart.dev/interop/js-interop/package-web) y [WebAssembly (Wasm) compilation](https://dart.dev/web/wasm)
- web.dev, [WasmGC and Wasm tail call optimizations are now Baseline Newly available](https://web.dev/blog/wasmgc-wasm-tail-call-optimizations-baseline)
- Chrome for Developers, [COEP: credentialless](https://developer.chrome.com/blog/coep-credentialless-origin-trial)
