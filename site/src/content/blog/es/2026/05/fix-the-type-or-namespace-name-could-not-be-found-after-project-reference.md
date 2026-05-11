---
title: "Fix: The type or namespace name 'X' could not be found (después de añadir una referencia de proyecto)"
description: "CS0246 justo después de un ProjectReference recién añadido casi siempre es un desajuste de TargetFramework, una carpeta obj/ obsoleta o una directiva using ausente. Cinco soluciones en orden de probabilidad."
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
translationOf: "2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference"
translatedBy: "claude"
translationDate: 2026-05-11
---

La solución: en nueve de cada diez casos, tu proyecto consumidor apunta a un `TargetFramework` inferior al del proyecto referenciado (así que el pack del SDK ni siquiera intenta resolver el ensamblado), los directorios `obj/` y `bin/` de la compilación previa siguen apuntando al ensamblado de referencia equivocado, o el tipo compiló sin errores pero falta una directiva `using` en el sitio de llamada. Abre ambos archivos `.csproj`, alinea sus valores de `TargetFramework`, ejecuta `dotnet build --no-incremental` (o borra `obj/` y `bin/` a mano en Windows) y solo después empieza a mirar las directivas `using`. El texto de la excepción y su causa no han cambiado entre .NET 6 y .NET 11 preview 4, así que la misma lista de verificación aplica a cualquier proyecto SDK-style moderno.

```text
error CS0246: The type or namespace name 'OrderService' could not be found (are you missing a using directive or an assembly reference?)
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'MyApp.Domain' (are you missing an assembly reference?)
```

Los dos códigos dividen la misma causa raíz por una línea estrecha: `CS0246` significa que el compilador no encuentra un tipo de nivel superior por su nombre corto; `CS0234` significa que encontró el espacio de nombres pero no pudo ver el miembro anidado. Ambos se disparan en cuanto el compilador de C# pide a Roslyn un símbolo que el lector de metadatos no puede resolver, lo que en una compilación SDK-style ocurre después de que MSBuild haya terminado de ensamblar la lista de referencias. Si esa lista está mal, el compilador es la capa equivocada donde depurar.

Esta guía está escrita contra .NET SDK 11.0.100-preview.4, MSBuild 17.13 y Roslyn 4.13. El comportamiento es idéntico en .NET 8 LTS y .NET 10. Los códigos de error del compilador han sido estables desde que Roslyn salió a la luz, así que las soluciones aplican a todas las versiones de C# desde 7.0 en adelante.

## Por qué el compilador no ve el tipo tras añadir un `ProjectReference`

Hay cinco causas recurrentes y conviene revisarlas en este orden. Las tres primeras explican la enorme mayoría del tráfico de búsqueda que aterriza en el mensaje exacto de arriba.

1. **Desajuste de TargetFramework.** Tu consumidor es `net8.0` y el proyecto referenciado es `net11.0`, o el consumidor es `netstandard2.0` y el proyecto referenciado es `net8.0`. MSBuild hace lo correcto aquí y se niega a conectar la referencia, pero la advertencia que emite (`NU1201` desde NuGet o `NETSDK1005` desde el SDK) es fácil de pasar por alto en la salida del build. El error de C# que se dispara a continuación es CS0246, que es el síntoma que notaste.
2. **`obj/` y `bin/` obsoletos.** Las compilaciones incrementales en MSBuild son agresivas. Después de editar un `.csproj`, el archivo de assets (`obj/project.assets.json`) y los archivos de respuesta (`obj/*.csproj.AssemblyReference.cache`) pueden discrepar con el nuevo grafo. Roslyn compila contento contra el conjunto antiguo de referencias y obtienes CS0246 para un tipo que sí existe en disco.
3. **Directiva `using` ausente.** Añadiste la referencia correctamente, el tipo existe y la compilación está limpia, pero el sitio de llamada no importa el espacio de nombres. Con `ImplicitUsings` habilitado esto es raro para la BCL, pero es la regla para tus propios espacios de nombres. La pista del compilador al final de CS0246, `(are you missing a using directive or an assembly reference?)`, lista esta opción primero por algo.
4. **El proyecto no está en la solución.** Visual Studio y `dotnet build <solución>` solo compilan proyectos que el archivo `.sln` conoce. Puedes añadir un `ProjectReference` a un `.csproj` que no esté en la solución, y el consumidor fallará al encontrar el tipo porque el productor nunca se compiló. `dotnet build <consumer.csproj>` tiene éxito porque recorre el grafo de proyectos directamente; el IDE falla porque recorre la solución.
5. **`ReferenceOutputAssembly="false"` o `PrivateAssets="all"` en la referencia.** Ambos son items de metadatos legítimos, usados para suprimir el flujo transitivo o para pasar referencias solo de build como analizadores, pero cada uno le indica a MSBuild que no añada el ensamblado producido a la lista de referencias del compilador. El IDE suele mostrar el proyecto como referenciado en el Explorador de Soluciones, lo que vuelve a este caso el más lento de detectar.

