---
title: "Solución: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered"
description: "EF Core lanza esto cuando AddDbContext nunca se ejecutó, se ejecutó después de Build o el constructor del contexto recibe el DbContextOptions equivocado. Registra antes de Build y usa DbContextOptions<TuContexto>."
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "dependency-injection"
lang: "es"
translationOf: "2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered"
translatedBy: "claude"
translationDate: 2026-06-26
---

La solución: se le pidió `DbContextOptions` al contenedor de inyección de dependencias mientras construía tu `DbContext`, y no tenía nada que devolver. En casi todos los casos eso significa que `AddDbContext<TuContexto>(...)` nunca se llamó, se llamó después de `builder.Build()`, vive en un método `ConfigureServices` que ya no se ejecuta, o el constructor de tu contexto declara un parámetro que el contenedor no registra. Agrega `builder.Services.AddDbContext<TuContexto>(...)` antes de `Build()`, y dale al constructor un parámetro `DbContextOptions<TuContexto>`, no el `DbContextOptions` no genérico.

```text
System.InvalidOperationException: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered.
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService[T](IServiceProvider provider)
```

También puedes ver la misma causa raíz a través de la ruta de activación, con la forma genérica con comilla invertida del nombre del tipo:

```text
System.InvalidOperationException: Unable to resolve service for type 'Microsoft.EntityFrameworkCore.DbContextOptions`1[MyApp.Data.AppDbContext]' while attempting to activate 'MyApp.Data.AppDbContext'.
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.GetService(...)
```

Esta guía está escrita contra .NET 11, EF Core 11.0.0 (`Microsoft.EntityFrameworkCore` 11.0.0) y `Microsoft.Extensions.DependencyInjection` 11.0.0. El comportamiento descrito aquí ha sido estable desde EF Core 3.0, así que las soluciones se aplican igual a EF Core 6, 8 y 10.

## Las dos formas del mensaje son el mismo error

El contenedor de .NET emite dos frases distintas para un solo fallo subyacente, y cuál de ellas obtienes depende de cómo empezó la resolución:

- `No service for type 'X' has been registered.` proviene de `GetRequiredService<X>()`. Algo le pidió `X` al proveedor directamente y `X` no estaba en la colección.
- `Unable to resolve service for type 'X' while attempting to activate 'Y'.` proviene de `ActivatorUtilities`. El contenedor estaba construyendo `Y`, encontró un parámetro del constructor de tipo `X` y no pudo satisfacerlo.

En ambos casos aquí, `X` es `DbContextOptions` (o su genérico `DbContextOptions<AppDbContext>`, que el runtime imprime como ``DbContextOptions`1[AppDbContext]``). `Y`, cuando aparece, es tu contexto. Lee los nombres de los tipos antes de cambiar nada: el error trata sobre el objeto de opciones que EF Core necesita para configurar el contexto, no sobre el contexto en sí.

## Qué registra realmente AddDbContext

Entender la solución implica entender qué pone `AddDbContext<TContext>` en el contenedor. Internamente registra dos cosas para las opciones (`Microsoft.EntityFrameworkCore.EntityFrameworkServiceCollectionExtensions`, el método `AddCoreServices`):

```csharp
// EF Core 11.0.0 - paraphrased from AddCoreServices
serviceCollection.TryAdd(
    new ServiceDescriptor(
        typeof(DbContextOptions<TContextImplementation>),
        CreateDbContextOptions<TContextImplementation>,
        optionsLifetime));

serviceCollection.Add(
    new ServiceDescriptor(
        typeof(DbContextOptions),
        p => p.GetRequiredService<DbContextOptions<TContextImplementation>>(),
        optionsLifetime));
```

De aquí salen dos hechos que explican cada variante del error:

1. El genérico `DbContextOptions<TContext>` es el registro real. Se agrega con `TryAdd`, así que la primera llamada gana para ese tipo cerrado.
2. El no genérico `DbContextOptions` es un reenviador agregado con `Add` (incondicional). Simplemente llama a `GetRequiredService<DbContextOptions<TContext>>()` por debajo. Como es `Add`, no `TryAdd`, cada llamada a `AddDbContext` agrega otro reenviador, y cuando resuelves el `DbContextOptions` no genérico, **gana el último que se registró**.

