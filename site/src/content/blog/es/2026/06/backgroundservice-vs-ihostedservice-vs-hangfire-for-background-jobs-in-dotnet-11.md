---
title: "BackgroundService vs IHostedService vs Hangfire para tareas en segundo plano en .NET 11"
description: "Elige BackgroundService para bucles en proceso, IHostedService puro cuando necesitas control fino del ciclo de vida, y Hangfire cuando las tareas deben sobrevivir a un reinicio. Una matriz de decisión con código y el detalle que decide por ti."
pubDate: 2026-06-03
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
lang: "es"
translationOf: "2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-03
---

Para trabajo en segundo plano en una aplicación .NET 11, la respuesta corta es: usa `BackgroundService` para bucles continuos en proceso y consumidores de colas, baja a un `IHostedService` puro solo cuando necesites un arranque o apagado ordenado y explícito, y recurre a Hangfire en cuanto una tarea tenga que sobrevivir a un reinicio del proceso o haya que programarla para "el próximo martes a las 2 de la madrugada". Los dos primeros son la misma primitiva de hosting a distinta altitud y no te cuestan nada extra. Hangfire es una dependencia aparte con una base de datos detrás, y esa base de datos es exactamente lo que estás pagando. Este artículo construye la matriz de decisión, muestra el código mínimo de cada opción y señala el único requisito (la durabilidad) que normalmente decide por ti.

Todos los ejemplos apuntan a .NET 11 y C# 14. Los ejemplos de Hangfire usan Hangfire 1.8.x (`Hangfire.AspNetCore` más `Hangfire.SqlServer`).

## La matriz de características

Esta es la tabla que viniste a ver. Lee primero la fila "Sobrevive a un reinicio"; es la que divide el campo.

| Característica                   | IHostedService          | BackgroundService        | Hangfire                       |
| -------------------------------- | ----------------------- | ------------------------ | ------------------------------ |
| Integrado en .NET 11             | sí                      | sí                       | no (NuGet + almacenamiento)    |
| Infraestructura extra            | ninguna                 | ninguna                  | SQL Server / Redis / Postgres  |
| Superficie de ciclo de vida      | `StartAsync`/`StopAsync`| un `ExecuteAsync`        | ninguna (tú encolas tareas)    |
| Mejor para                       | pasos de arranque/apagado| bucles de larga duración | tareas puntuales y programadas |
| Sobrevive a un reinicio          | no                      | no                       | sí                             |
| Reintentos ante fallos           | los escribes tú         | los escribes tú          | automáticos, configurables     |
| Programación (cron, retraso)     | la escribes tú          | la escribes tú           | integrada                      |
| Se ejecuta en varias instancias  | corre en cada instancia | corre en cada instancia  | un worker toma cada tarea      |
| Panel / visibilidad              | ninguno                 | ninguno                  | panel web integrado            |
| Costo                            | gratis                  | gratis                   | núcleo OSS; licencia Pro a veces |

`BackgroundService` no es una alternativa a `IHostedService`; es una clase abstracta que lo implementa. Así que la verdadera elección es de dos vías: un servicio de hosting en proceso (en una de sus dos formas) frente a un sistema de tareas durable externo. Vamos en orden.

## IHostedService: el contrato de ciclo de vida puro

`IHostedService` es la interfaz de bajo nivel que el host genérico de .NET llama durante el arranque y el apagado. Tiene exactamente dos métodos:

```csharp
// .NET 11, C# 14
public interface IHostedService
{
    Task StartAsync(CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}
```

El host espera (con `await`) el `StartAsync` de cada servicio registrado en orden de registro antes de atender la primera solicitud, y espera el `StopAsync` (hasta `HostOptions.ShutdownTimeout`, 30 segundos por defecto) antes de que el proceso termine. Esa garantía de orden es la razón para usar la interfaz pura: es el lugar correcto para trabajo que debe completarse antes de que llegue tráfico (precalentar una caché, ejecutar una comprobación de migración única, abrir una conexión de larga vida).

