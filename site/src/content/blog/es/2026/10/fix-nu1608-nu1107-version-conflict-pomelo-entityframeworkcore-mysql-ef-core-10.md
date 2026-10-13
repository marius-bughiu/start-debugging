---
title: "Solución: conflicto de versiones NU1608 / NU1107 entre Pomelo.EntityFrameworkCore.MySql y EF Core 10"
description: "Pomelo 9.0.0 solo admite EF Core Relational 9.0.x y no tiene una compilación para EF Core 10. Mantén todos los paquetes de EF Core en 9.0.x, o cambia a Microting.EntityFrameworkCore.MySql 10.0.x. Suprimir la advertencia provoca un fallo al iniciar."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "dotnet-10"
  - "nuget"
  - "mysql"
lang: "es"
translationOf: "2026/10/fix-nu1608-nu1107-version-conflict-pomelo-entityframeworkcore-mysql-ef-core-10"
translatedBy: "claude"
translationDate: 2026-10-13
---

**Respuesta corta:** `Pomelo.EntityFrameworkCore.MySql` 9.0.0 sigue siendo la versión más reciente en nuget.org (octubre de 2026) y declara `Microsoft.EntityFrameworkCore.Relational` como `[9.0.0, 9.0.999]`. Cualquier paquete de EF Core 10 en el grafo o bien choca con ese rango (`NU1107`, un error de restauración) o bien se impone sobre él (`NU1608`, una advertencia). No existe una compilación de Pomelo para EF Core 10, ni siquiera en el feed nightly. Tienes dos opciones que funcionan: mantener todos los paquetes de EF Core e Identity en 9.0.x (funciona bien en `net10.0`), o reemplazar Pomelo por el fork `Microting.EntityFrameworkCore.MySql` 10.0.x. No uses `NoWarn` para `NU1608`: la aplicación compila y luego muere dentro de `UseMySql` con una `MissingMethodException`.

Todo lo que sigue se reprodujo en macOS con .NET SDK 10.0.302, EF Core 10.0.13 y 9.0.21, Pomelo 9.0.0, Microting 10.0.12 y `MySql.EntityFrameworkCore` 10.0.9 de Oracle.

## El error en contexto

Obtienes una de dos variantes según el paquete de EF Core 10 que hayas agregado. Si algo más arrastra EF Core 10 de forma transitiva, normalmente `Microsoft.EntityFrameworkCore.Design` o ASP.NET Core Identity, la restauración falla de forma definitiva:

```text
error NU1107: Version conflict detected for Microsoft.EntityFrameworkCore.Relational. Install/reference Microsoft.EntityFrameworkCore.Relational 10.0.13 directly to project App to resolve this issue.
error NU1107:  App -> Microsoft.EntityFrameworkCore.Design 10.0.13 -> Microsoft.EntityFrameworkCore.Relational (>= 10.0.13)
error NU1107:  App -> Pomelo.EntityFrameworkCore.MySql 9.0.0 -> Microsoft.EntityFrameworkCore.Relational (>= 9.0.0 && <= 9.0.999).
```

Si sigues ese consejo y referencias `Microsoft.EntityFrameworkCore.Relational` 10.0.13 directamente, el error se convierte en una advertencia, porque una referencia directa siempre gana sobre un rango transitivo:

```text
warning NU1608: Detected package version outside of dependency constraint: Pomelo.EntityFrameworkCore.MySql 9.0.0 requires Microsoft.EntityFrameworkCore.Relational (>= 9.0.0 && <= 9.0.999) but version Microsoft.EntityFrameworkCore.Relational 10.0.13 was resolved.
```

Y esto es lo que hace esa compilación "arreglada" en tiempo de ejecución, en la primera línea que configura el contexto:

```text
Unhandled exception. System.MissingMethodException: Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
   at Microsoft.EntityFrameworkCore.Utilities.Check.NullButNotEmpty(String value, String parameterName)
   at Microsoft.EntityFrameworkCore.MySqlDbContextOptionsBuilderExtensions.UseMySql(DbContextOptionsBuilder optionsBuilder, String connectionString, ServerVersion serverVersion, Action`1 mySqlOptionsAction)
