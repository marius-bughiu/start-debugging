---
title: ".NET 11 gibt MemoryCache erstklassige OpenTelemetry-Metriken"
description: ".NET 11 Preview 4 liefert einen integrierten Meter für Microsoft.Extensions.Caching.Memory, sodass Cache-Trefferquote und Evictions ohne Background-Poller in OpenTelemetry fließen."
pubDate: 2026-06-06
tags:
  - "dotnet"
  - "dotnet-11"
  - "opentelemetry"
  - "caching"
lang: "de"
translationOf: "2026/06/dotnet-11-memorycache-opentelemetry-metrics"
translatedBy: "claude"
translationDate: 2026-06-06
---

Die nützlichste Zahl für jeden leselastigen Dienst ist die Cache-Trefferquote, und bis jetzt zwang `Microsoft.Extensions.Caching.Memory` Sie, danach zu angeln. .NET 11 Preview 4, veröffentlicht am 2026-06-02, behebt das: `MemoryCache` gibt jetzt OpenTelemetry-Metriken aus einem integrierten Meter aus, sodass Treffer, Fehlversuche, Evictions und Größe ohne eine einzige Zeile eigener Verdrahtung in Ihren Dashboards landen.

## Was TrackStatistics Sie bisher kostete

`TrackStatistics` und `GetCurrentStatistics()` existieren seit .NET 8, aber sie lieferten nur ein Snapshot-Objekt. Um daraus eine Zeitreihe zu machen, mussten Sie einen Hosted Service schreiben, der den Cache per Timer abfragte und die Zahlen über Ihren eigenen `Meter` erneut veröffentlichte:

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

Das funktioniert, aber der Cast ist hässlich, das Abfrageintervall ist geraten, und jedes Projekt erfindet denselben Boilerplate neu.

## Der integrierte Meter

Preview 4 fügt einen Meter namens `Microsoft.Extensions.Caching.Memory` mit vier beobachtbaren Instrumenten hinzu:

| Instrument | Typ | Meldet |
| --- | --- | --- |
| `dotnet.cache.requests` | Counter | Treffer und Fehlversuche, nach Tag getrennt |
| `dotnet.cache.entries` | Up-Down-Counter | aktuelle Anzahl der Einträge |
| `dotnet.cache.estimated_size` | Gauge | aktuelle geschätzte Größe |
| `dotnet.cache.evictions` | Counter | Gesamtzahl der Evictions seit dem Start |

`dotnet.cache.requests` trägt einen `cache.request.type`-Tag mit dem Wert `hit` oder `miss`, was genau das ist, was Sie brauchen, um die Trefferquote im Dashboard statt in der Anwendung zu berechnen. Jedes Instrument trägt außerdem einen `cache.name`-Tag, sodass mehrere Caches in einem Prozess unterscheidbar bleiben.

## Die Verdrahtung

Zwei Schritte: Statistiken einschalten und den Meter bei OpenTelemetry registrieren.

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

Die Instrumente bleiben inaktiv, bis `TrackStatistics` gesetzt ist, sodass kein Overhead entsteht, wenn Sie sich nie dafür entscheiden. Geben Sie jedem Cache einen `Name`, und der `cache.name`-Tag macht den Katalog-Cache in Grafana oder Azure Monitor mühelos vom Session-Cache trennbar.

Die Metriken fügen sich neben das [native OpenTelemetry-Tracing](/de/2026/04/aspnetcore-11-native-opentelemetry-tracing/) ein, das ASP.NET Core früher im .NET-11-Zyklus erhielt, was bedeutet, dass ein Request-Trace und das dahinterliegende Cache-Verhalten jetzt dieselbe Pipeline teilen. Holen Sie sich [.NET 11 Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) und löschen Sie Ihren Cache-Statistik-`BackgroundService`.
