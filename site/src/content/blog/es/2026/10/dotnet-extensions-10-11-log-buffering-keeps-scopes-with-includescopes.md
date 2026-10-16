---
title: ".NET Extensions 10.11: los logs en búfer por fin pueden conservar sus scopes"
description: "Microsoft.Extensions.Telemetry 10.11.0, publicado el 2026-10-15, agrega una opción experimental IncludeScopes al log buffering global y por solicitud, para que OrderId y TenantId de BeginScope sobrevivan a un Flush() en lugar de perderse en silencio."
pubDate: 2026-10-16
tags:
  - "dotnet"
  - "logging"
  - "observability"
  - "aspnetcore"
  - "csharp"
lang: "es"
translationOf: "2026/10/dotnet-extensions-10-11-log-buffering-keeps-scopes-with-includescopes"
translatedBy: "claude"
translationDate: 2026-10-16
---

[.NET Extensions 10.11.0](https://github.com/dotnet/extensions/releases/tag/v10.11.0) llegó a NuGet el 2026-10-15. La mayoría de los arreglos de IA son pequeños, pero un cambio de telemetría cierra un hueco que existía desde que apareció el log buffering: los registros en búfer perdían todos los valores de `ILogger.BeginScope`. Guardabas en búfer los logs de `Information`, saltaba una excepción, llamabas a `Flush()` y los registros salían sin el `OrderId`, el `TenantId` o el ID de solicitud que habías puesto en el scope. Justo el contexto que necesitabas para depurar el fallo.

## Cómo se veía un flush antes

El log buffering vive en `Microsoft.Extensions.Telemetry` (búfer global) y en `Microsoft.AspNetCore.Diagnostics.Middleware` (búfer por solicitud). Los registros que coinciden con una regla se guardan en un búfer circular y solo se escriben cuando llamas a `Flush()`. Este es un repro mínimo con el logger JSON de consola, que normalmente imprime los scopes cuando `IncludeScopes` está activado:

```csharp
var builder = Host.CreateApplicationBuilder();
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(o => o.IncludeScopes = true);
builder.Logging.AddGlobalBuffer(o =>
{
    o.Rules.Add(new LogBufferingFilterRule(logLevel: LogLevel.Information));
    o.IncludeScopes = true; // new in 10.11.0, EXTEXP0003
});
using var host = builder.Build();
var logger = host.Services.GetRequiredService<ILogger<Program>>();
var buffer = host.Services.GetRequiredService<GlobalLogBuffer>();

using (logger.BeginScope(new Dictionary<string, object?> { ["OrderId"] = 4711, ["TenantId"] = "contoso" }))
{
    logger.LogInformation("Reserving stock for {Sku}", "SKU-42");
    buffer.Flush();
}
```

Lo ejecuté como app basada en archivo con el SDK 10.0.302. Con `Microsoft.Extensions.Telemetry` 10.10.0 (sin la línea de `IncludeScopes`, que ahí no compila), el registro vaciado no tiene ni rastro del scope, aunque el flush ocurre dentro de él:

```text
{"EventId":0,"LogLevel":"Information","Category":"Program","Message":"Reserving stock for SKU-42","Exception":"","State":{"Message":null,"Sku":"SKU-42","{OriginalFormat}":"Reserving stock for {Sku}"}}
```

En 10.11.0 con `IncludeScopes = true`:

```text
{"EventId":0,"LogLevel":"Information","Category":"Program","Message":"Reserving stock for SKU-42","Exception":"","State":{"Message":null,"Sku":"SKU-42","OrderId":"4711","TenantId":"contoso","{OriginalFormat}":"Reserving stock for {Sku}"}}
```

## Cómo funciona

El [PR #7813](https://github.com/dotnet/extensions/pull/7813) captura los scopes en el momento en que el registro entra al búfer, no al hacer el flush, que es justo lo que quieres: cuando algo llama a `Flush()`, el scope original normalmente ya desapareció. Los búferes obtienen un `IExternalScopeProvider` desde DI (compartido con `ExtendedLoggerFactory`) y copian los pares nombre/valor de cada scope en el registro.

Algunos detalles que conviene conocer:

- Los scopes aparecen como **atributos**, no como scopes. Los proveedores `IBufferedLogger` los ven en `BufferedLogRecord.Attributes`; los demás proveedores los reciben mezclados en el estado que se pasa a `ILogger.Log`. Por eso arriba aparecen en `State` y no en un arreglo `Scopes`.
- Solo se capturan los scopes que implementan `IEnumerable<KeyValuePair<string, object?>>`. Un scope de tipo string como `BeginScope("Checkout")` se omite, y los pares `{OriginalFormat}` se descartan. Los scopes de `ActivityTrackingOptions` (trace ID, span ID) sí se incluyen.
- Está desactivado por defecto, es experimental bajo `EXTEXP0003` y se puede enlazar desde la configuración. Las opciones se vuelven a leer en cada registro en búfer, así que una recarga de configuración surte efecto de inmediato.

Para el búfer por solicitud de ASP.NET Core existe el mismo interruptor en `PerRequestLogBufferingOptions`:

```csharp
builder.Logging.AddPerIncomingRequestBuffer(o =>
{
    o.Rules.Add(new LogBufferingFilterRule(logLevel: LogLevel.Information));
    o.IncludeScopes = true;
});
```

## También en 10.11.0

La versión corrige una `ArgumentNullException` en el búfer por solicitud al final de una solicitud (#7811) y una condición de carrera en el buffering causada por una caché del selector de reglas (#7803). Si usas el enriquecedor experimental de latencia HTTP, `AddHttpLatencyTelemetry` ahora se llama `AddHttpServerLatencyTelemetry` (#7730). En el lado de IA, `FunctionInvocationContext.Terminate` ahora se respeta cuando la función lanza una excepción (#7801), y `ChatResponseUpdate.Clone` conserva `ContinuationToken` (#7699). La versión anterior de esta serie fue [Microsoft.Extensions.AI 10.10.1](/es/2026/09/microsoft-extensions-ai-10-10-1-fixes-openai-2-14-typeloadexception/).

Para actualizar:

```bash
dotnet add package Microsoft.Extensions.Telemetry --version 10.11.0
```

Si guardas logs en búfer y los correlacionas por valores de scope, activa `IncludeScopes`. Sin él, los logs que vacías cuando algo falla no traen los IDs que necesitas para correlacionarlos.
