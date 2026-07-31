---
title: "Solución: Unable to load asset en Flutter después de agregar una imagen a pubspec.yaml"
description: "La clave del asset falta en el bundle compilado, no en tu disco. Corrige la indentación del pubspec, agrega la barra final, iguala la clave y reinicia por completo."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pubspec"
  - "assets"
lang: "es"
translationOf: "2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml"
translatedBy: "claude"
translationDate: 2026-07-31
---

El archivo está en el disco, la ruta parece correcta y Flutter sigue diciendo que no puede cargarlo. Eso ocurre porque el mensaje no habla de tu disco: la clave que pasaste no está en el bundle de assets compilado. En orden de frecuencia, la razón es un bloque `assets:` que no está indentado bajo `flutter:`, una entrada de directorio a la que le falta la `/` final, un archivo en un subdirectorio que nunca se declaró, una clave que difiere en mayúsculas y minúsculas del nombre del archivo, o un hot reload cuando hacía falta un reinicio completo. Corrige `pubspec.yaml`, detén la aplicación y vuelve a ejecutarla.

```text
======== Exception caught by image resource service ================================================
The following assertion was thrown resolving an image codec:
Unable to load asset: "assets/images/logo.png".
The asset does not exist or has empty data.

When the exception was thrown, this was the stack:
#0      PlatformAssetBundle.load (package:flutter/src/services/asset_bundle.dart:271:7)
<asynchronous suspension>
#1      AssetBundleImageProvider._loadAsync (package:flutter/src/painting/image_provider.dart:951:14)
```

Esta guía está escrita contra Flutter 3.44.7 y Dart 3.12.2, el canal stable al 2026-07-20. El comportamiento descrito aquí es estable desde que Flutter 3.16 cambió el formato del manifiesto de assets, y las reglas del pubspec no han cambiado en años.

## Qué significa realmente el error

`Image.asset('assets/images/logo.png')` no abre un archivo. Entrega una clave de texto al framework, que le pide al engine los bytes registrados bajo esa clave en el bundle de assets de la aplicación. `PlatformAssetBundle.load` lanza la excepción en el momento en que el engine devuelve null o un búfer de longitud cero:

```dart
// flutter/lib/src/services/asset_bundle.dart, Flutter 3.44.7
throw FlutterError.fromParts(<DiagnosticsNode>[
  _errorSummaryWithKey(key),
  ErrorDescription('The asset does not exist or has empty data.'),
]);
```

Ese bundle lo compila una sola vez la herramienta `flutter`, a partir de la sección `flutter: assets:` de `pubspec.yaml`. Todo lo que esté listado ahí se copia a `build/flutter_assets/` y se indexa en un manifiesto llamado `AssetManifest.bin`, que el engine carga al arrancar. Nada más en tu sistema de archivos existe desde el punto de vista de la aplicación en ejecución.

Así que dos cosas independientes tienen que coincidir, y el error no puede decirte cuál de las dos está mal:

1. La declaración del pubspec tiene que meter el archivo en el bundle.
2. La clave en tu código Dart tiene que coincidir byte por byte con la clave del bundle.

Cada causa de abajo es una de esas dos fallando.

## La reproducción mínima

```
my_app/
  pubspec.yaml
  assets/
    images/
      logo.png
  lib/
    main.dart
```

```yaml
# pubspec.yaml, Flutter 3.44.7
name: my_app

flutter:
  uses-material-design: true
  assets:
    - assets/images/logo.png
```

```dart
// lib/main.dart, Flutter 3.44.7, Dart 3.12.2
import 'package:flutter/material.dart';

void main() => runApp(
      const MaterialApp(
        home: Scaffold(
          body: Center(child: Image.asset('assets/images/logo.png')),
        ),
      ),
    );
```

Eso funciona. Rompe cualquier línea de ese ejemplo de las maneras que siguen y obtienes el error, sin ningún otro diagnóstico.

## Causa 1: el bloque assets no está anidado bajo flutter

