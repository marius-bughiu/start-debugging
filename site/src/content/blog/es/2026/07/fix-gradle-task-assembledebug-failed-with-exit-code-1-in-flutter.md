---
title: "Solución: Gradle task assembleDebug failed with exit code 1 en una compilación de Android con Flutter"
description: "Esa línea es un envoltorio, no el error. Vuelve a ejecutar con flutter run --verbose o ./gradlew assembleDebug --stacktrace, lee el fallo real de Gradle y corrige eso."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "dart"
lang: "es"
translationOf: "2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-31
---

La solución en una frase: `Gradle task assembleDebug failed with exit code 1` no es un error, es Flutter informando de que Gradle terminó con un código distinto de cero. El fallo real se imprime encima y casi siempre queda recortado de la consola. Vuelve a ejecutar con `flutter run --verbose`, o entra en `android/` y ejecuta `./gradlew assembleDebug --stacktrace`, y corrige lo que Gradle diga de verdad bajo `* What went wrong:`. En julio de 2026 la respuesta más común es el Kotlin integrado del Android Gradle Plugin 9 chocando con el antiguo plugin `kotlin-android`, lo que aparece como `Cannot add extension with name 'kotlin'`.

```text
FAILURE: Build failed with an exception.

BUILD FAILED in 47s
Running Gradle task 'assembleDebug'...                             48.2s
Error: Gradle task assembleDebug failed with exit code 1
```

Esta guía está escrita contra Flutter 3.44.7 y Dart 3.12.2, el canal estable a fecha de 2026-07-20, con notas sobre Android Gradle Plugin (AGP) 8.x y 9.x, Gradle 8.13, y JDK 17 y 21. El procedimiento de diagnóstico no ha cambiado en años; las causas ordenadas más abajo sí, y la primera es nueva desde el despliegue de AGP 9.

## Por qué el mensaje no te dice nada

`assembleDebug` es una tarea de Gradle para Android. La herramienta de Flutter invoca el wrapper de Gradle en el directorio `android/` de tu proyecto, transmite la salida y luego comprueba el código de salida. Si el código es distinto de cero, la herramienta lanza exactamente una línea: el nombre de la tarea y el código de salida. No tiene ni idea de qué falló, porque los fallos de Gradle no están tipados, son texto.

Entonces dos cosas conspiran contra ti:

1. La herramienta de Flutter filtra la salida de Gradle. Oculta el ruido de la fase de configuración para que una compilación normal se vea limpia, y al hacerlo a veces descarta el bloque que necesitas.
2. Gradle mismo trunca. Sin `--stacktrace`, una cadena de `Caused by:` de tres niveles de profundidad se resume en una sola línea que puede no nombrar el plugin culpable.

Así que el primer movimiento nunca es adivinar. Es hacer que la compilación imprima la verdad.

## Consigue el error real antes de cambiar nada

Ejecuta esto en orden y detente en el primero que te dé un bloque `* What went wrong:` que nombre una tarea y una causa:

```bash
# Flutter 3.44.7, Dart 3.12.2
flutter run --verbose
```

Si eso sigue siendo opaco, esquiva por completo la herramienta de Flutter y habla directamente con Gradle. Este es el paso que la mayoría se salta, y es el que funciona:

```bash
# From the Flutter project root. Use gradlew.bat on Windows.
cd android
./gradlew assembleDebug --stacktrace --info
```

Gradle ahora imprime el fallo completo con el módulo que lo produjo:

```text
* What went wrong:
A problem occurred configuring project ':file_picker'.
> Failed to apply plugin 'kotlin-android'.
   > Cannot add extension with name 'kotlin', as there is an extension
     already registered with that name.
```

Eso es un error real y corregible. `Gradle task assembleDebug failed with exit code 1` nunca lo fue.

Vale la pena ejecutar un diagnóstico más antes de tocar un solo archivo de Gradle, porque atrapa una clase entera de causas por sí solo:

```bash
# Validates the Java, Gradle, and AGP versions against each other
flutter analyze --suggestions
```

