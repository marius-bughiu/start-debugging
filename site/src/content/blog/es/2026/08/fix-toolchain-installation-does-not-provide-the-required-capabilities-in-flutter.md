---
title: "Solución: Toolchain installation does not provide the required capabilities: [JAVA_COMPILER]"
description: "Gradle está compilando con un JRE. No busca en tu máquina, usa exactamente la JVM con la que se lanzó. Apunta flutter config --jdk-dir a un JDK real, o borra org.gradle.java.home."
pubDate: 2026-08-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "java"
lang: "es"
translationOf: "2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-21
---

El directorio de Java sobre el que corre Gradle no tiene `bin/javac`, así que es un JRE, no un JDK. Gradle no está buscando uno mejor en tu máquina: si no hay ningún toolchain configurado, usa la JVM con la que se lanzó y falla de inmediato. En una compilación de Android con Flutter, esa JVM la elige primero `flutter config --jdk-dir`, así que ejecuta `flutter config --jdk-dir "/ruta/a/un/jdk/real"` y vuelve a compilar. Si eso no cambia el error, algo está sobrescribiendo a Flutter: revisa `org.gradle.java.home` en `android/gradle.properties`.

Todo lo que sigue se verificó contra Flutter 3.44.2 stable, cuyas plantillas de Android fijan Gradle 9.1.0, Android Gradle Plugin 9.0.1, Kotlin Gradle Plugin 2.3.20 y `compileSdk` 36.

## El error tal como lo imprime Gradle

```text
FAILURE: Build failed with an exception.

* What went wrong:
Could not determine the dependencies of task ':app:packageDebug'.
> Could not create task ':app:compileDebugJavaWithJavac'.
   > Failed to calculate the value of task ':app:compileDebugJavaWithJavac' property 'javaCompiler'.
      > Toolchain installation 'C:\path\to\some-java-home' does not provide the required capabilities: [JAVA_COMPILER]
```

A través de `flutter build apk` normalmente solo ves el final, envuelto en `Gradle task assembleDebug failed with exit code 1`. La ruta entre comillas es lo importante. Es el directorio de Java que Gradle rechazó y, nueve de cada diez veces, no lo configuraste a conciencia.

## Por qué Gradle culpa a un directorio de Java que nunca configuraste

Este mensaje viene de Gradle, no de Flutter ni de AGP. En Gradle 9.1.0 lo lanza `JavaToolchainQueryService`, y la lógica que lo rodea es toda la historia:

```java
// Gradle 9.1.0, JavaToolchainQueryService.resolveToolchain
boolean useFallback = !requestedSpec.isConfigured();
JavaToolchainSpec actualSpec = useFallback ? fallbackToolchainSpec : requestedSpec;
```

Si no hay ningún toolchain configurado en la compilación, Gradle sustituye una especificación de respaldo que significa "la JVM actual". Ese camino no busca, ni filtra, ni ordena nada:

```java
// Gradle 9.1.0, JavaToolchainQueryService.query
if (spec instanceof CurrentJvmToolchainSpec) {
    return asToolchainOrThrow(
        InstallationLocation.autoDetected(currentJavaHome, "current JVM"),
        spec, requiredCapabilities, isFallback);
}
```

`asToolchainOrThrow` inspecciona esa única instalación y lanza el error si le falta alguna capacidad requerida. Compáralo con el camino configurado, `findInstalledToolchain`, que pasa todas las instalaciones detectadas por un comparador que conoce las capacidades y descarta en silencio las que no califican.

Esa diferencia es lo más útil que hay que saber aquí. Este error significa que a Gradle se le entregó un directorio de Java concreto y ese directorio no tiene compilador. No significa "Gradle no pudo encontrar un JDK". Cuando Gradle realmente no encuentra ninguno, aparece un mensaje completamente distinto, que se cubre más abajo.

También significa que la configuración de detección automática de toolchains es irrelevante en este camino. Lo confirmé ejecutando la misma tarea dos veces, una con `-Dorg.gradle.java.installations.auto-detect=false` y otra con la detección activada. Fallo idéntico en ambos casos.

## Qué comprueba Gradle en realidad cuando dice JAVA_COMPILER

Menos de lo que imaginarías. No hay inspección, ni consulta de módulos, ni intento de invocar una API de compilador. Es una prueba de existencia de archivo:

```java
// Gradle 9.1.0, JvmInstallationMetadata.gatherCapabilities
if (getToolByExecutable("javac").exists()) {
    capabilities.add(JavaInstallationCapability.JAVA_COMPILER);
}
if (getToolByExecutable("javadoc").exists()) {
    capabilities.add(JavaInstallationCapability.JAVADOC_TOOL);
}
if (getToolByExecutable("jar").exists()) {
    capabilities.add(JavaInstallationCapability.JAR_TOOL);
}
```

`getToolByExecutable` resuelve `<javaHome>/bin/<name>` con el sufijo de ejecutable de la plataforma. Gradle etiqueta una instalación como "JDK" solo cuando están presentes los tres: `javac`, `javadoc` y `jar`, y `JAVA_COMPILER` es exactamente `bin/javac`.

La consecuencia práctica: un directorio de Java que es un JDK en todos los sentidos salvo que su directorio `bin` no contiene literalmente `javac` será reportado como JRE. Eso incluye los paquetes `java-17-openjdk` de Fedora y Debian que solo traen el runtime headless, un directorio `jre` antiguo dentro de una instalación de JDK, y cualquier directorio envoltorio que reenvíe `java` pero no el resto de las herramientas.

## Reproducción: construye un JRE y míralo fallar

No necesitas una máquina rota para ver esto. Construye una imagen de runtime sin los módulos del compilador usando `jlink`, que es lo que es un JRE:

```bash
# JDK 21.0.11, jlink from the same JDK
MODS=$(java --list-modules | sed 's/@.*//' \
  | grep -vE '^(jdk\.compiler|jdk\.javadoc|jdk\.jshell|jdk\.jlink|jdk\.jdeps|jdk\.jpackage)$' \
  | paste -sd, -)
jlink --add-modules "$MODS" --no-header-files --no-man-pages --output ./real-jre-21
ls ./real-jre-21/bin/javac   # no such file
./real-jre-21/bin/java -version
# openjdk version "21.0.11" 2026-04-21 LTS
```

Excluir `jdk.jpackage` importa. Arrastra `jdk.jlink`, que arrastra `jdk.jdeps`, que vuelve a arrastrar `jdk.compiler`, y terminas con el lanzador `javac` que intentabas evitar.

Ahora apunta Flutter ahí y compila una app recién creada con `flutter create`:

```bash
# Flutter 3.44.2 stable, Gradle 9.1.0, AGP 9.0.1
flutter create --platforms=android toolchain_repro
flutter config --jdk-dir "$(pwd)/real-jre-21"
cd toolchain_repro && flutter build apk --debug
```

Eso falla con el error exacto del principio de este artículo, en una plantilla sin modificar y sin ningún bloque de toolchain.

## ¿Qué Java usa realmente una compilación de Flutter?

Aquí es donde se pierde la mayor parte del tiempo de depuración, porque `JAVA_HOME` no es lo primero que mira Flutter. Según `packages/flutter_tools/lib/src/android/java.dart` en 3.44.2, `_findJavaHome` devuelve la primera coincidencia en este orden:

1. el valor `jdk-dir` en la configuración propia de Flutter, establecido con `flutter config --jdk-dir`
2. el JDK incluido con Android Studio
3. la variable de entorno `JAVA_HOME`
4. lo que sea que resuelva `java` en el `PATH`

Así que un `jdk-dir` obsoleto le gana a un `JAVA_HOME` perfectamente válido, de forma permanente y silenciosa. Me topé con esto mientras escribía la reproducción: exporté `JAVA_HOME` apuntando al runtime mutilado y la compilación seguía funcionando, porque ganaba un `jdk-dir` configurado tiempo atrás. Revisa el tuyo antes de cambiar cualquier otra cosa:

```bash
# Flutter 3.44.2
flutter config --list | grep jdk-dir
```

Para el punto 2, la ruta incluida depende de la versión de Android Studio. Studio 2022 y posteriores usan `<studio>/jbr`, o `<studio>/jbr/Contents/Home` en macOS. Cualquiera anterior usa `<studio>/jre`. Si tienes una instalación antigua olvidada que Flutter sigue encontrando, ese directorio `jre` es un culpable plausible.

La trampa que hace difícil detectarlo es que `flutter doctor` no comprueba si hay compilador. Con el JRE configurado imprime:

```text
[√] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • Java binary at: /path/to/real-jre-21/bin/java
      This JDK is specified in your Flutter configuration.
    • Java version OpenJDK Runtime Environment Microsoft-13877171 (build 21.0.11+10-LTS)
```

Una marca verde, y las palabras "This JDK". Doctor ejecuta `java --version` y analiza la salida, algo que un JRE responde perfectamente. Nunca busca `javac`. Si ya estás persiguiendo un problema de doctor, `cmdline-tools component is missing` es un diagnóstico aparte con su propia solución.

## ¿Cómo apunto Flutter a un JDK real?

Establece `jdk-dir` explícitamente y vuelve a compilar. Esta es la solución en el caso común:

```bash
# Flutter 3.44.2
flutter config --jdk-dir "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home"
flutter build apk --debug
```

Verifica el directorio antes de establecerlo. La comprobación que hace Gradle es la que deberías hacer tú:

```bash
ls "$YOUR_JDK/bin/javac"
```

Si ese archivo no existe, la ruta es un JRE sin importar cómo se llame el directorio. En Debian y Ubuntu, `openjdk-21-jre-headless` es el paquete que te trae hasta aquí y `openjdk-21-jdk` es el que quieres. En macOS con Homebrew, instala `openjdk@21` y usa la ruta con versión que imprime en lugar de un enlace intermedio.

Para volver a `JAVA_HOME` y a la cadena de precedencia normal, borra la anulación:

```bash
# Flutter 3.44.2, empty value removes the setting
flutter config --jdk-dir ""
```

## ¿Qué anula la elección de JDK de Flutter?

`android/gradle.properties` puede anular todo lo que Flutter decidió. `org.gradle.java.home` fija la JVM sobre la que corre el daemon de Gradle y, como el camino que falla es "la JVM actual", apuntarlo a un JRE reproduce el error incluso cuando `flutter config --jdk-dir` es un JDK válido. Verifiqué esa combinación concreta: `jdk-dir` correcto, una línea añadida, el mismo fallo.

```properties
# android/gradle.properties, delete this line if it points at a JRE
org.gradle.java.home=/path/to/real-jre-21
```

Revisa la misma propiedad en `~/.gradle/gradle.properties`, que aplica a todas las compilaciones de la máquina y es fácil de olvidar. Después confirma qué ve Gradle:

```bash
# run from android/, Gradle 9.1.0
./gradlew -q javaToolchains
```

El informe es el diagnóstico más rápido disponible, porque imprime los dos campos que importan:

```text
 + Microsoft JDK 21 (21.0.11+10-LTS)
     | Location:           C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot
     | Language Version:   21
     | Is JDK:             true
     | Detected by:        Current JVM

 + Oracle JDK 26 (26.0.2+10-55)
     | Location:           C:\Program Files\Java\jdk-26.0.2
     | Language Version:   26
     | Is JDK:             true
     | Detected by:        Windows Registry
```

Un `Is JDK: false` en la entrada cuya ubicación coincide con la ruta de tu mensaje de error confirma el diagnóstico en una sola línea.

## ¿Añadir un bloque de toolchain lo arregla?

El consejo más común para este error es declarar un toolchain en `android/app/build.gradle.kts`. Sí cambia el resultado, pero no siempre en la dirección que quieres, porque saca la compilación del camino de la JVM actual y la mete en el camino de coincidencia, donde Gradle solo aceptará una instalación que realmente pueda descubrir.

Probé exactamente eso. Con el JRE todavía configurado como `jdk-dir`, añadir:

```kotlin
// android/app/build.gradle.kts, AGP 9.0.1, Gradle 9.1.0
java {
    toolchain { languageVersion = JavaLanguageVersion.of(21) }
}
```

produjo un fallo diferente:

```text
> Cannot find a Java installation on your machine (Windows 11 10.0 amd64) matching:
  {languageVersion=21, vendor=any vendor, implementation=vendor-specific, nativeImageCapable=false}.
  Toolchain download repositories have not been configured.
```

Había un JDK 21 instalado todo el tiempo. Gradle no lo encontró porque la detección automática nunca lo había visto: mira otra vez la salida de `javaToolchains` de arriba y fíjate en que el Microsoft JDK 21 aparece como `Detected by: Current JVM`. En cuanto la JVM actual pasó a ser el JRE, esa entrada desapareció de la lista de candidatos, y el escaneo del registro solo sacó a la luz un JDK 26 que no satisface una petición de 21.