Así que si nunca llamas a `AddDbContext`, no existe ninguno de los dos registros, y pedir cualquiera de las formas lanza la excepción. Y si registras dos contextos pero uno recibe el `DbContextOptions` no genérico, ese contexto recibe silenciosamente las opciones del otro contexto. Ambos casos se cubren más abajo.

## Reproducción mínima

El programa .NET 11 más pequeño que lanza el error, por olvidar el registro por completo:

```csharp
// .NET 11, EF Core 11.0.0, Microsoft.AspNetCore.App 11.0.0
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// No builder.Services.AddDbContext<AppDbContext>(...) here.
builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();

public sealed class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
    public DbSet<Product> Products => Set<Product>();
}

public sealed class Product
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

[ApiController]
[Route("products")]
public sealed class ProductsController(AppDbContext db) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(db.Products.Count());
}
```

Accede a `GET /products` y MVC le pide al contenedor que active `ProductsController`, que necesita un `AppDbContext`, que necesita un `DbContextOptions<AppDbContext>`. Nada lo registró, así que obtienes la forma de activación del error. Esta es la forma exacta que encuentras justo después de generar (scaffold) un controlador en Visual Studio contra un contexto que todavía no has conectado en `Program.cs`.

## Solución uno: registra el contexto antes de construir el host

La respuesta la mayoría de las veces. Agrega el registro en `Program.cs` y asegúrate de que se ejecute antes de `builder.Build()`:

```csharp
// .NET 11, EF Core 11.0.0
var connectionString = builder.Configuration.GetConnectionString("DefaultConnection")
    ?? throw new InvalidOperationException("Connection string 'DefaultConnection' not found.");

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(connectionString));

var app = builder.Build();
```

`builder.Build()` toma una instantánea de la colección de servicios. Todo lo que agregues a `builder.Services` después de esa línea es ignorado silenciosamente por el host en ejecución, así que esto está mal:

```csharp
// .NET 11 - bug: registration after Build is discarded
var app = builder.Build();
builder.Services.AddDbContext<AppDbContext>(options => options.UseSqlServer(cs)); // too late
app.Run();
```

Si estás en el modelo más antiguo de `Startup`, el registro pertenece a `ConfigureServices`, y la versión clásica de este error es una segunda sobrecarga de `ConfigureServices`, o una línea `services.AddDbContext` comentada que alguien desactivó mientras depuraba y nunca restauró. Busca `AddDbContext` en todo el proyecto y confirma que la llamada que encuentres está realmente en la ruta de código que ejecuta el host.

Si construyes un `DbContext` fuera del pipeline de solicitudes, se aplica la misma regla dentro del proveedor que hayas construido. Resolver un `DbContext` con ámbito (scoped) desde el proveedor raíz, o antes de `app.Run()` sin crear un ámbito, falla por la misma razón:

```csharp
// .NET 11 - resolve a scoped DbContext correctly outside a request
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.MigrateAsync();
}
```

## Solución dos: dale al constructor un DbContextOptions<TuContexto>

Si el registro está presente y aun así encuentras el error, mira el constructor. El registro de DI de EF Core produce `DbContextOptions<AppDbContext>`, así que ese es el parámetro que el constructor debería declarar:

```csharp
// Right: generic, tied to this specific context type
public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
```

La versión no genérica compila y, con un único contexto registrado, incluso funciona, porque el reenviador descrito arriba la resuelve. Pero es frágil:

```csharp
// Risky: non-generic. Works with one context, breaks with two.
public AppDbContext(DbContextOptions options) : base(options) { }
```

En cuanto se registra un segundo contexto, ambas llamadas a `AddDbContext` agregan un reenviador `DbContextOptions` no genérico, gana el último, y tu contexto recibe las opciones equivocadas, normalmente la cadena de conexión equivocada o incluso el proveedor de base de datos equivocado. El fallo puede manifestarse como un error `No service` durante un registro parcial, o peor aún, como un contexto que consulta silenciosamente la base de datos equivocada. La documentación de Microsoft es explícita al respecto:

> La mayoría de las subclases de `DbContext` que aceptan un `DbContextOptions` deberían usar la variación genérica `DbContextOptions<TContext>`. Esto garantiza que se resuelvan las opciones correctas para el subtipo de `DbContext` específico desde la inyección de dependencias, incluso cuando se registran múltiples subtipos de `DbContext`.

Hay un uso legítimo de la forma no genérica: una clase base pensada para ser heredada. La base recibe un `DbContextOptions` no genérico para que cada subclase concreta pueda pasar su propio `DbContextOptions<TConcreto>`:

```csharp
// .NET 11, EF Core 11.0.0 - base class shared by several contexts
public abstract class AppDbContextBase : DbContext
{
    protected AppDbContextBase(DbContextOptions options) : base(options) { }
}

public sealed class CatalogDbContext : AppDbContextBase
{
    public CatalogDbContext(DbContextOptions<CatalogDbContext> options) : base(options) { }
}

public sealed class OrdersDbContext : AppDbContextBase
{
    public OrdersDbContext(DbContextOptions<OrdersDbContext> options) : base(options) { }
}
```

Cada contexto concreto sigue exponiendo el constructor genérico, así que DI le entrega las opciones correctas; la base solo provee un constructor al que las subclases se encadenan. Un contexto que necesita ser instanciado directamente y además heredado debería exponer ambos constructores, con el genérico público y el no genérico protegido.

## Solución tres: herramientas en tiempo de diseño (migraciones y scaffolding)

Una variante distinta de este error aparece solo cuando ejecutas `dotnet ef`:

```text
Unable to create a 'DbContext' of type ''. The exception 'Unable to resolve service for type
'Microsoft.EntityFrameworkCore.DbContextOptions`1[MyApp.Data.AppDbContext]' while attempting to
activate 'MyApp.Data.AppDbContext'.' was thrown while attempting to create an instance.
```

En tiempo de diseño no hay un host web en ejecución, así que EF Core no puede sacar las opciones del contenedor de DI de tu aplicación. Intenta construir el contexto de todos modos y falla en el parámetro de opciones. Dos soluciones fiables:

1. Deja que EF encuentre el host de tu app. Si tu `DbContext` vive en el proyecto de inicio y `Program.cs` llama a `AddDbContext`, las herramientas de EF pueden usar el proveedor de servicios de la app. Mantén el mismo proyecto en tiempo de diseño y en tiempo de ejecución, o pasa `--startup-project`.
2. Provee una fábrica explícita. Implementa `IDesignTimeDbContextFactory<TContext>` junto al contexto. EF la descubre automáticamente y la usa en lugar de adivinar:

```csharp
// .NET 11, EF Core 11.0.0 - found automatically by dotnet ef
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

public sealed class AppDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=DesignTime;ConnectRetryCount=0")
            .Options;

        return new AppDbContext(options);
    }
}
```

La fábrica construye `DbContextOptions<AppDbContext>` a mano, así que los comandos en tiempo de diseño nunca tocan la DI de tu aplicación. Esta es la solución canónica cuando el contexto vive en una biblioteca de clases sin host de inicio propio. Para la versión más amplia de ese fallo, consulta el recorrido dedicado sobre [por qué `dotnet ef migrations add` informa "Unable to create an object of type DbContext"](/es/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

## Construir un contexto a mano

Si no estás usando DI en absoluto, el registro no genérico de `DbContextOptions` es irrelevante. Construye las opciones tú mismo y pásalas al constructor:

```csharp
// .NET 11, EF Core 11.0.0 - no DI container involved
var options = new DbContextOptionsBuilder<AppDbContext>()
    .UseSqlServer(connectionString)
    .Options;

