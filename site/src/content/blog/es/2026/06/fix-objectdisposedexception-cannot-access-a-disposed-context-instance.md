---
title: "Solución: ObjectDisposedException: Cannot access a disposed context instance"
description: "Tu tarea fire-and-forget capturó un DbContext con ámbito de solicitud que el ámbito de DI ya había liberado. Resuelve un contexto nuevo dentro de la tarea con IServiceScopeFactory o IDbContextFactory."
pubDate: 2026-06-02
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "async"
lang: "es"
translationOf: "2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance"
translatedBy: "claude"
translationDate: 2026-06-02
---

La solución: una `Task` fire-and-forget capturó un `DbContext` (u otro servicio con ámbito) que vivía en un ámbito de DI que se liberó antes de que la tarea terminara. La solicitud retornó, ASP.NET Core liberó el ámbito y su `DbContext`, y tu tarea desacoplada tocó luego la instancia muerta. No captures el contexto con ámbito: dentro de la tarea, crea tu propio ámbito con `IServiceScopeFactory.CreateAsyncScope` y resuelve un nuevo `DbContext` desde él, o inyecta `IDbContextFactory<T>` y llama a `CreateDbContextAsync`.

```text
System.ObjectDisposedException: Cannot access a disposed context instance. A common cause of this error is disposing a context instance that was resolved from dependency injection and then later trying to use the same context instance elsewhere in your application. This may occur if you are calling Dispose() on the context instance, or wrapping it in a using statement. If you are using dependency injection, you should let the dependency injection container take care of disposing context instances.
Object name: 'AppDb'.
   at Microsoft.EntityFrameworkCore.DbContext.CheckDisposed()
   at Microsoft.EntityFrameworkCore.DbContext.get_DbContextDependencies()
   at Microsoft.EntityFrameworkCore.DbContext.Set[TEntity]()
   at Microsoft.EntityFrameworkCore.Internal.InternalDbSet`1.get_EntityQueryable()
```

Esta guía está escrita contra .NET 11 preview 4 y `Microsoft.EntityFrameworkCore` 11.0.0-preview.4, pero el texto del mensaje y la verificación `CheckDisposed` se han mantenido estables desde EF Core 3.0. La excepción se lanza desde `DbContext.CheckDisposed()`, que se ejecuta al inicio de cada miembro público: `Set<T>`, `SaveChangesAsync`, `Database`, el rastreador de cambios, todo. Para cuando la ves, el objeto ya no existe. EF Core no está compitiendo ni comportándose mal; algo liberó el contexto y luego el código lo buscó de todas formas.

## Qué significa "liberado" aquí en realidad

Un `DbContext` resuelto desde inyección de dependencias es propiedad del ámbito desde el que se resolvió. En ASP.NET Core, el framework crea un ámbito de DI por solicitud HTTP y lo libera cuando la respuesta finaliza. Liberar el ámbito libera todo `IDisposable` que creó, incluido tu `DbContext`. Después de eso, el proveedor de servicios interno del contexto se desmantela, su `DbConnection` vuelve al pool y `_disposed` se establece en `true`. Cualquier llamada posterior alcanza `CheckDisposed()` y lanza la excepción.

El error casi nunca tiene que ver con que escribas `using` o llames a `Dispose()` tú mismo (aunque esa es la otra forma de provocarlo). En la práctica tiene que ver con el ciclo de vida: el código sobrevivió al ámbito que era propietario del contexto. La forma más común con diferencia es una tarea fire-and-forget iniciada desde una solicitud que capturó el contexto de esa solicitud.

## El repro mínimo

Un controlador inicia trabajo en segundo plano sin esperarlo, y el lambda cierra sobre el `DbContext` inyectado:

```csharp
// .NET 11, C# 14, EF Core 11.0.0 -- wrong
public class OrdersController(AppDb db) : ControllerBase
{
    [HttpPost("orders")]
    public IActionResult Create(OrderDto dto)
    {
        var order = new Order(dto);
        db.Orders.Add(order);

        // fire-and-forget: not awaited, escapes the request lifetime
        _ = Task.Run(async () =>
        {
            await Task.Delay(2000);            // simulate slow work
            db.AuditLog.Add(new Audit(order)); // db is disposed by now
            await db.SaveChangesAsync();        // throws ObjectDisposedException
        });

        return Accepted();
    }
}
```

La secuencia: `Create` retorna `Accepted()` casi de inmediato, ASP.NET Core libera el ámbito de la solicitud (y `db` con él), y dos segundos después la tarea desacoplada despierta y llama a un contexto cuya bandera `_disposed` ya está establecida. El `Add` puede incluso parecer que tiene éxito según los tiempos, pero `SaveChangesAsync` lanza la excepción de forma fiable porque toca las dependencias liberadas.

Lo mismo ocurre con `ContinueWith`, con un controlador de eventos `async void` que captura el contexto, con un callback de `Timer` que cierra sobre él, y con un `BackgroundService` que resolvió un contexto con ámbito una vez en su constructor y lo reutiliza para siempre.

## Solución 1: crea un ámbito dentro de la tarea y resuelve un contexto nuevo

Esta es la respuesta correcta cuando el trabajo en segundo plano necesita servicios con ámbito más allá del puro acceso a datos. Inyecta `IServiceScopeFactory` (un singleton, siempre seguro de capturar) y abre un ámbito dentro del cuerpo de la tarea:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class OrdersController(AppDb db, IServiceScopeFactory scopeFactory)
    : ControllerBase
{
    [HttpPost("orders")]
    public async Task<IActionResult> Create(OrderDto dto)
    {
        var order = new Order(dto);
        db.Orders.Add(order);
        await db.SaveChangesAsync();     // the request's own work, awaited

        var orderId = order.Id;          // capture a value, not the context

        _ = Task.Run(async () =>
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var bgDb = scope.ServiceProvider.GetRequiredService<AppDb>();
            bgDb.AuditLog.Add(new Audit(orderId));
            await bgDb.SaveChangesAsync();
        });

        return Accepted();
    }
}
```

