---
title: ".NET 11 le da a MemoryCache métricas de OpenTelemetry de primera clase"
description: ".NET 11 Preview 4 incluye un meter integrado para Microsoft.Extensions.Caching.Memory, así la tasa de aciertos de caché y las expulsiones fluyen a OpenTelemetry sin un poller en segundo plano."
pubDate: 2026-06-06
tags:
  - "dotnet"
  - "dotnet-11"
  - "opentelemetry"
  - "caching"
lang: "es"
translationOf: "2026/06/dotnet-11-memorycache-opentelemetry-metrics"
translatedBy: "claude"
translationDate: 2026-06-06
---

El número más útil para cualquier servicio con muchas lecturas es la tasa de aciertos de caché, y hasta ahora `Microsoft.Extensions.Caching.Memory` te obligaba a pescarlo. .NET 11 Preview 4, lanzado el 2026-06-02, lo soluciona: `MemoryCache` ahora emite métricas de OpenTelemetry desde un meter integrado, así que aciertos, fallos, expulsiones y tamaño llegan a tus dashboards sin una sola línea de plomería personalizada.

## Lo que TrackStatistics te costaba antes

`TrackStatistics` y `GetCurrentStatistics()` existen desde .NET 8, pero solo te entregaban un objeto de instantánea. Para convertir eso en una serie temporal tenías que escribir un servicio alojado que consultara la caché con un temporizador y republicara los números a través de tu propio `Meter`:

```csharp
// Pre-.NET 11: poll the snapshot yourself
public class CacheStatsReporter(IMemoryCache cache) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var stats = ((MemoryCache)cache).GetCurrentStatistics();
            // manually push stats.TotalHits, stats.TotalMisses, ...
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }
}
```

Eso funciona, pero el cast es feo, el intervalo de sondeo es una conjetura, y cada proyecto reinventa el mismo código repetitivo.

## El meter integrado

Preview 4 agrega un meter llamado `Microsoft.Extensions.Caching.Memory` con cuatro instrumentos observables:

| Instrumento | Tipo | Reporta |
| --- | --- | --- |
| `dotnet.cache.requests` | contador | aciertos y fallos, divididos por tag |
| `dotnet.cache.entries` | contador up-down | cantidad actual de entradas |
| `dotnet.cache.estimated_size` | gauge | tamaño estimado actual |
| `dotnet.cache.evictions` | contador | total de expulsiones desde el arranque |

`dotnet.cache.requests` lleva un tag `cache.request.type` con valor `hit` o `miss`, que es exactamente lo que necesitas para calcular la tasa de aciertos en el dashboard en lugar de en la aplicación. Cada instrumento también lleva un tag `cache.name`, así que varias cachés en un mismo proceso se mantienen distintas.

## Cómo conectarlo

Dos pasos: activa las estadísticas y registra el meter con OpenTelemetry.

```csharp
builder.Services.AddMemoryCache(options =>
{
    options.TrackStatistics = true;
    options.Name = "catalog";
});

builder.Services.AddOpenTelemetry()
    .WithMetrics(metrics =>
    {
        metrics.AddMeter("Microsoft.Extensions.Caching.Memory");
    });
```

Los instrumentos permanecen inactivos hasta que se establece `TrackStatistics`, así que no hay sobrecarga si nunca lo activas. Dale a cada caché un `Name` y el tag `cache.name` hace que la caché del catálogo sea trivialmente separable de la caché de sesión en Grafana o Azure Monitor.

Las métricas encajan junto al [trazado nativo de OpenTelemetry](/es/2026/04/aspnetcore-11-native-opentelemetry-tracing/) que ASP.NET Core adoptó antes en el ciclo de .NET 11, lo que significa que una traza de solicitud y el comportamiento de caché detrás de ella ahora comparten el mismo pipeline. Toma [.NET 11 Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) y borra tu `BackgroundService` de estadísticas de caché.
