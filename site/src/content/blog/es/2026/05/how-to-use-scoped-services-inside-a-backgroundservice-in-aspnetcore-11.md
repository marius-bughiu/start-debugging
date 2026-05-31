---
title: "Cómo usar servicios scoped dentro de un BackgroundService en ASP.NET Core 11"
description: "Un BackgroundService es un singleton, así que no puede inyectar directamente un servicio scoped como un DbContext. Toma IServiceScopeFactory, abre un scope por unidad de trabajo con CreateAsyncScope, resuelve dentro de él y deséchalo al terminar."
pubDate: 2026-05-31
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
  - "backgroundservice"
lang: "es"
translationOf: "2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-05-31
---

Un `BackgroundService` se registra como singleton, así que inyectar directamente en su constructor un servicio scoped como un `DbContext` o bien lanza `Cannot consume scoped service 'X' from singleton 'Y'` al arrancar o, peor aún, fija esa instancia scoped al tiempo de vida de todo tu proceso. La solución es inyectar `IServiceScopeFactory`, abrir un scope nuevo con `CreateAsyncScope()` para cada unidad de trabajo dentro de `ExecuteAsync`, resolver el servicio scoped desde el provider de ese scope y desechar el scope cuando el trabajo termine. Esta guía está escrita para .NET 11 (preview 4 en el momento de escribirla, con disponibilidad general prevista para noviembre de 2026), `Microsoft.Extensions.Hosting` 11.0.0 y EF Core 11. Los contratos de `BackgroundService` e `IServiceScopeFactory` han sido estables desde .NET Core 3.1, así que todos los patrones de aquí también aplican sin cambios a .NET 6, 8 y 10.

## Por qué un BackgroundService no puede simplemente inyectar un servicio scoped

Cada servicio hospedado que registras con `AddHostedService<T>` es un singleton. Ese no es un valor por defecto que puedas anular: `AddHostedService<T>` y `AddSingleton<IHostedService, T>` se resuelven al mismo registro, y el host obtiene la instancia desde el provider **raíz** durante `StartAsync`. El provider raíz no tiene ningún scope ambiental.

Un servicio scoped, por definición, vive una vez por scope. En una solicitud web ese scope se crea y se desecha por solicitud. Un `BackgroundService` se ejecuta durante todo el tiempo de vida del host, completamente fuera de cualquier solicitud. Así que no hay scope contra el cual el runtime pueda resolver una dependencia scoped. Si escribes un constructor como `OrderWorker(AppDbContext db)`, ocurre una de dos cosas:

- En `Development`, `WebApplication.CreateBuilder` activa `ValidateScopes`, el validador de call sites recorre el grafo durante el build, ve un servicio scoped fluyendo hacia un singleton y lanza `Cannot consume scoped service ...`. Si esa es la excepción exacta con la que llegaste aquí, la guía dedicada de [no se puede consumir un servicio scoped desde un singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/) recorre cada variante.
- En `Production`, la validación de scopes está desactivada por defecto, así que el mismo código compila y se ejecuta. El `DbContext` queda capturado durante la vida del proceso. Su change tracker acumula cada entidad que cargues, su conexión nunca vuelve limpiamente al pool y tarde o temprano te topas con `ObjectDisposedException` o lecturas obsoletas.

Ninguno de los dos resultados es lo que quieres. El modelo correcto es: el worker singleton posee el bucle y la cancelación, y cada iteración pide prestado un scope de vida corta para hacer el trabajo real.

## Configura la resolución scoped en cuatro pasos

La propia [guía de servicios worker de Microsoft](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) recomienda delegar el trabajo real a un servicio scoped y mantener delgado al propio `BackgroundService`. Aquí está la forma completa en cuatro pasos.

