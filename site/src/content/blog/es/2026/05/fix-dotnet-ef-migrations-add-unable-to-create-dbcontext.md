---
title: "Fix: dotnet ef migrations add falla con 'Unable to create an object of type DbContext'"
description: "Las herramientas en tiempo de diseño de EF Core no pudieron instanciar tu DbContext. Expón un host con WebApplication.CreateBuilder, apunta al startup project correcto o implementa IDesignTimeDbContextFactory."
pubDate: 2026-05-11
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "migrations"
lang: "es"
translationOf: "2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext"
translatedBy: "claude"
translationDate: 2026-05-11
---

La solución: `dotnet ef` ejecuta tu aplicación en tiempo de diseño para descubrir el `DbContext`. Falló porque el punto de entrada no devolvió un host que pudiera sondear, o porque tu `DbContext` tiene parámetros en el constructor que no se pueden resolver sin uno. En una aplicación web, asegúrate de que `Program.cs` compile y use (o devuelva) un `WebApplication`. En una biblioteca de clases o un proyecto de pruebas, agrega una implementación de `IDesignTimeDbContextFactory<TContext>`. Luego vuelve a ejecutar con `--startup-project` apuntando al proyecto host, no al proyecto de datos.

```text
Unable to create an object of type 'AppDbContext'. For the different patterns supported at design time, see https://go.microsoft.com/fwlink/?linkid=851728
```

Esta guía está escrita contra `Microsoft.EntityFrameworkCore.Design` 11.0.0-preview.4, `dotnet-ef` 11.0.0-preview.4 y el SDK de .NET 11 preview 4. El mismo comportamiento aplica hasta EF Core 3.1: las reglas de descubrimiento en tiempo de diseño no han cambiado de forma desde la introducción del host genérico. Si todavía estás en EF Core 6 u 8, todas las soluciones de abajo funcionan, solo cambian ligeramente los namespaces.

## Cómo las herramientas en tiempo de diseño encuentran tu DbContext

Cuando ejecutas `dotnet ef migrations add Init`, la herramienta no escanea tu código de forma estática. Compila tu proyecto, carga el ensamblado resultante y busca una de cuatro cosas, en este orden:

1. Una implementación de `IDesignTimeDbContextFactory<TContext>` en el startup project.
2. Un host devuelto desde `Program.Main` o expuesto mediante el patrón implícito de `WebApplication`. La herramienta llama a `IHost.Services.GetRequiredService<TContext>()` sobre él.
3. Un `DbContext` con un constructor público sin parámetros. La herramienta llama a `new TContext()` directamente.
4. Un `DbContext` con `OnConfiguring` que no depende de servicios inyectados.

Si ninguno produce una instancia, obtienes el error `Unable to create an object of type 'X'`. El hipervínculo del mensaje apunta a la documentación de tiempo de diseño, que lista los mismos cuatro caminos.

## Por qué pasa esto en una aplicación web típica

La mayoría de los proyectos fallan en el camino 2. La herramienta puede llamar a tu `Program.cs` pero no encuentra un host que sondear. Tres cosas suelen romper el camino 2 en 2026:

1. `Program.cs` compila el `WebApplication` pero termina antes de que la herramienta pueda leer `Services` por el orden de las top-level statements.
2. El `DbContext` está registrado en un ensamblado distinto al que se pasa como `--startup-project`. La herramienta ejecutó el proyecto equivocado.
3. El constructor del `DbContext` toma un tipo personalizado (un resolutor de tenant, un reloj, un servicio de feature flag) que el contenedor de inyección de dependencias no puede resolver sin que `app.Run()` se ejecute realmente.

El primero es el asesino silencioso. Con top-level statements, el compilador sintetiza un `Program.Main` cuyo tipo de retorno y última instrucción importan a EF Core. Si `app.Run()` es la última expresión, la herramienta lee el host por reflexión sobre la clase sintética `Program`. Si envolviste la llamada a run en un condicional, o si haces un `return` temprano, el host nunca llega a la herramienta.