Así que un bloque de toolchain a secas cambia un error claro por uno más vago. Úsalo junto con una ruta de instalación explícita, no en su lugar.

## ¿Cómo fijo un JDK para CI de modo que esto no vuelva a pasar?

Declara el toolchain y dile a Gradle dónde están las instalaciones. Esta combinación compila correctamente incluso cuando el daemon corre sobre un JRE, que es la propiedad que quieres en un agente de compilación donde no controlas `JAVA_HOME`:

```properties
# android/gradle.properties, Gradle 9.1.0
org.gradle.java.installations.paths=/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/21.0.11/x64
```

Junto con el bloque `java { toolchain { ... } }` de arriba, esa fue la configuración que confirmé en verde mientras `jdk-dir` seguía apuntando al runtime sin compilador. Vale la pena conocer dos parámetros relacionados: `org.gradle.java.installations.fromEnv=JDK21` lee rutas de variables de entorno con nombre, algo que encaja con imágenes de CI que ya las exportan, y `org.gradle.java.installations.auto-detect=false` desactiva el escaneo por completo para que un agente sin rutas fijadas falle de forma ruidosa en lugar de elegir algo arbitrario.

No recurras a `org.gradle.java.installations.auto-download=true` como solución. Gradle 9 marca como obsoleto el uso de toolchains aprovisionados automáticamente sin repositorios de toolchain declarados y advierte de que se convertirá en error en Gradle 10.

## Variantes que se parecen a este error pero no lo son

`Toolchain installation '...' could not be probed` se lanza dos líneas antes en el mismo método y significa que Gradle no pudo ejecutar `java` en absoluto. Eso es una instalación rota o parcial, un problema de permisos o una arquitectura incompatible, no un JRE.

`Cannot find a Java installation on your machine ... matching` es el camino del toolchain configurado que no encuentra candidato. Se arregla añadiendo la ruta de instalación, como arriba.

`Unsupported class file major version` y `Gradle requires JVM 17 or later` son incompatibilidades de versión, no fallos de capacidad. Flutter 3.44.2 lleva una tabla de compatibilidad Java-Gradle en `gradle_utils.dart`: Java 21 necesita Gradle 8.4 o posterior, Java 24 necesita 8.14 y Java 25 necesita 9.1.0.

`Cannot add extension with name 'kotlin'` es el soporte integrado de Kotlin de AGP 9 chocando con el plugin heredado `kotlin-android`, y es la otra causa frecuente de un `assembleDebug` fallido en 2026.

## Relacionado

- Flutter reporta los fallos de Gradle a través de una línea envoltorio, y el [error real suele quedar truncado más arriba](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- Una marca verde en el toolchain de Android todavía puede ocultar una pieza faltante, como con [el componente cmdline-tools](/es/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/).
- Otro fallo del SDK de Android que se repite igual hasta que limpias una caché: [un archivo NDK corrupto](/es/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- Más ajustes que rompen compilaciones y viven en `android/gradle.properties`: [los flags de AndroidX y Jetifier](/es/2026/05/fix-androidx-conflict-during-flutter-android-build/).
- Contexto de versiones para los valores por defecto de toolchain mencionados aquí: [qué cambió en Flutter 3.44](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).

## Fuentes

- Guía de usuario de Gradle, [Toolchains for JVM projects](https://docs.gradle.org/current/userguide/toolchains.html), para las fuentes de detección automática, la precedencia y las propiedades de instalación.
- Código fuente de Gradle 9.1.0, `JavaToolchainQueryService.java` y `JvmInstallationMetadata.java`, incluidos en el directorio `src` de la distribución `gradle-9.1.0-all`.
- Código fuente de Flutter 3.44.2, `packages/flutter_tools/lib/src/android/java.dart` para el orden de búsqueda de Java y `gradle_utils.dart` para las versiones fijadas de Gradle, AGP y Kotlin.
- Issues de Gradle [#30499](https://github.com/gradle/gradle/issues/30499) y [#30421](https://github.com/gradle/gradle/issues/30421), donde se reporta el mismo mensaje contra paquetes OpenJDK de Linux.
