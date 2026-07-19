---
title: "Cómo agregar un endpoint de health check a una minimal API en ASP.NET Core 11"
description: "Una guía completa y funcional de health checks en una minimal API de ASP.NET Core 11: AddHealthChecks y MapHealthChecks, clases IHealthCheck personalizadas que devuelven Healthy/Degraded/Unhealthy, la sonda de EF Core AddDbContextCheck, endpoints de liveness y readiness basados en tags para Kubernetes, un ResponseWriter JSON, ResultStatusCodes, cómo proteger el endpoint con RequireAuthorization y RequireHost, y cómo enviar resultados con IHealthCheckPublisher."
pubDate: 2026-07-19
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "health-checks"
lang: "es"
translationOf: "2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-19
---

Para agregar un endpoint de health check a una minimal API en ASP.NET Core 11 llamas a `builder.Services.AddHealthChecks()` para registrar el servicio, opcionalmente encadenas llamadas a `.AddCheck(...)` para describir qué significa "healthy" para tu aplicación, y luego llamas a `app.MapHealthChecks("/healthz")` para exponer un endpoint. Accede a esa URL y obtienes `200 OK` con el cuerpo `Healthy` cuando todas las comprobaciones pasan, o `503 Service Unavailable` cuando alguna comprobación reporta `Unhealthy`. Esa configuración de dos líneas es el mínimo completo. Este artículo lo lleva desde ese mínimo hasta una configuración lista para producción: un `IHealthCheck` personalizado que realmente sondea una dependencia, la sonda de base de datos integrada de EF Core, endpoints separados de liveness y readiness conectados para Kubernetes, un cuerpo de respuesta JSON, códigos de estado HTTP correctos, y cómo asegurar el endpoint. Apunta a .NET 11 (Preview 6 al momento de escribir, GA en noviembre de 2026) con `Microsoft.NET.Sdk.Web` y C# 14, pero la API de health checks ha sido estable desde ASP.NET Core 2.2, así que cada ejemplo aquí funciona sin cambios en .NET 8, 9 y 10.

## Para qué sirve realmente un endpoint de health check

Un endpoint de health check es una URL que un orquestador, un balanceador de carga o un monitor de disponibilidad puede consultar para preguntar "¿debería enviarle tráfico a esta instancia?" La respuesta es deliberadamente gruesa: un estado agregado calculado a partir de un conjunto de comprobaciones registradas, expuesto como un código de estado HTTP para que cualquier cosa que hable HTTP pueda consumirlo sin analizar un cuerpo. Kubernetes lo usa para decidir si reiniciar un pod o enrutar solicitudes hacia él. Un Azure App Service o un target group de AWS lo usa para sacar de rotación una instancia no saludable. Una herramienta como Uptime Kuma lo usa para avisarte.

El punto clave de diseño es que un health check no es un endpoint de métricas ni un panel de diagnóstico. Responde una pregunta rápido, idealmente en unos pocos milisegundos, y sus comprobaciones deberían probar solo las cosas que genuinamente determinan si este proceso puede atender solicitudes: ¿es alcanzable la base de datos, responde una API descendente crítica, terminó la aplicación su trabajo de arranque. Acumular sondas lentas o no esenciales en él convierte una señal de liveness en un lastre, porque un health check lento bajo carga provoca los reinicios en cascada que se suponía debía prevenir.

## Pasos para agregar un endpoint de health check

1. Registra el servicio con `builder.Services.AddHealthChecks()`, que devuelve un `IHealthChecksBuilder`.
2. Encadena llamadas `.AddCheck(...)` o `.AddCheck<T>(...)` a ese builder por cada dependencia que quieras sondear.
3. Compila la aplicación y llama a `app.MapHealthChecks("/healthz")` para mapear el endpoint.
4. Opcionalmente pasa un `HealthCheckOptions` para filtrar comprobaciones por tag, dar forma a la respuesta o reasignar códigos de estado.
5. Opcionalmente encadena `.RequireAuthorization()` o `.RequireHost(...)` para controlar quién puede alcanzarlo.

El resto de este artículo expande cada uno de esos pasos en código funcional.

## El punto de partida de dos líneas

