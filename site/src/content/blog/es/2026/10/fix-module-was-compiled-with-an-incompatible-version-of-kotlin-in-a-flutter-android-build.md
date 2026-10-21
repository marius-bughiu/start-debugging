---
title: "Solución: Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is X, expected version is Y (Flutter Android)"
description: "Una dependencia fue compilada con una versión de Kotlin al menos dos versiones menores más nueva que el compilador de tu compilación. Sube la versión de org.jetbrains.kotlin.android en settings.gradle.kts a X menos uno o posterior, o fija la dependencia a una versión anterior."
pubDate: 2026-10-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "kotlin"
  - "gradle"
lang: "es"
translationOf: "2026/10/fix-module-was-compiled-with-an-incompatible-version-of-kotlin-in-a-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-10-21
---

Respuesta corta: alguna biblioteca en el classpath de Android (muy a menudo un `kotlin-stdlib` más reciente incorporado de forma transitiva) fue compilada con una versión de Kotlin al menos dos versiones menores por delante del compilador que ejecuta tu compilación. El compilador solo lee metadatos de una versión menor adelante. Sube la versión de `org.jetbrains.kotlin.android` en `android/settings.gradle.kts` al menos a "X menos una versión menor" (para los metadatos 2.4.0, KGP 2.3.x o posterior) y vuelve a compilar. Todo lo que sigue se reprodujo con Flutter 3.44.8, AGP 9.0.1, Gradle 9.1.0 y artefactos de Kotlin 2.4.21.

## El error en contexto

Al ejecutar `flutter build apk` o `flutter run`, la tarea `compileDebugKotlin` (o `compileReleaseKotlin`) falla con una línea por cada archivo de módulo de Kotlin en el jar problemático:

```text
> Task :app:compileDebugKotlin FAILED
e: file:///Users/me/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.4.21/.../kotlin-stdlib-2.4.21.jar!/META-INF/kotlin-stdlib.kotlin_module Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is 2.4.0, expected version is 2.2.0.
e: file:///.../MainActivity.kt:6:19 Unresolved reference 'listOf'.

FAILURE: Build failed with an exception.
* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction
   > Compilation error. See log for more details
```

Cuando el código que falla vive en un plugin y no en tu app, la misma incompatibilidad se reporta por clase y el mensaje es más nuevo y más útil:

```text
> Task :shared_preferences_android:compileDebugKotlin FAILED
e: Incompatible classes were found in dependencies. Remove them from the classpath or use '-Xskip-metadata-version-check' to suppress errors
e: .../shared_preferences_android-2.5.1/android/src/main/kotlin/io/flutter/plugins/sharedpreferences/LegacySharedPreferencesPlugin.kt:47:5 Class 'kotlin.Unit' was compiled with an incompatible version of Kotlin. The actual metadata version is 2.4.0, but the compiler version 2.2.0 can read versions up to 2.3.0.
```

Los errores "Unresolved reference" que aparecen después (`listOf`, `startsWith`, `it`) son ruido. Una vez que el compilador se niega a cargar la biblioteca estándar, todos los símbolos de la stdlib quedan sin resolver. Corrige el primer error y todos desaparecen.

## Por qué el compilador rechaza metadatos más nuevos