```csharp
// .NET 11, C# 14
public sealed class CacheWarmer(IMemoryCache cache, IProductRepository repo) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        // Runs to completion BEFORE the app starts serving requests.
        var hot = await repo.GetHotProductsAsync(ct);
        cache.Set("hot-products", hot);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

La trampa con el `IHostedService` puro es hacer trabajo de larga duración dentro de `StartAsync`. Si arrancas ahí un bucle infinito y lo esperas con `await`, el host nunca termina de arrancar. Tienes que disparar el bucle sin esperarlo y rastrear el `Task` tú mismo, para luego cancelarlo y esperarlo en `StopAsync`. Esa contabilidad es exactamente lo que `BackgroundService` existe para eliminar.

Si necesitas un control aún más fino (un gancho que se ejecute *después de que cada* servicio de hosting haya arrancado, o justo antes de que comience el apagado), .NET 8 añadió `IHostedLifecycleService`, que extiende `IHostedService` con `StartingAsync`/`StartedAsync` y `StoppingAsync`/`StoppedAsync`. Sigue vigente en .NET 11 y es el lugar documentado para una validación entre servicios del tipo "ahora todo está arriba", como describe el [recorrido de la interfaz de Steve Gordon](https://www.stevejgordon.co.uk/introducing-the-new-ihostedlifecycleservice-interface-in-dotnet-8).

## BackgroundService: el bucle que realmente quieres

`BackgroundService` es la clase base abstracta que implementa `IHostedService` por ti usando el patrón método-plantilla. Sobrescribes un solo método:

```csharp
// .NET 11, C# 14
public sealed class QueuePump(IServiceScopeFactory scopeFactory, ILogger<QueuePump> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();
                await processor.DrainOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break; // normal shutdown
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Order pump iteration failed; retrying");
            }

            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }
}
```

El framework llama a `ExecuteAsync` desde su propio `StartAsync`, señala el `stoppingToken` cuando el host se detiene y espera con `await` el `Task` que devuelves durante el apagado. Dos detalles muerden a la gente con suficiente frecuencia como para mencionarlos:

- **Un `BackgroundService` es un singleton.** No puedes inyectar un servicio con ámbito como un `DbContext` directamente; tomas `IServiceScopeFactory` y abres un ámbito por unidad de trabajo, exactamente como arriba. Escribí un recorrido dedicado sobre [usar servicios con ámbito dentro de un BackgroundService](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).
- **Una excepción no controlada en `ExecuteAsync` detiene el servicio de forma silenciosa** (y desde .NET 6, por defecto, detiene todo el host mediante `BackgroundServiceExceptionBehavior.StopHost`). Envuelve el cuerpo del bucle en try/catch si una sola iteración mala no debe matar el servicio, como se muestra.

Registra cualquiera de las dos formas de la misma manera:

```csharp
// .NET 11, C# 14 -- Program.cs
builder.Services.AddHostedService<QueuePump>();      // BackgroundService
builder.Services.AddHostedService<CacheWarmer>();    // raw IHostedService
```

Un `BackgroundService` emparejado con un `System.Threading.Channel` acotado es la cola de tareas en proceso canónica: los productores escriben elementos de trabajo, el servicio los drena. Si alguna vez recurriste a `Task.Run` desde un controlador, ese es el patrón que en realidad querías: consulta [ejecutar trabajo fire-and-forget de forma segura con un BackgroundService](/es/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) y el argumento más amplio a favor de los [Channels frente a BlockingCollection](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## Cuándo elegir las opciones en proceso

**Elige `BackgroundService` cuando:**

- Tienes un bucle continuo: un consumidor de cola, un sondeador, un latido, un volcado de métricas. Este es su terreno natural.
- Es aceptable perder el trabajo en el apagado, o drenas los elementos en vuelo en la breve ventana de `StopAsync`. Reintentos de correo que de todos modos se reactivarán desde una cola, refrescos de caché, envío de logs.
- Quieres cero infraestructura nueva. Viene en `Microsoft.Extensions.Hosting`; no hay nada que instalar ni aprovisionar.

**Elige `IHostedService` puro (o `IHostedLifecycleService`) cuando:**

- Necesitas que el trabajo termine *antes* de que se atienda la primera solicitud (precalentar caché, comprobar esquema, prefetch de feature flags).
- Necesitas un arranque o apagado ordenado entre varios servicios, o un gancho de validación "todo en verde" posterior al arranque.
- El trabajo es un paso discreto de inicio/parada, no un bucle perpetuo, por lo que la forma de un solo `ExecuteAsync` de `BackgroundService` no encaja.

Ambos corren en *cada* instancia de tu aplicación. Si escalas a tres réplicas, tu `BackgroundService` corre tres veces, en paralelo, sin coordinación. Para un sondeador sin estado eso está bien. Para "enviar el correo nocturno de facturas una vez", es un bug.

## Cuándo elegir Hangfire

**Elige Hangfire cuando se cumpla alguna de estas:**

- **Una tarea debe sobrevivir a un reinicio o caída.** Hangfire escribe la tarea en el almacenamiento (SQL Server, Redis o PostgreSQL) antes de ejecutarla, de modo que un despliegue a mitad de una tarea no la pierde. La tarea se vuelve a tomar. Esta es la característica estrella.
- **Necesitas programación.** "Ejecutar en 10 minutos", "cada día laborable a las 6 de la mañana" (cron), "este instante UTC exacto". Integrada, sin matemáticas de temporizadores.
- **Necesitas reintentos automáticos con retroceso.** Hangfire reintenta las tareas fallidas un número configurable de veces por defecto, con el historial de intentos visible en su panel.
- **Necesitas una única ejecución en N instancias.** Los servidores de Hangfire compiten por las tareas del almacenamiento compartido, así que cada tarea se ejecuta una vez sin importar cuántas instancias de la aplicación estén arriba. Eso resuelve limpiamente el problema del "correo nocturno tres veces".
- **Quieres visibilidad operativa.** El panel incluido muestra tareas encoladas, en proceso, exitosas y fallidas con sus trazas de pila, algo que de otro modo tendrías que construir tú.

Configuración mínima en .NET 11:

```csharp
// .NET 11, C# 14 -- Program.cs
builder.Services.AddHangfire(cfg => cfg
    .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
    .UseSimpleAssemblyNameTypeSerializer()
    .UseRecommendedSerializerSettings()
    .UseSqlServerStorage(builder.Configuration.GetConnectionString("HangfireDb")));