Aquí está lo más pequeño que funciona. `AddHealthChecks` sin comprobaciones registradas sigue siendo útil: te da un endpoint de liveness que devuelve `Healthy` mientras el proceso esté en marcha y la canalización de solicitudes esté girando.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHealthChecks();

var app = builder.Build();

app.MapHealthChecks("/healthz");

app.Run();
```

Un `GET /healthz` ahora devuelve `200 OK` con el cuerpo de texto plano `Healthy`. No hay comprobaciones registradas, así que no hay nada que pueda fallar. Esto por sí solo responde "¿está vivo el proceso y atendiendo HTTP?", que es precisamente lo que quiere una sonda de liveness de Kubernetes. Todo a partir de este punto trata sobre registrar comprobaciones que puedan reportar algo distinto a saludable, y sobre dar forma a cómo comunica el endpoint.

## Escribir una comprobación personalizada con IHealthCheck

Una comprobación real sondea una dependencia y reporta uno de tres estados. Implementa `IHealthCheck`, cuyo único método devuelve un `HealthCheckResult`:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Diagnostics.HealthChecks;

public sealed class QueueDepthHealthCheck : IHealthCheck
{
    private readonly IMessageQueue _queue;

    public QueueDepthHealthCheck(IMessageQueue queue) => _queue = queue;

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var depth = await _queue.GetApproximateDepthAsync(cancellationToken);

            if (depth > 10_000)
            {
                return HealthCheckResult.Unhealthy(
                    $"Queue backlog is {depth} messages.");
            }

            if (depth > 1_000)
            {
                // Still serving, but the backlog is a warning sign.
                return HealthCheckResult.Degraded(
                    $"Queue backlog is {depth} messages.",
                    data: new Dictionary<string, object> { ["depth"] = depth });
            }

            return HealthCheckResult.Healthy($"Queue depth {depth}.");
        }
        catch (Exception ex)
        {
            // Could not even reach the queue: that is unhealthy, not an unhandled 500.
            return HealthCheckResult.Unhealthy("Queue is unreachable.", ex);
        }
    }
}
```

Los tres métodos de fábrica se corresponden con los tres miembros del enum `HealthStatus`. `Healthy` significa plenamente operativo. `Unhealthy` significa que esta instancia no puede hacer su trabajo y debería sacarse de rotación o reiniciarse. `Degraded` es el intermedio interesante: la aplicación sigue atendiendo solicitudes, pero algo va mal (una dependencia lenta, un backlog creciente), y de forma predeterminada un resultado degradado aún devuelve `200 OK`. Eso es deliberado: normalmente no quieres que un orquestador reinicie un pod solo porque una cola se está llenando. El diccionario opcional `data` viaja junto en el reporte y aparece en un cuerpo de respuesta JSON, lo que es útil para un panel sin cambiar la decisión de aprobado/fallo.

Registra la clase y dale un nombre y, opcionalmente, un estado de fallo y tags:

```csharp
// .NET 11, C# 14
builder.Services.AddHealthChecks()
    .AddCheck<QueueDepthHealthCheck>(
        "queue",
        failureStatus: HealthStatus.Unhealthy,
        tags: ["ready"]);
```

La dependencia del constructor (`IMessageQueue`) se resuelve desde la inyección de dependencias, así que tu comprobación puede inyectar cualquier servicio registrado. Si necesitas pasar argumentos literales al constructor que no están en el contenedor, usa `AddTypeActivatedCheck<T>(...)` y proporciona un arreglo `args` en su lugar.

Para una comprobación en línea desechable que no merece una clase, la forma lambda es suficiente:

```csharp
// .NET 11, C# 14
builder.Services.AddHealthChecks()
    .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"]);
```

## Sondear la base de datos con AddDbContextCheck

Lo más común que los equipos quieren en una sonda de readiness es "¿puedo alcanzar la base de datos?". No necesitas escribir un `IHealthCheck` para eso. Agrega el paquete `Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore` y usa el `AddDbContextCheck<TContext>` integrado:

```csharp
// .NET 11, C# 14
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(
        builder.Configuration.GetConnectionString("DefaultConnection")));

builder.Services.AddHealthChecks()
    .AddDbContextCheck<AppDbContext>("database", tags: ["ready"]);
```

