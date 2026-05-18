---
title: "Solución: framework_version=6.0.0 was not found al ejecutar un binario de .NET 6"
description: "El runtime de .NET 6 ya no está o no coincide. Instala net6.0 de nuevo, haz roll forward a net8.0 con runtimeconfig, cambia el csproj, o publica self-contained."
pubDate: 2026-05-18
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-6"
  - "runtime"
  - "deployment"
lang: "es"
translationOf: "2026/05/fix-framework-version-6-0-0-when-launching-dotnet-6-binary"
translatedBy: "claude"
translationDate: 2026-05-18
---

La solución: un binario de .NET 6 que imprime `framework_version=6.0.0` y se niega a iniciar te está diciendo que el runtime de .NET 6 no está en la máquina, no que tu aplicación esté rota. En un servidor al que aún se le permite mantener `net6.0`, instala el runtime Microsoft.NETCore.App 6.0 y el error de arranque desaparece. En un servidor que ya pasó a net8.0 o net10.0, configura `rollForward` en `Major` en `runtimeconfig.json`, cambia el proyecto a un framework con soporte, o publica self-contained para que el binario lleve su propio runtime. Una `MissingMethodException` inmediatamente después de esa solución es el mismo problema con la mecha retardada: el roll-forward dejó que la aplicación arrancara en un runtime más nuevo, pero un assembly transitivo se enlaza rígidamente a un método que .NET 6 tenía y que el runtime más nuevo renombró.

```text
You must install or update .NET to run this application.

App: /opt/myapp/MyApp
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '6.0.0' (x64)
.NET location: /usr/share/dotnet

The following frameworks were found:
  8.0.15 at [/usr/share/dotnet/shared/Microsoft.NETCore.App]
  10.0.0 at [/usr/share/dotnet/shared/Microsoft.NETCore.App]

Learn more:
https://aka.ms/dotnet/app-launch-failed

To install missing framework, download:
https://aka.ms/dotnet-core-applaunch?framework=Microsoft.NETCore.App&framework_version=6.0.0&arch=x64&rid=linux-x64&os=linux
```

Esta guía está escrita para la situación que existe en mayo de 2026: .NET 6 alcanzó el fin del soporte el 2024-11-12, así que las imágenes de producción, los gestores de paquetes y las capas base que se actualizan solas han empezado a desinstalarlo. El mismo binario que estuvo en producción durante dos años ahora falla al iniciar con el mensaje de arriba. El comportamiento es idéntico ya sea que el host sea `dotnet.exe MyApp.dll` en Windows, el stub apphost en Linux, o `dotnet exec` en macOS. Las reglas de sondeo del runtime descritas aquí son las de los hosts de .NET 6, .NET 8 y .NET 10; nada de ellas cambió entre versiones.

## Dos errores, una misma causa raíz

El error aparece en dos formas que parecen no relacionadas, y la segunda es la que pilla a la mayoría de los equipos.

La primera forma es el error host-fxr de arriba. El host abre `MyApp.runtimeconfig.json`, lee el `tfm` y el bloque `framework`, y decide que necesita `Microsoft.NETCore.App` versión 6.0.0. Luego recorre las rutas de instalación y encuentra o bien nada o solo carpetas SxS más nuevas. La URL de instalación incrusta el nombre y la versión del framework como parámetros de consulta, por eso toda búsqueda de `framework_version=6.0.0` aterriza en el mismo problema.

La segunda forma es `MissingMethodException` en tiempo de ejecución. El host encontró un framework compatible, el proceso arrancó, y luego una búsqueda `JIT_GetMethodCall` falló:

```text
System.MissingMethodException: Method not found: 'System.String System.String.IsNullOrEmpty(System.String)'
   at MyApp.Services.RequestPipeline.HandleAsync(HttpContext ctx)
```

Eso pasa cuando la aplicación arrancó en un runtime más nuevo, pero uno de los assemblies cargados se compiló contra un ensamblado de referencia de .NET 6 y referencia a un método cuya firma cambió en .NET 8 o .NET 10. El roll-forward te dejó pasar la comprobación de arranque, y el coste fue un error de enlazado retrasado en código de usuario. Ambos mensajes significan que el runtime de .NET 6 no está en esta máquina.

## Por qué tu binario pide 6.0.0 específicamente

