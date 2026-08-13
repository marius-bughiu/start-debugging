---
title: "Solución: 404 Not Found para blazor.server.js después de instalar un nuevo SDK de .NET"
description: "blazor.server.js devuelve 404 en .NET 10 porque el script dejó de ser un recurso incrustado. Agrega RequiresAspNetWebAssets al proyecto host, o asegúrate de que tenga un archivo .razor."
pubDate: 2026-08-13
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnet-core"
  - "dotnet-10"
  - "dotnet-11"
  - "static-web-assets"
lang: "es"
translationOf: "2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk"
translatedBy: "claude"
translationDate: 2026-08-13
---

Agrega `<RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>` al proyecto host y ejecuta el restore. En .NET 10 el script de Blazor dejó de ser un recurso incrustado en `Microsoft.AspNetCore.Components.Server` y pasó a ser un archivo del paquete NuGet `Microsoft.AspNetCore.App.Internal.Assets`, que el SDK solo incorpora cuando el proyecto contiene al menos un archivo `.razor`. Sin archivo `.razor` en el host, no hay script: 404. Todo lo que sigue se midió con el SDK 10.0.201 y ASP.NET Core 10.0.5 en Windows 11.

## El error en contexto

La consola del navegador, desde un `_Host.cshtml` que funcionaba sin cambios desde .NET 6:

```
GET https://localhost:5001/_framework/blazor.server.js net::ERR_ABORTED 404 (Not Found)
Uncaught ReferenceError: Blazor is not defined
```

La página renderiza su HTML prerenderizado y luego no hace nada. No se abre ningún circuito, ningún botón funciona y el registro del servidor está en silencio porque un 404 del middleware de archivos estáticos no es una excepción. Lo mismo le pasa a `_framework/blazor.web.js` en una Blazor Web App.

Lo confuso es el disparador. El archivo de proyecto no cambió. Muy a menudo el target framework tampoco cambió. Alguien instaló el SDK de .NET 10, y una aplicación que compilaba y se ejecutaba ayer ahora devuelve un 404 para un solo archivo.

## Por qué desapareció el script

Hasta .NET 9, `blazor.server.js` era un recurso incrustado dentro del ensamblado del framework compartido, y `MapBlazorHub()` registraba un endpoint dedicado que lo leía de ese ensamblado. Ese endpoint no podía fallar al encontrar el archivo, porque el archivo estaba dentro de la DLL que registraba el endpoint.

