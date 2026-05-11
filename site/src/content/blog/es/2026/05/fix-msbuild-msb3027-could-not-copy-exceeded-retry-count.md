---
title: "Fix: MSB3027 Could not copy X to Y. Exceeded retry count of 10. Failed"
description: "MSB3027 significa que MSBuild reintentó copiar un archivo 10 veces y un proceso seguía reteniendo el destino. Mata el proceso bloqueante, excluye bin/obj del antivirus o sube CopyRetryCount."
pubDate: 2026-05-11
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "csproj"
lang: "es"
translationOf: "2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count"
translatedBy: "claude"
translationDate: 2026-05-11
---

La solución: la tarea `Copy` de MSBuild intentó diez veces, con pausas de un segundo, sobrescribir un archivo en tu directorio `bin/` y un proceso seguía reteniendo un handle sobre él. Localiza al proceso responsable con `handle.exe` o el Monitor de recursos, mátalo y vuelve a compilar. En Windows, ese proceso casi siempre es la ejecución anterior de tu propio programa (`apphost.exe`, `MyApp.exe`, un worker de IIS Express o un hijo de `dotnet watch`), el build-server `MSBuild.exe` que sigue residente bajo Visual Studio, o un antivirus en tiempo real que abrió la DLL recién producida para inspeccionarla unos milisegundos antes de que MSBuild intentara sobrescribirla. Si no puedes corregir el origen del bloqueo, sube `CopyRetryCount` y `CopyRetryDelayMilliseconds` en `Directory.Build.props` y sigue adelante.

```text
error MSB3027: Could not copy "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". Exceeded retry count of 10. Failed. The file is locked by: ".NET Host (4176)"  [C:\src\MyApp\MyApp.csproj]
error MSB3021: Unable to copy file "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". The process cannot access the file 'C:\src\MyApp\bin\Debug\net11.0\MyApp.dll' because it is being used by another process.
```

Este artículo está escrito contra .NET SDK 11.0.100-preview.4, MSBuild 17.13 y Visual Studio 17.14. La tarea `Copy` y la cadena del mensaje MSB3027 han sido estables desde MSBuild 15 (Visual Studio 2017), así que la misma lista aplica a cualquier proyecto SDK-style moderno, desde `net6.0` hasta `net11.0`. Lo que cambió recientemente es el comportamiento de reintentos: entre el SDK 7.0.306 y el 7.0.400 se endureció la ruta de reintento sobre algunas subclases de `IOException`, y por eso fallos de CI que antes eran invisibles (el reintento tenía éxito) ahora afloran como MSB3027.

## Qué significa realmente MSB3027

`MSB3027` lo lanza la tarea `Copy` de MSBuild al final de su bucle de reintentos. La tarea se conecta mediante los targets estándar `_CopyFilesMarkedCopyLocal` y `CopyFilesToOutputDirectory` dentro de `Microsoft.Common.CurrentVersion.targets`, que se disparan al final de cada `dotnet build`. El bucle se gobierna con dos propiedades:

- `CopyRetryCount` por defecto vale `10`. La tarea falla tras tantos fallos consecutivos.
- `CopyRetryDelayMilliseconds` por defecto vale `1000`. La tarea duerme ese tiempo entre reintentos.

Así que la ventana completa de diez reintentos es de unos diez segundos. Si un proceso retiene el archivo de destino durante más de diez segundos, se dispara MSB3027. MSBuild imprime la excepción interna (`System.IO.IOException`) en la línea siguiente como `MSB3021`, y por eso los dos códigos de error casi siempre van juntos.

La entrada de Microsoft Learn para [MSB3027](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb3027) nombra las cuatro causas canónicas: otro programa retiene el archivo, tu cuenta no puede escribir el destino, no hay espacio en la unidad o el recurso de red se cayó. En la práctica, en una estación de trabajo de desarrollo, la primera causa explica más del 95 por ciento del tráfico.

## Por qué ocurre (en orden de prioridad)

Estas son las siete causas recurrentes, ordenadas por la frecuencia con la que explican el fallo en un proyecto real de .NET 11.

