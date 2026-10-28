---
title: "Solución: Cannot access a disposed object. Object name: 'IServiceProvider'"
description: "El código resolvió un servicio desde un scope de DI o un proveedor raíz después de que fue liberado. Captura IServiceScopeFactory en lugar de IServiceProvider y crea un scope nuevo donde se ejecuta el trabajo."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "aspnetcore"
  - "dependency-injection"
lang: "es"
translationOf: "2026/10/fix-cannot-access-a-disposed-object-object-name-iserviceprovider"
translatedBy: "claude"
translationDate: 2026-10-28
---

La solución: algo llamó a `GetService`, `GetRequiredService` o `CreateScope` sobre un `IServiceProvider` cuyo scope (o el contenedor completo) ya había sido liberado. Normalmente se trata de una tarea fire-and-forget que capturó `HttpContext.RequestServices`, de un servicio que guardó el `IServiceProvider` con scope para una resolución "perezosa", o de un bucle en segundo plano que sigue ejecutándose después de que el host se apagó. Deja de conservar `IServiceProvider`. Inyecta `IServiceScopeFactory`, llama a `CreateAsyncScope()` en el punto donde el trabajo realmente se ejecuta y resuelve todo desde ese nuevo scope.

```text
System.ObjectDisposedException: Cannot access a disposed object.
Object name: 'IServiceProvider'.
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ThrowHelper.ThrowObjectDisposedException()
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ServiceProviderEngineScope.GetService(Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService[T](IServiceProvider provider)
```

Cada fragmento y cada línea de salida de este artículo proviene de un repro que ejecuté en .NET 10 (runtime 10.0.10, `Microsoft.Extensions.DependencyInjection` tal como se distribuye en el shared framework, ASP.NET Core 10.0.10). La guarda que lanza esta excepción es idéntica en la rama `release/11.0` de `dotnet/runtime`, así que el mismo análisis aplica a .NET 11.

## Por qué el contenedor lanza una excepción en lugar de devolver null

En `Microsoft.Extensions.DependencyInjection`, cada scope es un `ServiceProviderEngineScope`. Implementa `IServiceScope`, `IServiceProvider` e `IServiceScopeFactory` al mismo tiempo, y el `IServiceProvider` que obtienes de `scope.ServiceProvider` es el propio objeto scope. Cuando el scope se libera, libera todos los `IDisposable`/`IAsyncDisposable` que creó y luego activa una bandera privada `_disposed`. A partir de ese momento, `GetService`, `GetKeyedService` y `GetRequiredKeyedService` empiezan con la misma comprobación:

```csharp
// dotnet/runtime, release/10.0
// src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs
public object? GetService(Type serviceType)
{
    if (_disposed)
    {
        ThrowHelper.ThrowObjectDisposedException();
    }

    return RootProvider.GetService(ServiceIdentifier.FromServiceType(serviceType), this);
}

// ThrowHelper.cs
internal static void ThrowObjectDisposedException()
{
    throw new ObjectDisposedException(nameof(IServiceProvider));
}
```

Ese `nameof(IServiceProvider)` es la razón por la que el nombre del objeto es siempre `'IServiceProvider'`, sin importar si llegaste desde un scope de solicitud, un scope creado a mano o el `ServiceProvider` raíz. El proveedor raíz tiene su propia bandera `_disposed` y pasa por el mismo helper, así que el mensaje por sí solo no te dice *cuál* proveedor murió. La traza de pila sí: `ServiceProviderEngineScope.GetService` significa un scope, mientras que un frame en `ServiceProvider.CreateScope` o `ServiceProvider.GetService` significa que el contenedor raíz ya no existe, lo que casi siempre quiere decir que el host fue liberado.

Dos consecuencias de ese diseño importan al depurar:

1. **Solo la resolución lanza la excepción.** Una instancia que ya resolviste antes de que terminara el scope sigue siendo un objeto normal. Si tiene su propia guarda de liberación (un `DbContext`, un `HttpClient`, un `CancellationTokenSource`), al usarla obtienes el `ObjectDisposedException` de *ese* tipo con su propio nombre de objeto, no este.
2. **El proveedor no está "roto", está terminado.** No hay forma de revivir un scope liberado. La solución es siempre usar un scope cuyo tiempo de vida cubra el trabajo.

## Las cuatro formas que lo provocan

Reproduje cada una en una sola aplicación de consola (`Microsoft.NET.Sdk.Web`, `net10.0`). Las cuatro imprimieron exactamente el mensaje de arriba.

### 1. Un proveedor con scope que escapa de su `using`

