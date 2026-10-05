---
title: "Solución: Timeout waiting to lock journal cache en una compilación de Flutter para Android"
description: "Otro proceso de Gradle retiene ~/.gradle/caches/journal-1 y no puede cederlo. Encuentra el Owner PID, mata ese daemon y deja de borrar archivos .lock: eso solo traslada el error."
pubDate: 2026-10-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
lang: "es"
translationOf: "2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-10-05
---

Un proceso de Gradle distinto, el "Owner PID" del mensaje, retiene el bloqueo de `~/.gradle/caches/journal-1` y no respondió a la solicitud de tu compilación para liberarlo dentro del timeout fijo de 60 segundos de Gradle. La solución es encontrar ese proceso y matarlo: `jps -l` (o `ps`) para confirmar que es un `GradleDaemon`, luego `kill -9 <Owner PID>` o `Stop-Process -Id <Owner PID> -Force` en Windows, y vuelve a ejecutar `flutter run`. `./gradlew --stop` a menudo no hace nada aquí, porque solo detiene los daemons de su propia versión de Gradle. Borrar `journal-1.lock` tampoco lo arregla: en mi reproducción la siguiente compilación simplemente agotó el tiempo de espera en la caché de hashes de archivos.

Todo lo que sigue se reprodujo en macOS con Flutter 3.44.8 (cuya plantilla fija Gradle 9.1.0 y AGP 9.0.1), distribuciones de Gradle 9.3.1 y 8.14, y OpenJDK 17, usando un `GRADLE_USER_HOME` desechable. El código de bloqueo se leyó del código fuente de Gradle en la etiqueta `v9.8.0`, la versión actual.

## El error en contexto

Esta es la salida exacta de mi reproducción (rutas abreviadas a `~`):

```text
FAILURE: Build failed with an exception.

* What went wrong:
Gradle could not start your build.
> Cannot create service of type BuildSessionActionExecutor using method LauncherServices$ToolingBuildSessionScopeServices.createActionExecutor() as there is a problem with parameter #21 of type BuildLifecycleAwareVirtualFileSystem.
   ...
            > Could not create service of type FileAccessTimeJournal using GradleUserHomeScopeServices.createFileAccessTimeJournal().
               > Timeout waiting to lock journal cache (~/.gradle/caches/journal-1). It is currently in use by another process.
                 Owner PID: 52907
                 Our PID: 52963
                 Owner Operation: 
                 Our operation: 
                 Lock file: ~/.gradle/caches/journal-1/journal-1.lock

BUILD FAILED in 1m 1s
```

Cuando Flutter dirige la compilación ves el mismo bloque bajo `FAILURE: Build failed with an exception.`, seguido del propio `Gradle task assembleDebug failed with exit code 1` de Flutter. Esa última línea es el mensajero, no la causa.

Dos detalles te dicen en qué Gradle estás. Gradle 8.x y anteriores dicen "It is currently in use by another **Gradle instance**". Desde Gradle 9.0 la redacción es "in use by another **process**". Las líneas `Owner Operation` y `Our operation` casi siempre están vacías para la caché del journal, así que ignóralas. La línea que importa es `Owner PID`.

## Por qué Gradle no puede tomar el bloqueo

`~/.gradle/caches/journal-1` registra cuándo se usó por última vez cada archivo de las cachés compartidas, para que la limpieza de caché de Gradle sepa qué es seguro eliminar. A diferencia de `caches/9.1.0/` o `caches/8.14/`, **no está versionado**: todas las versiones de Gradle de la máquina, todos los daemons y todas las sincronizaciones del IDE comparten ese único directorio. Por eso es el bloqueo con el que más se tropieza la gente.

Gradle no mantiene estos bloqueos durante toda la compilación. Los toma "bajo demanda" y los cede cuando otro los pide. El algoritmo en `DefaultFileLockManager` es:

1. Intentar tomar un bloqueo de archivo del sistema operativo sobre la región de estado del archivo de bloqueo.
2. Si falla, leer el PID y el puerto UDP del propietario de la región de información del archivo de bloqueo, y hacer ping al propietario por loopback.
3. El propietario, si no está usando la caché en ese momento, libera el bloqueo y lo confirma.
4. Reintentar con espera exponencial hasta obtener el bloqueo o hasta que se agote `DEFAULT_LOCK_TIMEOUT` (60 000 ms).

```java
// Gradle v9.8.0, DefaultFileLockManager.java
public static final int DEFAULT_LOCK_TIMEOUT = 60000;
```

El timeout es una constante que pasa `BasicGlobalScopeServices`. No hay ninguna propiedad de Gradle ni propiedad del sistema para aumentarlo, así que "aumentar el timeout del bloqueo" no es una opción.

Por tanto, el error nunca significa "hay un archivo de bloqueo obsoleto por ahí". Si el proceso propietario hubiera muerto, el sistema operativo habría liberado su bloqueo de archivo y tu compilación lo habría tomado de inmediato. Significa que **un proceso vivo es dueño del bloqueo y no respondió al ping**. Hay cuatro razones realistas:

- **El propietario está colgado.** Un daemon atrapado en GC porque se quedó sin heap, detenido en un depurador o suspendido. Está vivo, así que el sistema operativo conserva su bloqueo, pero no puede atender el ping ([gradle/gradle#16299](https://github.com/gradle/gradle/issues/16299)).
- **El ping no puede llegar.** Se sabe que los productos de seguridad de endpoints y firewalls (CrowdStrike, SentinelOne, Symantec WSS, Netskope, algunos clientes VPN) descartan el tráfico UDP de loopback de Gradle. El caso del firewall de macOS 15.1 es [gradle/gradle#31245](https://github.com/gradle/gradle/issues/31245), corregido en Gradle 8.12.1.
- **El propietario está en otro contenedor.** Dos contenedores de CI que montan el mismo volumen `~/.gradle` comparten el archivo de bloqueo pero no la interfaz de loopback, por lo que los pings nunca llegan ([gradle/gradle#8750](https://github.com/gradle/gradle/issues/8750)). La documentación de Gradle dice que el acceso concurrente a la caché "is only supported if the different Gradle processes can communicate together".
- **El sistema de archivos no maneja bien los bloqueos.** ExFAT, algunos recursos de red compartidos y algunas carpetas sincronizadas ([gradle/gradle#4329](https://github.com/gradle/gradle/issues/4329)).

En la máquina de un desarrollador de Flutter domina la primera causa, porque un proyecto de Flutter suele tener varios clientes de Gradle apuntando a él: `flutter run` desde la terminal o VS Code, la sincronización de Gradle de Android Studio y `flutter build apk` desde un script. Si usan JDK distintos (el JBR incluido en Android Studio frente a `JAVA_HOME`) o versiones de Gradle distintas (dos proyectos creados por versiones diferentes de Flutter), cada uno obtiene su propio daemon, y todos comparten `journal-1`.

## Reproducción mínima

No necesitas Flutter ni un celular para verlo. Basta un proyecto de Gradle con una sola tarea, un directorio de usuario de Gradle temporal y `kill -STOP` para simular un daemon colgado:

```bash
# macOS 26, OpenJDK 17, Gradle 9.3.1 (same 9.x error wording as Gradle 9.1.0 in the Flutter 3.44 template)
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export GRADLE_USER_HOME=/tmp/guh          # keep your real ~/.gradle out of it
mkdir -p /tmp/plain && cd /tmp/plain
echo "rootProject.name = 'plain'" > settings.gradle
echo "tasks.register('hello') { doLast { println 'hello' } }" > build.gradle

gradle hello -q                           # starts a daemon, which keeps journal-1 on demand
PID=$(jps -l | awk '/GradleDaemon/{print $1}')
kill -STOP "$PID"                         # the daemon is alive but cannot answer pings

gradle hello --no-daemon                  # fails after ~60 s: Timeout waiting to lock journal cache
kill -CONT "$PID"
```

Estos son los resultados que medí, cada uno con el mismo directorio de usuario temporal:

| Escenario | Resultado |
| --- | --- |
| Daemon 9.3.1 inactivo y sano, segunda compilación con 9.3.1 | Funciona en 2 s (el daemon cede el bloqueo) |
| Daemon 9.3.1 congelado, segunda compilación con 9.3.1 | Falla tras 62 s en `journal cache`, con `Owner PID` = el daemon congelado |
| Daemon 9.3.1 congelado, `journal-1.lock` borrado, segunda compilación | Falla tras 62 s en `file hash cache (caches/9.3.1/fileHashes)` |
| Daemon 9.3.1 congelado, `gradle --stop` (9.3.1) | Se queda en "Stopping Daemon(s)" (sigue esperando tras 25 s) |
| Daemon 9.3.1 sano, `gradle --stop` desde Gradle 8.14 | Imprime "No Gradle daemons are running." mientras el daemon 9.3.1 sigue ejecutándose |
| Daemon 9.3.1 congelado, compilación con Gradle 8.14 | Falla tras 64 s en `journal cache`, con la redacción antigua "another Gradle instance" |
| `kill -9` al daemon congelado, luego una compilación | Funciona en 2 s |

Las filas tercera y quinta son las que explican por qué este error tiene una reputación tan frustrante.

## La solución, paso a paso

### 1. Identifica el Owner PID

Toma el PID del error y examínalo antes de matar nada:

```bash
# macOS / Linux, any Gradle version
ps -o pid,stat,etime,command -p 52907
jps -l                                    # lists every JVM; Gradle daemons show as org.gradle.launcher.daemon.bootstrap.GradleDaemon
```

```powershell
# Windows PowerShell, any Gradle version
Get-CimInstance Win32_Process -Filter "ProcessId = 52907" | Select-Object ProcessId, CommandLine
Get-CimInstance Win32_Process -Filter "Name = 'java.exe'" |
  Where-Object CommandLine -match 'GradleDaemon' |
  Select-Object ProcessId, CommandLine
```

La línea de comandos incluye la versión de Gradle del daemon y el JDK sobre el que se ejecuta, lo que te dice quién lo inició. Un daemon bajo la carpeta `jbr` de Android Studio vino de una sincronización del IDE. Una `T` en la columna `stat` en macOS o Linux significa que el proceso está detenido. Si el PID pertenece a un proceso que no es un daemon de Gradle (un daemon de compilación de Kotlin, una JVM de pruebas), anótalo, porque indica que una compilación lanzó una JVM de larga duración con tu directorio de usuario de Gradle.

Si el PID no existe en tu máquina, el propietario está en otra parte: otro contenedor o VM que comparte el mismo directorio `.gradle`. Salta a la sección de CI más abajo.

### 2. Mata ese proceso, no el archivo de bloqueo

```bash
# macOS / Linux (a stopped or hung JVM ignores a plain kill, so use -9)
kill -9 52907
```

```powershell
# Windows
Stop-Process -Id 52907 -Force
```

Cuando el propietario muere, el sistema operativo libera su bloqueo. Ejecuta `flutter run` de nuevo y la compilación arranca con normalidad. No hay nada que borrar y no hace falta `flutter clean`, que de todos modos no toca `~/.gradle`.

Para limpiar todos los daemons de todas las versiones de una vez (útil tras un largo día cambiando entre proyectos):

```bash
# macOS / Linux: stops all Gradle daemons regardless of version
jps -l | awk '/GradleDaemon/{print $1}' | xargs kill
```

`./gradlew --stop` dentro de `android/` sirve cuando el propietario es un daemon sano de la *misma* versión de Gradle que tu wrapper. La documentación de Gradle es explícita en que "terminates all Daemon processes started with the same version of Gradle used to execute the command". Mi reproducción muestra ambos modos de fallo: un `--stop` de otra versión ni siquiera ve al propietario, y un `--stop` de la misma versión espera a un daemon colgado en lugar de matarlo.

### 3. Elimina la razón por la que se colgó

Si el mismo daemon se sigue colgando, averigua por qué antes de que vuelva a ocurrir:

- **Heap.** La plantilla de Flutter 3.44 establece `org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G` en `android/gradle.properties`. Los proyectos creados con versiones anteriores de Flutter suelen tener mucho menos, y una aplicación grande con R8 habilitado puede llevar a un daemon a la saturación del GC. Ejecuta `jstack <Owner PID>` antes de matarlo: un volcado lleno de marcos de GC o de `OutOfMemoryError` lo confirma.
- **Dos JDK.** Haz que Flutter y Android Studio usen el mismo JDK para que compartan un daemon en lugar de dos. `flutter doctor -v` imprime el `Java binary at:` que usa Flutter. Apunta la configuración de JDK de Gradle de Android Studio al mismo, o apunta Flutter al de Android Studio con `flutter config --jdk-dir <path>`.
- **Software de seguridad.** Si el error aparece siempre que dos proyectos se compilan a la vez y el propietario está sano, sospecha de un firewall o agente de endpoint que filtra UDP de loopback. Actualiza el wrapper de Gradle del proyecto por encima de 8.12.1 (los proyectos de las plantillas actuales de Flutter ya lo están), y luego pide a TI una excepción para el tráfico de loopback de tu JDK.

## CI y Docker

En CI el Owner PID suele vivir en otro job. Funcionan tres configuraciones:

1. **Un directorio de usuario de Gradle por job.** Establece `GRADLE_USER_HOME` en una ruta dentro del espacio de trabajo del job y usa el paso de caché de CI para conservarlo entre ejecuciones. Nunca hay dos procesos vivos que compartan un archivo de bloqueo.
2. **Una caché de dependencias compartida de solo lectura.** `GRADLE_RO_DEP_CACHE` de Gradle apunta a un directorio `modules-2` prepoblado que Gradle lee sin bloqueo, mientras cada contenedor conserva su propio directorio de usuario escribible. La funcionalidad sigue marcada como incubating en la documentación de Gradle, y la copia compartida nunca debe escribirse mientras las compilaciones la leen.
3. **No dejes daemons atrás.** `flutter build apk --no-android-gradle-daemon` (el flag es true por defecto en Flutter 3.44.8) pasa `--no-daemon` al wrapper, de modo que la JVM de la compilación termina cuando termina la compilación. Esto no evita la contención entre dos jobs que se ejecutan al mismo tiempo, pero elimina al propietario más común: un daemon que dejó el job anterior en un runner reutilizado.

```yaml
# GitHub Actions, Flutter 3.44.8: per-job Gradle home, cached between runs
env:
  GRADLE_USER_HOME: ${{ github.workspace }}/.gradle-home
steps:
  - uses: actions/cache@v4
    with:
      path: ${{ github.workspace }}/.gradle-home/caches
      key: gradle-${{ runner.os }}-${{ hashFiles('android/**/*.gradle*', 'android/gradle/wrapper/gradle-wrapper.properties') }}
  - run: flutter build apk --release --no-android-gradle-daemon
```

Ejecutar los contenedores con red de host también hace que los pings funcionen, pero renuncia al aislamiento que querías de los contenedores, así que yo recurriría primero a un directorio por job.

## Por qué "borra los archivos .lock" sigue apareciendo

El consejo más votado para este error es `find ~/.gradle -type f -name "*.lock" -delete`. Mi reproducción muestra qué hace eso cuando el propietario sigue vivo. La segunda compilación creó un `journal-1.lock` nuevo, lo bloqueó y luego agotó el tiempo 60 segundos después en `caches/9.3.1/fileHashes/fileHashes.lock`, porque el daemon congelado también retenía ese. Borrar todos los archivos de bloqueo deja continuar la nueva compilación, pero ahora dos procesos creen ser dueños de los mismos archivos de caché. Así es como la gente termina con `CorruptedCacheException` y con un borrado completo de `~/.gradle/caches`, como se reporta en [gradle/gradle#30135](https://github.com/gradle/gradle/issues/30135).

Cuando parece funcionar, es porque el propietario terminó o murió mientras tanto. Matar al propietario da el mismo resultado sin el riesgo de corrupción.

## Errores parecidos

- **`Timeout waiting to lock file hash cache`, `build cache`, `Generated Gradle JARs cache`, `artifact cache`.** Mismo mecanismo y misma solución: encuentra el Owner PID y mátalo. Solo cambia el nombre de la caché.
- **`Timeout waiting to lock ... It is currently in use by this process.`** Sin línea `Owner PID`. La contención es entre dos hilos de una misma compilación, normalmente por un mal uso de un plugin o del test kit ([gradle/gradle#35592](https://github.com/gradle/gradle/issues/35592)). Matar daemons no ayudará.
- **`Gradle task assembleDebug failed with exit code 1`** por sí solo. Es Flutter resumiendo aquello en lo que falló Gradle. Consulta [cómo leer el error real detrás de assembleDebug failed](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- **`e: Daemon compilation failed: null`.** A pesar de la palabra "daemon", ese es el daemon de compilación de Kotlin y un error de rutas entre unidades, tratado en [la solución de Daemon compilation failed](/es/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/).

## Relacionado

- [Solución: Gradle task assembleDebug failed with exit code 1 en una compilación de Flutter para Android](/es/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) explica cómo sacar el bloque de error propio de Gradle de una compilación de Flutter.
- [Migrar un proyecto Flutter de Android a AGP 9 con Kotlin integrado](/es/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) cubre las versiones de Gradle y AGP que fijan las plantillas más nuevas.
- [Solución: A restricted method in java.lang.System has been called](/es/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/) es otro caso en el que importa el JDK que ejecuta tu daemon de Gradle.
- [Apuntar a varias versiones de Flutter desde un mismo pipeline de CI](/es/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) muestra compilaciones en matriz, donde los directorios de Gradle por job rinden frutos.

## Fuentes

- Código fuente de Gradle, [`DefaultFileLockManager.java` en v9.8.0](https://github.com/gradle/gradle/blob/v9.8.0/platforms/core-execution/persistent-cache/src/main/java/org/gradle/cache/internal/DefaultFileLockManager.java) y [`DefaultFileLockContentionHandler.java`](https://github.com/gradle/gradle/blob/v9.8.0/platforms/core-execution/persistent-cache/src/main/java/org/gradle/cache/internal/locklistener/DefaultFileLockContentionHandler.java).
- Documentación de Gradle: [The Gradle Daemon](https://docs.gradle.org/current/userguide/gradle_daemon.html) (alcance de `--stop`, compatibilidad de daemons) y [Dependency caching](https://docs.gradle.org/current/userguide/dependency_caching.html) (bloqueo de caché, `GRADLE_RO_DEP_CACHE`).
- [gradle/gradle#8750](https://github.com/gradle/gradle/issues/8750), [#16299](https://github.com/gradle/gradle/issues/16299), [#31245](https://github.com/gradle/gradle/issues/31245), [#30135](https://github.com/gradle/gradle/issues/30135), [#8375](https://github.com/gradle/gradle/issues/8375).
- `flutter_tools` de Flutter 3.44.8, `lib/src/android/gradle.dart` y `lib/src/runner/flutter_command.dart` (el flag `--android-gradle-daemon`).