La cadena de versión `6.0.0` no es la versión del runtime instalada cuando construiste el proyecto. Es el piso declarado por el `<TargetFramework>` contra el que compilaste. Cuando ejecutas `dotnet publish` en un proyecto `net6.0`, MSBuild escribe `MyApp.runtimeconfig.json` que se ve así:

```json
{
  "runtimeOptions": {
    "tfm": "net6.0",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "6.0.0"
    },
    "configProperties": {
      "System.Runtime.TieredCompilation": true
    }
  }
}
```

El host usa ese campo `version` como mínimo, no como coincidencia exacta. Con la política `rollForward` por defecto, que es `Minor`, acepta cualquier 6.x pero nunca 7.x o superior. Con `Major`, acepta 7.x, 8.x, 10.x. Con `LatestPatch`, solo acepta 6.0.x. La razón por la que tu consulta de búsqueda dice `framework_version=6.0.0` es que el host repite el piso que pidió, incluso cuando no hay ningún 6.x instalado en absoluto.

Ejecuta `dotnet --list-runtimes` en la máquina que falla. Si ves `Microsoft.NETCore.App 8.0.15` y `10.0.0` pero ninguna línea 6.x, ese es el diagnóstico. La línea que debería estar ahí es `Microsoft.NETCore.App 6.0.x [/usr/share/dotnet/shared/Microsoft.NETCore.App]`.

## Reproducción mínima

Construye una app de consola `net6.0`, publícala framework-dependent, y ejecútala en una máquina que solo tenga runtimes más nuevos instalados.

```xml
<!-- MyApp.csproj, .NET SDK 8.0.300+ still builds net6.0 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net6.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// MyApp/Program.cs, .NET 6, C# 10
Console.WriteLine($"Running on .NET {Environment.Version}");
```

```bash
dotnet publish -c Release -r linux-x64 --self-contained false -o ./out
./out/MyApp
# You must install or update .NET to run this application.
# Framework: 'Microsoft.NETCore.App', version '6.0.0' (x64)
```

El bug aparece de la misma forma en una imagen de Docker que cambió su base de `mcr.microsoft.com/dotnet/aspnet:6.0` a `mcr.microsoft.com/dotnet/aspnet:8.0` sin retargeting del proyecto. La etiqueta `net6.0` en `runtimeconfig.json` sobrevive al cambio de imagen base.

## Solución uno, recomendada: cambiar el target del proyecto

La respuesta con soporte en 2026 es dejar de publicar `net6.0`. .NET 6 dejó de recibir parches de seguridad en noviembre de 2024, .NET 7 en mayo de 2024, y .NET 9 en mayo de 2026. Las únicas ramas actualmente con soporte son `net8.0` (LTS, con soporte hasta noviembre de 2026), `net10.0` (LTS, con soporte hasta noviembre de 2028), y las previews en desarrollo de `net11.0`.

Cambia el archivo de proyecto, restaura y vuelve a publicar:

```xml
<!-- MyApp.csproj, .NET SDK 10.0.x -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

```bash
dotnet restore
dotnet publish -c Release -r linux-x64 --self-contained false -o ./out
```

`runtimeconfig.json` ahora declara `version: 10.0.0`, y una máquina con `Microsoft.NETCore.App 10.0.0` instalada lo arranca sin quejas. Esta es la única solución que también elimina la variante `MissingMethodException`, porque la aplicación ahora se compila contra los mismos ensamblados de referencia que el runtime en el que se va a ejecutar.

Si el proyecto depende de un paquete que no ha publicado un build `net10.0`, normalmente tienes dos salidas: subir la versión del paquete, o poner `<TargetFrameworks>net6.0;net10.0</TargetFrameworks>` y publicar la salida multi-target. El host en el servidor nuevo elige `net10.0`, el host legacy en el servidor viejo elige `net6.0`, y ambos siguen funcionando hasta que retires del todo las máquinas 6.x.

## Solución dos, baja fricción: roll forward a un runtime más nuevo

Cuando cambiar el target está bloqueado (binario de un proveedor que no puedes recompilar, ciclo de release lento, revisión legal de cada assembly), fuerza al binario de .NET 6 a arrancar en un runtime más nuevo cambiando su política `rollForward`. Hay dos sitios donde configurarlo.

En el proyecto antes de publicar:

```xml
<!-- MyApp.csproj, still net6.0 -->
<PropertyGroup>
  <TargetFramework>net6.0</TargetFramework>
  <RollForward>Major</RollForward>
