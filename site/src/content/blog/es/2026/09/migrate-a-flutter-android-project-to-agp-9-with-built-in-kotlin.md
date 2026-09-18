---
title: "Migra un proyecto Android de Flutter a AGP 9 con Kotlin integrado"
description: "El camino completo desde una app Flutter con AGP 8 que aplica kotlin-android hasta AGP 9.1 con android.builtInKotlin=true en Flutter 3.47. Cada paso fue compilado y medido, incluidos los dos cambios que parecen opcionales y no lo son: kotlinOptions es un error de compilación con KGP 2.2+, y la línea de KGP en settings.gradle.kts tiene que quedarse."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
lang: "es"
translationOf: "2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin"
translatedBy: "claude"
translationDate: 2026-09-18
---

Para una app Flutter creada antes de Flutter 3.44, la migración son cuatro cambios: sube el Gradle wrapper a 9.3.1 y AGP a 9.1.0, sube la versión del Kotlin Gradle Plugin (KGP) en `settings.gradle.kts` a 2.4.0 pero conserva la línea, reemplaza `kotlinOptions` por un bloque `kotlin { compilerOptions { ... } }` de nivel superior, y elimina `id("kotlin-android")` de `app/build.gradle.kts`. Después activa `android.builtInKotlin=true` en `gradle.properties`, lo cual requiere Flutter 3.47 o posterior, y solo cuando todos los plugins de los que dependes también hayan dejado KGP. Calcula una hora para una app con dependencias al día, más si algún plugin todavía aplica `kotlin-android`. Vale la pena hacerlo ahora: Flutter ya se niega a compilar con Gradle por debajo de 8.14 o AGP por debajo de 8.11.1, y ha anunciado que eliminará por completo el soporte de KGP ([flutter#184837](https://github.com/flutter/flutter/issues/184837)).

Todo lo que sigue se ejecutó en Flutter 3.47.4 stable (revisión del framework `9584c6713b`, Dart 3.13), OpenJDK 17.0.20 y Android SDK build-tools 36.1, partiendo de un proyecto con la misma estructura que la plantilla `android-kotlin` de Flutter 3.35: AGP 8.9.1, KGP 2.1.0, Gradle 8.12, `id("kotlin-android")` en el módulo de la app y un bloque `kotlinOptions`. También comprobé el estado final en Flutter 3.44.8. Cada paso incluye la salida exacta que obtuve.

## Por qué esta migración ya no es opcional

- **Flutter 3.47 impone mínimos que un proyecto AGP 8 de 2025 no cumple.** `DependencyVersionChecker.kt` en 3.47.4 da error con Gradle por debajo de 8.14.0, AGP por debajo de 8.11.1 y KGP por debajo de 2.2.20, y advierte por debajo de Gradle 9.1.0, AGP 9.0.1 y KGP 2.3.20. Mi proyecto de la era 3.35 sin tocar falló en la primera compilación con `Your project's Gradle version (8.12.0) is lower than Flutter's minimum supported version of 8.14.0`.
- **AGP 9 cambia dos valores por defecto.** Según las [notas de versión de AGP 9.0](https://developer.android.com/build/releases/agp-9-0-0-release-notes), `android.builtInKotlin` y `android.newDsl` pasan a ser `true` por defecto. Kotlin integrado significa que AGP compila Kotlin por sí mismo, y aplicar `org.jetbrains.kotlin.android` es un error.
- **Las opciones de exclusión son temporales en ambos lados.** Las plantillas de Flutter se distribuyen hoy con `android.builtInKotlin=false` y `android.newDsl=false`, pero la [guía general de migración a Kotlin integrado](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin) dice que el soporte de KGP se eliminará en una versión futura de Flutter, y Google dice que la salida de emergencia `newDsl=false` desaparece en AGP 10.
- **Tus plugins se miden con la misma regla.** Una vez que activas Kotlin integrado, cualquier plugin que todavía aplique `kotlin-android` rompe tu compilación, no su propio CI. Encontrar esos plugins temprano es la mayor parte del trabajo real.

## Qué se rompe

| Área | Cambio | Gravedad |
| --- | --- | --- |
| Gradle wrapper | Flutter 3.47 da error por debajo de 8.14; AGP 9.1 necesita 9.3.1 | alta |
| `kotlin-android` en el módulo de la app | Falla con Kotlin integrado activado | alta |
| `kotlinOptions { jvmTarget = ... }` | Error de compilación del script con KGP 2.2 y posteriores | alta |
| Plugins que aplican KGP | Rompen tu compilación una vez que `android.builtInKotlin=true` | alta |
| `android.newDsl=true` | El Flutter Gradle Plugin todavía hace cast al DSL antiguo, `ClassCastException` | alta (déjalo en `false`) |
| Entrada de KGP en `settings.gradle.kts` | Quitarla baja Kotlin al 2.2.10 incluido en AGP, por debajo del mínimo de Flutter | media |
| Proyectos `build.gradle` (Groovy) | Mismos cambios, otra sintaxis; las estructuras `buildscript` anteriores a 3.16 necesitan primero la migración a plugins declarativos | media |

## Lista de verificación previa

- **Flutter 3.47.x en la máquina y en CI.** Flutter 3.44 agregó soporte para AGP 9 con Kotlin integrado *desactivado*; activarlo solo está soportado a partir de 3.47. Compruébalo con `flutter --version`.
- **JDK 17 o posterior para Gradle.** AGP 9 requiere JDK 17. `flutter doctor -v` muestra qué JDK le pasa Flutter a Gradle; si es un JRE o JDK 11, arregla eso primero (consulta [el error de toolchain JAVA_COMPILER](/es/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/) para ver cómo elige Flutter el JDK).
- **Android SDK build-tools 36.0.0 o posterior.** Es el mínimo de AGP 9.
- **Un árbol de trabajo limpio.** La herramienta de Flutter reescribe `gradle.properties` por su cuenta la primera vez que compila con 3.44+, así que haz commit antes de empezar y revisa el diff después.
- **Una lista de tus plugins de Android.** `flutter pub deps --style=compact` es suficiente. Revisarás el changelog de cada uno en busca de soporte para Kotlin integrado en el paso 6.

## Pasos de la migración

1. **Deja que la herramienta de Flutter agregue las dos opciones de exclusión y luego revísalas.** Ejecuta cualquier compilación de Android una vez con Flutter 3.44 o posterior. Los migradores de la herramienta agregan ambas opciones a `android/gradle.properties` si faltan. En mi proyecto la compilación siguió fallando (por Gradle 8.12), pero el archivo ya estaba reescrito:

   ```properties
   # android/gradle.properties, written by the Flutter 3.47.4 migrators
   org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError
   android.useAndroidX=true
   # This builtInKotlin flag was added automatically by Flutter migrator
   android.builtInKotlin=false
   # This newDsl flag was added automatically by Flutter migrator
   android.newDsl=false
   ```

   El migrador nunca se ejecuta en proyectos host de add-to-app, porque el host es un proyecto Android normal. Ahí agregas ambas líneas a mano en el `gradle.properties` del host. Verifica: `grep -E 'builtInKotlin|newDsl' android/gradle.properties` imprime ambas líneas.

2. **Sube el Gradle wrapper a 9.3.1.** AGP 9.0.x necesita Gradle 9.1.0 o posterior, y las herramientas de Flutter emparejan AGP 9.1.x con 9.3.1 o posterior, que es también lo que trae la plantilla de Flutter 3.47:

   ```properties
   # android/gradle/wrapper/gradle-wrapper.properties, Flutter 3.47.4
   distributionUrl=https\://services.gradle.org/distributions/gradle-9.3.1-all.zip
   ```

   Verifica: `cd android && ./gradlew --version` reporta `Gradle 9.3.1`.

3. **Sube AGP y KGP en `settings.gradle.kts`, y conserva la línea de Kotlin.** Estas son las versiones que escribe `flutter create` en 3.47.4:

   ```kotlin
   // android/settings.gradle.kts, Flutter 3.47.4, AGP 9.1.0, KGP 2.4.0
   plugins {
       id("dev.flutter.flutter-plugin-loader") version "1.0.0"
       id("com.android.application") version "9.1.0" apply false
       id("org.jetbrains.kotlin.android") version "2.4.0" apply false
   }
   ```

   Es tentador borrar la línea `org.jetbrains.kotlin.android`, ya que el objetivo de la migración es dejar de usar KGP. No lo hagas. Con `apply false` solo pone esa versión de Kotlin en el classpath de la compilación, y Kotlin integrado compila con ella. Cuando la quité, AGP 9.1.0 volvió a su Kotlin 2.2.10 incluido, y el Flutter Gradle Plugin rechazó la compilación: `Your project's Kotlin version (2.2.10) is lower than Flutter's minimum supported version of 2.2.20`. La línea también importa mientras `builtInKotlin=false`, porque en ese caso el Flutter Gradle Plugin aplica `kotlin-android` por su cuenta a cada subproyecto Android que no lo haga, y necesita KGP en el classpath para hacerlo.

   Verifica: nada todavía. La compilación sigue fallando hasta el paso 4.

4. **Reemplaza `kotlinOptions` por el DSL `compilerOptions`.** Este es el cambio que sorprende a la gente, porque es obligatorio incluso antes de tocar Kotlin integrado. Con AGP 9.1.0, KGP 2.4.0, `kotlin-android` todavía aplicado y `builtInKotlin=false`, mi compilación falló durante la compilación del script:

   ```text
   Script compilation errors:
     Line 18:     kotlinOptions {
                  ^ 'fun BaseAppModuleExtension.kotlinOptions(configure: Action<DeprecatedKotlinJvmOptions>): Unit' is deprecated. Please migrate to the compilerOptions DSL.
     Line 19:         jvmTarget = JavaVersion.VERSION_11.toString()
                      ^ 'var jvmTarget: String' is deprecated. Please migrate to the compilerOptions DSL.
   ```

   [Kotlin 2.2.0 elevó la deprecación de `kotlinOptions` a error](https://kotlinlang.org/docs/whatsnew22.html), y Flutter 3.47 no te deja quedarte por debajo de KGP 2.2.20, así que no existe ninguna combinación de versiones en la que `kotlinOptions` sobreviva. Saca el JVM target del bloque `android {}` a un bloque `kotlin {}` de nivel superior:

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.47.4, AGP 9.1.0, KGP 2.4.0
   android {
       // ...
       compileOptions {
           sourceCompatibility = JavaVersion.VERSION_17
           targetCompatibility = JavaVersion.VERSION_17
       }
       // kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }  <- delete
   }

   kotlin {
       compilerOptions {
           jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
       }
   }
   ```

   Mantén `jvmTarget` igual a `targetCompatibility`. Las plantillas antiguas usaban 11, las nuevas usan 17; cualquiera funciona siempre que ambos coincidan. Verifica: `flutter build apk --debug` tiene éxito. En este punto también imprime `WARNING: Your Android app project: app ... applies the Kotlin Gradle Plugin, which will cause build failures in future versions of Flutter.` Esa advertencia es esperada, y es lo que elimina el paso 5.

5. **Quita `kotlin-android` del módulo de la app.** Borra la línea del plugin y nada más:

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.47.4
   plugins {
       id("com.android.application")
       // id("kotlin-android")  <- delete
       // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
       id("dev.flutter.flutter-gradle-plugin")
   }
   ```

   Si tu módulo de la app usa la forma de version catalog, la línea que debes borrar es `alias(libs.plugins.kotlin.android)`. Para un `build.gradle` en Groovy, es `apply plugin: 'kotlin-android'` o `id "kotlin-android"`, y el bloque `kotlin { compilerOptions { ... } }` del paso 4 es Groovy válido tal como está. Verifica: `flutter build apk --debug` tiene éxito sin advertencia de KGP para `app`. Con `builtInKotlin` todavía en `false`, el Flutter Gradle Plugin ahora aplica KGP en tu nombre, y por eso este estado intermedio compila.

6. **Encuentra los plugins que todavía aplican KGP.** Compila una vez más con `builtInKotlin=false` y lee la salida de Gradle. Flutter 3.47 te los nombra:

   ```text
   WARNING: Your app uses the following plugins that apply Kotlin Gradle Plugin (KGP): oldplug
   Future versions of Flutter will fail to build if your app uses plugins that apply KGP.
   Please check the changelogs of these plugins and upgrade to a version that supports Built-in Kotlin.
   ```

   Para cada plugin de la lista, busca en pub.dev una versión más reciente cuyo changelog mencione Kotlin integrado o AGP 9, y actualiza. Si no existe, abre un issue en el plugin (la guía de Flutter para desarrolladores de apps incluye [una plantilla de issue](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers#report-incompatible-kotlin-gradle-plugin-usage-to-plugin-authors)) y detente aquí: estás en AGP 9 con Kotlin integrado desactivado, que es un estado soportado. Verifica: la advertencia ya no lista ningún plugin.

7. **Activa Kotlin integrado.** Solo cuando el paso 6 salga limpio:

   ```properties
   # android/gradle.properties, Flutter 3.47.4, AGP 9.1.0
   android.builtInKotlin=true
   android.newDsl=false
   ```

   Deja `android.newDsl=false`. Verifica: `flutter build apk --debug` tiene éxito sin advertencias de KGP, y luego `flutter run` en un dispositivo o emulador inicia la app.

## Lista de verificación final

- `flutter build apk --debug` y `flutter build appbundle --release` tienen éxito sin la advertencia `applies the Kotlin Gradle Plugin` en la salida.
- Tu código Kotlin realmente llegó al APK. Lo comprobé porque Kotlin integrado es una ruta de compilación distinta: descomprime el APK con `unzip` y busca tu `MainActivity` en los archivos `classes*.dex`. En mi proyecto migrado, `Lnet/sd/app347/MainActivity;` estaba en `classes4.dex`.
- `flutter test` y cualquier suite de `integration_test` siguen pasando en un dispositivo Android.
- CI usa la misma versión de Flutter y JDK 17. Una imagen de CI atascada en Flutter 3.44 compila con Kotlin integrado activado pero imprime un mensaje engañoso (consulta los problemas encontrados).
- `git diff android/` muestra solo los archivos anteriores. Si un migrador reescribió algo más en silencio, vale la pena leerlo antes de hacer commit.

## Plan de reversión

La migración es reversible en cada paso, y la reversión más barata es parcial. Si un plugin se rompe después del paso 7, vuelve a poner `android.builtInKotlin=false`: con esa opción AGP 9 acepta KGP, y el Flutter Gradle Plugin vuelve a aplicar `kotlin-android` a los módulos que lo necesitan, así que no hace falta restaurar la línea `kotlin-android` en tu módulo de la app. Una reversión completa a AGP 8 significa restaurar `settings.gradle.kts` y el wrapper desde git, pero en Flutter 3.47 no puedes bajar de AGP 8.11.1, Gradle 8.14 ni KGP 2.2.20, así que "reversión" en realidad significa AGP 8.11+, no tu 8.9 original. El cambio a `kotlin { compilerOptions }` del paso 4 se queda en cualquier caso.

## Problemas que encontré en el camino

**El primer error no tiene nada que ver con Kotlin.** En el proyecto sin migrar, Flutter 3.47.4 imprimió el problema real (Gradle 8.12 por debajo de 8.14) dentro de la salida de Gradle, y debajo un recuadro "Flutter Fix" que decía `Starting AGP 9+, only the new DSL interface will be read` y sugería excluirse de `android.newDsl`. El proyecto estaba en AGP 8.9.1. El recuadro es una heurística que se dispara ante cualquier fallo al aplicar el Flutter Gradle Plugin, así que lee primero la sección `* What went wrong:`, el mismo consejo que en [la guía de assembleDebug con exit code 1](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

**El mensaje de error por un `kotlin-android` olvidado depende de tu versión de KGP.** Con KGP 2.4.0 es explícito:

```text
> Failed to apply plugin 'kotlin-android'.
   > ⛔ Failed to apply plugin 'org.jetbrains.kotlin.android'
     The 'org.jetbrains.kotlin.android' plugin is no longer required for Kotlin support since AGP 9.0.
     Solution: Remove the 'org.jetbrains.kotlin.android' plugin from this project's build file: app/build.gradle.kts.
```

Con versiones anteriores de KGP el mismo error aparece como `Cannot add extension with name 'kotlin'`, que es la forma que citan la mayoría de las respuestas de Stack Overflow. La línea `Solution:` es útil cuando el culpable es un plugin: para mi plugin de prueba apuntaba a `../../oldplug/android/build.gradle.kts`. Para un paquete de pub.dev la ruta apunta dentro de `~/.pub-cache/hosted/pub.dev/<package>-<version>/android/`, lo que te dice exactamente qué paquete actualizar. No edites archivos en la caché de pub; se sobrescriben en el siguiente `pub get`.

**`android.newDsl=true` sigue siendo un fallo seguro.** Con todo lo demás migrado, activarlo produjo `class com.android.build.gradle.internal.dsl.ApplicationExtensionImpl$AgpDecorated_Decorated cannot be cast to class com.android.build.gradle.AbstractAppExtension`. El Flutter Gradle Plugin todavía lee los tipos del DSL antiguo ([flutter#180137](https://github.com/flutter/flutter/issues/180137) da seguimiento a la adaptación). Deja la opción en `false` hasta que una versión de Flutter diga lo contrario, y cuenta con que esa versión llegue antes que AGP 10.

**Flutter 3.44 funciona a medias con Kotlin integrado activado.** La documentación dice que `android.builtInKotlin=true` necesita 3.47. Aun así ejecuté el proyecto completamente migrado en Flutter 3.44.8: el APK compiló y `MainActivity` estaba en el dex, pero la herramienta imprimió `Applying the Kotlin Android Plugin (KGP) was unsuccessful. KGP was not found on the classpath.` Eso viene del Flutter Gradle Plugin de 3.44, que no lee la opción e intenta aplicar KGP de todos modos. Es inofensivo en una app trivial y confuso en un log de CI, así que toma 3.47 como el mínimo real, exactamente como está documentado.

**Los proyectos anteriores a 3.16 necesitan primero una migración previa.** Si tu `android/build.gradle` todavía tiene `buildscript { ext.kotlin_version = '...' }` y tu módulo de la app usa `apply from: ".../flutter.gradle"`, los pasos anteriores no encajan limpiamente. Haz primero la [migración a plugins declarativos](https://docs.flutter.dev/release/breaking-changes/flutter-gradle-plugin-apply) y luego vuelve al paso 2. No reproduje esa estructura para este post; ahí la referencia es la documentación de Flutter. Si en cambio estás atascado con el mensaje de la versión antigua de Kotlin, [el post sobre el error de versión de KGP](/es/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/) explica dónde vive esa versión en las estructuras antiguas.

**Gradle 9 convierte otras advertencias antiguas en errores.** Gradle 9 eliminó APIs que Gradle 8 solo había deprecado, así que un plugin antiguo puede fallar por razones que no tienen que ver con Kotlin. Si junto a eso aparece una advertencia de JDK 24 como `A restricted method in java.lang.System has been called`, esa se cubre en [su propio post](/es/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/).

## Resultados medidos

| Estado del proyecto (Flutter 3.47.4 salvo que se indique) | Resultado |
| --- | --- |
| AGP 8.9.1, KGP 2.1.0, Gradle 8.12, `kotlin-android` | Falla: Gradle por debajo de 8.14 |
| AGP 9.1.0, KGP 2.4.0, Gradle 9.3.1, `kotlinOptions` conservado | Falla: errores de compilación del script |
| Igual, `compilerOptions`, `kotlin-android` conservado, `builtInKotlin=false` | Compila, advertencia de KGP para `app` |
| Igual, `builtInKotlin=true` | Falla: KGP ya no es necesario desde AGP 9.0 |
| `kotlin-android` eliminado, `builtInKotlin=true` | Compila, 4.0 s incremental |
| Línea de KGP eliminada de `settings.gradle.kts` | Falla: Kotlin 2.2.10 por debajo de 2.2.20 |
| Plugin que aplica KGP, `builtInKotlin=true` | Falla, nombra el archivo de compilación del plugin |
| Plugin que aplica KGP, `builtInKotlin=false` | Compila, la advertencia lista el plugin |
| Migrado, `newDsl=true` | Falla: `ClassCastException` en el Flutter Gradle Plugin |
| Migrado, `builtInKotlin=true`, Flutter 3.44.8 | Compila, mensaje engañoso "KGP was not found" |

## Relacionado

- [Solución: Gradle task assembleDebug failed with exit code 1 en una compilación Android de Flutter](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)
- [Solución: Toolchain installation does not provide the required capabilities: [JAVA_COMPILER]](/es/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/)
- [Solución: A restricted method in java.lang.System has been called en una compilación Gradle de Flutter](/es/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/)
- [Solución: flutter doctor --android-licenses falla con cmdline-tools 23](/es/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/)
- [Flutter: your project requires a newer version of the Kotlin Gradle plugin](/es/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/)

## Fuentes

- [Migrating Flutter Android projects to built-in Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin) y la [guía para desarrolladores de apps](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), documentación de Flutter.
- [Built-in Kotlin migration for plugin authors](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-plugin-authors), documentación de Flutter.
- [Notas de versión de Android Gradle Plugin 9.0](https://developer.android.com/build/releases/agp-9-0-0-release-notes): Gradle 9.1.0, JDK 17, dependencia de runtime KGP 2.2.10, nuevos valores por defecto.
- [What's new in Kotlin 2.2.0](https://kotlinlang.org/docs/whatsnew22.html): la deprecación de `kotlinOptions` elevada a error.
- Código fuente de Flutter 3.47.4: `packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt` (versiones mínimas), `FlutterPluginUtils.kt` (`isBuiltInKotlinEnabled`, KGP aplicado automáticamente), `lib/src/android/migrations/disable_built_in_kotlin_migration.dart`.
- Issues de Flutter [#181383](https://github.com/flutter/flutter/issues/181383), [#183909](https://github.com/flutter/flutter/issues/183909), [#184837](https://github.com/flutter/flutter/issues/184837), [#180137](https://github.com/flutter/flutter/issues/180137).