1. **La ejecución anterior de tu propio programa sigue viva.** Las aplicaciones de consola bloqueadas en `Console.ReadKey`, los workers `IHostedService` de dotnet esperando una parada limpia y los procesos huérfanos `apphost.exe` de una sesión de depuración caída mantienen un bloqueo de archivo sobre el ejecutable principal. El mensaje de error nombra al proceso directamente, por ejemplo `The file is locked by: ".NET Host (4176)"`.
2. **IIS Express o el pool de aplicaciones de Kestrel retiene el ensamblado.** `dotnet run`, `iisexpress.exe` y el proceso worker de IIS (`w3wp.exe`) mantienen un read share exclusivo sobre la DLL cargada. Una compilación iniciada desde Visual Studio mientras la sesión F5 anterior sigue corriendo cae en esto siempre.
3. **`dotnet watch` está a mitad de un rebuild.** Hot reload intercambia ensamblados en vivo, pero ante un rude edit dispara un reinicio completo y existe una pequeña ventana donde el proceso viejo y el build nuevo tocan el mismo archivo. Los proyectos con muchos generadores de código fuente lo amplifican porque la DLL de salida del generador se copia dos veces. El SDK de dotnet sigue este problema en [dotnet/sdk#40911](https://github.com/dotnet/sdk/issues/40911) desde la época de .NET 8.
4. **El antivirus en tiempo real escaneó el archivo justo cuando MSBuild lo escribió.** Windows Defender, CrowdStrike Falcon, SentinelOne y similares abren cada nuevo `.exe` y `.dll` para inspección. El escaneo termina en unos cientos de milisegundos, pero si el siguiente proyecto en una compilación paralela necesita copiar ese mismo archivo, la copia puede correr contra el escáner. Las exclusiones de Defender para la raíz del repositorio eliminan todo este modo de fallo.
5. **OneDrive u otro cliente de sincronización abrió el archivo.** La función "Files On-Demand" de OneDrive abre un handle de escritura sobre cualquier archivo bajo una carpeta sincronizada cuando deshidrata o rehidrata contenido. Si tu árbol de código vive bajo `C:\Users\<tú>\OneDrive\...`, esto dispara MSB3027 de forma aleatoria durante compilaciones largas.
6. **El build server de MSBuild (o VS BuildHost) sigue conectado.** Con `MSBUILDDISABLENODEREUSE=0` (el valor por defecto), MSBuild mantiene nodos `MSBuild.exe` vivos entre compilaciones. Dentro de Visual Studio el equivalente son `VBCSCompiler.exe` y el build server de Roslyn. Casi nunca retienen targets de copia, pero un nodo colgado puede inmovilizar un ensamblado recién compilado.
7. **Proyectos en paralelo de una misma solución copian el mismo archivo al mismo instante.** Dos proyectos en el mismo `.sln` que dependen de una biblioteca compartida intentan copiarla cada uno a su propia salida. Con paralelismo `/m`, la segunda copia puede toparse con MSB3021 en `OpenWrite` y agotar el presupuesto de reintentos. Esto regresó en el SDK 7.0.400 y se sigue en [dotnet/msbuild#9169](https://github.com/dotnet/msbuild/issues/9169).

## Reproducción mínima: una app de consola que retiene su propio binario abierto

El reproductor más pequeño es una app de consola que no termina. Guarda esto como `MyApp/Program.cs` y `MyApp/MyApp.csproj`:

```xml
<!-- MyApp.csproj - .NET 11 preview 4 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// Program.cs - .NET 11, C# 14
Console.WriteLine("running, press any key to exit");
Console.ReadKey();
```

Arráncala en una terminal:

```text
dotnet run
```

Después cambia `Program.cs` (añade un espacio) y desde una segunda terminal:

```text
dotnet build
```

La segunda compilación imprime:

```text
error MSB3021: Unable to copy file "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". The process cannot access the file because it is being used by another process.
error MSB3027: Could not copy "obj\Debug\net11.0\MyApp.dll" to "bin\Debug\net11.0\MyApp.dll". Exceeded retry count of 10. Failed.
```

Este es el caso canónico. La primera terminal posee la DLL porque el host de .NET la abrió con `FILE_SHARE_READ` solamente, lo que excluye las escrituras.

## La solución, en detalle

### 1. Encuentra el proceso que retiene el archivo y mátalo

El mensaje de error tras `MSB3027` lista el proceso cuando MSBuild puede resolverlo. Cuando no puede (típicamente dentro de contenedores o en máquinas restringidas), recurre a una de estas opciones:

```text
:: sysinternals handle.exe - https://learn.microsoft.com/sysinternals/downloads/handle
handle64.exe -nobanner -accepteula C:\src\MyApp\bin\Debug\net11.0\MyApp.dll
```

```powershell
# Get-Process by module path (PowerShell 7.4+)
Get-Process | Where-Object { $_.Modules.FileName -contains 'C:\src\MyApp\bin\Debug\net11.0\MyApp.dll' }
```

```text
:: Kill by image name
taskkill /im MyApp.exe /f
:: Or by PID from handle.exe output
taskkill /pid 4176 /f
```

Para IIS Express: clic derecho en el icono de la bandeja del sistema y `Exit All`, o `iisexpress /stop /siteid:<id>`. Para IIS completo, un `iisreset` es la opción contundente; un `Stop-WebAppPool -Name "<pool>"` es la quirúrgica.

### 2. Deja de ejecutar el programa desde la misma terminal en la que compilas

La solución más limpia es de flujo de trabajo: no dejes una sesión de depuración pegada mientras recompilas. En Visual Studio, las rutas `Edit and Continue` y `Hot Reload` suelen encargarse de esto por ti. Desde línea de comandos, prefiere `dotnet watch` (que es consciente del rebuild) frente a un bucle manual de `dotnet run` más un `dotnet build` separado.

Si estás en `dotnet watch` y ves MSB3027 en cada rebuild, el síntoma suele ser un generador de código fuente cuya DLL de salida se reescribe en cada compilación. El workaround documentado en el repo del SDK consiste en mover el generador a un `.csproj` separado con `<EnforceCodeStyleInBuild>false</EnforceCodeStyleInBuild>` y `<EmitCompilerGeneratedFiles>false</EmitCompilerGeneratedFiles>`, y luego referenciar el proyecto del generador con `OutputItemType="Analyzer" ReferenceOutputAssembly="false"`. La DLL del generador deja de ser un destino de copia.

### 3. Añade exclusiones de antivirus para el repositorio

Para Microsoft Defender abre `Windows Security` > `Virus & threat protection` > `Manage settings` > `Exclusions` > `Add or remove exclusions` > `Add an exclusion` > `Folder`, y agrega:

- La raíz del repo, o como mínimo cada subdirectorio `bin/` y `obj/`.
- `%USERPROFILE%\.nuget\packages` (la caché global de NuGet).
- `%USERPROFILE%\.dotnet` (la instalación del SDK).

Para CrowdStrike / SentinelOne / un Defender gestionado por la empresa, no puedes hacerlo tú; abre un ticket con el equipo de IT y referencia el `.gitattributes` o `.editorconfig` de tu equipo como prueba de que las carpetas bin/obj son artefactos de compilación, no datos de usuario. La propia [documentación de exclusiones de Defender](https://learn.microsoft.com/en-us/defender-endpoint/configure-extension-file-exclusions-microsoft-defender-antivirus) confirma que el escaneo en tiempo real de la salida de compilación es la principal causa de fallos intermitentes de MSBuild en entornos corporativos.

### 4. Mueve el repositorio fuera de OneDrive

Si `pwd` dentro de tu repo imprime `C:\Users\<tú>\OneDrive\source\...`, muévelo. Los clientes de sincronización de cualquier tipo (OneDrive, Dropbox, Google Drive, iCloud) poseen un handle de escritura sobre los archivos que están subiendo o hidratando, y liberan ese handle según su propio reloj, no el de MSBuild. `C:\src\<repo>` fuera de cualquier carpeta sincronizada es el layout estándar para trabajo .NET en Windows.

### 5. Sube el presupuesto de reintentos (último recurso)

Si el bloqueo es inevitable (agente de CI con caché compartida, antivirus que no puedes excluir, build paralelo golpeando una dependencia compartida), sube el presupuesto. Pon esto en `Directory.Build.props` en la raíz del repositorio para que aplique a cada proyecto:

```xml
<!-- Directory.Build.props - .NET 11 SDK, MSBuild 17.13 -->
<Project>
  <PropertyGroup>
    <CopyRetryCount>20</CopyRetryCount>
    <CopyRetryDelayMilliseconds>2000</CopyRetryDelayMilliseconds>
  </PropertyGroup>
</Project>
```

Eso le da a la tarea `Copy` cuarenta segundos de presupuesto de reintentos. Números más altos solo esconden un problema más serio (un proceso atascado, un antivirus mal configurado) y hacen que cada compilación fallida tarde un minuto en aflorar, así que no los subas más allá de `CopyRetryCount=20`.

Para el caso específico de CI en el que proyectos paralelos compiten por la misma DLL compartida, la mejor solución es poner `BuildInParallel=false` para la solución problemática o marcar la biblioteca compartida como `<PackageReference>` a un feed NuGet en lugar de `<ProjectReference>`. Ambas hacen que la carrera desaparezca.

### 6. Desactiva el build server cuando los nodos de MSBuild se cuelgan

Los nodos de MSBuild colgados son raros pero visibles: `tasklist /fi "imagename eq MSBuild.exe"` muestra nodos que llevan muchos minutos sin ser reutilizados. Apágalos con:

```text
dotnet build-server shutdown
```

Ejecuta esto entre compilaciones en scripts que sufran MSB3027 intermitente, o pon `MSBUILDDISABLENODEREUSE=1` para desactivar por completo el reuso de nodos. Los tiempos de compilación suben unos segundos, pero los fallos de bloqueo de archivo de cola larga desaparecen.

## Trampas y variantes

- **MSB3026 es una advertencia, no un error.** Significa que MSBuild reintentó una copia y el reintento tuvo éxito. Si solo ves MSB3026, la compilación pasó y no hay nada que arreglar; el ruido solo te dice que ocurrió un bloqueo transitorio. Trata MSB3026 repetida como una señal para añadir una exclusión de Defender antes de que escale a MSB3027 la próxima semana.
- **MSB3021 sin MSB3027.** Es el comportamiento antiguo, anterior a que se añadiera el bucle de reintentos. Si solo ves MSB3021, estás en una cadena de herramientas mucho más vieja (.NET Core 2.x o `msbuild.exe` de VS 2015), y la resolución es la misma menos la palanca `CopyRetryCount`.
- **Variantes en Linux y macOS.** El número de error es el mismo. Los kernels Unix no aplican bloqueo de archivo obligatorio como Windows, así que la mayoría de las causas de bloqueo no aplican. Las que quedan son errores de permisos (el directorio de destino es propiedad de `root` tras una compilación en Docker) y sistemas de archivos llenos. `df -h` y `ls -ld bin/` descartan ambos en segundos.
- **Contenedores.** Compilar dentro de un contenedor Linux con un volumen montado desde un host Windows es lo peor de ambos mundos: el antivirus del host escanea archivos escritos desde dentro del contenedor. O compilas dentro del contenedor con un volumen local del contenedor (`docker volume create`), o compilas directamente en el host.
- **The file is locked by: 'System' or 'unknown'.** Cuando el proceso bloqueante se reporta como `System (4)` o sin nombre, el culpable casi siempre es un driver de antivirus en modo kernel. Defender, CrowdStrike y SentinelOne afloran así. Un `taskkill` en modo usuario no ayuda; la solución es una exclusión o desactivar temporalmente la protección en tiempo real.
- **Native AOT y publish con trim.** `dotnet publish -c Release` para un proyecto Native AOT a veces escribe el `.exe` de salida dos veces (una para el paso de publish, otra para la verificación de trim). En IO lento compite consigo mismo. Añade `<PublishAot>true</PublishAot>` y `<PublishSingleFile>false</PublishSingleFile>` juntos para evitar la copia duplicada.

## Relacionado

- [Fix: The type or namespace name 'X' could not be found after adding a project reference](/es/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) es la otra mitad del kit de diagnóstico para proyectos SDK-style. Los fallos de referencia y los de copia comparten una causa raíz más a menudo de lo que la gente cree.
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform in Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/) cubre los escenarios de trim y AOT donde MSB3027 también aflora desde la ruta de publish.
- [How to profile a .NET app with dotnet-trace and read the output](/es/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) es útil cuando el proceso bloqueante es tu propio programa y quieres averiguar qué lo mantuvo vivo en primer lugar.
- [.NET watch in .NET 11 preview 3: Aspire crash recovery](/es/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/) es el cambio reciente del SDK que afecta a la variante `dotnet watch` de este fallo.
- [Visual Studio 2026 Hot Reload: auto-restart on rude edits](/es/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) es la contraparte en el IDE para la causa de hot reload.

## Fuentes

- Microsoft Learn, [MSB3027 diagnostic code - MSBuild](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb3027) (la referencia oficial de una pantalla)
- Microsoft Learn, [Configure Microsoft Defender Antivirus exclusions by extension, name, or location](https://learn.microsoft.com/en-us/defender-endpoint/configure-extension-file-exclusions-microsoft-defender-antivirus)
- GitHub, [dotnet/msbuild#9169 File copy is no longer retried, causing builds to randomly fail](https://github.com/dotnet/msbuild/issues/9169)
- GitHub, [dotnet/sdk#40911 dotnet watch fails with MSB3021 (locked file) when project references custom source generator](https://github.com/dotnet/sdk/issues/40911)
- Microsoft Sysinternals, [handle.exe](https://learn.microsoft.com/en-us/sysinternals/downloads/handle), la herramienta canónica para nombrar al proceso bloqueante
