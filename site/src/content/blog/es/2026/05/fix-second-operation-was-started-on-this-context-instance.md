---
title: "Solución: A second operation was started on this context instance before a previous operation completed"
description: "EF Core lanza esta excepción cuando dos await corren en paralelo sobre el mismo DbContext. Espera cada llamada de forma secuencial, u obtén un DbContext nuevo por unidad de trabajo concurrente vía IDbContextFactory."
pubDate: 2026-05-07
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "async"
lang: "es"
translationOf: "2026/05/fix-second-operation-was-started-on-this-context-instance"
translatedBy: "claude"
translationDate: 2026-05-07
---

La solución: un `DbContext` no es seguro para hilos y solo puede tener una consulta, un guardado o un recorrido del rastreador de cambios en curso a la vez. La excepción significa que dos operaciones sobre la misma instancia se solaparon, casi siempre porque se inició una `Task` sin `await`, porque un cuerpo de `Parallel.ForEachAsync` compartió el contexto, o porque un campo capturado fue accedido desde dos solicitudes a la vez. Espera la primera llamada antes de iniciar la segunda, o entrega a cada unidad de trabajo concurrente su propio `DbContext` mediante `IDbContextFactory<T>`.

```text
System.InvalidOperationException: A second operation was started on this context instance before a previous operation completed. This is usually caused by different threads concurrently using the same instance of DbContext. For more information on how to avoid threading issues with DbContext, see https://go.microsoft.com/fwlink/?linkid=2097913.
   at Microsoft.EntityFrameworkCore.Internal.ConcurrencyDetector.EnterCriticalSection()
   at Microsoft.EntityFrameworkCore.Query.Internal.QueryCompiler.ExecuteAsync[TResult](Expression query, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Query.Internal.EntityQueryProvider.ExecuteAsync[TResult](Expression expression, CancellationToken cancellationToken)
   at System.Linq.AsyncEnumerable.ToListAsync[TSource](IAsyncEnumerable`1 source, CancellationToken cancellationToken)
```

Esta guía está escrita contra .NET 11 preview 4 y `Microsoft.EntityFrameworkCore` 11.0.0-preview.4. El texto y el `ConcurrencyDetector` subyacente han sido los mismos desde EF Core 2.0; los detalles internos de la traza de pila circundante cambian entre versiones. La excepción se lanza desde `ConcurrencyDetector.EnterCriticalSection`, que protege todas las API públicas asíncronas de `DbContext`. No hay condición de carrera del lado de EF Core, el detector tiene razón: detectó que estás intentando ejecutar dos operaciones a través de un único mapa de identidad y un único comando abierto.

## Por qué un DbContext es de un solo hilo por diseño

`DbContext` mantiene una máquina de estados privada: un mapa de identidad de entidades rastreadas, una lista pendiente de cambios, una `DbConnection` abierta, y como mucho un `DbCommand` en curso. Los proveedores ADO.NET no permiten dos comandos sobre la misma conexión a menos que MARS esté activo, e incluso con MARS, las mutaciones del rastreador de cambios entre dos consultas competirían entre sí de formas arbitrarias. En lugar de sincronizar todo internamente y pagar el coste en cada llamada, EF Core dice no: una operación a la vez por instancia. El `ConcurrencyDetector` es una aplicación amigable para depuración de ese contrato, no la causa del problema.

Este contrato se sostiene en cada método `*Async`: `ToListAsync`, `FirstOrDefaultAsync`, `SaveChangesAsync`, `AnyAsync`, `CountAsync`, `Database.ExecuteSqlAsync`, además de los hermanos síncronos si mezclas `.Result` o `.GetAwaiter().GetResult()` en el mismo punto de llamada. Si dos de estos se solapan sobre el mismo `DbContext`, el segundo lanza.

## Una reproducción mínima

La reproducción más corta y fiable es `Task.WhenAll` sobre el mismo contexto:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class Report(AppDb db)
{
    public async Task<(int customers, int orders)> Counts()
    {
        var customersTask = db.Customers.CountAsync();
        var ordersTask = db.Orders.CountAsync();

        await Task.WhenAll(customersTask, ordersTask); // throws
        return (await customersTask, await ordersTask);
    }
}
```