Esta es la falla más común y la más frustrante, porque nada se queja. `flutter pub get` termina bien, la compilación termina bien y la aplicación arranca con un bundle vacío.

```yaml
# Wrong. Valid YAML, silently ignored.
flutter:
  uses-material-design: true
assets:
  - assets/images/logo.png
```

`assets:` en el nivel superior es una clave que la herramienta de Flutter no lee. No es un error, simplemente es configuración de otra persona en lo que respecta al parser. La forma correcta indenta `assets:` exactamente dos espacios bajo `flutter:`, con los elementos de la lista dos espacios más adentro:

```yaml
# Right.
flutter:
  uses-material-design: true
  assets:
    - assets/images/logo.png
```

Una variante relacionada: una segunda clave `flutter:` más abajo en el archivo. Los mapas YAML no pueden tener claves duplicadas y, según el parser, una gana silenciosamente. Si tu pubspec creció de forma orgánica, busca en él cada aparición de `flutter:` en la columna cero antes de depurar cualquier otra cosa.

## Causa 2: una entrada de directorio sin barra final, o un subdirectorio que nunca se declaró

Las entradas de directorio se activan una por una y no son recursivas. De la documentación de Flutter sobre cómo agregar assets: "Only files located directly in the directory are included. Resolution-aware asset image variants are the only exception. To add files located in subdirectories, create an entry per directory."

Así que esto no declara nada útil si tus imágenes viven en `assets/images/icons/`:

```yaml
flutter:
  assets:
    - assets/images/
```

y esto es lo que necesitas:

```yaml
flutter:
  assets:
    - assets/images/
    - assets/images/icons/
    - assets/images/illustrations/
```

La barra final es lo que convierte la entrada en un directorio. `- assets/images` sin ella se lee como un único archivo llamado `images` y, como ese archivo no existe, la compilación falla a nivel de herramienta con un mensaje que sí es útil:

```text
Error: unable to find directory entry in pubspec.yaml: /path/to/my_app/assets/images/
```

Vale la pena conocerlo al revés: si tu compilación tuvo éxito y aun así obtienes `Unable to load asset` en tiempo de ejecución, la entrada coincidió con algo. El problema entonces es una clave que no coincide, no una declaración faltante.

La única excepción a la regla de no recursividad son las variantes según resolución. Si declaras `assets/images/logo.png`, entonces `assets/images/2.0x/logo.png` y `assets/images/3.0x/logo.png` se empaquetan automáticamente y `AssetImage` elige la correcta según el device pixel ratio. Nunca declaras tú mismo los directorios de variantes.

## Causa 3: la clave del código no coincide con la clave del bundle

Las claves del bundle son cadenas exactas. Tres maneras en que se desvían de lo que escribiste:

**Mayúsculas y minúsculas.** Tu máquina de desarrollo casi con certeza tiene un sistema de archivos insensible a mayúsculas (APFS en macOS por defecto, NTFS en Windows). `Image.asset('assets/images/Logo.png')` resuelve un archivo llamado `logo.png` localmente y falla en un dispositivo Android, en iOS, en web y en cualquier runner de CI con Linux. Si una compilación funciona en tu laptop y falla en todas partes, revisa esto primero. Es la explicación más probable para un caso de mismo código con resultado distinto según la máquina.

**Un `./` inicial o un espacio perdido.** `'./assets/images/logo.png'` es una cadena distinta de `'assets/images/logo.png'`, y el bundle solo contiene la segunda. Un espacio en blanco al final dentro de un valor YAML entre comillas tiene el mismo efecto.

**El prefijo `packages/`.** Un asset que viene dentro de un paquete del que dependes se identifica como `packages/<package_name>/<path>`, con el directorio `lib/` del paquete implícito y nunca escrito. Para cargar `lib/assets/bg.png` desde un paquete llamado `fancy_backgrounds`:

```dart
// Flutter 3.44.7. Either form works; they produce the same key.
Image.asset('packages/fancy_backgrounds/assets/bg.png');
Image.asset('assets/bg.png', package: 'fancy_backgrounds');
```