1. **Registra el servicio scoped** con `AddScoped`, exactamente como lo harías para un consumidor ligado a una solicitud. No hace falta nada especial porque se usa en un contexto de fondo.
2. **Registra el worker** con `AddHostedService<T>`. Sigue siendo un singleton; no intentes hacerlo scoped.
3. **Inyecta `IServiceScopeFactory`** (no el servicio scoped, ni `IServiceProvider`) en el constructor del worker.
4. **Abre un scope por unidad de trabajo** dentro de `ExecuteAsync` con `CreateAsyncScope()`, resuelve el servicio scoped desde `scope.ServiceProvider`, haz el trabajo y deja que el `await using` deseche el scope.

### Pasos 1 y 2: registro

```csharp
// .NET 11, C# 14 - Program.cs
using App.Workers;

var builder = WebApplication.CreateBuilder(args);

// The scoped unit of work. Registered exactly like any request-scoped service.
builder.Services.AddScoped<IOrderProcessor, OrderProcessor>();

// The worker stays a singleton. AddHostedService always registers a singleton.
builder.Services.AddHostedService<OrderWorker>();

var app = builder.Build();
app.Run();
```

### Pasos 3 y 4: el worker

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace App.Workers;

public sealed class OrderWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<OrderWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("OrderWorker started.");

        while (!stoppingToken.IsCancellationRequested)
        {
            // One scope per iteration: a fresh DbContext, change tracker, and
            // connection scope every time, disposed at the end of the block.
            await using var scope = scopeFactory.CreateAsyncScope();

            var processor = scope.ServiceProvider
                .GetRequiredService<IOrderProcessor>();

            await processor.ProcessPendingAsync(stoppingToken);

            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }
    }
}
```

El servicio scoped que contiene toda la lógica real y las dependencias scoped:

```csharp
// .NET 11, C# 14
namespace App.Workers;

public interface IOrderProcessor
{
    Task ProcessPendingAsync(CancellationToken cancellationToken);
}

public sealed class OrderProcessor(
    AppDbContext db,                 // scoped, injected normally now
    ILogger<OrderProcessor> logger) : IOrderProcessor
{
    public async Task ProcessPendingAsync(CancellationToken cancellationToken)
    {
        var pending = await db.Orders
            .Where(o => o.Status == OrderStatus.Pending)
            .ToListAsync(cancellationToken);

        foreach (var order in pending)
        {
            order.Status = OrderStatus.Processed;
        }

        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Processed {Count} orders.", pending.Count);
    }
}
```

`OrderProcessor` inyecta `AppDbContext` directamente porque él mismo es scoped y solo se resuelve dentro de un scope. El worker singleton nunca ve el `DbContext`. Esa separación es todo el truco: el desajuste de tiempos de vida desaparece en el momento en que el grafo scoped se resuelve desde un scope real en lugar de desde la raíz.

## CreateAsyncScope frente a CreateScope

Usa `CreateAsyncScope()`, no `CreateScope()`, para casi todo el código moderno. La diferencia está en el descarte.

`CreateScope()` devuelve un `IServiceScope` que desecha sus servicios scoped de forma síncrona mediante `IDisposable.Dispose()`. `CreateAsyncScope()` devuelve un `AsyncServiceScope` que desecha mediante `IAsyncDisposable.DisposeAsync()` cuando el servicio lo implementa, y recurre al descarte síncrono cuando no.

Esto importa porque el `DbContext` de EF Core en .NET 11 implementa `IAsyncDisposable`, y varias configuraciones (contextos pooled, contextos que mantienen abierta una `DbConnection`) lanzarán una excepción si se desechan de forma síncrona. Si escribes `using var scope = scopeFactory.CreateScope();` y el scope contiene un contexto que requiere descarte asíncrono, obtienes una excepción al final del bloque que no tiene nada que ver con tu trabajo real.

```csharp
// .NET 11 - prefer this
await using var scope = scopeFactory.CreateAsyncScope();