Ambas llamadas a `CountAsync` arrancan casi simultáneamente; la segunda entra en `ConcurrencyDetector.EnterCriticalSection` mientras la primera todavía está dentro, y el detector lanza. La solución no es introducir bloqueo, es reconocer que querías dos unidades de trabajo independientes y solo tenías una herramienta.

Una reproducción más sutil es olvidar un `await`:

```csharp
// .NET 11, EF Core 11.0.0 -- still wrong
public async Task ProcessOrder(int id)
{
    var orderTask = db.Orders.FirstOrDefaultAsync(o => o.Id == id);
    var auditTask = db.AuditLog.AddAsync(new AuditEntry(id)); // no await
    await db.SaveChangesAsync(); // throws
}
```

`AddAsync` devuelve un `ValueTask`. Sin esperarlo no has terminado realmente de añadir, pero la llamada ya tocó el rastreador de cambios. Luego `SaveChangesAsync` se ejecuta contra un rastreador en plena mutación y el detector se dispara. Misma causa raíz: dos operaciones se solapan sobre la misma instancia.

## Tres soluciones, en orden de preferencia

Aplícalas en este orden. La primera es la respuesta correcta en el 90% de los casos; la tercera es la salida de emergencia para trabajo genuinamente concurrente.

### 1. Espera de forma secuencial cuando solo necesitas una conexión

Si en realidad no necesitas que las consultas corran en paralelo, no las arranques en paralelo. El coste de reloj de pared de dos `CountAsync` secuenciales rara vez compensa el bug:

```csharp
// .NET 11, EF Core 11.0.0
public async Task<(int customers, int orders)> Counts()
{
    var customers = await db.Customers.CountAsync();
    var orders = await db.Orders.CountAsync();
    return (customers, orders);
}
```

Para un manejador de solicitud que habla con una única base de datos, esto es casi siempre lo correcto. La segunda consulta corre sobre la misma conexión ya abierta, así que no hay coste de un segundo viaje de ida y vuelta más allá de la propia consulta. Recurre al paralelismo solo cuando hayas medido que dos consultas contra el mismo backend ahorran tiempo real, lo cual es poco común porque la propia base de datos serializa los comandos por conexión de todos modos.

### 2. Usa IDbContextFactory para unidades de trabajo realmente concurrentes

Cuando necesitas dos consultas corriendo al mismo tiempo (sobre todo en un `BackgroundService`, un trabajo de `Hangfire`, una herramienta de CLI procesando lotes, o escenarios de fan-out), entrega a cada tarea su propio `DbContext`:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

public class Report(IDbContextFactory<AppDb> factory)
{
    public async Task<(int customers, int orders)> Counts()
    {
        var customersTask = CountAsync(db => db.Customers);
        var ordersTask = CountAsync(db => db.Orders);

        await Task.WhenAll(customersTask, ordersTask);
        return (await customersTask, await ordersTask);
    }