Si tú escribiste el paquete, también tiene que declarar esos archivos en su propio `pubspec.yaml`. Los assets de una dependencia no se empaquetan solo porque el archivo exista en `.pub-cache`.

## Causa 4: hiciste hot reload cuando necesitabas reiniciar

El hot reload intercambia código Dart dentro de un isolate en ejecución. El bundle de assets y su manifiesto los produce la herramienta cuando se lanza la aplicación. Editar `pubspec.yaml` para agregar una entrada nueva cambia el manifiesto, y una aplicación en ejecución conserva el manifiesto con el que arrancó.

Detén la sesión y vuelve a iniciarla. Ni `r`, ni `R`:

```bash
# Flutter 3.44.7
# Ctrl-C to end the current run, then:
flutter run
```

Cambiar los *bytes* de un asset que ya está declarado sí se vuelve a empaquetar en el reload y no necesita esto. Cambiar el *conjunto* de assets declarados sí.

## Causa 5: salida obsoleta en el disco

Rara vez es la causa, es barato descartarla y es lo primero que te dice toda respuesta en internet, razón por la cual se la culpa de muchas más fallas de las que produce. Sí es una causa real en iOS, donde un bundle `.app` actualizado a medias puede sobrevivir a una recompilación:

```bash
# Flutter 3.44.7
flutter clean
flutter pub get
flutter run
```

