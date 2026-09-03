---
title: "Migra una app Android de .NET MAUI de Mono a CoreCLR en .NET 11"
description: "Una migración paso a paso de Mono a CoreCLR para .NET MAUI en Android: el piso de API 24, las propiedades de MSBuild exclusivas de Mono que ahora rompen tu compilación, por qué creció tu APK, cómo perfilar la regresión de arranque con dotnet-dsrouter y dotnet-trace, y cómo es realmente una reversión ahora que la ruta de Mono desapareció."
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "dotnet-11"
  - "maui"
  - "android"
  - "coreclr"
  - "mono"
lang: "es"
translationOf: "2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-03
---

Para una app pequeña, esta migración es un cambio de `TargetFramework`, un cambio de `android:minSdkVersion` y una tarde de mediciones. Para una grande, calcula una semana, y espera que toda la semana se vaya en dos cosas: eliminar propiedades de MSBuild de la era de Mono que ahora no hacen nada o rompen activamente la compilación, y perseguir una regresión de arranque que no tiene nada que ver con tu código. La recompensa es real (diagnóstico unificado, JIT por niveles, PGO dinámico, un camino plausible hacia Native AOT en Android), pero la lectura honesta es que esto no es opcional. Desde [.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), Microsoft ya no expone una ruta separada de Mono para Android, iOS ni Mac Catalyst. Esta guía apunta a .NET 11 Preview 7 (`11.0.100-preview.7`, publicado el 2026-08-11) con .NET MAUI `11.0.0-preview.7`, migrando desde .NET 10 con Mono. La versión final de .NET 11 está programada para el 2026-11-10.

## Por qué vale la pena más allá de "no tienes alternativa"

- **Tu perfilador por fin funciona.** `dotnet-trace` y `dotnet-counters` ahora se conectan a una app Android en ejecución igual que se conectan a un proceso de ASP.NET Core, a través de `dotnet-dsrouter`. Se acabó el dialecto de trazas específico de Mono.
- **La compilación por niveles y el PGO dinámico llegan al teléfono.** Mono AOT compilaba una vez en tiempo de compilación y ahí terminaba la historia de la optimización. CoreCLR instrumenta en Tier 0 y recompila los métodos calientes en Tier 1 con datos de perfil reales, así que el rendimiento en régimen permanente de una app de larga vida mejora sin que cambies nada.
- **ReadyToRun reemplaza a Mono AOT como mecanismo de arranque.** En Android, MAUI usa por defecto R2R *compuesto parcial* para las compilaciones Release con CoreCLR, guiado por perfiles `.mibc` que vienen en el workload. Solo se precompilan los métodos que el perfil considera importantes, que es lo que evita que la sobrecarga de tamaño sea catastrófica.
- **Un runtime, un rastreador de errores.** Un fallo de `System.Text.Json` o de `HttpClient` en Android ahora es el mismo fallo que en el servidor, y se corrige en el mismo lugar.

## Qué se rompe

| Área | Cambio | Severidad |
| --- | --- | --- |
| API mínima de Android | Sube de 21 (Android 5.0) a 24 (Android 7.0) | alta |
| ABIs de Android | Android x86 (32 bits) no está soportado con CoreCLR | alta |
| Propiedades de Mono AOT | `RunAOTCompilation`, `AndroidAotMode`, `UseInterpreter` son exclusivas de Mono; `RunAOTCompilation=true` todavía puede invocar `MonoAOTCompiler` y romper la compilación | alta |
| Tiempo de arranque | Apps grandes han reportado regresiones de varios segundos y ANRs | alta (según el caso) |
| Tamaño del APK | Las imágenes R2R viven dentro de tus archivos `.dll`, así que los ensamblados crecen | media |
| Paquetes NuGet | `NU1703` cuando un paquete resuelve activos de `MonoAndroid` en vez de `net6.0-android` o posterior | media |
| Recursos heredados | `XA0149` para recursos heredados de Xamarin.Android incrustados en una dependencia | baja |
| `Microsoft.Maui.Controls.Compatibility` | Paquete eliminado en Preview 6 | media (solo si lo referencias) |
| Errores HTTP | Los fallos de transporte de `AndroidMessageHandler` lanzan `HttpRequestException` en vez de `WebException` | baja |
| Incrustación del runtime | Las APIs de incrustación de Android no se llevan a CoreCLR | alta (si las usas) |