</PropertyGroup>
```

O en el artefacto ya publicado, editando `MyApp.runtimeconfig.json` al lado del binario:

```json
{
  "runtimeOptions": {
    "tfm": "net6.0",
    "rollForward": "Major",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "6.0.0"
    }
  }
}
```

O sin tocar el archivo, configurando la variable de entorno para un solo arranque:

```bash
DOTNET_ROLL_FORWARD=Major ./out/MyApp
```

`Major` acepta cualquier versión mayor más nueva. `LatestMajor` hace lo mismo pero siempre elige la mayor instalada más alta, que es lo que las flotas de producción que abarcan varios majors de runtime suelen querer. Reinicia el proceso y el error de arranque desaparece.

El roll-forward es la solución que produce `MissingMethodException` más adelante. Si algún paquete en tu grafo de dependencias se compiló contra los ensamblados de referencia de .NET 6 y llamó a un método que se eliminó o renombró en .NET 8 o .NET 10, el JIT lo descubre la primera vez que esa ruta de código se ejecuta. No hay forma de evitarlo para ese caso aparte de actualizar el paquete problemático o volver a la solución uno.

## Solución tres, último recurso: instalar el runtime de .NET 6

Cuando la máquina debe mantener un runtime sin soporte, instálalo explícitamente. Microsoft sigue alojando las descargas del runtime de .NET 6, marcadas como fin de vida, en la misma URL a la que el error de arranque enlazaba.

En Debian y Ubuntu, el paquete es `dotnet-runtime-6.0`:

```bash
sudo apt-get install -y dotnet-runtime-6.0
dotnet --list-runtimes
# Microsoft.NETCore.App 6.0.36 [/usr/share/dotnet/shared/Microsoft.NETCore.App]
# Microsoft.NETCore.App 8.0.15 [...]
# Microsoft.NETCore.App 10.0.0 [...]
```

En Windows, instálalo con `winget install Microsoft.DotNet.Runtime.6` o el MSI standalone. En una imagen Docker, cambia `FROM mcr.microsoft.com/dotnet/aspnet:8.0` de vuelta a `FROM mcr.microsoft.com/dotnet/aspnet:6.0` o usa la imagen multi-versión en `mcr.microsoft.com/dotnet/runtime-deps:6.0` con una capa de instalación explícita de `dotnet-runtime-6.0`.

Marca `dotnet-runtime-6.0` con hold para que el próximo upgrade desatendido no lo vuelva a eliminar:

```bash
sudo apt-mark hold dotnet-runtime-6.0
```

Esto es una prórroga, no una solución. El runtime ya no recibe parches de seguridad, así que cualquier CVE en `System.Net.Http` o `System.Text.Json` 6.x se queda sin parchear en esa máquina. Trátalo como una extensión de plazo mientras completas la solución uno.

## Solución cuatro, aislamiento: publicar self-contained

Si controlas la build pero no el destino del deploy, embarca el runtime dentro del artefacto. Una publicación self-contained pone los archivos de `Microsoft.NETCore.App` al lado de tus DLLs y el host nunca pide un runtime al sistema.

```bash
dotnet publish -c Release -r linux-x64 \
  --self-contained true \
  -p:PublishSingleFile=true \
  -p:PublishTrimmed=false \
  -o ./out
