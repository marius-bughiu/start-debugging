---
title: "Cómo ejecutar una app de C# basada en archivo con `dotnet run app.cs` en .NET 11"
description: "Guía completa de las apps de C# basadas en archivo: ejecutar un solo archivo .cs con dotnet run, las directivas #:package, #:sdk, #:property, #:project e #:include, scripts multiarchivo con #:ref, manejo de argumentos y stdin, la caché de compilación, la publicación con native AOT, el empaquetado como herramienta de dotnet y dotnet project convert cuando el script se queda corto."
pubDate: 2026-08-09
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "dotnet-10"
  - "dotnet-cli"
  - "file-based-apps"
lang: "es"
translationOf: "2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-09
---

Para ejecutar un archivo de C# sin proyecto, guárdalo como `app.cs` y ejecuta `dotnet run app.cs`. Eso es todo. El SDK sintetiza un proyecto en memoria, restaura, compila hacia un directorio de caché dentro de tu carpeta temporal y ejecuta el resultado. No necesitas un `.csproj`, ni una clase `Program`, ni un método `Main`. La configuración que normalmente viviría en el archivo de proyecto va en directivas `#:` al inicio del archivo fuente: `#:package Humanizer@2.14.1` agrega una referencia de NuGet, `#:sdk Microsoft.NET.Sdk.Web` convierte el script en una app web y `#:property PublishAot=false` establece cualquier propiedad de MSBuild. Las apps basadas en archivo llegaron con el SDK de .NET 10 y obtuvieron soporte multiarchivo en .NET 11. Este artículo cubre toda la superficie, incluidas las partes que sorprenden: dónde termina realmente la salida de compilación, por qué un `.csproj` en tu directorio de trabajo secuestra el comando en silencio y qué directivas necesitan qué versión del SDK.

Todo lo marcado como "verificado" más abajo se ejecutó en el SDK 10.0.201 (runtime .NET 10.0.5) en Windows. .NET 11 está en Preview 6 al momento de escribir esto, con GA prevista para noviembre de 2026, y las características de .NET 11 se señalan por versión cuando difieren.

## Pasos para ejecutar una app de C# basada en archivo

1. Guarda tu código en un archivo con extensión `.cs`, usando instrucciones de nivel superior. Sin `class`, sin `Main`.
2. Agrega cualquier directiva `#:` al inicio del archivo: `#:package` para referencias de NuGet, `#:sdk` para cambiar de SDK, `#:property` para propiedades de MSBuild.
3. Ejecuta `dotnet run app.cs` desde un directorio que no contenga un archivo de proyecto.
4. Pasa argumentos a tu app después de un separador `--`: `dotnet run app.cs -- arg1 arg2`.
5. Cuando el script se quede corto en un solo archivo, ejecuta `dotnet project convert app.cs` para generar un `.csproj` equivalente.

El resto de este artículo desarrolla cada paso y cubre el comportamiento que solo descubres al chocar con él.

## Lo más pequeño que se ejecuta

Las instrucciones de nivel superior son el punto de entrada. `args` está en ámbito sin ceremonia alguna:

```csharp
// app.cs -- verified on SDK 10.0.201
Console.WriteLine($"args: {string.Join(",", args)}");
Console.WriteLine($"tfm: {System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}");
Console.WriteLine($"asm: {System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name}");
```

```bash
dotnet run app.cs -- one two
```

```
args: one,two
tfm: .NET 10.0.5
asm: app
```

Fíjate en el nombre del ensamblado: `app`, tomado del nombre del archivo. Eso importa más adelante, porque el directorio de la caché de compilación, el ID de user secrets y el nombre de la herramienta empaquetada se derivan de él.

Hay tres formas equivalentes de invocarlo. `dotnet run app.cs` es la forma común. `dotnet run --file app.cs` es la forma explícita, la que quieres en scripts porque no es ambigua. Y `dotnet app.cs` es la forma abreviada. Las tres produjeron una salida idéntica en las pruebas.

