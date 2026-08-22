---
title: "Solución: A restricted method in java.lang.System has been called en una compilación Gradle de Flutter"
description: "La advertencia de JEP 472 en JDK 24+ es inofensiva y se imprime una sola vez. Corrígela alineando tu JDK con una versión de Gradle que lo soporte, no pegando flags en gradle.properties."
pubDate: 2026-08-22
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "jdk"
lang: "es"
translationOf: "2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build"
translatedBy: "claude"
translationDate: 2026-08-22
---

Tu compilación está bien. Esta es una advertencia de JDK 24 y posteriores proveniente de [JEP 472](https://openjdk.org/jeps/472), impresa una vez por módulo llamante cuando algo carga una biblioteca nativa mediante `System.load` o `System.loadLibrary` sin `--enable-native-access`. Gradle actual ya pasa ese flag a su propio daemon, así que si estás viendo esto, o tu JDK es más nuevo de lo que tu Gradle soporta, o a una JVM bifurcada dentro de la compilación le falta el flag. Volver al JDK 21 que incluye Android Studio la hace desaparecer por completo.

Todo lo que sigue se midió en Windows 11 con Flutter 3.44.2 stable (revisión `c9a6c48423`), Gradle 9.1.0, JDK 26.0.2 (`26.0.2+10-55`) y Microsoft OpenJDK 21.0.11.

## El error en contexto

```text
WARNING: A restricted method in java.lang.System has been called
WARNING: java.lang.System::load has been called by net.rubygrapefruit.platform.internal.NativeLibraryLoader in an unnamed module (file:/C:/Users/mariu/.gradle/wrapper/dists/gradle-9.1.0-all/7wzd0jkjit61aq2p43wpjgij9/gradle-9.1.0/lib/native-platform-0.22-milestone-28.jar)
WARNING: Use --enable-native-access=ALL-UNNAMED to avoid a warning for callers in this module
WARNING: Restricted methods will be blocked in a future release unless native access is enabled
```

La segunda línea varía. `java.lang.System::loadLibrary` aparece en lugar de `::load` cuando quien llama pasó un nombre de biblioteca en vez de una ruta absoluta, y la clase llamante es la que realmente cargó el código nativo. `net.rubygrapefruit.platform.internal.NativeLibraryLoader` es la integración nativa propia de Gradle. `com.sun.jna.Native` es JNA, incorporada por algún plugin.

## ¿Qué significa "a restricted method in java.lang.System has been called"?

JEP 472, entregado en JDK 24, convirtió `System::load`, `System::loadLibrary`, `Runtime::load` y `Runtime::loadLibrary` en métodos restringidos, y volvió una operación restringida el enlazar un método `native` de JNI. Restringido significa que la JVM exige una habilitación explícita antes de que el código salga fuera del runtime, porque una biblioteca nativa defectuosa puede corromper el heap de formas que la JVM no puede reportar.

La habilitación es `--enable-native-access`. Sin ella, JDK 24 y posteriores imprimen el bloque de cuatro líneas de arriba y continúan. Vale la pena saber tres cosas antes de buscar una solución:

La advertencia se emite **una vez por módulo llamante**, no una vez por llamada. Un bucle que carga tres bibliotecas desde la misma clase imprime un solo bloque:

```java
// JDK 26.0.2, plain javac, no flags
public class MultiProbe {
    public static void main(String[] args) {
        for (int i = 0; i < 3; i++) {
            try { System.load("C:/Windows/System32/winhttp.dll"); }
            catch (Throwable t) { /* ignore */ }
        }
        System.out.println("DONE-MULTI");
    }
}
```

Eso imprime un bloque de advertencia seguido de `DONE-MULTI`. Si ves el bloque repetido, estás mirando varias JVM distintas, o varios jars distintos, en un mismo registro de compilación. Lee la ruta del módulo en la línea 2 de cada bloque para distinguirlos.

El modo por defecto sigue siendo `warn`. Ejecutar la misma clase con `--illegal-native-access=warn` en JDK 26.0.2 produce una salida idéntica a ejecutarla sin ningún flag, que es como confirmas que el valor por defecto no cambió a `deny` en el JDK que usas.

Y la última línea es un pronóstico, no un aviso de obsolescencia sobre tu código. "Blocked in a future release" se refiere a un JDK futuro, no a un Gradle o un Flutter futuro.

## ¿Qué versiones de JDK imprimen esto, y por qué JDK 21 no?

JDK 24 es el piso. Esta advertencia no existe en JDK 21 ni en 17. Ejecutar la misma prueba en Microsoft OpenJDK 21.0.11 imprime `DONE-MULTI` y nada más.

Conviene ser preciso aquí porque la restricción llegó en dos olas. JDK 22 y 23 advierten sobre métodos restringidos en la Foreign Function and Memory API, así que el mensaje nombra `java.lang.foreign.Linker` o similar. La mitad correspondiente a JNI, que es la variante `java.lang.System::load` sobre la que estás leyendo, llegó en JDK 24. Si tu advertencia nombra `java.lang.System`, estás en JDK 24 o posterior.

Eso importa para Flutter porque Flutter no elige el JDK más nuevo de tu máquina. Resuelve uno, en este orden, según `packages/flutter_tools/lib/src/android/java.dart`:

1. La ruta almacenada por `flutter config --jdk-dir`.
2. El JBR incluido con Android Studio.
3. `JAVA_HOME`.
4. El primer `java` en el `PATH`.

El JBR incluido con Android Studio es un 21 en las versiones actuales, así que una instalación de Flutter por defecto nunca ve esta advertencia. Verla significa que tú mismo apuntaste `jdk-dir` o `JAVA_HOME` a un JDK 24, 25 o 26, casi siempre como efecto colateral de instalar el "último Java" desde un gestor de paquetes. Confirma cuál está en juego con `flutter doctor --verbose`, que imprime el binario de Java resuelto y su versión.

## ¿Gradle ya pasa --enable-native-access a su daemon?

Sí, y esta es la parte que cambia la solución. Gradle envía el flag desde la 8.14. La lógica vive en `org.gradle.internal.jvm.JpmsConfiguration`, y el bytecode en `gradle-base-services-8.14.jar` y en `gradle-base-services-9.1.0.jar` es idéntico: `forDaemonProcesses(int, boolean)` y `forWorkerProcesses(int, boolean)` comparan la versión de Java objetivo contra `24`, y cuando es 24 o superior y el booleano es verdadero devuelven una lista que contiene `--enable-native-access=ALL-UNNAMED`. Quienes las llaman, `DefaultDaemonStarter` y `DefaultWorkerProcessBuilder`, pasan `NativeServices.NativeServicesMode.isPotentiallyEnabled()` como ese booleano.

Puedes verlo en un daemon vivo. Inicia cualquier compilación y luego pídele a la JVM su línea de comandos:

```bash
# JDK 26.0.2 jcmd against a running Gradle 9.1.0 daemon
jps -l | grep GradleDaemon
jcmd <pid> VM.command_line
```

En un daemon de Gradle 9.1.0 corriendo sobre JDK 26.0.2 eso imprime, entre las entradas `--add-opens`, un único `--enable-native-access=ALL-UNNAMED`. Vale la pena conocer dos consecuencias:

- Definir tu propio `org.gradle.jvmargs` no lo sobrescribe. Con `org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G` en `gradle.properties`, la línea de comandos del daemon sigue llevando `-Xmx4G`, `-XX:MaxMetaspaceSize=2G` **y** `--enable-native-access=ALL-UNNAMED`. Esto importa especialmente en Flutter, porque la plantilla de la app trae una línea `org.gradle.jvmargs` no vacía por defecto.
- Definir `org.gradle.native=false` sí lo elimina, porque `isPotentiallyEnabled()` devuelve falso. Eso no es una solución, es Gradle apagando su integración nativa por completo, y con ella pierdes la vigilancia del sistema de archivos.

Así que una advertencia que nombra `net.rubygrapefruit.platform.internal.NativeLibraryLoader` desde un daemon de Gradle actual no es algo que se parchee con un flag. Significa que esa JVM no recibió los argumentos de Gradle, lo que apunta a una de tres cosas: un Gradle anterior a la 8.14, una JVM bifurcada por un plugin en lugar de por la worker API de Gradle, o un IDE hablando con tu compilación mediante la Tooling API. Las propias notas de la versión 8.14 de Gradle señalan lo último: quienes consumen la Tooling API deben habilitar el acceso nativo al arrancar, por su uso de JNI.

## ¿Qué JVM de la compilación está imprimiendo la advertencia?

Trabaja desde la línea 2 hacia afuera. Nombra tanto la clase llamante como el jar del que vino, y ese par basta para ubicar la JVM:

- Llamante en un `native-platform-*.jar` bajo `~/.gradle/wrapper/dists/`, y `jcmd` muestra que el daemon sí tiene el flag: la advertencia viene de un proceso distinto del daemon que inspeccionaste, típicamente un worker bifurcado o un daemon de compilación iniciado por un plugin.
- Llamante en un `jna-*.jar`: un plugin cargó JNA. Encuéntralo con `./gradlew :app:dependencies --configuration runtimeClasspath` desde el directorio `android/` y busca `net.java.dev.jna`.
- Llamante en un jar bajo `~/.gradle/caches/modules-2/`: es una dependencia de un plugin, no Gradle en sí, y quien mantiene el plugin necesita bifurcar con el flag.

Como Flutter ejecuta Gradle por ti, captura primero la salida cruda:

```bash
# Flutter 3.44.2, run from the project root
flutter build apk --debug --verbose 2>&1 | tee build.log
grep -n "restricted method" -A 3 build.log
```

## ¿Cómo elimino la advertencia?

En orden de preferencia.

**Alinea tu JDK con tu versión de Gradle.** La matriz de compatibilidad de Gradle es estricta: Java 24 necesita Gradle 8.14 o posterior, Java 25 necesita 9.1.0 o posterior, y Java 26 necesita 9.4.0 o posterior. Flutter 3.44.2 genera proyectos sobre Gradle 9.1.0 con AGP 9.0.1 y Kotlin 2.3.20, así que un proyecto nuevo está bien en JDK 24 o 25 y le falta una versión para JDK 26. Sube el wrapper en `android/gradle/wrapper/gradle-wrapper.properties`:

```properties
# Flutter 3.44.2 default is gradle-9.1.0-all; 9.4.0+ is required for JDK 26
distributionUrl=https\://services.gradle.org/distributions/gradle-9.4.0-all.zip
```

Pasarse de la matriz no solo advierte. Gradle 9.1.0 sobre JDK 26.0.2 falla la compilación de plano:

```text
BUG! exception in phase 'semantic analysis' in source unit '_BuildScript_' Unsupported class file major version 70
```

Flutter reconoce ese caso. `gradle_errors.dart` coincide con `Unsupported class file major version\s+\d+` e imprime un recuadro diciéndote que tu versión de Gradle es incompatible con la versión de Java que Flutter está usando, con un puntero a `flutter doctor --verbose`.

**Apunta Flutter al JDK que realmente quieres.** Si no necesitas un JDK de última hora para este proyecto, el camino más corto es dejar de entregárselo a Flutter:

```bash
# Flutter 3.44.2; persists to the Flutter config, survives JAVA_HOME changes
flutter config --jdk-dir "C:\Program Files\Android\Android Studio\jbr"
flutter doctor --verbose
```

Como `jdk-dir` está por encima de `JAVA_HOME` en el orden de resolución, esto gana sobre lo que sea que un gestor de paquetes haya definido globalmente, y solo afecta a Flutter.

**Agrega el flag a la JVM a la que le falta.** Solo una vez que hayas identificado esa JVM en la línea 2. Para el daemon de Gradle en un Gradle antiguo, eso es `org.gradle.jvmargs` en `android/gradle.properties`, añadido a lo que la plantilla de Flutter ya puso ahí:

```properties
# Flutter 3.44.2 template default, plus the JEP 472 opt-in
org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError --enable-native-access=ALL-UNNAMED
```

Para un daemon de compilación de Kotlin, la perilla equivalente es `kotlin.daemon.jvmargs`. Ten en cuenta que esto es una habilitación real con un significado real, no un botón de silencio: estás afirmando que todo lo que está en el class path puede llamar código nativo.

## ¿Es seguro poner --illegal-native-access=allow en gradle.properties?

No, y este es el único cambio aquí que realmente puede romper la compilación de un compañero.

`--illegal-native-access` se introdujo junto con JEP 472 en JDK 24. En JDK 21 no existe, y una opción `-` desconocida es fatal al arrancar la JVM:

```text
Unrecognized option: --illegal-native-access=deny
Error: Could not create the Java Virtual Machine.
Error: A fatal exception has occurred. Program will exit.
```

Ponlo en `org.gradle.jvmargs` y la compilación muere para cualquiera en JDK 21, lo que incluye a todo desarrollador que use el JBR incluido con Android Studio y a la mayoría de las imágenes de CI fijadas a un LTS. `--enable-native-access` es más seguro en ese frente, ya que existe desde JDK 21 y allí se acepta sin quejas, pero aun así conviene acotarlo al proyecto en lugar de a un `GRADLE_OPTS` global.

El valor `allow` tiene un segundo problema: es el modo de compatibilidad que JEP 472 describe como temporal, a eliminarse gradualmente y finalmente a retirarse. Construir sobre él significa que la advertencia vuelve como error en algún JDK futuro, según el calendario de otra persona.

## ¿Qué pasa cuando la advertencia se convierte en error?

Puedes ver el desenlace hoy si te adelantas. Cargar la propia biblioteca nativa de Gradle en JDK 26.0.2 bajo `--illegal-native-access=deny`:

```text
Exception in thread "main" net.rubygrapefruit.platform.NativeException: Failed to load native library 'native-platform.dll' for Windows 11 amd64.
	at net.rubygrapefruit.platform.internal.NativeLibraryLoader.load(NativeLibraryLoader.java:67)
	at net.rubygrapefruit.platform.Native.init(Native.java:60)
Caused by: java.lang.IllegalCallerException: Illegal native access from an unnamed module (file:/C:/.../gradle-9.1.0/lib/native-platform-0.22-milestone-28.jar)
	at java.base/java.lang.Module.ensureNativeAccess(Module.java:311)
	at java.base/java.lang.System$1.ensureNativeAccess(System.java:2110)
```

La `IllegalCallerException` es la parte del JDK. Todo lo que está encima es el manejo de fallos de la propia biblioteca, y por eso la versión futura de este problema no se verá como un error de acceso nativo. Se verá como lo que sea que diga la biblioteca cuando una `.dll` o un `.so` no logra cargarse. Ejecutar tu CI con `--illegal-native-access=deny` en un job sobre JDK 24+ es una forma barata de descubrir cuál de tus plugins se romperá primero, siempre que lo mantengas fuera del `gradle.properties` compartido.

## Relacionado

- [Toolchain installation does not provide the required capabilities: \[JAVA_COMPILER\]](/es/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/) cubre la otra mitad de la historia del JDK en Flutter, donde Gradle resuelve un JRE en lugar de un JDK.
- [Gradle task assembleDebug failed with exit code 1](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) recorre cómo sacar el error real de un registro de compilación Android de Flutter.
- [flutter doctor reporta que falta el componente cmdline-tools](/es/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) es el complemento para cuando el propio `flutter doctor --verbose` no está contento.
- [La UI de Flutter se superpone a la barra de navegación de Android tras apuntar a SDK 35](/es/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) es otro caso donde un cambio de la plataforma Android aparece tarde en un proyecto Flutter.

## Fuentes

- [JEP 472: Prepare to Restrict the Use of JNI](https://openjdk.org/jeps/472), que define los métodos restringidos y la habilitación `--enable-native-access`.
- [JDK 24: Prepares Restricted Native Access](https://inside.java/2024/12/09/quality-heads-up/) en Inside Java, la nota de difusión de calidad para el cambio de JDK 24.
- [Matriz de compatibilidad de Java en Gradle](https://docs.gradle.org/current/userguide/compatibility.html), para la versión de Gradle requerida por cada release de Java.
- [Notas de la versión Gradle 8.14](https://docs.gradle.org/8.14/release-notes.html), que agregan soporte del daemon para Java 24 y señalan el requisito de JNI de la propia Tooling API.
- Fuentes de Flutter 3.44.2: `packages/flutter_tools/lib/src/android/java.dart` para el orden de resolución del JDK y `packages/flutter_tools/lib/src/android/gradle_errors.dart` para el manejador de la versión de class file.
