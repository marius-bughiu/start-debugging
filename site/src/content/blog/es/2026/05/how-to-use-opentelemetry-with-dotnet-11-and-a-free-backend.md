---
title: "Cómo usar OpenTelemetry con .NET 11 y un backend gratuito"
description: "Conecta trazas, métricas y logs de OpenTelemetry en una aplicación ASP.NET Core .NET 11 con el exportador OTLP, y luego envíalos a un backend gratuito y autoalojado: el Aspire Dashboard standalone para desarrollo local, Jaeger y SigNoz para producción autoalojada, y el OpenTelemetry Collector cuando necesites ambos."
pubDate: 2026-05-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "observability"
  - "opentelemetry"
lang: "es"
translationOf: "2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend"
translatedBy: "claude"
translationDate: 2026-05-01
---

Para agregar OpenTelemetry a una aplicación ASP.NET Core de .NET 11 y enviar los datos a algo gratuito, instala `OpenTelemetry.Extensions.Hosting` 1.15.3 y `OpenTelemetry.Exporter.OpenTelemetryProtocol` 1.15.3, registra el SDK con `services.AddOpenTelemetry().WithTracing(...).WithMetrics(...).UseOtlpExporter()`, configura `OTEL_EXPORTER_OTLP_ENDPOINT` apuntando a tu collector o backend, y ejecuta el Aspire Dashboard standalone desde la imagen Docker `mcr.microsoft.com/dotnet/aspire-dashboard` como visor local. Aspire Dashboard habla OTLP/gRPC en `4317` y OTLP/HTTP en `4318`, no cuesta nada y muestra trazas, logs estructurados y métricas en una sola interfaz. Para observabilidad autoalojada en producción, cambia el destino por Jaeger 2.x (solo trazas) o SigNoz 0.x (trazas, métricas, logs) y pon el OpenTelemetry Collector delante para poder bifurcar y filtrar. Esta guía está escrita contra .NET 11 preview 3, C# 14 y OpenTelemetry .NET 1.15.3.

## Por qué OpenTelemetry en lugar de SDKs propietarios

Cada producto serio de observabilidad para .NET sigue ofreciendo un SDK propietario: Application Insights, Datadog, New Relic, Dynatrace, el cliente propio de Honeycomb, y muchos más. Todos hacen aproximadamente lo mismo: se enganchan a ASP.NET Core, HttpClient y EF Core, agrupan datos por lotes y los envían en su formato. El problema empieza en cuanto quieres cambiar de proveedor, ejecutar dos en paralelo o simplemente ver los datos localmente sin pagar a nadie. Cada reescritura es un proyecto de varias semanas en sí mismo, porque las llamadas de instrumentación están repartidas en cientos de archivos.

OpenTelemetry reemplaza esa imagen con un único SDK neutral en cuanto al proveedor y un único formato de transporte (OTLP). Instrumentas una vez. El exportador es un paquete separado, intercambiable al iniciar la aplicación. Puedes enviar la misma telemetría a Aspire Dashboard durante el desarrollo local, a Jaeger en staging y a un backend de pago en producción, sin tocar el código de la aplicación. ASP.NET Core 11 incluso incluye primitivas nativas de tracing OpenTelemetry, de modo que los spans del propio framework caen en el mismo pipeline que los tuyos personalizados (consulta [los cambios de tracing nativo de OpenTelemetry en .NET 11](/es/2026/04/aspnetcore-11-native-opentelemetry-tracing/) para ver qué se subió al árbol principal).

Los números de versión que vale la pena fijar para 2026: `OpenTelemetry` 1.15.3, `OpenTelemetry.Extensions.Hosting` 1.15.3, `OpenTelemetry.Exporter.OpenTelemetryProtocol` 1.15.3, la instrumentación de ASP.NET Core 1.15.0 y la instrumentación de HttpClient 1.15.0. Aspire Dashboard se distribuye desde `mcr.microsoft.com/dotnet/aspire-dashboard:9.5` al momento de escribir esto.

## Levanta el backend gratuito en 30 segundos

Antes que nada, ten un backend funcionando. El Aspire Dashboard standalone es la opción de menor esfuerzo para desarrollo local. Expone un receptor OTLP, indexa trazas, métricas y logs en memoria, y te da una interfaz Blazor en el puerto `18888`:

```bash
# Aspire Dashboard 9.5, default ports
docker run --rm \
  --name aspire-dashboard \
  -p 18888:18888 \
  -p 4317:18889 \
  -p 4318:18890 \
  -e DASHBOARD__OTLP__AUTHMODE=ApiKey \
  -e DASHBOARD__OTLP__PRIMARYAPIKEY=local-dev-key \
  mcr.microsoft.com/dotnet/aspire-dashboard:9.5
```

