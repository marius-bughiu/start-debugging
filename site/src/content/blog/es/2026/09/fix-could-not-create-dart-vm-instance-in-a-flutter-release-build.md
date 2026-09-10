---
title: "Solución: Could not create Dart VM instance en una compilación release de Flutter después de flutter upgrade"
description: "El APK de release se generó sin libapp.so. Flutter 3.44.0 a 3.44.4 podía omitirlo: actualiza a 3.44.5 o posterior y divide el bloque subprojects combinado."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "dart"
lang: "es"
translationOf: "2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build"
translatedBy: "claude"
translationDate: 2026-09-10
---

Tu compilación release no contiene el código Dart compilado. El motor busca el snapshot AOT en `libapp.so`, no encuentra nada y no puede arrancar la VM. Después de actualizar a Flutter 3.44.0 hasta 3.44.4, la causa habitual es una regresión del plugin de Gradle que omitía `libapp.so` del APK o del app bundle sin avisar. Ejecuta `unzip -l` sobre el APK para confirmarlo, actualiza a Flutter 3.44.5 o posterior (3.47.3 es la versión estable actual) y divide el bloque `subprojects` combinado de `android/build.gradle` en dos bloques.

Todo lo que sigue se verificó contra el código fuente de Flutter 3.44.x y 3.47.3 en GitHub, el changelog de los hotfixes de 3.44 y el código del motor que imprime estas líneas.

## El error tal como lo imprime logcat

```text
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm_data.cc(20)] VM snapshot invalid and could not be inferred from settings.
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm.cc(253)] Could not set up VM data to bootstrap the VM from.
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm_lifecycle.cc(85)] Could not create Dart VM instance.
```

La aplicación se cierra antes de que se ejecute `main()`. En 3.44 el crash nativo suele aparecer después en `FlutterJNI.performNativeAttach`. Los motores más antiguos añadían una cuarta línea, `[FATAL:flutter/shell/common/shell.cc] Check failed: vm. Must be able to initialize the VM.` La variante de macOS de este fallo imprime `Isolate snapshot invalid and could not be inferred from settings.` en `dart_vm_data.cc(31)` en lugar de la línea del VM snapshot. Esa tiene otra causa, que se explica más abajo.

El patrón que trae a la gente a esta página: las compilaciones debug y `flutter run` funcionan bien, un proyecto nuevo de `flutter create` funciona bien, y la compilación release de la app real falla al iniciar. Empezó solo con `flutter upgrade`, y volver a la versión anterior lo hace desaparecer.

## Por qué el motor no encuentra un VM snapshot

Una compilación release no incluye código fuente Dart ni bytecode de kernel. `gen_snapshot` compila tu app de forma anticipada en una biblioteca compartida nativa: `libapp.so` en Android y `App.framework` en iOS y macOS. Esa biblioteca exporta los símbolos del snapshot de la VM y del snapshot del isolate, y el motor arranca a partir de ellos.

La primera línea del log viene de `DartVMData::Create` en el motor. Primero toma el snapshot que le pasó el embedder. Si falta o no es válido, recurre a `DartSnapshot::VMSnapshotFromSettings`, que busca los símbolos del snapshot en las bibliotecas listadas en `settings.application_library_paths`. Si eso no devuelve nada, registra el error y devuelve vacío. Las otras dos líneas son sus llamadores rindiéndose. Así que "VM snapshot invalid" casi nunca significa un snapshot corrupto. Significa que no había ninguna biblioteca AOT donde buscar.

Eso convierte la pregunta en: ¿por qué el paquete no contiene `libapp.so`? En orden de probabilidad:

1. **La regresión de Gradle de Flutter 3.44.0 a 3.44.4.** `libapp.so` se omitía de los APK y app bundles en algunas estructuras de proyecto. Es la que aparece después de `flutter upgrade`.
2. **`debuggable true` en el build type release.** El plugin de Gradle de Flutter compila entonces Dart en modo debug, así que no se genera ninguna biblioteca AOT.
3. **macOS Big Sur ejecutando una app compilada con Flutter 3.44 o posterior.** La biblioteca está ahí, pero el cargador dinámico antiguo no puede resolver los símbolos en la nueva salida Mach-O.

## Confírmalo: mira dentro del APK

No adivines, verifica. Tarda diez segundos:

```bash
# Flutter 3.44.x, Android release build
flutter build apk --release
unzip -Z1 build/app/outputs/flutter-apk/app-release.apk | grep -E 'lib/[^/]+/lib(app|flutter)\.so' | sort
```

Un APK sano lista ambas bibliotecas para cada ABI que distribuyes:

```text
lib/arm64-v8a/libapp.so
lib/arm64-v8a/libflutter.so
lib/armeabi-v7a/libapp.so
lib/armeabi-v7a/libflutter.so
lib/x86_64/libapp.so
lib/x86_64/libflutter.so
```

