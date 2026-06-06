---
title: ".NET 11 が MemoryCache に第一級の OpenTelemetry メトリクスを追加"
description: ".NET 11 Preview 4 は Microsoft.Extensions.Caching.Memory 用の組み込み meter を提供し、キャッシュのヒット率や eviction がバックグラウンドのポーラーなしで OpenTelemetry に流れます。"
pubDate: 2026-06-06
tags:
  - "dotnet"
  - "dotnet-11"
  - "opentelemetry"
  - "caching"
lang: "ja"
translationOf: "2026/06/dotnet-11-memorycache-opentelemetry-metrics"
translatedBy: "claude"
translationDate: 2026-06-06
---

読み取りの多いサービスにとって最も有用な数値はキャッシュのヒット率ですが、これまで `Microsoft.Extensions.Caching.Memory` ではそれを手探りで取り出す必要がありました。2026-06-02 にリリースされた .NET 11 Preview 4 がこれを解決します。`MemoryCache` は組み込みの meter から OpenTelemetry メトリクスを出力するようになり、ヒット、ミス、eviction、サイズが独自の配線を一切書かずにダッシュボードへ届きます。

## これまで TrackStatistics に払っていたコスト

`TrackStatistics` と `GetCurrentStatistics()` は .NET 8 から存在しますが、これらはスナップショットオブジェクトを返すだけでした。それを時系列に変えるには、タイマーでキャッシュをポーリングし、自前の `Meter` を通じて数値を再公開するホステッドサービスを書く必要がありました。

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

これは動作しますが、キャストは醜く、ポーリング間隔は当て推量で、どのプロジェクトも同じ定型コードを再発明することになります。

## 組み込みの meter

Preview 4 は `Microsoft.Extensions.Caching.Memory` という名前の meter を、4 つの observable な計測器とともに追加します。

| 計測器 | 種類 | 報告する内容 |
| --- | --- | --- |
| `dotnet.cache.requests` | counter | ヒットとミス、タグで分割 |
| `dotnet.cache.entries` | up-down counter | 現在のエントリ数 |
| `dotnet.cache.estimated_size` | gauge | 現在の推定サイズ |
| `dotnet.cache.evictions` | counter | 起動以降の eviction の合計 |

`dotnet.cache.requests` は値が `hit` または `miss` の `cache.request.type` タグを持ち、これはまさにヒット率をアプリケーションではなくダッシュボードで計算するために必要なものです。各計測器は `cache.name` タグも持つため、1 つのプロセス内の複数のキャッシュは区別されたままになります。

## 配線方法

2 ステップです。統計を有効にし、meter を OpenTelemetry に登録します。

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

計測器は `TrackStatistics` が設定されるまで休止状態のままなので、有効にしなければオーバーヘッドはありません。各キャッシュに `Name` を与えれば、`cache.name` タグにより Grafana や Azure Monitor でカタログキャッシュをセッションキャッシュから簡単に分離できます。

このメトリクスは、.NET 11 のサイクルの早い段階で ASP.NET Core が取り入れた[ネイティブの OpenTelemetry トレーシング](/ja/2026/04/aspnetcore-11-native-opentelemetry-tracing/)の隣に収まります。つまり、リクエストのトレースとその背後にあるキャッシュの挙動が同じパイプラインを共有するようになります。[.NET 11 Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) を入手して、キャッシュ統計の `BackgroundService` を削除しましょう。
