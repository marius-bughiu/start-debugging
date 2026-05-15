---
title: "Solución: la compilación de Gradle no logró producir un archivo .apk en MAUI Android"
description: "Nueve de cada diez veces el error real de Gradle está enterrado más arriba en el log de MSBuild. La ruta a JDK 17, el workload maui-android faltante y las rutas largas en Windows son las causas raíz habituales."
pubDate: 2026-05-15
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "android"
  - "gradle"
lang: "es"
translationOf: "2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android"
translatedBy: "claude"
translationDate: 2026-05-15
---

La solución: este error de MSBuild casi nunca es el error real. Desplaza el log de compilación hacia arriba pasando esta línea hasta llegar a la primera línea `error` de `gradlew.bat` o `aapt2`. Nueve de cada diez veces la causa real es una de tres cosas: `JAVA_HOME` apunta a JDK 11 (Android Gradle Plugin 8.x en MAUI 11 necesita JDK 17), el workload `android` o `maui-android` no se restauró tras una actualización del SDK de .NET, o una violación de ruta larga en Windows truncó la salida de R8 ofuscada. Corrige el error subyacente y el `.apk` se producirá en la siguiente compilación.

```text
C:\Program Files\dotnet\sdk\11.0.100\Sdks\Microsoft.NET.Sdk\targets\Microsoft.NET.RuntimeIdentifierInference.targets(311,5):
error XA1029: The Gradle build failed to produce an .apk file. Please check the diagnostic log.
```

Esta guía está escrita contra .NET 11 GA, el target framework `net11.0-android`, .NET MAUI 11.0.0, y el Android Gradle Plugin (AGP) incluido con `Xamarin.Android.Sdk` 35.x (la versión que Microsoft fija para `dotnet workload install android` en .NET 11). El código `XA1029` lo lanza `Xamarin.Android.Build.Tasks` después de que `gradlew assembleDebug` o `assembleRelease` salgan con un código distinto de cero. El texto "failed to produce an .apk file" es un envoltorio, no la causa.

## Por qué MAUI Android envuelve el error real de Gradle

MAUI no llama a Gradle directamente durante un `dotnet build` normal. El target de MSBuild específico de Android (`_CompileToDalvikWithD8`, `_GenerateAndroidPackage`) escribe un `build.gradle.kts` generado en `obj/Debug/net11.0-android/<rid>/android/`, y luego ejecuta el `gradlew.bat` (Windows) o `gradlew` (macOS, Linux) incluido. Cuando `gradlew` sale con un código distinto de cero, la tarea de MSBuild se traga el log de Gradle de varios miles de líneas en un único archivo de diagnóstico en `obj/Debug/net11.0-android/<rid>/android/build.log` y emite `XA1029`. Visual Studio sólo expone el envoltorio. La traza de pila real, la dependencia faltante, el rechazo del JDK o el fallo de firma están en `build.log` más las líneas inmediatamente arriba de `XA1029` en el panel de salida de MSBuild.

Trata `XA1029` como un HTTP 500: te dice que la compilación se rompió, no qué se rompió. El primer movimiento siempre es encontrar la línea real `> Task :` que falló.

## Leer el log de diagnóstico para encontrar la causa real

Desde una terminal en el directorio de tu proyecto, vuelve a ejecutar la compilación con el nivel de detalle que expone cada línea de Gradle:

```bash
# .NET 11 SDK, MAUI 11.0.0
dotnet build -t:Run -f net11.0-android \
  -p:AndroidPackageFormat=apk \
  -bl:msbuild.binlog \
  -v:diag
```