El contenedor expone internamente `18889` para OTLP/gRPC y `18890` para OTLP/HTTP, y los mapeas a los puertos estándar `4317`/`4318` por fuera para que cualquier SDK de OpenTelemetry con configuración por defecto los encuentre. Establecer `DASHBOARD__OTLP__AUTHMODE=ApiKey` obliga a los clientes a adjuntar la clave en una cabecera `x-otlp-api-key`, lo cual importa en cuanto enlazas el dashboard a una dirección que no sea loopback. Abre `http://localhost:18888` y verás pestañas vacías de Traces, Metrics y Structured Logs esperando datos. El dashboard guarda todo en memoria del proceso, así que un reinicio borra el estado: esta es una herramienta de desarrollo, no un almacén a largo plazo.

Si prefieres no ejecutar nada localmente, Jaeger 2.x tiene la misma ergonomía solo para trazas:

```bash
# Jaeger 2.0 all-in-one
docker run --rm \
  --name jaeger \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  jaegertracing/jaeger:2.0.0
```

Jaeger 2.x es en sí mismo un envoltorio fino sobre el OpenTelemetry Collector con un backend de almacenamiento Cassandra/Elasticsearch/Badger, y acepta OTLP de forma nativa. SigNoz, que añade métricas y logs sobre ClickHouse, es una instalación con Docker Compose en lugar de un único comando; clona `https://github.com/SigNoz/signoz` y ejecuta `docker compose up`.

## Instala el SDK y los paquetes de instrumentación

Para una API mínima de ASP.NET Core 11, cuatro paquetes te dan el camino feliz. El agregado `OpenTelemetry.Extensions.Hosting` arrastra el SDK; el exportador OTLP gestiona el transporte; y los dos paquetes de instrumentación cubren las dos superficies que toda aplicación web necesita: HTTP entrante y HTTP saliente.

```bash
# OpenTelemetry .NET 1.15.3, .NET 11
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.15.3
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.15.3
dotnet add package OpenTelemetry.Instrumentation.AspNetCore --version 1.15.0
dotnet add package OpenTelemetry.Instrumentation.Http --version 1.15.0
```

Si además usas EF Core, añade `OpenTelemetry.Instrumentation.EntityFrameworkCore` 1.15.0-beta.1. Fíjate en el sufijo `-beta.1`: esa línea está oficialmente todavía en versión preliminar, pero todos los equipos con los que he trabajado la tratan como estable. La instrumentación se engancha al diagnostic source de EF Core y emite un span por cada `SaveChanges`, consulta y DbCommand.

## Conecta trazas, métricas y logs en Program.cs

El SDK es un único registro. Desde OpenTelemetry .NET 1.8, `UseOtlpExporter()` es el helper transversal que registra el exportador OTLP para trazas, métricas y logs en una sola llamada, reemplazando al antiguo `AddOtlpExporter()` por pipeline:

```csharp
// .NET 11, C# 14, OpenTelemetry 1.15.3
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r
        .AddService(
            serviceName: "orders-api",
            serviceVersion: typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0",
            serviceInstanceId: Environment.MachineName))
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddSource("Orders.*"))
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddRuntimeInstrumentation()
        .AddMeter("Orders.*"))
    .WithLogging()
    .UseOtlpExporter();

var app = builder.Build();

app.MapGet("/orders/{id:int}", (int id) => new { id, status = "ok" });
app.Run();
```

Vale la pena destacar tres cosas. Primero, `ConfigureResource` no es opcional en la práctica: sin `service.name`, cada backend agrupará todo bajo `unknown_service:dotnet`, lo cual se vuelve inviable en cuanto aparece una segunda aplicación. Segundo, `AddSource("Orders.*")` es lo que expone tus instancias personalizadas de `ActivitySource`; si instancias una como `new ActivitySource("Orders.Checkout")`, debe coincidir con un glob que registraste o los spans no llegan a ningún sitio. Tercero, `WithLogging()` ata `Microsoft.Extensions.Logging` al mismo pipeline, de modo que una llamada a `ILogger<T>` escribe registros de log estructurados de OpenTelemetry con el trace ID y el span ID actuales adjuntos. Eso es lo que hace que el enlace "View structured logs for this trace" del Aspire Dashboard funcione.

## Configura el exportador desde variables de entorno, no desde código

El exportador OTLP por defecto lee su destino, protocolo y cabeceras desde variables de entorno definidas por la especificación OpenTelemetry. Hardcodearlas dentro de `UseOtlpExporter(o => o.Endpoint = ...)` es una mala señal porque ata tu binario a un backend específico. Usa variables de entorno y la misma imagen corre en una laptop de desarrollo, en CI y en producción sin recompilar:

```bash
# Talk to a local Aspire Dashboard over gRPC
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"
export OTEL_EXPORTER_OTLP_HEADERS="x-otlp-api-key=local-dev-key"
export OTEL_SERVICE_NAME="orders-api"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=dev"
```

