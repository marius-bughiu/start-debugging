---
title: "Solución: PublishAot junto con EFOptimizeContext agota la memoria durante una compilación de EF Core"
description: "La generación del modelo de EF Core en tiempo de compilación volvía a invocar MSBuild hasta agotar la RAM. Actualiza Tasks y Design a 10.0.10+ y, en EF Core 11, elimina EFOptimizeContext."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "entity-framework"
  - "native-aot"
  - "msbuild"
  - "dotnet-10"
lang: "es"
translationOf: "2026/09/fix-publishaot-and-efoptimizecontext-exhaust-memory-during-an-ef-core-build"
translatedBy: "claude"
translationDate: 2026-09-10
---

Actualiza tanto `Microsoft.EntityFrameworkCore.Tasks` como `Microsoft.EntityFrameworkCore.Design` a 10.0.10 o posterior (10.0.12 es la versión actual al 2026-09-10), luego termina los procesos de compilación que quedaron colgados y reinicia Visual Studio. Hasta la 10.0.9, la generación del modelo compilado y la precompilación de consultas de EF Core en tiempo de compilación se volvían a disparar desde dentro de sus propias compilaciones anidadas, lanzando procesos de MSBuild hasta que la máquina se quedaba sin memoria. En EF Core 11 la corrección ya está incluida, y `EFOptimizeContext` desapareció por completo: elimínalo o la compilación falla.

## El error en contexto

