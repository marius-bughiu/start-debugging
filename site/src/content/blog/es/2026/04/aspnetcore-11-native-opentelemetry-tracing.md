---
title: "ASP.NET Core 11 incluye trazado OpenTelemetry nativo: deja el paquete NuGet adicional"
description: "ASP.NET Core en .NET 11 Preview 2 agrega atributos semánticos de OpenTelemetry directamente a la actividad del servidor HTTP, eliminando la necesidad de OpenTelemetry.Instrumentation.AspNetCore."
pubDate: 2026-04-12
tags:
  - "aspnet-core"
  - "dotnet-11"
  - "opentelemetry"
  - "observability"
lang: "es"
translationOf: "2026/04/aspnetcore-11-native-opentelemetry-tracing"
translatedBy: "claude"
translationDate: 2026-04-25
---

Todo proyecto ASP.NET Core que exporta trazas tiene la misma línea en su `.csproj`: una referencia a `OpenTelemetry.Instrumentation.AspNetCore`. Ese paquete se suscribe al `Activity` source del framework y estampa cada span con los atributos semánticos que esperan los exportadores: `http.request.method`, `url.path`, `http.response.status_code`, `server.address`, y así.

A partir de [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/), el framework hace ese trabajo por sí mismo. ASP.NET Core ahora puebla los atributos estándar de las convenciones semánticas de OpenTelemetry directamente en la actividad del servidor HTTP, así que la biblioteca de instrumentación separada ya no es requerida para recolectar datos de trazado base.

## Lo que el framework ahora provee

Cuando una solicitud llega a Kestrel en .NET 11 Preview 2, el middleware integrado escribe los mismos atributos que el paquete de instrumentación solía agregar:

- `http.request.method`
- `url.path` y `url.scheme`
- `http.response.status_code`
- `server.address` y `server.port`
- `network.protocol.version`

Estas son las [convenciones semánticas del servidor HTTP](https://opentelemetry.io/docs/specs/semconv/http/http-spans/) en las que se apoyan todos los backends compatibles con OTLP para dashboards y alertas.

## Antes y después

Una configuración típica de .NET 10 para obtener trazas HTTP se veía así:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddAspNetCoreInstrumentation()   // requires the NuGet package
            .AddOtlpExporter();
    });
```

En .NET 11, te suscribes al activity source integrado en su lugar:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddSource("Microsoft.AspNetCore")  // no extra package needed
            .AddOtlpExporter();
    });
```

El paquete `OpenTelemetry.Instrumentation.AspNetCore` no desapareció; sigue existiendo para los equipos que necesitan sus callbacks de enriquecimiento o filtrado avanzado. Pero los atributos base que el 90% de los proyectos necesitan ahora están horneados en el framework.

## Por qué esto importa

Menos paquetes significa un grafo de dependencias más pequeño, tiempos de restore más rápidos, y una cosa menos que mantener sincronizada durante actualizaciones de versión mayor. También significa que las aplicaciones ASP.NET Core publicadas con NativeAOT obtienen trazas estándar sin meter código de instrumentación pesado en reflexión.

Si ya estás corriendo el paquete de instrumentación, nada se rompe. Los atributos del framework y los atributos del paquete se fusionan limpiamente en la misma `Activity`. Puedes eliminar la referencia al paquete cuando estés listo, probar tus dashboards, y seguir adelante.

Las [notas de versión completas de ASP.NET Core .NET 11 Preview 2](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview2/aspnetcore.md) cubren el resto de los cambios, incluyendo el soporte de TempData en Blazor SSR y la nueva plantilla de proyecto Web Worker.