Hay dos valores que pillan a casi todo el mundo. `OTEL_EXPORTER_OTLP_PROTOCOL` por defecto es `grpc` en .NET 8+ pero `http/protobuf` en builds .NET Standard 2.0, porque el SDK trae un cliente gRPC personalizado en targets modernos pero retrocede a HTTP en Framework. Si estás puenteando ambos, configura el valor explícitamente. Y `OTEL_EXPORTER_OTLP_HEADERS` acepta una lista de pares `clave=valor` separados por comas. Los backends que se autentican con tokens bearer usan esto para `Authorization=Bearer ...`. La clave de API del Aspire Dashboard es `x-otlp-api-key`, no la más común `Authorization`.

Cuando migras de desarrollo local a un backend desplegado, el único cambio es el endpoint y la cabecera de auth. El binario de la aplicación queda igual.

## Añade un span personalizado con ActivitySource

Los paquetes de instrumentación cubren HTTP entrante y saliente automáticamente, además de EF Core si añadiste ese. Todo lo demás corre por tu cuenta. .NET trae `System.Diagnostics.ActivitySource` como la primitiva multiruntime para spans: OpenTelemetry .NET la adopta directamente en lugar de introducir su propio tipo. Crea uno por área lógica, registra el prefijo en `AddSource`, y llama a `StartActivity` donde quieras un span:

```csharp
// Orders/CheckoutService.cs -- .NET 11, C# 14
using System.Diagnostics;

public sealed class CheckoutService(IOrdersRepository orders, IPaymentClient payments)
{
    private static readonly ActivitySource Source = new("Orders.Checkout");

    public async Task<CheckoutResult> CheckoutAsync(int orderId, CancellationToken ct)
    {
        using var activity = Source.StartActivity("checkout", ActivityKind.Internal);
        activity?.SetTag("order.id", orderId);

        var order = await orders.GetAsync(orderId, ct);
        activity?.SetTag("order.line_count", order.Lines.Count);

        var receipt = await payments.ChargeAsync(order, ct);
        activity?.SetTag("payment.provider", receipt.Provider);

        return new CheckoutResult(receipt.Id);
    }
}
```

`StartActivity` retorna `null` cuando no hay listener adjunto, así que las llamadas `?.SetTag` no son paranoia defensiva, evitan una NullReferenceException en un build con OpenTelemetry deshabilitado. Las etiquetas siguen las convenciones semánticas de OpenTelemetry donde existe una (`http.request.method`, `db.system`, `messaging.destination.name`); para valores específicos del dominio como `order.id`, ponles un prefijo propio para mantenerlas consultables sin chocar con las convenciones.

El mismo patrón aplica a las métricas con `System.Diagnostics.Metrics.Meter`. Crea uno por área, regístralo con `AddMeter`, y usa `Counter<T>`, `Histogram<T>` u `ObservableGauge<T>` para grabar valores.

## Correlaciona logs OTLP con trazas

La razón para registrar `WithLogging()` y no solo `WithTracing()` es la correlación. Cada llamada a `ILogger<T>` dentro de un span activo recibe automáticamente el `TraceId` y el `SpanId` del span adjuntos como campos del registro de log OTLP, y el Aspire Dashboard renderiza esto como un enlace clicable desde la vista de la traza. La misma correlación funciona en cualquier backend compatible con OpenTelemetry.

Si ya usas Serilog y no quieres renunciar a él, no tienes que hacerlo. El paquete `Serilog.Sinks.OpenTelemetry` escribe los eventos de Serilog como registros de log OTLP, y el proveedor de logging del SDK de OpenTelemetry se puede saltar en `WithLogging()`. La publicación sobre logging estructurado en este sitio tiene un tratamiento más largo de [cómo configurar Serilog con Seq en .NET 11](/es/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) y las mismas reglas de correlación de trazas aplican cuando cambias Seq por OTLP.

Para `Microsoft.Extensions.Logging` puro, la receta es más corta: añade `WithLogging()` al pipeline de OpenTelemetry y desactiva el proveedor de consola por defecto en producción. `LogInformation("Order {OrderId} for {CustomerId} took {Elapsed} ms", id, customer, ms)` ya está estructurado, y OpenTelemetry serializa los placeholders nombrados como atributos del log OTLP. El proveedor de consola, en contraste, los aplana de vuelta en una sola cadena, que es exactamente la regresión de la que intentabas escapar.

## Pon el OpenTelemetry Collector delante en producción