El repro más pequeño posible. La variable sobrevive al scope:

```csharp
// .NET 10, C# 14
var services = new ServiceCollection();
services.AddScoped<Repo>();
using var root = services.BuildServiceProvider();

IServiceProvider leaked;
using (var scope = root.CreateScope())
{
    leaked = scope.ServiceProvider;
}

leaked.GetRequiredService<Repo>(); // ObjectDisposedException: 'IServiceProvider'
```

Nadie escribe esto a propósito, pero aparece disfrazado todo el tiempo: un método auxiliar que hace `using var scope = ...; return scope.ServiceProvider;`, o un método `async` que crea un scope con `using var` y luego devuelve un `Task` o un `IAsyncEnumerable` que sigue resolviendo desde él después de que la parte síncrona del método ya retornó.

### 2. Una tarea fire-and-forget que capturó `HttpContext.RequestServices`

Esta es la que trae a la mayoría de la gente aquí. ASP.NET Core crea el scope de la solicitud de forma perezosa en `RequestServicesFeature` y registra la feature con `Response.RegisterForDisposeAsync`, así que el scope se libera apenas se completa la respuesta. Una tarea desacoplada que tomó `RequestServices` pierde la carrera:

```csharp
// .NET 10, ASP.NET Core 10.0.10 -- wrong
app.MapPost("/orders/{id}/export", (int id, HttpContext ctx) =>
{
    var sp = ctx.RequestServices;
    _ = Task.Run(async () =>
    {
        await Task.Delay(200);                       // the response is already sent
        var exporter = sp.GetRequiredService<OrderExporter>(); // throws
        await exporter.ExportAsync(id);
    });
    return Results.Accepted();
});
```

En mi repro el endpoint devolvió `202`, y 200 ms después la tarea registró `ObjectDisposedException: Cannot access a disposed object. Object name: 'IServiceProvider'.` Como la excepción ocurre en una tarea no observada, muchas veces solo la ves en los registros, o nunca, y el síntoma es "la exportación silenciosamente no ocurre". Lo mismo pasa cuando la tarea captura `IServiceProvider` mediante inyección por constructor en un controlador, o lee `IHttpContextAccessor.HttpContext.RequestServices` más tarde (donde además puedes obtener `null` porque el contexto fue reciclado).

### 3. Un servicio que guarda `IServiceProvider` para después

La variante del "service locator". Un servicio transient o con scope recibe `IServiceProvider` en su constructor para poder resolver dependencias bajo demanda:

```csharp
// .NET 10, C# 14 -- wrong
class ReportBuilder(IServiceProvider sp)
{
    public void Build() => sp.GetRequiredService<Repo>().Save();
}

ReportBuilder rb;
using (var scope = root.CreateScope())
    rb = scope.ServiceProvider.GetRequiredService<ReportBuilder>();

rb.Build(); // ObjectDisposedException: 'IServiceProvider'
```

El `IServiceProvider` inyectado en un servicio con scope o transient es el scope desde el que se resolvió, no el raíz. En cuanto `ReportBuilder` se entrega a algo que sobrevive al scope (una caché singleton, una suscripción a un evento de un singleton, un campo estático, un `Lazy<T>`, una fábrica `Func<T>` registrada con `sp => () => sp.GetRequiredService<T>()`), la siguiente resolución perezosa lanza la excepción. Si has visto el [error de dependencia cautiva, "Cannot consume scoped service from singleton"](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/), este es su primo en tiempo de ejecución: la validación de scopes detecta *servicios* cautivos al compilar, pero no puede ver un *proveedor* capturado.

### 4. Un bucle en segundo plano que sobrevive al host

El proveedor raíz se libera cuando se libera el host. `BackgroundService.StopAsync` cancela el token de detención y espera a `ExecuteAsync`, pero solo hasta que expira `HostOptions.ShutdownTimeout` (30 segundos por defecto desde .NET 6). Un bucle que ignora el token sigue ejecutándose después de que el host avanzó y liberó el contenedor:

```csharp
// .NET 10 -- wrong: ignores stoppingToken
class StubbornWorker(IServiceScopeFactory scopes) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (true)
        {
            using var scope = scopes.CreateScope(); // throws once the host is disposed
            scope.ServiceProvider.GetRequiredService<Repo>().Save();
            await Task.Delay(250);
        }
    }
}
```

