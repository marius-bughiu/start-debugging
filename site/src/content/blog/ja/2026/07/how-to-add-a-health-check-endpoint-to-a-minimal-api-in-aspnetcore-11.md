---
title: "ASP.NET Core 11 の Minimal API に health check エンドポイントを追加する方法"
description: "ASP.NET Core 11 の Minimal API における health checks の完全で実用的なガイドです。AddHealthChecks と MapHealthChecks、Healthy/Degraded/Unhealthy を返すカスタム IHealthCheck クラス、EF Core のプローブ AddDbContextCheck、Kubernetes 向けのタグベースの liveness と readiness エンドポイント、JSON の ResponseWriter、ResultStatusCodes、RequireAuthorization と RequireHost によるエンドポイントの保護、そして IHealthCheckPublisher による結果のプッシュを扱います。"
pubDate: 2026-07-19
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "health-checks"
lang: "ja"
translationOf: "2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-19
---

ASP.NET Core 11 の Minimal API に health check エンドポイントを追加するには、サービスを登録するために `builder.Services.AddHealthChecks()` を呼び出し、必要に応じて `.AddCheck(...)` の呼び出しを連ねてアプリケーションにとって "healthy" が何を意味するかを記述し、続いてエンドポイントを公開するために `app.MapHealthChecks("/healthz")` を呼び出します。その URL にアクセスすると、すべてのチェックが通れば本文 `Healthy` とともに `200 OK` が返り、いずれかのチェックが `Unhealthy` を報告すれば `503 Service Unavailable` が返ります。この 2 行のセットアップが完全な最小構成です。この記事はそれを最小構成から本番向けのセットアップまで引き上げます。実際に依存関係をプローブするカスタム `IHealthCheck`、EF Core の組み込みデータベースプローブ、Kubernetes 向けに配線された liveness と readiness の別々のエンドポイント、JSON のレスポンス本文、正しい HTTP ステータスコード、そしてエンドポイントのロックダウンです。対象は .NET 11 (執筆時点では Preview 6、GA は 2026 年 11 月) で、`Microsoft.NET.Sdk.Web` と C# 14 を使用しますが、health checks の API は ASP.NET Core 2.2 以降で安定しているため、ここのすべての例は .NET 8、9、10 でも変更なしで動作します。

## health check エンドポイントが実際に果たす役割

health check エンドポイントは、オーケストレーター、ロードバランサー、または稼働監視ツールが "このインスタンスにトラフィックを送るべきか" を尋ねるためにポーリングできる URL です。その答えは意図的に粗く、登録された一連のチェックから計算される集約ステータスであり、HTTP を話すものであれば本文を解析せずに消費できるように HTTP ステータスコードとして公開されます。Kubernetes はこれを使って、ポッドを再起動するか、あるいはそこへリクエストをルーティングするかを判断します。Azure App Service や AWS のターゲットグループはこれを使って、健全でないインスタンスをローテーションから外します。Uptime Kuma のようなツールはこれを使ってあなたに通知します。

設計上の要点は、health check がメトリクスのエンドポイントでも診断ダッシュボードでもないということです。それは 1 つの問いに素早く、理想的には数ミリ秒で答え、そのチェックはこのプロセスがリクエストを処理できるかどうかを本当に左右するものだけをテストすべきです。データベースは到達可能か、重要な下流の API は応答しているか、アプリケーションは起動処理を完了したか、といったものです。遅い、あるいは本質的でないプローブを詰め込むと、liveness のシグナルが負債になります。というのも、負荷の下で遅い health check は、それが防ぐはずだった連鎖的な再起動を引き起こすからです。

## health check エンドポイントを追加する手順

1. `builder.Services.AddHealthChecks()` でサービスを登録します。これは `IHealthChecksBuilder` を返します。
2. プローブしたい依存関係ごとに、その builder に `.AddCheck(...)` または `.AddCheck<T>(...)` の呼び出しを連ねます。
3. アプリケーションをビルドし、エンドポイントをマップするために `app.MapHealthChecks("/healthz")` を呼び出します。
4. 必要に応じて `HealthCheckOptions` を渡し、チェックをタグでフィルタリングしたり、レスポンスを整形したり、ステータスコードを再マッピングしたりします。
5. 必要に応じて `.RequireAuthorization()` または `.RequireHost(...)` を連ね、誰が到達できるかを制御します。

