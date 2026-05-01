---
title: ".NET 11 で Serilog と Seq による構造化ログを設定する方法"
description: ".NET 11 の ASP.NET Core アプリに Serilog 4.x と Seq 2025.2 を組み込むための完全ガイド。AddSerilog と UseSerilog の違い、二段階ブートストラップロギング、JSON 設定、エンリッチャー、リクエストロギング、OpenTelemetry トレース相関、API キー、そしてバッファリング、保持期間、シグナルレベルにまつわる本番環境での落とし穴を解説します。"
pubDate: 2026-05-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "logging"
  - "serilog"
  - "seq"
lang: "ja"
translationOf: "2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-01
---

.NET 11 の ASP.NET Core アプリから Seq に構造化ログを送るには、`Serilog.AspNetCore` 10.0.0 と `Serilog.Sinks.Seq` 9.0.0 をインストールし、`services.AddSerilog((sp, lc) => lc.ReadFrom.Configuration(...).WriteTo.Seq("http://localhost:5341"))` でパイプラインを登録し、`app.UseSerilogRequestLogging()` でホストのリクエストロガーを有効化します。すべての設定は `appsettings.json` から行うことで、本番環境では再デプロイなしで最小レベルを変更できます。Seq はローカルで `datalust/seq` Docker イメージとして `ACCEPT_EULA=Y` とポートマッピング付きで実行し、シンクを `http://localhost:5341` に向けます。このガイドは .NET 11 preview 3 と C# 14 をベースに書かれていますが、すべてのスニペットは .NET 8、9、10 でも動作します。

## なぜ "ただの `ILogger`" ではなく Serilog と Seq なのか

`Microsoft.Extensions.Logging` は hello-world のデモやユニットテストには問題ありません。しかし本番環境には不十分です。`ILogger<T>.LogInformation("Order {OrderId} for {CustomerId} took {Elapsed} ms", id, customer, ms)` は呼び出し側では構造化されていますが、デフォルトのコンソールプロバイダーはこれらのプロパティを単一の文字列にフラット化し、構造を捨ててしまいます。本番環境で何かが起きた瞬間、tarball を grep する作業に逆戻りします。

Serilog は構造を保ちます。各呼び出しは名前付きプレースホルダーを JSON プロパティとしてシリアライズし、設定したシンクに転送します。Seq は受信側です。セルフホストのログサーバーで、これらのプロパティをインデックス化するため、`select count(*) from stream where StatusCode >= 500 and Endpoint = '/api/orders' group by time(1m)` といったクエリを書いてミリ秒単位で答えを得られます。この組み合わせが .NET 界隈で 10 年来のデフォルト選択肢である理由は、両者とも実際にこれを使う人々によって書かれているからです。

2026 年に覚えておく価値のあるバージョン番号は Serilog 4.3.1、Serilog.AspNetCore 10.0.0、Serilog.Sinks.Seq 9.0.0、Seq 2025.2 です。メジャーバージョンは Microsoft.Extensions.Logging に追従しているため、.NET 11 では Microsoft が新しいメジャーを切るまで `Serilog.AspNetCore` の 10.x 系列と `Serilog.Sinks.Seq` の 9.x 系列を使い続けます。

## Seq を 30 秒でローカル実行する

コードを書く前に、Seq インスタンスを起動しておきましょう。Docker のワンライナーは、CI を含めほとんどのチームが使う方法です。

```bash
# Seq 2025.2, default ports
docker run \
  --name seq \
  -d \
  --restart unless-stopped \
  -e ACCEPT_EULA=Y \
  -p 5341:80 \
  -p 5342:443 \
  -v seq-data:/data \
  datalust/seq:2025.2
```

`5341` は HTTP のインジェスチョンと UI のポート、`5342` は HTTPS です。`seq-data` の名前付きボリュームでコンテナの再起動をまたいでイベントを保持します。Windows では datalust.co の MSI インストーラーが代替手段で、同じエンジンと同じデフォルトポートを提供します。無料枠はシングルユーザーなら無制限で、認証付きアカウントを追加するとチームライセンスが必要になります。ブラウザで `http://localhost:5341` を開き、"Settings"、"API Keys" をクリックしてキーを作成します。これは取り込み認証と、後で組む読み取り専用ダッシュボードの両方で使います。

## パッケージをインストールする

ハッピーパスには 3 つのパッケージで十分です。

```bash
dotnet add package Serilog.AspNetCore --version 10.0.0
dotnet add package Serilog.Sinks.Seq --version 9.0.0
dotnet add package Serilog.Settings.Configuration --version 9.0.0
```

