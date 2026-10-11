---
title: "Quartz.NET 4.4: los jobs informan lo que lograron y un health check avisa cuando dejan de ejecutarse"
description: "Quartz.NET 4.4.0 permite que un job asigne a context.Result un JobRunReport (Succeeded, Failed, Cancelled o Skipped, con un resumen y métricas), lo conserva por job en el historial de ejecución y añade health checks RequireSuccessWithin que pasan a Degraded cuando un job nocturno deja de completarse con éxito."
pubDate: 2026-10-11
tags:
  - "quartz-net"
  - "dotnet"
  - "csharp"
  - "health-checks"
  - "background-jobs"
lang: "es"
translationOf: "2026/10/quartz-net-4-4-job-outcomes-and-per-job-health-checks"
translatedBy: "claude"
translationDate: 2026-10-11
---

Quartz.NET [v4.4.0](https://github.com/quartznet/quartznet/releases/tag/v4.4.0) se publicó el 7 de octubre de 2026. Las cifras principales son sobre clustering (los triggers que ya están vencidos se disparan dentro de la transacción que los adquiere, y en PostgreSQL entre el 95 y el 99 % de los disparos a 20 triggers por segundo ocurren dentro de 50 ms, frente al 54 % en 4.3.0), pero el cambio que usará la mayoría del código de aplicación es más pequeño: por fin un job puede decir qué logró su ejecución, y tu endpoint de salud puede actuar en consecuencia.

## "No lanzó una excepción" no es lo mismo que "funcionó"

Hasta 4.3, Quartz conocía dos resultados: el job lanzaba una excepción, o no. Un job de limpieza que no encontró nada que limpiar, una sincronización que terminó antes porque la API de origen devolvió una página vacía y una ejecución que hizo trabajo real se veían idénticas en el historial. Y un job nocturno cuyo trigger quedó en pausa o sufrió un misfire durante tres días no se veía como nada, porque nada falló.

## Informar un resultado con JobRunReport

En 4.4 un job asigna a `context.Result` un `JobRunReport`. Hay cuatro resultados (`Succeeded`, `Failed`, `Cancelled`, `Skipped`), un resumen opcional de hasta 1 000 caracteres y métricas almacenadas como JSON compatible con AOT, limitadas a 4 000 caracteres:

```csharp
public sealed class ReleaseStaleReservationsJob : IJob
{
    public async ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
    {
        int scanned = await CountReservations(cancellationToken);
        int released = await ReleaseStale(cancellationToken);

        context.Result = released == 0
            ? JobRunReport.Skipped("no stale reservations").With("scanned", scanned)
            : JobRunReport.Succeeded($"released {released}")
                .With("scanned", scanned)
                .With("released", released);
    }
}
```

El resultado registrado sigue un orden fijo: un disparo cancelado es `Cancelled`, un job que lanzó una excepción es `Failed`, y en otro caso lo que hayas puesto en `context.Result`, y si no hay nada, `Succeeded`. Informar `JobRunReport.Failed(...)` no es lo mismo que lanzar una excepción. Solo una excepción lanzada activa la política de reintentos y las continuaciones `OnFailure`, así que informa un fallo cuando reintentar no ayudaría.

El historial conserva un `JobRunStatus` por job (`LastSucceededAtUtc`, `ConsecutiveFailures`, `LastFailureMessage`, y contadores de ejecuciones y fallos), la retención puede diferir según el resultado, y la métrica `quartz.job.execution.duration` incorpora una etiqueta `quartz.job.result` para que tus paneles de OpenTelemetry puedan separar las ejecuciones omitidas de las reales.

## Un health check por job

Esta es la parte que activaría hoy mismo. `RequireSuccessWithin` reporta un job como unhealthy cuando no ha tenido éxito dentro de una ventana de tiempo, lo que detecta el caso silencioso: un trigger en pausa, un misfire, un job que un veto sigue omitiendo.

```csharp
builder.Services.AddQuartzExecutionHistory();

builder.Services.AddHealthChecks().AddQuartz(options =>
{
    // Degraded once the nightly report has not succeeded for 26 hours.
    options.RequireSuccessWithin(new JobKey("nightly-report", "reports"), TimeSpan.FromHours(26));

    // Unhealthy, so the node leaves rotation, after 90 minutes without a ledger close.
    options.RequireSuccessWithin(
        new JobKey("ledger-close", "billing"),
        TimeSpan.FromMinutes(90),
        HealthStatus.Unhealthy);
});
```

El estado predeterminado es `Degraded`, y una ejecución `Skipped` cuenta como éxito, de modo que el camino de "nada que hacer" del job anterior no alerta a nadie. La lista también puede enlazarse desde la configuración mediante `RequiredJobs`. Si el historial de ejecución está desactivado, el host falla al iniciar en lugar de reportar un check que nunca puede pasar.

## Actualizar desde 4.3

La versión es aditiva: el código de 4.3 compila sin cambios, y cada nuevo miembro de interfaz tiene una implementación predeterminada. Si usas un almacén de jobs persistente con el historial de ejecución activado, ejecuta el script `4.4/add_execution_outcome_<dialect>.sql` antes de que arranque el primer nodo 4.4. La versión también añade un atributo `[RetryPolicy]` en las clases de job, `q.RunAtStartup(jobKey)` y gestión de esquemas con Weasel para MySQL, Oracle y Firebird, todo cubierto en la [guía de migración](https://www.quartz-scheduler.net/documentation/quartz-4.x/migration-guide.html#upgrading-from-4-3-to-4-4) y en la [guía práctica de resultados de jobs](https://www.quartz-scheduler.net/documentation/quartz-4.x/how-tos/job-outcomes.html).

Si todavía estás en 4.2, el [analizador de cron y el generador de código fuente `[QuartzJob]` de 4.2](/es/2026/09/quartz-net-4-2-turns-bad-cron-expressions-into-build-errors/) vienen incluidos sin costo adicional.