この記事の残りは、これらの各手順を動作するコードへと展開します。

## 2 行の出発点

これが動作する最小のものです。チェックを登録していない `AddHealthChecks` も依然として有用です。プロセスが起動していてリクエストパイプラインが回っている限り `Healthy` を返す liveness エンドポイントが得られます。

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHealthChecks();

var app = builder.Build();

app.MapHealthChecks("/healthz");

app.Run();
```

`GET /healthz` はこれで、プレーンテキストの本文 `Healthy` とともに `200 OK` を返します。登録されたチェックはないので、失敗しうるものは何もありません。これだけで "プロセスは生きていて HTTP を処理しているか" に答えており、それはまさに Kubernetes の liveness プローブが求めるものです。これ以降のすべては、健全以外の何かを報告しうるチェックの登録と、エンドポイントがどう伝えるかの整形についてです。

## IHealthCheck でカスタムチェックを書く

本物のチェックは依存関係をプローブし、3 つの状態のいずれかを報告します。`IHealthCheck` を実装します。その唯一のメソッドは `HealthCheckResult` を返します。

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Diagnostics.HealthChecks;

public sealed class QueueDepthHealthCheck : IHealthCheck
{
    private readonly IMessageQueue _queue;

    public QueueDepthHealthCheck(IMessageQueue queue) => _queue = queue;

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var depth = await _queue.GetApproximateDepthAsync(cancellationToken);

            if (depth > 10_000)
            {
                return HealthCheckResult.Unhealthy(
                    $"Queue backlog is {depth} messages.");
            }

            if (depth > 1_000)
            {
                // Still serving, but the backlog is a warning sign.
                return HealthCheckResult.Degraded(
                    $"Queue backlog is {depth} messages.",
                    data: new Dictionary<string, object> { ["depth"] = depth });
            }

            return HealthCheckResult.Healthy($"Queue depth {depth}.");
        }
        catch (Exception ex)
        {
            // Could not even reach the queue: that is unhealthy, not an unhandled 500.
            return HealthCheckResult.Unhealthy("Queue is unreachable.", ex);
        }
    }
}
```

3 つのファクトリメソッドは `HealthStatus` 列挙体の 3 つのメンバーに対応します。`Healthy` は完全に稼働中を意味します。`Unhealthy` はこのインスタンスが仕事をこなせず、ローテーションから外すか再起動すべきであることを意味します。`Degraded` は興味深い中間です。アプリケーションはまだリクエストを処理していますが、何かがおかしく (遅い依存関係、増大するバックログ)、既定では degraded な結果でも `200 OK` を返します。これは意図的です。キューが埋まっているというだけで、オーケストレーターにポッドを再起動してほしいとは通常思わないからです。省略可能な `data` ディクショナリはレポートに同乗して JSON のレスポンス本文に現れ、合否の判断を変えずにダッシュボードにとって便利です。

クラスを登録し、名前と、必要に応じて失敗ステータスとタグを与えます。

```csharp
// .NET 11, C# 14
builder.Services.AddHealthChecks()
    .AddCheck<QueueDepthHealthCheck>(
        "queue",
        failureStatus: HealthStatus.Unhealthy,
        tags: ["ready"]);
```

コンストラクターの依存関係 (`IMessageQueue`) は依存性注入から解決されるため、チェックは登録済みの任意のサービスを注入できます。コンテナーにないリテラルのコンストラクター引数を渡す必要がある場合は、代わりに `AddTypeActivatedCheck<T>(...)` を使い、`args` 配列を渡します。

クラスに値しない使い捨てのインラインチェックには、ラムダ形式で十分です。

```csharp
// .NET 11, C# 14
builder.Services.AddHealthChecks()
    .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"]);
```

## AddDbContextCheck でデータベースをプローブする

チームが readiness プローブに求める断トツで最も一般的なものは "データベースに到達できるか" です。そのために `IHealthCheck` を書く必要はありません。`Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore` パッケージを追加し、組み込みの `AddDbContextCheck<TContext>` を使います。

```csharp
// .NET 11, C# 14
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(
        builder.Configuration.GetConnectionString("DefaultConnection")));

builder.Services.AddHealthChecks()
    .AddDbContextCheck<AppDbContext>("database", tags: ["ready"]);
```