Internamente esto llama a `DbContext.Database.CanConnectAsync`, que abre una conexión y la cierra sin ejecutar una consulta. Ese es el valor predeterminado correcto: es barato y verifica exactamente lo que le importa a una sonda de readiness, que la cadena de conexión se resuelva y el servidor acepte conexiones. Si necesitas algo más fuerte, `AddDbContextCheck` tiene una sobrecarga que toma una consulta de prueba personalizada, pero para el caso común `CanConnectAsync` es lo que quieres. Para un cableado más profundo sobre preparar EF Core antes del primer uso, consulta [cómo preparar el modelo de EF Core antes de la primera consulta](/es/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/); una comprobación que ejecuta `CanConnectAsync` es un lugar natural para que ese calentamiento ya haya ocurrido.

Los paquetes de la comunidad bajo `AspNetCore.Diagnostics.HealthChecks` (el proyecto Xabaril) proporcionan comprobaciones listas para Redis, RabbitMQ, PostgreSQL, blob storage y decenas de otras dependencias con el mismo patrón `.Add...`, así que rara vez necesitas escribir a mano una sonda para un servicio conocido.

## Endpoints separados de liveness y readiness

Kubernetes distingue dos sondas, y confundirlas es el error más común de health checks. Una sonda de liveness responde "¿está atascado este proceso y necesita un reinicio?"; si falla, Kubernetes mata el pod. Una sonda de readiness responde "¿está esta instancia lista para recibir tráfico ahora mismo?"; si falla, Kubernetes deja de enrutar hacia ella pero la deja en marcha. No quieres que tu base de datos siendo momentáneamente inalcanzable dispare un reinicio del pod, porque un reinicio no puede arreglar la base de datos y solo elimina capacidad. Así que la comprobación de base de datos pertenece a readiness, no a liveness.

El mecanismo son los tags más el `Predicate` en `HealthCheckOptions`. Registra las comprobaciones con tags, luego mapea dos endpoints que cada uno filtre al conjunto correcto:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Diagnostics.HealthChecks;

app.MapHealthChecks("/health/live", new HealthCheckOptions
{
    // Liveness: run no dependency checks. If the pipeline responds, we are alive.
    Predicate = _ => false
});

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    // Readiness: only the checks tagged "ready" (database, queue, downstreams).
    Predicate = check => check.Tags.Contains("ready")
});
```

`Predicate = _ => false` significa "no incluir ninguna comprobación", así que `/health/live` cortocircuita a `Healthy` en el momento en que la solicitud llega al endpoint. `/health/ready` ejecuta solo las comprobaciones que etiquetaste como `ready`. Apunta tu `livenessProbe` de Kubernetes a `/health/live` y tu `readinessProbe` a `/health/ready`, y las dos preocupaciones se mantienen limpiamente separadas.

## Devolver JSON en lugar de texto plano

El cuerpo de respuesta predeterminado es la única palabra `Healthy`, `Degraded` o `Unhealthy`. Eso es suficiente para una sonda pero inútil para una persona depurando por qué falla readiness. Proporciona un `ResponseWriter` para emitir JSON con detalle por comprobación:

```csharp
// .NET 11, C# 14
using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Diagnostics.HealthChecks;