Hay causas de menor incidencia que conviene nombrar para descartarlas por inspección: un sistema de archivos sensible a mayúsculas (Linux, macOS) donde la directiva `using` no coincide exactamente en mayúsculas con el espacio de nombres; un ItemGroup `Conditional` que excluye la referencia para la `Configuration` o el `TargetFramework` actual; un consumidor multi-target (`<TargetFrameworks>net8.0;net11.0</TargetFrameworks>`) en el que solo una de las compilaciones internas toma la referencia; y un global.json que fija una versión del SDK más antigua que el mínimo del `TargetFramework` del consumidor.

## El error en contexto

Así se ve la salida del build cuando la causa es el desajuste de TargetFramework. Presta atención a las líneas anteriores al CS0246, no al CS0246 en sí:

```text
warning NU1201: Project Domain is not compatible with net8.0 (.NETCoreApp,Version=v8.0). Project Domain supports: net11.0 (.NETCoreApp,Version=v11.0)
warning MSB3277: Found conflicts between different versions of "System.Runtime" that could not be resolved.
error CS0246: The type or namespace name 'OrderService' could not be found (are you missing a using directive or an assembly reference?) [C:\src\Api\Api.csproj]
```

`NU1201` es la pista decisiva. El paso de restore de NuGet encontró el proyecto pero lo rechazó porque su conjunto de target frameworks no contiene nada que el consumidor pueda consumir. El compilador entonces se ejecutó con una referencia vacía para ese proyecto. El CS0246 es un efecto secundario, no el bug.

## Reproducción mínima

La configuración de dos proyectos más pequeña que reproduce el desajuste de TargetFramework. Guárdalos como `Domain/Domain.csproj` y `Api/Api.csproj`:

```xml
<!-- Domain/Domain.csproj - .NET 11 preview 4 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

```xml
<!-- Api/Api.csproj - .NET 8 LTS consumer of a net11.0 library -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Domain\Domain.csproj" />
  </ItemGroup>
</Project>
```

```csharp
// Domain/OrderService.cs - .NET 11 preview 4
namespace MyApp.Domain;

public sealed class OrderService
{
    public string Greet(int id) => $"order-{id}";
}
```

```csharp
// Api/Program.cs - .NET 8 LTS
using MyApp.Domain;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<OrderService>();