.NET 10 lo eliminó. Javier Calvarro Nelson, del equipo de ASP.NET Core, [lo explicó sin rodeos](https://github.com/dotnet/aspnetcore/issues/64381#issuecomment-3546832403) cuando esto se reportó por primera vez:

"In 10.0, we stopped embedding the `server.js` and the `.web.js` files inside their respective assemblies so that we can compress and fingerprint them like any other files."

Es una mejora real. Ahora el script obtiene compresión Gzip en tiempo de compilación, Brotli al publicar, un hash de contenido en su URL y un `Cache-Control` inmutable de un año. Pero cambia de dónde viene el archivo. Ahora es un recurso web estático, entregado por un paquete NuGet que el SDK agrega a tu grafo de restore a tus espaldas. En mi máquina:

```
C:\Users\mariu\.nuget\packages\microsoft.aspnetcore.app.internal.assets\10.0.5\_framework\
  blazor.server.js
  blazor.server.js.map
  blazor.web.js
  blazor.web.js.map
  blazor.webassembly.js
  blazor.webassembly.js.map
```

La versión la fija el SDK, no tu proyecto. `Microsoft.NETCoreSdk.BundledVersions.props` en la instalación del SDK es quien decide:

```xml
<!-- C:\Program Files\dotnet\sdk\10.0.201\Microsoft.NETCoreSdk.BundledVersions.props -->
<KnownAspNetCorePack Include="Microsoft.AspNetCore.App.Internal.Assets"
                     TargetFramework="net10.0"
                     AspNetCorePackVersion="10.0.5" />
```

Y aquí está la parte que realmente causa el 404. El SDK no agrega ese paquete a todos los proyectos web, porque la mayoría de los proyectos web no son aplicaciones Blazor y nadie quiere que se descargue un script de Blazor en una minimal API. Lo adivina, con una sola heurística:

```xml
<!-- Sdks\Microsoft.NET.Sdk.Web.ProjectSystem\targets\Microsoft.NET.Sdk.Web.ProjectSystem.targets -->
<Target Name="ResolveRequiredWebAssets" BeforeTargets="ProcessFrameworkReferences">
  <PropertyGroup>
    <RequiresAspNetWebAssets
      Condition="'$(RequiresAspNetWebAssets)' == '' and @(Content->AnyHaveMetadataValue(Extension, .razor))">true</RequiresAspNetWebAssets>
  </PropertyGroup>
</Target>
```

Si el proyecto host tiene un archivo `.razor` en sus elementos `Content`, el paquete entra. Si no, `RequiresAspNetWebAssets` vuelve a su valor predeterminado `false`, el paquete nunca se restaura y `_framework/blazor.server.js` simplemente no está en el manifiesto de recursos web estáticos de la aplicación. No hay ninguna advertencia en tiempo de compilación. La compilación tiene éxito.

Muchas aplicaciones Blazor Server reales no tienen ningún archivo `.razor` en el proyecto host. Si tus componentes viven en una Razor Class Library y el host no es más que `Program.cs`, `_Host.cshtml` y una referencia de proyecto, la heurística dice "esto no es una aplicación Blazor" y obtienes un 404.

## Reproducción mínima

Un host de ASP.NET Core que sirve componentes de Blazor Server desde una RCL. Nada exótico:

```xml
<!-- BzSrv.csproj, .NET 10, SDK 10.0.201 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\BzLib\BzLib.csproj" />
  </ItemGroup>
</Project>
```

```csharp
// Program.cs, .NET 10, ASP.NET Core 10.0.5
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorPages();
builder.Services.AddServerSideBlazor();

var app = builder.Build();
app.UseStaticFiles();
app.MapBlazorHub();
app.MapFallbackToPage("/_Host");
app.Run();
```

```html
<!-- Pages/_Host.cshtml -->
<component type="typeof(App)" render-mode="ServerPrerendered" />
<script src="_framework/blazor.server.js"></script>
```

Compílalo y mira qué decidió el restore:

```bash
dotnet build
grep -o "Microsoft.AspNetCore.App.Internal.Assets/[0-9.]*" obj/project.assets.json
# (no output)
grep -c "blazor.server.js" bin/Debug/net10.0/BzSrv.staticwebassets.runtime.json
# 0
```

El paquete no está en el grafo de restore y el script no está en el manifiesto. Solicitarlo devuelve HTTP 404 con un cuerpo de cero bytes. Mueve un solo archivo `.razor` al proyecto host, o define la propiedad de abajo, y ambos conteos dejan de ser cero.

## La solución

**Define la propiedad en el proyecto host.** Esta es la vía de escape soportada y la que el equipo de ASP.NET Core recomienda. Va en el proyecto que usa `Microsoft.NET.Sdk.Web`, el que realmente atiende las solicitudes, no en la RCL:

```xml
<!-- BzSrv.csproj, .NET 10 / .NET 11 -->
<PropertyGroup>
  <RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>
</PropertyGroup>
```

Luego ejecuta el restore, porque el paquete entra en el grafo durante el restore, no durante la compilación:

```bash
dotnet restore
```

`dotnet build` ejecuta un restore implícito, así que una recompilación normal suele bastar. Un paso de CI que ejecute `dotnet build --no-restore` contra un restore hecho antes de agregar la propiedad, no. Después del cambio, las dos comprobaciones dan positivo y el archivo se sirve con 164 838 bytes.

**O agrega un archivo `.razor` al host.** Mover `App.razor` (o cualquier componente) de vuelta al proyecto host satisface la heurística sin ninguna propiedad de MSBuild. Está bien si de todos modos ibas a tener uno, pero es una razón extraña para mover código, y la propiedad expresa mejor la intención.

**No recurras a `MapStaticAssets()`.** Este es el consejo equivocado más común sobre este error, y vale la pena ser específico porque hace perder horas. Migrar un pipeline que funciona a `MapStaticAssets()` no arregla un paquete faltante, y `UseStaticFiles()` nunca fue el problema. El equipo [cerró un PR de la comunidad](https://github.com/dotnet/aspnetcore/pull/66060#issuecomment-5068880296) que se basaba en ese diagnóstico:

"`blazor.web.js` and `blazor.server.js` are shipped as static web assets, and `app.UseStaticFiles()` already serves them without `MapStaticAssets()` (this is what our own server-side Blazor E2E tests exercise, using `UseStaticFiles()` and `MapBlazorHub()` with no `MapStaticAssets()` call)."

Eso coincide con lo que medí. Con el paquete presente, `UseStaticFiles()` y `MapBlazorHub()` sirven el script en Development y desde la salida publicada, sin `MapStaticAssets()` por ninguna parte.

## Qué devuelve realmente cada configuración

Nueve ejecuciones contra la misma reproducción, cada una una solicitud HTTP a `/_framework/blazor.server.js` sobre un proceso Kestrel real:

| Proyecto host | Pipeline | Entorno | Ejecutando desde | Resultado |
| --- | --- | --- | --- | --- |
| con `.razor` | `UseStaticFiles()` | Development | `dotnet run` | 200, 164838 bytes |
| con `.razor` | `UseStaticFiles()` | Development | salida de compilación | 200 |
| con `.razor` | `UseStaticFiles()` | Production | salida de compilación | **404** |
| con `.razor` | `UseStaticFiles()` | Production | salida publicada | 200 |
| con `.razor` | `MapStaticAssets()` | Development | salida de compilación | 200 |
| con `.razor` | `MapStaticAssets()` | Production | salida de compilación | **500** |
| sin `.razor` | `UseStaticFiles()` | Development | salida de compilación | **404** |
| sin `.razor`, propiedad definida | `UseStaticFiles()` | Development | salida de compilación | 200 |
| `EnableDefaultContentItems=false` | cualquiera | cualquiera | cualquiera | el paquete nunca se restaura |

Dos filas merecen su propia explicación.

**Production contra la salida de compilación devuelve 404 incluso cuando el proyecto está bien configurado.** `WebApplication.CreateBuilder` solo llama a `UseStaticWebAssets()` en el entorno Development. En Development, el manifiesto de recursos web estáticos mapea `_framework/` directamente a la carpeta de la caché NuGet mostrada antes. En cualquier otro entorno ese mapeo no se aplica, y la salida de compilación no tiene su propio `wwwroot/_framework/`, así que no hay nada que servir. La salida publicada funciona porque `dotnet publish` copia los archivos reales (más las variantes `.gz` y `.br`) a `wwwroot/_framework/`. Esto muerde en pruebas de humo de CI e imágenes de contenedor que ejecutan la salida de `dotnet build` con `ASPNETCORE_ENVIRONMENT=Staging`. No es nuevo en .NET 10, pero antes de .NET 10 el endpoint de recurso incrustado lo ocultaba para este archivo en particular.

**La misma configuración bajo `MapStaticAssets()` devuelve 500, no 404**, lo cual es un diagnóstico útil. El endpoint se registra desde `BzSrv.staticwebassets.endpoints.json`, que se copia al directorio de salida y se lee independientemente del entorno, así que el routing coincide. El proveedor de archivos entonces no puede producir los bytes:

```
System.IO.FileNotFoundException: Could not find file '...\BzSrv\wwwroot\_framework\blazor.server.js'.
   at System.IO.FileInfo.get_Length()
   at Microsoft.AspNetCore.Builder.StaticAssetDevelopmentRuntimeHandler...
```

Un 500 con esa traza significa que el manifiesto conoce el script y el proveedor de archivos no puede alcanzarlo, así que el paquete está bien y tu entorno o directorio de salida está mal. Un 404 seco significa que el manifiesto nunca lo tuvo, así que falta el paquete y `RequiresAspNetWebAssets` es tu solución.

## Trampas y falsos parecidos

**`EnableDefaultContentItems=false` desactiva la heurística en silencio.** La condición de MSBuild prueba elementos `Content`, no archivos en disco. Un proyecto host con `App.razor` justo al lado de `Program.cs` sigue sin restaurar el paquete si los globs de contenido predeterminados están desactivados. Verificado: mismo proyecto, mismo archivo, paquete ausente. Define la propiedad explícitamente en cualquier proyecto que personalice sus elementos de contenido.

**Un proyecto `Microsoft.NET.Sdk.Razor` nunca se autodetecta.** El target `ResolveRequiredWebAssets` se distribuye únicamente en `Microsoft.NET.Sdk.Web.ProjectSystem.targets`. Si tu host usa el SDK de Razor, o define `<OutputType>Library</OutputType>`, nada define `RequiresAspNetWebAssets` por ti sin importar cuántos componentes contenga. Esa es la forma reportada en [dotnet/aspnetcore#64545](https://github.com/dotnet/aspnetcore/issues/64545). Define la propiedad a mano.

**`packages.lock.json` convierte la solución en un fallo de compilación.** Agregar la propiedad cambia el grafo de restore, así que un restore bloqueado lo rechaza con un mensaje exacto que conviene reconocer:

```
error NU1004: The package references have changed for net10.0. Lock file's package references: None,
project's package references: Microsoft.AspNetCore.App.Internal.Assets >= 10.0.5. The packages lock
file is inconsistent with the project dependencies so restore can't be run in locked mode.
```

Regenera el archivo de bloqueo una vez y súbelo al repositorio:

```bash
dotnet restore --force-evaluate
```

**El restore tiene que poder alcanzar el paquete.** Es un paquete real de nuget.org, no algo incluido en la instalación del SDK. Las compilaciones aisladas de la red y los feeds privados sin réplica del upstream no lo encontrarán, y la versión del SDK, no tu target framework, decide qué versión se solicita. Instala un nuevo parche del SDK y tu feed offline necesitará una nueva versión de `Microsoft.AspNetCore.App.Internal.Assets` que coincida.

**Si la carpeta del paquete desaparece, la aplicación no devuelve 404: no arranca.** Limpiar la caché NuGet mientras queda salida de compilación obsoleta te da esto al iniciar, antes de que Kestrel haga el bind:

```
Unhandled exception. System.IO.DirectoryNotFoundException: ...\microsoft.aspnetcore.app.internal.assets\10.0.5\_framework\
   at Microsoft.AspNetCore.Hosting.StaticWebAssets.StaticWebAssetsLoader.UseStaticWebAssetsCore(...)
   at Microsoft.AspNetCore.Builder.WebApplication.CreateBuilder(String[] args)
```

El manifiesto en `bin` guarda una ruta absoluta hacia la caché de paquetes. Borra `bin` y `obj`, y recompila.

**Una aplicación de .NET 9 puede caer en esto sin haber sido actualizada.** [dotnet/aspnetcore#65353](https://github.com/dotnet/aspnetcore/issues/65353) es una aplicación Blazor `net9.0` que empezó a devolver 404 en cuanto se instaló el SDK de .NET 10. La causa fue `DOTNET_ROLL_FORWARD=LatestMajor` en el entorno: la aplicación estaba haciendo roll forward al runtime 10.0, donde el script ya no está incrustado, mientras seguía compilándose como proyecto de .NET 9 que nunca restaura el paquete. Revisa `dotnet --info` buscando esa variable antes de tocar el archivo de proyecto. Ejecútala en el runtime 9.0 y el recurso incrustado sigue ahí y todo funciona, con SDK de .NET 10 o sin él.

**La documentación se queda corta sobre el alcance.** El [artículo sobre la estructura de proyecto de Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0) dice que el archivo `.razor` hace falta "in order to automatically include the Blazor script when the app is published". También afecta a `dotnet build`: la reproducción de arriba devuelve 404 bajo `dotnet run` en Development, mucho antes de que nadie publique nada.

**Esto no cambia en .NET 11.** El modelo de entrega de recursos estáticos y la propiedad `RequiresAspNetWebAssets` se mantienen, y la página de documentación de arriba aplica igual a los monikers `aspnetcore-10.0` y `aspnetcore-11.0`. Actualizar más allá de 10 no elimina el requisito.

## Relacionado

Si estás en medio de una actualización y esto es una de varias cosas que se rompieron a la vez, los puntos de Blazor están reunidos en la [lista de verificación de .NET 8 a .NET 11](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), y el lado de los render modes del mismo movimiento está en [migrar una aplicación Blazor Server a Blazor United](/es/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/). Una vez que el script carga y se abre un circuito de verdad, los dos siguientes fallos con los que la gente se topa son [el banner de reconexión tras desconectarse un circuito](/es/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/) y [las llamadas de interoperabilidad con JavaScript que no se pueden emitir durante el prerenderizado](/es/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/). Si estás decidiendo si el host debería seguir alojando componentes, [Blazor Server vs WebAssembly vs United](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) cubre el compromiso.

## Fuentes

- [ASP.NET Core Blazor project structure](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0), por la propiedad `RequiresAspNetWebAssets` y la regla del al-menos-un-archivo-`.razor`.
- [ASP.NET Core Blazor static files](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0), por `MapStaticAssets` frente a `UseStaticFiles` y qué puede y qué no puede servir cada uno.
- [dotnet/aspnetcore#64381](https://github.com/dotnet/aspnetcore/issues/64381), el reporte original, con la explicación del equipo sobre por qué los scripts dejaron de ser recursos incrustados.
- [dotnet/aspnetcore#66175](https://github.com/dotnet/aspnetcore/issues/66175), el mismo 404 en el SDK 10.0.201 tras actualizar una aplicación Blazor Server, cerrado al agregar la propiedad.
- [dotnet/aspnetcore#66059](https://github.com/dotnet/aspnetcore/issues/66059) y [el PR que propuso](https://github.com/dotnet/aspnetcore/pull/66060), por qué se rechazó volver a agregar los antiguos endpoints de recurso incrustado y la confirmación de que `UseStaticFiles()` sirve estos archivos hoy.
- [dotnet/aspnetcore#65353](https://github.com/dotnet/aspnetcore/issues/65353), por la variante de roll forward que rompe aplicaciones `net9.0` tras instalar el SDK.
- [dotnet/aspnetcore#64545](https://github.com/dotnet/aspnetcore/issues/64545), por la variante de `OutputType` / SDK no-Web.