Cambiaron dos cosas. La tarea captura `orderId` (un `int`), no el `DbContext`. Y resuelve un `AppDb` completamente nuevo desde un ámbito que es de su propiedad, así que la liberación de ese ámbito está atada a que la tarea termine, no a la solicitud HTTP. `CreateAsyncScope` (en lugar del síncrono `CreateScope`) importa porque `DbContext` implementa `IAsyncDisposable`; usar el ámbito asíncrono lo libera por la ruta asíncrona y evita una advertencia de sync-over-async bajo los analizadores.

Tampoco captures nunca instancias de entidad a través del límite. El objeto `order` es rastreado por el contexto de la solicitud; pasarlo al contexto del nuevo ámbito invita a la colisión "instance of entity type cannot be tracked". Pasa la clave y vuelve a cargar o vuelve a adjuntar dentro de la tarea.

## Solución 2: inyecta IDbContextFactory cuando el trabajo es puro acceso a datos

Si el trabajo desacoplado solo necesita un `DbContext` y nada más con ámbito, `IDbContextFactory<T>` es más limpio que levantar todo un ámbito de DI. Regístralo junto a (o en lugar de) el contexto con ámbito:

```csharp
// .NET 11, EF Core 11.0.0 -- Program.cs
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));
```

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class OrdersController(IDbContextFactory<AppDb> factory) : ControllerBase
{
    [HttpPost("orders")]
    public async Task<IActionResult> Create(OrderDto dto)
    {
        int orderId;
        await using (var db = await factory.CreateDbContextAsync())
        {
            var order = new Order(dto);
            db.Orders.Add(order);
            await db.SaveChangesAsync();
            orderId = order.Id;
        }

        _ = Task.Run(async () =>
        {
            await using var bgDb = await factory.CreateDbContextAsync();
            bgDb.AuditLog.Add(new Audit(orderId));
            await bgDb.SaveChangesAsync();
        });

        return Accepted();
    }
}
```

`IDbContextFactory<T>` se registra como singleton, así que capturarlo en el closure es seguro. Cada `CreateDbContextAsync` te entrega un contexto cuyo ciclo de vida controlas con `await using`. La factory evita el ámbito de la solicitud por completo, que es exactamente lo que quiere una tarea desacoplada. Si también llamas a `AddDbContextFactory`, ten en cuenta que en EF Core 11 el mismo registro puede satisfacer tanto la inyección de `AppDb` con ámbito como la inyección de la factory, así que no tienes que elegir una globalmente. Recurre a `AddPooledDbContextFactory` si el costo de creación aparece en un perfil, pero reinicia cualquier estado por contexto entre alquileres.

## Solución 3: deja de disparar y olvidar -- entrega el trabajo a un mecanismo real en segundo plano

`Task.Run` desde un manejador de solicitud es la herramienta equivocada incluso cuando arreglas el ciclo de vida del contexto: el trabajo no tiene reintento, ni contrapresión, ni manejo de apagado controlado, y el hilo en el que se ejecuta compite con el procesamiento de solicitudes. La solución duradera es encolar un mensaje y dejar que un hosted service lo drene en su propio ámbito. Un `Channel<T>` es la opción en proceso más ligera:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public sealed record AuditWork(int OrderId);

public class AuditQueue
{
    private readonly Channel<AuditWork> _channel =
        Channel.CreateUnbounded<AuditWork>();

    public ValueTask Enqueue(AuditWork work) => _channel.Writer.WriteAsync(work);
    public IAsyncEnumerable<AuditWork> Reader(CancellationToken ct) =>
        _channel.Reader.ReadAllAsync(ct);
}

public class AuditWorker(AuditQueue queue, IServiceScopeFactory scopeFactory)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var work in queue.Reader(stoppingToken))
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            db.AuditLog.Add(new Audit(work.OrderId));
            await db.SaveChangesAsync(stoppingToken);
        }
    }
}
```