```

La salida crece unos 70 MB y no hay que instalar nada en la máquina destino. Esto funciona también para `net6.0`, pero el SDK que lo construye tiene que poder resolver el ref pack de `net6.0`; el .NET SDK 10.0.x aún puede compilar contra `net6.0` al momento de escribir esto, así que la build funciona bien en un SDK reciente.

Self-contained es la respuesta correcta para herramientas one-off, scripts de CI, sidecars, y cualquier sitio donde no puedes dictar el entorno del host. Es la respuesta incorrecta para flotas donde el parcheo compartido del runtime es parte de la postura de seguridad, porque cada aplicación ahora tiene su propia copia de `System.Net.Http` y hay que recompilarla cada vez que cae un CVE.

## Diagnosticar antes de arreglar

El host tiene un modo verboso que imprime exactamente qué está buscando y dónde. Configura `COREHOST_TRACE=1` (y opcionalmente `COREHOST_TRACEFILE=/tmp/host.log`) y vuelve a ejecutar el binario que falla:

```bash
COREHOST_TRACE=1 COREHOST_TRACEFILE=/tmp/host.log ./out/MyApp
grep -E "version|framework|rollForward" /tmp/host.log
```

El log lista cada versión de framework que el host consideró, qué política `rollForward` se aplicó, y qué rutas se sondearon. Si el log dice que encontró 8.0.15 pero lo rechazó porque `rollForward=LatestPatch` estaba configurado, sabes que hay que cambiar la política. Si el log dice que no encontró nada bajo `/usr/share/dotnet/shared/Microsoft.NETCore.App`, sabes que hay que instalar o reubicar.

Para la forma `MissingMethodException`, la traza de pila nombra el assembly que se enlazó al método equivocado. Abre la carpeta publicada, ejecuta `dotnet --info` contra el host para confirmar la versión del runtime, e inspecciona la DLL problemática con `ildasm` o `dotnet-ildasm` para confirmar que referencia un ensamblado de referencia 6.0. Reemplaza el paquete con uno que tenga un build `net8.0` o `net10.0`, o usa redirecciones de enlazado vía `<AssemblyLoadContext>` si tienes que mantener ambos.

## Trampas y casos parecidos

El parámetro `framework_version` en la URL **no** es la versión del runtime instalada; es el piso que pidió la aplicación. Buscar específicamente "install .NET 6.0.0" es un callejón sin salida, porque el parche que se publica es algo como 6.0.36. Instala el último 6.0.x, no 6.0.0.

Una `MissingMethodException` en `Microsoft.AspNetCore.App` en vez de `Microsoft.NETCore.App` sigue la misma lógica, pero apunta al framework compartido de ASP.NET Core. Mismas rutas de solución, mismo botón `rollForward`, distinto nombre de framework compartido en el .deps.json.

`dotnet --info` lista SDKs y runtimes. El runtime que usa tu aplicación es el listado bajo "Microsoft.NETCore.App". Si solo está instalado "Microsoft.AspNetCore.App 6.0.x", las aplicaciones de ASP.NET Core arrancarán pero las de consola seguirán reportando el error original, porque el framework compartido de ASP.NET depende del runtime de .NET pero no es la misma instalación.

En Windows, el apphost es `MyApp.exe`, no `dotnet.exe`. El mensaje de error es idéntico, el troubleshooting es idéntico, y `where dotnet` responde la pregunta equivocada. Usa `MyApp.exe --info` para confirmar qué host está ejecutándose.

Si el binario arranca desde dentro de un Azure App Service o un host de Functions, la plataforma configura la ruta del runtime por ti. La solución es la versión "Stack" de configuración del App Service, no el archivo local. La variante relacionada para App Service está cubierta en [La versión especificada de Microsoft.NetCore.App o Microsoft.AspNetCore.App no se encontró](/es/2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found/) que recorre la misma causa raíz con el portal de Azure delante.

## Relacionado

- [Solución: Could not load file or assembly en una app publicada](/es/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) cuando el host encontró el runtime pero falta una DLL del proyecto en la carpeta de publicación.
- [Azure App Service: Microsoft.NetCore.App no encontrado](/es/2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found/) para la misma causa raíz cuando la plataforma controla el host.
- [Solución: El comando 'dotnet' no se encuentra en CI](/es/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/) cuando el runtime ni siquiera está en el PATH.
- [Solución: The type or namespace name could not be found tras un ProjectReference](/es/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) cuando el retargeting introduce un desajuste de TargetFramework `NU1201`.
- [Solución: PlatformNotSupportedException en Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/) para la clase relacionada de errores del host de runtime que solo aparecen después de publicar.

## Fuentes

- [Anuncio de fin de soporte de .NET 6](https://learn.microsoft.com/en-us/lifecycle/announcements/dotnet-6-end-of-support) y el calendario de releases de .NET para saber qué sigue recibiendo parches.
- [Roll forward para aplicaciones framework-dependent](https://learn.microsoft.com/en-us/dotnet/core/versions/selection#framework-dependent-apps-roll-forward) para la tabla completa de políticas `rollForward`.
- [Deployment self-contained](https://learn.microsoft.com/en-us/dotnet/core/deploying/) para el flujo de publicación con `--self-contained`.
- [Opciones de configuración del runtime de .NET](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/) para el esquema completo de `runtimeconfig.json`.
- [dotnet/runtime issue #79286](https://github.com/dotnet/runtime/issues/79286) para el hilo canónico sobre la lógica de resolución de frameworks del host y la flag de traza.