Con `ShutdownTimeout` en 1 segundo, `StopAsync` retornó, se ejecutó `host.Dispose()` y la siguiente iteración imprimió `ObjectDisposedException: Cannot access a disposed object. Object name: 'IServiceProvider'.`. Ten en cuenta que este worker hace todo bien respecto a los scopes. El error es únicamente el token de cancelación ignorado. El mismo fallo aparece con callbacks de `System.Threading.Timer`, consumidores de `Channel` iniciados con `Task.Run` y manejadores de bus de mensajes que siguen procesando después del apagado. En las pruebas, aparece cuando un `WebApplicationFactory<T>` o un fixture de host se libera mientras una prueba (o una tarea en segundo plano que la prueba inició) todavía resuelve servicios desde `factory.Services`.

## Solución 1: captura `IServiceScopeFactory`, no `IServiceProvider`

Para las formas 2 y 3, esta es la solución. `IServiceScopeFactory` es especial en el contenedor: `ServiceProvider` lo registra como un call site constante que apunta al scope **raíz**, así que no importa desde dónde lo resuelvas. Incluso un `IServiceScopeFactory` inyectado en un endpoint con scope de solicitud está ligado al contenedor raíz y sigue funcionando después de que termina la solicitud. Crea el scope dentro del trabajo desacoplado, de modo que el tiempo de vida del scope sea exactamente el del trabajo:

```csharp
// .NET 10, ASP.NET Core 10.0.10 -- right
app.MapPost("/orders/{id}/export", (int id, IServiceScopeFactory scopes) =>
{
    _ = Task.Run(async () =>
    {
        await using var scope = scopes.CreateAsyncScope();
        var exporter = scope.ServiceProvider.GetRequiredService<OrderExporter>();
        await exporter.ExportAsync(id);
    });
    return Results.Accepted();
});
```

En el repro, el mismo retraso de 200 ms que rompía la versión con `RequestServices` registró `good: ok` aquí. Prefiere `CreateAsyncScope()` con `await using`: si algún servicio del scope implementa solo `IAsyncDisposable`, un `Dispose()` síncrono sobre el scope lanza `InvalidOperationException` indicando que uses `DisposeAsync`. La [guía de `IAsyncDisposable` y `await using`](/es/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) explica el porqué.

Tampoco pases *datos* ligados a la solicitud a través del scope. Copia lo que necesites (IDs, el nombre de usuario, un ID de correlación) a variables locales antes de iniciar la tarea. `HttpContext` en sí no es seguro de tocar después de que la respuesta se completa.

Para la forma del service locator, inyecta `IServiceScopeFactory` en `ReportBuilder` y crea un scope por cada llamada a `Build()`, o mejor aún, inyecta `Repo` directamente y deja que el contenedor administre los tiempos de vida. Si la dependencia realmente es opcional o costosa, un registro con clave o con fábrica que resuelva desde un scope nuevo es más limpio que guardar el proveedor.

## Solución 2: mueve el trabajo a un mecanismo real de segundo plano

`Task.Run` desde un manejador de solicitud es la raíz del problema en la forma 2. Nada rastrea la tarea, nada observa su excepción y nada la detiene al apagar. Pon el elemento de trabajo en un `Channel<T>` y drénalo desde un `BackgroundService` que cree un scope por elemento:

```csharp
// .NET 10, C# 14
public sealed class ExportQueue
{
    private readonly Channel<int> _channel = Channel.CreateUnbounded<int>();
    public ValueTask EnqueueAsync(int orderId) => _channel.Writer.WriteAsync(orderId);
    public IAsyncEnumerable<int> ReadAllAsync(CancellationToken ct) => _channel.Reader.ReadAllAsync(ct);
}

public sealed class ExportWorker(ExportQueue queue, IServiceScopeFactory scopes, ILogger<ExportWorker> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var id in queue.ReadAllAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<OrderExporter>().ExportAsync(id, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.LogError(ex, "Export of order {OrderId} failed", id);
            }
        }
    }
}

// Program.cs
builder.Services.AddSingleton<ExportQueue>();
builder.Services.AddHostedService<ExportWorker>();
app.MapPost("/orders/{id}/export", async (int id, ExportQueue queue) =>
{
    await queue.EnqueueAsync(id);
    return Results.Accepted();
});
```

