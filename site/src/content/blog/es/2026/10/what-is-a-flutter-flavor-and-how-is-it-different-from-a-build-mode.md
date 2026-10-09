---
title: "Qué es un flavor de Flutter y en qué se diferencia de un modo de compilación"
description: "Un modo de compilación (debug, profile, release) decide cómo Flutter compila tu código Dart. Un flavor (dev, staging, prod) es una variante de compilación nativa que defines en Gradle y Xcode y que decide qué aplicación publicas. Son ejes independientes: 2 flavors por 3 modos son 6 compilaciones. Verificado en Flutter 3.44.8 con AGP 9.0.1, código fuente comprobado contra 3.47.7."
pubDate: 2026-10-10
tags:
  - "flutter"
  - "dart"
  - "flavors"
  - "android"
  - "ios"
  - "tooling"
lang: "es"
translationOf: "2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode"
translatedBy: "claude"
translationDate: 2026-10-10
---

Respuesta corta: un **modo de compilación** es cómo Flutter compila y ejecuta tu código Dart. Hay exactamente tres, `debug`, `profile` y `release`, vienen integrados en el motor y en la herramienta, y tu código los ve a través de `kDebugMode`, `kProfileMode` y `kReleaseMode`. Un **flavor** es algo que Flutter no posee en absoluto: es una variante de compilación nativa que defines tú mismo, como `productFlavors` de Android en Gradle y como esquemas de Xcode más configuraciones de compilación en iOS y macOS, y decide *qué aplicación* estás compilando (ID de aplicación, nombre visible, iconos, proyecto de Firebase, URL base de la API). Flutter solo reenvía `--flavor dev` a la compilación nativa y expone el nombre a Dart como la constante `appFlavor`. Ambos son ortogonales, así que un proyecto con los flavors `dev` y `prod` tiene seis variantes, desde `devDebug` hasta `prodRelease`. Todo lo que sigue se compiló y se comprobó en Flutter 3.44.8 (Dart 3.12.2, Android Gradle Plugin 9.0.1, Gradle 9.1.0), y el código fuente relevante de `flutter_tools` se comparó con la versión estable actual, Flutter 3.47.7.

## Dos ejes, una matriz de compilación

La confusión suele empezar porque ambas cosas se pasan en la misma línea de comandos y ambas acaban en el nombre del archivo de salida:

```bash
# Flutter 3.44.8 / 3.47.7
flutter build apk --release --flavor prod
# -> Running Gradle task 'assembleProdRelease'...
# -> build/app/outputs/flutter-apk/app-prod-release.apk
```

`--release` elige el modo. `--flavor prod` elige el flavor. Gradle los compone en un único nombre de variante, `prodRelease`, y ejecuta `assembleProdRelease`. Esta es la matriz completa para un proyecto con dos flavors:

| | `--debug` | `--profile` | `--release` |
|---|---|---|---|
| `--flavor dev` | `app-dev-debug.apk` | `app-dev-profile.apk` | `app-dev-release.apk` |
| `--flavor prod` | `app-prod-debug.apk` | `app-prod-profile.apk` | `app-prod-release.apk` |

Las columnas las decide Flutter y responden a "¿cómo se compila el código Dart y puedo usar hot reload?". Las filas las deciden tu `build.gradle.kts` y tu proyecto de Xcode y responden a "¿es esta la aplicación que habla con el backend de staging y que se llama `Demo Dev` en la pantalla de inicio?". Nada de un eje implica nada del otro. Una compilación debug de `prod` es completamente normal: es lo que ejecutas cuando necesitas reproducir con puntos de interrupción un error que solo ocurre en producción.

## Qué cambia realmente un modo de compilación

Los modos de compilación tienen que ver con el pipeline de compilación de Dart, y los fija Flutter:

- **Debug** compila a un archivo kernel y lo ejecuta en el JIT de la VM de Dart. Los asserts están activados, las extensiones de servicio están activadas, hot reload y hot restart funcionan, y el rendimiento no es representativo.
- **Profile** compila por adelantado (AOT) a código máquina nativo, como release, pero mantiene vivo suficiente protocolo de servicio para el trazado con DevTools. No se ejecuta en emuladores ni simuladores.
- **Release** compila por adelantado, elimina los asserts y la información de depuración, y es lo que publicas.

Puedes ver la diferencia listando los APK. El APK debug lleva el programa Dart como `kernel_blob.bin` para el JIT, mientras que los APK profile y release llevan un `libapp.so` precompilado:

```text
# Flutter 3.44.8, flutter build apk --target-platform android-arm64 --flavor dev|prod
app-dev-debug.apk     26146208  assets/flutter_assets/kernel_blob.bin
app-dev-profile.apk    2753424  lib/arm64-v8a/libapp.so
app-prod-release.apk   1508240  lib/arm64-v8a/libapp.so
```

Tu código Dart conoce el modo a través de tres constantes de `package:flutter/foundation.dart`. Son constantes en tiempo de compilación derivadas de indicadores que la herramienta pasa al compilador de Dart, y por eso el compilador puede eliminar por completo un bloque `if (kDebugMode) { ... }` de una compilación release (tree-shaking):

```dart
// Flutter 3.44.8, packages/flutter/lib/src/foundation/constants.dart (abridged)
const bool kReleaseMode = bool.fromEnvironment('dart.vm.product');
const bool kProfileMode = bool.fromEnvironment('dart.vm.profile');
const bool kDebugMode = !kReleaseMode && !kProfileMode;
```

No puedes añadir un cuarto modo. Un modo "staging" no existe en Flutter; staging es un flavor.

## Qué es realmente un flavor

Un flavor es una variante de la aplicación nativa. Flutter no tiene un formato de configuración de flavors propio. Cuando pasas `--flavor dev`, la herramienta hace tres cosas:

1. En Android, ejecuta la tarea de Gradle `assemble<Flavor><Mode>`, por ejemplo `assembleDevDebug`. Si tu archivo de Gradle no declara ningún product flavor llamado `dev`, la compilación falla.
2. En iOS y macOS, compila el esquema de Xcode que lleva el nombre del flavor (con la primera letra en mayúscula, así que para `dev` busca primero `Dev` y luego una coincidencia sin distinguir mayúsculas) usando la configuración de compilación `<Mode>-<scheme>`, por ejemplo `Debug-dev` o `Release-prod`.
3. En todas las plataformas, añade `FLUTTER_APP_FLAVOR=dev` a los defines de Dart, que aparece en Dart como `appFlavor`.

Todo lo que un flavor cambia en el binario final viene del lado nativo: el sufijo del ID de aplicación, la cadena con el nombre de la aplicación, `google-services.json` o `GoogleService-Info.plist`, los iconos del lanzador, la configuración de firma. Flutter solo hace pasar el nombre.

## Definir flavors en Android con AGP 9

Este es el lado Android de la aplicación de demostración. Es la plantilla estándar de `flutter create` para Flutter 3.44.8 con una dimensión de flavor añadida:

```kotlin
// android/app/build.gradle.kts
// Flutter 3.44.8, Android Gradle Plugin 9.0.1, Gradle 9.1.0
android {
    namespace = "com.example.flavordemo"
    compileSdk = flutter.compileSdkVersion

    defaultConfig {
        applicationId = "com.example.flavordemo"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // AGP 9 turns resValue off by default. Without this block the
    // productFlavors below fail with:
    // "Product Flavor dev contains custom resource values, but the feature is disabled."
    buildFeatures {
        resValues = true
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            resValue("string", "app_name", "Demo Dev")
        }
        create("prod") {
            dimension = "env"
            resValue("string", "app_name", "Demo")
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}
```