`Serilog.AspNetCore` は `Serilog`、`Serilog.Extensions.Hosting`、コンソールシンクを引き込みます。`Serilog.Sinks.Seq` は Seq の取り込みエンドポイントにイベントをバッチ送信する HTTP シンクです。`Serilog.Settings.Configuration` はパイプライン全体を `appsettings.json` に記述できるようにする橋渡しで、これは本番環境で実際に運用したい形です。

## 最小限の Program.cs

.NET 11 の minimal API における最小の動作する配線を示します。Serilog.AspNetCore 8.0.0 で廃止された `IWebHostBuilder.UseSerilog()` 拡張が削除されて以降、唯一サポートされる入口となった `AddSerilog` API を使っています。

```csharp
// .NET 11 preview 3, C# 14
// Serilog 4.3.1, Serilog.AspNetCore 10.0.0, Serilog.Sinks.Seq 9.0.0
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSerilog((services, lc) => lc
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services)
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .WriteTo.Seq("http://localhost:5341"));

var app = builder.Build();

app.UseSerilogRequestLogging();

app.MapGet("/api/orders/{id:int}", (int id, ILogger<Program> log) =>
{
    log.LogInformation("Fetching order {OrderId}", id);
    return Results.Ok(new { id, total = 99.95m });
});

app.Run();
```

5 行が実際の仕事をしています。`ReadFrom.Configuration` は `appsettings.json` から最小レベルとオーバーライドを読み込みます。`ReadFrom.Services` はシンクがスコープ付き依存関係を解決できるようにし、これはカスタムエンリッチャーを書き始めると重要になります。`Enrich.FromLogContext` は、ミドルウェアで `using (LogContext.PushProperty("CorrelationId", id))` ブロックを push できるようにし、そのスコープ内のすべてのログ行に自動でタグを付けます。`WriteTo.Console` はローカル開発体験を高速に保ちます。`WriteTo.Seq` が実際のシンクです。

`UseSerilogRequestLogging` はデフォルトの ASP.NET Core リクエストロギングミドルウェアを、リクエストごとに 1 つの構造化イベントを出すものに置き換えます。リクエストごとに 3〜4 行ではなく、`RequestPath`、`StatusCode`、`Elapsed`、そして `EnrichDiagnosticContext` コールバック経由で push したプロパティを含む 1 行が得られます。ノイズが減り、シグナルが増えます。

## 設定を appsettings.json に移す

`http://localhost:5341` のハードコードはデモには問題ありませんが、本番環境では誤りです。再デプロイなしで詳細度を変更できるよう、パイプライン記述全体を `appsettings.json` に移します。

```json
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Sinks.Seq" ],
    "MinimumLevel": {
      "Default": "Information",
      "Override": {
        "Microsoft.AspNetCore": "Warning",
        "Microsoft.EntityFrameworkCore.Database.Command": "Warning",
        "System.Net.Http.HttpClient": "Warning"
      }
    },
    "Enrich": [ "FromLogContext", "WithMachineName", "WithThreadId" ],
    "WriteTo": [
      { "Name": "Console" },
      {
        "Name": "Seq",
        "Args": {
          "serverUrl": "http://localhost:5341",
          "apiKey": "REPLACE_WITH_API_KEY"
        }
      }
    ],
    "Properties": {
      "Application": "Orders.Api"
    }
  }
}
```

押さえておきたい細部がいくつかあります。`Using` 配列は `Serilog.Settings.Configuration` 9.x がシンクアセンブリをロードするのに使うもので、これがないと JSON パーサーは `WriteTo.Seq` がどのアセンブリに含まれているかを知りません。`Override` マップは Serilog で最も過小評価されている機能です。グローバルレベルを `Information` に保ちつつ、EF Core のコマンドロガーを `Warning` に固定することで、忙しいサーバーで SQL に溺れずに済みます。`WithMachineName` と `WithThreadId` は `Serilog.Enrichers.Environment` と `Serilog.Enrichers.Thread` をインストールした場合のみ追加してください。そうでなければ削除しないと、起動時に静かな "method not found" エラーで設定が失敗します。

`Application` プロパティは、1 つの Seq インスタンスを多くのサービスで使うための鍵です。各アプリの名前を `Properties` 経由で push すれば、Seq UI で `Application = 'Orders.Api'` という無料のフィルターが手に入ります。

## ブートストラップロギング: ロギングが始まる前のクラッシュを捕まえる

設定ベースのロギングには 1 つ弱点があります。`appsettings.json` が壊れていると、設定済みのシンクが生きる前にホストが爆発し、何も得られません。公式パターン、そして `Serilog.AspNetCore` がドキュメント化しているのは二段階のブートストラップです。ホストがビルドされる前に最小限のロガーをインストールし、設定がロードされたらそれを置き換えます。