También puedes omitir el archivo por completo y canalizar el código fuente por la entrada estándar usando `-` como argumento:

```bash
echo 'Console.WriteLine("hello from stdin!");' | dotnet run -
```

Eso imprime `hello from stdin!`. Con `-`, el SDK no revisa el directorio de trabajo en busca de perfiles de inicio ni de otros archivos, aunque el directorio actual sigue siendo el directorio de trabajo para la compilación. Es una salida de emergencia genuinamente útil para scripts de shell que generan C#.

## Lo que el SDK genera realmente

La forma más clara de entender una app basada en archivo es mirar el proyecto que el SDK compila en tu nombre. `dotnet project convert` lo escribe en disco. Para un archivo que no contiene más que `Console.WriteLine("plain");`, el proyecto generado es:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <PublishAot>true</PublishAot>
    <PackAsTool>true</PackAsTool>
    <UserSecretsId>plain-c7cf82264bd176cef60e04b947ef58d1b133625432bf800179babd82aa79722e</UserSecretsId>
  </PropertyGroup>

</Project>
```

Cuatro de esos valores por defecto vale la pena interiorizarlos. `ImplicitUsings` y `Nullable` están ambos habilitados, y por eso `Console` se resuelve sin un `using System;` y por eso el compilador te va a molestar con la nulabilidad en un script desechable. `PublishAot` está en **true** por defecto, así que `dotnet publish app.cs` produce un ejecutable nativo salvo que optes por lo contrario. Y `PackAsTool` está en true por defecto, así que `dotnet pack app.cs` te da un paquete instalable con `dotnet tool install` sin configuración adicional. El `UserSecretsId` es un hash estable de la ruta completa del archivo, lo que significa que los user secrets funcionan de entrada pero dejan de resolverse si mueves el archivo.

`TargetFramework` sigue al SDK que tengas instalado. En el SDK 10.0.201 es `net10.0`; en un SDK de .NET 11 es `net11.0`. Fíjalo explícitamente con `#:property TargetFramework=net10.0` si te importa.

## Las cinco directivas

Las directivas van al inicio del archivo, con el prefijo `#:`. El conjunto documentado es `#:include`, `#:package`, `#:project`, `#:property` y `#:sdk`.

`#:package` agrega una referencia de NuGet. La versión va después de una `@`:

```csharp
// pkg.cs -- verified on SDK 10.0.201
#:package Humanizer@2.14.1

using Humanizer;
Console.WriteLine(TimeSpan.FromMinutes(90).Humanize(2));
```

Eso imprime `1 hour, 30 minutes`. Usa `@*` para flotar hacia la última versión. Omitir la versión por completo solo funciona cuando un archivo `Directory.Packages.props` te pone bajo gestión centralizada de paquetes; de lo contrario, fíjala o usa `@*`.

`#:sdk` cambia el SDK de MSBuild, que es la manera de obtener una app web a partir de un solo archivo:

```csharp
// web.cs
#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=false

var app = WebApplication.Create();
app.MapGet("/", () => "ok");
app.Run();
```

`#:sdk` también acepta una versión, como en `#:sdk Aspire.AppHost.Sdk@13.0.2`. Cambiar a `Microsoft.NET.Sdk.Web` también cambia los globs de elementos por defecto: los archivos de configuración `*.json` del directorio se recogen automáticamente.

`#:property` establece cualquier propiedad de MSBuild, y no se limita a literales. Las funciones de propiedad de MSBuild funcionan, así que puedes leer variables de entorno con un valor de reserva:

```csharp
#:property LogLevel=$([MSBuild]::ValueOrDefault('$(LOG_LEVEL)', 'Information'))
```

`#:project` referencia un archivo de proyecto real o un directorio que contenga uno, y es el puente de vuelta a una solución normal:

```csharp
#:project ../SharedLibrary/SharedLibrary.csproj
```

## Scripts multiarchivo y la versión del SDK que los condiciona

`#:include` trae otros archivos a la misma compilación. Mapea por extensión: `*.cs` pasa a `Compile`, `*.resx` a `EmbeddedResource`, `*.json` a `None` y `*.razor` a `Content`. Funcionan rutas literales, patrones glob y propiedades de MSBuild:

```csharp
#:include helpers.cs
#:include models/customer.cs
#:include shared/**/*.cs
```

La restricción crítica: los archivos `.cs` incluidos pueden agregar tipos, métodos y espacios de nombres, pero **no** pueden contener instrucciones de nivel superior. Solo el archivo de entrada las tiene.

`#:include` requiere el SDK de .NET 10.0.300 o .NET 11 Preview 3 en adelante. En un SDK más antiguo obtienes un rechazo seco en lugar de un mensaje útil sobre la versión. En 10.0.201 el error exacto es:

```
inc.cs(1): error: Unrecognized directive 'include'.
```

Si ves eso, revisa `dotnet --version` antes de ponerte a buscar una errata. Esta es la misma brecha que hizo de [`#:include` en .NET 10 un hito notable](/es/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/) cuando llegó.

.NET 11 Preview 5 agregó una segunda forma, distinta, de abarcar varios archivos: [la directiva `#:ref`](/es/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/), que referencia otra app basada en archivo como *biblioteca* en lugar de fusionarla en una sola compilación, con soporte para referencias transitivas ([dotnet/sdk#53480](https://github.com/dotnet/sdk/pull/53480)). La misma preview quitó los feature flags de `#:include` y `#:exclude` ([dotnet/sdk#53775](https://github.com/dotnet/sdk/pull/53775)) e hizo que las directivas dentro de archivos incluidos se procesen de forma transitiva ([dotnet/sdk#54012](https://github.com/dotnet/sdk/pull/54012)). Preview 6 extendió `#:include` a ensamblados compilados, así que `#:include ./libs/MyLibrary.dll` ahora funciona sin flag.

Dos detalles de comportamiento de esas notas de preview son fáciles de pasar por alto. Se permiten entradas duplicadas de `#:project` y `#:ref`, en línea con la semántica de elementos de MSBuild. Las directivas duplicadas de otro tipo entre archivos incluidos producen un diagnóstico en lugar de aceptarse en silencio, aunque Preview 6 relajó eso para `#:sdk`, `#:property` y `#:package` cuando los valores duplicados coinciden. Ten en cuenta que `#:ref` y `#:exclude` están documentadas en las notas de versión del SDK pero todavía no aparecen en el [artículo de MS Learn sobre apps basadas en archivo](https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps), así que trata las notas de versión como la fuente autorizada para esas dos.

## Argumentos, variables de entorno y dónde va la salida

Los argumentos posteriores a `--` se reenvían a tu app en lugar de que los consuma la CLI. Las variables de entorno se pueden establecer en línea con `-e`:

```bash
dotnet run -e FOO=bar env.cs
```

Eso imprime `FOO=bar` desde `Environment.GetEnvironmentVariable("FOO")`. Las notas de versión de .NET 11 listan `dotnet run -e` como una opción nueva del SDK, pero ya funcionaba en el SDK 10.0.201 probado aquí.

La salida de compilación no aterriza junto a tu archivo. Va a un directorio direccionado por contenido dentro de la carpeta temporal del sistema, con la forma `<temp>/dotnet/runfile/<appname>-<sha>/bin/<configuration>/`. La ruta verificada en Windows:

```
C:\Users\...\AppData\Local\Temp\dotnet\runfile\app-82b0b938fb24db69...\bin\debug\app.dll
```

Redirígela con `--output` en `dotnet build`, o establece un valor por defecto en el propio archivo con `#:property OutputPath=./output`.

## La caché de compilación es toda la historia del rendimiento

El SDK cachea la salida de compilación con una clave basada en el contenido del archivo fuente, la configuración de directivas, la versión del SDK y la existencia y el contenido de los archivos de compilación implícitos. La diferencia es lo bastante grande como para cambiar la sensación que da la herramienta. Medido en el SDK 10.0.201, misma máquina, mismo script trivial:

| Invocación | Tiempo de reloj |
| --- | --- |
| Primera ejecución tras `dotnet clean app.cs` | 1.174 s |
| Ejecución cacheada | 0.252 s |

Un cuarto de segundo está dentro del rango en el que un archivo `.cs` es un reemplazo viable de un script de shell. Una compilación en frío no lo está.

Tres comportamientos de la caché causan confusión. Los cambios en archivos de compilación implícitos como `Directory.Build.props` no siempre disparan una recompilación. Mover un archivo a otro directorio no invalida la caché. Y usar un patrón glob en `#:include` actualmente deshabilita la caché de compilación por completo, así que una línea `shared/**/*.cs` te cuesta el camino rápido en silencio.

Para limpiarla:

```bash
dotnet clean file-based-apps
```

Eso escanea `<temp>/dotnet/runfile` y elimina las carpetas de artefactos sin usar durante al menos 30 días; pasa `--days` para cambiar el umbral. Para una sola app, `dotnet clean app.cs` seguido de `dotnet build app.cs` fuerza una recompilación limpia.

Una advertencia sobre concurrencia: ejecutar varias instancias de la misma app basada en archivo en paralelo puede fallar por contención sobre los archivos de salida de compilación. Compila una vez primero y luego ejecuta con `--no-build`:

```bash
dotnet build app.cs
dotnet run app.cs --no-build
```

## Publicar, empaquetar y ejecución desde el shell

`dotnet publish app.cs` produce un ejecutable autocontenido en un directorio `artifacts` junto al archivo `.cs`. Como `PublishAot` está en true por defecto, ese es un binario native AOT con arranque rápido y sin dependencia del runtime, que es exactamente lo que quieres para una herramienta de línea de comandos distribuida y exactamente lo que no quieres si tu script usa bibliotecas cargadas de reflexión. Opta por lo contrario con `#:property PublishAot=false`. Si no tienes claro de qué lado de esa línea cae tu código, las compensaciones son las mismas que se cubren en [qué te cuesta realmente Native AOT](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/), y la diferencia entre compilar y publicar también merece precisión, como se cubre en [`dotnet build` frente a `dotnet publish`](/es/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/).

`dotnet pack app.cs` produce un paquete de NuGet y, dado que `PackAsTool` es true por defecto, ese paquete es instalable como herramienta global. De un solo archivo `.cs` a una `dotnet tool` distribuible sin archivo de proyecto es un camino genuinamente corto.

En sistemas tipo Unix puedes hacer el archivo directamente ejecutable con un shebang:

```csharp
#!/usr/bin/env -S dotnet --
#:package Spectre.Console@*

using Spectre.Console;

AnsiConsole.MarkupLine("[green]Hello, World![/]");
```

```bash
chmod +x file.cs
./file.cs
```

La bandera `-S` permite que `env` divida el resto de la línea en argumentos separados, y el `--` final impide que `dotnet` se trague argumentos que parecen suyos (`--help`, por ejemplo). Usa finales de línea LF y sin BOM, o el shebang no será reconocido. Si tu `env` no admite `-S`, recurre a `#!/usr/bin/env dotnet` y acepta el riesgo de colisión de argumentos.

## El detalle que más tiempo hace perder

Si existe un archivo de proyecto en el directorio de trabajo actual, `dotnet run app.cs` ejecuta *ese proyecto* y le pasa `app.cs` como argumento de línea de comandos. Esto es compatibilidad hacia atrás deliberada, y es silenciosa.

Verificado: desde un directorio que contenía `pkg.csproj`, ejecutar `dotnet run ../env.cs` ejecutó `pkg.csproj` e imprimió su salida, no la de `env.cs`. Nada te avisa. Usa `dotnet run --file ../env.cs` cuando necesites certeza, y mantén las apps basadas en archivo fuera del cono de directorios de cualquier proyecto:

```
MyProject/
  MyProject.csproj
  Program.cs
scripts/
  utility.cs
```

La trampa relacionada son los archivos de compilación implícitos. Las apps basadas en archivo respetan `Directory.Build.props`, `Directory.Build.targets`, `Directory.Packages.props`, `nuget.config` y `global.json` del directorio actual y de los directorios padre. Un `Directory.Build.props` en la raíz del repositorio que establezca `TreatWarningsAsErrors` se aplicará a tu script desechable. Dale a los scripts su propio directorio con su propio `Directory.Build.props` cuando necesites aislamiento.

Dos más pequeñas. Los perfiles de inicio viven en un archivo plano `app.run.json` junto a `app.cs` en lugar de en `Properties/launchSettings.json`; si existen ambos, gana la ubicación tradicional y la CLI registra una advertencia. Y `dotnet user-secrets` necesita la opción `--file` para apuntar a un script: `dotnet user-secrets set "ApiKey" "value" --file app.cs`.

## Cuando el script deja de ser un script

`dotnet project convert app.cs` es el camino de graduación. Copia el archivo `.cs` y escribe un `.csproj` con SDK, propiedades y referencias de paquetes equivalentes derivadas de tus directivas `#:`, ambos colocados en un nuevo directorio con el nombre de la app. El archivo original queda intacto, así que la conversión no es destructiva y puedes revisar el diff del resultado antes de comprometerte con él.

Ejecutarlo contra el ejemplo de Humanizer de arriba produjo exactamente la traducción esperada, con `#:package Humanizer@2.14.1` convertido en un `PackageReference` y `#:property PublishAot=false` en una propiedad:

```xml
  <ItemGroup>
    <PackageReference Include="Humanizer" Version="2.14.1" />
  </ItemGroup>
```

Ese gradiente es el verdadero diseño de la característica. Empieza con un archivo. Separa los ayudantes con `#:include`. Promueve un ayudante a biblioteca con `#:ref`. Apunta a un proyecto real con `#:project`. Convierte cuando la ceremonia de MSBuild por fin se gane su lugar. Cada paso es una línea, y ninguno te obliga a abandonar `dotnet run`. Para la historia del ciclo interno una vez que sí tienes un proyecto, la distinción entre [`dotnet watch` y `dotnet run`](/es/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/) es lo siguiente que vale la pena conocer.

## Relacionados

- [.NET 11 Preview 5 permite que las apps basadas en archivo se referencien entre sí con `#:ref`](/es/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/)
- [Las apps basadas en archivo de .NET 10 acaban de conseguir scripts multiarchivo: llega `#:include`](/es/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/)
- [¿Cuál es la diferencia entre `dotnet build` y `dotnet publish`?](/es/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)
- [¿Qué es Native AOT y qué te cuesta?](/es/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [¿Cuál es la diferencia entre `dotnet watch` y `dotnet run`?](/es/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)

## Fuentes

- [File-based apps](https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps) en MS Learn, la referencia conceptual para directivas, comandos de la CLI, caché y disposición de carpetas.
- [What's new in .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview), que lista el soporte de DLL en `#:include` y `dotnet run -e`.
- [Notas de versión del SDK de .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md) para `#:ref`, la eliminación de feature flags y los diagnósticos de directivas duplicadas.
- [Notas de versión del SDK de .NET 11 Preview 6](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/sdk.md) para `#:include` de ensamblados compilados.
- [Announcing dotnet run app.cs](https://devblogs.microsoft.com/dotnet/announcing-dotnet-run-app/) en el blog de .NET, la justificación de diseño original.
