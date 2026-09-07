---
title: "Cómo mantener appFlavor con valor después de un hot restart al usar flutter attach"
description: "flutter attach no tiene opción --flavor, así que el compilador residente que lanza nunca define FLUTTER_APP_FLAVOR y la constante appFlavor pasa a null en el primer hot restart. Tres soluciones: default-flavor en pubspec.yaml, flutter run --use-application-binary y un canal de plataforma que lee el flavor de forma nativa. Verificado en Flutter 3.47.2 / Dart 3.13.2."
pubDate: 2026-09-07
template: how-to
tags:
  - "flutter"
  - "dart"
  - "how-to"
  - "flavors"
  - "tooling"
lang: "es"
translationOf: "2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach"
translatedBy: "claude"
translationDate: 2026-09-07
---

`appFlavor` es una constante de tiempo de compilación, no una consulta en tiempo de ejecución, y `flutter attach` no tiene opción `--flavor`. Por eso, cuando te conectas a una app compilada y lanzada fuera de `flutter run`, el compilador frontend que arranca la herramienta se inicia sin `-DFLUTTER_APP_FLAVOR=...`, y el primer hot restart reemplaza tu `dev` correcto por `null`. La solución más rápida es `default-flavor` en `pubspec.yaml`, que `FlutterCommand.getBuildInfo()` lee para todos los comandos, incluido `attach`. Si necesitas que el flavor varíe por invocación, usa `flutter run --use-application-binary=<path> --flavor dev` en lugar de conectarte, o deja de leer `appFlavor` y obtén el flavor desde la plataforma. Todo lo que sigue se comprobó con Flutter 3.47.2 y Dart 3.13.2 en el canal stable.

## appFlavor son once líneas de const, y eso es toda la historia

La gente asume que `appFlavor` le pregunta algo al engine. No lo hace. Esta es la declaración completa, en `packages/flutter/lib/src/services/flavor.dart` de la rama stable:

```dart
// Flutter 3.47.2, packages/flutter/lib/src/services/flavor.dart
/// The flavor this app was built with.
///
/// This is equivalent to the value argued to the `--flavor` option at build time.
/// This will be `null` if the `--flavor` option was not provided.
const String? appFlavor = String.fromEnvironment('FLUTTER_APP_FLAVOR') != ''
    ? String.fromEnvironment('FLUTTER_APP_FLAVOR')
    : null;
```

`String.fromEnvironment` lo resuelve el CFE cuando compila el kernel, a partir de los flags `-D` que recibe el proceso del compilador. No tiene nada que ver con `Platform.environment`, nada que ver con la VM en ejecución y nada que ver con el APK que instalaste. El valor que tuviera el compilador en el momento de producir el kernel queda grabado.

Eso importa porque una sesión de depuración de Flutter tiene dos compiladores en su vida. El primero se ejecuta al compilar la app: `flutter build apk --flavor dev --debug` resuelve `--flavor` en `FlutterCommand.getBuildInfo()` y añade `FLUTTER_APP_FLAVOR=dev` a los dart defines, que terminan como `-DFLUTTER_APP_FLAVOR=dev` en la línea de comandos del frontend server. El segundo se ejecuta durante todo el resto de la sesión: el compilador residente que `flutter run` o `flutter attach` mantiene vivo para atender hot reload y hot restart. En `packages/flutter_tools/lib/src/compile.dart` los defines se vuelcan sobre ese proceso exactamente una vez, cuando arranca:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/compile.dart (abridged)
final List<String> command = <String>[
  engineDartPath,
  ...
  '--sdk-root', sdkRoot,
  '--target=$targetModel',
  '--no-print-incremental-dependencies',
  for (final Object dartDefine in dartDefines) '-D$dartDefine',
  ...buildModeOptions(buildMode, dartDefines),
  if (trackWidgetCreation) '--track-creation-locations',
  ...
];
```

No hay ningún canal para cambiar `dartDefines` después de eso. Cada hot reload y cada hot restart del resto de la sesión los atiende ese único proceso con ese único conjunto de defines. Si `FLUTTER_APP_FLAVOR` no estaba en la línea de comandos cuando arrancó, ningún reinicio lo va a recuperar.

## Qué registra attach y qué no

El constructor de `AttachCommand` es una lista de llamadas `uses*`. Esta es la parte relevante, literal de stable:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/commands/attach.dart
addBuildModeFlags(verboseHelp: verboseHelp, defaultToRelease: false, excludeRelease: true);
usesTargetOption();
usesPortOptions(verboseHelp: verboseHelp);
usesIpv6Flag(verboseHelp: verboseHelp);
usesFilesystemOptions(hide: !verboseHelp);
usesFuchsiaOptions(hide: !verboseHelp);
usesDartDefineOption();
usesDeviceUserOption();
```

