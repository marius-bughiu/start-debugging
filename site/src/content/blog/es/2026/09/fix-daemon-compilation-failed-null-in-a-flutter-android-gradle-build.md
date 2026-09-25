---
title: "Solución: e: Daemon compilation failed: null en un build de Gradle de Flutter para Android"
description: "En Windows, la compilación incremental de Kotlin falla cuando el proyecto Flutter y la caché de pub están en unidades distintas. Mueve PUB_CACHE a la unidad del proyecto o desactiva la IC para los plugins de la caché de pub."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
lang: "es"
translationOf: "2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build"
translatedBy: "claude"
translationDate: 2026-09-25
---

Esto ocurre en Windows cuando tu proyecto Flutter está en una unidad (`D:\`) y la caché de pub está en otra (`C:\Users\<you>\AppData\Local\Pub\Cache`). El compilador incremental de Kotlin guarda cada archivo fuente de un plugin como una ruta relativa a tu carpeta `android\`. No existe una ruta relativa de `D:\` a `C:\`, así que `compileDebugKotlin` falla para plugins como `shared_preferences_android`. La mejor solución es poner `PUB_CACHE` en la misma unidad que tus proyectos y luego ejecutar `flutter clean` y `flutter pub get`. Si no puedes hacerlo, establece `kotlin.incremental=false` solo para los subproyectos de plugins (fragmento más abajo). Con Kotlin Gradle Plugin 2.3.0 y anteriores el APK se genera igual y el error es solo ruido. A partir de KGP 2.3.20 (la plantilla de Flutter 3.44) y KGP 2.4.0 (Flutter 3.47) el build puede fallar directamente.

Las versiones de abajo se comprobaron con Flutter 3.47.5 (Dart 3.13.4, AGP 9.1.0, Gradle 9.3.1, KGP 2.4.0), `shared_preferences` 2.5.5 / `shared_preferences_android` 2.4.28, y el código fuente de Kotlin Gradle Plugin en los tags `v1.9.22` a `v2.4.20`.

## El error en contexto

Los reportes en [flutter/flutter#173456](https://github.com/flutter/flutter/issues/173456) y [flutter/flutter#144566](https://github.com/flutter/flutter/issues/144566) se ven todos así, una vez por plugin:

```text
e: Daemon compilation failed: null
java.lang.Exception
	at org.jetbrains.kotlin.daemon.common.CompileService$CallResult$Error.get(CompileService.kt:69)
	at org.jetbrains.kotlin.daemon.common.CompileService$CallResult$Error.get(CompileService.kt:65)
	at org.jetbrains.kotlin.compilerRunner.GradleKotlinCompilerWork.compileWithDaemon(GradleKotlinCompilerWork.kt:244)
	...
Caused by: java.lang.AssertionError: java.lang.Exception: Could not close incremental caches in
  D:\src\my_app\build\shared_preferences_android\kotlin\compileReleaseKotlin\cacheable\caches-jvm\jvm\kotlin:
  class-fq-name-to-source.tab, source-to-classes.tab, internal-name-to-source.tab
	at org.jetbrains.kotlin.incremental.IncrementalCachesManager.close(IncrementalCachesManager.kt:55)
	...
	Suppressed: java.lang.IllegalArgumentException: this and base files have different roots:
	  C:\Users\me\AppData\Local\Pub\Cache\hosted\pub.dev\shared_preferences_android-2.4.28\android\src\main\kotlin\io\flutter\plugins\sharedpreferences\LegacySharedPreferencesPlugin.kt
	  and D:\src\my_app\android.
```

La primera línea dice `null` porque el daemon envuelve el fallo real en un `java.lang.Exception` sin mensaje. La línea útil es la última: `this and base files have different roots`. Si tu registro la tiene, este artículo es tu solución. Si no, salta a "Errores parecidos" al final.

## Por qué el compilador incremental de Kotlin necesita una sola unidad

La compilación incremental (IC) de Kotlin mantiene tablas de búsqueda en `build/<module>/kotlin/compile<Variant>Kotlin/cacheable/caches-jvm`. Las tablas asocian cada archivo fuente con las clases que produce. Para que la caché de build de Gradle sea reubicable, Kotlin 1.9.20 empezó a guardar esas rutas relativas a un directorio base en lugar de rutas absolutas. Este es el conversor de `build-common` en el repositorio de Kotlin:

```kotlin
// Kotlin build-common, RelocatableFileToPathConverter.kt (unchanged through 2.4.20)
override fun toPath(file: File): String {
    // ...
    // Note: If the given file is located outside `baseDir`, the relative path will start with "../".
    // It's not "clean", but it can work.
    return file.relativeTo(baseDir).invariantSeparatorsPath
}
```

Para los archivos fuente, `baseDir` es el **directorio del proyecto raíz**, que en una app Flutter es `<project>\android`. Los plugins de Flutter son subproyectos de Gradle, pero su código fuente vive en la caché de pub, fuera de esa carpeta. En macOS y Linux eso funciona, porque todas las rutas comparten la raíz `/`. En mi Mac, la caché de IC de `shared_preferences_android` contiene de hecho esta entrada:

```text
../../../../../../../../Users/marius/.pub-cache/hosted/pub.dev/shared_preferences_android-2.4.28/android/src/main/kotlin/io/flutter/plugins/sharedpreferences/LegacySharedPreferencesPlugin.kt
```

En Windows, `D:\src\my_app\android` y `C:\Users\...\Pub\Cache` tienen raíces distintas. Ninguna cadena de `..\` te lleva de una unidad a la otra, así que `File.relativeTo` lanza `IllegalArgumentException`. La excepción se dispara mientras la IC escribe sus cachés, por eso aparece como "Could not close incremental caches" y el daemon la reporta como "Daemon compilation failed".

Por eso también funcionan los workarounds clásicos: "mueve el proyecto a `C:`", "baja Kotlin a 1.9.10" (la última versión antes de las rutas relativas) y "solo falla con algunos plugins" (solo los plugins con código fuente Kotlin pasan por el compilador de Kotlin). JetBrains sigue la causa raíz como [KT-63983](https://youtrack.jetbrains.com/issue/KT-63983), que sigue en "To be discussed". Un ingeniero de JetBrains señaló que la solución trivial (`relativeToOrSelf`) provocaría aciertos incorrectos en la caché de build. Del lado de Flutter está [flutter/flutter#105395](https://github.com/flutter/flutter/issues/105395), abierto desde 2022.

El mismo fallo afecta a cualquier configuración donde el código fuente y el proyecto raíz estén en raíces distintas: unidades virtuales `subst` ([KT-65155](https://youtrack.jetbrains.com/issue/KT-65155)), un directorio de build en un disco RAM, o una ruta de WSL como `\mnt\d\project` mezclada con `D:\project`.

## Por qué a veces el APK se genera igual

Mucha gente reporta que el registro se llena de líneas `e:` y luego imprime `√ Built build\app\outputs\flutter-apk\app-release.apk`. Otros, sobre todo desde Flutter 3.44, reciben un `BUILD FAILED` de verdad. La diferencia está en qué ruta de compilación toma Kotlin Gradle Plugin después de que falla el daemon. Lo leí en el código fuente de KGP en cada tag:

| Versión de KGP | Ruta de compilación por defecto | Fallback después de que falla el daemon | Resultado en un proyecto entre unidades |
| --- | --- | --- | --- |
| 1.9.20 a 2.3.0 | `GradleKotlinCompilerWork` | `compileInProcess`, que es explícitamente **no incremental** ("in-process execution strategy is non-incremental") | Salida `e:` ruidosa, el APK se genera |
| 2.3.20 y posteriores | Build Tools API (`kotlin.compiler.runViaBuildToolsApi` es `true` por defecto) | `performCompilation(IN_PROCESS)` con la **misma** configuración incremental, incluido `ROOT_PROJECT_DIR` | El fallback llega al mismo `relativeTo`, el build puede fallar |

La plantilla de Flutter fija la versión de KGP en `android/settings.gradle.kts`, así que tu versión de Flutter en el momento de `flutter create` decide en qué fila estás:

| Plantilla de Flutter | `templateKotlinGradlePluginVersion` |
| --- | --- |
| 3.35.0 | 2.1.0 |
| 3.38.0, 3.41.0 | 2.2.20 |
| 3.44.0 | 2.3.20 |
| 3.47.0 a 3.47.5 | 2.4.0 |

Esto coincide con los hilos de los issues. Los reportes de 2025 en Flutter 3.32 y 3.35 dicen "el APK se genera igual". Los comentarios de junio de 2026 dicen "me apareció este problema después de actualizar a Flutter 3.44". El reporte de agosto de 2026 en 3.47.0 con AGP 9.1.0 y KGP 2.4.0 tiene `:shared_preferences_android:compileDebugKotlin` haciendo fallar el build en una ejecución limpia. Esas personas no están viendo un bug nuevo. El fallback de Kotlin que antes ocultaba el viejo ya no lo hace.

## Reproducción mínima

Necesitas Windows con dos unidades (o una unidad `subst`). Deja la caché de pub por defecto en `C:`:

```powershell
# Windows 11, Flutter 3.47.5, default PUB_CACHE on C:
D:
cd \src
flutter create --platforms=android daemon_repro
cd daemon_repro
flutter pub add shared_preferences
flutter build apk --debug
```

Un proyecto 3.47.5 recién creado recibe `com.android.application` 9.1.0, `org.jetbrains.kotlin.android` 2.4.0 y Gradle 9.3.1, con la IC de Kotlin activada por defecto. Sin el plugin, la app de la plantilla no tiene nada fuera de `android\` que Kotlin deba compilar, así que compila sin problemas. Eso explica la observación habitual de "se rompió en cuanto agregué un paquete".

## Solución 1: pon la caché de pub en la misma unidad que tus proyectos

Esta es la solución recomendada. Elimina la causa y mantiene la compilación incremental en todas partes. Elige una carpeta en la unidad donde viven tus proyectos, apunta `PUB_CACHE` a ella y vuelve a resolver:

```powershell
# Windows, any Flutter 3.x: user-level env var, picked up by new shells and IDEs
[Environment]::SetEnvironmentVariable("PUB_CACHE", "D:\PubCache", "User")

# open a NEW terminal (and restart VS Code / Android Studio), then:
cd D:\src\my_app
flutter clean
flutter pub get
flutter build apk --debug
```

`flutter pub get` descarga los paquetes en la nueva caché y regenera `.dart_tool\package_config.json` y `.flutter-plugins-dependencies`. El plugin de Gradle de Flutter lee las rutas de los plugins desde esos archivos, así que cada subproyecto de plugin ahora se resuelve a `D:\PubCache\...`. `flutter clean` importa porque las cachés de IC viejas en `build\` todavía contienen rutas de la estructura anterior. Después puedes borrar la vieja `C:\Users\<you>\AppData\Local\Pub\Cache`.

El límite de esta solución: si tienes proyectos en varias unidades, solo una de ellas puede coincidir con la caché. Para ese caso, usa la solución 2.

## Solución 2: desactiva la compilación incremental solo para los subproyectos de plugins

Los plugins de la caché de pub nunca cambian entre builds, así que la IC no te ahorra nada con ellos. Tu propio módulo `app` es donde la IC compensa, y su código fuente está dentro de `android\`, así que no se ve afectado. KGP lee `kotlin.incremental` por proyecto, incluidas las propiedades extra del proyecto, así que puedes acotar el cambio. Agrega esto al final de `android/build.gradle.kts`:

```kotlin
// android/build.gradle.kts, Flutter 3.47.5, AGP 9.1.0, KGP 2.4.0
// Kotlin incremental compilation stores source paths relative to this
// directory. Plugins from the pub cache live outside it, which breaks on
// Windows when the cache is on another drive (KT-63983). Turn IC off for
// those subprojects only; the :app module stays incremental.
subprojects {
    if (!projectDir.canonicalPath.startsWith(rootDir.canonicalPath)) {
        extra["kotlin.incremental"] = "false"
    }
}
```

Para un `android/build.gradle` en Groovy, el equivalente es:

```groovy
// android/build.gradle, Flutter 3.35 to 3.47
subprojects {
    if (!projectDir.canonicalPath.startsWith(rootDir.canonicalPath)) {
        ext.set("kotlin.incremental", "false")
    }
}
```

Lo comprobé en macOS con el proyecto de reproducción 3.47.5, revisando qué módulos escriben cachés de IC después de `flutter clean && flutter build apk --debug`. Sin el fragmento, existen tanto `build/app/kotlin/compileDebugKotlin/cacheable/caches-jvm` como `build/shared_preferences_android/.../caches-jvm`. Con él, solo existe la de `app`, y el APK se genera. La versión en Groovy dio el mismo resultado. No tengo aquí una máquina Windows con una segunda unidad, así que no vi desaparecer el fallo en Windows con mis propios ojos, pero el mecanismo es el mismo: con la IC desactivada, KGP no construye ninguna configuración incremental y nada llama a `RelocatableFileToPathConverter`.

Dos enfoques que parecen correctos **no** funcionan, y probé ambos en 3.47.5:

- `tasks.withType<KotlinCompile>().configureEach { incremental = false }` dentro de `subprojects {}`. La acción de configuración propia de KGP ejecuta `task.incremental = propertiesProvider.incrementalJvm ?: true` más tarde y sobrescribe tu valor. Una sonda en `doFirst` imprimió `incremental=true`.
- Envolver lo mismo en `afterEvaluate {}`. Mismo resultado: las cachés se seguían escribiendo.

Establecer la propiedad que lee el propio KGP es el único interruptor por módulo que sobrevive.

Una dependencia por ruta dentro de tu repositorio (`path: ../packages/my_plugin`) también está fuera de `android\`, así que el fragmento desactiva la IC también para ella. Eso cuesta una recompilación completa del código Kotlin de ese plugin en cada build, normalmente uno o dos segundos. Si eso importa, restringe la comprobación a rutas de la caché de pub, por ejemplo `projectDir.canonicalPath.contains("Pub${File.separator}Cache")`.

## Solución 3: desactiva la compilación incremental de Kotlin de forma global

La solución más tosca, y la más citada en los hilos de los issues. En `android/gradle.properties`:

```properties
# android/gradle.properties, any Flutter / KGP version
kotlin.incremental=false
```

Funciona, y confirmé que después no se crea ninguna carpeta `caches-jvm` para ningún módulo. El costo es que el código Kotlin de tu módulo `app` también se recompila desde cero en cada build. Para el único `MainActivity.kt` de la plantilla de Flutter eso no importa. Para una app con mucho Kotlin nativo (platform channels, un widget, un módulo de Wear OS) se nota durante `flutter run`. En ese caso prefiere la solución 1 o la 2.

## Qué no hacer

- **No bajes KGP a 1.9.10.** Es la última versión antes de las rutas relativas, así que el fallo desaparece. Pero Flutter 3.47 rechaza KGP por debajo de 2.2.20 y AGP 9 requiere un KGP moderno, así que estarías fijando toda tu cadena de herramientas de Android en 2023.
- **No establezcas `kotlin.compiler.runViaBuildToolsApi=false` para recuperar el viejo comportamiento de "el APK se genera igual".** En KGP 2.4 esa propiedad está anotada como obsoleta (KT-85433, "non-BTA JVM compiler invocation is deprecated"), y sigue registrando el fallo en cada build. Oculta el problema hasta que el próximo KGP la elimine.
- **No establezcas `kotlin.daemon.useFallbackStrategy=false`.** Eso convierte el caso de "el APK se genera igual" en un fallo definitivo también en versiones viejas de KGP.
- **No muevas el SDK de Flutter.** La ubicación del SDK es irrelevante aquí. El plugin de Gradle de Flutter es un included build con su propia raíz, y su código fuente está junto a él. Lo único que importa es la separación entre la unidad de la caché de pub y la del proyecto.

## Errores parecidos

No toda línea `Daemon compilation failed` es este bug. Revisa las líneas `Caused by` y `Suppressed`:

- **`Daemon compilation failed: Could not connect to Kotlin compile daemon`**. El daemon no arrancó o murió, a menudo por interferencia del antivirus o por falta de memoria. Ejecuta `cd android; .\gradlew --stop` y vuelve a compilar. En versiones viejas de KGP el fallback compila sin el daemon, así que este suele ser inofensivo.
- **Un `OutOfMemoryError` en el daemon o en Gradle**. Aumenta `kotlin.daemon.jvmargs` y `org.gradle.jvmargs` en `gradle.properties`, consulta [flutter/flutter#133371](https://github.com/flutter/flutter/issues/133371).
- **`Module was compiled with an incompatible version of Kotlin`**. Un plugin se compiló con una versión de metadatos de Kotlin más nueva que tu KGP. Es un desajuste de versiones, no un problema de IC, y se trata en [la guía de migración a AGP 9](/es/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/).
- **Un `Gradle task assembleDebug failed with exit code 1` genérico** sin líneas del daemon de Kotlin. Empieza por [la lista de verificación general de assembleDebug](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

Los registros crudos del daemon están en `android\.kotlin\errors\errors-<timestamp>.log` y `%TEMP%\kotlin-daemon.*.log`. Busca `different roots` en ellos si la salida de la consola está truncada.

## Relacionados

- [Migrar un proyecto Flutter Android a AGP 9 con Kotlin integrado](/es/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) explica la plantilla con AGP 9.1 / KGP 2.4 que convirtió esta advertencia en un fallo.
- [Solución: Gradle task assembleDebug failed with exit code 1 en Flutter](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) es el artículo general sobre fallos de build en Android.
- [Solución: A restricted method in java.lang.System has been called en un build de Gradle de Flutter](/es/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/), otro mensaje ruidoso de Gradle donde tienes que decidir si es fatal.
- [Solución: flutter doctor --android-licenses falla con cmdline-tools 23](/es/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/) para el otro problema común de la cadena de herramientas de Android en Windows este mes.
- [Depurar Flutter iOS desde Windows](/es/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) si Windows es tu máquina principal para Flutter.

## Fuentes

- [flutter/flutter#173456](https://github.com/flutter/flutter/issues/173456) (abierto), incluida la reproducción del 2026-08-16 en Flutter 3.47.0, AGP 9.1.0, KGP 2.4.0, y [flutter/flutter#105395](https://github.com/flutter/flutter/issues/105395), el issue de seguimiento del problema entre unidades.
- [flutter/flutter#144566](https://github.com/flutter/flutter/issues/144566) y [flutter/flutter#170534](https://github.com/flutter/flutter/issues/170534), reportes anteriores con la pila completa.
- [KT-63983](https://youtrack.jetbrains.com/issue/KT-63983), [KT-65155](https://youtrack.jetbrains.com/issue/KT-65155) y [KT-80077](https://youtrack.jetbrains.com/issue/KT-80077) en el tracker de Kotlin.
- Código fuente de Kotlin: [`RelocatableFileToPathConverter.kt`](https://github.com/JetBrains/kotlin/blob/master/build-common/src/org/jetbrains/kotlin/incremental/storage/RelocatableFileToPathConverter.kt), `GradleKotlinCompilerWork.kt` y `btapi/BuildToolsApiCompilationWork.kt` en `libraries/tools/kotlin-gradle-plugin`, y `PropertiesProvider.kt` / `KotlinCompileConfig.kt` en los tags `v2.3.0`, `v2.3.20` y `v2.4.0`.
- Código fuente de Flutter: `packages/flutter_tools/lib/src/android/gradle_utils.dart` (`templateKotlinGradlePluginVersion`) en los tags 3.35.0 a 3.47.5.
- [Kotlin Gradle plugin compilation and caches](https://kotlinlang.org/docs/gradle-compilation-and-caches.html) en kotlinlang.org, para `kotlin.incremental`.
- [Environment variables for pub](https://dart.dev/tools/pub/environment-variables) en dart.dev, para `PUB_CACHE`.