内部ではこれは `DbContext.Database.CanConnectAsync` を呼び出し、クエリを実行せずに接続を開いて閉じます。これは正しい既定です。安価であり、readiness プローブが気にかけるまさにその点、つまり接続文字列が解決され、サーバーが接続を受け入れることを検証します。もっと強力なものが必要なら、`AddDbContextCheck` にはカスタムのテストクエリを受け取るオーバーロードがありますが、一般的なケースでは `CanConnectAsync` が求めるものです。最初の使用前に EF Core を準備することのより深い配線については、[最初のクエリの前に EF Core のモデルをウォームアップする方法](/ja/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)を参照してください。`CanConnectAsync` を実行するチェックは、そのウォームアップがすでに済んでいるべき自然な場所です。

`AspNetCore.Diagnostics.HealthChecks` (Xabaril プロジェクト) 配下のコミュニティパッケージは、Redis、RabbitMQ、PostgreSQL、blob storage、その他数十の依存関係向けの既製のチェックを同じ `.Add...` パターンで提供するため、よく知られたサービス向けのプローブを手で書く必要はめったにありません。

## liveness と readiness の別々のエンドポイント

Kubernetes は 2 つのプローブを区別しており、それらを混同することが最も一般的な health check の誤りです。liveness プローブは "このプロセスは行き詰まっていて再起動が必要か" に答えます。それが失敗すると、Kubernetes はポッドを kill します。readiness プローブは "このインスタンスは今トラフィックを受け取る準備ができているか" に答えます。それが失敗すると、Kubernetes はそこへのルーティングを止めますが、稼働はさせたままにします。データベースが一時的に到達不能になったことでポッドの再起動が引き起こされてほしくはありません。再起動はデータベースを直せず、キャパシティを奪うだけだからです。したがってデータベースのチェックは liveness ではなく readiness に属します。

その仕組みはタグと `HealthCheckOptions` の `Predicate` です。チェックをタグ付きで登録し、それぞれが正しい集合にフィルタリングする 2 つのエンドポイントをマップします。

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Diagnostics.HealthChecks;

app.MapHealthChecks("/health/live", new HealthCheckOptions
{
    // Liveness: run no dependency checks. If the pipeline responds, we are alive.
    Predicate = _ => false
});

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    // Readiness: only the checks tagged "ready" (database, queue, downstreams).
    Predicate = check => check.Tags.Contains("ready")
});
```

`Predicate = _ => false` は "どのチェックも含めない" を意味するため、`/health/live` はリクエストがエンドポイントに到達した時点で `Healthy` にショートサーキットします。`/health/ready` は `ready` とタグ付けしたチェックだけを実行します。Kubernetes の `livenessProbe` を `/health/live` に、`readinessProbe` を `/health/ready` に向ければ、2 つの関心事はきれいに分離されたままになります。

## プレーンテキストの代わりに JSON を返す

既定のレスポンス本文は `Healthy`、`Degraded`、`Unhealthy` の 1 語です。プローブには十分ですが、readiness がなぜ失敗しているのかをデバッグする人間には役に立ちません。チェックごとの詳細を持つ JSON を出力するために `ResponseWriter` を提供します。

```csharp
// .NET 11, C# 14
using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Diagnostics.HealthChecks;

static Task WriteJsonResponse(HttpContext context, HealthReport report)
{
    context.Response.ContentType = "application/json; charset=utf-8";

    var payload = new
    {
        status = report.Status.ToString(),
        totalDurationMs = report.TotalDuration.TotalMilliseconds,
        checks = report.Entries.Select(e => new
        {
            name = e.Key,
            status = e.Value.Status.ToString(),
            description = e.Value.Description,
            durationMs = e.Value.Duration.TotalMilliseconds
        })
    };

    return context.Response.WriteAsync(JsonSerializer.Serialize(payload));
}

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResponseWriter = WriteJsonResponse
});
```

これで、失敗した readiness チェックは、チェック名、そのステータス、その説明、そして所要時間を名指しする本文を返すため、`Unhealthy` になったエントリが "database" であることが一目で分かります。`HealthReport` オブジェクトは `Status` (集約)、`TotalDuration`、そして登録したチェック名でキー付けされた `Entries` ディクショナリを公開します。ステータスコードは本文とは別に駆動される点に注意してください。`503` はこの JSON を問題なく運べます。

## ステータスコードを制御する

既定ではフレームワークは `Healthy` と `Degraded` を `200 OK` に、`Unhealthy` を `503 Service Unavailable` にマッピングします。そのマッピングはロードバランサーが期待するものなので、具体的な理由がある場合にのみ変更してください。変更する場合、`ResultStatusCodes` がそのダイヤルです。

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResultStatusCodes =
    {
        [HealthStatus.Healthy] = StatusCodes.Status200OK,
        [HealthStatus.Degraded] = StatusCodes.Status200OK,
        [HealthStatus.Unhealthy] = StatusCodes.Status503ServiceUnavailable
    }
});
```

