---
title: "Hangfire を使わずに .NET 9 と .NET 10 のバックグラウンドジョブを監視する: ヘルス + メトリクス + アラート"
description: ".NET 9 と .NET 10 で BackgroundService のジョブを Hangfire なしで監視する方法。ハートビートのヘルスチェック、所要時間メトリクス、失敗アラートを実用的なコード例とともに紹介します。"
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "ja"
translationOf: "2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts"
translatedBy: "claude"
translationDate: 2026-04-30
---
今日 r/dotnet で出てきた質問です。「(Hangfire なしで) .NET のバックグラウンドジョブをどう監視・アラートしていますか?」。よくある誤りは、"サービスが起動している" を "ジョブが動いている" と同じ意味にとらえてしまうことです。バックグラウンド処理には、ジョブの進行に紐づいた生存シグナルが必要です。

元の議論: [https://www.reddit.com/r/dotnet/comments/1q86tv7/how\_do\_you\_monitor\_alert\_on\_background\_jobs\_in/](https://www.reddit.com/r/dotnet/comments/1q86tv7/how_do_you_monitor_alert_on_background_jobs_in/)

## 重要な 3 つのシグナル

-   **生存性 (Liveness)**: ジョブのループがまだ動いている (ハートビート)。
-   **正しさ**: 失敗が握りつぶされず追跡されている。
-   **レイテンシ**: 処理が SLO の中で終わっている。

ログしかない場合、"遅いけれど死んではいない" 種類のインシデントで盲目になります。ヘルスチェックを 1 つ、そして少なくとも 1 つのメトリクスを追加してください。

## シンプルなパターン: ハートビート + 直近のエラー + 所要時間メトリクス

これは普通の `BackgroundService` で .NET 9 / .NET 10 で動きます。

```cs
using System.Diagnostics;
using System.Diagnostics.Metrics;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging;

public sealed class JobState
{
    public DateTimeOffset LastSuccessUtc { get; private set; } = DateTimeOffset.MinValue;
    public Exception? LastError { get; private set; }

    public void MarkSuccess() { LastSuccessUtc = DateTimeOffset.UtcNow; LastError = null; }
    public void MarkFailure(Exception ex) { LastError = ex; }
}

public sealed class MyJob : BackgroundService
{
    private static readonly Meter Meter = new("MyApp.Jobs", "1.0");
    private static readonly Histogram<double> DurationMs = Meter.CreateHistogram<double>("myjob.duration_ms");
    private readonly JobState _state;
    private readonly ILogger<MyJob> _logger;

    public MyJob(JobState state, ILogger<MyJob> logger) { _state = state; _logger = logger; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var start = Stopwatch.GetTimestamp();
            try
            {
                await DoWorkOnce(stoppingToken);
                _state.MarkSuccess();
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                _state.MarkFailure(ex);
                _logger.LogError(ex, "Background job failed.");
            }
            finally
            {
                var elapsedMs = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
                DurationMs.Record(elapsedMs);
            }

            await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
        }
    }

    private static Task DoWorkOnce(CancellationToken ct) => Task.CompletedTask;
}

public sealed class JobHealthCheck(JobState state) : IHealthCheck
{
    private readonly JobState _state = state;

    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken)
    {
        var age = DateTimeOffset.UtcNow - _state.LastSuccessUtc;
        if (age <= TimeSpan.FromMinutes(2))
            return Task.FromResult(HealthCheckResult.Healthy("Job heartbeat OK."));

        var msg = _state.LastError is null
            ? $"No successful run in {age.TotalSeconds:n0}s."
            : $"Last error: {_state.LastError.GetType().Name}. No success in {age.TotalSeconds:n0}s.";

        return Task.FromResult(HealthCheckResult.Unhealthy(msg));
    }
}
```

配線のしかた:

-   `JobState` をシングルトンとして登録します。
-   ホストされたサービスを追加します。
-   `HealthChecks` を追加し、`/health` を公開します。
-   OpenTelemetry があればメトリクスをエクスポートし、なければせめてログから失敗回数を抽出します。

## 何にアラートを出すか (みんな飛ばしがちな部分)

-   **Health が Unhealthy** の状態が X 分以上続いている。
-   **所要時間ヒストグラムの p95** が SLO を超えている。
-   **エラー率** がしきい値を超えている (区間ごとの例外数)。

ひとつだけやるなら、ハートビートのヘルスチェックです。これは "プロセスは生きているか?" を "ジョブは生きているか?" に変換します。後者こそ本当に問うべき質問です。

参考: [https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks](https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks)