// Only use the sync form when nothing in the scope needs async disposal
using var syncScope = scopeFactory.CreateScope();
```

El coste de `CreateAsyncScope()` frente a `CreateScope()` es prácticamente cero cuando nada necesita descarte asíncrono, así que no hay razón para recurrir a la versión síncrona por defecto.

## Un scope por unidad de trabajo, no uno por proceso

El error más común tras cambiar a `IServiceScopeFactory` es sacar el scope fuera del bucle:

```csharp
// .NET 11 - WRONG. The scope lives for the whole process.
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    await using var scope = scopeFactory.CreateAsyncScope();      // created once
    var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();

    while (!stoppingToken.IsCancellationRequested)
    {
        await processor.ProcessPendingAsync(stoppingToken);       // same DbContext forever
        await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
    }
}
```

Esto compila, pasa la validación de scopes y reintroduce el mismo bug que intentabas corregir. El `DbContext` resuelto una sola vez ahora vive durante toda la vida del worker. Su change tracker crece sin límite en cada iteración, las consultas se vuelven más lentas a medida que el grafo rastreado se expande y un solo `SaveChanges` fallido puede dejar el contexto en un estado que envenena cada iteración posterior. También vuelves a abrir la puerta a [el error de la segunda operación en la instancia del contexto](/es/2026/05/fix-second-operation-was-started-on-this-context-instance/) en cuanto dos iteraciones se solapan.

Crea el scope **dentro** del bucle. Un scope es barato. El sentido del patrón es que cada unidad de trabajo obtenga una pizarra limpia: un contexto nuevo, un change tracker nuevo y una conexión tomada del pool y devuelta al final de la iteración.

## Servicios scoped en un worker que drena una cola

El scope por iteración se generaliza de forma natural a un worker que drena un `Channel<T>`. Cada elemento sacado de la cola es su propia unidad de trabajo, así que cada uno obtiene su propio scope:

```csharp
// .NET 11, C# 14
using System.Threading.Channels;

public sealed class OrderQueueWorker(
    Channel<int> queue,
    IServiceScopeFactory scopeFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var orderId in queue.Reader.ReadAllAsync(stoppingToken))
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var processor = scope.ServiceProvider
                .GetRequiredService<IOrderProcessor>();

            await processor.ProcessOneAsync(orderId, stoppingToken);
        }
    }
}
```

`ReadAllAsync` ya respeta el token de cancelación, así que el bucle se desenrolla limpiamente al apagar. Cada mensaje se procesa de forma aislada, y un mensaje envenenado que lanza una excepción dentro de un scope no corrompe el contexto usado en el siguiente.

## EF Core: IServiceScopeFactory frente a IDbContextFactory

Cuando la única dependencia scoped que necesitas es un `DbContext`, EF Core te da una herramienta más directa: `IDbContextFactory<T>`. Regístrala con `AddDbContextFactory`, que registra la factory como singleton, e inyecta la factory directamente en el worker:

```csharp
// .NET 11, EF Core 11 - Program.cs
builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default")));
```

```csharp
// .NET 11, EF Core 11
public sealed class OrderWorker(
    IDbContextFactory<AppDbContext> dbFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);

            var pending = await db.Orders
                .Where(o => o.Status == OrderStatus.Pending)
                .ToListAsync(stoppingToken);

            // process...
            await db.SaveChangesAsync(stoppingToken);

            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }
    }
}
```

La regla de decisión es simple. Si tu unidad de trabajo necesita **solo** un `DbContext`, usa `IDbContextFactory<T>`: no hay ceremonia de scope, y la factory te entrega un contexto nuevo y correctamente desechado en cada llamada. Si tu unidad de trabajo necesita un grafo de servicios scoped (un repositorio, un resolutor de tenant, un `IOptionsSnapshot<T>`, un servicio de dominio que a su vez depende del contexto), usa `IServiceScopeFactory` para que todo el grafo se resuelva de forma consistente dentro de un único scope. Puedes registrar `AddDbContext` para código ligado a solicitudes y `AddDbContextFactory` para el worker en la misma aplicación.

## Un scope no es thread-safe: el paralelismo necesita un scope por tarea

Si procesas elementos en paralelo, no compartas un único scope entre las tareas paralelas. Un `DbContext` no es thread-safe, y tampoco lo es la resolución de un scope. Dale a cada rama paralela su propio scope:

```csharp
// .NET 11, C# 14
await Parallel.ForEachAsync(
    orderIds,
    new ParallelOptions
    {
        MaxDegreeOfParallelism = 4,
        CancellationToken = stoppingToken
    },
    async (orderId, ct) =>
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var processor = scope.ServiceProvider
            .GetRequiredService<IOrderProcessor>();
        await processor.ProcessOneAsync(orderId, ct);
    });
