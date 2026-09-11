---
title: "Solución: Flutter web sirve una compilación antigua desde la caché después de recargar la pestaña del navegador"
description: "Una recarga solo revalida index.html, así que un main.dart.js sin hash sigue saliendo de la caché del navegador. Envía Cache-Control: no-cache para la salida de compilación de Flutter, agrega un build id donde no puedas configurar headers y deja que el service worker autolimpiable retire las cachés anteriores a la 3.41."
pubDate: 2026-09-11
template: how-to
tags:
  - "flutter"
  - "flutter-web"
  - "deployment"
  - "caching"
  - "how-to"
lang: "es"
translationOf: "2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload"
translatedBy: "claude"
translationDate: 2026-09-11
---

**Respuesta corta:** Flutter web genera puntos de entrada con nombres de archivo fijos (`flutter_bootstrap.js`, `main.dart.js`, `main.dart.wasm`, `canvaskit/...`), y una recarga normal del navegador solo revalida el documento HTML. Si tu hosting envía cualquier tiempo de vigencia para esos archivos (Firebase Hosting envía `max-age=3600`, GitHub Pages envía `max-age=600`), la página recargada recibe un `index.html` nuevo y un `main.dart.js` viejo desde la caché. Para solucionarlo, sirve toda la carpeta `build/web` con `Cache-Control: no-cache` o, en hostings donde no puedes configurar headers, agrega un build id a `flutter_bootstrap.js` y `main.dart.js` después de `flutter build web`. Si tus usuarios todavía tienen el service worker offline-first de Flutter 3.38 o anterior, sigue implementando el `flutter_service_worker.js` predeterminado: desde Flutter 3.41 es un worker autolimpiable que desregistra el anterior y recarga la pestaña.

Todo lo que sigue se reprodujo con Flutter 3.44.8 (Dart 3.12.2) y se contrastó con el código fuente de la herramienta y del motor en la 3.47.3, que se comportan igual para este problema. Las pruebas de navegador se ejecutaron en un navegador basado en Chromium contra un pequeño servidor Node que puede cambiar su política de `Cache-Control`.

## Dos cachés distintas, según cuándo publicaste por primera vez

Los resultados de búsqueda sobre este problema mezclan dos épocas, y la solución es diferente:

- **Flutter 3.38.x y anteriores** generaban un service worker offline-first. Servía cada archivo listado en su mapa `RESOURCES` directamente desde Cache Storage, solo pedía `index.html` con prioridad a la red y necesitaba una segunda carga para que una nueva implementación tomara el control. De ahí viene el clásico consejo de "tengo que recargar dos veces".
- **Flutter 3.41.0 y posteriores** ya no instalan un service worker de caché para los visitantes nuevos. El [PR #176834](https://github.com/flutter/flutter/pull/176834) (fusionado en octubre de 2025, primera versión estable en la 3.41.0) reemplazó el worker de 6 KB por un worker de limpieza de 784 bytes, y el loader de `flutter.js` solo lo registra cuando el origen ya tiene un registro. En una app nueva con 3.41+, la única caché que sigue en juego es la caché HTTP normal, y de eso trata principalmente este artículo.

Puedes confirmar en qué escenario estás abriendo DevTools, Application, Service workers. Si no hay ningún registro, la culpable es la caché HTTP.

## Por qué una recarga no descarga el nuevo main.dart.js

Mira lo que `flutter build web` pone en `build/web` en la 3.44.8:

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

Ninguno de estos nombres contiene un hash del contenido. `index.html` carga `flutter_bootstrap.js`, que incluye un `_flutter.buildConfig` cuyo `mainJsPath` es la cadena literal `"main.dart.js"`. Cada implementación reutiliza las mismas URLs, así que el navegador no puede distinguir una compilación nueva de una vieja solo por la URL.

Ahora combina eso con cómo funciona la recarga. La recarga de Chrome revalida el recurso principal y luego hace una carga de página normal. El artículo del equipo de Chromium de 2017 dice que el navegador eligió "only validate the main resource and continue with a regular page load" ([blog de Chromium](https://blog.chromium.org/2017/01/reload-reloaded-faster-and-leaner-page_26.html)). Los subrecursos que siguen vigentes según su `Cache-Control` salen directamente de la caché de disco sin ninguna solicitud. En una navegación simple (un marcador, una URL escrita, un enlace), todos los navegadores reutilizan las copias vigentes, incluido el propio `index.html`.

Así que si la recarga muestra la nueva compilación o no depende por completo de lo que tu hosting envía para esos archivos:

| Hosting | `Cache-Control` predeterminado para archivos estáticos | Ventana de contenido obsoleto tras una implementación |
| --- | --- | --- |
| Firebase Hosting | `max-age=3600` (observado en `*.firebaseapp.com`) | hasta 1 hora |
| GitHub Pages | `max-age=600`, no configurable | hasta 10 minutos |
| Netlify, Vercel, Cloudflare Pages | `public, max-age=0, must-revalidate` | ninguna |
| Nginx, Apache, `python -m http.server` sin configuración | sin header, pero se envía `Last-Modified` | heurística, ver abajo |

La última fila es la que atrapa a la gente. La ausencia del header `Cache-Control` no significa "no guardar en caché". Con un header `Last-Modified`, la [sección 4.2.2 del RFC 9111](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.2) permite que el navegador elija un tiempo de vigencia heurístico, normalmente el 10% del tiempo transcurrido desde la última modificación del archivo. Un `main.dart.js` que se implementó por última vez hace diez días puede considerarse vigente durante un día entero.

Firebase sí purga su CDN en cada implementación, así que el edge sirve los archivos nuevos de inmediato. La caché propia del navegador no se purga, y esa es la copia que usa una recarga.

## Reproducción mínima

Este servidor sirve `build/web` con una política intercambiable. `firebase` imita el comportamiento predeterminado de Firebase Hosting, `fixed` es la solución:

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

Y una app cuyo único trabajo es mostrar qué compilación se está ejecutando:

```dart
// lib/main.dart, Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

const build = 'A';

void main() => runApp(
  const MaterialApp(home: Scaffold(body: Center(child: Text('Build $build')))),
);
```

Pasos: compila con `build = 'A'`, inicia el servidor con `MODE=firebase` y abre `http://localhost:8765/`. Cambia la constante a `'B'`, ejecuta `flutter build web` de nuevo y recarga la pestaña. La página sigue diciendo "Build A". El registro del servidor para esa recarga muestra una sola solicitud:

```text
200 /index.html
```

`flutter_bootstrap.js`, `main.dart.js`, CanvasKit y las fuentes se sirvieron desde la caché del navegador. Repite toda la secuencia con `MODE=fixed` en un origen nuevo y la recarga muestra "Build B". Una segunda recarga sin una nueva implementación cuesta entonces una solicitud condicional por archivo, cada una respondida con un `304` y sin cuerpo.

## La solución, paso a paso

1. **Sirve la salida de compilación de Flutter con `Cache-Control: no-cache`.** `no-cache` no desactiva la caché. Le indica al navegador que conserve el archivo pero que lo revalide con `If-None-Match` o `If-Modified-Since` antes de cada uso. Los archivos sin cambios cuestan un viaje de ida y vuelta y un `304`. Los archivos modificados se descargan. Aplícalo a `index.html`, `flutter_bootstrap.js`, `flutter.js`, `flutter_service_worker.js`, `main.dart.js`, `main.dart.mjs`, `main.dart.wasm`, `version.json`, `manifest.json`, todo lo que está dentro de `assets/` y la carpeta local `canvaskit/`. La regla correcta más simple es "todo lo que hay en `build/web`".
2. **Pon la regla en la configuración de tu hosting.** Más abajo hay ejemplos para Firebase Hosting, Nginx y el archivo `_headers` que usan Netlify y Cloudflare Pages.
3. **Espera a que venza un tiempo de vigencia anterior.** Los nuevos headers solo se aplican a las respuestas descargadas después del cambio. Los navegadores que guardaron `main.dart.js` en caché con `max-age=3600` lo siguen usando hasta que se cumpla esa hora. Publica el cambio de headers una implementación antes de necesitarlo, o combínalo con un build id (paso 4) para el primer despliegue.
4. **Donde no puedas configurar headers, agrega un build id.** GitHub Pages es el caso habitual. Reescribe las URLs de los puntos de entrada después de cada compilación para que cada implementación tenga URLs nuevas.
5. **Avisa a las pestañas que ya están abiertas.** Los headers solo ayudan en la siguiente carga. Una pestaña que lleva mucho tiempo abierta sigue ejecutando la compilación vieja hasta que el usuario recarga, así que consulta periódicamente un pequeño archivo con el build id y ofrece una recarga.

### Firebase Hosting

La [FAQ de Flutter web](https://docs.flutter.dev/platform-integration/web/faq) sugiere `max-age=0,s-maxage=604800` para `js`, `mjs`, `wasm` y `json`, lo que mantiene la CDN caliente mientras obliga al navegador a revalidar. Su patrón deja fuera el HTML y `.bin`, y a las imágenes y fuentes les asigna `max-age=3600`, así que `index.html`, `assets/AssetManifest.bin` y cualquier imagen que hayas reemplazado con el mismo nombre quedan obsoletos durante una hora. Este `firebase.json` cubre toda la compilación:

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

Como Firebase purga su CDN en cada implementación, no necesitas `s-maxage` para que el edge sea correcto. Vuelve a agregarlo solo si mides un problema de latencia.

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

Mantén `etag on` (el valor predeterminado). Sin un validador, el navegador no tiene con qué revalidar y descarga el archivo completo cada vez.

### Netlify y Cloudflare Pages

Ambos usan por defecto `max-age=0, must-revalidate`, que se comporta correctamente. Si una configuración anterior o un preset de framework agregó un tiempo de vigencia más largo, sobrescríbelo con un archivo `_headers` en `web/` para que `flutter build web` lo copie a `build/web`:

```text
# web/_headers, copied to build/web by flutter build web (Flutter 3.44)
/*
  Cache-Control: no-cache
```

### GitHub Pages y otros hostings sin headers configurables

Ejecuta un pequeño script después de la compilación. Agrega `?v=<id>` a la etiqueta script de bootstrap y a las rutas de compilación dentro de `_flutter.buildConfig`, y escribe el id en `build_id.txt` para el paso 5:

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

Con una política `max-age=600`, una recarga después de implementar una compilación marcada pidió exactamente tres archivos (`index.html`, `flutter_bootstrap.js?v=...`, `main.dart.js?v=...`) y mostró la nueva compilación, mientras que CanvasKit y las fuentes siguieron saliendo de la caché. Este es el enfoque que describe la FAQ de Flutter, que aclara que Flutter no agrega build ids automáticamente. El propio `index.html` sigue sujeto al tiempo de vigencia de 10 minutos en una navegación simple (una recarga siempre lo revalida), y los assets que reemplaces con el mismo nombre no quedan cubiertos, así que renombra las imágenes modificadas en lugar de sobrescribirlas.

### Ofrece una recarga a las pestañas abiertas

Pasa el mismo id a la app en tiempo de compilación y compáralo con el `build_id.txt` implementado. `cache: 'no-store'` mantiene la propia comprobación fuera de la caché HTTP:

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

Dale a `MaterialApp` un `scaffoldMessengerKey` y llama a `startUpdateCheck` con él desde `main`. Al compilar con `--dart-define=BUILD_ID=A` e implementar un `build_id.txt` que contiene `B`, `newBuildAvailable()` devolvió `true` en la primera comprobación. Si no usas `bust.sh`, escribe `build_id.txt` en CI con el mismo id. Esto importa sobre todo cuando la API de tu backend cambia junto con el frontend, porque una pestaña vieja que llama a una API nueva es un bug peor que una UI vieja.

## Si publicaste el service worker antes de Flutter 3.41

Los usuarios que abrieron tu app por primera vez cuando se compilaba con 3.38.x o anterior todavía tienen el worker offline-first y su `flutter-app-cache` en el navegador. Esto es lo que ocurre la primera vez que cargan una implementación compilada con 3.41 o posterior, según el código fuente de la 3.44.8 y la 3.47.3:

1. El worker viejo sigue teniendo el control, así que responde a la navegación con prioridad a la red (`index.html` nuevo) pero sirve `flutter_bootstrap.js` y `main.dart.js` desde Cache Storage. Es posible que el usuario vea brevemente la compilación vieja.
2. La comprobación de actualización del service worker del navegador descarga `flutter_service_worker.js` desde la red. El archivo es distinto byte a byte (ahora es el worker de limpieza de 784 bytes), así que se instala.
3. El worker de limpieza llama a `skipWaiting()`, luego en `activate` llama a `self.registration.unregister()` y navega cada ventana que controla a su URL actual.
4. Esa navegación ocurre sin service worker, así que la página carga la compilación actual a través de la caché HTTP. Con los headers de la sección anterior, esa es la compilación nueva.

El worker de limpieza no elimina `flutter-app-cache`, `flutter-temp-cache` ni `flutter-app-manifest`. Sin un worker nadie las lee, pero siguen ocupando almacenamiento. Si eso te importa, elimínalas una vez al iniciar mediante la Cache Storage API (`caches.delete('flutter-app-cache')` y así sucesivamente, a través de `package:web`).

Dos errores de implementación bloquean este traspaso:

- **Quitar `flutter_service_worker.js` de la implementación.** Si la comprobación de actualización recibe un `404`, el navegador conserva el worker existente, y el worker viejo sigue sirviendo el `main.dart.js` viejo desde Cache Storage. Sigue publicando el archivo mientras puedas tener visitantes con la versión antigua.
- **Compilar con `--pwa-strategy=none` demasiado pronto.** El flag está oculto y obsoleto en la 3.44 e imprime una referencia a [flutter/flutter#156910](https://github.com/flutter/flutter/issues/156910). Con `none`, la herramienta escribe un `flutter_service_worker.js` vacío y elimina `serviceWorkerSettings` de `flutter_bootstrap.js`, así que nada desregistra el worker viejo. El navegador termina instalando el script vacío, pero solo toma el control cuando se cierran todas las pestañas de la app, y el registro nunca desaparece. La compilación predeterminada es la que incluye el mecanismo de limpieza.

Si necesitas soporte offline real, la [FAQ de Flutter](https://docs.flutter.dev/platform-integration/web/faq) ahora indica que traigas tu propio worker, por ejemplo con Workbox. Dale un nombre de caché versionado y una estrategia network-first para `index.html` y `flutter_bootstrap.js`, o volverás a crear el problema original.

## Trampas y casos parecidos

- **La recarga forzada oculta el bug.** Ctrl+Shift+R (Cmd+Shift+R en macOS) omite la caché HTTP y el service worker en esa carga, así que los desarrolladores rara vez lo ven por sí mismos. Prueba con una recarga normal, o con "Disable cache" desactivado en DevTools.
- **CanvasKit desde la CDN es seguro, CanvasKit local no.** Por defecto, el loader descarga CanvasKit desde `gstatic.com` con una URL que contiene la revisión del motor, así que una actualización de Flutter cambia la URL. Con `--no-web-resources-cdn`, CanvasKit se sirve desde `canvaskit/` con el mismo nombre en cada versión. Un tiempo de vigencia agresivo ahí puede combinar un `main.dart.js` nuevo con un CanvasKit viejo después de una actualización de Flutter.
- **Tiempos de vigencia largos en assets "estáticos".** Algunos hostings y presets de CDN asignan a los archivos `.js` valores de `max-age` de 30 días, suponiendo nombres con hash. Esa suposición es falsa para la salida de Flutter. Comprueba los headers reales de la respuesta con `curl -I https://your.app/main.dart.js`.
- **Las compilaciones Wasm tienen más puntos de entrada.** Una compilación con `--wasm` también carga `main.dart.mjs` y `main.dart.wasm`, y el loader recurre a `main.dart.js` para los navegadores que no están en su lista de permitidos. Los tres necesitan el mismo tratamiento, por eso `bust.sh` los reescribe todos.
- **Comportamiento obsoleto que no es la caché.** Si la nueva compilación carga pero las rutas dan 404 al refrescar, falta un rewrite de SPA (`try_files ... /index.html` o `"rewrites"` en `firebase.json`). Si los assets dan 404 solo bajo una subruta, revisa `--base-href`.

## Relacionados

- [Cómo compilar una app web de Flutter con WebAssembly](/es/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), que cubre los puntos de entrada adicionales de Wasm y los headers COOP/COEP que conviven con `Cache-Control` en la misma configuración del hosting.
- [Migrar una app web de Flutter de `dart:html` a `package:web`](/es/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/), para el estilo de interop que se usa en la comprobación de actualizaciones.
- [Solución: el Text de Flutter se dibuja fuera de la pantalla en un WebView de Android](/es/2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling/), otro problema de Flutter web que solo aparece después de la implementación.
- [Output caching vs response caching en ASP.NET Core 11](/es/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/), si tu compilación de Flutter web la sirve un backend ASP.NET Core y configuras ahí los headers `Cache-Control`.

## Fuentes

- [FAQ de Flutter web](https://docs.flutter.dev/platform-integration/web/faq): eliminación del service worker, recomendaciones sobre `Cache-Control` y la técnica del build id.
- [Inicialización de apps web de Flutter](https://docs.flutter.dev/platform-integration/web/initialization): tokens de la plantilla de `flutter_bootstrap.js`.
- [flutter/flutter#156910](https://github.com/flutter/flutter/issues/156910): deprecación y eliminación de `flutter_service_worker.js`.
- [flutter/flutter PR #176834](https://github.com/flutter/flutter/pull/176834): el service worker autolimpiable, publicado por primera vez en la 3.41.0.
- [`service_worker_loader.js` en la 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/engine/src/flutter/lib/web_ui/flutter_js/src/service_worker_loader.js) y [`flutter_service_worker.js` en la 3.38.10](https://github.com/flutter/flutter/blob/3.38.10/packages/flutter_tools/lib/src/web/file_generators/js/flutter_service_worker.js) para el comportamiento del worker viejo y del nuevo.
- [Blog de Chromium: Reload, reloaded](https://blog.chromium.org/2017/01/reload-reloaded-faster-and-leaner-page_26.html): la recarga solo revalida el recurso principal.
- [RFC 9111, sección 4.2.2](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.2): vigencia heurística cuando no se envía un tiempo de vigencia explícito.
- [Comportamiento de la caché de Firebase Hosting](https://firebase.google.com/docs/hosting/manage-cache): purga de la CDN al volver a implementar.