    private async Task<int> CountAsync<T>(Func<AppDb, IQueryable<T>> set)
    {
        await using var db = await factory.CreateDbContextAsync();
        return await set(db).CountAsync();
    }
}
```

Cada operación concurrente obtiene ahora su propio contexto, su propia conexión del pool y su propio rastreador de cambios. No hay estado mutable compartido, así que el detector no tiene nada de lo que quejarse. `AddDbContextFactory` es el registro soportado; no intentes hacer `new` manualmente sobre un `DbContext` para escapar del ciclo de vida, pasa por encima de la resolución de opciones y del pooling.

Si además quieres instancias del pool para una creación barata, registra `AddPooledDbContextFactory` en su lugar. Para los compromisos de las fábricas con pool en montajes de pruebas, [el patrón de intercambio de fábrica con pool removible](/es/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) cubre el detalle del estado que se filtra entre alquileres.

### 3. Resuelve un scope nuevo por operación

En el ciclo de vida scoped administrado por el framework (el predeterminado para ASP.NET Core), la solución es crear un scope hijo para cada rama paralela:

```csharp
// .NET 11, EF Core 11.0.0
public class Report(IServiceScopeFactory scopes)
{
    public async Task ProcessAll(IEnumerable<int> ids)
    {
        await Parallel.ForEachAsync(ids, async (id, ct) =>
        {
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            var order = await db.Orders.FirstOrDefaultAsync(o => o.Id == id, ct);
            // ... process order ...
        });
    }
}
```

`CreateAsyncScope` construye un scope de DI nuevo, así que resolver `AppDb` desde él devuelve una instancia distinta a la del scope de la solicitud externa y a la de cada otra iteración. Esta es la forma correcta para `Parallel.ForEachAsync` contra EF Core. El patrón de fábrica de la solución 2 es preferible cuando el trabajo es puramente acceso a datos; el patrón de scope es mejor cuando el cuerpo del bucle también necesita otros servicios scoped.

## Patrones habituales que disparan esto

### Compartir el DbContext de la solicitud con Task.Run

Un error clásico de ASP.NET Core: un manejador de solicitud lanza una tarea fire-and-forget que captura el `DbContext` con scope de la solicitud:

```csharp
// .NET 11, EF Core 11.0.0 -- wrong
[HttpPost]
public IActionResult QueueWork()
{
    _ = Task.Run(async () =>
    {
        await db.AuditLog.AddAsync(new AuditEntry("queued"));
        await db.SaveChangesAsync();
    });
    return Accepted();
}
```

Aquí se solapan dos modos de fallo. Primero, la solicitud retorna y el scope de DI desecha el `DbContext` mientras la tarea de fondo todavía corre, así que también verás `ObjectDisposedException`. Segundo, si cualquier otra ruta de código en la solicitud sigue usando el contexto, ambos hilos compiten por él y el detector lanza. La solución es la misma que en #2: inyecta `IDbContextFactory<AppDb>`, o pasa el trabajo a un mecanismo de fondo real (`IHostedService`, channels, una cola de trabajos) que posea su propio scope. [La guía de Channels como reemplazo de BlockingCollection](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) cubre el patrón de cola en proceso.

### Hacer streaming de un IAsyncEnumerable a través de un límite HTTP

Si devuelves `IAsyncEnumerable<T>` desde un controlador respaldado por una consulta de EF Core, ASP.NET Core lo enumera mientras serializa la respuesta. Si cualquier otra cosa en ese scope golpea el mismo `DbContext` mientras la serialización está en curso, el detector lanza. Es fácil de provocar cuando un middleware más tarde añade una fila de auditoría en un callback `OnStarting` mientras el cuerpo todavía está haciendo streaming.

La solución es materializar el enumerable, o asegurarte de que el endpoint de streaming sea el único acceso a ese contexto durante el ciclo de vida de la respuesta. [La guía de `IAsyncEnumerable` con EF Core](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) recorre el modelo de streaming y los ciclos de vida que funcionan con él.

### DbContext capturado en un manejador de eventos o campo estático

Un `DbContext` almacenado como campo estático, o capturado en un manejador de eventos suscrito al arranque, será reutilizado en cada evento. Dos eventos que llegan cerca uno del otro se solaparán sobre él. La misma solución: inyecta la fábrica, no captures.

### DbContext con scope Singleton

Un `DbContext` registrado como `Singleton` (por error o vía `AddSingleton<MyService>` donde `MyService` inyecta `AppDb`) acaba compartido entre solicitudes. La concurrencia entonces está garantizada bajo cualquier carga real. [La guía de colisión del mapa de identidad](/es/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/) recorre la misma trampa Singleton/Scoped desde el ángulo de la clave duplicada; ambos errores vienen de la misma causa raíz.

### Mezclar sync y async en el mismo punto de llamada

`db.SaveChanges()` seguido de una consulta asíncrona en curso iniciada antes (y no esperada) disparará el detector cuando finalmente hagas `await` sobre la asíncrona. Esto suele aparecer en rutas de código heredadas donde alguien añadió un `_ = SomethingAsync()` para suprimir la advertencia del compilador. Suprimir la advertencia también suprimió el bug; la solución es hacerle `await`.

### Reusar un DbContext entre intentos de retry de Polly

Si envuelves una llamada en `Polly` y el retry corre mientras la `Task` del intento anterior sigue viva (la cancelación no se propagó limpiamente), ambos intentos tocan el mismo contexto. Empareja los retries con `IDbContextFactory<T>` para que cada intento obtenga un contexto nuevo, o asegúrate de que el intento anterior está totalmente cancelado (`ct.ThrowIfCancellationRequested()` recorra la llamada de EF Core) antes de reintentar. [La guía de cancelar sin interbloqueo](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) cubre la disciplina de cancelación que hace esto seguro.

## Variantes que se parecen a este error pero no lo son

### "There is already an open DataReader associated with this Connection which must be closed first"

Excepción distinta, misma familia. Esta viene de ADO.NET cuando MARS está apagado e intentaste arrancar un segundo lector sobre la misma conexión. EF Core esconde esto la mayoría del tiempo, pero el trabajo crudo con `db.Database.GetDbConnection()` salta el detector y muestra el error subyacente en su lugar. La solución tiene la misma forma (una operación a la vez, o una conexión por operación), pero activar `MultipleActiveResultSets=True` en tu cadena de conexión de SQL Server te permite ejecutar lectores anidados si realmente lo necesitas.

### "ObjectDisposedException: Cannot access a disposed context"

Significa que el scope de DI ya desechó el `DbContext` mientras una tarea capturada intentó usarlo. Generalmente un `Task.Run` fire-and-forget desde un manejador HTTP, o un `BackgroundService` que capturó un contexto scoped al arranque. La solución es resolver el contexto dentro de la tarea, no fuera.

### "The instance of entity type cannot be tracked because another instance with the same key value is already being tracked"

Conflicto del mapa de identidad, una forma de un solo hilo. Dos objetos CLR, misma clave primaria, mismo contexto. Recorre la solución en detalle [en la guía de rastreo de entidades](/es/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/).

### "InvalidOperationException: Synchronous operations are disallowed"

Kestrel rechazando `Stream.Read` en lugar de `Stream.ReadAsync` sobre el cuerpo de la respuesta. Pila distinta, solución distinta (`AllowSynchronousIO = true` o moverse a APIs asíncronas). No es un problema de `DbContext`.

## Relacionados

Para una higiene más amplia de EF Core, consulta [la guía de detección de N+1](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) y [la guía de consultas compiladas en hot paths](/es/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) para el diseño de consultas una vez que el modelo de concurrencia esté correcto. Para fixtures de pruebas que entregan una base de datos real a tu código sin compartir un contexto entre hilos, [la guía de Testcontainers contra SQL Server real](/es/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) es el montaje más limpio. [El post de detección de N+1](/es/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) también cubre los hooks del logger de EF Core 11 que puedes reutilizar para señalar `await` olvidados en CI.

## Fuentes

- [Avoiding DbContext threading issues](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#avoiding-dbcontext-threading-issues), documentación de EF Core.
- [`IDbContextFactory<TContext>` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [`AddDbContextFactory` extension](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.adddbcontextfactory), Microsoft Learn.
- [`ConcurrencyDetector` source](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/ConcurrencyDetector.cs), dotnet/efcore en GitHub.
- [`IServiceScopeFactory.CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope), Microsoft Learn.