El piso de nivel de API es el que llega a tus usuarios. Según el [aviso de cambio importante](https://learn.microsoft.com/en-us/dotnet/core/compatibility/maui/11/android-minimum-api-level), las apps compiladas con .NET 11 no se pueden instalar ni ejecutar en API 21, 22 o 23. Revisa tus números de distribución en Play Console antes de empezar, porque esta es una decisión sobre usuarios, no un ajuste de compilación.

## Lista de verificación previa

- SDK de .NET 11 `11.0.100-preview.7` o posterior, con el workload `maui-android` instalado.
- `$ANDROID_HOME` apuntando a una ruta válida del SDK de Android. `dotnet-dsrouter` usa `adb` desde ahí para configurar el reenvío de puertos, y no lo encontrará de forma fiable de otro modo.
- Las herramientas de diagnóstico instaladas globalmente: `dotnet tool install --global dotnet-dsrouter`, `dotnet-trace`, `dotnet-counters`.
- Una **línea base numérica capturada en .NET 10 con Mono, antes de cambiar nada.** Este es el paso que todos se saltan y luego lamentan, porque "se siente más lento" no es algo que puedas bisecar.
- Un dispositivo real, no solo el emulador. Las regresiones reportadas son regresiones de arranque, y los tiempos de arranque del emulador no son representativos.

## Pasos de la migración

1. **Captura la línea base de Mono.** En tu compilación Release actual de .NET 10, instala el APK y mide el arranque en frío con el gestor de actividades de Android, que reporta `TotalTime` en milisegundos:

   ```console
   # .NET 10, Mono, Release
   adb shell am force-stop com.example.myapp
   adb shell am start -W -n com.example.myapp/crc64...MainActivity
   ```

   Ejecútalo cinco veces, descarta la primera y anota la mediana. Anota también el tamaño del APK o AAB de Release. **Verifica:** tienes dos números escritos en algún lugar que no sea el historial de tu terminal.

2. **Mueve el target framework y el piso de API juntos.** Ambos cambios, en un mismo commit, porque CoreCLR en Android requiere API 24:

   ```xml
   <!-- .NET 11 Preview 7, MAUI 11.0.0-preview.7 -->
   <PropertyGroup>
     <TargetFrameworks>net11.0-android;net11.0-ios;net11.0-maccatalyst</TargetFrameworks>
     <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">24.0</SupportedOSPlatformVersion>
   </PropertyGroup>
   ```

   Si defines `android:minSdkVersion` a mano en `Platforms/Android/AndroidManifest.xml`, súbelo a `24` para que el manifiesto y el proyecto coincidan. **Verifica:** `dotnet build -f net11.0-android -c Release` tiene éxito y el manifiesto generado muestra `minSdkVersion="24"`.

3. **Elimina o condiciona cada propiedad de MSBuild exclusiva de Mono.** Busca en tu `.csproj`, `Directory.Build.props` y en cualquier propiedad inyectada por CI: `RunAOTCompilation`, `AndroidAotMode`, `AndroidEnableProfiledAot`, `UseInterpreter` y `UseMonoRuntime`. Dejar `RunAOTCompilation=true` en un `Directory.Build.props` es un fallo de compilación conocido: el target `MonoAOTCompiler` sigue ejecutándose aunque la app esté sobre CoreCLR ([dotnet/android#11068](https://github.com/dotnet/android/issues/11068)). Elimínalas directamente o, si todavía compilas un TFM antiguo en paralelo, condiciónalas:

   ```xml
   <PropertyGroup Condition="'$(UseMonoRuntime)' == 'true'">
     <RunAOTCompilation>true</RunAOTCompilation>
     <AndroidEnableProfiledAot>true</AndroidEnableProfiledAot>
   </PropertyGroup>
   ```

   **Verifica:** `dotnet build -f net11.0-android -c Release -bl` y luego busca `MonoAOTCompiler` en el log binario. Cero coincidencias es la condición de aprobación.

4. **Limpia la lista de ABIs y las advertencias de paquetes.** Quita `x86` de `RuntimeIdentifiers` si todavía está ahí, porque CoreCLR no lo distribuye:

   ```xml
   <RuntimeIdentifiers>android-arm64;android-x64</RuntimeIdentifiers>
   ```

   Luego encárgate de `NU1703`. Introducida en Preview 5, se dispara cuando un paquete resuelve activos de la carpeta obsoleta `MonoAndroid`: "Package 'PackageName' 1.0.0 uses the deprecated MonoAndroid framework instead of 'net6.0-android' or later." Actualiza el paquete si existe una versión moderna. Si no existe, has encontrado una dependencia de la era de Xamarin que vive de prestado, y suprimir la advertencia es una decisión de cargar con ese riesgo, no una solución. **Verifica:** `dotnet restore` está limpio, o cada `NU1703` restante corresponde a un paquete que has triado conscientemente.

5. **Recompila en Release y vuelve a medir contra el paso 1.** Mismo dispositivo, mismo procedimiento, mismo número de ejecuciones:

   ```console
   # .NET 11 Preview 7, CoreCLR, Release
   dotnet publish -f net11.0-android -c Release
   adb install -r bin/Release/net11.0-android/publish/com.example.myapp-Signed.apk
   adb shell am force-stop com.example.myapp
   adb shell am start -W -n com.example.myapp/crc64...MainActivity
   ```

   La posición oficial de Microsoft es que Android queda "dentro del 10 por ciento de Mono en arranque y tamaño de app" para una app de plantilla base. **Verifica:** si estás dentro de esa banda, terminaste el trabajo de rendimiento. Si estás 2x o peor, ve al paso 6 en vez de empezar a alternar propiedades de MSBuild al azar.

6. **Perfila la regresión en vez de adivinar.** Añade un archivo `app.env` junto al `.csproj` con `DOTNET_DiagnosticPorts=127.0.0.1:9000,suspend` y referéncialo condicionalmente:

   ```xml
   <ItemGroup Condition="'$(AndroidEnableProfiler)'=='true'">
     <AndroidEnvironment Include="app.env" />
   </ItemGroup>
   ```

   Arranca el router, compila con el perfilador habilitado, lanza la app y luego conéctate:

   ```console
   dotnet-dsrouter server-server -ipcs ~/mylocalport -tcps 127.0.0.1:9000 --forward-port Android &
   dotnet build -f net11.0-android -c Release -t:Run /p:AndroidEnableProfiler=true
   dotnet-trace collect --diagnostic-port ~/mylocalport,connect
   ```

   Como el puerto se configuró con `suspend`, el runtime se bloquea al arrancar hasta que `dotnet-trace` se conecta, que es exactamente lo que necesitas para ver la ruta de arranque y no todo lo posterior. En Windows, usa `mylocalport` en vez de `~/mylocalport`, ya que el canal IPC es una tubería con nombre. **Verifica:** tienes un archivo `.nettrace` con una ventana de arranque poblada y puedes nombrar los tres métodos con mayor tiempo inclusivo.

7. **Ajusta solo lo que la traza justifique.** Si el problema es el tamaño de los ensamblados, R2R es la primera perilla, porque las imágenes R2R van empaquetadas dentro de los archivos `.dll` y por eso crecieron tus ensamblados:

   ```xml
   <PropertyGroup Condition="'$(Configuration)' == 'Release'">
     <PublishReadyToRun>false</PublishReadyToRun>  <!-- smaller APK, slower startup -->
     <TrimMode>full</TrimMode>                     <!-- default is partial -->
   </PropertyGroup>
   ```

   Estas tiran en direcciones opuestas: apagar R2R cambia arranque por tamaño, y `TrimMode=full` recupera tamaño pero ahora recorta tu propio código y tus referencias de NuGet, así que necesita una pasada completa de regresión. Cambia una a la vez y vuelve a ejecutar el paso 5 entre cada una. **Verifica:** cada perilla está justificada por un delta medido que puedes citar, no por una entrada de blog.

8. **Despliega por fases.** Publica primero a un canal interno y vigila específicamente la tasa de ANR, no solo la de fallos. El modo de fallo reportado de CoreCLR en apps grandes es un arranque que dura lo suficiente como para que Android mate el proceso, lo que aparece como ANRs y no como excepciones. **Verifica:** la tasa de ANR en Play Console tras una semana de pruebas internas es plana respecto a tu compilación con Mono.

## Lista de verificación posterior

- `dotnet build -f net11.0-android -c Release` no produce ninguna invocación de `MonoAOTCompiler` en el log binario.
- La mediana de arranque en frío en un dispositivo real está dentro de la banda aceptada respecto a la línea base de .NET 10.
- El delta de tamaño de APK/AAB está registrado y aceptado.
- La suite de pruebas completa pasa, incluidas las pruebas que tocan reflexión, rutas de error de `HttpClient` o serialización.
- Hot Reload funciona. En CoreCLR esto pasa por Edit and Continue en vez de por el intérprete de Mono, así que es una ruta de código genuinamente distinta de la que probaste en la última versión.
- No hay dispositivos con API 21-23 en tu base de instalaciones activa, o ya has comunicado el corte.

## Plan de reversión

Dilo en voz alta: **ya no existe una reversión a nivel de runtime.** `<UseMonoRuntime>true</UseMonoRuntime>` se documentó como la vía de escape cuando CoreCLR pasó a ser el valor por defecto en Preview 4, y entonces se presentó como un desbloqueo temporal mientras reportabas una regresión. Preview 6 eliminó la ruta separada de Mono para Android, iOS y Mac Catalyst. Trata la propiedad como desaparecida y no construyas un plan de lanzamiento a su alrededor.

Tu reversión real es el target framework: mantén verde la compilación `net10.0-android` en una rama hasta que la compilación de .NET 11 haya sobrevivido a un despliegue real en producción. Eso es una reversión más pesada que cambiar una propiedad, que es precisamente por qué existen los pasos 1 y 5.

## Trampas que cuestan tiempo real

**La regresión de arranque es real y no está distribuida uniformemente.** Dos issues documentan el modo de fallo: [dotnet/android#10588](https://github.com/dotnet/android/issues/10588) reporta que "an app that takes 1s to launch on mono can take 6s on coreclr", con ANRs en `ControlCatalog.Android` de Avalonia, y [dotnet/android#10914](https://github.com/dotnet/android/issues/10914) reporta aproximadamente de 1,0 s a 6,0 s de arranque en frío y un crecimiento del APK de 21 MB a 38 MB en `11.0.100-preview.2`. Ambos son de Avalonia y no de MAUI, y ambos son anteriores al trabajo de R2R compuesto parcial y de perfiles MIBC que llegó más tarde en el ciclo de preview, así que no los leas como tu resultado esperado. Léelos como la razón por la que el paso 1 es obligatorio.

**Las rutas de arranque cargadas de XAML son las que duelen.** El hilo común en los reportes es la reflexión y el análisis de XAML durante la inicialización, que es exactamente el trabajo que R2R parcial no puede precompilar si el perfil `.mibc` distribuido no cubre la forma de tu app. Si tu app construye un árbol visual grande antes del primer frame, ahí es donde hay que mirar primero.

**`UseInterpreter` deja de importar en silencio.** Estaba en `true` por defecto en Debug con Mono, y es lo que hacía funcionar el Hot Reload de la era de Mono. En CoreCLR es inerte. Si lo tenías activado por una razón (una ruta de código dinámica que Mono AOT no podía manejar), esa razón no ha desaparecido, solo se ha movido: CoreCLR en Android ejecuta un JIT real en Debug, así que el código funcionará, pero vuelve a probarlo deliberadamente en vez de asumirlo.

**El contenido de tu APK cambia de forma.** Con Mono distribuías `libmonosgen-2.0.so` más imágenes `libaot-*.dll.so`. Con CoreCLR distribuyes `libcoreclr.so`, `libclrjit.so`, `libmonodroid.so` (el pegamento de Android conserva su nombre de la era de Mono) y un único `libassemblies.arm64-v8a.so` que contiene MSIL comprimido con imágenes R2R. Si tienes scripts de compilación, presupuestos de tamaño o configuración de ProGuard/R8 que nombren esos archivos, hay que actualizarlos.

**El tamaño está realmente en el recorte.** MAUI todavía usa `TrimMode=partial` por defecto, que recorta los ensamblados del framework pero deja intactos tu código y tus referencias de NuGet. La mayoría de las quejas de tamaño se convierten en quejas de recorte en cuanto miras el desglose por ensamblado.

## Relacionados

- El cambio de runtime se anunció cuando [MAUI hizo de CoreCLR el valor por defecto en Android, iOS y Mac Catalyst en Preview 4](/es/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), que es de donde salió la propiedad de exclusión.
- La vía de escape se cerró dos meses después, cuando [MAUI en móvil pasó a ser solo CoreCLR en Preview 6](/es/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/).
- Si todavía estás en la pila antigua, la migración previa es [de Xamarin.Forms a MAUI 11](/es/2026/05/migrate-from-xamarin-forms-to-maui-11/), no esta.
- El compromiso entre R2R y Mono AOT del paso 7 se cubre en profundidad en [Native AOT vs ReadyToRun vs JIT en .NET 11](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), y el objetivo final que CoreCLR desbloquea en Android se describe en [qué te cuesta realmente Native AOT](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/).
- Si `TrimMode=full` del paso 7 rompe tu serialización, el fallo se ve como [reflection-based serialization has been disabled for this application](/es/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/).
- Cambiar la lista de ABIs distribuidas en el paso 4 puede producir [el fallo de instalación "doesn't support required ABI"](/es/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/) en dispositivos a los que antes servías.

## Fuentes

- [.NET MAUI Moves to CoreCLR in .NET 11](https://devblogs.microsoft.com/dotnet/dotnet-maui-moves-to-coreclr-in-dotnet-11/), el blog de .NET
- [CoreCLR Progress and the Mono Timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), el blog de .NET
- [Runtimes and compilation in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/deployment/runtimes-compilation), Microsoft Learn
- [Breaking change: Minimum Android API level raised to 24](https://learn.microsoft.com/en-us/dotnet/core/compatibility/maui/11/android-minimum-api-level), Microsoft Learn
- [Breaking change: NU1703 warning for packages that use deprecated MonoAndroid framework assets](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/11/nu1703-deprecated-monoandroid-framework), Microsoft Learn
- [dotnet-dsrouter](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dsrouter), Microsoft Learn
- [dotnet/maui#33386, el epic de seguimiento de CoreCLR en Android](https://github.com/dotnet/maui/issues/33386)
- [dotnet/android#10588, ANR while running large app](https://github.com/dotnet/android/issues/10588)
- [dotnet/android#11068, RunAOTCompilation runs MonoAOTCompiler under CoreCLR](https://github.com/dotnet/android/issues/11068)