```

El mensaje de NuGet te indica literalmente que hagas lo que produce el fallo. Por eso este error sigue apareciendo en los rastreadores de incidencias meses después de que .NET 10 se publicara.

## Por qué ocurre

Los proveedores de EF Core se compilan contra los internos de una versión mayor de EF Core. Pomelo lo codifica en su nuspec con un límite superior:

```xml
<!-- Pomelo.EntityFrameworkCore.MySql 9.0.0 nuspec -->
<group targetFramework="net8.0">
  <dependency id="Microsoft.EntityFrameworkCore.Relational" version="[9.0.0, 9.0.999]" include="All" />
  <dependency id="MySqlConnector" version="2.4.0" exclude="Build,Analyzers" />
</group>
```

NuGet resuelve una sola versión de cada paquete por proyecto. Cuando dos caminos del grafo no coinciden:

- **Ambos transitivos, con rangos que no se solapan** (`Design 10 -> Relational >= 10.0.13` frente a `Pomelo -> Relational <= 9.0.999`): NuGet no puede elegir, así que falla con `NU1107`.
- **Gana una referencia directa** (tú mismo referencias Relational 10.0.13, o Central Package Management la fija): NuGet respeta la versión directa y avisa con `NU1608` de que se violó la restricción de Pomelo.

El límite superior no es paranoia. Pomelo 9.0.0 llama a helpers como `Check.NullButNotEmpty`, que en EF Core 9 delegan en `AbstractionsStrings.ArgumentIsEmpty(object)`. EF Core 10 cambió esos métodos internos de recursos, así que el IL del ensamblado de Pomelo apunta a un método que ya no existe. El JIT solo lo descubre cuando el método se llama por primera vez, y por eso la compilación sale en verde y el fallo ocurre al iniciar.

La razón por la que esto sigue siendo un problema en octubre de 2026, casi un año después de que EF Core 10 llegara a disponibilidad general: la [incidencia de seguimiento de EF Core 10 de Pomelo, #2007](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql/issues/2007), sigue abierta con más de 120 reacciones, el último comentario de un mantenedor (octubre de 2025) prometió una versión "pronto", y varios PR de la comunidad para EF Core 10 siguen sin fusionarse. Revisé tanto el listado de nuget.org como el feed nightly de Azure DevOps de Pomelo: la compilación más reciente en ambos es un paquete de CI `9.0.1-servicing` de agosto de 2025. No hay nada 10.x a lo que actualizar.

## Reproducción mínima

Tres proyectos `net10.0`, cada uno con Pomelo 9.0.0 más un paquete de EF Core 10:

```xml
<!-- .NET SDK 10.0.302. Swap the second reference to get each outcome. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
    <!-- NU1107: -->
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.13" />
    <!-- NU1107 too: Microsoft.AspNetCore.Identity.EntityFrameworkCore 10.0.13 -->
    <!-- NU1608 + crash: Microsoft.EntityFrameworkCore.Relational 10.0.13 -->
    <!-- No warning at all + crash: Microsoft.EntityFrameworkCore 10.0.13 -->
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 9.0.x or 10.0.x depending on the graph above
using Microsoft.EntityFrameworkCore;

var options = new DbContextOptionsBuilder<Shop>()
    .UseMySql("Server=localhost;Database=shop;User=root;Password=x",
              new MySqlServerVersion(new Version(8, 4, 0)))
    .Options;

using var db = new Shop(options);
Console.WriteLine(db.Orders.Where(o => o.Total > 10m).ToQueryString());

public class Order { public int Id { get; set; } public decimal Total { get; set; } }
public class Shop(DbContextOptions<Shop> o) : DbContext(o)
{
    public DbSet<Order> Orders => Set<Order>();
}
```

La última variante de esa lista merece su propia advertencia. Si agregas `Microsoft.EntityFrameworkCore` 10.0.13 (no Relational), la restauración es silenciosa. `Microsoft.EntityFrameworkCore.Relational` 9.0.0 solo dice `Microsoft.EntityFrameworkCore >= 9.0.0`, sin límite superior, así que NuGet resuelve felizmente EF Core 10.0.13 junto a Relational 9.0.0. `dotnet nuget why` lo muestra:

```text
[net10.0]
 └── Pomelo.EntityFrameworkCore.MySql (v9.0.0)
     └── Microsoft.EntityFrameworkCore.Relational (v9.0.0)
