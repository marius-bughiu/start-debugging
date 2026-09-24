---
title: "Solución: Conflicting assets with the same target path después de actualizar al SDK de .NET 10"
description: "En el SDK de .NET 10 todo proyecto Microsoft.NET.Sdk.Web recibe StaticWebAssetBasePath=/, así que una aplicación web que referencia otra aplicación web colisiona. Define la ruta base en el proyecto referenciado. Desactivar la compresión no ayuda."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "aspnet-core"
  - "blazor"
  - "dotnet-10"
  - "msbuild"
  - "static-web-assets"
lang: "es"
translationOf: "2026/09/fix-conflicting-assets-with-the-same-target-path-in-aspnetcore-10"
translatedBy: "claude"
translationDate: 2026-09-24
---

Agrega `<StaticWebAssetBasePath>_content/$(MSBuildProjectName)</StaticWebAssetBasePath>` al proyecto **referenciado**, aquel cuyo `wwwroot` antes aparecía bajo `/_content/...`. Desde el SDK de .NET 10, todo proyecto `Microsoft.NET.Sdk.Web` recibe una ruta base de `/`, así que cuando una aplicación web referencia otra, ambas publican `css/site.css` en la misma URL y el pipeline de static web assets se niega a compilar. Desactivar la compresión no sirve de nada, porque la comprobación se ejecuta antes de la compresión. Todo lo que sigue se midió con el SDK 10.0.302 y el SDK 9.0.318 en macOS.

## El error en contexto

El mensaje completo es largo, porque vuelca los dos registros de assets. Recortado a las partes que necesitas leer:

```text
Microsoft.NET.Sdk.StaticWebAssets.targets(640,5): error : Conflicting assets with the same target path
'css/site#[.{fingerprint}]?.css'. For assets
'Identity: .../Common/wwwroot/css/site.css, SourceType: Project, SourceId: Common, ContentRoot: .../Common/wwwroot/,
 BasePath: /, RelativePath: css/site#[.{fingerprint}]?.css, ...' and
'Identity: .../Main/wwwroot/css/site.css, SourceType: Discovered, SourceId: Main, ContentRoot: .../Main/wwwroot/,
 BasePath: /, RelativePath: css/site#[.{fingerprint}]?.css, ...' from different projects.
```

Tres campos te dicen en qué caso estás:

- **`SourceId`** nombra los dos proyectos que producen el asset. Dos ids distintos significan una colisión entre proyectos.
- **`SourceType`** es `Discovered` para el proyecto que se está compilando, `Project` para una referencia de proyecto y `Package` para un paquete NuGet.
- **`BasePath`** es el prefijo de la URL. Si el proyecto referenciado muestra `BasePath: /` en lugar de `_content/<Name>`, estás ante el cambio de .NET 10 que se describe más abajo.

La ruta de destino a veces termina en `.gz` o `.br`, por eso este error suele atribuirse a la compresión en tiempo de compilación que llegó con .NET 9. En el SDK actual, esa rara vez es la causa real.

## Por qué ocurre en el SDK de .NET 10

Los static web assets deciden en tiempo de compilación qué archivo responde a qué URL, y el manifiesto solo puede asignar un archivo a una ruta. Antes de .NET 10, un proyecto web *referenciado* por otro proyecto web se comportaba como una biblioteca de clases: el SDK asignaba por defecto a su `StaticWebAssetBasePath` el valor `_content/$(PackageId)`, así que su `wwwroot/css/site.css` se convertía en `/_content/Common/css/site.css` dentro del host y nada colisionaba.

El SDK de .NET 10 cambió `Sdk.Server.props`, el archivo de props que importa todo proyecto `Microsoft.NET.Sdk.Web`, para definir esto de forma incondicional:

```xml
<!-- SDK 10.0.302: Sdks/Microsoft.NET.Sdk.Web/Targets/Sdk.Server.props -->
<PropertyGroup>
  <DebugSymbols Condition="'$(DebugSymbols)' == ''">true</DebugSymbols>
  <StaticWebAssetProjectMode>Root</StaticWebAssetProjectMode>
  <StaticWebAssetBasePath>/</StaticWebAssetBasePath>
</PropertyGroup>
```

