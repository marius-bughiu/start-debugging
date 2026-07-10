---
title: "Que es el contrato IHostedService y cuando lo uso?"
description: "IHostedService es la interfaz de dos metodos (StartAsync/StopAsync) que el host generico de .NET invoca al inicio y en el apagado ordenado. Esto es lo que promete el contrato, cuando implementarlo directamente y los cambios de comportamiento de .NET 10 y 11 que sorprenden a mucha gente."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "aspnetcore"
  - "csharp"
lang: "es"
translationOf: "2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it"
translatedBy: "claude"
translationDate: 2026-07-10
---

`IHostedService` es la interfaz de dos metodos que el host generico de .NET usa para iniciar y detener trabajo de larga duracion junto con tu aplicacion. Tiene exactamente dos miembros, `StartAsync(CancellationToken)` y `StopAsync(CancellationToken)`, y el host los invoca en puntos bien definidos: `StartAsync` antes de que la app empiece a atender solicitudes, `StopAsync` durante el apagado ordenado. Lo implementas directamente cuando necesitas control preciso sobre pasos ordenados de inicio o apagado. Para bucles continuos casi siempre querras `BackgroundService`, una pequena clase abstracta que implementa `IHostedService` por ti. Este articulo explica que garantiza realmente el contrato, cuando recurrir a la interfaz cruda y los cambios de comportamiento de .NET 10 y .NET 11 que hacen tropezar a la gente.

Todo lo aqui descrito apunta a .NET 11 y C# 14, con `Microsoft.Extensions.Hosting` 11.0.x. Donde el comportamiento cambio en una version concreta, lo senalo.

## El contrato son dos metodos y una promesa de secuencia

Esta es la interfaz completa:

```csharp
// .NET 11, C# 14 -- Microsoft.Extensions.Hosting.Abstractions
public interface IHostedService
{
    Task StartAsync(CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}
```

Esa es toda la superficie. Lo que la hace util no es la forma de los metodos sino las garantias que el host envuelve alrededor de ellos:

- El host espera (`await`) a `StartAsync` en cada servicio alojado registrado **antes** de considerar iniciada la aplicacion. En una app ASP.NET Core, eso significa antes de que Kestrel acepte la primera solicitud.
- Por defecto, los servicios inician **de forma secuencial, en el orden de registro**. El host no invoca el `StartAsync` del siguiente servicio hasta que el `Task` devuelto por el actual se completa.
- En el apagado, el host invoca `StopAsync` en cada servicio, en orden **inverso** al de registro, y espera hasta `HostOptions.ShutdownTimeout` (30 segundos por defecto) a que terminen.

La promesa de secuencia es la razon para prestar atencion. Si necesitas "calienta esta cache antes de que cualquier solicitud pueda golpear una ruta fria" o "abre esta conexion antes de que arranque el consumidor de la cola", `StartAsync` es el gancho correcto, porque el host no avanzara hasta que retorne.

## Por que StartAsync debe ser rapido

Como el inicio es secuencial por defecto, un `StartAsync` lento retrasa a todos los servicios registrados despues de el y retrasa que toda la aplicacion quede en linea. Este es el error mas comun con la interfaz cruda: poner un bucle de larga duracion directamente dentro de `StartAsync` y nunca retornar.

```csharp
// .NET 11, C# 14 -- WRONG: the host never finishes starting
public sealed class BrokenWorker : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        // This loop never returns, so StartAsync never completes,
        // so the host never starts, so no requests are served.
        while (!ct.IsCancellationRequested)
        {
            await DoWorkAsync();
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

La solucion es tratar a `StartAsync` como "arranca el trabajo y retorna". Inicia el bucle como un `Task` en segundo plano, guarda una referencia a el y espera esa referencia en `StopAsync`:

```csharp
// .NET 11, C# 14 -- correct raw IHostedService with a background loop
public sealed class QueueDrainService(ILogger<QueueDrainService> logger) : IHostedService
{
    private readonly CancellationTokenSource _stopping = new();
    private Task? _loop;