El bloque `buildFeatures` es la parte que se les escapa a la mayoría de los tutoriales antiguos. Las guías de flavors escritas antes de AGP 9 usan `resValue` para el nombre de la aplicación, y en un proyecto nuevo de Flutter 3.44 esa configuración ahora falla durante la configuración de Gradle con el error del comentario de arriba. Después, apunta el manifiesto a la cadena para que cada flavor tenga su propia etiqueta de lanzador:

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<application
    android:label="@string/app_name"
    android:name="${applicationName}"
    android:icon="@mipmap/ic_launcher">
```

`aapt2 dump badging` sobre los APK resultantes confirma que los dos ejes son realmente independientes. El modo no cambió nada de la identidad, y el flavor no cambió nada de la compilación:

```text
app-dev-debug.apk     package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-dev-profile.apk   package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-dev-release.apk   package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-prod-release.apk  package: com.example.flavordemo      versionName 0.1.0      label 'Demo'
```

Como las variantes `dev` tienen un ID de aplicación distinto, se instalan junto a la de producción en el mismo teléfono. Solo por eso la mayoría de los equipos adoptan flavors.

## Los errores que te dicen qué eje está mal

Cuando un archivo de Gradle declara product flavors, un simple `flutter build apk` deja de funcionar:

```text
# Flutter 3.44.8, no --flavor, productFlavors declared
Running Gradle task 'assembleDebug'...                             14.5s
Gradle build failed to produce an .apk file. It's likely that this file was generated
under .../flavordemo/build, but the tool couldn't find it.
```

El mensaje es engañoso. `assembleDebug` tuvo éxito y compiló *todos* los flavors (tanto `app-dev-debug.apk` como `app-prod-debug.apk` estaban en disco después), pero la herramienta busca `app-debug.apk`, que ya no existe. Pasa `--flavor`, o define un valor por defecto (ver más abajo).

El error opuesto, pasar `--flavor` a un proyecto que no tiene product flavors, recibe un mensaje mucho más claro:

```text
# Flutter 3.44.8, --flavor dev, no productFlavors
[!]  Gradle project does not define a task suitable for the requested build.
The .../android/app/build.gradle.kts file does not define any custom product flavors.
You cannot use the --flavor option.
```

En iOS la herramienta valida el flavor contra los esquemas de Xcode. Al ejecutar `flutter build ios --config-only --no-codesign --flavor dev` en el mismo proyecto, que todavía no tiene un esquema `dev`, se imprimió:

```text
The Xcode project defines schemes: FlutterFramework, FlutterGeneratedPluginSwiftPackage, Runner
You must specify a --flavor option to select one of the available schemes.
```

## Prueba de que ambos acaban como constantes en el binario

`appFlavor` está declarado en `package:flutter/services.dart`, y en Flutter 3.47.7 sigue siendo una simple consulta con `String.fromEnvironment`:

```dart
// Flutter 3.47.7, packages/flutter/lib/src/services/flavor.dart
const String? appFlavor = String.fromEnvironment('FLUTTER_APP_FLAVOR') != ''
    ? String.fromEnvironment('FLUTTER_APP_FLAVOR')
    : null;
```

Así que el flavor llega a Dart igual que el modo: como una constante en tiempo de compilación. Para demostrarlo, el `main.dart` de la demostración registra ambos:

```dart
// Flutter 3.44.8, lib/main.dart
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