El mismo archivo en el SDK 9.0.318 no define ninguna de las dos propiedades. El valor por defecto `_content/$(PackageId)` en `Microsoft.NET.Sdk.StaticWebAssets.targets` solo se aplica cuando `StaticWebAssetBasePath` está vacío, y en el SDK 10 nunca lo está para un proyecto web. Ambas aplicaciones web reclaman ahora `/`, y cada archivo que existe en la misma ruta relativa en las dos carpetas `wwwroot` es un conflicto.

La postura del equipo de ASP.NET Core, según [dotnet/aspnetcore#62138](https://github.com/dotnet/aspnetcore/issues/62138), es que una aplicación web que referencia otra aplicación web nunca fue una forma soportada: "Only class libraries or Blazor apps can be referenced by webapps in a supported capacity." El issue se cerró sin cambios en el código y, a día de hoy, el cambio no aparece ni en la [página de cambios importantes de .NET 10](https://learn.microsoft.com/en-us/dotnet/core/compatibility/10) ni en la [página de cambios importantes de ASP.NET Core 10](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/overview). Por eso tantas actualizaciones se topan con él sin aviso.

Es el **SDK** el que decide esto, no tu target framework. Un proyecto `net8.0` o `net9.0` falla de la misma forma en cuanto se compila con el SDK 10.x, que es lo que reportó [dotnet/aspnetcore#64726](https://github.com/dotnet/aspnetcore/issues/64726) para una aplicación `netcoreapp8.0`.

## Reproducción mínima

Dos aplicaciones web vacías, cada una con su propio `wwwroot/css/site.css`, una referenciando a la otra:

```bash
# SDK 10.0.302
dotnet new web -o Main -n Main
dotnet new web -o Common -n Common
mkdir -p Main/wwwroot/css Common/wwwroot/css
echo "body{color:red}/*Main*/"   > Main/wwwroot/css/site.css
echo "body{color:red}/*Common*/" > Common/wwwroot/css/site.css
dotnet add Main/Main.csproj reference Common/Common.csproj
dotnet build Main
```

Resultados medidos para exactamente este par de proyectos:

| SDK | TargetFramework | Resultado |
| --- | --- | --- |
| 9.0.318 | net9.0 | La compilación tuvo éxito. Rutas: `css/site.css`, `_content/Common/css/site.css` |
| 10.0.302 | net9.0 | `Conflicting assets with the same target path 'css/site#[.{fingerprint}]?.css'` |
| 10.0.302 | net10.0 | El mismo error |
| 10.0.302 | net10.0, `-p:DisableBuildCompression=true` | El mismo error |
| 10.0.302 | net10.0, `-p:CompressionEnabled=false` | El mismo error |
| 10.0.302 | net10.0, después de `rm -rf */bin */obj` | El mismo error |

Las tres últimas filas son las que vale la pena recordar. El consejo que aparece primero en los resultados de búsqueda para este error es desactivar la compresión o borrar `bin` y `obj`. Ninguna de las dos cosas cambia nada para esta causa. El conflicto lo lanza `GenerateStaticWebAssetsManifest` en la línea 640 del archivo de targets, que se ejecuta esté o no habilitada la compresión.

## Solución: devuélvele al proyecto referenciado su antigua ruta base

Coloca la propiedad en el csproj del proyecto que se referencia (`Common` en este caso), no en el host:

```xml
<!-- Common.csproj, SDK 10.0.302 -->
<Project Sdk="Microsoft.NET.Sdk.Web">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <StaticWebAssetBasePath>_content/$(MSBuildProjectName)</StaticWebAssetBasePath>
  </PropertyGroup>

</Project>
```

Definirla en el archivo de proyecto funciona porque el SDK establece `/` en un archivo de props, que se evalúa antes del cuerpo de tu proyecto, así que tu valor gana. Después del cambio, `dotnet build Main` tiene éxito y `Main.staticwebassets.endpoints.json` contiene ambos conjuntos de rutas:

```text
_content/Common/css/site.css
_content/Common/css/site.css.gz
css/site.css
css/site.css.gz
(plus the fingerprinted variants of each)
```

Ejecuté el host con `app.MapStaticAssets()` y solicité ambas URLs. `/css/site.css` devolvió el archivo de `Main` y `/_content/Common/css/site.css` devolvió el archivo de `Common`, cada uno con `Content-Encoding: gzip` cuando la solicitud lo permitía. Así que las variantes comprimidas se generan por proyecto exactamente como antes.

La ruta base solo se aplica a los consumidores. Ejecuté `Common` por sí solo después del cambio y `/css/site.css` siguió devolviendo 200, mientras que `/_content/Common/css/site.css` devolvió 404. Un proyecto que es a la vez una aplicación independiente y una referencia sigue funcionando en ambos roles.

### No uses `$(PackageId)` aquí

La forma obvia de recrear el antiguo valor por defecto es `_content/$(PackageId)`, ya que es lo que el SDK calculaba antes. No funciona desde el csproj. `PackageId` se asigna más tarde, en los targets de NuGet, así que en el momento en que se evalúa tu `PropertyGroup` todavía está vacío. Lo probé: la compilación tuvo éxito, pero las rutas se convirtieron en `_content/css/site.css`. Eso rompe en silencio cada `<link href="_content/Common/...">` de tus vistas mientras parece una solución. Usa `$(MSBuildProjectName)`, o escribe el nombre literalmente si tu `AssemblyName` difiere del nombre del archivo de proyecto y tu marcado usa el nombre del ensamblado.

### Mejor: deja de referenciar una aplicación web

Si `Common` existe solo para compartir vistas Razor, componentes y archivos de `wwwroot`, conviértelo en una biblioteca de clases Razor (`Microsoft.NET.Sdk.Razor`). Esa es la forma soportada, recibe `_content/{PackageId}` por defecto y es como la [documentación de archivos estáticos de Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0) describe cómo compartir assets. Reserva la propiedad de ruta base para los casos en que el proyecto referenciado realmente tenga que ejecutarse también como aplicación, como un host de pruebas de integración basado en `Microsoft.NET.Sdk.Web` que referencia la aplicación real.

## El mismo archivo en dos proyectos de una Blazor Web App

El segundo desencadenante habitual no tiene nada que ver con referencias entre aplicaciones web. En una Blazor Web App con WebAssembly interactivo, el proyecto de servidor y el proyecto `.Client` contribuyen ambos a `/`. Eso es por diseño: los assets del cliente se sirven desde la raíz del host.

Así que un archivo que existe en ambas carpetas `wwwroot` colisiona. Lo reproduje con la plantilla `dotnet new blazor -int WebAssembly` en el SDK 10.0.302 copiando `favicon.png` en `W.Client/wwwroot`:

```text
Microsoft.NET.Sdk.StaticWebAssets.targets(640,5): error : Conflicting assets with the same target path
'favicon#[.{fingerprint}]?.png'. For assets 'Identity: .../W.Client/wwwroot/favicon.png, SourceType: Project, ...
```

Aquí la solución no es una ruta base. No quieres que los archivos del cliente se muevan bajo `_content/`. Mantén cada archivo en exactamente uno de los dos proyectos. Una regla útil: los assets que solo necesita el marcado renderizado en el servidor viven en el proyecto de servidor; los assets que el código WebAssembly carga en runtime viven en `.Client`. Si migraste desde la antigua plantilla hospedada de Blazor WebAssembly, donde el proyecto cliente era dueño de `index.html`, `favicon` y el CSS, este es el resto habitual. La [comparación de modelos de hospedaje de Blazor](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) explica por qué los dos proyectos comparten una raíz.

## Cuando la compresión sí es la causa

La compresión en tiempo de compilación llegó en .NET 9 y, durante las versiones preliminares de .NET 9, sí causaba este error. Paquetes como `Z.Blazor.Diagrams` 3.0.2 y algunas configuraciones de bundlers incluían sus propios archivos `.gz` en `wwwroot`. El SDK intentaba entonces generar `app.js.gz` para el mismo asset y colisionaba con el que ya estaba ahí ([dotnet/aspnetcore#57512](https://github.com/dotnet/aspnetcore/issues/57512), [dotnet/sdk#40413](https://github.com/dotnet/sdk/issues/40413)).

Eso se corrigió con [dotnet/aspnetcore#57518](https://github.com/dotnet/aspnetcore/issues/57518), cerrado en noviembre de 2024. El SDK actual ejecuta una tarea `DiscoverPrecompressedAssets` que reconoce un archivo hermano `.gz` o `.br` existente y lo trata como la variante comprimida en lugar de producir la suya. Comprobé ambos casos en el SDK 10.0.302:

- Una aplicación web con `wwwroot/js/app.js`, `app.js.gz` y `app.js.br` incluidos en el repositorio: la compilación y la publicación tienen éxito con cero advertencias. El manifiesto de endpoints asigna `js/app.js` a `js/app.js.gz` con un selector `gzip`, y el `app.js.gz` publicado es idéntico byte a byte al archivo que creé. Se sirve tu archivo, no uno regenerado.
- Una aplicación web que referencia `Z.Blazor.Diagrams` 3.0.2, el paquete de #57512: compila sin problemas.

Así que si estás en una versión preliminar del SDK 9.0.1xx, actualiza el SDK. Si todavía necesitas excluir archivos concretos de la compresión, por ejemplo porque un bundler ya escribe su propio `.br` con mejores ajustes, usa la lista de exclusión en lugar de desactivar la funcionalidad. Verifiqué esto en el SDK 10.0.302: después de publicar, `app.bundle.js` no tenía ningún hermano `.gz` ni `.br`, mientras que `other.js` en la misma carpeta tenía ambos.

```xml
<!-- Host .csproj, SDK 9.0.100 and later -->
<PropertyGroup>
  <CompressionExcludePatterns>$(CompressionExcludePatterns);**/*.bundle.js</CompressionExcludePatterns>
</PropertyGroup>
```

`DisableBuildCompression=true` omite la compresión solo para `dotnet build` (la publicación sigue comprimiendo), y `CompressionEnabled=false` elimina por completo los targets de compresión. Ambas opciones son razonables para acelerar la compilación. Ninguna corrige una colisión de ruta base, como muestra la tabla anterior. La compresión de respuestas en runtime es, a su vez, otra funcionalidad distinta; consulta [cómo agregar compresión de respuestas a una API de ASP.NET Core](/es/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) para ese lado.

## Trampas y errores parecidos

**"Two assets found targeting the same path with incompatible asset kinds" es un error distinto.** Aparece dentro de un *único* proyecto, por ejemplo cuando un elemento `<Content Include="shared/app.js" Link="wwwroot/js/app.js" />` apunta a la misma ruta que un `wwwroot/js/app.js` real. Lo reproduje en el SDK 10.0.302 desde la línea 706 del mismo archivo de targets. Elimina uno de los dos elementos.

**`The "DiscoverPrecompressedAssets" task failed unexpectedly` con `An item with the same key has already been added`** es un bug relacionado de .NET 10, también desencadenado por un proyecto web que referencia otro, a menudo con la clave apuntando a `blazor.web.js` en `microsoft.aspnetcore.app.internal.assets`. Sigue abierto como [dotnet/sdk#52089](https://github.com/dotnet/sdk/issues/52089). La solución de ruta base de arriba es lo primero que debes probar, porque elimina el registro duplicado en su origen. Si además estás persiguiendo un script de Blazor que falta después de la actualización, ese paquete se explica en [el artículo sobre el 404 de blazor.server.js](/es/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/).

**Si el error aparece y desaparece entre compilaciones**, sospecha de un paso de compilación que escribe en `wwwroot` (TypeScript, LibMan, un bundler de JS) mientras los targets de static web assets lo están leyendo. [dotnet/sdk#52014](https://github.com/dotnet/sdk/issues/52014) documenta una condición de carrera que se manifiesta como este error, `No file exists for the asset` o `The asset ... can not be found`. También se reproduce con un único target framework. La solución fiable es ejecutar el generador como un paso propio antes de MSBuild (`npm run build && dotnet build` en CI y en tu perfil de inicio) en lugar de desde un target `BeforeTargets="Build"`, para que los archivos ya estén en disco cuando el SDK evalúa el glob de `wwwroot`. Un binlog (`dotnet build -bl`) muestra el orden; el [servidor MCP para binlogs](/es/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/) es una forma rápida de consultarlo.

**Fijar el SDK 9 con `global.json` funciona, pero solo como solución provisional.** La reproducción compila bien en 9.0.318 incluso con el SDK de .NET 10 instalado en paralelo. También significa que no puedes compilar proyectos `net10.0`, y deja la colisión real para más adelante. [dotnetup](/es/2026/06/dotnetup-official-dotnet-sdk-version-manager/) hace que cambiar de SDK sea barato si necesitas bisecar qué SDK introdujo un fallo en tu repositorio.

**El viejo target que "elimina todo StaticWebAsset `.gz`" está obsoleto.** El workaround de #57512 que borra los elementos `StaticWebAsset` con extensión `.gz` antes de `ResolveStaticWebAssetsConfiguration` era para las versiones preliminares de .NET 9. En el SDK 10 descarta archivos precomprimidos que el SDK ahora maneja correctamente, y no hace nada para el caso de la ruta base.

## Relacionado

- [Solución: 404 Not Found para blazor.server.js después de instalar un nuevo SDK de .NET](/es/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/), otro cambio de static web assets que llega con el SDK y no con el target framework.
- [Blazor Server vs Blazor WebAssembly vs Blazor United en .NET 11](/es/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/), para entender por qué los proyectos de servidor y `.Client` comparten `/`.
- [Cómo agregar compresión de respuestas a una API de ASP.NET Core 11](/es/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/), la contraparte en runtime de la compresión de assets en tiempo de compilación.
- [Un servidor MCP para binlogs de .NET](/es/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/), para rastrear qué target produjo un asset en conflicto.
- [dotnetup, el gestor oficial de versiones del SDK de .NET](/es/2026/06/dotnetup-official-dotnet-sdk-version-manager/), para probar un repositorio contra varios SDKs.

## Fuentes

- [dotnet/aspnetcore#62138](https://github.com/dotnet/aspnetcore/issues/62138): la regresión del SDK 10 preview 5, el workaround con `StaticWebAssetBasePath` y la resolución de "no soportado".
- [dotnet/aspnetcore#64726](https://github.com/dotnet/aspnetcore/issues/64726): el mismo error en una aplicación `netcoreapp8.0` después de instalar el nuevo SDK.
- [dotnet/aspnetcore#57512](https://github.com/dotnet/aspnetcore/issues/57512) y [dotnet/aspnetcore#57518](https://github.com/dotnet/aspnetcore/issues/57518): assets de paquetes precomprimidos en .NET 9 y la corrección.
- [dotnet/sdk#40413](https://github.com/dotnet/sdk/issues/40413): ajustes de compresión (`DisableBuildCompression`, `BuildCompressionFormats`, `CompressionExcludePatterns`).
- [dotnet/sdk#52089](https://github.com/dotnet/sdk/issues/52089) y [dotnet/sdk#52014](https://github.com/dotnet/sdk/issues/52014): bugs abiertos de static web assets en .NET 10 con síntomas que se solapan.
- [ASP.NET Core Blazor static files](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0) en Microsoft Learn.
- Fuentes del SDK inspeccionadas localmente: `Sdk.Server.props`, `Microsoft.NET.Sdk.StaticWebAssets.targets` y `Microsoft.NET.Sdk.StaticWebAssets.Compression.targets` de los SDK 10.0.302 y 9.0.318.