`usesFlavorOption()` no está. `RunCommand` la llama en la línea 40 de `run.dart`; `AttachCommand` nunca lo hace. Y `getBuildInfo()`, que `attach` sí llama, resuelve el flavor así:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/runner/flutter_command.dart
final String? defaultFlavor = project.manifest.defaultFlavor;
final String? cliFlavor = getValue(BuildInfoOptions.flavor);
final String? flavor = cliFlavor ?? defaultFlavor;

_ensureReservedDartDefineIsUnset(kAppFlavor, dartDefines);
if (flavor != null) {
  dartDefines.add('$kAppFlavor=$flavor');
}
```

Sin la opción `--flavor` registrada, `cliFlavor` es `null`. Si `defaultFlavor` también es null, `flavor` es null, el `if` nunca se ejecuta y el compilador residente arranca sin el define. La app en el dispositivo es una compilación `dev`; el compilador que la atiende cree que los flavors no existen.

## La reproducción, en cuatro pasos

Este es [flutter/flutter#192261](https://github.com/flutter/flutter/issues/192261), reportado el 2026-09-03 y confirmado por triaje contra 3.47.2 stable. Se reproduce tanto en `platform-android` como en `platform-ios`.

1. Dale product flavors a una app y lee la constante en algún lugar visible:

   ```dart
   // Flutter 3.47.2 / Dart 3.13.2
   import 'package:flutter/material.dart';
   import 'package:flutter/services.dart';

   void main() => runApp(const FlavorApp());

   class FlavorApp extends StatelessWidget {
     const FlavorApp({super.key});

     @override
     Widget build(BuildContext context) {
       return MaterialApp(
         home: Scaffold(
           body: Center(
             child: Text('appFlavor = $appFlavor',
                 style: const TextStyle(fontSize: 28)),
           ),
         ),
       );
     }
   }
   ```

2. Compílala y lánzala con el flavor, pero fuera de `flutter run`:

   ```bash
   flutter build apk --flavor dev --debug
   adb install -r build/app/outputs/flutter-apk/app-dev-debug.apk
   adb shell monkey -p com.example.flavors.dev 1
   ```

3. Conéctate: `flutter attach --debug`. La pantalla sigue diciendo `appFlavor = dev`, porque todavía no se ha recompilado nada.

4. Pulsa `R` para un hot restart. La pantalla ahora dice `appFlavor = null`.

El paso 3 es lo que hace confuso el diagnóstico. El valor es correcto hasta el primer restart, así que el error parece pertenecer al código que acabas de editar y no a la herramienta.

## Solución 1: default-flavor en pubspec.yaml

`default-flavor` se añadió al esquema del pubspec en [flutter/flutter#147968](https://github.com/flutter/flutter/pull/147968), y [#169298](https://github.com/flutter/flutter/pull/169298) movió su resolución a `FlutterCommand.getBuildInfo()` para que aplique a todos los comandos que construyen un `BuildInfo`, no solo a `run` y `build`. `attach` es uno de esos comandos. Por eso esto funciona.

1. Añade el campo bajo la clave `flutter:` en `pubspec.yaml`:

   ```yaml
   # pubspec.yaml, Flutter 3.47.2
   name: flavors_example
   environment:
     sdk: ^3.13.0

   flutter:
     uses-material-design: true
     default-flavor: dev
   ```

2. Reinicia la sesión de attach. `flutter attach --debug` ahora resuelve `flavor` a `dev` desde el manifiesto, añade `FLUTTER_APP_FLAVOR=dev` a los defines y el hot restart sigue devolviendo `dev`.

3. Sigue usando `--flavor` de forma explícita donde exista la opción. El propio texto de ayuda de `usesFlavorOption()` dice que "Overrides the value of the `default-flavor` entry in the flutter pubspec", así que `flutter run --flavor staging` sigue ganando sobre `default-flavor: dev`.

La limitación es exactamente la que esperarías de un valor guardado en un archivo versionado: es un flavor, para todo el mundo, en todos los attach. Si tu CI se conecta a una compilación `staging` en una máquina y a una `dev` en otra, `default-flavor` no puede seguirlas. Hay una propuesta abierta, [#191376](https://github.com/flutter/flutter/pull/191376), para permitir valores de `default-flavor` específicos por plataforma, pero eso tampoco hace que el valor sea por invocación.

## Por qué se rechaza --dart-define=FLUTTER_APP_FLAVOR

La solución obvia es poner el define a mano, y `attach` sí registra `usesDartDefineOption()`, así que el flag se parsea. Aun así falla:

```bash
flutter attach --debug --dart-define=FLUTTER_APP_FLAVOR=dev
# FLUTTER_APP_FLAVOR is used by the framework and cannot be set using
# --dart-define or --dart-define-from-file
```

Esa protección es deliberada, y también cubre el entorno del proceso:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/runner/flutter_command.dart
void _ensureReservedDartDefineIsUnset(String define, List<String> dartDefines) {
  if (_platform.environment[define] != null) {
    throwToolExit('$define is used by the framework and cannot be set in the environment.');
  }
  if (dartDefines.any((String d) => d == define || d.startsWith('$define='))) {
    throwToolExit(
      '$define is used by the framework and cannot be '
      'set using --${FlutterOptions.kDartDefinesOption} or --${FlutterOptions.kDartDefineFromFileOption}',
    );
  }
}
```