    public Task StartAsync(CancellationToken ct)
    {
        // Return quickly. Capture the loop task; do not await it here.
        _loop = RunAsync(_stopping.Token);
        return Task.CompletedTask;
    }

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await DrainOnceAsync(ct); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { logger.LogError(ex, "Drain failed; retrying"); }
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _stopping.Cancel();
        // Wait for the loop to unwind, but respect the shutdown deadline.
        if (_loop is not null)
            await _loop.WaitAsync(ct).ConfigureAwait(false);
    }

    private static Task DrainOnceAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Si ese patron parece codigo repetitivo, ese es exactamente el punto: es el codigo repetitivo que `BackgroundService` existe para eliminar.

## Donde encaja BackgroundService

`BackgroundService` es una clase abstracta del mismo espacio de nombres que implementa `IHostedService` y te da un solo metodo para sobrescribir:

```csharp
// .NET 11, C# 14 -- the shape BackgroundService hands you
public sealed class QueueDrainService(ILogger<QueueDrainService> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await DrainOnceAsync(stoppingToken); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { logger.LogError(ex, "Drain failed; retrying"); }
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }

    private static Task DrainOnceAsync(CancellationToken ct) => Task.CompletedTask;
}
```

La clase base almacena la tarea devuelta por `ExecuteAsync`, cancela el `stoppingToken` cuando el host se detiene y espera a tu bucle en su propio `StopAsync`. Es el mismo ciclo de vida que el ejemplo crudo de arriba, menos la fontaneria.

Asi que la regla practica es: **implementa `IHostedService` directamente solo cuando necesites que un trabajo se complete dentro de `StartAsync` antes de que la app quede en linea, o trabajo ordenado de apagado dentro de `StopAsync`.** Para un bucle continuo que solo necesita correr mientras corre la app, usa `BackgroundService`. Si quieres la comparacion mas profunda que incluye sistemas de trabajos durables, consulta [la matriz de decision de BackgroundService, IHostedService y Hangfire](/es/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/).

## El cambio de .NET 10 que movio ExecuteAsync fuera del hilo principal

Antes de .NET 10 habia una trampa sutil en `BackgroundService`: la porcion sincrona de `ExecuteAsync`, es decir todo lo anterior al primer `await`, corria en el hilo principal durante el inicio y bloqueaba el arranque de otros servicios. Solo el codigo posterior al primer `await` pasaba a un hilo en segundo plano.

A partir de .NET 10, [`BackgroundService` ejecuta la totalidad de `ExecuteAsync` en un hilo en segundo plano](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/backgroundservice-executeasync-task), asi que ninguna parte de el bloquea el arranque de otros servicios. Es una correccion bienvenida, pero cambia una suposicion de la que algun codigo dependia. Si hacias deliberadamente trabajo de configuracion antes del primer `await` para que corriera durante el inicio, ese trabajo ya no esta en la ruta de arranque.

Si necesitas que algo corra de forma sincrona durante el inicio otra vez, la documentacion detalla las opciones: hazlo en el constructor, sobrescribe `StartAsync` y ejecuta antes de `base.StartAsync`, implementa `IHostedLifecycleService` (mas abajo) o baja a un `IHostedService` crudo. La interfaz cruda nunca tuvo esta ambiguedad, lo cual es una razon mas para usarla cuando el orden de inicio importa de verdad.

## IHostedLifecycleService para ganchos mas granulares

Cuando dos ganchos `StartAsync` no bastan, .NET 8 anadio `IHostedLifecycleService`, que extiende `IHostedService` con cuatro callbacks mas:

```csharp
// .NET 11, C# 14 -- extends IHostedService with pre/post hooks
public interface IHostedLifecycleService : IHostedService
{
    Task StartingAsync(CancellationToken cancellationToken);
    Task StartedAsync(CancellationToken cancellationToken);
    Task StoppingAsync(CancellationToken cancellationToken);
    Task StoppedAsync(CancellationToken cancellationToken);
}
```

El host los invoca alrededor de los dos metodos centrales en este orden: `StartingAsync` en todos los servicios, luego `StartAsync` en todos los servicios, luego `StartedAsync` en todos los servicios. El apagado lo refleja: `StoppingAsync`, luego `StopAsync`, luego `StoppedAsync`. La distincion respecto al `IHostedService` simple es que estas fases corren como *lotes* a traves de cada servicio, asi que `StartingAsync` es el lugar para ejecutar trabajo que debe ocurrir antes del `StartAsync` de **cualquier** servicio, no solo del propio.

Rara vez lo necesitas. Recurre a el cuando tengas restricciones de orden entre servicios, como "cada servicio debe haber terminado su trabajo previo al inicio antes de que cualquiera de ellos abra un escucha de red". Para el caso comun, `IHostedService` simple o `BackgroundService` basta.

## Registrar servicios alojados

El registro es una sola linea, y el ciclo de vida de DI es fijo:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHostedService<QueueDrainService>();
builder.Services.AddHostedService<CacheWarmer>();

var app = builder.Build();
app.Run();
```

`AddHostedService<T>` registra el tipo como un `IHostedService` **singleton**. Eso tiene una consecuencia con la que la gente choca constantemente: no puedes inyectar un servicio con alcance (scoped, como un `DbContext` agrupado) directamente en el constructor de un servicio alojado, porque un singleton no puede depender de un servicio con alcance. Inyecta `IServiceScopeFactory` y crea un alcance por unidad de trabajo en su lugar. Esa trampa concreta, y su mensaje de excepcion exacto, se cubre en [por que no puedes consumir un servicio con alcance desde un singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/), y el patron de alcance correcto esta en [como usar servicios con alcance dentro de un BackgroundService](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

El orden de registro es el orden de las llamadas a `StartAsync` y el orden inverso de las llamadas a `StopAsync`, asi que registra primero los servicios de cuyo inicio dependen otros.

## Honrar los tokens de cancelacion

Ambos metodos reciben un `CancellationToken`, y significan cosas distintas.

El token pasado a `StartAsync` senala que se esta abortando el inicio. En la practica rara vez se dispara, pero aun asi deberias propagarlo por cualquier llamada asincrona que hagas para que un Ctrl+C durante un inicio lento realmente lo cancele.

El token pasado a `StopAsync` es el que importa. Se cancela cuando transcurre el plazo de apagado ordenado (`HostOptions.ShutdownTimeout`, 30 segundos por defecto). Si tu `StopAsync` lo ignora y sigue esperando, el host acabara desmontando el proceso de todos modos, y el trabajo en curso se pierde. Asi que tu logica de apagado deberia detenerse *con prontitud* cuando ese token se dispare, vaciando o marcando un punto de control de lo que pueda en lugar de intentar terminar todo.

```csharp
// .NET 11, C# 14 -- extend the shutdown window when your drain is slow
builder.Services.Configure<HostOptions>(o =>
    o.ShutdownTimeout = TimeSpan.FromSeconds(60));
