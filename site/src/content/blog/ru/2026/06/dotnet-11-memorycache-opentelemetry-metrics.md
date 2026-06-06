---
title: ".NET 11 даёт MemoryCache полноценные метрики OpenTelemetry"
description: ".NET 11 Preview 4 поставляет встроенный meter для Microsoft.Extensions.Caching.Memory, поэтому коэффициент попаданий в кеш и вытеснения попадают в OpenTelemetry без фонового опросчика."
pubDate: 2026-06-06
tags:
  - "dotnet"
  - "dotnet-11"
  - "opentelemetry"
  - "caching"
lang: "ru"
translationOf: "2026/06/dotnet-11-memorycache-opentelemetry-metrics"
translatedBy: "claude"
translationDate: 2026-06-06
---

Самое полезное число для любого сервиса с интенсивным чтением -- это коэффициент попаданий в кеш, и до сих пор `Microsoft.Extensions.Caching.Memory` заставлял вылавливать его вручную. .NET 11 Preview 4, выпущенный 2026-06-02, это исправляет: `MemoryCache` теперь выдаёт метрики OpenTelemetry из встроенного meter, поэтому попадания, промахи, вытеснения и размер попадают в ваши дашборды без единой строки собственной обвязки.

## Чего раньше стоил TrackStatistics

`TrackStatistics` и `GetCurrentStatistics()` существуют с .NET 8, но они отдавали лишь объект-снимок. Чтобы превратить это во временной ряд, нужно было писать hosted-сервис, который опрашивал кеш по таймеру и заново публиковал числа через ваш собственный `Meter`:

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

Это работает, но приведение типа уродливо, интервал опроса -- это догадка, и каждый проект заново изобретает один и тот же шаблонный код.

## Встроенный meter

Preview 4 добавляет meter с именем `Microsoft.Extensions.Caching.Memory` и четырьмя наблюдаемыми инструментами:

| Инструмент | Тип | Сообщает |
| --- | --- | --- |
| `dotnet.cache.requests` | счётчик | попадания и промахи, разделённые по тегу |
| `dotnet.cache.entries` | up-down счётчик | текущее число записей |
| `dotnet.cache.estimated_size` | gauge | текущий оценочный размер |
| `dotnet.cache.evictions` | счётчик | всего вытеснений с момента запуска |

`dotnet.cache.requests` несёт тег `cache.request.type` со значением `hit` или `miss`, что и нужно, чтобы вычислять коэффициент попаданий в дашборде, а не в приложении. Каждый инструмент также несёт тег `cache.name`, поэтому несколько кешей в одном процессе остаются различимыми.

## Подключение

Два шага: включить статистику и зарегистрировать meter в OpenTelemetry.

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

Инструменты остаются неактивными, пока не задан `TrackStatistics`, поэтому накладных расходов нет, если вы никогда это не включаете. Дайте каждому кешу `Name`, и тег `cache.name` сделает кеш каталога тривиально отделимым от кеша сессии в Grafana или Azure Monitor.

Метрики встают рядом с [нативной трассировкой OpenTelemetry](/ru/2026/04/aspnetcore-11-native-opentelemetry-tracing/), которую ASP.NET Core получил ранее в цикле .NET 11, а значит трассировка запроса и поведение кеша за ней теперь используют один и тот же конвейер. Возьмите [.NET 11 Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) и удалите свой `BackgroundService` для статистики кеша.