builder.Services.AddHangfireServer();

var app = builder.Build();
app.UseHangfireDashboard("/jobs");  // lock this down in production

// Fire-and-forget, durable:
BackgroundJob.Enqueue<IInvoiceService>(s => s.SendAsync(orderId, CancellationToken.None));

// Recurring (cron):
RecurringJob.AddOrUpdate<IReportService>(
    "nightly-report",
    s => s.BuildAsync(CancellationToken.None),
    Cron.Daily(2));
```

Fíjate en lo que acaba de cambiar: ahora eres dueño de un conjunto de tablas de base de datos que Hangfire gestiona, una cadena de conexión, migraciones de ese esquema entre actualizaciones de Hangfire y un endpoint de panel que debes autorizar. Eso es peso operativo real. Lo asumes deliberadamente, a cambio de una durabilidad y una programación que de otro modo improvisarías mal.

## El panorama de throughput, con números reales

El rendimiento rara vez es el eje decisivo aquí, pero vale la pena ser honestos sobre el costo de la durabilidad. Un `BackgroundService` en proceso drenando un `Channel` no hace E/S por elemento más allá de tu propio trabajo; la sobrecarga de despacho es en la práctica una llamada a método y no es medible frente al trabajo en sí. Hangfire, en cambio, hace al menos un viaje de ida y vuelta al almacenamiento para desencolar y otro para marcar la finalización por cada tarea.

La propia documentación de Hangfire cuantifica la elección de almacenamiento: cambiar de SQL Server a Redis rinde **más de 4 veces el throughput** en tareas vacías, según la [guía de Redis](https://docs.hangfire.io/en/latest/configuration/using-redis.html). Los números absolutos dependen de la latencia de tu almacenamiento, pero la forma es fija: el suelo de Hangfire es "viajes de ida y vuelta a una base de datos", y el suelo de una cola en proceso es "nada". Si procesas decenas de miles de elementos triviales por segundo, esa brecha importa y una cola en proceso con `Channel` gana de calle. Si procesas miles de tareas por minuto que cada una hace trabajo real (llamar a una API, renderizar un PDF), el costo de almacenamiento por tarea desaparece en el ruido y la durabilidad es gratis en la práctica.

La regla que se desprende: no pongas trabajo de alta frecuencia y tolerante a pérdidas a través de Hangfire solo porque está ahí. Un sondeador que revisa una cola cada segundo es un `BackgroundService`, no 86.400 tareas de Hangfire al día.

## El detalle que decide por ti

Dos requisitos terminan el debate antes de que entre la preferencia:

1. **"Esto no debe perderse si la aplicación se reinicia."** Si una tarea se descarta en un despliegue y eso es un bug real (la captura de un pago, un correo de confirmación, la entrega de un webhook), necesitas almacenamiento durable, y eso significa Hangfire (o un broker de mensajes de verdad). Ninguna cantidad de drenaje en `StopAsync` hace que un `BackgroundService` sobreviva a un `kill -9` o a un fallo de nodo. Las opciones en proceso mantienen el trabajo en memoria; la memoria muere con el proceso.

2. **"Esto debe ejecutarse exactamente una vez en mis réplicas."** Un `BackgroundService` corre en cada instancia. Si escalas horizontalmente y la tarea no es idempotente, obtienes trabajo duplicado. El modelo de worker con almacenamiento compartido de Hangfire te da una única ejecución gratis. El equivalente en proceso es un lock distribuido que tienes que construir y hacer bien.

Si no aplica ninguno de los dos requisitos (el trabajo es en proceso, tolerante a pérdidas y o bien corre una vez porque ejecutas una sola instancia o es naturalmente idempotente), entonces añadir Hangfire es pagar un impuesto de base de datos a cambio de nada. Usa `BackgroundService`.

Un híbrido común y correcto: mantén el *programa y los reintentos* durables en Hangfire, pero deja que el cuerpo de la tarea recurrente simplemente encole en un `Channel` en proceso que un `BackgroundService` drena. Hangfire garantiza que la tarea se dispare una vez y sobreviva a los reinicios; el `Channel` te da un throughput en proceso rápido y consciente de la contrapresión. Obtienes ambas propiedades sin forzar cada elemento a pasar por el almacenamiento.

## La recomendación, repetida

Por defecto, usa `BackgroundService` para cualquier cosa que haga bucles en proceso. Recurre a `IHostedService` puro o `IHostedLifecycleService` solo cuando necesites específicamente orden de arranque o ganchos de pre/post apagado. Adopta Hangfire en cuanto una tarea deba sobrevivir a un reinicio, ejecutarse según un programa, reintentar automáticamente o ejecutarse exactamente una vez en varias instancias, y acepta la base de datos que trae como el precio de esas garantías. El instinto de recurrir a Hangfire "por si acaso" suele estar al revés: empieza en proceso y deja que un requisito concreto de durabilidad o programación te arrastre hacia la herramienta más pesada. Cuando corras sobre las primitivas integradas, [monitorea esas tareas en segundo plano con health checks y métricas](/es/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) para no volar a ciegas, y asegúrate de que tus bucles [se cancelen limpiamente sin interbloqueo](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) en el apagado.

## Fuentes

- [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) -- Microsoft Learn
- [Implement background tasks with IHostedService and BackgroundService](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/multi-container-microservice-net-applications/background-tasks-with-ihostedservice) -- Microsoft Learn
- [Introducing the new IHostedLifecycleService interface in .NET 8](https://www.stevejgordon.co.uk/introducing-the-new-ihostedlifecycleservice-interface-in-dotnet-8) -- Steve Gordon
- [Hangfire overview and supported storage](https://www.hangfire.io/) -- Hangfire
- [Using Redis storage (throughput note)](https://docs.hangfire.io/en/latest/configuration/using-redis.html) -- Hangfire Documentation
- [Using SQL Server storage](https://docs.hangfire.io/en/latest/configuration/using-sql-server.html) -- Hangfire Documentation