void main() {
  debugPrint('FLAVORPROBE appFlavor=$appFlavor kDebugMode=$kDebugMode '
      'kProfileMode=$kProfileMode kReleaseMode=$kReleaseMode');
  runApp(const SizedBox());
}
```

Entonces `strings` sobre el snapshot AOT dentro de cada APK muestra que el compilador plegó toda la interpolación en un único literal. No queda ninguna consulta en tiempo de ejecución que inspeccionar:

```text
# strings lib/arm64-v8a/libapp.so | grep FLAVORPROBE
app-dev-release.apk:   FLAVORPROBE appFlavor=dev kDebugMode=false kProfileMode=false kReleaseMode=true
app-prod-release.apk:  FLAVORPROBE appFlavor=prod kDebugMode=false kProfileMode=false kReleaseMode=true
app-dev-profile.apk:   FLAVORPROBE appFlavor=dev kDebugMode=false kProfileMode=true kReleaseMode=false
```

Esto tiene dos consecuencias prácticas. No puedes cambiar de flavor en tiempo de ejecución, porque el binario solo contiene una respuesta. Y cualquier cosa que recompile Dart sin los defines correctos, como un hot restart desde `flutter attach`, obtiene `appFlavor == null`, que es el problema tratado en [cómo mantener appFlavor poblado tras un hot restart](/es/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).

La herramienta también protege el nombre. Intentar falsificar un flavor con un define falla antes de que empiece la compilación:

```text
# flutter build apk --dart-define=FLUTTER_APP_FLAVOR=qa
FLUTTER_APP_FLAVOR is used by the framework and cannot be set using --dart-define or --dart-define-from-file
```

## iOS y macOS: esquemas más configuraciones de compilación

En las plataformas de Apple un flavor son dos cosas que deben coincidir: un esquema con el nombre del flavor y un conjunto de configuraciones de compilación llamadas `Debug-<flavor>`, `Profile-<flavor>` y `Release-<flavor>`. La matriz modo por flavor está escrita literalmente en los nombres de las configuraciones. En Xcode, duplica `Debug`, `Profile` y `Release` para cada flavor, crea un esquema `dev` y establece su acción Run en `Debug-dev`, Profile en `Profile-dev` y Archive en `Release-dev`. Cada configuración puede entonces definir su propio `PRODUCT_BUNDLE_IDENTIFIER` y nombre visible.

Un comportamiento que conviene conocer en Flutter 3.47.7: `XcodeProjectInfo.buildConfigurationFor` busca primero una coincidencia exacta con `Debug-dev`, luego una única configuración cuyo nombre contenga tanto el modo como el esquema (sin distinguir mayúsculas), y si no existe ninguna **recurre a la configuración `Debug` simple**. Así que un error tipográfico como `Debug-dve` no hace fallar la compilación; compila discretamente con tu configuración base y con el identificador de bundle que esa configuración lleve, normalmente el de producción. Si una compilación de iOS con flavor parece de prod, comprueba los nombres de las configuraciones antes que nada.

`flutter run`, `flutter build ios`, `flutter build ipa` y `flutter build macos` aceptan `--flavor`. `flutter build web`, `flutter build windows` y `flutter build linux` no tienen la opción en 3.44.8, porque no existe un sistema de variantes nativo al que Flutter pueda reenviar.

## Assets específicos de un flavor y un flavor por defecto

Dos funciones de pubspec hacen los flavors menos dolorosos. Los assets pueden limitarse a flavors concretos, lo que mantiene los datos de prueba de dev y las configuraciones de depuración fuera del paquete de producción:

```yaml
# pubspec.yaml, Flutter 3.44.8
flutter:
  default-flavor: dev
  assets:
    - path: assets/dev/
      flavors:
        - dev