var app = builder.Build();
app.MapGet("/", (OrderService svc) => svc.Greet(1));
app.Run();
```

Ejecuta `dotnet build Api/Api.csproj` y obtendrás el par de errores exacto de la sección anterior. El CS0246 es aparatoso; la advertencia `NU1201` justo arriba es la falla real.

## Solución uno: alinea los valores de TargetFramework

El movimiento más seguro es actualizar el consumidor en lugar de bajar la biblioteca, porque bajar normalmente pierde APIs:

```xml
<!-- Api/Api.csproj - now .NET 11 to match the library -->
<TargetFramework>net11.0</TargetFramework>
```

Si no puedes mover el consumidor, multi-target la biblioteca para que envíe un ensamblado para ambos:

```xml
<!-- Domain/Domain.csproj -->
<TargetFrameworks>net8.0;net11.0</TargetFrameworks>
```

Para bibliotecas genuinamente neutras al framework, `netstandard2.0` sigue siendo el target más amplio y es consumible desde .NET Framework 4.7.2+, Mono, Unity y todo .NET moderno. Elige `netstandard2.0` solo cuando la superficie de la API quepa en él; si no, multi-targeting `net8.0` + `net11.0` es la opción más limpia en 2026.

Una nota sobre `<TargetFrameworks>` con un solo valor: escribe `<TargetFramework>` (singular). MSBuild los trata como propiedades distintas, y un proyecto con `<TargetFrameworks>net8.0</TargetFrameworks>` compila a `bin/<config>/net8.0/` en vez de `bin/<config>/`, lo que rompe silenciosamente herramientas downstream que asumen el layout plano.

## Solución dos: borra `obj/` y `bin/` después de editar el `.csproj`

Si los frameworks coinciden pero el error persiste, la caché del build está obsoleta. Roslyn lee `obj/<project>.csproj.AssemblyReference.cache` y el `*.GeneratedMSBuildEditorConfig.editorconfig` por proyecto para cortocircuitar la resolución de referencias. Si editaste el `.csproj` para añadir el `ProjectReference` mientras una compilación previa sigue residente, la caché discrepa del nuevo grafo y el compilador se ejecuta contra la lista antigua de referencias.

El reset correcto en .NET 11 es `dotnet build --no-incremental` para una recompilación limpia puntual o, para el caso raro en que eso no baste, eliminar manualmente las carpetas de build:

```powershell
# .NET SDK 11.0.100-preview.4, PowerShell on Windows
Get-ChildItem -Path . -Include obj,bin -Recurse -Directory | Remove-Item -Recurse -Force
dotnet build
```

```bash
# .NET SDK 11.0.100-preview.4, bash on Linux/macOS
find . -type d \( -name obj -o -name bin \) -prune -exec rm -rf {} +
dotnet build
```

`dotnet clean` es deliberadamente conservador: elimina las salidas pero conserva el archivo de assets, lo que significa que no siempre cura esta clase de bug. Trátalo como un reset parcial, no completo. Si tienes un IDE abierto al mismo tiempo, ciérralo antes de borrar `obj/` porque en Windows el servicio de lenguaje mantiene handles de archivo abiertos y el borrado fallará en la mitad de los directorios.

## Solución tres: añade o corrige la directiva `using`

Una vez sana la referencia, el compilador puede encontrar el tipo pero todavía necesitas importar su espacio de nombres en el sitio de llamada. La solución es mecánica:

```csharp
// Api/Program.cs - .NET 11 preview 4
using MyApp.Domain;        // the namespace declared inside Domain/OrderService.cs
// using MyApp.Domain.Models; // for the CS0234 variant where you also need the nested namespace
```

Dos sutilezas muerden a los equipos en cada release. Primera, `<ImplicitUsings>enable</ImplicitUsings>` añade un conjunto fijo de espacios de nombres (`System`, `System.Collections.Generic`, `System.Linq`, `System.Net.Http`, `System.Threading`, `System.Threading.Tasks` y los extras específicos del SDK), pero no importa tus propios espacios de nombres. Segunda, desde C# 10 puedes declarar global usings para rellenar ese hueco:

```xml
<!-- Api/Api.csproj - .NET 11 preview 4 -->
<ItemGroup>
  <Using Include="MyApp.Domain" />
</ItemGroup>
```

Esto emite un archivo `GlobalUsings.g.cs` en `obj/` y ahorra la línea `using` por archivo en todas partes donde se consuma `OrderService`. El precio es que los global usings hacen las refactorizaciones más ruidosas: un typo en un espacio de nombres global rompe el proyecto entero, y una biblioteca eliminada ahora se esconde como una sola edición de MSBuild en lugar de una ola de subrayados rojos. Úsalos con criterio, no por reflejo.

## Solución cuatro: confirma que el proyecto está en la solución

`dotnet sln list` es la forma más rápida de verificarlo. Si tu consumidor es `Api/Api.csproj` y tu biblioteca es `Domain/Domain.csproj`, ambos deben aparecer en el `.sln`:

```bash
# .NET SDK 11.0.100-preview.4
dotnet sln list
# Project(s)
# ----------
# Api\Api.csproj
# Domain\Domain.csproj   <-- must be here
```

Si `Domain` falta, el IDE parecerá conocerlo (porque el `ProjectReference` lo resuelve en disco), pero los builds con alcance de solución lo saltan y luego una recompilación de un solo proyecto falla porque el `obj/project.assets.json` del consumidor referencia un ensamblado que nadie produjo. Añade el proyecto faltante:

```bash
dotnet sln add Domain/Domain.csproj
```

Esta trampa es más común en 2026 de lo que era cuando aterrizaron `slnx` y el nuevo formato ligero de solución en el SDK de .NET 11. La CLI tolera compilar una solución que lista proyectos con grafos de referencia disjuntos, y los servicios de lenguaje en Visual Studio 2026 y Rider 2026.1 han mejorado al advertir cuando un proyecto referenciado está fuera de la solución activa. Si estás en un SDK más antiguo, la advertencia es silenciosa. Para la ergonomía de archivos de solución en general, la nueva CLI vale la pena revisar: ver [las mejoras de la dotnet sln CLI en .NET 11](/es/2026/04/dotnet-11-sln-cli-solution-filters/).

## Solución cinco: revisa `ReferenceOutputAssembly` y `PrivateAssets`

Algunas referencias deliberadamente no se propagan al compilador. Los dos items de metadatos a revisar en el `ProjectReference` son:

```xml
<!-- Will NOT add Domain.dll to the compiler's reference list -->
<ProjectReference Include="..\Domain\Domain.csproj"
                  ReferenceOutputAssembly="false" />