`FLUTTER_APP_FLAVOR` acompaña a `FLUTTER_BUILD_NAME`, `FLUTTER_BUILD_NUMBER` y `FLUTTER_ENABLED_FEATURE_FLAGS` en esa lista reservada. Definir la variable en tu shell antes de ejecutar la herramienta tampoco la esquiva: la primera rama comprueba `_platform.environment` y sale con un mensaje distinto. Si antes hacías esto en compilaciones web, eso es [#172165](https://github.com/flutter/flutter/issues/172165), cerrado como inválido: el comportamiento anterior a 3.32 era el accidente, no el rechazo actual.

## Solución 2: ejecuta el binario ya compilado en lugar de conectarte

La mayoría recurre a `flutter attach` porque la app la compiló algo distinto de `flutter run`: una tarea de Gradle, un esquema de Xcode, un arnés de instrumentación. Si lo único que necesitas es "instala este artefacto y dame un ciclo de hot restart", `flutter run` hace justo eso y, a diferencia de `attach`, acepta `--flavor`:

```bash
# Flutter 3.47.2. run registers both --use-application-binary and --flavor.
flutter run \
  --use-application-binary=build/app/outputs/flutter-apk/app-dev-debug.apk \
  --flavor dev
```

`RunCommand` llama a `usesFlavorOption()` y lee `--use-application-binary` en `prebuiltApplicationBinaryPath`, así que obtienes un `HotRunner` real sobre un binario que compilaste tú, con `FLUTTER_APP_FLAVOR=dev` en el compilador residente. En iOS, apúntalo al bundle `.app` que produce `flutter build ios --flavor dev --debug` o tu esquema de Xcode. Esto es lo más parecido a una solución correcta sin tocar tu código Dart, y es la primera a la que recurro en CI.

No ayuda si de verdad no controlas el lanzamiento, por ejemplo cuando una app nativa anfitriona incrusta Flutter como módulo y arranca el engine por su cuenta. Para eso está la solución 3.

## Solución 3: lee el flavor desde la plataforma, no desde el kernel

Si el flavor tiene que sobrevivir a un attach arbitrario, deja de pedirle a una constante de tiempo de compilación un valor que el compilador no conoce. El flavor ya está presente de forma nativa, en `BuildConfig.FLAVOR` en Android y en el build setting que gobierne tu esquema de Xcode, y un canal de plataforma lo lee después de que el isolate se reinicie, no antes de compilar. La técnica es la misma que cubre [añadir código específico de plataforma sin escribir un plugin](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

Android primero. AGP 8.0 dejó de generar `BuildConfig` a menos que lo pidas, y la plantilla de app de Flutter no lo pide, así que actívalo:

```kotlin
// android/app/build.gradle.kts, AGP 8.13, Flutter 3.47.2
android {
    namespace = "com.example.flavors"

    buildFeatures {
        buildConfig = true
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
        }
        create("staging") {
            dimension = "env"
            applicationIdSuffix = ".staging"
        }
    }
}
```

Después responde a una llamada del canal en `MainActivity`:

```kotlin
// android/app/src/main/kotlin/com/example/flavors/MainActivity.kt
package com.example.flavors

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "com.example.flavors/flavor",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "getFlavor" -> result.success(BuildConfig.FLAVOR)
                else -> result.notImplemented()
            }
        }
    }
}
```

En iOS, añade un build setting definido por el usuario en cada xcconfig (`APP_FLAVOR = dev` en `Debug-dev.xcconfig`), exponlo en `Info.plist` como una cadena `FLUTTER_APP_FLAVOR` con valor `$(APP_FLAVOR)`, y léelo del bundle:

```swift
// ios/Runner/AppDelegate.swift, Xcode 26.4, Flutter 3.47.2
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let controller = window?.rootViewController as! FlutterViewController
    let channel = FlutterMethodChannel(
      name: "com.example.flavors/flavor",
      binaryMessenger: controller.binaryMessenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "getFlavor" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result(Bundle.main.object(forInfoDictionaryKey: "FLUTTER_APP_FLAVOR") as? String)
    }
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
```

Y del lado de Dart, resuélvelo una vez y usa `appFlavor` como respaldo en las plataformas que no tienen manejador nativo:

```dart
// Flutter 3.47.2 / Dart 3.13.2
import 'package:flutter/services.dart';

const _channel = MethodChannel('com.example.flavors/flavor');

/// Survives hot restart under `flutter attach`, because it is a call, not a const.
Future<String?> resolveFlavor() async {
  try {
    return await _channel.invokeMethod<String>('getFlavor') ?? appFlavor;
  } on MissingPluginException {
    return appFlavor; // desktop, web, unit tests
  }
}
```

El costo es que `resolveFlavor()` es asíncrono y `appFlavor` no lo es, así que todo lo que ramificaba según el flavor de forma síncrona en `main()` ahora tiene que esperarlo antes de `runApp`, o leerlo desde un provider. Eso es una refactorización real, y por eso solo la haría cuando las soluciones 1 y 2 no estén disponibles.

## Cosas que parecen este error pero no lo son

**El hotfix de 3.32.1.** Si buscas este síntoma vas a llegar a [#165803](https://github.com/flutter/flutter/issues/165803) y [#169160](https://github.com/flutter/flutter/issues/169160), donde `appFlavor` pasaba a null tras un hot restart con `flutter run --flavor` a secas y durante `flutter test --flavor`. Esa era otra causa: `KernelSnapshot` en `build_system/targets/common.dart` se saltaba añadir el flavor cuando ya había un define presente del tramo de xcodebuild de la compilación. [El PR #169602](https://github.com/flutter/flutter/pull/169602) lo cambió para quitar cualquier entrada existente y volver a añadir la suya al final, y la entrada del changelog llegó en **Flutter 3.32.1**. Si estás en 3.32.1 o posterior y sigues viendo null con `flutter run`, ese es un error nuevo, no este.

**Hot reload, no solo hot restart.** El conjunto de defines queda fijado cuando arranca el compilador residente, así que gobierna cada compilación incremental, no solo los restarts completos. Un hot reload que recompile una biblioteca que lee `appFlavor` puede reevaluar la constante a null en esa biblioteca mientras otras conservan el valor anterior. No des por hecho que `r` es seguro porque `R` no lo sea.

**Flavors que solo existen en Gradle.** `appFlavor` reporta el valor pasado a `--flavor`, que debe coincidir con el nombre de un product flavor. Si renombraste un flavor en `build.gradle.kts` pero seguiste compilando con el nombre viejo, la compilación falla antes de que esto importe. Configurar las propias dimensiones de flavor queda fuera del alcance de este artículo; si lo que falla es `assembleDevDebug`, eso está más cerca de [la lista de comprobación de assembleDebug con código de salida 1](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

**Acciones "Attach" del IDE.** IntelliJ chocó con la misma pared desde el otro lado en flutter-intellij#5237, donde la acción Attach pasaba `--flavor` y moría con `Could not find an option named 'flavor'`. La solución del IDE fue quitar el flag, y por eso conectarse desde Android Studio o VS Code muestra este comportamiento también. `default-flavor` es hoy lo único que arregla la ruta del IDE, porque no controlas su línea de comandos.

La propuesta upstream en #192261 es de una línea: llamar a `usesFlavorOption()` en el constructor de `AttachCommand`. `getBuildInfo()` ya convierte la opción en el define, así que no hace falta más plomería. Hasta que eso aterrice, trata a `appFlavor` bajo `attach` como "correcto exactamente una vez", y elige la de las tres soluciones anteriores que se corresponda con cuánto controlas del lanzamiento.

## Relacionado

- [Cómo añadir código específico de plataforma en Flutter sin plugins](/es/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) recorre la configuración de `MethodChannel` de la que depende la solución 3.
- [Fix: la tarea de Gradle assembleDebug falla con código de salida 1 en una compilación Android de Flutter](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) cubre las malas configuraciones de flavor y NDK que rompen la compilación antes de que `appFlavor` entre siquiera en juego.
- [Cómo apuntar a varias versiones de Flutter desde un único pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) vale la pena leerlo junto a la solución 2, porque `--use-application-binary` es sobre todo una jugada de CI.
- [Depurar Flutter iOS desde Windows: un flujo real con dispositivo](/es/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) es el otro lugar donde `flutter attach` se gana el sueldo, y ahí aplica la misma distinción entre constante y tiempo de ejecución.
- [Fix: el inicio de sesión de Firebase Auth no persiste en una compilación release de Android con Flutter](/es/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/) es buen complemento si tus flavors también significan proyectos de Firebase distintos.

## Fuentes

- [flutter/flutter#192261](https://github.com/flutter/flutter/issues/192261), el issue abierto que rastrea la falta de `--flavor` en `attach`, con confirmación de triaje en 3.47.2.
- [La constante `appFlavor`](https://api.flutter.dev/flutter/services/appFlavor-constant.html) en la documentación de la API de Flutter, y su código fuente en `packages/flutter/lib/src/services/flavor.dart`.
- [Opciones del pubspec de Flutter](https://docs.flutter.dev/tools/pubspec) para el campo `default-flavor`, y [Configurar flavors de Flutter para Android](https://docs.flutter.dev/deployment/flavors) para la configuración de flavors en sí.
- [flutter/flutter#147968](https://github.com/flutter/flutter/pull/147968) añadió `default-flavor`; [#169298](https://github.com/flutter/flutter/pull/169298) y su roll-forward [#169602](https://github.com/flutter/flutter/pull/169602) movieron la resolución del flavor a `getBuildInfo()`.
- [El CHANGELOG de Flutter](https://github.com/flutter/flutter/blob/main/CHANGELOG.md) para la entrada del hotfix 3.32.1 que cubre `appFlavor` en `flutter test` y hot restart.
- [Las notas de la versión 8.0 del Android Gradle Plugin](https://developer.android.com/build/releases/past-releases/agp-8-0-0-release-notes) para el cambio del valor por defecto de `buildFeatures.buildConfig` que la solución 3 tiene que sortear.