La [guía de migración de Android Java Gradle](https://docs.flutter.dev/release/breaking-changes/android-java-gradle-migration-guide) documenta este validador: evalúa tu JDK, el wrapper de Gradle y las versiones de AGP como un trío y te dice cuál está fuera de rango.

## Causa 1: el Kotlin integrado de AGP 9 frente al plugin `kotlin-android`

Esta es la causa dominante en 2026 y la que más se diagnostica mal, porque se dispara durante la fase de configuración de Gradle, antes de que se compile una sola línea de Dart o Kotlin.

AGP 9.0 incluye soporte integrado de Kotlin y registra automáticamente una extensión de Gradle llamada `kotlin`. Cualquier módulo que todavía aplique el antiguo Kotlin Gradle Plugin (`kotlin-android`, también conocido como KGP) intenta registrar una segunda extensión con el mismo nombre, y Gradle se niega:

```text
Cannot add extension with name 'kotlin', as there is an extension
already registered with that name.
```

El módulo nombrado en `A problem occurred configuring project ':x'` te dice si el culpable es tu propia app o un paquete del que dependes. Si es un paquete de plugin como `file_picker` o `wakelock_plus`, no puedes corregirlo en tus propios archivos de compilación; actualizas el paquete o desactivas el Kotlin integrado.

La salida de emergencia, según la [guía de migración a Kotlin integrado para desarrolladores de apps](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), va en `android/gradle.properties`:

```properties
# android/gradle.properties -- Flutter 3.44, AGP 9.x
android.newDsl=false
android.builtInKotlin=false
```

Eso restaura el comportamiento previo a AGP 9 para toda la compilación, y el shim temporal de KGP de Flutter mantiene funcionando el plugin antiguo. Te compra tiempo; no es el destino. Flutter ya ha [registrado la eliminación del soporte de KGP](https://github.com/flutter/flutter/issues/184837) y [la eliminación del antiguo DSL de AGP](https://github.com/flutter/flutter/issues/184839) para una versión futura.

La migración real, una vez que todos los plugins de los que dependes soportan AGP 9, es eliminar el plugin y el bloque `kotlinOptions` de `android/app/build.gradle.kts`:

```kotlin
// android/app/build.gradle.kts -- AGP 9.0+, Flutter 3.47+
plugins {
    id("com.android.application")
    // id("kotlin-android")  <-- delete this line
}

android {
    // kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }  <-- delete this block
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}
```

Después cambia el flag:

```properties
# android/gradle.properties
android.builtInKotlin=true
```

Fíjate en los mínimos de versión. Flutter 3.44 subió el KGP mínimo soportado a 2.0.0, y la documentación indica que habilitar el Kotlin integrado requiere Flutter 3.47 o posterior. En 3.44 estable, el movimiento correcto es `android.builtInKotlin=false` más una actualización de paquetes, no una migración a medias. Si en cambio tu compilación se queja de que el propio plugin de Kotlin es demasiado antiguo, ese es un fallo distinto con una solución distinta, cubierto en [el error de versión del Kotlin Gradle plugin](/es/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/).

## Causa 2: tu JDK y tu wrapper de Gradle no se ponen de acuerdo

La firma es un número de versión mayor de archivo de clase:

```text
Caused by: org.codehaus.groovy.control.MultipleCompilationErrorsException: startup failed:
...
Unsupported class file major version 65
```

La versión mayor 61 es Java 17, la 65 es Java 21. El número te dice qué JDK está ejecutando la compilación; el fallo te dice que tu wrapper de Gradle es demasiado antiguo para entender bytecode de esa versión. Las versiones de Gradle anteriores a 7.3 no pueden ejecutarse bajo Java 17 en absoluto, y cada versión de Gradle tiene su propio techo para el JDK más nuevo que acepta.

Esto muerde más fuerte cuando no cambiaste nada: Android Studio se actualizó, su JDK incluido pasó de 17 a 21, y tu wrapper de Gradle de hace cinco años se rompió de la noche a la mañana.

Comprueba qué JDK está usando Flutter:

```bash
flutter doctor -v
```

Luego, o bien sube el wrapper:

```bash
# From android/. Pick the version flutter analyze --suggestions recommends.
./gradlew wrapper --gradle-version=8.13
```

O fija Flutter a un JDK que el wrapper pueda manejar:

```bash
# macOS example. /usr/libexec/java_home -V lists installed JDKs.
flutter config --jdk-dir=/opt/homebrew/Cellar/openjdk@17/17.0.13/libexec/openjdk.jdk/Contents/Home
```

Prefiere mover Gradle hacia adelante. Fijar un JDK antiguo es una decisión que volverás a pagar en la siguiente subida de AGP.

## Causa 3: desajuste de versión del NDK entre plugins

Cualquier paquete con código nativo declara una versión de NDK. Si dos de ellos no coinciden con lo que configuró tu app, la compilación se detiene:

```text
* What went wrong:
Execution failed for task ':app:configureCMakeDebug[arm64-v8a]'.
> [CXX1101] NDK at .../ndk/26.3.11579264 did not have a source.properties file
```

O, de forma más explícita:

```text
Your project is configured with Android NDK 26.3.11579264, but the following
plugin(s) depend on a different Android NDK version:
- path_provider_android requires Android NDK 27.0.12077973
```

Las versiones del NDK son retrocompatibles, así que la solución es adoptar la versión más alta que pida cualquier dependencia:

```kotlin
// android/app/build.gradle.kts -- Flutter 3.44
android {
    ndkVersion = "27.0.12077973"
}
```

Si el error menciona un `source.properties` faltante, el directorio del NDK nombrado existe pero es una descarga parcial. Borra ese directorio dentro de la carpeta `ndk/` de tu SDK de Android y reinstala la versión a través del SDK Manager, luego `flutter clean`.

## Causa 4: un plugin sube minSdkVersion por encima del tuyo

La fusión del manifiesto ocurre dentro de `assembleDebug`, así que un conflicto de nivel de SDK aparece como el mismo envoltorio genérico:

```text
* What went wrong:
Execution failed for task ':app:processDebugMainManifest'.
> Manifest merger failed : uses-sdk:minSdkVersion 21 cannot be smaller than
  version 23 declared in library [:some_plugin]
```

Sube el suelo en lugar de suprimir la fusión con `tools:overrideLibrary`, que solo mueve el fallo a tiempo de ejecución en los dispositivos que excluiste:

```kotlin
// android/app/build.gradle.kts
android {
    defaultConfig {
        minSdk = 23
    }
}
```

La misma forma de fallo con un paquete concreto se recorre en el artículo sobre [background_fetch requiriendo minSdkVersion 21](/es/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/). Si en cambio el fusionador se queja de clases duplicadas de la support library, estás ante un problema completamente distinto: mira [el conflicto de AndroidX durante una compilación de Android con Flutter](/es/2026/05/fix-androidx-conflict-during-flutter-android-build/).

## Causa 5: un plugin sin mantenimiento no tiene namespace

AGP 8.0 hizo obligatoria la propiedad `namespace` y dejó de leer `package` desde `AndroidManifest.xml`. Un paquete que no ha publicado nada desde AGP 7 falla en la configuración:

```text
* What went wrong:
A problem occurred configuring project ':some_old_plugin'.
> Namespace not specified. Specify a namespace in the module's build file.
```

No hay una forma soportada de inyectar un namespace en el paquete de otra persona desde tu app. En orden de preferencia: actualiza el paquete, reemplázalo, o haz un fork y añade `namespace 'com.example.some_old_plugin'` a su `android/build.gradle`. Circulan mucho scripts que reescriben archivos bajo `~/.pub-cache` para este error y son una trampa: la caché se regenera, así que la corrección desaparece en la siguiente máquina y en CI.

## Causa 6: no hay nada mal salvo el estado en disco

No todo código de salida 1 es un problema de configuración. Un artefacto escrito a medias en `build/`, un demonio de Gradle sosteniendo un classpath obsoleto, o un directorio `.dart_tool` de una versión distinta del SDK producen fallos que parecen estructurales y no lo son. Antes de una sesión larga de depuración, limpia los casos baratos:

```bash
flutter clean
cd android && ./gradlew --stop && ./gradlew clean && cd ..
flutter pub get
flutter run
```

Si compila después de eso, tenías un problema de estado obsoleto y no hay nada más que corregir. Si un `pub get` falla por el camino, la salida del solucionador de restricciones es su propio ejercicio de diagnóstico, cubierto en [cómo leer un error version solving failed en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Variantes que aterrizan en esta página por error

- **`Gradle task assembleRelease failed with exit code 1`**: el mismo envoltorio alrededor de la variante de release. Todo lo anterior aplica, más R8 y la reducción de código, que solo se ejecutan en release. Si debug compila y release no, empieza poniendo `isMinifyEnabled = false` para confirmar que R8 es el culpable, y luego corrige las reglas keep que faltan en vez de dejar la reducción desactivada.
- **`Gradle task assembleDebug failed with exit code 1` inmediatamente, en menos de dos segundos**: eso no es un fallo de compilación. Gradle no pudo arrancar. Revisa la URL de la distribución del wrapper en `android/gradle/wrapper/gradle-wrapper.properties` y tu acceso de red a `services.gradle.org`.
- **`Execution failed for task ':app:checkDebugAarMetadata'`**: una dependencia requiere un `compileSdk` más alto del que declara tu app. Sube `compileSdk` en `android/app/build.gradle.kts`; es un techo de tiempo de compilación, no un objetivo de tiempo de ejecución, así que subirlo no cambia el comportamiento en el dispositivo.
- **El fallo solo ocurre en CI**: compara las versiones de JDK, Android SDK y NDK del runner con las de tu máquina. La Causa 2 y la Causa 3 explican casi todos los reportes de "en local pasa, en CI falla", y ambas tienen forma de entorno, no de código.
- **El fallo apareció tras actualizar Flutter**: revisa el índice de cambios incompatibles de la versión antes de depurar el síntoma. Un salto de framework que también mueve las versiones de AGP y Gradle de la plantilla puede disparar varias de las causas anteriores a la vez, igual que hace una [actualización de Flutter 2 a Flutter 3](/es/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/).

La lección general va más allá de este único mensaje. Cada vez que un fallo de compilación de Flutter nombre una tarea de Gradle y un código de salida, la herramienta es solo el mensajero. Ve a `android/`, ejecuta la tarea tú mismo con `--stacktrace`, y lee el bloque bajo `* What went wrong:`. La solución siempre está en ese bloque, y nunca está en la línea que imprimió Flutter.

## Relacionado

- [Solución: conflicto de AndroidX durante una compilación de Android con Flutter](/es/2026/05/fix-androidx-conflict-during-flutter-android-build/) -- la variante de clases duplicadas de un fallo de configuración, y por qué AGP 8 al desactivar Jetifier la trajo de vuelta.
- [Flutter: tu proyecto requiere una versión más reciente del Kotlin Gradle plugin](/es/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/) -- el mínimo de versión de KGP, que es un fallo distinto de la colisión de extensiones de AGP 9 de arriba.
- [Solución: background_fetch requiere minSdkVersion 21](/es/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) -- un ejemplo trabajado del conflicto de SDK en la fusión del manifiesto de la Causa 4.
- [Solución: Version solving failed en pubspec.yaml](/es/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- qué hacer cuando el `flutter pub get` de la secuencia de limpieza es lo que falla.
- [Migrar una app de Flutter 2 a Flutter 3.x: lista de verificación de null safety](/es/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) -- la ruta de actualización más amplia que suele disparar varias de estas causas de Gradle a la vez.

## Fuentes

- [Android Java Gradle migration guide](https://docs.flutter.dev/release/breaking-changes/android-java-gradle-migration-guide), documentación de Flutter
- [Migrating Flutter Android projects to built-in Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin), documentación de Flutter
- [Built-in Kotlin migration for app developers](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), documentación de Flutter
- [Flutter maintained plugins should support AGP 9.0](https://github.com/flutter/flutter/issues/181383), flutter/flutter
- [Gradle Java compatibility matrix](https://docs.gradle.org/current/userguide/compatibility.html#java), documentación de Gradle
- [Android Gradle Plugin release notes](https://developer.android.com/build/releases/gradle-plugin), Android Developers