No hay ninguna excepción que buscar, y eso es lo que hace tan desagradable este problema. El reporte contra EF Core 10.0.5, [dotnet/efcore#38087](https://github.com/dotnet/efcore/issues/38087), describe el síntoma completo: la RAM sube hasta que la máquina deja de responder, la salida de la compilación nunca pasa de su primera línea, y basta con abrir la solución en Visual Studio para provocarlo, porque IntelliSense inicia compilaciones en tiempo de diseño en cuanto se carga el proyecto. El registro detallado de la compilación en ese reporte contiene exactamente esto y nada más:

```
Build started at 5:55 PM...
```

Mientras tanto, el Administrador de tareas o `top` muestra una pila creciente de procesos `dotnet` y `MSBuild`. La configuración del proyecto que lo provoca siempre son las mismas cuatro líneas:

```xml
<!-- EF Core 10.0.5 through 10.0.9: do not build this without the fix -->
<PublishAot>true</PublishAot>
<EFOptimizeContext>true</EFOptimizeContext>
<EFScaffoldModelStage>build</EFScaffoldModelStage>
<EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
```

Si llegaste aquí después de actualizar a EF Core 11, lo que ves es distinto: un error de compilación definitivo lanzado por el target `_EFValidateProperties` en `Microsoft.EntityFrameworkCore.Tasks` 11.0.0-rc.1.26425.128, con este mensaje:

```
$(EFOptimizeContext) is no longer supported. Use $(EFScaffoldModelStage) and $(EFPrecompileQueriesStage) instead.
```

## Por qué ocurre

Aquí se combinan dos hechos que parecen no tener relación.

Primero, `PublishAot` no es solo una opción de publicación. Con `<PublishAot>true</PublishAot>` en el archivo de proyecto, incluso un simple `dotnet build` escribe los switches de características de AOT en `bin/Debug/net10.0/YourApp.runtimeconfig.json`, incluido este:

```json
"System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported": false
```

EF Core respeta ese switch y se niega a construir su modelo en runtime, así que una sesión de depuración con F5 muere en la primera consulta:

```
Unhandled exception. System.InvalidOperationException: Model building is not supported when publishing with NativeAOT. Use a compiled model.
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.CreateModel(Boolean designTime)
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.get_Model()
```

La reacción natural es hacer que el modelo compilado y las consultas precompiladas se generen en cada compilación. Eso es exactamente lo que hacen `EFScaffoldModelStage=build` y `EFPrecompileQueriesStage=build`, y en EF Core 9 y 10 solo tienen efecto junto con `EFOptimizeContext=true`. De ahí las cuatro líneas.

Segundo, está la forma en que `Microsoft.EntityFrameworkCore.Tasks` integra la generación en la compilación. Su target `_EFGenerateFilesAfterBuild` se agrega a `$(TargetsTriggeredByCompilation)`, así que se ejecuta después de cada `CoreCompile`. Lanza un MSBuild anidado del mismo proyecto con `_EFGenerationStage=build`, que vuelve a compilar el proyecto con AOT desactivado y luego ejecuta la tarea `OptimizeDbContext`. Para las consultas precompiladas, el código de tiempo de diseño de EF abre el proyecto mediante el `MSBuildWorkspace` de Roslyn, y cargar un proyecto de esa forma ejecuta otra compilación en tiempo de diseño más.

Lo único que impedía que esa cadena se volviera recursiva era una condición `'$(_EFGenerationStage)'==''` en los targets de generación. Tenía dos huecos:

1. **Compilaciones en tiempo de diseño de Visual Studio.** `CoreCompile` también se ejecuta durante las compilaciones ligeras en tiempo de diseño que VS dispara continuamente mientras un proyecto está abierto. Cada una iniciaba una generación completa fuera de proceso, y se acumulaban más rápido de lo que terminaban. [dotnet/efcore#38386](https://github.com/dotnet/efcore/pull/38386) lo corrigió agregando `'$(DesignTimeBuild)' != 'True'` a los targets de generación. Ese cambio vive en el archivo `.targets` del paquete **Tasks**.
2. **Compilaciones desde la línea de comandos.** El `MSBuildWorkspace` abierto para la precompilación de consultas no llevaba `_EFGenerationStage`, así que su compilación cumplía la condición y volvía a disparar la generación, que abría otro workspace, y así sucesivamente. [dotnet/efcore#38403](https://github.com/dotnet/efcore/pull/38403) lo corrigió creando el workspace con `_EFGenerationStage=build` como propiedad global. Ese cambio vive en `DbContextOperations` dentro del paquete **Design**.

Ambos se integraron en `release/10.0` en junio de 2026 y se publicaron por primera vez en 10.0.10 el 2026-07-14. Lo verifiqué contra los propios paquetes en lugar de confiar en el milestone: el `Microsoft.EntityFrameworkCore.Tasks.targets` de 10.0.9 no contiene ninguna comprobación de `DesignTimeBuild`, mientras que el de 10.0.10 contiene tres, y la cadena `_EFGenerationStage` aparece por primera vez en `Microsoft.EntityFrameworkCore.Design.dll` en 10.0.10.

## Reproducción mínima

Este es el proyecto del reporte original, reducido a una entidad y un contexto sobre SQLite. Todas las versiones hasta la 10.0.9 inclusive lo reproducen. No lo compiles en una máquina donde no estés listo para matar el árbol de procesos.

```xml
<!-- .NET 10 SDK, EF Core 10.0.9 (broken). Reproduces the memory exhaustion. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <PublishAot>true</PublishAot>
    <EFOptimizeContext>true</EFOptimizeContext>
    <EFScaffoldModelStage>build</EFScaffoldModelStage>
    <EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
    <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.9" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tasks" Version="10.0.9" PrivateAssets="all" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 10.0.x
using Microsoft.EntityFrameworkCore;

await using var db = new AppDbContext();
await db.Database.OpenConnectionAsync();
await db.Database.ExecuteSqlRawAsync(
    "CREATE TABLE IF NOT EXISTS Entities (Id INTEGER PRIMARY KEY)");
var count = await db.Entities.Where(e => e.Id > 0).CountAsync();
Console.WriteLine($"Entities: {count}");

public class Entity { public int Id { get; set; } }

public class AppDbContext : DbContext
{
    public DbSet<Entity> Entities => Set<Entity>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite("Data Source=db.sqlite");
}
```

La tabla se crea con SQL directo a propósito en lugar de `EnsureCreatedAsync()`. La sección de trampas más abajo explica por qué.

## La solución, en detalle

### 1. Actualiza Tasks y Design juntos a 10.0.10 o posterior

```xml
<!-- .NET 10 SDK 10.0.302, EF Core 10.0.12 (fixed) -->
<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.12" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.12" PrivateAssets="all" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Tasks" Version="10.0.12" PrivateAssets="all" />
</ItemGroup>
```

Fija Design explícitamente. La protección para tiempo de diseño está en Tasks, la protección para línea de comandos está en Design, y de otro modo Design llega a tu grafo de forma transitiva en la versión que resuelva NuGet. No siempre es la versión que crees: Tools 10.0.6 a 10.0.8 permitían que Design se resolviera tan bajo como 8.0.0, un lío que se cubre en [la solución de MissingMethodException ArgumentIsEmpty](/es/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/). Actualizar solo Tasks arregla Visual Studio y deja `dotnet build` roto. Ejecuta `dotnet nuget why . Microsoft.EntityFrameworkCore.Design` para ver qué obtuviste realmente.

Luego limpia lo que dejó la versión rota. Cierra Visual Studio, termina cualquier proceso `dotnet` o `MSBuild` huérfano, apaga los servidores de compilación y borra `obj` para que los archivos generados a medias y sus listas `*.EFGeneratedSources.Build.txt` no vuelvan a entrar en la siguiente compilación:

```bash
dotnet build-server shutdown
```

Con la reproducción anterior movida a 10.0.12, en el SDK 10.0.302, `dotnet build` termina en 5.4 segundos con 0 errores, la app imprime `Entities: 0`, y `obj/Debug/net10.0/EfBombRepro.EFGeneratedSources.Build.txt` lista seis archivos generados:

```
AppDbContextAssemblyAttributes.g.cs
EntityUnsafeAccessors.g.cs
AppDbContextModel.g.cs
AppDbContextModelBuilder.g.cs
EntityEntityType.g.cs
Program.EFInterceptors.AppDbContext.g.cs
```

El archivo de interceptores contiene el SQL final de la llamada a `CountAsync`, `SELECT COUNT(*) FROM "Entities" AS "e" WHERE "e"."Id" > 0`, como literal de cadena. Ese es todo el sentido de la precompilación de consultas: no se traduce LINQ en runtime.

### 2. En EF Core 11, elimina EFOptimizeContext

EF Core 11 eliminó la propiedad ([dotnet/efcore#35079](https://github.com/dotnet/efcore/issues/35079)) porque las propiedades de etapa ya expresaban todo lo que hacía. Ahora habilitan la generación por sí solas:

```xml
<!-- .NET 11, EF Core 11.0.0-rc.1.26425.128 -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
  <EFScaffoldModelStage>build</EFScaffoldModelStage>
  <EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
</PropertyGroup>
```

El archivo targets de la rc.1 incluye la protección de `DesignTimeBuild`, y el ensamblado Design de la rc.1 incluye la corrección del workspace con `_EFGenerationStage`, así que esta configuración es segura. Si solo necesitas la generación al publicar, elimina también las dos líneas de etapa: ambas tienen `publish` como valor predeterminado, y con `PublishAot=true` EF Core 11 genera el modelo compilado y las consultas precompiladas durante `dotnet publish` sin ninguna propiedad adicional. Hay una combinación que se rechaza directamente, `EFScaffoldModelStage=publish` con `EFPrecompileQueriesStage=build`, que falla con "If $(EFScaffoldModelStage) is set to 'publish' then $(EFPrecompileQueriesStage) must also be set to 'publish'."

Cuida el orden. En 10.x, `EFOptimizeContext` sigue siendo la llave de la generación en la etapa de compilación. Lo quité de la reproducción corregida en 10.0.12 y dejé ambas etapas en `build`: la compilación tuvo éxito, no generó nada, y la app lanzó la excepción "Model building is not supported" en la primera consulta. Elimina la propiedad como parte de la actualización a EF Core 11, no antes. Ten en cuenta también que en EF Core 11 el paquete Tasks ya no depende de Design en absoluto, otra razón más para conservar la referencia explícita a Design del paso 1.

Como el único SDK en mi máquina es el 10.0.302 y los paquetes de EF Core 11 solo apuntan a `net11.0`, las afirmaciones sobre EF Core 11 de arriba provienen de leer el archivo targets y el ensamblado publicados en la rc.1, no de ejecutar una compilación.

### 3. Mantén PublishAot fuera del ciclo interno de desarrollo

El consejo del mantenedor de EF en el hilo del issue es directo: "I'd recommend not setting `<PublishAot>true</PublishAot>` for the inner dev loop". La objeción de quien reportó el problema es la real: si quitas `PublishAot`, las advertencias de trimming y de AOT desaparecen del IDE. No tiene por qué ser así, porque los analizadores tienen sus propios switches:

```xml
<!-- .NET 10 SDK 10.0.302, EF Core 10.0.12 -->
<PropertyGroup>
  <EnableAotAnalyzer>true</EnableAotAnalyzer>
  <EnableTrimAnalyzer>true</EnableTrimAnalyzer>
</PropertyGroup>
```

Con `PublishAot` reemplazado por esas dos líneas, la reproducción sigue reportando las mismas advertencias `IL2026` e `IL3050` en `new AppDbContext()`. El runtimeconfig ya no contiene el switch `IsDynamicCodeSupported`, EF Core construye su modelo en runtime como de costumbre, y no se genera nada durante la compilación. AOT pasa a ser una decisión de publicación:

```bash
dotnet publish -c Release -r linux-x64 -p:PublishAot=true
```

La documentación de EF también recomienda establecer `<RuntimeIdentifier>` en el proyecto de inicio cuando la generación se ejecuta en la etapa de publicación.

El costo en el ciclo interno no es hipotético. En la reproducción de una sola entidad, una compilación incremental después de editar `Program.cs` tardó 4.7 segundos con la generación en la etapa de compilación y 1.2 segundos sin ella. Una compilación sin cambios tardó 0.6 segundos en ambos casos, porque la generación se omite siempre que se omite `CoreCompile`. La documentación advierte que el modelo y los interceptores generados "may currently be quite large" y son lentos de producir, así que esa diferencia crece con tu modelo.

## Trampas y errores parecidos

**"Design-time DbContext operations are not supported when publishing with NativeAOT."** Con `PublishAot=true`, `EnsureCreatedAsync()`, `Migrate()` y cualquier otra cosa que necesite el modelo de tiempo de diseño lanzan esto, incluso con F5 e incluso con un modelo compilado presente. Por eso la reproducción crea su tabla con SQL directo. Aplica los cambios de esquema desde tu pipeline de implementación con un migrations bundle o un script SQL.

**`warning CS9270: 'InterceptsLocationAttribute(string, int, int)' is not supported`.** Los interceptores generados por 10.0.12 todavía usan la forma del atributo basada en la ruta del archivo, así que el compilador advierte sobre el archivo generado. Es una advertencia en código generado, no algo que corrijas en el tuyo. El mismo detalle explica por qué esos archivos contienen rutas absolutas específicas de la máquina y pertenecen a `obj`, nunca al control de versiones.

**CS9137, "The 'interceptors' feature is not enabled in this namespace".** O falta la línea `InterceptorsNamespaces`, o, según la documentación de EF, hay referencias transitivas desactualizadas a `Microsoft.CodeAnalysis.CSharp.Workspaces` y `Microsoft.CodeAnalysis.Workspaces.MSBuild` en el grafo. El mismo código de error desde otro generador se cubre en [la solución del error CS9137 de interceptors](/es/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/).

**Generación omitida en silencio en una solución con varios proyectos.** Cada proyecto que contenga un `DbContext` o una consulta de EF necesita su propia referencia a `Microsoft.EntityFrameworkCore.Tasks`, ya que no es transitiva. La integración tampoco puede usar un proyecto de inicio separado, así que un contexto configurado desde un host en otro proyecto necesita un `IDesignTimeDbContextFactory<TContext>`.

**La misma excepción de construcción del modelo en iOS sin PublishAot.** Las compilaciones de iOS establecen `DynamicCodeSupport=false` por su cuenta, así que las apps de .NET MAUI llegan a esta ruta sin haber activado nunca AOT. Consulta [la solución de construcción del modelo con NativeAOT en MAUI iOS](/es/2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios/).

## Relacionado

- [Cómo precalentar el modelo de EF Core antes de la primera consulta](/es/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/), incluido cómo distribuir un modelo compilado con `dotnet ef dbcontext optimize` cuando no necesitas AOT en absoluto.
- [Solución: Model building is not supported when publishing with NativeAOT en una compilación de .NET MAUI para iOS](/es/2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios/)
- [Native AOT vs ReadyToRun vs JIT en .NET 11: ¿cuál deberías distribuir?](/es/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), vale la pena leerlo antes de comprometer una app de EF Core con AOT.
- [Solución: MissingMethodException 'AbstractionsStrings.ArgumentIsEmpty' después de actualizar EF Core Tools](/es/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/)
- [Solución: The 'interceptors' feature is not enabled in this namespace](/es/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/)

## Fuentes

- [dotnet/efcore#38087, `PublishAot` + `EFOptimizeContext` fork bombs the system](https://github.com/dotnet/efcore/issues/38087)
- [dotnet/efcore#38386, protege la generación de archivos de EF contra las compilaciones en tiempo de diseño](https://github.com/dotnet/efcore/pull/38386)
- [dotnet/efcore#38403, protege la generación de archivos de EF durante las compilaciones desde la línea de comandos](https://github.com/dotnet/efcore/pull/38403)
- [dotnet/efcore#35079, elimina la propiedad EFOptimizeContext de los targets de EF](https://github.com/dotnet/efcore/issues/35079)
- [Tareas de MSBuild de EF Core](https://learn.microsoft.com/en-us/ef/core/cli/msbuild)
- [Cambios importantes en EF Core 11: se eliminó la propiedad de MSBuild EFOptimizeContext](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Compatibilidad con NativeAOT y consultas precompiladas en EF Core](https://learn.microsoft.com/en-us/ef/core/performance/nativeaot-and-precompiled-queries)
- [Microsoft.EntityFrameworkCore.Tasks en NuGet](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tasks)
