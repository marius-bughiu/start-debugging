---
title: "Migrar de Serilog a logging con OpenTelemetry en .NET 11"
description: "Una guía paso a paso para sacar a una app .NET 11 de Serilog y llevarla a logging con OpenTelemetry: el puente de bajo riesgo Serilog.Sinks.OpenTelemetry, el cambio completo a Microsoft.Extensions.Logging, qué se rompe, cómo verificar y cómo revertir."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "serilog"
  - "opentelemetry"
  - "dotnet-11"
  - "logging"
  - "observability"
lang: "es"
translationOf: "2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-05
---

Si tu equipo se estandarizó en OpenTelemetry para trazas y métricas, el que suele quedar fuera es el logging, que sigue pasando por Serilog y un sink de archivo o Seq. Esta guía mueve una app .NET 11 (OpenTelemetry .NET SDK 1.15.x, Serilog 4.x) fuera de esa configuración dividida y la lleva a logging con OpenTelemetry. Hay dos rutas: un puente de una sola tarde que mantiene Serilog y solo cambia el sink, y un cambio completo a `Microsoft.Extensions.Logging` que elimina Serilog por completo. El puente es reversible en un solo commit y casi no rompe nada. La migración completa toma un día o dos en una base de código real, toca cada `BeginScope` y cada plantilla de mensaje, y vale la pena solo si eliminar la dependencia de Serilog y unificar en una sola API de logging es un objetivo real y no algo deseable.

## Por qué mover el logging a OpenTelemetry

- **Una sola tubería para tres señales.** Las trazas, las métricas y los registros salen del proceso a través del mismo exportador OTLP y llegan al mismo backend, correlacionados por `TraceId` y `SpanId`. No hay un endpoint de Seq aparte que operar junto a tu backend de trazas.
- **Formato de transporte neutral respecto al proveedor.** OTLP es un protocolo estable. Puedes apuntar la misma app al Aspire Dashboard localmente, a Jaeger o SigNoz autoalojados, o a un backend comercial, cambiando un solo endpoint, no intercambiando un paquete de sink.
- **Correlación de trazas automática.** Los registros emitidos dentro de un `Activity` activo llevan los IDs de traza y span sin un enricher, así que "muéstrame cada línea de registro para esta solicitud" funciona entre servicios.
- **Menos piezas móviles en CI y producción.** Quitar el bootstrap de Serilog y la configuración del sink elimina una clase de incidentes de "los registros se detuvieron en silencio" causados por errores de buffering del sink y de flush al apagar.

Si todavía no cableaste las trazas de OpenTelemetry, haz eso primero: [usar OpenTelemetry con .NET 11 y un backend gratuito](/es/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) cubre la configuración del exportador y del backend que esta guía asume que ya está en su lugar.

## Qué se rompe

| Área | Cambio | Severidad |
| --- | --- | --- |
| Configuración del sink | Los sinks de archivo/consola/Seq se reemplazan por el exportador OTLP o `Serilog.Sinks.OpenTelemetry` | alta (completa) / baja (puente) |
| `Log.Logger` estático + `CreateBootstrapLogger()` | Eliminado en la migración completa; sin logging de arranque en dos etapas | alta (solo completa) |
| Enrichers de `LogContext.PushProperty` | Reemplazados por `ILogger.BeginScope` más `IncludeScopes = true` | media (solo completa) |
| Operador de destructuring `{@Order}` | Sin equivalente en `Microsoft.Extensions.Logging`; registra campos escalares o serializa explícitamente | media (solo completa) |
| `UseSerilogRequestLogging()` | Reemplazado por la instrumentación OTel de ASP.NET Core o `AddHttpLogging` | media (solo completa) |
| Bloque de configuración `MinimumLevel` | Se mueve a la sección `Logging:LogLevel` en `appsettings.json` | baja (solo completa) |
| Nombres de severidad | El `Verbose` de Serilog mapea a `Trace` de OTel; `Information` se queda igual | baja |

La columna "puente" importa: si tomas la ruta A, solo aplica la primera fila y la severidad es baja. Todo lo demás es asunto de la migración completa.

## Lista de verificación previa