El patrón completo, incluidos los canales con límite y la contrapresión, está en [cómo ejecutar trabajo fire-and-forget de forma segura con BackgroundService](/es/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/). La parte del scope por iteración se cubre a fondo en [usar servicios con scope dentro de un BackgroundService](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

## Solución 3: respeta el token de detención para que nada se ejecute después de la liberación

Para la forma 4, el código de los scopes está bien y el error es el tiempo de vida del bucle. Pasa `stoppingToken` a cada await y a cada condición del bucle, de modo que el bucle termine antes de que expire `ShutdownTimeout`:

```csharp
// .NET 10 -- right
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
    while (await timer.WaitForNextTickAsync(stoppingToken))
    {
        await using var scope = scopes.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<Repo>().SaveAsync(stoppingToken);
    }
}
```

`PeriodicTimer.WaitForNextTickAsync` lanza `OperationCanceledException` al cancelarse, y `BackgroundService` trata una cancelación que coincide con el token de detención como una salida limpia. Si una sola unidad de trabajo legítimamente tarda más de 30 segundos, aumenta `HostOptions.ShutdownTimeout` en lugar de ignorar el token; de lo contrario, el host liberará el contenedor bajo tus pies. El [artículo sobre el contrato de IHostedService](/es/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) recorre el orden exacto de inicio y detención.

Para las pruebas de integración, asegúrate de que la prueba espere cada tarea que inicia antes de que se ejecute el `DisposeAsync` del fixture, y resuelve los servicios por prueba desde `factory.Services.CreateAsyncScope()` en lugar de directamente desde `factory.Services`.

## Casos límite y parecidos

**La carrera dentro de la resolución.** `ServiceProviderEngineScope.CaptureDisposable` comprueba `_disposed` bajo un lock después de construir un servicio liberable. Si el scope se liberó *mientras* tu servicio se creaba en otro hilo, el contenedor libera la instancia recién construida y luego lanza esta misma excepción. Por eso puedes verla en una ruta de código que parecía correcta un microsegundo antes. Sigue siendo el mismo error: dos hilos no coinciden sobre el tiempo de vida del scope.

**`app.Services` después de que `app.Run` retorna.** Cualquier cosa en `Program.cs` que se ejecute después de `app.Run()` o `await app.RunAsync()` (código de limpieza, un vaciado final) se ejecuta después de que el host fue liberado. Resuelve lo que necesites antes de llamar a `Run`, o mueve la lógica a un callback de `IHostApplicationLifetime.ApplicationStopping`.

**`IServiceProvider` en un singleton es el raíz.** Inyectar `IServiceProvider` en un singleton te da el proveedor raíz, que solo se libera junto con el host, así que no lanzará esta excepción durante la operación normal. Sin embargo, entregará con gusto servicios con scope desde el scope raíz si `ValidateScopes` está desactivado, lo que los convierte en singletons accidentales. Usa `IServiceScopeFactory` también ahí.

**"Cannot access a disposed context instance".** Si el nombre del objeto en tu mensaje es el tipo de tu `DbContext` (`Object name: 'AppDb'`), lo que se liberó fueron los servicios del scope, no el proveedor, y la solución es un contexto nuevo por operación: consulta [la guía del DbContext liberado](/es/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/).

**`Object name: 'System.Net.Http.HttpClient'` o un `CancellationTokenSource`.** Mismo tipo de excepción, distinto dueño. Esas vienen de liberar una instancia que resolviste, no de resolver después de la liberación.

## Relacionado

- [Solución: Cannot consume scoped service from singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/) para la versión en tiempo de compilación de los tiempos de vida capturados.
- [Cómo usar servicios con scope dentro de un BackgroundService](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) para el patrón de un scope por unidad de trabajo.
- [Cómo ejecutar trabajo fire-and-forget de forma segura con BackgroundService](/es/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) para reemplazar `Task.Run` en los manejadores.
- [Solución: Cannot access a disposed context instance](/es/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) para la variante de EF Core del mismo error de tiempo de vida.
- [Cómo escribir pruebas de integración con WebApplicationFactory](/es/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) para los tiempos de vida de los fixtures en las pruebas.

## Fuentes

- [`ServiceProviderEngineScope.cs` en `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs) (la guarda `_disposed` y `CaptureDisposable`).
- [`ThrowHelper.cs` en `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ThrowHelper.cs) (`new ObjectDisposedException(nameof(IServiceProvider))`).
- [`ServiceProvider.cs` en `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceProvider.cs) (`IServiceScopeFactory` registrado como constante ligada al scope raíz).
- [`RequestServicesFeature.cs` en `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Http/Http/src/Features/RequestServicesFeature.cs) (scope de la solicitud liberado mediante `RegisterForDisposeAsync`).
- [Directrices de inyección de dependencias](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines) en Microsoft Learn.
- [Usar servicios con scope dentro de un BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) en Microsoft Learn.
- Referencia de API de [`HostOptions.ShutdownTimeout`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.shutdowntimeout).