static Task WriteJsonResponse(HttpContext context, HealthReport report)
{
    context.Response.ContentType = "application/json; charset=utf-8";

    var payload = new
    {
        status = report.Status.ToString(),
        totalDurationMs = report.TotalDuration.TotalMilliseconds,
        checks = report.Entries.Select(e => new
        {
            name = e.Key,
            status = e.Value.Status.ToString(),
            description = e.Value.Description,
            durationMs = e.Value.Duration.TotalMilliseconds
        })
    };

    return context.Response.WriteAsync(JsonSerializer.Serialize(payload));
}

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResponseWriter = WriteJsonResponse
});
```

Ahora una comprobación de readiness fallida devuelve un cuerpo que nombra la comprobación, su estado, su descripción y cuánto tardó, así puedes ver de un vistazo que "database" es la entrada que quedó `Unhealthy`. El objeto `HealthReport` expone `Status` (el agregado), `TotalDuration` y un diccionario `Entries` indexado por los nombres de comprobación que registraste. Ten en cuenta que el código de estado se controla por separado del cuerpo: un `503` puede transportar este JSON sin problema.

## Controlar el código de estado

De forma predeterminada, el framework mapea `Healthy` y `Degraded` a `200 OK` y `Unhealthy` a `503 Service Unavailable`. Ese mapeo es lo que esperan los balanceadores de carga, así que cámbialo solo cuando tengas una razón específica. Cuando lo hagas, `ResultStatusCodes` es el control:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResultStatusCodes =
    {
        [HealthStatus.Healthy] = StatusCodes.Status200OK,
        [HealthStatus.Degraded] = StatusCodes.Status200OK,
        [HealthStatus.Unhealthy] = StatusCodes.Status503ServiceUnavailable
    }
});
```

Una sutileza que vale la pena interiorizar: como `Degraded` devuelve `200` de forma predeterminada, un balanceador de carga trata una instancia degradada como saludable y le sigue enviando tráfico. Eso suele ser correcto, pero si tu definición de "degradado" es lo bastante severa como para querer sacarla de rotación, o bien mapea `Degraded` a `503` aquí o devuelve `Unhealthy` desde la comprobación en lugar de `Degraded`. No dejes la intención ambigua.

Otro valor predeterminado que conviene conocer: las respuestas de health check establecen encabezados no-cache para que un intermediario no pueda servir un `Healthy` obsoleto mientras la instancia en realidad está fallando. Si alguna vez necesitas caché, `AllowCachingResponses = true` en las opciones lo desactiva, pero casi nunca lo quieres en una sonda.

## Asegurar el endpoint

Un endpoint de salud que devuelve JSON detallado es una pequeña superficie de divulgación de información: nombra tus dependencias y puede filtrar detalles de fallo. Hay dos formas limpias de restringirlo. `RequireHost` limita el endpoint a un host o puerto específico, que es el truco estándar para exponer la salud solo en un puerto de gestión interno que no se enruta públicamente:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready")
})
.RequireHost("*:8081");
```

`RequireAuthorization` pone el endpoint detrás de tus políticas de autorización, que se combinan con cualquier autenticación que hayas configurado. Si ya ejecutas autenticación JWT bearer, agregarla al endpoint de salud es una sola llamada:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready")
    .RequireAuthorization();
```