Registra `AuditQueue` como singleton y `AuditWorker` con `AddHostedService`. El controlador ahora solo llama a `await queue.Enqueue(new AuditWork(orderId))` y retorna. Cada unidad de trabajo obtiene su propio ámbito y su propio contexto dentro del worker, el trabajo sobrevive al retorno de la solicitud, y el apagado drena de forma limpia porque el bucle respeta `stoppingToken`. Este es el patrón que cubre en detalle la [guía de fire-and-forget seguro con BackgroundService](/es/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/), y la [guía de Channels como reemplazo de BlockingCollection](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) explica el lado de la cola en profundidad.

## Por qué un BackgroundService que inyecta DbContext falla al iniciar

Una versión más sutil: inyectas `AppDb` directamente en el constructor de un `BackgroundService` y obtienes un error diferente primero.

```csharp
// .NET 11, EF Core 11.0.0 -- wrong, fails to start
public class AuditWorker(AppDb db) : BackgroundService { /* ... */ }
```

Un `BackgroundService` es un singleton. Inyectar un `AppDb` con ámbito en un singleton activa el validador de ámbitos de DI al iniciar con "Cannot consume scoped service 'AppDb' from singleton". Si de algún modo lo suprimes (no deberías), el singleton mantendría un contexto durante toda la vida del proceso y volverías a `ObjectDisposedException` o a errores de hilos la primera vez que dos iteraciones se solapen. La solución es el mismo patrón `CreateAsyncScope` de la Solución 1. La entrada sobre el [error de servicio con ámbito desde un singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/) y la [guía de servicios con ámbito dentro de un BackgroundService](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) explican ambas por qué los singletons no pueden mantener estado con ámbito.

## Liberación que provocaste tú mismo

Dos formas que no son fire-and-forget producen el mensaje idéntico:

Envolviste un contexto resuelto por DI en `using`. Si `AppDb` vino de inyección por constructor, el contenedor es su propietario; un bloque `using` lo libera antes de tiempo, y la siguiente llamada a un miembro en la misma solicitud lanza la excepción. Deja que el contenedor lo libere: elimina el `using`. Solo libera contextos que creaste tú mismo con `new` o vía una factory.

Retornaste un `IEnumerable<T>` o `IQueryable<T>` desde un método y el llamador lo enumera después de que el contexto ya no existe. LINQ diferido no se ejecuta hasta la enumeración; si el contexto del método estaba acotado a un `using` o a una solicitud que ya terminó, la enumeración alcanza un contexto liberado. Materializa dentro del método con `ToListAsync`, o mantén el contexto vivo durante la enumeración.

## Variantes que parecen esto pero no lo son

### "A second operation was started on this context instance before a previous operation completed"

La misma familia, causa diferente: dos operaciones se solaparon en un contexto vivo (no liberado), normalmente un `await` olvidado o un `Task.WhenAll` sobre un solo contexto. La solución también es un contexto por operación, detallada en la [guía de second-operation-started](/es/2026/05/fix-second-operation-was-started-on-this-context-instance/).

### "Cannot access a disposed object. Object name: 'IServiceProvider'"

Se liberó todo el ámbito o el proveedor raíz, no solo el contexto. La misma causa raíz (ciclo de vida), pero significa que capturaste un `IServiceProvider`/`IServiceScope` y lo usaste después de liberarlo. Resuelve todo lo que necesites antes de que el ámbito termine, o mantén el ámbito vivo durante el trabajo.

### "The ConnectionString property has not been initialized"

Un contexto creado con `new` sin proveedor configurado, no un problema de liberación. Esquivaste DI y olvidaste `OnConfiguring` o las opciones. Usa la factory o DI en lugar de `new AppDb()`.

### "ObjectDisposedException" en un CancellationTokenSource

Un `CancellationTokenSource` liberado mientras un token suyo todavía está en uso. No tiene relación con EF Core, aunque el tipo de excepción coincida. Mira la línea `Object name:` -- nombra el objeto liberado, y esa es tu señal de triaje más rápida.

## Relacionado

Para el panorama más amplio de ejecutar trabajo desacoplado sin filtrar estado con ámbito, las guías de [patrones de fire-and-forget seguro](/es/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) y [servicios con ámbito dentro de un BackgroundService](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) son las dos que leer a continuación. Si tu fire-and-forget empezó como un `async void`, el [desglose de async void vs async Task](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) explica por qué eso traga la excepción por completo. Y cuando la tarea desacoplada necesita detenerse de forma limpia al apagar, la [guía de cancelación sin deadlock](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) cubre la disciplina de tokens.

## Fuentes

- [DbContext lifetime, configuration, and initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), documentación de EF Core.
- [`IDbContextFactory<TContext>` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [`DbContext.CheckDisposed` source](https://github.com/dotnet/efcore/blob/main/src/EFCore/DbContext.cs), dotnet/efcore en GitHub.
- [Consuming a scoped service in a background task](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service), documentación de .NET.
- [`ServiceProviderServiceExtensions.CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope), Microsoft Learn.