```csharp
// .NET 11 preview 3, C# 14
using Serilog;

Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .WriteTo.Console()
    .WriteTo.Seq("http://localhost:5341")
    .CreateBootstrapLogger();

try
{
    var builder = WebApplication.CreateBuilder(args);

    builder.Services.AddSerilog((services, lc) => lc
        .ReadFrom.Configuration(builder.Configuration)
        .ReadFrom.Services(services)
        .Enrich.FromLogContext()
        .WriteTo.Console()
        .WriteTo.Seq("http://localhost:5341"));

    var app = builder.Build();

    app.UseSerilogRequestLogging();
    app.MapGet("/", () => "ok");

    app.Run();
}
catch (Exception ex) when (ex is not HostAbortedException)
{
    Log.Fatal(ex, "Host terminated unexpectedly");
    throw;
}
finally
{
    Log.CloseAndFlush();
}
```

`CreateBootstrapLogger` は今すぐ使えて後で置き換え可能なロガーを返すため、`AddSerilog` が実装をすげ替えた後も同じ `Log.Logger` 静的が機能し続けます。`finally` ブロックの `Log.CloseAndFlush()` は、`Serilog.Sinks.Seq` のメモリ内バッチがプロセス終了前に確実に排出されるようにします。これを省くとクリーンシャットダウン時に最後の数秒分のログを失い、まさに興味深いイベントがある時間帯です。

## 実用的なリクエストロギング

`UseSerilogRequestLogging` はリクエストごとに 1 つのイベントを書き出します。2xx と 3xx は `Information`、4xx は `Warning`、5xx は `Error` です。デフォルトは妥当です。本番品質にするには、メッセージテンプレートを上書きし、各イベントをユーザー識別子とトレース id でエンリッチします。

```csharp
// .NET 11 preview 3, C# 14
app.UseSerilogRequestLogging(options =>
{
    options.MessageTemplate =
        "HTTP {RequestMethod} {RequestPath} responded {StatusCode} in {Elapsed:0} ms";

    options.EnrichDiagnosticContext = (diagnosticContext, httpContext) =>
    {
        diagnosticContext.Set("UserId", httpContext.User?.FindFirst("sub")?.Value);
        diagnosticContext.Set("ClientIp", httpContext.Connection.RemoteIpAddress?.ToString());
        diagnosticContext.Set("TraceId", System.Diagnostics.Activity.Current?.TraceId.ToString());
    };
});
```

`TraceId` の行は、追加できるエンリッチャーの中で最も価値の高いものです。Serilog 3.1 で実装されたトレース id 収集と組み合わせれば、リクエスト内でコードが書くすべてのログイベントが、リクエスト自体と同じ `TraceId` を保持します。Seq では任意のイベントをクリックして "show all events with this TraceId" にピボットでき、1 つのクエリで完全な呼び出し連鎖が手に入ります。

## OpenTelemetry トレース相関を組み込む

OpenTelemetry 経由でトレースもエクスポートしている場合、別のロギングエクスポーターを追加してはいけません。Serilog はすでに `Activity.Current` を理解しており、存在すれば `TraceId` と `SpanId` を自動で書き出します。ASP.NET Core 11 のネイティブ OpenTelemetry トレーシングは、トレースが受信リクエストで開始され、`HttpClient`、EF Core、その他の計測済みライブラリを通じて伝播することを意味します。Serilog は同じ `Activity` コンテキストを拾うため、すべてのログイベントはロギング側で追加の配線なしにトレースと相関付けされます。トレース側の設定については [.NET 11 のネイティブ OpenTelemetry トレーシングパイプライン](/ja/2026/04/aspnetcore-11-native-opentelemetry-tracing/) を参照してください。

これらのトレースを別のバックエンドではなく Seq に送るには、`Serilog.Sinks.Seq` に加えて Seq 2025.2 に同梱される OTLP サポートをインストールし、OpenTelemetry エクスポーターを `http://localhost:5341/ingest/otlp/v1/traces` に向けます。Seq はトレースとログを `TraceId` で結合した同じ UI に表示します。

## レベル、サンプリング、そして "意味なくページングされている"

忙しい API のデフォルト `Information` レベルは、毎秒数百のイベントを生成します。ボリュームを制御するつまみは 2 つあります。