```

Sube el tiempo de espera solo si tu trabajo realmente necesita mas para vaciarse limpiamente. Cancelar correctamente con el token es el habito mas importante, y se empareja con hacer bien la cancelacion en el resto de tu codigo asincrono, que es un tema propio en [como cancelar un Task de larga duracion sin interbloqueo](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## El cambio de .NET 11 en los codigos de salida ante fallos

Aqui esta el cambio de comportamiento con mas probabilidad de sorprenderte al actualizar. Cuando un `BackgroundService` lanza una excepcion no controlada desde `ExecuteAsync`, y `HostOptions.BackgroundServiceExceptionBehavior` se deja en su valor por defecto `StopHost`, el host se detiene. Ese valor por defecto existe desde .NET 6 (antes, el valor por defecto era `Ignore`, que te dejaba silenciosamente con un host zombi que parecia vivo pero no hacia trabajo).

Lo que cambio en .NET 11 Preview 3 es el codigo de salida. Antes, la tarea devuelta por `RunAsync`, `StopAsync` o `WaitForShutdownAsync` se completaba con *exito* aunque un servicio hubiera caido, asi que el proceso solia salir con codigo cero y tu orquestador creia que todo iba bien. A partir de .NET 11, [esos metodos ahora fallan con una excepcion](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/11/ihost-runasync-stopasync-throw-backgroundservice-failure) para que el proceso salga con codigo distinto de cero. Un unico servicio que falla relanza su excepcion; multiples fallos regresan como un `AggregateException`.

Este es casi siempre el comportamiento que quieres: un trabajador en segundo plano que ha caido no deberia reportar exito. Pero si tenias codigo que dependia del viejo comportamiento de exito silencioso, ahora veras una salida distinta de cero y posiblemente una excepcion no controlada en la cima de `Program.cs`. La accion recomendada por Microsoft es no hacer nada y dejar que falle ruidosamente. Si de verdad necesitas el viejo comportamiento, envuelve el `await host.RunAsync()` en un try/catch, o vuelve a poner el comportamiento de excepcion en `Ignore` y acepta la contrapartida:

```csharp
// .NET 11, C# 14 -- opt back into the old, quieter behavior (usually a mistake)
builder.Services.Configure<HostOptions>(o =>
    o.BackgroundServiceExceptionBehavior =
        BackgroundServiceExceptionBehavior.Ignore);
```

Yo no recurriria a `Ignore`. Un servicio alojado que puede caer y dejar el host corriendo pero inactivo es mucho mas dificil de diagnosticar que uno que tumba el proceso y es reiniciado por tu orquestador. La mejor solucion es capturar y registrar dentro de tu bucle, como hacen los ejemplos anteriores, para que una unica iteracion fallida nunca se convierta en una excepcion no controlada.

## Cuando la interfaz cruda es la eleccion correcta

Juntando todo, implementa `IHostedService` directamente cuando:

- Tengas trabajo de inicio que **debe completarse antes de que la app atienda trafico**: calentar una cache, ejecutar una verificacion de esquema o de migracion, establecer un pool de conexiones. Ponlo en `StartAsync` y deja que la garantia de inicio secuencial haga su trabajo.
- Tengas trabajo de apagado que debe correr en un **orden especifico**: vaciar un buffer, darse de baja de un endpoint de descubrimiento de servicios, enviar una metrica final. Ponlo en `StopAsync`.
- Quieras que la fontaneria sea explicita porque el ciclo de vida es inusual y prefieres leerlo a confiar en la clase base.

Usa `BackgroundService` para el caso mucho mas comun de un bucle que corre durante toda la vida de la app. Usa `IHostedLifecycleService` solo cuando necesites fases de pre-inicio o post-apagado por lotes a traves de multiples servicios. Y elijas lo que elijas, honra los tokens de cancelacion, manten `StartAsync` rapido y deja que los fallos salgan a la superficie. Para patrones relacionados, consulta [como ejecutar trabajo fire-and-forget de forma segura con BackgroundService](/es/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Fuentes

- [IHostedService Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.ihostedservice)
- [IHostedLifecycleService Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.ihostedlifecycleservice)
- [Breaking change: BackgroundService runs all of ExecuteAsync as a Task (.NET 10)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/backgroundservice-executeasync-task)
- [Breaking change: IHost.RunAsync and IHost.StopAsync throw when a BackgroundService fails (.NET 11)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/11/ihost-runasync-stopasync-throw-backgroundservice-failure)
- [BackgroundServiceExceptionBehavior Enum -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.backgroundserviceexceptionbehavior)