<!-- Will not flow transitively to projects that consume the consumer -->
<ProjectReference Include="..\Domain\Domain.csproj"
                  PrivateAssets="all" />
```

`ReferenceOutputAssembly="false"` es correcto cuando el proyecto referenciado es una herramienta de tiempo de build (un generador de código, un host de analizadores) cuya salida quieres secuenciar en el grafo de build pero cuyo ensamblado no consumes. Si está puesto en tu referencia real de biblioteca, el consumidor falla con CS0246 aunque el grafo de build esté sano.

`PrivateAssets="all"` es el caso simétrico para referencias transitivas. Si `Api` referencia a `Bff`, y `Bff` referencia a `Domain` con `PrivateAssets="all"`, entonces `Api` no puede ver los tipos de `Domain` aunque `Bff` sí. La pista está en el proyecto que consume, no en el que produce.

## Variantes que se parecen al mismo error

Un puñado de errores cercanos se confunden con CS0246 en los resultados de búsqueda:

- **`CS1069`: The type name 'X' could not be found in the namespace 'Y'. This type has been forwarded to assembly 'Z'.** Falta un type-forwarder. Añade el ensamblado nombrado en el mensaje. Es más común con `System.Configuration.ConfigurationManager` y `System.Drawing.Common` en .NET moderno.
- **`CS8073` / `CS0518`: Predefined type 'System.Object' is not defined or imported.** La referencia implícita a `System.Runtime` está rota. Casi siempre un `obj/` corrupto o un `<Reference>` escrito a mano que excluye el framework. `dotnet build --no-incremental` es lo primero a probar.
- **`CS0433`: The type 'X' exists in both 'A' and 'B'.** Dos ensamblados exponen el mismo tipo. Se resuelve con un alias en el `ProjectReference` (`<ProjectReference Include="..." Aliases="domain" />`) y una directiva `extern alias` en el sitio de llamada.
- **`NETSDK1005`: Assets file '...' doesn't have a target for 'net8.0'.** La referencia es a un paquete NuGet compilado para un framework más alto que el del consumidor. Misma causa raíz que la Solución uno arriba, mensaje distinto porque el productor es un paquete, no un proyecto.
- **`MSB4181`: The "ResolvePackageAssets" task returned false but did not log an error.** Una falla genuina del restore; el grafo de paquetes es irresoluble. Borra la caché global `~/.nuget/packages/<name>/<version>/` para el paquete ofensor y restaura de nuevo. Trata esto como ortogonal a CS0246 aunque ambos coocurran a menudo.

## Cómo leer la salida del build para confirmar la solución

Sesga tu depuración hacia el log del build en vez de la lista de errores de C#. El compilador es el lugar equivocado donde empezar cuando la resolución de referencias está rota. Tres comandos justifican su uso:

```bash
# .NET SDK 11.0.100-preview.4
dotnet build -v:n Api/Api.csproj
```

`-v:n` (`-verbosity normal`) imprime la lista de referencias resueltas bajo `CoreCompile -> ResolveReferences`. Si tu biblioteca no está en esa lista, el compilador nunca la vio y tienes un problema de MSBuild, no de Roslyn.

```bash
dotnet build -bl Api/Api.csproj
```

`-bl` escribe un `msbuild.binlog` junto al proyecto. Ábrelo en el [MSBuild Structured Log Viewer](https://msbuildlog.com/) y busca `ResolveAssemblyReferences`. El visor muestra exactamente qué rutas de archivo entregó MSBuild a Roslyn, y por qué cada una se incluyó o se omitió.

```bash
dotnet msbuild Api/Api.csproj -t:ResolveReferences -p:DesignTimeBuild=false
```

Esto ejecuta el target de resolución de referencias aisladamente, sin invocar al compilador. La salida es concisa y te dice si la falla está en restore, en resolución o en compilación. CS0246 desaparece del ruido.

## Casos límite que atrapan a desarrolladores con experiencia

Algunos patrones reproducen CS0246 en código que se ve correcto a la vista:

- **`Directory.Packages.props` con `ManagePackageVersionsCentrally=true`.** Si olvidaste añadir una entrada `<PackageVersion>` para un paquete transitivo que tu biblioteca expone en su API, el consumidor no puede resolver el tipo desde la dependencia transitiva. El mensaje es CS0246, no el error de versión faltante que esperarías.
- **Multi-targeting con `Condition`.** `<ProjectReference Include="..." Condition="'$(TargetFramework)' == 'net11.0'" />` saltará la referencia para la compilación interna `net8.0` de un consumidor multi-target. El IDE muestra la referencia; el build de `net8.0` no ve el tipo.
- **`global.json` fijando un SDK al que le falta tu `TargetFramework`.** Si `global.json` selecciona el SDK 8.0.x y el proyecto apunta a `net11.0`, el restore reporta una advertencia benigna y el build falla con CS0246 para cada tipo de la biblioteca referenciada porque los packs del SDK no están instalados para `net11.0`.
- **Sensibilidad a mayúsculas en Linux.** `using MyApp.domain;` en vez de `using MyApp.Domain;` compila en Windows y falla CS0246 en CI en Linux. Añade `<EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>` y fija las mayúsculas con una regla `.editorconfig`.
- **Consumidores Native AOT.** Si `<PublishAot>true</PublishAot>` está puesto en el consumidor pero no en la biblioteca, el analizador AOT marca las advertencias de trim transitivas como errores y el build puede detenerse en un CS0246 downstream una vez que un tipo es podado. La solución es marcar la biblioteca como trim-safe, no silenciar al analizador. La misma disciplina de trim que cubre [el post sobre PlatformNotSupportedException en Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/) aplica aquí.

## Relacionado

- La siguiente excepción de resolución de referencias con la que los equipos topan después de esta es la variante en tiempo de ejecución que se cubre en [Unable to resolve service for type 'X' while attempting to activate 'Y'](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- Ergonomía del archivo de solución que hace esta clase de bug más fácil de detectar: [los cambios en la dotnet sln CLI en .NET 11](/es/2026/04/dotnet-11-sln-cli-solution-filters/).
- Los casos esquina de Native AOT que sacan CS0246 a la luz indirectamente vía trimming: [PlatformNotSupportedException en Native AOT](/es/2026/05/fix-platformnotsupportedexception-in-native-aot/).
- Una política de advertencias de build que evita que advertencias `NU1201` silenciosas se escondan bajo CI verde: [TreatWarningsAsErrors sin sabotear los builds de dev](/es/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).
- Cuando el tipo faltante es un valor de configuración y el mensaje es similar en espíritu: [no connection string named 'DefaultConnection' could be found](/es/2026/05/fix-no-connection-string-named-defaultconnection/).

## Fuentes

- Microsoft Learn, [Compiler Error CS0246](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0246).
- Microsoft Learn, [Compiler Error CS0234](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0234).
- Microsoft Learn, [MSBuild ProjectReference protocol](https://learn.microsoft.com/en-us/visualstudio/msbuild/common-msbuild-project-items#projectreference).
- Microsoft Learn, [Implicit using directives in .NET 6+](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/overview#implicit-using-directives).
- Microsoft Learn, [global.json overview](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json).
- MSBuild source, [`Microsoft.Common.CurrentVersion.targets`](https://github.com/dotnet/msbuild/blob/main/src/Tasks/Microsoft.Common.CurrentVersion.targets), where `ResolveProjectReferences` lives.