Cada archivo de clase de Kotlin/JVM lleva una anotación `@kotlin.Metadata`, y cada jar tiene un archivo `META-INF/*.kotlin_module`, ambos marcados con la versión de metadatos del compilador que los produjo. Los [principios de evolución](https://kotlinlang.org/docs/kotlin-evolution-principles.html) de Kotlin prometen compatibilidad hacia atrás (un compilador más nuevo lee todos los binarios más antiguos), pero solo compatibilidad hacia adelante de mejor esfuerzo con la siguiente versión del lenguaje, "but not later ones". El compilador aplica esa regla desde el principio: un compilador 2.2 acepta metadatos hasta 2.3.0 y rechaza 2.4.0. Eso es exactamente lo que dice el mensaje más nuevo: "the compiler version 2.2.0 can read versions up to 2.3.0".

Entonces, los dos números del error significan:

- **"binary version of its metadata is X"**: la versión de Kotlin que compiló el jar de la biblioteca indicado en la ruta.
- **"expected version is Y"**: el compilador de Kotlin que ejecuta tu compilación de Gradle, que proviene del Kotlin Gradle Plugin (KGP) en el classpath de la compilación. No es el Kotlin instalado en Android Studio, y no es necesariamente la versión que escribiste.

En las apps de Flutter, el detonante casi siempre es uno de estos, en orden de frecuencia:

1. **La actualización de un plugin o de una biblioteca de AndroidX/Google** incorpora de forma transitiva un `kotlin-stdlib` más nuevo. La resolución de conflictos de Gradle elige la stdlib más alta solicitada, así que una sola dependencia moderna la actualiza para todo el módulo.
2. **El KGP de tu proyecto es antiguo**, normalmente porque la app se creó hace años y nunca se actualizó `settings.gradle.kts` (o `ext.kotlin_version` en un `android/build.gradle` anterior a 3.16).
3. **Un plugin compilado con un Kotlin más nuevo distribuye un AAR o jar precompilado** con clases de Kotlin dentro (común en plugins que envuelven SDK, como mapas, pagos y analítica).

## Reproducción mínima

Parte de un proyecto nuevo de Flutter 3.44.8, baja el KGP y agrega una dependencia compilada con Kotlin 2.4:

```kotlin
// android/settings.gradle.kts -- Flutter 3.44.8, AGP 9.0.1, Gradle 9.1.0
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false // template ships 2.3.20
}
```

```kotlin
// android/app/build.gradle.kts -- Flutter 3.44.8
dependencies {
    // Stands in for any library compiled with Kotlin 2.4.x
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.4.21")
}
```

```kotlin
// android/app/src/main/kotlin/com/example/kapp/MainActivity.kt -- Kotlin source that touches stdlib
package com.example.kapp

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    val doubled = listOf(1, 2, 3).map { it * 2 }
}
```

Hay dos detalles de la reproducción que conviene conocer antes de empezar a cambiar versiones.

**La versión que declaraste puede no ser la que se ejecuta.** Declaré KGP 2.0.21, pero el error dice "expected version is 2.2.0", y el Flutter Gradle Plugin advirtió "Flutter support for your project's Kotlin version (2.2.10) will soon be dropped". AGP 9.0.1 declara una dependencia de runtime sobre `kotlin-gradle-plugin:2.2.10`, y Gradle resuelve el classpath de la compilación a la versión más alta solicitada. Declarar un KGP *inferior* al que trae AGP no tiene ningún efecto. Lee la "expected version" del error, no de tu archivo de configuración.

**El error solo se dispara cuando el código Kotlin toca las clases más nuevas.** Con la clásica línea `class MainActivity : FlutterActivity()`, el mismo classpath compilaba bien, porque nada obligaba al compilador a deserializar los metadatos de la stdlib. Agregar `listOf(...)` lo rompió. Por eso el error suele aparecer "de la nada" después de agregar unas líneas de Kotlin en `MainActivity` o en un manejador de method channel, aunque la actualización de la dependencia haya ocurrido semanas antes.

## Solución 1: subir el Kotlin Gradle Plugin (recomendada)

La regla es: la versión menor de KGP debe ser al menos la versión menor de metadatos de la biblioteca menos uno. Para los metadatos 2.4.0 eso significa 2.3.x o posterior; igualarla exactamente (2.4.x) es la opción más segura.

```kotlin
// android/settings.gradle.kts -- Flutter 3.44.8, AGP 9.0.1
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.3.20" apply false
}
```

Con 2.3.20, la misma reproducción compiló sin problemas (`BUILD SUCCESSFUL`): una versión menor de anticipación es suficiente. Hazlo en este orden:

1. Lee X del error ("binary version of its metadata is 2.4.0").
2. Abre `android/settings.gradle.kts` (o `settings.gradle`) y establece la versión de `org.jetbrains.kotlin.android` en X menos una versión menor o posterior. En proyectos creados antes de Flutter 3.16, la versión vive en `android/build.gradle` como `ext.kotlin_version = '...'` dentro de `buildscript`; cámbiala ahí.
3. Verifica el nuevo KGP contra tu AGP y tu Gradle en la [tabla de compatibilidad del Kotlin Gradle plugin](https://kotlinlang.org/docs/gradle-configure-project.html#apply-the-plugin). KGP 2.3.20 soporta Gradle 7.6.3 a 9.3.0 y AGP 8.2.2 a 9.0.0; KGP 2.4.20 requiere AGP 8.5.2 o posterior. Los proyectos de Flutter más antiguos con AGP 7.x tienen que actualizar AGP y Gradle en el mismo cambio.
4. Ejecuta `flutter clean` y vuelve a compilar, para que no queden salidas de Gradle en caché del compilador anterior.

Las herramientas de Flutter 3.44.8 lo respaldan: la plantilla trae KGP 2.3.20, y el Flutter Gradle Plugin advierte por debajo de 2.2.20 y falla por debajo de 2.0.0 (`warnKGPVersion` y `errorKGPVersion` en `packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt`). Si todavía estás en un proyecto con Kotlin 1.x, vas a encontrar este error con casi todas las versiones actuales de AndroidX, así que esta es la actualización que de todos modos conviene hacer.

## Solución 2: cuando el error está en un módulo de plugin, corrígelo igual en la app

Si la tarea que falla es `:some_plugin:compileReleaseKotlin`, el instinto es culpar al `build.gradle` del plugin. La reproducción muestra por qué ese es el archivo equivocado. `shared_preferences_android` 2.5.1 declara su propio KGP en su buildscript:

```kotlin
// ~/.pub-cache/hosted/pub.dev/shared_preferences_android-2.5.1/android/build.gradle.kts (excerpt)
val kotlinVersion = "2.3.0"
classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion")
```

Aun así, el error decía "the compiler version 2.2.0". Los plugins son subproyectos de la compilación de Gradle de tu app, y el KGP que ya cargó la compilación raíz (desde `settings.gradle.kts`, posiblemente actualizado por AGP) es el que los compila. La declaración del plugin no se impone. Entonces:

1. Sube el KGP en el `android/settings.gradle.kts` de tu app, exactamente como en la Solución 1.
2. Si el propio plugin fija un Kotlin antiguo de una forma que sigue fallando, actualiza el plugin (`flutter pub upgrade <name>` o sube su restricción en `pubspec.yaml`). Nunca edites archivos dentro de `~/.pub-cache`: `pub get` los sobrescribe.

## Solución 3: encontrar y fijar la dependencia que trajo el Kotlin más nuevo

A veces no puedes subir el KGP en este momento (una rama de release, una imagen de CI congelada). Entonces averigua quién solicitó la nueva stdlib y fija esa dependencia a una versión anterior. Desde la carpeta `android/`:

```bash
./gradlew :app:dependencyInsight --dependency org.jetbrains.kotlin:kotlin-stdlib --configuration releaseRuntimeClasspath
```

En mi reproducción, la sección "Selection reasons" explicó toda la historia en una línea:

```text
- By conflict resolution: between versions 2.4.21, 2.2.10, 1.8.22, 2.0.21, 1.6.21, 1.7.10, 1.8.10, 1.3.20, 1.8.20, 1.9.24, 2.0.0, 1.9.25 and 2.0.20
```

Debajo, cada línea `org.jetbrains.kotlin:kotlin-stdlib:1.x -> 2.4.21` aparece con sangría bajo la dependencia que la solicitó. Sube por el árbol hasta la que pide 2.4.x y luego degrada esa biblioteca o el plugin de Flutter que la trae. Para una dependencia transitiva de un plugin, ejecuta el mismo comando contra el proyecto del plugin (`:plugin_name:dependencyInsight`). Fijar versiones es una medida a corto plazo: el autor de la biblioteca pasó al nuevo Kotlin por una razón, y la próxima actualización de cualquier otra cosa te traerá de vuelta aquí.

No lo "arregles" forzando `kotlin-stdlib` a una versión inferior con `resolutionStrategy.force(...)`. La biblioteca fue compilada contra la API más nueva de la stdlib y puede llamar a funciones que no existen en la anterior, lo que convierte un error de compilación en un `NoSuchMethodError` en tiempo de ejecución.

## Solución 4: -Xskip-metadata-version-check (último recurso)

El propio mensaje del compilador sugiere una bandera, y funciona:

```kotlin
// android/app/build.gradle.kts -- Kotlin compiler option, use only temporarily
kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
        freeCompilerArgs.add("-Xskip-metadata-version-check")
    }
}
```

Con ella, la reproducción compiló. Es una bandera `-X`, lo que significa que no está soportada, y solo desactiva la verificación de seguridad: el compilador entonces lee metadatos de un formato que no conoce. Si la biblioteca más nueva usa una característica del lenguaje codificada de una forma que tu compilador no sabe interpretar, obtienes firmas incorrectas o un fallo del compilador en lugar de un error claro. Además, solo se aplica al módulo donde la pones, así que un módulo de plugin que falle seguiría fallando. Úsala para desbloquear una compilación de emergencia y quítala cuando subas el KGP.

## Errores parecidos que terminan aquí

- **`Your project requires a newer version of the Kotlin Gradle plugin`**: es la verificación previa de Flutter, no el compilador de Kotlin. Tiene otro camino de solución, descrito en [el artículo sobre el error de versión antigua de KGP](/es/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/).
- **`Daemon compilation failed: null`**: un fallo de compilación incremental dentro del daemon de Kotlin, no una incompatibilidad de versiones. Consulta [cómo solucionar Daemon compilation failed: null](/es/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/).
- **Errores de Kotlin justo después de pasar a AGP 9**: si la compilación se rompió al actualizar AGP y ves `Cannot add extension with name 'kotlin'`, es la migración a Kotlin integrado. [La guía de migración a AGP 9](/es/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) la explica paso a paso, incluido por qué debes conservar la línea de KGP en `settings.gradle.kts`.
- **`Execution failed for task ':app:compileFlutterBuildDebug'` o un simple `exit code 1`**: la línea de resumen que imprime Flutter oculta el error real de Gradle. Sube en la salida o vuelve a ejecutar con `--verbose`; [la guía sobre el exit code 1 de assembleDebug](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) muestra dónde mirar.
- **"Expected version is 1.x" en un proyecto que crees que usa Kotlin 2**: estás leyendo el archivo equivocado. Busca un `ext.kotlin_version` sobrante en `android/build.gradle`, o un bloque `buildscript` en el proyecto raíz que todavía pone un `kotlin-gradle-plugin` antiguo en el classpath.

## Relacionado

- [Migrate a Flutter Android project to AGP 9 with built-in Kotlin](/es/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)
- [Fix: Daemon compilation failed: null in a Flutter Android Gradle build](/es/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)
- [Fix: Gradle task assembleDebug failed with exit code 1 in Flutter](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)
- [Fix: Timeout waiting to lock journal cache in a Flutter Android build](/es/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/)

## Fuentes

- [Kotlin evolution principles: binary compatibility](https://kotlinlang.org/docs/kotlin-evolution-principles.html)
- [Kotlin Gradle plugin: compatibility with Gradle and AGP](https://kotlinlang.org/docs/gradle-configure-project.html#apply-the-plugin)
- [Android Gradle Plugin 9.0 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes) (dependencia de runtime KGP 2.2.10)
- [Flutter: Kotlin and Gradle version requirements](https://docs.flutter.dev/release/breaking-changes/kotlin-version)
- [flutter/flutter#179253](https://github.com/flutter/flutter/issues/179253), la misma incompatibilidad reportada con metadatos 2.2.0 frente a una versión esperada 1.8.0