Una advertencia: no requieras autorización en el endpoint que sondea tu orquestador, porque el orquestador no presentará un token y la sonda fallará. Mantén abiertos los endpoints simples de liveness/readiness (restríngelos por host o red en su lugar) y pon el endpoint detallado que emite JSON detrás de autorización si es que lo expones. La mecánica de configurar el lado del token se cubre en [cómo configurar la autenticación JWT bearer en una minimal API en ASP.NET Core 11](/es/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

## Enviar resultados en lugar de esperar a ser consultado

Todo lo anterior es basado en pull: algo llama a tu endpoint. El framework también admite el reporte basado en push a través de `IHealthCheckPublisher`, que ejecuta las comprobaciones registradas en un temporizador y entrega el `HealthReport` agregado a tu código para que puedas reenviarlo a un sistema de monitoreo, emitir una métrica o registrar una alerta:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Diagnostics.HealthChecks;

public sealed class LoggingHealthCheckPublisher : IHealthCheckPublisher
{
    private readonly ILogger<LoggingHealthCheckPublisher> _logger;

    public LoggingHealthCheckPublisher(ILogger<LoggingHealthCheckPublisher> logger)
        => _logger = logger;

    public Task PublishAsync(HealthReport report, CancellationToken cancellationToken)
    {
        if (report.Status != HealthStatus.Healthy)
        {
            _logger.LogWarning(
                "Health degraded: {Status} across {Count} checks.",
                report.Status, report.Entries.Count);
        }
        return Task.CompletedTask;
    }
}

builder.Services.AddSingleton<IHealthCheckPublisher, LoggingHealthCheckPublisher>();
builder.Services.Configure<HealthCheckPublisherOptions>(options =>
{
    options.Delay = TimeSpan.FromSeconds(5);   // Wait before the first run.
    options.Period = TimeSpan.FromSeconds(30); // Then run every 30 seconds.
    options.Predicate = check => check.Tags.Contains("ready");
});
```

El publisher se ejecuta en un servicio de fondo alojado que el framework registra tan pronto como cualquier `IHealthCheckPublisher` está en el contenedor, así que obtienes ejecución periódica sin cablear tu propio temporizador. Este es el lugar idiomático para alimentar la salud hacia una canalización de métricas; si ya exportas telemetría, combínalo con [OpenTelemetry en .NET 11](/es/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) para que el estado degradado aparezca junto a tus trazas. También se lleva bien con cualquier [monitoreo de trabajos en segundo plano](/es/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) que ya ejecutes, ya que un publisher es simplemente otro consumidor del mismo reporte.

## MapHealthChecks frente a UseHealthChecks, y dónde se ejecutan las comprobaciones

Los tutoriales más antiguos usan `app.UseHealthChecks("/healthz")`, que es middleware que cortocircuita la canalización cuando la ruta coincide. `MapHealthChecks` es el equivalente consciente del enrutamiento y el que hay que preferir en cualquier minimal API moderna, porque participa en el enrutamiento de endpoints, que es lo que hace que `RequireAuthorization`, `RequireHost` y `RequireCors` funcionen. Esas convenciones de endpoint no tienen significado en la forma de middleware. En .NET 8 y posteriores también puedes encadenar `.ShortCircuit()` a un endpoint de salud mapeado para omitir el resto de la canalización de middleware para esa solicitud, ahorrando un poco de sobrecarga en una sonda de alta frecuencia.

Un recordatorio operativo: las comprobaciones se ejecutan dentro de la solicitud que llegó al endpoint, usando servicios scoped resueltos para esa solicitud. Si una comprobación necesita una dependencia scoped como un `DbContext`, esa resolución simplemente funciona porque el endpoint se ejecuta en un scope de solicitud. Esta es la misma preocupación de scoping que muerde a quienes buscan servicios scoped desde singletons de larga vida, exactamente la trampa que [usar servicios scoped dentro de un BackgroundService](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) existe para resolver; un health check nunca la toca, porque ya tiene un scope de solicitud.

## La forma a recordar

Un endpoint de health check es `AddHealthChecks()` para registrar el servicio, `.AddCheck<T>(...)` (o `.AddDbContextCheck<T>()`, o una lambda) por cada dependencia que valga la pena sondear, y `MapHealthChecks("/path")` para exponerlo. Devuelve `Healthy`, `Degraded` o `Unhealthy` desde cada comprobación, y recuerda que `Unhealthy` es un `503` mientras que ambos otros son `200` de forma predeterminada. Separa liveness de readiness con tags y un `Predicate` para que una base de datos inestable nunca reinicie un pod saludable, agrega un `ResponseWriter` cuando una persona necesite leer el resultado, protege el endpoint con `RequireHost` en lugar de autorización en la ruta de la sonda, y recurre a `IHealthCheckPublisher` cuando quieras push en lugar de pull. Esa es la superficie completa, y cada línea de arriba funciona en .NET 8 hasta .NET 11 sin cambios.

## Relacionados

- [Cómo usar servicios scoped dentro de un BackgroundService en ASP.NET Core 11](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)
- [Cómo organizar los endpoints de una minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Cómo configurar la autenticación JWT bearer en una minimal API en ASP.NET Core 11](/es/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)
- [Cómo usar OpenTelemetry con .NET 11 y un backend gratuito](/es/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [Cómo preparar el modelo de EF Core antes de la primera consulta](/es/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)

## Fuentes

- [Health checks in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/health-checks)
- [IHealthCheck interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.diagnostics.healthchecks.ihealthcheck)
- [HealthCheckOptions (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.diagnostics.healthchecks.healthcheckoptions)
- [AddDbContextCheck extension (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkcorehealthchecksbuilderextensions.adddbcontextcheck)
- [AspNetCore.Diagnostics.HealthChecks (Xabaril, GitHub)](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks)