using var db = new AppDbContext(options);
```

Esta es la forma correcta para una herramienta de consola, una prueba o una utilidad en segundo plano que no tiene `IServiceProvider`. Nota que el builder también es genérico: `DbContextOptionsBuilder<AppDbContext>` produce un `DbContextOptions<AppDbContext>`, que coincide con el constructor genérico.

## Variantes que caen en esta página por error

Varios casos parecidos se buscan igual pero se resuelven de forma distinta:

- **`No connection string named 'DefaultConnection' could be found`.** El contexto se registró bien; falló la búsqueda de la cadena de conexión. Otra capa, otra solución. Consulta [el error de cadena de conexión DefaultConnection](/es/2026/05/fix-no-connection-string-named-defaultconnection/).
- **`Unable to resolve service for type 'X' while attempting to activate 'Y'`, donde X es tu propio servicio, no `DbContextOptions`.** Eso es un registro faltante simple en tu código, no un problema de cableado de EF Core. Consulta [el error general de resolución de servicio](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- **`Cannot consume scoped service 'AppDbContext' from singleton 'Y'`.** El contexto está registrado correctamente; un singleton lo está capturando. La solución es un ámbito, no un registro.
- **`A second operation was started on this context instance`.** El contexto se resolvió bien y se está compartiendo entre hilos o esperando (await) incorrectamente.
- **`AddDbContextPool` y `AddDbContextFactory`.** Ambos registran `DbContextOptions<TContext>` igual que `AddDbContext`, así que la regla del constructor es idéntica: los contextos agrupados (pooled) y los construidos por fábrica también requieren el parámetro genérico `DbContextOptions<TContext>`. Si estás intercambiando el contexto en pruebas a través de la fábrica agrupada, consulta [cómo quitar una fábrica de DbContext agrupada para un intercambio en pruebas en EF Core 11](/es/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).

## Confirmar el cableado en diez segundos

Cuando el registro parece correcto pero el error persiste, demuéstralo desde un ámbito en lugar de adivinar:

```csharp
// .NET 11 - remove before commit
using (var scope = app.Services.CreateScope())
{
    var options = scope.ServiceProvider.GetService<DbContextOptions<AppDbContext>>();
    Console.WriteLine(options is null ? "OPTIONS NOT REGISTERED" : "options OK");

    var ctx = scope.ServiceProvider.GetService<AppDbContext>();
    Console.WriteLine(ctx is null ? "CONTEXT NOT REGISTERED" : ctx.GetType().FullName);
}
```

Si la línea de las opciones imprime `OPTIONS NOT REGISTERED`, `AddDbContext` nunca se ejecutó en este proveedor, y estás en la Solución uno. Si las opciones se resuelven pero el contexto no, el parámetro del constructor está mal, y estás en la Solución dos. También puedes activar la validación en tiempo de compilación para que el host se niegue a arrancar con un grafo roto en lugar de fallar en la primera solicitud:

```csharp
// .NET 11
builder.Host.UseDefaultServiceProvider(o =>
{
    o.ValidateScopes = true;
    o.ValidateOnBuild = true;
});
```

`ValidateOnBuild` recorre cada registro una vez y falla rápido, lo que convierte un 500 en tiempo de ejecución en un error de arranque que no puedes pasar por alto. Combina el constructor genérico con `AddDbContext` antes de `Build`, y el error de `DbContextOptions` no vuelve. Para los patrones detrás de las pruebas unitarias que construyen contextos sin DI en absoluto, la pieza complementaria sobre [cómo simular (mock) DbContext sin romper el seguimiento de cambios](/es/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) cubre las concesiones.

## Fuentes

- Microsoft Learn, [DbContext Lifetime, Configuration, and Initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), incluida la sección `DbContextOptions` versus `DbContextOptions<TContext>`.
- Microsoft Learn, [Design-time DbContext Creation](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation) y `IDesignTimeDbContextFactory<TContext>`.
- Código fuente de EF Core, [`EntityFrameworkServiceCollectionExtensions.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Extensions/EntityFrameworkServiceCollectionExtensions.cs), donde `AddCoreServices` registra las opciones genéricas y no genéricas.
- Incidencia dotnet/efcore [#32936](https://github.com/dotnet/efcore/issues/32936) sobre el error de activación en tiempo de diseño y la solución con fábrica.