Si lo que falla en el camino es el propio `flutter pub get`, se trata de un problema de resolución de dependencias y no de assets, y la salida del solucionador de restricciones es un ejercicio aparte: mira [cómo leer un error de version solving failed en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Deja de adivinar: imprime las claves que están realmente en el bundle

Cada sección anterior es una hipótesis. Puedes reemplazarlas todas con una sola medición. `AssetManifest` es la API compatible para leer el manifiesto en tiempo de ejecución, agregada cuando `AssetManifest.json` fue reemplazado por `AssetManifest.bin`:

```dart
// Flutter 3.44.7, Dart 3.12.2
import 'package:flutter/services.dart';

Future<void> dumpAssetKeys() async {
  final manifest = await AssetManifest.loadFromAssetBundle(rootBundle);
  for (final key in manifest.listAssets()..sort()) {
    debugPrint(key);
  }
}
```

Llámala desde `main` detrás de una comprobación `kDebugMode` y lee la consola. Lo que se imprima es lo que el engine puede servir. Si tu ruta no está, el problema es la Causa 1 o la 2. Si está presente algo casi idéntico a tu ruta, es la Causa 3, y la diferencia entre las dos cadenas es tu solución.

No parsees `AssetManifest.bin` por tu cuenta. Flutter lo documenta como un detalle de implementación cuyo formato puede cambiar sin aviso, y `AssetManifest.json` ya no se genera en absoluto, así que el código que todavía llama a `rootBundle.loadString('AssetManifest.json')` lanza exactamente este error con `AssetManifest.json` como clave.

También puedes inspeccionar el bundle sin ejecutar nada:

```bash
# Flutter 3.44.7. Writes the bundle the engine would load.
flutter build bundle
ls build/flutter_assets/assets/images/

# Or check what shipped inside a built APK:
unzip -l build/app/outputs/flutter-apk/app-debug.apk | grep flutter_assets
```

## Variantes que caen en esta página

- **`Unable to load asset: "fonts/Inter-Regular.ttf"`**. Las fuentes se declaran bajo `flutter: fonts:`, no bajo `assets:`, y el nombre de la familia en tu `TextStyle` tiene que coincidir con el valor de `family:` y no con el nombre del archivo. El modo de falla y la lógica de la solución son idénticos.
- **`Unable to load asset` desde `SvgPicture.asset`**. `flutter_svg` carga a través del mismo `AssetBundle`, así que el error es del framework y no del paquete. Todo lo anterior aplica sin cambios.
- **El asset existe pero "has empty data"**. Lee esa frase de forma literal. El culpable habitual es Git LFS: un repositorio donde las imágenes están rastreadas con LFS, con checkout en un runner de CI sin `lfs: true`, deja un puntero de texto de 130 bytes donde debería estar el PNG. La compilación tiene éxito, el bundle contiene la clave y la decodificación falla. Revisa el tamaño del archivo antes que cualquier otra cosa. Una regla de `.gitignore` o `.dockerignore` que excluye `assets/` produce la misma forma de "funciona local, falla en CI", algo que vale la pena descartar cuando estás [ejecutando compilaciones con varias versiones de Flutter en un solo pipeline](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- **Solo se rompe en Flutter web, solo después de desplegar**. Si la aplicación está hospedada bajo una subruta, `build/web/index.html` necesita `<base href="/my-app/">` y la compilación necesita `flutter build web --base-href /my-app/`. Sin eso el engine pide `/assets/...` desde la raíz del dominio y recibe un 404, que se manifiesta como este error. La misma trampa aplica a una [compilación WebAssembly con `flutter build web --wasm`](/es/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/).
- **Solo se rompe en `flutter test`**. Los assets declarados en `pubspec.yaml` sí funcionan en las pruebas de widgets: la herramienta compila `build/unit_test_assets/`, exporta su ruta como `UNIT_TEST_ASSETS` y `mockFlutterAssets()` sirve las claves desde ahí. Dos cosas siguen rompiéndose. Los assets empaquetados de forma condicional por flavor no están en ese directorio, y una prueba de golden que renderiza `Image.asset` necesita que la carga se complete, así que envuelve el pump en `tester.runAsync` o llama a `precacheImage` antes de comparar.
- **Solo se rompe en release, no en debug**. No es un problema de assets. Revisa si la ruta de código que construye la clave se está alcanzando siquiera, y si una cadena `const` se está ensamblando a partir de algo que difiere entre modos de compilación.
- **La compilación de Android nunca llegó lo bastante lejos como para empaquetar nada**. Si la falla es en tiempo de compilación y no de ejecución, estás mirando [una tarea de Gradle que falló con exit code 1](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/), y ninguna cantidad de ediciones al pubspec ayudará.

La idea de fondo: este error es un fallo de búsqueda en una estructura de datos que produjo tu compilación. Trátalo así. Imprime `listAssets()`, compara la cadena que pasaste contra las cadenas que existen, y la solución siempre está en uno de los dos lados de esa comparación.

## Relacionados

- [Solución: Version solving failed en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- cuando el `flutter pub get` de la secuencia de recompilación limpia es lo que falla.
- [Solución: Gradle task assembleDebug failed with exit code 1 en una compilación Android de Flutter](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) -- la contraparte en tiempo de compilación, donde el bundle nunca llega a producirse.
- [Cómo compilar una aplicación web Flutter con WebAssembly](/es/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) -- cubre la configuración de base href y de ruta de hospedaje que rompe las URL de assets en web.
- [Cómo apuntar a varias versiones de Flutter desde un solo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) -- los detalles de checkout y caché detrás de la mayoría de los reportes de assets que funcionan local y fallan en CI.
- [Solución: Cannot provide both a color and a decoration en un Container de Flutter](/es/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/) -- el otro error que aparece la primera vez que pones una imagen detrás de una caja con estilos.

## Fuentes

- [Adding assets and images](https://docs.flutter.dev/ui/assets/assets-and-images), documentación de Flutter
- [Removal of AssetManifest.json](https://docs.flutter.dev/release/breaking-changes/asset-manifest-dot-json), documentación de Flutter
- [Clase `AssetManifest`](https://api.flutter.dev/flutter/services/AssetManifest-class.html), referencia de la API de Flutter
- [`asset_bundle.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/services/asset_bundle.dart), flutter/flutter
- [`_binding_io.dart` y `mockFlutterAssets`](https://github.com/flutter/flutter/blob/stable/packages/flutter_test/lib/src/_binding_io.dart), flutter/flutter
- [Conditionally bundling assets based on flavor makes tests fail](https://github.com/flutter/flutter/issues/150296), flutter/flutter