```

Sin `NU1608`, sin `NU1107`, y exactamente la misma `MissingMethodException` en tiempo de ejecución. Si ves esa excepción sin ninguna advertencia de NuGet, esta es la razón.

## La solución, en detalle

### 1. Encuentra todos los paquetes que arrastran EF Core 10

Antes de cambiar nada, averigua quién pidió la 10.x. En un proyecto que sí se restaura (el caso de `NU1608`), `dotnet nuget why` te da el camino:

```bash
dotnet nuget why src/App/App.csproj Microsoft.EntityFrameworkCore.Relational
```

En un proyecto atascado en `NU1107`, el propio error lista ambos caminos. Los sospechosos habituales en una aplicación `net10.0`:

- `Microsoft.EntityFrameworkCore.Design` y `Microsoft.EntityFrameworkCore.Tools`, actualizados por Dependabot o Renovate.
- `Microsoft.AspNetCore.Identity.EntityFrameworkCore`, porque la plantilla de Identity usa la versión del framework (10.0.x).
- `Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore`, `Microsoft.EntityFrameworkCore.InMemory` o `.Sqlite` en un proyecto de pruebas que referencia a la aplicación.
- Una biblioteca de terceros que ya migró a EF Core 10 (extensiones de operaciones masivas, auditoría, multi-tenencia).
- Un `Directory.Packages.props` que fija todos los paquetes `Microsoft.EntityFrameworkCore.*` a una única propiedad de versión compartida.

Esta última es la trampa de Central Package Management: un único `$(EfCoreVersion)` subido a 10.0.x convierte en silencio un Relational transitivo en uno fijado, así que obtienes `NU1608` en lugar de `NU1107` y pierdes la parada en seco.

### 2. Opción A: quedarse en EF Core 9.0.x sobre .NET 10

EF Core 9 apunta a `net8.0`, así que se ejecuta sobre el runtime de .NET 10 sin quejas. Fija todos los paquetes de EF Core, y también Identity si lo usas, al mismo parche 9.0.x:

```xml
<!-- .NET 10 app, EF Core 9.0.21, Pomelo 9.0.0 -->
<ItemGroup>
  <PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="9.0.21">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
  <PackageReference Include="Microsoft.AspNetCore.Identity.EntityFrameworkCore" Version="9.0.21" />
</ItemGroup>
```

Con Central Package Management, divide la propiedad para que quede explícito el mundo del proveedor:

```xml
<!-- Directory.Packages.props, .NET 10 solution with Pomelo 9.0.0 -->
<PropertyGroup>
  <!-- Pomelo 9.0.0 caps Relational at 9.0.999. Do not bump until the provider moves. -->
  <EfCoreVersion>9.0.21</EfCoreVersion>
</PropertyGroup>
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Relational" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.AspNetCore.Identity.EntityFrameworkCore" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
</ItemGroup>
```

Ejecuté el programa de reproducción con este grafo en `net10.0`: EF Core y Relational reportan ambos `9.0.21.0`, la construcción del modelo, `ToQueryString()` y `GenerateCreateScript()` funcionan, y el proyecto con Identity 9.0.21 se restaura y se ejecuta sin problemas. Indícale a Dependabot que deje en paz la línea 9.x (una regla `ignore` para `Microsoft.EntityFrameworkCore*` con `update-types: ["version-update:semver-major"]`), o reabrirá el mismo PR cada semana.

El problema es el calendario. EF Core 9 se entrega con la ventana de soporte STS de .NET 9, que termina el [10 de noviembre de 2026](https://dotnet.microsoft.com/platform/support/policy/dotnet-core). Después de esa fecha no habrá parches de seguridad para los paquetes de EF Core 9 (EF Core 8 LTS termina el mismo día). La Opción A es un puente, no un destino.

### 3. Opción B: cambiar a Microting.EntityFrameworkCore.MySql 10.0.x

[Microting.EntityFrameworkCore.MySql](https://github.com/microting/Pomelo.EntityFrameworkCore.MySql) es un fork de Pomelo que publica compilaciones para EF Core 10 desde febrero de 2026 y que además tiene una `11.0.0-preview.1`. El nuspec de la 10.0.12 apunta a `net10.0` con `Microsoft.EntityFrameworkCore.Relational [10.0.12, 10.0.999]` y `MySqlConnector 2.6.2`. Es la opción a la que se ha pasado la mayoría en la incidencia de seguimiento de Pomelo.

```xml
<!-- .NET 10, EF Core 10.0.13, Microting 10.0.12 -->
<ItemGroup>
  <PackageReference Include="Microting.EntityFrameworkCore.MySql" Version="10.0.12" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.13">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