```

En la demostración, `assets/flutter_assets/assets/dev/config.json` estaba presente en `app-dev-debug.apk` y `app-dev-profile.apk` y ausente de `app-prod-debug.apk` y `app-prod-release.apk`. Recuerda que cualquier `rootBundle.loadString('assets/dev/config.json')` en código compartido lanzará ahora una excepción en `prod`, el mismo fallo "Unable to load asset" descrito en [el artículo sobre la solución de problemas de assets en pubspec](/es/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/).

`default-flavor` es lo que la herramienta usa cuando se omite `--flavor`. En `FlutterCommand.getBuildInfo()` la lógica es una sola línea, `cliFlavor ?? defaultFlavor`, sin cambios en 3.47.7. Con él definido, un simple `flutter build apk --release` en la demostración produjo `app-dev-release.apk` en lugar de fallar. Es cómodo para `flutter run` durante el desarrollo, pero piénsalo dos veces antes de confirmar `default-flavor: prod`: un trabajo de CI que olvide `--flavor` publicará entonces en silencio el flavor que nombre el archivo.

## A qué eje pertenece cada ajuste

Una forma rápida de decidir dónde vive un dato de configuración:

- **Depende de cómo se compila o se depura el código** (registro detallado, `debugPaintSizeEnabled`, informes de fallos desactivados durante el desarrollo, superposiciones de rendimiento): usa el modo, mediante `kDebugMode` / `kReleaseMode`. Estas comprobaciones se eliminan por tree-shaking de las compilaciones release.
- **Depende de qué entorno o producto estás publicando** (URL base de la API, proyecto de Firebase, ID de bundle, nombre de la aplicación, icono, IDs de producto del paywall): usa un flavor, en el lado nativo para todo lo que lee el sistema operativo y mediante `appFlavor` para todo lo que lee Dart.
- **Es un valor, no una identidad** (un feature flag, un número de compilación, una clave no secreta): `--dart-define` o `--dart-define-from-file` suele ser más simple que un flavor. Los defines también son constantes en tiempo de compilación, así que se combinan con ambos ejes.
- **Es un secreto**: ninguna de las anteriores. Los flavors, los modos y los defines acaban como cadenas legibles en el binario, como muestra la salida de `strings` de arriba.

El error que hay que evitar es mapear entornos sobre modos, por ejemplo "debug habla con staging, release habla con prod". Funciona hasta que necesitas perfilar contra producción, depurar un fallo exclusivo de release contra staging, o enviar una compilación de staging a los testers mediante TestFlight, que requiere una compilación release. Mantén los ejes separados y todas las combinaciones seguirán siendo alcanzables.

Firebase es donde esto sale mal con más frecuencia en la práctica. Los archivos `google-services.json` por flavor viven en source sets de Android como `android/app/src/dev/`, y un desajuste ahí produce el tipo de fallo exclusivo de release tratado en [el inicio de sesión de Firebase Auth que no persiste en una compilación release](/es/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/). Los source sets de flavor también afectan a qué clases de Kotlin se compilan, que es una de las causas en [ClassNotFoundException para MainActivity](/es/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/), y los nombres de salida con flavor (`app-prod-release.apk`, `app-prodRelease.aab`) importan cuando compruebas las bibliotecas nativas por [el fallo de release "Could not create Dart VM instance"](/es/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## Artículos relacionados

- [How to keep appFlavor populated after a hot restart when using flutter attach](/es/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/)
- [Fix: ClassNotFoundException for MainActivity when a Flutter Android app launches](/es/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/)
- [Fix: Firebase Auth sign-in does not persist in a Flutter Android release build](/es/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/)
- [Fix: Could not create Dart VM instance in a Flutter release build after flutter upgrade](/es/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)
- [Fix: Unable to load asset in Flutter after adding an image to pubspec.yaml](/es/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/)

## Fuentes

- [Flutter docs: Flutter's build modes](https://docs.flutter.dev/testing/build-modes)
- [Flutter docs: Set up Flutter flavors for Android](https://docs.flutter.dev/deployment/flavors)
- [Flutter docs: Set up Flutter flavors for iOS and macOS](https://docs.flutter.dev/deployment/flavors-ios)
- [Android developers: Configure build variants](https://developer.android.com/build/build-variants)
- [`flavor.dart` at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter/lib/src/services/flavor.dart)
- [`flutter_command.dart` (`getBuildInfo`, `default-flavor`) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter_tools/lib/src/runner/flutter_command.dart)
- [`xcodeproj.dart` (scheme and build configuration matching) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter_tools/lib/src/ios/xcodeproj.dart)
- [`constants.dart` (`kReleaseMode`, `kProfileMode`, `kDebugMode`) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter/lib/src/foundation/constants.dart)