En producción muy pocas veces quieres que tu aplicación hable directamente con un backend de observabilidad. Quieres un Collector en medio: un proceso independiente que recibe OTLP, aplica muestreo, depura PII, agrupa por lotes, reintenta y bifurca los datos a uno o varios destinos. La imagen del Collector es `otel/opentelemetry-collector-contrib:0.111.0`, y una configuración mínima que recibe OTLP y reenvía a Jaeger más un backend hospedado se ve así:

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
    send_batch_size: 512
  attributes/scrub:
    actions:
      - key: http.request.header.authorization
        action: delete
      - key: user.email
        action: hash

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true
  otlp/honeycomb:
    endpoint: api.honeycomb.io:443
    headers:
      x-honeycomb-team: ${env:HONEYCOMB_API_KEY}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, attributes/scrub]
      exporters: [otlp/jaeger, otlp/honeycomb]
```

El `OTEL_EXPORTER_OTLP_ENDPOINT` de la aplicación ahora apunta al Collector, no a un backend específico. Cambiar de destino es una reconfiguración y reinicio del Collector, no un redespliegue de cada servicio. El mismo patrón es lo que mantiene tu volumen de trazas controlado: pon el procesador `attributes/scrub` delante de cada exportador y dejas de enviar accidentalmente cabeceras de autorización a un tercero desde el día uno.

## Trampas que la documentación no advierte

Hay tres cosas que muerden a la gente camino a un pipeline funcional.

Primero, **los valores por defecto de gRPC y HTTP no coinciden entre runtimes**. En .NET 8 y posteriores, el SDK trae un cliente gRPC gestionado y `OTEL_EXPORTER_OTLP_PROTOCOL` por defecto es `grpc`. En .NET Framework 4.8 y .NET Standard 2.0, el valor por defecto es `http/protobuf` para evitar la dependencia de `Grpc.Net.Client`. Si una solución única apunta a ambos, configura el protocolo explícitamente o verás comportamientos diferentes desde el mismo código en dos ensamblados.

Segundo, **los atributos de recurso son globales, no por pipeline**. `ConfigureResource` se ejecuta una vez, y el resultado se adjunta a cada traza, métrica y registro de log de ese proceso. Intentar configurar un atributo por petición a través de la API de recursos no hace nada en silencio; lo que quieres ahí es `Activity.SetTag` sobre el span activo, o una entrada de `Baggage` que se propague a través de la llamada. La CVE de DoS de baggage en Aspire 13.2.4, documentada en [el análisis de la CVE de baggage de OpenTelemetry .NET](/es/2026/04/aspire-13-2-4-opentelemetry-cve-2026-40894-baggage-dos/), es un recordatorio de que el baggage se parsea de forma anticipada en cada petición y, por lo tanto, es una herramienta útil pero afilada.

Tercero, **el exportador OTLP reintenta silenciosamente en segundo plano**. Cuando el backend está caído, el exportador sigue agrupando eventos en memoria y reintentando con backoff exponencial hasta un tope configurable. Eso suele ser lo que quieres; lo sorprendente es que cuando el Collector o el dashboard vuelven en línea, no hay un flush instantáneo. Si estás ejecutando una prueba de integración y aseverando "la traza X llegó al Aspire Dashboard en 100 ms", dale al exportador un calendario de `BatchExportProcessor` más corto que los 5 segundos por defecto, o llama explícitamente a `TracerProvider.ForceFlush()` antes de la aserción.

## A dónde ir desde aquí

El valor de OpenTelemetry crece con la superficie que instrumentas. El punto de partida es ASP.NET Core más HttpClient más EF Core. A partir de ahí, las añadiduras de mayor palanca son los servicios en segundo plano (cada `IHostedService` debería iniciar una `Activity` por unidad de trabajo) y los brokers de mensajes salientes (las instrumentaciones `OpenTelemetry.Instrumentation.MassTransit` y Confluent.Kafka cubren a la mayoría de los equipos). Para el profiling más profundo de unidades de trabajo una vez que los spans te llevan al minuto correcto, [la guía de dotnet-trace en este sitio](/es/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) recorre la herramienta que más a menudo recoge el testigo donde OpenTelemetry lo deja, y [la publicación sobre el filtro de excepciones global](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) cubre el lado ASP.NET Core de capturar fallos limpiamente en el mismo pipeline.

El estado final al que vale la pena apuntar es: un pipeline, un formato de transporte y un solo lugar donde mirar primero cuando algo va mal. OpenTelemetry más el Aspire Dashboard más un Collector delante te llevan ahí por el precio de un docker pull.

Sources:

- [OpenTelemetry .NET Exporters documentation](https://opentelemetry.io/docs/languages/dotnet/exporters/)
- [OTLP Exporter for OpenTelemetry .NET](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Exporter.OpenTelemetryProtocol/README.md)
- [Use OpenTelemetry with the standalone Aspire Dashboard - .NET](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-otlp-example)
- [.NET Observability with OpenTelemetry](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel)
- [OpenTelemetry.Exporter.OpenTelemetryProtocol on NuGet](https://www.nuget.org/packages/OpenTelemetry.Exporter.OpenTelemetryProtocol)