</ItemGroup>
```

La extensión `UseMySql(...)` y `MySqlServerVersion`/`ServerVersion.AutoDetect` viven en el namespace `Microsoft.EntityFrameworkCore` en ambos paquetes, así que el `Program.cs` de mi reproducción compiló sin cambios tras el reemplazo e imprimió el mismo SQL de MySQL que Pomelo 9.0.0 con EF Core 9:

```text
SELECT `o`.`Id`, `o`.`Customer`, `o`.`Total`
FROM `Orders` AS `o`
WHERE (`o`.`Total` > 10.0) AND (`o`.`Customer` LIKE 'A%')
ORDER BY `o`.`Id`
LIMIT 5
```

Lo que sí necesitas cambiar:

1. Renombra cada `using Pomelo.EntityFrameworkCore.MySql.*;` a `using Microting.EntityFrameworkCore.MySql.*;`. El fork renombró tanto el ensamblado como los namespaces (por ejemplo `Pomelo.EntityFrameworkCore.MySql.Infrastructure` pasa a ser `Microting.EntityFrameworkCore.MySql.Infrastructure`).
2. Reemplaza también los paquetes de complementos: `Pomelo.EntityFrameworkCore.MySql.Json.Microsoft` pasa a ser `Microting.EntityFrameworkCore.MySql.Json.Microsoft`, y lo mismo para `.Json.Newtonsoft` y `.NetTopologySuite`. Dejar atrás un solo complemento de Pomelo trae de vuelta Pomelo 9.0.0 y el `NU1107`.
3. Actualiza el nombre del proveedor en los comandos de scaffolding: `dotnet ef dbcontext scaffold "<conn>" Microting.EntityFrameworkCore.MySql`.
4. Actualiza la herramienta `dotnet-ef` a 10.0.x para que coincida con la versión de EF Core en tiempo de ejecución.
5. Ejecuta `dotnet ef migrations add ProviderSwapCheck` contra tus migraciones existentes. Si la migración generada está vacía, el snapshot del modelo es compatible; elimínala con `dotnet ef migrations remove`. Si no está vacía, léela antes de publicar nada: esa diferencia es exactamente lo que se ejecutaría contra producción.

Sé honesto contigo mismo sobre lo que es esto: un fork de la comunidad mantenido por una sola empresa, no un proveedor oficial. Fija la versión exacta, lee sus notas de la versión antes de actualizar y vigila ambos repositorios. Si Pomelo publica la 10.0.0 más adelante, volver atrás es el mismo renombrado a la inversa.

### 4. Opción C: MySql.EntityFrameworkCore de Oracle

El proveedor de Oracle, [MySql.EntityFrameworkCore](https://www.nuget.org/packages/MySql.EntityFrameworkCore), tiene compilaciones para EF Core 10 desde la 10.0.0-rc y está en la 10.0.9. Su nuspec usa límites inferiores simples (`Microsoft.EntityFrameworkCore.Relational >= 10.0.9`), así que nunca provoca este conflicto. Es un proveedor distinto, no un fork, y la API cambia:

```csharp
// .NET 10, EF Core 10.0.13, MySql.EntityFrameworkCore 10.0.9
options.UseMySQL(connectionString); // capital SQL, no ServerVersion argument
```

También traduce las consultas de otra manera. El mismo filtro `Customer.StartsWith("A")` de la reproducción se convierte en un `LIKE CONCAT('A', '%')` más una comparación `LEFT(...) = CONVERT(... USING utf8mb4) COLLATE utf8mb4_bin`, mientras que Pomelo y Microting emiten `LIKE 'A%'`. Los mapeos de tipos y las anotaciones de migración también difieren, así que espera una diferencia de migración no vacía y planifica una revisión de migración de verdad. Elige esta opción si quieres un proveedor respaldado por el fabricante y puedes permitirte esa revisión; de lo contrario, la Opción B es el cambio más pequeño.

### 5. Qué no hacer

- **No agregues `<NoWarn>NU1608</NoWarn>`.** La reproducción muestra el resultado: una compilación limpia y una `MissingMethodException` en la primera llamada a `UseMySql`. Si fue `TreatWarningsAsErrors` lo que dejó ver el `NU1608`, cumplió con su trabajo.
- **No referencies `Microsoft.EntityFrameworkCore.Relational` 10.x directamente** solo porque lo sugiere el mensaje de `NU1107`. Eso convierte el error en el fallo al iniciar.
- **No mezcles versiones mayores dentro de una solución.** Un proyecto de pruebas con EF Core 10 InMemory que referencia una aplicación con EF Core 9 arrastra ambos a su grafo, y obtienes `NU1107` (o la discrepancia silenciosa) solo en el proyecto de pruebas.

## Trampas y errores parecidos

- **`MissingMethodException` sin ninguna advertencia de NuGet**: el grafo de `Microsoft.EntityFrameworkCore` 10 + Relational 9.0.0 de la reproducción. Ejecuta `dotnet nuget why <project> Microsoft.EntityFrameworkCore.Relational` y busca un Relational 9.x junto a un EF Core 10.x.
- **`NU1107` o `NU1608` que nombra a `Pomelo.EntityFrameworkCore.MySql.Json.Microsoft`**: los paquetes de complementos repiten la misma restricción `Microsoft.EntityFrameworkCore.Relational [9.0.0, 9.0.999]` y dependen ellos mismos de Pomelo 9.0.0. Muévelos en sincronía con el paquete principal.
- **`NU1605` (degradación de paquete detectada)**: un problema distinto. Algo en el grafo quiere una versión más nueva que la que fijaste directamente. A menudo aparece justo después de aplicar la Opción A, cuando algún paquete transitivo todavía quiere EF Core 10. Corrígelo encontrando y fijando ese paquete, no degradando más.
- **`dotnet ef` avisa de que la versión de las herramientas es más nueva que el runtime**: inofensivo por sí solo, pero tras la Opción A mantén la herramienta `dotnet-ef` en la misma versión mayor que los paquetes de EF Core de la aplicación, para que el comportamiento en tiempo de diseño coincida con lo que se ejecuta en producción.
- **Paquetes de Npgsql o SQL Server en 10.x en la misma solución**: sin problema mientras estén en proyectos distintos que nunca compartan un grafo. Un proyecto, una versión mayor de EF Core.

## Relacionado

- Si `NU1608` solo apareció porque las advertencias rompen tu compilación, consulta [TreatWarningsAsErrors sin sabotear las compilaciones de desarrollo](/es/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/) para mantenerlo estricto sin ocultar problemas reales.
- Para el patrón de propiedad de versión compartida usado en la Opción A, consulta [migrar una solución .NET a Central Package Management](/es/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/).
- .NET 10 también cambió qué paquetes transitivos aparecen en tu grafo: [la poda de paquetes NuGet está activada por defecto en .NET 10](/es/2026/05/nuget-package-pruning-default-net-10/).
- Cuando la herramienta `dotnet-ef` y el SDK no coinciden, lee [la solución para DotnetToolSettings.xml](/es/2026/10/fix-settings-file-dotnettoolsettings-xml-was-not-found-in-the-package/).
- Si planeas el salto final más allá de EF Core 9: [Migrar de EF Core 6 a EF Core 11: los cambios incompatibles que sí duelen](/es/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Fuentes

- [Incidencia de seguimiento de soporte de EF Core 10 en Pomelo #2007](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql/issues/2007)
- [README de Pomelo.EntityFrameworkCore.MySql: tabla de compatibilidad y feeds nightly](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql)
- [Pomelo.EntityFrameworkCore.MySql 9.0.0 en NuGet](https://www.nuget.org/packages/Pomelo.EntityFrameworkCore.MySql/9.0.0)
- [Microting.EntityFrameworkCore.MySql en NuGet](https://www.nuget.org/packages/Microting.EntityFrameworkCore.MySql) y [su README sobre el renombrado de namespaces](https://github.com/microting/Pomelo.EntityFrameworkCore.MySql)
- [MySql.EntityFrameworkCore en NuGet](https://www.nuget.org/packages/MySql.EntityFrameworkCore)
- [Advertencia de NuGet NU1608](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1608) y [error de NuGet NU1107](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1107)
- [Política de soporte de .NET y .NET Core](https://dotnet.microsoft.com/platform/support/policy/dotnet-core)