1 つ目は前述の `MinimumLevel.Override` マップです。ノイジーなフレームワークログを `Warning` に押し上げることで、自分のアプリケーションログを失わずに放水ホースを 1 桁減らせます。`UseSerilogRequestLogging` を有効にしたら必ず `Microsoft.AspNetCore` を `Warning` にオーバーライドしてください。そうしないとリクエストごとの行が二重に出ます。フレームワークから 1 回、Serilog から 1 回です。

2 つ目はサンプリングです。Serilog には組み込みのサンプラーがありませんが、Seq シンクを `Filter.ByExcluding` 述語でラップしてプロセスを離れる前に低価値イベントを落とすことができます。

```csharp
// .NET 11, C# 14: drop /health probe noise
.Filter.ByExcluding(le =>
    le.Properties.TryGetValue("RequestPath", out var p) &&
    p is ScalarValue { Value: string path } &&
    path.StartsWith("/health", StringComparison.OrdinalIgnoreCase))
```

大量トラフィックの場合、より良い答えはリクエストログには `Information` を保ち、それ以外をすべて `Warning` に上げて、実際にアラートを出したい小さな部分は Seq の "signal" 機能でマークすることです。

## 本番環境の落とし穴

Serilog と Seq を初めて出荷するチームが必ずぶつかる問題がいくつかあります。

**シンクのバッチングが障害を隠す。** `Serilog.Sinks.Seq` は最大 2 秒または 1000 イベントまでイベントをバッファリングしてからフラッシュします。Seq に到達できない場合、シンクは指数バックオフで再試行しますが、バッファは有限です。Seq の障害が長引くと、静かにイベントを取りこぼします。本番デプロイでは `bufferBaseFilename` を設定して、シンクがまずディスクに溢れさせ、Seq が戻ったら再生するようにすべきです。

```json
{
  "Name": "Seq",
  "Args": {
    "serverUrl": "https://seq.internal",
    "apiKey": "...",
    "bufferBaseFilename": "/var/log/myapp/seq-buffer"
  }
}
```

**Seq シンクへの同期呼び出しはタダではない。** シンクは非同期ですが、`LogInformation` の呼び出しはメッセージテンプレートのレンダリングとチャネルへの push を呼び出し側のスレッドで行います。ホットパスではプロファイルに表れます。`Async` ([`Serilog.Sinks.Async`](https://github.com/serilog/serilog-sinks-async)) を使って Seq シンクを専用のバックグラウンドスレッドでラップすれば、リクエストスレッドは即座に戻ります。

**`appsettings.json` の API キーは漏洩予備軍。** 開発ではユーザーシークレット、本番ではシークレットストア (Key Vault、AWS Secrets Manager) に移しましょう。Serilog はホストが登録した任意の設定プロバイダーを読むため、変えるのは値の出所だけです。

**Seq の保持期間は無限ではない。** デフォルトの `seq-data` Docker ボリュームはディスクが埋まるまで成長し続け、Seq は取り込みを落とし始めます。Seq の UI で "Settings"、"Data" の下に保持ポリシーを設定してください。よくある出発点は `Information` を 30 日、`Warning` 以上を 90 日です。

**`UseSerilogRequestLogging` は `UseEndpoints` の前、`UseRouting` の後に置く必要がある。** これより前に置くとマッチしたエンドポイントを見られず、`RequestPath` がルートテンプレートではなく生の URL を含むため、Seq ダッシュボードの有用性が大きく下がります。

## このスタックでの位置付け

Serilog と Seq は、3 本足のオブザーバビリティスタックの 1 本目、ログの足です。ログ (Serilog/Seq)、トレース (OpenTelemetry)、例外 ([グローバル例外ハンドラー](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)) です。本番 API で何かが起きたら、Seq から始めて、失敗したリクエストを見つけ、`TraceId` をコピーし、トレースビューまたはスローしたソースコードのいずれかにピボットします。この往復こそが要点です。これが 1 分以内にできないなら、ロギングは元を取れていません。

ランタイムエラーではなく特定のスローダウンを追跡している場合は、代わりに [`dotnet-trace` プロファイリングループ](/ja/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) でフォローアップしてください。Seq は "何が起きたか" には優れ、`dotnet-trace` は "なぜ遅いか" に適切なツールです。そして答えが "リクエストごとにシリアライズしすぎ" になった場合は、[カスタム JsonConverter ガイド](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) が System.Text.Json 側をカバーします。

ソースリンク:

- [Serilog.AspNetCore release notes](https://github.com/serilog/serilog-aspnetcore/releases)
- [Serilog.Sinks.Seq on NuGet](https://www.nuget.org/packages/Serilog.Sinks.Seq/)
- [Seq documentation](https://docs.datalust.co/docs)
- [Datalust seq-extensions-logging](https://github.com/datalust/seq-extensions-logging)