## Una reproducción mínima

Este es el proyecto más pequeño que produce el error. Un proyecto `WebApi`, un `DbContext` con una dependencia inyectada, sin design-time factory.

```csharp
// AppDbContext.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;

public sealed class AppDbContext : DbContext
{
    private readonly ITenantResolver _tenant;

    public AppDbContext(DbContextOptions<AppDbContext> options, ITenantResolver tenant)
        : base(options)
    {
        _tenant = tenant;
    }

    public DbSet<Order> Orders => Set<Order>();
}

public interface ITenantResolver { string Current { get; } }
public sealed class Order { public int Id { get; set; } public string TenantId { get; set; } = ""; }
```

```csharp
// Program.cs - .NET 11
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddScoped<ITenantResolver, HttpHeaderTenantResolver>();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

var app = builder.Build();

if (args.Contains("--migrate-only"))
{
    return; // <-- design-time tool reads this path, never reaches app.Run()
}

app.Run();
```

Ejecutar `dotnet ef migrations add Init` contra ese proyecto imprime el error. El registro de `ITenantResolver` solo ocurre después de `builder.Build()`, pero el `return` temprano corta el `Main` sintetizado y el sondeo del host de EF Core ve un estado parcialmente inicializado. El código de descubrimiento también intenta `new AppDbContext()`, que falla porque el constructor necesita dos argumentos.

## Solución 1 - haz que el host sea detectable (recomendado para aplicaciones web)

La solución más limpia es dejar que `Program.cs` termine de inicializar el host sin returns tempranos condicionales. La design-time host factory de EF Core usa `HostFactoryResolver` para recorrer el `Program.Main` compilado y tomar la referencia a `IHost`. Cualquier cosa que impida ese recorrido también impide que EF Core encuentre el contexto.

```csharp
// Program.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddScoped<ITenantResolver, HttpHeaderTenantResolver>();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

var app = builder.Build();

app.MapGet("/", () => "ok");

app.Run();
```

Ese único cambio suele ser suficiente. Confírmalo con el flag `--verbose`:

```bash
dotnet ef migrations add Init --verbose
```

Deberías ver líneas como `Finding design-time services...`, `Using application service provider from Microsoft.Extensions.Hosting.IHostBuilder.` y `Using DbContext factory 'AppDbContext'.` Si `--verbose` reporta `No host builder was found`, el camino 2 sigue roto y necesitas la solución 2 o la solución 3.

Si genuinamente necesitas un switch `--migrate-only` (un runner de consola que termine antes de `app.Run()` en producción), pónlo después de que el host se construya, pero **devuelve el host** en lugar de void, para que el `Main` sintetizado siga terminando con la referencia al host:

```csharp
// Program.cs - .NET 11
var app = builder.Build();
app.MapGet("/", () => "ok");

if (args.Contains("--migrate-only"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}

app.Run();
```

La herramienta en tiempo de diseño sigue viendo `app.Run()` como la instrucción terminal y puede sondear `app.Services` antes de invocarla.

## Solución 2 - apunta al startup project correcto

Una solución con un proyecto `Web` que referencia una biblioteca de clases `Data` es la segunda causa más común. La gente ejecuta `dotnet ef migrations add Init` desde dentro de `Data/`, donde vive el `DbContext`, esperando que la herramienta use el host registrado en `Web`. No lo hará. La herramienta compila el proyecto **actual** (o el que indique `--project`) y busca un host dentro de **ese** ensamblado.

```bash
# Run from the solution root, EF Core 11.0.0-preview.4 / .NET 11
dotnet ef migrations add Init \
  --project src/Data/Data.csproj \
  --startup-project src/Web/Web.csproj
```

`--project` es donde se escriben los archivos de migración. `--startup-project` es donde vive el host. Ambos flags son obligatorios cuando no son el mismo proyecto. Muchos equipos crean un alias para esto en `Directory.Build.props` o un `Makefile` para no tener que escribir nunca la invocación larga.

