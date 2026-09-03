---
title: "Migra una app web de Flutter de dart:html a package:web y dart:js_interop"
description: "Una migración paso a paso desde los obsoletos dart:html, dart:js_util y package:js hacia package:web 1.1.1 y dart:js_interop: cómo encontrar cada import problemático con el compilador dart2wasm, qué renombra y qué no renombra dart fix, las trampas de JSImmutableListWrapper e innerHTML, y cómo verificar con flutter build web --wasm."
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
lang: "es"
translationOf: "2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web"
translatedBy: "claude"
translationDate: 2026-09-03
---

Un código web de Flutter de una sola app con unas pocas llamadas a `dart:html` es una migración de medio día. Un código donde `dart:html` se filtró a paquetes compartidos, a mocks o a un plugin que tú mismo mantienes es una semana, y el cuello de botella casi nunca es tu propio código: es la dependencia transitiva que sigue importando la biblioteca heredada. Ya nada de esto es opcional. `dart:html`, `dart:js`, `dart:js_util` y `package:js` quedaron obsoletos en Dart 3.7 (febrero de 2025), ninguno compila bajo `dart2wasm`, y el par de reemplazo, [`package:web`](https://pub.dev/packages/web) 1.1.1 junto con `dart:js_interop`, es estable desde julio de 2024. Esta guía apunta al canal stable actual, Flutter 3.47.2 con Dart 3.13.2 (publicado el 2026-08-27), y a `package:web` 1.1.1, que requiere Dart `^3.4.0`. Cada salida del compilador que aparece abajo se capturó en una ejecución real con el toolchain stable Flutter 3.44.8 / Dart 3.12.2 y el mismo `package:web` 1.1.1.

## Por qué ya no puedes seguir postergándolo

- **WebAssembly depende de esto.** `dart2wasm` se niega a compilar un programa que alcance `dart:html` de forma transitiva. Si quieres el beneficio descrito en [compilar una app web de Flutter con `flutter build web --wasm`](/es/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), esta migración es el precio de entrada, no una optimización.
- **La obsolescencia ya pesa.** `dart analyze` reporta `deprecated_member_use` en la propia línea del import, así que cualquier job de CI con `--fatal-infos` ya está fallando o está a un cambio de configuración de fallar.
- **`package:web` se versiona aparte del SDK.** Las adiciones a las APIs del navegador llegan como una versión del paquete en lugar de esperar una versión del SDK, y `package:web` se genera directamente desde el Web IDL, así que los nombres coinciden con MDN en vez de con una guía de estilo de Dart de 2013.
- **Si publicas un paquete, tus usuarios no pueden compilar a Wasm hasta que migres.** Un solo import de `dart:html` en un paquete hoja bloquea todo el grafo de dependencias aguas abajo.

## Qué se rompe

| Área | Cambio | Severidad |
| ---- | ------ | --------- |
| Nombres de tipos | Los nombres al estilo Dart vuelven a los nombres del IDL: `HtmlElement` pasa a `HTMLElement`, `InputElement` a `HTMLInputElement`, `AnchorElement` a `HTMLAnchorElement` | alta, pero casi todo automatizable |
| Colecciones | `querySelectorAll` y `children` devuelven `NodeList` / `HTMLCollection`, que no implementan `List` | alta |
| Pruebas de tipo | `is` y `as` ya no funcionan sobre tipos del navegador, porque todo tipo de `package:web` se borra a `JSObject` | alta |
| Mocking | Los extension types no tienen despacho virtual, así que un mock que `implements` una clase de `dart:html` no puede implementar un tipo de `package:web` | alta |
| Firmas de tipos | `innerHTML` es `JSAny`, los listeners de eventos reciben `JSFunction`, así que los call sites necesitan `.toJS` | media |
| Zonas | Los callbacks ya no se enlazan automáticamente a la zona actual | media |
| Imports condicionales | `dart.library.html` debe pasar a `dart.library.js_interop` | media |
| Vistas de plataforma | Las factories de vista deben devolver un elemento de `package:web` y registrarse a través de `dart:ui_web` | media |
| `dart:js_util` | `getProperty` / `setProperty` / `callMethod` se mueven a `dart:js_interop_unsafe` con claves `JSAny` | baja, mecánica |

## Lista previa al despegue

- Flutter 3.47.2 o superior en el canal stable. Cualquier versión desde Flutter 3.22 (Dart 3.4) funciona, pero las correcciones del analizador que se describen abajo son mejores en SDKs recientes.
- `flutter pub add web`, que resuelve a `web: ^1.1.1`.
- Un job de CI que ejecute `flutter build web --wasm` aunque todavía no publiques la build de Wasm. Es el único detector confiable de imports heredados escondidos en dependencias.
- Una rama, no una serie de commits pequeños sobre `main`. La pasada de renombrado toca muchos archivos a la vez y es dolorosa de revisar en trozos.
- Un inventario de los paquetes de los que dependes que se publicaron por última vez antes de mediados de 2024. Esos son tus bloqueadores probables.

## Pasos de la migración

1. **Encuentra cada import problemático con el compilador, no con grep.** `grep -r "dart:html" lib/` encuentra tu código y se pierde la dependencia tres niveles más abajo que en realidad te bloquea. `dart2wasm` imprime la cadena completa de imports. Ejecuta `flutter build web --wasm` y lee el primer error:

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

   El bloque "Detailed import paths" es la parte útil. Cuando la cadena termina en un paquete de pub y no en tu propio `lib/`, encontraste una dependencia que hay que actualizar, forkear o reemplazar antes de que tu app pueda migrar.

   Verificación: cada ruta impresa por el compilador queda anotada y clasificada como "mi código", "mi paquete" o "de terceros". Nada queda como "seguramente está bien".

2. **Cambia el import y agrega la dependencia.** Por archivo, `import 'dart:html' as html;` pasa a `import 'package:web/web.dart' as web;`. Conserva el prefijo. Un import de `package:web` sin prefijo mete varios cientos de nombres de nivel superior en el ámbito y choca con `Element`, `Image` y `Text` del propio Flutter.

   ```console
   flutter pub add web
   ```

   Verificación: `flutter pub deps | grep web` muestra `web 1.1.1`, y los errores del archivo pasan de "deprecated" a una lista de nombres indefinidos. Los nombres indefinidos son progreso: son el trabajo de renombrado hecho visible.

3. **Ejecuta `dart fix` para los renombrados de tipos y termina el resto a mano.** `package:web` incluye un `lib/fix_data.yaml` con 141 transformaciones de renombrado, así que el analizador puede reescribir la mayoría de los nombres de tipos heredados una vez que el nuevo import está en su lugar:

   ```console
   dart fix --dry-run
   dart fix --apply
   ```

   Sobre un archivo que contiene `InputElement`, `HtmlElement` y `CheckboxInputElement`, `dart fix --apply` reescribe los dos primeros y deja el tercero intacto:

   ```dart
   // After dart fix --apply, package:web 1.1.1
   final HTMLInputElement input = HTMLInputElement();
   final HTMLElement box = document.querySelector('#box') as HTMLElement;
   final CheckboxInputElement cb = CheckboxInputElement(); // still undefined
   ```

   `CheckboxInputElement` no es un renombrado: es un tipo de conveniencia de `dart:html` sin contraparte en el IDL. La forma manual es `HTMLInputElement()..type = 'checkbox'`. Cuando un nombre no tiene transformación, busca la anotación `@Native` de la clase antigua de `dart:html`: su valor es el nombre en `package:web`.

   Verificación: `dart analyze` reporta cero diagnósticos `undefined_class` y `undefined_function` en los archivos migrados.

4. **Reemplaza `dart:js_util` y `package:js` por `dart:js_interop`.** Los accesores dinámicos antiguos se mueven a `dart:js_interop_unsafe` y reciben claves `JSAny` en vez de `String`. La interoperabilidad declarada pasa de clases `@JS()` a extension types sobre `JSObject`. Antes:

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

   Después:

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

   Tres patrones que conviene interiorizar: `allowInterop(fn)` pasa a `fn.toJS`, `js_util.promiseToFuture(p)` pasa a `p.toDart`, y una `JSPromise<T>` esperada con `.toDart` te da un `Future<T>`. `HttpRequest` no tiene reemplazo directo que valga la pena usar; la respuesta es `window.fetch` o `package:http`.

   Verificación: `dart analyze` está limpio y ningún archivo del repositorio importa todavía `dart:js`, `dart:js_util` ni `package:js`.

5. **Mueve las factories de vistas de plataforma a `dart:ui_web`.** Todo código que registre una vista HTML ahora tiene que devolver un elemento de `package:web`. El registro vive en `dart:ui_web`, y `registerViewFactory` se declara como `registerViewFactory(String viewType, Function viewFactory, {bool isVisible = true})`:

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

   Verificación: la vista se renderiza con `flutter run -d chrome`, y `flutter build web --wasm` compila el archivo sin quejarse.

6. **Reescribe los imports condicionales para que dependan de `dart.library.js_interop`.** La forma antigua selecciona en silencio la implementación stub bajo `dart2wasm`, porque ahí `dart.library.html` es falso, lo que produce un `UnsupportedError` en tiempo de ejecución en vez de un error de compilación. Ese es el peor modo de fallo de toda esta migración:

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

   Verificación: busca `dart.library.html` con grep en el repositorio y confirma cero resultados, luego ejecuta la app en un target nativo y en la web para probar que cada rama sigue resolviéndose. La misma técnica aplica al problema más amplio del [código específico de plataforma sin un plugin](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

7. **Arregla las pruebas al final, porque los mocks se rompen distinto.** Los tipos de `package:web` son extension types sobre `JSObject`, así que un fake que haga `implements HTMLElement` no compila. Reemplaza los fakes basados en clases por nodos DOM reales creados en la prueba, o por un objeto JS que construyas y le pases al código bajo prueba. Todo lo que recurría a `dynamic` para llamar a un miembro del DOM también deja de funcionar, porque los miembros de un extension type se resuelven solo de forma estática.

   Verificación: `flutter test` pasa y no queda en la suite ninguna cláusula `implements` apuntando a un tipo de `package:web`.

## Verificación

Ejecuta las cuatro, en este orden:

```console
dart analyze --fatal-infos
flutter test
flutter build web
flutter build web --wasm
```

El último comando es la verdadera barrera. En una app migrada termina con `Built build/web` y deja `main.dart.wasm`, `main.dart.mjs` y el fallback de `dart2js` `main.dart.js` en `build/web`. Si aun así falla, el error nombra la cadena exacta de imports que queda. Después de eso, carga la app y recorre todo lo que toque el DOM: descargas de archivos, portapapeles, iframes, `localStorage` y cualquier SDK de JS con el que hables por interoperabilidad.

## Plan de reversión

La reversión por archivo es fácil y la reversión de todo el repositorio no vale la pena planificarla. `package:web` y `dart:html` pueden convivir en el mismo programa, así que puedes migrar un archivo, publicarlo y revertir solo ese archivo si algo se rompe. Lo que no puedes hacer es revertir después de haber borrado las rutas de código con `dart:html` y publicado una build de Wasm, porque la build de Wasm nunca las soportó. Mantén la build de `dart2js` como tu target de producción hasta terminar el recorrido manual de arriba; `flutter build web --wasm` emite ambas y el cargador hace el fallback por su cuenta.

## Trampas que conviene conocer antes de empezar

**El ejemplo oficial de `JSImmutableListWrapper` no compila.** `JSImmutableListWrapper<T, U>` no puede inferir `U` a partir de su argumento de constructor, así que cae al límite del parámetro, `JSObject`:

```dart
for (final a in JSImmutableListWrapper(document.querySelectorAll('a'))) {
  a.classList.add('link'); // error: The getter 'classList' isn't defined for the type 'JSObject'
}
```

Pasa ambos argumentos de tipo de forma explícita:

```dart
// package:web 1.1.1
for (final a in JSImmutableListWrapper<NodeList, Element>(
  document.querySelectorAll('a'),
)) {
  a.classList.add('link');
}
```

**`innerHTML` es `JSAny`, en ambas direcciones.** Escribir necesita `.toJS`, y leer necesita un cast: `final String s = el.innerHTML;` falla con "A value of type 'JSAny' can't be assigned to a variable of type 'String'". Léelo como `(el.innerHTML as JSString).toDart`. Lo mismo aplica a `outerHTML` y a `insertAdjacentHTML`, cuyo segundo parámetro es `JSAny`.

**`element.text` es un setter sin getter.** `package:web` conserva un setter `text` obsoleto por comodidad durante la migración, pero leer requiere `textContent`, que es `String?` en vez de `String`. El código que hacía `if (el.text.isEmpty)` ahora necesita una comprobación de null.

**Los callbacks pierden su zona.** `dart:html` enlazaba los callbacks de eventos a la zona actual de forma automática; `package:web` no lo hace. Si dependes de valores locales de la zona o de que un manejador de errores basado en zonas capture lo que ocurre dentro de un listener, enlaza manualmente antes de convertir:

```dart
element.addEventListener(
  'click',
  Zone.current.bindUnaryCallback((Event event) {
    // zone-local values are preserved here
  }).toJS,
);
```

**Las pruebas de tipo cambian de significado en silencio.** `obj is Window` compilaba bien bajo `dart:html`; bajo `package:web` todo tipo se borra a `JSObject`, así que la comprobación no significa nada. Usa `element.isA<HTMLInputElement>()` (Dart 3.4 y superior) o `obj.instanceOfString('Window')`.

**Algunas costumbres de `dart:html` sobreviven como shims obsoletos.** `window.localStorage['k'] = 'v'` todavía pasa el análisis, con "'[]=' is deprecated and shouldn't be used. Use Storage.setItem instead", y existe un `querySelector` de nivel superior con "Directly use document.querySelector instead". Compilan hoy, pero no son un destino. Conviértelos en la misma pasada o harás esto dos veces.

**Los streams de eventos siguen existiendo y son el camino ergonómico.** `package:web` trae helpers de streams, así que `input.onClick.listen(...)` funciona sin cambios y devuelve `ElementStream<MouseEvent>`. Prefiérelos sobre `addEventListener` crudo más `.toJS` para todo lo que necesites cancelar. Ten en cuenta que los streams helper entregan algunos eventos de forma asíncrona donde `dart:html` era síncrono, así que el código sensible al tiempo necesita una segunda revisión.

## Relacionado

- El beneficio de este trabajo se describe completo en [compilar una app web de Flutter con WebAssembly](/es/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/), incluido por qué Firefox y Safari siguen recibiendo la build de JavaScript.
- Estructuralmente esta es la misma clase de pasada amplia y mecánica que [migrar una app de Flutter 2 a Flutter 3.x](/es/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/): un plan de dos saltos y un compilador que te avisa cuando terminaste.
- El mecanismo de imports condicionales del paso 6 es el mismo que está detrás del [código específico de plataforma sin un plugin](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).
- Si además estás actualizando Flutter, lee [qué cambió Flutter 3.47 para el renderizado en escritorio](/es/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) antes de culpar a esta migración por una regresión visual.
- La web también es donde los [isolates de Dart](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) se comportan distinto que en cualquier otra plataforma, algo que conviene saber antes de mover trabajo intensivo en CPU durante la misma pasada.

## Fuentes

- [Migrate to package:web](https://dart.dev/interop/js-interop/package-web), dart.dev
- [Past JS interop](https://dart.dev/interop/js-interop/past-js-interop), dart.dev
- [JS types and conversions](https://dart.dev/interop/js-interop/js-types), dart.dev
- [Breaking changes and deprecations](https://dart.dev/resources/breaking-changes), dart.dev
- [package:web en pub.dev](https://pub.dev/packages/web), versión 1.1.1
- [Referencia de la API EventStreamProviders](https://pub.dev/documentation/web/latest/web/EventStreamProviders-class.html), package:web
- [dart:ui_web PlatformViewRegistry](https://api.flutter.dev/flutter/dart-ui_web/PlatformViewRegistry-class.html), documentación de la API de Flutter
- [Announcing Dart 3.13](https://dart.dev/blog/announcing-dart-3-13), el blog de Dart
