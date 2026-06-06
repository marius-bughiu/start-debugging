---
title: ".NET 11 dá ao MemoryCache métricas de OpenTelemetry de primeira classe"
description: ".NET 11 Preview 4 traz um meter integrado para Microsoft.Extensions.Caching.Memory, então a taxa de acerto do cache e as expulsões fluem para o OpenTelemetry sem um poller em segundo plano."
pubDate: 2026-06-06
tags:
  - "dotnet"
  - "dotnet-11"
  - "opentelemetry"
  - "caching"
lang: "pt-br"
translationOf: "2026/06/dotnet-11-memorycache-opentelemetry-metrics"
translatedBy: "claude"
translationDate: 2026-06-06
---

O número mais útil para qualquer serviço com muitas leituras é a taxa de acerto do cache, e até agora `Microsoft.Extensions.Caching.Memory` obrigava você a garimpá-lo. .NET 11 Preview 4, lançado em 2026-06-02, resolve isso: `MemoryCache` agora emite métricas de OpenTelemetry a partir de um meter integrado, então acertos, erros, expulsões e tamanho chegam aos seus dashboards sem uma única linha de encanamento personalizado.

## O que TrackStatistics custava antes

`TrackStatistics` e `GetCurrentStatistics()` existem desde o .NET 8, mas só entregavam um objeto de snapshot. Para transformar isso em uma série temporal, você tinha que escrever um serviço hospedado que consultava o cache em um timer e republicava os números através do seu próprio `Meter`:

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

Isso funciona, mas o cast é feio, o intervalo de polling é um chute, e cada projeto reinventa o mesmo código repetitivo.

## O meter integrado

O Preview 4 adiciona um meter chamado `Microsoft.Extensions.Caching.Memory` com quatro instrumentos observáveis:

| Instrumento | Tipo | Reporta |
| --- | --- | --- |
| `dotnet.cache.requests` | contador | acertos e erros, divididos por tag |
| `dotnet.cache.entries` | contador up-down | contagem atual de entradas |
| `dotnet.cache.estimated_size` | gauge | tamanho estimado atual |
| `dotnet.cache.evictions` | contador | total de expulsões desde a inicialização |

`dotnet.cache.requests` carrega um tag `cache.request.type` com valor `hit` ou `miss`, que é exatamente o que você precisa para calcular a taxa de acerto no dashboard em vez de na aplicação. Cada instrumento também carrega um tag `cache.name`, então vários caches em um mesmo processo permanecem distintos.

## Como conectar

Dois passos: ative as estatísticas e registre o meter no OpenTelemetry.

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

Os instrumentos permanecem inativos até `TrackStatistics` ser definido, então não há sobrecarga se você nunca optar por usá-lo. Dê a cada cache um `Name` e o tag `cache.name` torna o cache do catálogo trivialmente separável do cache de sessão no Grafana ou no Azure Monitor.

As métricas se encaixam ao lado do [tracing nativo de OpenTelemetry](/pt-br/2026/04/aspnetcore-11-native-opentelemetry-tracing/) que o ASP.NET Core adotou mais cedo no ciclo do .NET 11, o que significa que um trace de requisição e o comportamento de cache por trás dele agora compartilham o mesmo pipeline. Pegue o [.NET 11 Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) e apague seu `BackgroundService` de estatísticas de cache.