身につける価値のある微妙な点が 1 つあります。`Degraded` は既定で `200` を返すため、ロードバランサーは degraded なインスタンスを健全とみなし、トラフィックを送り続けます。それは通常は正しいのですが、あなたの "degraded" の定義がローテーションから外したいほど深刻なものであれば、ここで `Degraded` を `503` にマッピングするか、チェックから `Degraded` の代わりに `Unhealthy` を返してください。意図を曖昧なままにしないでください。

もう 1 つ知っておく価値のある既定があります。health check のレスポンスは no-cache ヘッダーを設定するため、インスタンスが実際には失敗している間に、中間装置が古い `Healthy` を配信することはできません。もしキャッシュが必要になったら、オプションの `AllowCachingResponses = true` でそれを無効化しますが、プローブでそれを望むことはほとんどありません。

## エンドポイントをロックダウンする

詳細な JSON を返すヘルスエンドポイントは、小さな情報開示の面です。依存関係を名指しし、失敗の詳細を漏らしうるからです。それを制限するきれいな方法が 2 つあります。`RequireHost` はエンドポイントを特定のホストやポートに限定します。これは、公開ルーティングされない内部管理ポートでのみヘルスを公開するための標準的な手法です。

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready")
})
.RequireHost("*:8081");
```

`RequireAuthorization` はエンドポイントを認可ポリシーの背後に置き、それはあなたが構成した任意の認証と組み合わさります。すでに JWT bearer 認証を実行しているなら、それをヘルスエンドポイントに載せるのは 1 回の呼び出しです。

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready")
    .RequireAuthorization();
```

注意を 1 つ。オーケストレーターがポーリングするエンドポイントに認可を要求してはいけません。オーケストレーターはトークンを提示せず、プローブが失敗するからです。単純な liveness/readiness エンドポイントは開いたままにし (代わりにホストやネットワークで制限し)、詳細な JSON を出力するエンドポイントは、そもそも公開するなら認可の背後に置いてください。トークン側をセットアップする仕組みは、[ASP.NET Core 11 の Minimal API で JWT bearer 認証をセットアップする方法](/ja/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)で扱っています。

## ポーリングを待つ代わりに結果をプッシュする

これまでのすべては pull ベースで、何かがあなたのエンドポイントを呼び出します。フレームワークは `IHealthCheckPublisher` を通じた push ベースの報告もサポートします。これは登録されたチェックをタイマーで実行し、集約された `HealthReport` をあなたのコードに渡すため、それを監視システムに転送したり、メトリクスを出力したり、アラートをログに記録したりできます。

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Diagnostics.HealthChecks;

public sealed class LoggingHealthCheckPublisher : IHealthCheckPublisher
{
    private readonly ILogger<LoggingHealthCheckPublisher> _logger;

    public LoggingHealthCheckPublisher(ILogger<LoggingHealthCheckPublisher> logger)
        => _logger = logger;

    public Task PublishAsync(HealthReport report, CancellationToken cancellationToken)
    {
        if (report.Status != HealthStatus.Healthy)
        {
            _logger.LogWarning(
                "Health degraded: {Status} across {Count} checks.",
                report.Status, report.Entries.Count);
        }
        return Task.CompletedTask;
    }
}