Puedes verificar qué ensamblado cargó realmente la herramienta con `dotnet ef dbcontext info --startup-project src/Web/Web.csproj`. Imprime el nombre del tipo resuelto, el proveedor y la fuente de la cadena de conexión. Si `info` funciona pero `migrations add` falla, tienes un problema de constructor, no de descubrimiento: salta a la solución 3.

## Solución 3 - implementa IDesignTimeDbContextFactory

Para bibliotecas de clases sin host (la disposición típica para una capa de datos empaquetada, un proyecto de pruebas o un proyecto compartido alojado de Blazor WebAssembly), no hay `Program.Main` que sondear. Agrega una factory en el mismo proyecto que el `DbContext`:

```csharp
// DesignTimeDbContextFactory.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlServer("Server=(localdb)\\MSSQLLocalDB;Database=design-time;Trusted_Connection=True;TrustServerCertificate=True")
            .Options;

        return new AppDbContext(options, new DesignTimeTenantResolver());
    }

    private sealed class DesignTimeTenantResolver : ITenantResolver
    {
        public string Current => "design-time";
    }
}
```

El descubrimiento de EF Core comprueba la existencia de `IDesignTimeDbContextFactory<TContext>` **antes** de recorrer el host, por lo que esta implementación también sobrescribe cualquier otra cosa. Eso la convierte en la solución más confiable, pero tiene un costo: la cadena de conexión se duplica. Léela desde `appsettings.json` si quieres evitarlo:

```csharp
// EF Core 11.0.0-preview.4 - read connection string from config
public AppDbContext CreateDbContext(string[] args)
{
    var config = new ConfigurationBuilder()
        .SetBasePath(Directory.GetCurrentDirectory())
        .AddJsonFile("appsettings.json", optional: false)
        .AddJsonFile($"appsettings.{Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? "Development"}.json", optional: true)
        .AddEnvironmentVariables()
        .Build();

    var options = new DbContextOptionsBuilder<AppDbContext>()
        .UseSqlServer(config.GetConnectionString("Default"))
        .Options;

    return new AppDbContext(options, new DesignTimeTenantResolver());
}
```

Un recordatorio sobre la copia de archivos: `appsettings.json` debe estar configurado a `Copy if newer` en el proyecto que ejecuta la herramienta, o el directorio de trabajo no lo contendrá. Si superas el error de descubrimiento y caes en una cadena de conexión `null`, esa es la misma trampa que se cubre en el artículo canónico sobre [el error No connection string named DefaultConnection](/es/2026/05/fix-no-connection-string-named-defaultconnection/).

## Solución 4 - la trampa del contrato de args

Si ya tienes una design-time factory y aún ves el error en CI, revisa el parámetro `args`. La herramienta de EF Core pasa su propia lista de argumentos a `CreateDbContext(string[] args)`. Código que confunde esos con los `args` de la aplicación y rechaza flags desconocidos lanzará una excepción antes de devolver el contexto. La herramienta reporta entonces ese throw como el fallo de descubrimiento:

```csharp
// Wrong - throws on EF Core's own args
public AppDbContext CreateDbContext(string[] args)
{
    if (args.Length != 2) throw new ArgumentException("expected env and db");
    ...
}
```

O quita la validación, o acepta que los `args` en tiempo de diseño son opacos y basa la lógica en `Environment.GetEnvironmentVariable`.

## Errores que parecen este pero no lo son