- **.NET 11 SDK instalado.** Confirma con `dotnet --version` (espera `11.0.x`).
- **Trazas de OpenTelemetry ya exportando por OTLP.** Esta guía reutiliza ese exportador y recurso.
- **Un backend que ingiera registros OTLP.** El Aspire Dashboard, SigNoz y Seq aceptan OTLP/HTTP. Seq expone un endpoint de ingesta OTLP en `/ingest/otlp/v1/logs`, así que puedes mantener Seq como destino incluso después de quitar el sink de Seq de Serilog.
- **Una suite de pruebas en verde y un árbol de trabajo limpio** antes de empezar, para que `git diff` muestre solo los cambios de la migración.
- **Conoce tu endpoint y protocolo OTLP.** El gRPC por defecto es `http://localhost:4317`; el HTTP/protobuf por defecto es `http://localhost:4318`. El exportador HTTP agrega `/v1/logs` al endpoint base.

## Pasos de la migración

### 1. Fija las versiones de los paquetes

Decide la ruta y luego instala los paquetes correspondientes. Ambas rutas apuntan a la misma línea del SDK.

```xml
<!-- .NET 11, both routes -->
<!-- Route A (bridge): keep Serilog, swap the sink -->
<PackageReference Include="Serilog.AspNetCore" Version="9.0.0" />
<PackageReference Include="Serilog.Sinks.OpenTelemetry" Version="4.2.0" />

<!-- Route B (full): Microsoft.Extensions.Logging + OpenTelemetry -->
<PackageReference Include="OpenTelemetry.Extensions.Hosting" Version="1.15.3" />
<PackageReference Include="OpenTelemetry.Exporter.OpenTelemetryProtocol" Version="1.15.3" />
```

Verifica: `dotnet restore` tiene éxito y `dotnet build` está limpio antes de que cambies cualquier código.

### 2a. Ruta A -- cambia el sink de Serilog por OTLP

Este es el camino de bajo riesgo. Mantén cada enricher, plantilla de mensaje y llamada a `LogContext` que ya tengas. Reemplaza solo la configuración del sink.

```csharp
// .NET 11, C# 14, Serilog 4.x, Serilog.Sinks.OpenTelemetry 4.2.0
using Serilog;
using Serilog.Sinks.OpenTelemetry;

Log.Logger = new LoggerConfiguration()
    .Enrich.FromLogContext()
    .WriteTo.OpenTelemetry(options =>
    {
        options.Endpoint = "http://localhost:4318/v1/logs";
        options.Protocol = OtlpProtocol.HttpProtobuf;
        options.ResourceAttributes = new Dictionary<string, object>
        {
            ["service.name"] = "orders-api",
            ["service.version"] = "2.4.0"
        };
    })
    .CreateLogger();
```

El sink lee `Activity.Current` e inyecta `TraceId` y `SpanId` en cada registro de log automáticamente (`IncludedData.TraceIdField` y `SpanIdField` están activados por defecto), así que la correlación entre señales funciona sin un enricher extra. Tus plantillas `_logger.LogInformation("Placed order {OrderId}", id)` fluyen sin cambios.

Verifica: inicia la app, haz una solicitud y confirma que la línea de registro aparece en tu backend OTLP con el mismo `TraceId` que la traza de la solicitud.

### 2b. Ruta B -- cambia a Microsoft.Extensions.Logging

Quita `UseSerilog()` / `AddSerilog()` y el bootstrap de `Log.Logger` de `Program.cs`. En su lugar, cablea OpenTelemetry en el constructor de logging integrado.

```csharp
// .NET 11, C# 14, OpenTelemetry .NET SDK 1.15.3
using OpenTelemetry.Logs;
using OpenTelemetry.Resources;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.AddOpenTelemetry(options =>
{
    options.IncludeScopes = true;            // keep BeginScope properties
    options.IncludeFormattedMessage = true;  // populate the log body
    options.ParseStateValues = true;         // capture structured attributes
    options.SetResourceBuilder(
        ResourceBuilder.CreateDefault()
            .AddService("orders-api", serviceVersion: "2.4.0"));
    options.AddOtlpExporter(o =>
    {
        o.Endpoint = new Uri("http://localhost:4318");
    });
});

var app = builder.Build();
```

Si tu app ya llama a `builder.Services.AddOpenTelemetry()` para trazas y métricas, prefiere la forma unificada para que las tres señales compartan un solo recurso y exportador:

```csharp
// .NET 11, OpenTelemetry .NET SDK 1.15.3
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("orders-api", serviceVersion: "2.4.0"))
    .WithTracing(t => t.AddAspNetCoreInstrumentation())
    .WithMetrics(m => m.AddAspNetCoreInstrumentation())
    .UseOtlpExporter(); // one call: configures OTLP for traces, metrics, AND logs

// Logs still need the provider on the logging builder:
builder.Logging.AddOpenTelemetry(o =>
{
    o.IncludeScopes = true;
    o.IncludeFormattedMessage = true;
    o.ParseStateValues = true;
});
```

`UseOtlpExporter()` (agregado en el SDK 1.8) registra el exportador OTLP para cada señal a la vez, así que no repites el endpoint tres veces.

Verifica: `dotnet run`, luego confirma que una línea de `ILogger` llega al backend con el `service.name` correcto y un cuerpo poblado.

### 3. Traduce los enrichers a scopes (solo Ruta B)

El `LogContext.PushProperty("UserId", id)` de Serilog no tiene equivalente en `Microsoft.Extensions.Logging`. Usa `ILogger.BeginScope` y las propiedades fluyen al registro OTLP porque pusiste `IncludeScopes = true`.

```csharp
// Before (Serilog)
using (LogContext.PushProperty("UserId", userId))
{
    _logger.LogInformation("Loaded cart");
}

// After (.NET 11, Microsoft.Extensions.Logging)
using (_logger.BeginScope(new Dictionary<string, object> { ["UserId"] = userId }))
{
    _logger.LogInformation("Loaded cart");
}
```

Verifica: el registro de log emitido lleva `UserId` como atributo. Si falta, olvidaste `IncludeScopes = true`.

### 4. Reemplaza el logging de solicitudes (solo Ruta B)

`app.UseSerilogRequestLogging()` producía una línea de registro resumida por solicitud. Con OpenTelemetry, la instrumentación de ASP.NET Core ya emite un span de servidor HTTP por solicitud, que es la primitiva mejor para "qué pasó en esta solicitud". Si aún quieres una línea de registro, agrega logging de HTTP:

```csharp
// .NET 11
builder.Services.AddHttpLogging(o => { });
// ...
app.UseHttpLogging();
```

Verifica: cada solicitud produce un span de servidor HTTP (y una entrada de log HTTP opcional) correlacionados por `TraceId`.

### 5. Mueve la configuración de nivel a appsettings