El APK de [flutter/flutter#187388](https://github.com/flutter/flutter/issues/187388), el reporte principal de esta regresión, listaba `libflutter.so` y `libdartjni.so` para las tres ABI y ningún `libapp.so`. Esa asimetría es la firma del problema. `libflutter.so` viene de una dependencia AAR, así que sobrevivió. `libapp.so` venía por otro camino, así que no.

En un app bundle, las rutas están bajo `base/lib/`:

```bash
# Flutter 3.44.x
unzip -Z1 build/app/outputs/bundle/release/app-release.aab | grep 'libapp.so'
```

Con flavors, el nombre del archivo incluye el flavor (`app-prod-release.apk`, `app-prodRelease.aab`). Revisa cada ABI, no solo arm64. En la variante con flavors del bug, una ABI puede estar presente y el resto faltar.

## Qué cambió en Flutter 3.44

Antes de 3.44, el plugin de Gradle de Flutter entregaba `libapp.so` dentro de una dependencia jar. Eso lo ocultaba del stripping de bibliotecas nativas de AGP, así que [flutter/flutter#181275](https://github.com/flutter/flutter/pull/181275) (fusionado el 2026-01-26, publicado en 3.44.0 el 2026-05-15) lo movió a un directorio de source set `jniLibs` que llena el plugin. Ese cambio hizo que `libapp.so` pudiera pasar por stripping, y también volvió frágil su entrega de dos maneras, según la descripción de la corrección, [flutter/flutter#188119](https://github.com/flutter/flutter/pull/188119):

1. El directorio `jniLibs` se resolvía de forma anticipada al configurar `:app`, pero la tarea de copia lo escribía de forma diferida. Si `:app` se evaluaba antes de que se redirigiera su directorio de build, ambos discrepaban sobre dónde estaba ese directorio, y el `libapp.so` preparado nunca se fusionaba. Eso ocurre con el antiguo bloque `subprojects` combinado más cualquier plugin cuyo nombre de proyecto Gradle quede alfabéticamente antes de `app`.
2. La tarea de copia escribía dentro del propio directorio de salida de la tarea de Flutter. Las salidas superpuestas rompían las comprobaciones up-to-date de Gradle. En un proyecto con flavors, un `flutter run` en un dispositivo (una ABI) seguido de un `flutter build appbundle` completo dejaba las demás ABI sin `libapp.so` ([#187388](https://github.com/flutter/flutter/issues/187388)). Un reporte relacionado mostraba compilaciones incrementales con flavors que distribuían el `libapp.so` de la compilación anterior ([#187553](https://github.com/flutter/flutter/issues/187553)).

Los app bundles fallaban de forma más visible. La misma biblioteca ausente aparece en tiempo de compilación como `Release app bundle failed to strip debug symbols from native libraries` ([#186810](https://github.com/flutter/flutter/issues/186810)). Los APK no tienen esa comprobación, así que compilan sin errores y fallan en el dispositivo.

## Repro mínimo del disparador de subprojects

Esta es la estructura que el equipo de Flutter codificó en la prueba de integración `gradle_libapp_so_packaging_test.dart` que acompaña a la corrección. Un `android/build.gradle` raíz de una plantilla antigua, con ambas instrucciones en un solo bloque:

```groovy
// android/build.gradle, pre-2021 template shape, broken on Flutter 3.44.0 to 3.44.4
rootProject.buildDir = "../build"

subprojects {
    project.buildDir = "${rootProject.buildDir}/${project.name}"
    project.evaluationDependsOn(':app')
}
```

Agrega cualquier plugin con código nativo de Android cuyo nombre quede antes de `app`, por ejemplo `android_intent_plus`, compila con `flutter build apk --release` en 3.44.4, y el APK no tiene `libapp.so`. `subprojects {}` recorre los proyectos en orden alfabético. `evaluationDependsOn(':app')` se dispara al procesar el primer plugin, lo que obliga a configurar `:app` antes de que el bucle haya llegado a él y redirigido su `buildDir`.

## Solución 1: actualiza a Flutter 3.44.5 o posterior

La corrección llegó a master el 2026-06-23 y se hizo cherry-pick a [Flutter 3.44.5](https://github.com/flutter/flutter/releases/tag/3.44.5) (2026-07-06). La entrada del changelog de 3.44.5 dice: "When building Android app bundles using flavors, or with an old app template combined with a plugin coming alphabetically before app, fixes problems with failing to include libapp.so." Ahora prepara `libapp.so` mediante una tarea dedicada `CopyFlutterJniLibsTask` y registra la salida con la API de variantes de AGP, `variant.sources.jniLibs.addGeneratedSourceDirectory(...)`. AGP pasa a ser dueño de la dependencia de la tarea y resuelve la ruta de forma diferida, sin importar el orden de evaluación.

```bash
# upgrade to current stable (3.47.3 as of 2026-09-10)
flutter upgrade
flutter --version

# clear the stale intermediates that the broken versions left behind
flutter clean
flutter pub get
flutter build apk --release
```

Luego vuelve a ejecutar la comprobación con `unzip` antes de publicar. Si tienes que quedarte en la línea 3.44, de 3.44.5 a 3.44.9 todas incluyen la corrección. En 3.44.0 a 3.44.4, `flutter clean` por sí solo solo ayuda con el disparador de flavors, y solo hasta el siguiente `flutter run` en un único dispositivo. No hace nada contra el disparador de subprojects.

Si fijas la versión de Flutter en CI con FVM o un archivo `.flutter-version`, actualiza también esa versión fijada. Un `flutter upgrade` local no cambia la versión con la que compila tu pipeline, y así es como un crash que "ya está arreglado en mi máquina" sigue llegando a Play Store. Fijar la versión sigue siendo la idea correcta, como se argumenta en [el artículo sobre compilaciones reproducibles de Flutter](/es/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/). Solo muévela a propósito.

## Solución 2: divide el bloque subprojects combinado

Hazlo incluso después de actualizar. El bloque combinado se eliminó de la plantilla hace años ([flutter/flutter#91030](https://github.com/flutter/flutter/pull/91030)) porque causaba errores de orden, y un mantenedor de Flutter señaló en [#186810](https://github.com/flutter/flutter/issues/186810) que la sintaxis combinada probablemente sigue sin estar soportada en general, aunque la interacción de 3.44 ya está corregida. El `build.gradle.kts` raíz de la plantilla `android-kotlin` de Flutter 3.47.3 se ve así:

```kotlin
// android/build.gradle.kts, Flutter 3.47.3 app template
val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}
```

Si sigues en Groovy, el equivalente es:

```groovy
// android/build.gradle, Groovy equivalent of the Flutter 3.47.3 template
rootProject.buildDir = "../build"

subprojects {
    project.buildDir = "${rootProject.buildDir}/${project.name}"
}
subprojects {
    project.evaluationDependsOn(':app')
}
```

Dos bloques significan que el directorio de build de cada proyecto se redirige antes de que algo obligue a evaluar `:app`. Revisa también restos como un tercer bloque `subprojects { afterEvaluate { ... compileSdkVersion ... } }` que fuerza valores en los plugins. Vienen de viejos workarounds de Stack Overflow y suelen causar el siguiente fallo al actualizar Gradle. Cuando Gradle falla de verdad en lugar de hacerlo en silencio, [el error real suele estar enterrado encima de la línea del código de salida](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

## Solución 3: quita debuggable true del build type release

Esta causa es anterior a 3.44 y sigue presente en 3.47.3. El plugin de Gradle de Flutter elige el modo de compilación de Dart a partir del build type de Android en `FlutterPluginUtils.buildModeFor`:

```kotlin
// Flutter 3.47.3, packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt
internal fun buildModeFor(buildType: BuildType): String {
    if (buildType.name == "profile") {
        return "profile"
    } else if (buildType.isDebuggable) {
        return "debug"
    }
    return "release"
}
```

Así que esta configuración compila tu código Dart en modo debug, sin `libapp.so`, mientras el resto del pipeline sigue esperando un motor release:

```kotlin
// android/app/build.gradle.kts, Flutter 3.47.3: this crashes on launch
android {
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isDebuggable = true // makes buildModeFor() return "debug"
        }
    }
}
```

El resultado son las mismas tres líneas de log. El reporte es [flutter/flutter#54126](https://github.com/flutter/flutter/issues/54126), todavía abierto. Quita `isDebuggable = true` (`debuggable true` en Groovy) de `release`. Si lo querías para adjuntar un depurador nativo a una compilación firmada, usa `flutter build apk --profile`, o agrega un build type separado para eso y acepta que ejecuta Dart en modo JIT. Un build type personalizado como `staging` sin `isDebuggable` obtiene Dart en modo release, que es lo que quieres ahí.

## La variante de macOS Big Sur: Isolate snapshot invalid

Si el log dice `Isolate snapshot invalid and could not be inferred from settings.` y la máquina tiene macOS 11 Big Sur, la biblioteca existe y no falta nada en el paquete. A partir de Flutter 3.44, `App.framework` en iOS y macOS lo escribe directamente `gen_snapshot` (`--snapshot_kind=app-aot-macho-dylib`) en lugar de enlazarlo `ld64`. La nueva dylib no tiene exports trie ni tabla de contenidos. El dyld de Big Sur (dyld-832) recurre entonces a una búsqueda binaria sobre la tabla de símbolos, que la nueva salida no satisface. Algunos símbolos del snapshot se resuelven y otros no, así que el VM snapshot carga y el isolate snapshot falla. El dyld de Monterey usa una búsqueda lineal en ese caso y carga el mismo binario sin problemas.

Esto se investigó en [flutter/flutter#189183](https://github.com/flutter/flutter/issues/189183) y [dart-lang/sdk#64051](https://github.com/dart-lang/sdk/issues/64051), y no se va a corregir. Flutter 3.47 lista Big Sur (11) y anteriores como no soportados en la [página de plataformas soportadas](https://docs.flutter.dev/reference/supported-platforms), y el equipo de Flutter no hace cherry-pick a líneas estables antiguas. Tus opciones son quedarte en Flutter 3.41.x para las compilaciones que deben ejecutarse en Big Sur, o subir `MACOSX_DEPLOYMENT_TARGET` a 12.0 y dejar fuera a esos usuarios. Un workaround de la comunidad reordena las entradas de la tabla de símbolos después de compilar y vuelve a firmar el framework. Un mantenedor de Dart dijo después que el análisis detrás de él era parcialmente incorrecto (la pieza que falta es la tabla de contenidos, no el orden de los símbolos), así que yo no lo publicaría.

Puedes inspeccionar lo que produjo tu compilación con `nm`:

```bash
# Flutter 3.47.3, macOS release build
flutter build macos --release
nm -p build/macos/Build/Products/Release/*.app/Contents/Frameworks/App.framework/App | grep kDart
```

## Errores parecidos que no son este bug

- Una compilación debug de iOS que muere al iniciar con `mprotect failed: 13 (Permission denied)` también es la VM de Dart fallando, pero en modo JIT en iOS 26. Esa es [otra solución: actualizar a Flutter 3.35 o posterior](/es/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/).
- Una compilación release que inicia bien y luego se comporta mal ya pasó este punto por completo: la VM arrancó. Perder la sesión de Firebase solo en release, por ejemplo, se reduce a un `google-services.json` distinto, una renovación de token rechazada o App Check. Consulta [la solución de Firebase Auth solo en release](/es/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/).
- En una app con flavors, que `appFlavor` pase a `null` después de un hot restart es una carencia de `flutter attach`, no un problema de empaquetado. Consulta [cómo mantener appFlavor después de un hot restart](/es/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).
- Los módulos add-to-app compilados como AAR pueden mostrar las mismas tres líneas cuando el AAR se compiló en otro modo o con un checkout de Flutter modificado ([#114881](https://github.com/flutter/flutter/issues/114881)). Vuelve a compilar el AAR con `flutter build aar` desde un SDK sin modificar y revisa la carpeta `jni/` del AAR en busca de `libapp.so`.

## Relacionado

- Qué más cambió en la versión que introdujo la regresión: [Flutter 3.44 y SwiftPM por defecto](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Fallos de Gradle que sí rompen la compilación: [Gradle task assembleDebug failed with exit code 1](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- Por qué importa fijar la versión de Flutter, y por qué hay que moverla deliberadamente: [compilaciones reproducibles de Flutter](/es/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).
- El otro crash de arranque de la VM de Dart: [mprotect permission denied en iOS](/es/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/).

## Fuentes

- [flutter/flutter#187388](https://github.com/flutter/flutter/issues/187388), el reporte de 3.44.1 con el listado del APK que mostró que faltaba `libapp.so` en todas las ABI.
- [flutter/flutter#188119](https://github.com/flutter/flutter/pull/188119), la corrección, con el análisis de la causa raíz de ambos disparadores.
- [flutter/flutter#181275](https://github.com/flutter/flutter/pull/181275), el cambio que sacó `libapp.so` de un jar.
- [flutter/flutter#186810](https://github.com/flutter/flutter/issues/186810) y [#187553](https://github.com/flutter/flutter/issues/187553), las variantes del app bundle y del flavor desactualizado.
- [CHANGELOG de Flutter, hotfix 3.44.5](https://github.com/flutter/flutter/blob/stable/CHANGELOG.md), que lista los tres issues.
- [flutter/flutter#54126](https://github.com/flutter/flutter/issues/54126), `debuggable true` en un build type release.
- [flutter/flutter#189183](https://github.com/flutter/flutter/issues/189183) y [dart-lang/sdk#64051](https://github.com/dart-lang/sdk/issues/64051), el fallo de carga de `App.framework` en Big Sur.
- Código fuente del motor de Flutter, `engine/src/flutter/runtime/dart_vm_data.cc` y `dart_snapshot.cc` en la rama `stable`, para ver de dónde vienen las líneas del log.