Luego abre `msbuild.binlog` en el [MSBuild Structured Log Viewer](https://msbuildlog.com/) y busca `FAILURE: Build failed`. La línea encima de él nombra la tarea de Gradle que falló: `:app:processDebugResources`, `:app:mergeDebugResources`, `:app:lintVitalReportRelease` o `:app:compileDebugJavaWithJavac` son los sospechosos habituales. Cada uno apunta a una categoría específica de solución más abajo.

Si el binlog está vacío para la fase de Gradle, significa que Gradle nunca arrancó, lo cual a su vez significa que la resolución de `JAVA_HOME` o la restauración del workload falló antes de que se ejecutara cualquier tarea. Salta a las secciones de JDK y workload.

## Causa 1: JAVA_HOME apunta al JDK incorrecto

Esta es la única causa más común tras una actualización del SDK de .NET. AGP 8.x, que se incluye con Xamarin.Android 35 (el predeterminado de .NET 11), se niega a arrancar bajo JDK 11 con este error dentro de `build.log`:

```text
> Task :app:checkKotlinGradlePluginConfigurationErrors
A problem occurred starting Gradle worker
> Could not resolve the Java toolchain '11'.
> Android Gradle plugin requires Java 17 to run. You are currently using Java 11.
```

La superficie correspondiente de MSBuild es `XA1029`. Microsoft documentó el mínimo de JDK para MAUI como Java 11 para la era .NET 6 a .NET 8, y luego Java 17 desde MAUI 9 en adelante, siguiendo el requisito de AGP en upstream. Consulta la incidencia de larga duración de MAUI [dotnet/maui#18906](https://github.com/dotnet/maui/issues/18906) para conocer la rotura original.

La solución es apuntar `JAVA_HOME` a una instalación de JDK 17. En una máquina Windows con Visual Studio 2026, el OpenJDK 17 incluido reside en `C:\Program Files\Microsoft\jdk-17.0.x-hotspot`. Configúralo de forma permanente:

```powershell
# PowerShell, as the same user that runs dotnet build
[Environment]::SetEnvironmentVariable(
  "JAVA_HOME",
  "C:\Program Files\Microsoft\jdk-17.0.12.7-hotspot",
  "User")
```

Luego reinicia el shell o, en CI, pasa también `-p:JavaSdkDirectory=...` en la línea de comandos de `dotnet build` para que MSBuild lo recoja sin depender del entorno heredado:

```bash
dotnet build -f net11.0-android \
  -p:JavaSdkDirectory="/usr/lib/jvm/temurin-17-jdk-amd64"
```

Puedes verificar qué JDK seleccionó realmente MSBuild buscando `JdkDirectory` en el binlog, o ejecutando `dotnet build -t:_ResolveAndroidTooling -v:diag | findstr Jdk`.

## Causa 2: workload maui-android o android faltante

La segunda causa más común: actualizaste el SDK de .NET en la máquina (o lo instalaste de cero en CI) y nunca restauraste los workloads. La tarea de MSBuild falla en `_GenerateAndroidPackage` porque el pack `Xamarin.Android.Sdk` que posee la integración de Gradle no está en disco. El envoltorio sigue siendo `XA1029`; el error real dentro de `build.log` es:

```text
> Task :app:processDebugResources FAILED
The 'aapt2' executable was not found at ...\Xamarin.Android.Sdk.x.x.x\tools\aapt2.exe
```

Restaura el workload fijado a la banda del SDK que tienes instalada:

```bash
# .NET 11 GA -- installs both the android pack and maui-android
dotnet workload install maui-android
dotnet workload restore
```

`dotnet workload restore` recorre cada `*.csproj` en el directorio actual, lee sus `TargetFrameworks` e instala los packs que cada target framework necesita. En CI ese es el único comando que vale la pena ejecutar porque es idempotente y está fijado a una versión. El `dotnet workload install maui-android` independiente es la opción correcta en una máquina de desarrollo recién creada. Microsoft documenta la separación de workloads en [Install workloads with dotnet workload install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-workload-install).

Si instalaste MAUI a través del instalador de Visual Studio 2026 y luego también ejecutaste `dotnet workload install maui` desde la CLI, puedes terminar en un estado donde Visual Studio no puede localizar ninguna de las dos copias. La documentación de solución de problemas de MAUI describe la [secuencia completa de desinstalación y reinstalación](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting), que es más trabajo de lo que parece pero es la única recuperación fiable de un estado de workload dividido.

## Causa 3: violación de ruta larga en Windows en la salida obj

La tercera causa recurrente es puramente un artefacto de Windows. R8 y `aapt2` ambos escriben rutas ofuscadas profundamente anidadas en `obj\Debug\net11.0-android\android\app\build\intermediates\`. Para un proyecto en `C:\src\MyCompany\MyProduct\Mobile\MyProduct.Mobile.csproj` la ruta completa de un archivo `.dex` intermedio rutinariamente excede el límite legado `MAX_PATH` de 260 caracteres. El worker de Gradle lo reporta como:

```text
> Task :app:mergeExtDexDebug FAILED
java.io.IOException: Cannot delete '...\transforms\...\classes.dex' (path too long)
```

Dos soluciones, en orden de preferencia:

1. Mueve el repositorio a una raíz más corta: `C:\src\Mobile\` en lugar de `C:\Users\you\source\repos\MyCompany\Mobile\`.
2. Habilita el soporte de rutas largas en todo el sistema operativo, el SDK de .NET y Git. Como PowerShell de Administrador:

   ```powershell
   New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
     -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
   git config --system core.longpaths true
   ```

   Luego añadir `<UseAppHost>false</UseAppHost>` no es la solución aquí; lo que realmente necesitas es la entrada del manifiesto. Edita tu `.csproj` para establecer `<EnableLongPaths>true</EnableLongPaths>` (Xamarin.Android 35+) y asegúrate de que el `app.manifest` de tu proyecto declare `longPathAware`. El lado de Android de la compilación recoge el flag del SO una vez que cierras sesión y vuelves a entrar.

La primera opción es más rápida y funciona en todas las máquinas sin permisos de administrador. Tómala a menos que la ruta de tu repositorio esté fijada por política.

## Causa 4: lintVitalRelease falla solo en una compilación Release

Si `dotnet build -c Debug` tiene éxito y `dotnet publish -c Release -f net11.0-android` falla con `XA1029`, la tarea de Gradle que murió es `:app:lintVitalReportRelease`. AGP 8 ascendió los fallos de lint de avisos a errores de compilación para configuraciones Release. Verás esto en `build.log`:

```text
> Task :app:lintVitalReportRelease FAILED
Lint found errors in the project; aborting build.
```

La solución correcta es leer el reporte de lint en `obj/Release/net11.0-android/android/app/build/reports/lint-results-release.html` y abordar los problemas reales (traducciones faltantes, cadenas hardcodeadas en etiquetas `<application>`, APIs de Android obsoletas que apuntan a `compileSdkVersion 35`).

La solución incorrecta pero tentadora es suprimir lint:

```xml
<!-- .csproj, .NET 11, MAUI 11 -- escape hatch only -->
<PropertyGroup Condition="'$(Configuration)' == 'Release'">
  <AndroidLintAbortOnError>false</AndroidLintAbortOnError>
</PropertyGroup>
```

Úsalo solo como un desbloqueo táctico para una versión que tiene que enviarse hoy. Los hallazgos de lint sobre declaraciones `android:exported` faltantes son bugs reales en Android 31+ y eventualmente harán crashear la app al lanzarse.

## Causa 5: keystore faltante o incorrecto para compilaciones Release firmadas

Una compilación Release firmada añade `:app:signReleaseBundle` a la lista de tareas. Si la ruta del keystore se resuelve a nada, AGP falla con:

```text
> Task :app:signReleaseBundle FAILED
Keystore file '/Users/runner/work/_temp/myapp.keystore' not found for signing config 'release'.
```

En una máquina de desarrollador esto significa que tu propiedad de MSBuild `<AndroidSigningKeyStore>` apunta a un archivo que no existe para el usuario actual. En CI normalmente significa que el secreto que contiene el keystore codificado en base64 no se decodificó en la ruta a la que hace referencia el `csproj`. La invocación mínima correcta de CI:

```bash
# .NET 11, MAUI 11 -- GitHub Actions
echo "$ANDROID_KEYSTORE_BASE64" | base64 --decode > $RUNNER_TEMP/release.keystore
dotnet publish src/MyApp/MyApp.csproj \
  -f net11.0-android \
  -c Release \
  -p:AndroidPackageFormat=apk \
  -p:AndroidKeyStore=true \
  -p:AndroidSigningKeyStore=$RUNNER_TEMP/release.keystore \
  -p:AndroidSigningStorePass=$ANDROID_KEYSTORE_PASS \
  -p:AndroidSigningKeyAlias=$ANDROID_KEY_ALIAS \
  -p:AndroidSigningKeyPass=$ANDROID_KEY_PASS
```

Las cuatro propiedades `AndroidSigning*` son obligatorias juntas. Configurar solo tres de ellas falla con el mismo `XA1029` y una línea de tarea de Gradle diferente. Microsoft documenta los nombres de las propiedades en [Publish a .NET MAUI app for Android](https://learn.microsoft.com/en-us/dotnet/maui/android/deployment/publish-cli).

## Causa 6: daemon de Gradle corrupto o caché .gradle obsoleta

Tras una larga cadena de compilaciones fallidas, el caché de Gradle a nivel de usuario en `~/.gradle/caches/` puede aterrizar en un estado donde cada compilación posterior falla con un `XA1029` genérico y un `build.log` quejándose sobre archivos de bloqueo. Borra el caché y la distribución de Gradle a nivel de workload:

```bash
# kills the daemon, deletes the cache, deletes the user gradle wrapper distribution
gradle --stop 2>/dev/null
rm -rf ~/.gradle/caches/ ~/.gradle/daemon/
rm -rf ~/.gradle/wrapper/dists/
```

En Windows el equivalente es `Remove-Item -Recurse -Force "$env:USERPROFILE\.gradle\caches"`. La siguiente compilación volverá a descargar la distribución de AGP (alrededor de 200 MB) y rehidratará el grafo de dependencias; toma de 5 a 10 minutos la primera vez y es rápido después de eso.

Esta es la solución correcta para "funcionaba ayer y nada cambió". Es la solución incorrecta cuando puedes nombrar qué cambió (una actualización de workload, un cambio de JDK, un nuevo paquete NuGet); persigue la causa primero.

## Detalles y errores parecidos

- `XA0119: Could not find android.jar for API level 35` es un error hermano de la misma etapa. Siempre es una instalación faltante de `android-sdk;platforms;android-35`, no un problema de Gradle. Ejecuta `androidsdkmanager --install platforms;android-35`.
- `error : Java.Interop.Tools.Diagnostics.XamarinAndroidException: Output directory does not exist` también es de `Xamarin.Android.Build.Tasks` pero más temprano en la tubería. Normalmente significa que `obj/` es de solo lectura porque Defender puso un archivo en cuarentena. Comprueba `Get-Acl obj` y el log de cuarentena de Defender.
- `MSB6006: "java.exe" exited with code 1` desde la fase del linker tiene un nombre engañoso: es `R8` minification fallando en una clase que no puede rastrear. Añade una regla de ProGuard y vuelve a intentarlo. Consulta el desglose en [una publicación reciente sobre el ajuste de cold-start](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) para los mecanismos subyacentes; los mismos contratos de trim/AOT aplican en Android.
- "Build SUCCESS" sin un `.apk` en `bin/` ocurre cuando `<AndroidPackageFormat>aab</AndroidPackageFormat>` está configurado en un `Directory.Build.props` padre. La compilación produce un `.aab` (App Bundle) en su lugar, que es lo que la Play Store realmente quiere. El texto `XA1029` dice ".apk" solo porque es el predeterminado histórico; la verificación subyacente es "¿escribió el paso de empaquetado su archivo de salida esperado?"

## Relacionado

- [Cómo empaquetar una app de MAUI para la Microsoft Store](/es/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) recorre el lado de Windows de la misma tubería de publicación.
- [.NET 11 preview 4: dotnet watch finalmente aterriza para MAUI Android e iOS](/es/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/) cubre las herramientas del bucle interno que se ejecutan sobre el mismo arnés de Gradle.
- [MAUI en .NET 11 preview 4 hace de CoreCLR el predeterminado para Android e iOS](/es/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) explica por qué el cambio de runtime movió algunas reglas de lint de avisos a errores en compilaciones Release.
- [Cómo migrar un Xamarin.Forms ListView de alto rendimiento a MAUI CollectionView](/es/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) es la razón más común por la que un proyecto que se compilaba bien en Xamarin empieza a chocar con `XA1029` tras la migración a MAUI.

## Fuentes

- [Troubleshoot known issues in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting), Microsoft Learn, .NET MAUI 11.
- [dotnet/maui#18906: GitHub Actions no longer builds MAUI Android: Java SDK 11.0 or above is required](https://github.com/dotnet/maui/issues/18906), la incidencia canónica que rastrea el cambio del requisito de JDK.
- [dotnet/maui Discussion #24164: Cannot build apk in Release](https://github.com/dotnet/maui/discussions/24164), hilo comunitario que enumera causas de `XA1029` exclusivas de Release.
- [Publish a .NET MAUI app for Android with the CLI](https://learn.microsoft.com/en-us/dotnet/maui/android/deployment/publish-cli), la fuente de verdad para las propiedades de MSBuild `AndroidSigning*`.
- [Java versions in Android builds](https://developer.android.com/build/jdks), documentación del equipo de Android sobre el mínimo de JDK por versión de AGP.
- [Install workloads with dotnet workload install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-workload-install), la semántica de instalación / restauración de workloads referenciada arriba.