builder.Services.AddSingleton<IHealthCheckPublisher, LoggingHealthCheckPublisher>();
builder.Services.Configure<HealthCheckPublisherOptions>(options =>
{
    options.Delay = TimeSpan.FromSeconds(5);   // Wait before the first run.
    options.Period = TimeSpan.FromSeconds(30); // Then run every 30 seconds.
    options.Predicate = check => check.Tags.Contains("ready");
});
```

publisher は、いずれかの `IHealthCheckPublisher` がコンテナーに入るとすぐにフレームワークが登録するホスト型のバックグラウンドサービス上で実行されるため、自前のタイマーを配線せずに周期的な実行が得られます。これはヘルスをメトリクスのパイプラインに供給する慣用的な場所です。すでにテレメトリをエクスポートしているなら、degraded なステータスがトレースの隣に現れるよう [.NET 11 の OpenTelemetry](/ja/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)と組み合わせてください。publisher は同じレポートのもう 1 つの消費者にすぎないため、すでに実行している任意の[バックグラウンドジョブの監視](/ja/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/)ともうまく調和します。

## MapHealthChecks と UseHealthChecks、そしてチェックが実行される場所

古いチュートリアルは `app.UseHealthChecks("/healthz")` を使います。これはパスが一致するとパイプラインをショートサーキットするミドルウェアです。`MapHealthChecks` はルーティングを意識した同等物であり、あらゆる現代の Minimal API で優先すべきものです。というのも、それはエンドポイントルーティングに参加し、それこそが `RequireAuthorization`、`RequireHost`、`RequireCors` を機能させるからです。これらのエンドポイント規約はミドルウェア形式では意味を持ちません。.NET 8 以降では、マップしたヘルスエンドポイントに `.ShortCircuit()` を連ねて、そのリクエストについて残りのミドルウェアパイプラインをスキップし、高頻度のプローブでわずかなオーバーヘッドを削ることもできます。

運用上の注意を 1 つ。チェックはエンドポイントに到達したリクエストの内部で実行され、そのリクエスト向けに解決された scoped サービスを使います。チェックが `DbContext` のような scoped 依存関係を必要とする場合、エンドポイントはリクエストスコープで実行されるため、その解決は問題なく機能します。これは、寿命の長いシングルトンから scoped サービスを取り出そうとする人を噛む、まさに同じスコープの問題であり、[BackgroundService の内部で scoped サービスを使う方法](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)が解決のために存在するその罠です。health check はすでにリクエストスコープを持っているため、決してそれに触れません。

## 覚えておくべき形

health check エンドポイントは、サービスを登録する `AddHealthChecks()`、プローブする価値のある依存関係ごとの `.AddCheck<T>(...)` (または `.AddDbContextCheck<T>()`、あるいはラムダ)、そしてそれを公開する `MapHealthChecks("/path")` に尽きます。各チェックから `Healthy`、`Degraded`、`Unhealthy` を返し、`Unhealthy` は `503` である一方、他の 2 つは既定で `200` であることを覚えておいてください。不安定なデータベースが健全なポッドを決して再起動しないよう、タグと `Predicate` で liveness と readiness を分離し、人間が結果を読む必要があるときは `ResponseWriter` を追加し、プローブのパスへの認可ではなく `RequireHost` でエンドポイントを保護し、pull ではなく push が欲しいときは `IHealthCheckPublisher` に手を伸ばしてください。これが完全な面であり、上記のすべての行は .NET 8 から .NET 11 まで変更なしで動作します。

## 関連

- [ASP.NET Core 11 の BackgroundService の内部で scoped サービスを使う方法](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)
- [ASP.NET Core 11 で MapGroup を使って Minimal API エンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [ASP.NET Core 11 の Minimal API で JWT bearer 認証をセットアップする方法](/ja/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)
- [.NET 11 と無料のバックエンドで OpenTelemetry を使う方法](/ja/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [最初のクエリの前に EF Core のモデルをウォームアップする方法](/ja/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)

## 参考文献

- [Health checks in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/health-checks)
- [IHealthCheck interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.diagnostics.healthchecks.ihealthcheck)
- [HealthCheckOptions (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.diagnostics.healthchecks.healthcheckoptions)
- [AddDbContextCheck extension (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkcorehealthchecksbuilderextensions.adddbcontextcheck)
- [AspNetCore.Diagnostics.HealthChecks (Xabaril, GitHub)](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks)