```

Cada invocación del cuerpo obtiene un scope independiente, un `DbContext` independiente y un change tracker independiente, que es exactamente el aislamiento que necesitas para trabajo concurrente.

## Apagado ordenado y StopAsync

`stoppingToken` se señaliza cuando el host empieza a apagarse. Pasarlo a cada llamada asíncrona dentro del scope (la consulta, el `SaveChanges`, el `Task.Delay`) es lo que permite que el worker se detenga con prontitud en lugar de bloquear el apagado hasta el tiempo de espera de apagado del host (30 segundos por defecto).

Si necesitas hacer limpieza cuando el host se detiene, sobrescribe `StopAsync` y llama a la implementación base:

```csharp
// .NET 11, C# 14
public override async Task StopAsync(CancellationToken cancellationToken)
{
    logger.LogInformation("OrderWorker stopping, draining in-flight work.");
    await base.StopAsync(cancellationToken);
}
```

Un matiz: una llamada bloqueante larga dentro del bucle que ignore `stoppingToken` no será interrumpida, y el host espera el tiempo de apagado completo antes de derribar el proceso. Si tu unidad de trabajo puede ejecutarse mucho tiempo, propaga el token de principio a fin. Para la cuestión relacionada de detener trabajo que no coopera con la cancelación, consulta [cancelar una Task de larga duración en C# sin causar deadlocks](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking).

## Errores que sobreviven a la validación de scopes

Todos estos compilan y pasan `ValidateScopes`, por eso vale la pena nombrarlos:

- **Inyectar `IServiceProvider` en lugar de `IServiceScopeFactory`.** El provider inyectado en un singleton es el provider raíz. Resolver un servicio scoped desde él lanza una excepción o lo captura, según la configuración de validación. Inyecta siempre `IServiceScopeFactory` y llama a `CreateAsyncScope()`.
- **Resolver desde el provider raíz capturado dentro del scope.** Escribe `scope.ServiceProvider.GetRequiredService<T>()`, nunca `_rootProvider.GetRequiredService<T>()`. Resolver desde la raíz dentro de un scope que abriste anula el scope por completo.
- **Almacenar un servicio scoped resuelto en un campo.** La instancia no debe sobrevivir al scope. Pásala como parámetro de método y deja que salga de scope con el `await using`.
- **Olvidar `await using`.** Un simple `var scope = scopeFactory.CreateAsyncScope();` sin descarte filtra el scope y cada servicio que contiene durante toda la vida del proceso.

Para workers que pienses ejecutar en producción, combina este patrón con observabilidad adecuada para que un bucle atascado o que falla en silencio salga a la luz; el enfoque de [monitorizar trabajos en segundo plano sin Hangfire](/es/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts) aplica directamente. Y para un ejemplo completo del mismo patrón de scope factory alrededor de una dependencia no trivial, consulta [ejecutar un plugin de Semantic Kernel desde un BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).

El modelo mental que mantiene esto correcto: el singleton posee el bucle y la cancelación; el scope posee el trabajo y el estado por unidad. Mantén esas dos responsabilidades separadas y los errores de tiempo de vida nunca aparecerán en primer lugar.

## Fuentes

- Microsoft Learn, [Use scoped services within a BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) (actualizado 2026-05-27), el tutorial canónico de servicios worker.
- Microsoft Learn, [Dependency injection in .NET: service lifetimes](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#service-lifetimes).
- Microsoft Learn, [`AsyncServiceScope` and `CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope).
- Microsoft Learn, [Using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- .NET Blog, [.NET 11 Preview 1 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-1/).