El bloque `MinimumLevel` de Serilog se reemplaza por la sección estándar `Logging:LogLevel`, que el proveedor de OpenTelemetry respeta como cualquier otro.

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    }
  }
}
```

Verifica: pon una categoría en `Warning`, confirma que sus líneas de `Information` dejan de aparecer en el backend.

## Lista de verificación

Ejecuta esto después de cualquiera de las rutas, antes de que borres los paquetes viejos:

- `dotnet build` está limpio sin advertencias de `Serilog` que no esperabas.
- `dotnet test` pasa con cero fallos.
- Una solicitud produce registros de log en el backend con un cuerpo no vacío (`IncludeFormattedMessage` funcionando).
- Esos registros comparten el `TraceId` de la solicitud (correlación funcionando).
- Las propiedades estructuradas (`OrderId`, valores de scope) aparecen como atributos, no incrustadas en la cadena del mensaje (`ParseStateValues` e `IncludeScopes` funcionando).
- El volumen de registros en el backend coincide con lo esperado; ningún filtro de nivel está descartando o inundando en silencio.
- El apagado hace flush: detén la app a mitad de una solicitud y confirma que las últimas líneas todavía llegan (el procesador por lotes hace flush al desecharse).

## Plan de reversión

**La Ruta A es reversible en un solo commit.** Revierte el bloque `WriteTo.OpenTelemetry(...)` a tu vieja configuración `WriteTo.Seq(...)` / `WriteTo.File(...)` y quita el paquete `Serilog.Sinks.OpenTelemetry`. Nada más cambió, así que no hay superficie de riesgo.

**La Ruta B es reversible pero no trivial.** Mantén los paquetes de Serilog instalados y el viejo bootstrap de `Program.cs` en tu historial de git hasta que la nueva tubería haya corrido en producción durante un ciclo de versión. Si necesitas revertir, restaura `UseSerilog()`, el bootstrap de `Log.Logger` y convierte las llamadas a `BeginScope` de vuelta a `LogContext.PushProperty`. Como el cambio toca scopes y logging de solicitudes a lo largo de la base de código, trata la reversión como su propia pequeña migración, no como un interruptor de una línea. No borres los paquetes de Serilog del `.csproj` hasta que la verificación haya pasado en producción.

## Problemas con los que nos topamos

**Cuerpos de log vacíos en el backend.** Si `IncludeFormattedMessage` se queda en su valor por defecto `false`, el registro OTLP se envía con atributos estructurados pero sin mensaje renderizado, y algunos backends muestran una línea en blanco. Actívalo. Combínalo con `ParseStateValues = true` para que los placeholders con nombre (`{OrderId}`) también lleguen como atributos en lugar de solo dentro de la cadena formateada.

**Las propiedades de scope desaparecen.** `IncludeScopes` tiene por defecto `false`. Cada valor de `BeginScope`, y cualquier cosa que ASP.NET Core ponga en el scope de la solicitud, se descarta hasta que lo habilites. Este es el reporte de "mi migración perdió la mitad de mi contexto de log" más común.

**Sin destructuring `{@Object}`.** El `_logger.LogInformation("Got {@Order}", order)` de Serilog serializaba el objeto completo. `Microsoft.Extensions.Logging` trata `@` como texto literal. Registra los campos escalares que de verdad consultas, o serializa explícitamente con `System.Text.Json`. Volcar objetos completos también explota la cardinalidad de los atributos, por la cual algunos backends cobran.

**Perder el logging de arranque en dos etapas.** El `CreateBootstrapLogger()` de Serilog capturaba fallos que ocurren antes de que el host se construya. El proveedor de OpenTelemetry solo existe después de `builder.Build()`, así que las excepciones de arranque muy tempranas van solo a la consola. Si la observabilidad del arranque temprano importa, mantén un logger de consola mínimo para esa ventana.

**Sorpresas en el mapeo de severidad.** El `Verbose` de Serilog se convierte en `Trace` de OTel, y `Fatal` se convierte en `Critical`. Si filtras o alertas con nombres de severidad aguas abajo, actualiza esas reglas. `Debug`, `Information`, `Warning` y `Error` mapean uno a uno.

Si de todas formas estás afinando el logging, vale la pena revisar cómo emites datos estructurados en primer lugar; [configurar logging estructurado con Serilog y Seq en .NET 11](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) cubre los patrones de plantillas de mensaje que se trasladan limpiamente a `ILogger`, y [el tracing nativo de OpenTelemetry de ASP.NET Core 11](/es/2026/04/aspnetcore-11-native-opentelemetry-tracing/) explica por qué quizás no necesites paquetes de instrumentación extra una vez que estás en la tubería unificada. Para trabajos en segundo plano y servicios alojados, [monitorear trabajos en segundo plano sin Hangfire](/es/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) muestra la misma correlación funcionando fuera de la ruta de la solicitud, y el [aviso sobre baggage de OpenTelemetry de Aspire 13.2.4](/es/2026/04/aspire-13-2-4-opentelemetry-cve-2026-40894-baggage-dos/) es un recordatorio para mantener los paquetes de OTel parcheados.

Elige el puente a menos que eliminar Serilog sea un objetivo real. Te da registros OTLP y correlación de trazas esta misma noche, y puedes hacer el cambio completo más tarde cuando tengas un sprint tranquilo para traducir scopes y logging de solicitudes como es debido.

## Fuentes

- [Documentación de logs de OpenTelemetry .NET](https://opentelemetry.io/docs/languages/dotnet/logs/)
- [Serilog.Sinks.OpenTelemetry en GitHub](https://github.com/serilog/serilog-sinks-opentelemetry)
- [Exportador OTLP para OpenTelemetry .NET](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Exporter.OpenTelemetryProtocol/README.md)
- [Observabilidad de .NET con OpenTelemetry (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel)
- [OpenTelemetry.Exporter.OpenTelemetryProtocol en NuGet](https://www.nuget.org/packages/OpenTelemetry.Exporter.OpenTelemetryProtocol)