- **`Could not load file or assembly 'Microsoft.EntityFrameworkCore.Design'`**. Olvidaste agregar el paquete `Microsoft.EntityFrameworkCore.Design` al startup project. Debe estar referenciado ahí aunque el `DbContext` viva en otra parte, porque la herramienta lo carga desde la carpeta bin del ensamblado de inicio.
- **`No project was found`**. Ejecutaste `dotnet ef` desde una carpeta sin `.csproj`. Ejecútalo desde la raíz del proyecto o pasa `--project`.
- **`The command 'dotnet-ef' could not be found`**. Falta el manifiesto local de herramientas. Ejecuta `dotnet new tool-manifest` y `dotnet tool install dotnet-ef --version 11.0.0-preview.4`. Anclar la versión importa: un `dotnet-ef` global instalado hace años desencajará silenciosamente con el runtime.
- **`Cannot consume scoped service from singleton`**. El descubrimiento funcionó, pero el registro de inyección de dependencias es incorrecto. Ese es un error diferente y la solución de [scoped vs singleton lifetime](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/) lo cubre.
- **`A second operation was started on this context instance`**. También es un error diferente, pero los usuarios de EF Core lo encuentran por la misma madriguera de búsqueda. El [artículo sobre concurrencia de DbContext](/es/2026/05/fix-second-operation-was-started-on-this-context-instance/) lo explica paso a paso.

## Una checklist de depuración cuando ninguna de las soluciones funciona

Si probaste las cuatro y la herramienta sigue sin encontrar tu contexto, recorre esta checklist en orden. Es la misma lista que la etiqueta de triage "design-time" del equipo de EF Core recomienda en GitHub.

1. `dotnet build` se completa sin advertencias sobre ensamblados faltantes. La herramienta se ejecuta contra tu build output, así que una compilación verde es una precondición.
2. `dotnet ef dbcontext list --startup-project src/Web/Web.csproj` imprime el nombre de tu contexto. Si esto también falla, el ensamblado nunca cargó un contexto. Probablemente falte `AddDbContext`.
3. `dotnet ef dbcontext info` imprime el proveedor y la cadena de conexión. Si esto tiene éxito pero `migrations add` falla, el constructor de tu `DbContext` lanza una excepción cuando se invoca realmente. Agrega registro de eventos.
4. El `TargetFramework` del startup project coincide con el runtime de la herramienta `dotnet-ef`. Las herramientas de EF Core 11 apuntan a .NET 11. No pueden sondear un proyecto que solo apunta a `netstandard2.0`.
5. El startup project tiene referenciados tanto `Microsoft.EntityFrameworkCore.Design` como el paquete del proveedor (`Microsoft.EntityFrameworkCore.SqlServer`, `Npgsql.EntityFrameworkCore.PostgreSQL`, etc.).
6. `Program.cs` es el punto de entrada. Si tienes múltiples métodos `Main` o usas configuraciones de `OutputType` que lo ocultan, el descubrimiento falla.

Una vez que `dotnet ef dbcontext info` funcione de principio a fin, todos los demás comandos funcionarán. Esa es la mejor prueba de humo y es más rápida que ejecutar una migración real.

## Relacionado

- El [flujo de migración de un solo paso en EF Core 11](/es/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) cubre `dotnet ef migrations update --add`, el nuevo comando combinado introducido para actualizaciones de esquema rutinarias.
- Para errores de scope de inyección de dependencias en tiempo de ejecución, mira [la solución de servicio scoped desde singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- Si `GetConnectionString` devuelve null en tiempo de diseño, mira [el artículo sobre la cadena de conexión faltante](/es/2026/05/fix-no-connection-string-named-defaultconnection/).
- Para probar la capa de datos sin tocar el descubrimiento en tiempo de diseño, [pruebas de integración con Testcontainers](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) mantiene el proyecto de pruebas independiente del toolchain de migraciones.
- Para calentar la creación del modelo antes de la primera solicitud, [cómo calentar el modelo de EF Core](/es/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) cubre el problema relacionado del camino frío.

## Fuentes

- [Design-time DbContext Creation - EF Core docs](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation)
- [EF Core Tools Reference - dotnet ef](https://learn.microsoft.com/en-us/ef/core/cli/dotnet)
- [HostFactoryResolver source on dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting/src/Internal/HostFactoryResolver.cs)
- [EF Core issue 21025: design-time discovery on top-level statements](https://github.com/dotnet/efcore/issues/21025)
- [WebApplication and the generic host - ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis)
