---
title: ".NET 11 で Serilog から OpenTelemetry ロギングへ移行する"
description: ".NET 11 アプリを Serilog から OpenTelemetry ロギングへ移行するためのステップバイステップガイド。低リスクな Serilog.Sinks.OpenTelemetry ブリッジ、Microsoft.Extensions.Logging への全面的な切り替え、何が壊れるか、検証方法、ロールバックの方法を解説します。"
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "serilog"
  - "opentelemetry"
  - "dotnet-11"
  - "logging"
  - "observability"
lang: "ja"
translationOf: "2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-05
---

チームがトレースとメトリクスについて OpenTelemetry に標準化している場合、仲間外れになりがちなのはたいていロギングで、いまだに Serilog とファイルまたは Seq シンクを通っているものです。このガイドでは、.NET 11 アプリ (OpenTelemetry .NET SDK 1.15.x、Serilog 4.x) をその分断された構成から外し、OpenTelemetry ロギングへ移行します。ルートは 2 つあります。Serilog を残してシンクだけを差し替える一晩で済むブリッジと、Serilog を完全に取り除く `Microsoft.Extensions.Logging` への全面的な切り替えです。ブリッジは 1 コミットで元に戻せ、ほとんど何も壊しません。全面的な移行は実際のコードベースでは 1 日か 2 日かかり、すべての `BeginScope` とメッセージテンプレートに手を入れることになります。これに価値があるのは、Serilog 依存の除去と 1 つのロギング API への統一が、あったら嬉しい程度ではなく実際の目標である場合だけです。

## そもそもなぜロギングを OpenTelemetry へ移すのか

- **3 つのシグナルに 1 つのパイプライン。** トレース、メトリクス、ログは同じ OTLP エクスポーターを通ってプロセスから出ていき、同じバックエンドに届き、`TraceId` と `SpanId` で相関付けられます。トレースバックエンドとは別に運用する Seq エンドポイントは不要です。
- **ベンダー中立なワイヤーフォーマット。** OTLP は安定したプロトコルです。エンドポイントを 1 つ変えるだけで、同じアプリをローカルの Aspire Dashboard、セルフホストの Jaeger や SigNoz、または商用バックエンドへ向けられます。シンクパッケージを差し替える必要はありません。
- **自動的なトレース相関。** アクティブな `Activity` 内で出力されたログは、エンリッチャーなしでトレース ID とスパン ID を持つため、「このリクエストに関するすべてのログ行を見せて」がサービスをまたいで機能します。
- **CI と本番で動く部品が減る。** Serilog のブートストラップとシンク構成を取り除くと、シンクのバッファリングやシャットダウン時フラッシュのバグに起因する「ログが静かに止まった」という類のインシデントがなくなります。

まだ OpenTelemetry のトレースを組み込んでいない場合は、まずそれを行ってください。[.NET 11 と無料バックエンドで OpenTelemetry を使う](/ja/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) では、このガイドが既に整っていることを前提としているエクスポーターとバックエンドのセットアップを解説しています。

## 何が壊れるか

| 領域 | 変更 | 深刻度 |
| --- | --- | --- |
| シンク構成 | ファイル/コンソール/Seq シンクが OTLP エクスポーターまたは `Serilog.Sinks.OpenTelemetry` に置き換わる | high (full) / low (bridge) |
| `Log.Logger` static + `CreateBootstrapLogger()` | 全面移行で削除される。2 段階の起動時ロギングがなくなる | high (full only) |
| `LogContext.PushProperty` エンリッチャー | `ILogger.BeginScope` と `IncludeScopes = true` に置き換わる | medium (full only) |
| デストラクチャリング演算子 `{@Order}` | `Microsoft.Extensions.Logging` に同等物はない。スカラーフィールドをログ出力するか、明示的にシリアライズする | medium (full only) |
| `UseSerilogRequestLogging()` | ASP.NET Core OTel インストルメンテーションまたは `AddHttpLogging` に置き換わる | medium (full only) |
| `MinimumLevel` 設定ブロック | `appsettings.json` の `Logging:LogLevel` セクションへ移動する | low (full only) |
| 重大度の名前 | Serilog の `Verbose` は OTel の `Trace` に対応する。`Information` はそのまま | low |

「ブリッジ」の列が重要です。ルート A を取るなら、最初の行だけが該当し、深刻度は low です。それ以外はすべて全面移行に関わる問題です。

## 事前チェックリスト

- **.NET 11 SDK がインストール済み。** `dotnet --version` で確認します (`11.0.x` を期待)。
- **OpenTelemetry のトレースが既に OTLP 経由でエクスポートされている。** このガイドはそのエクスポーターとリソースを再利用します。
- **OTLP ログを取り込むバックエンド。** Aspire Dashboard、SigNoz、Seq はいずれも OTLP/HTTP を受け付けます。Seq は `/ingest/otlp/v1/logs` で OTLP 取り込みエンドポイントを公開しているため、Serilog の Seq シンクを外したあとも Seq を送信先として残せます。
- **グリーンなテストスイートとクリーンな作業ツリー** を開始前に用意し、`git diff` に移行の変更だけが表示されるようにします。
- **OTLP のエンドポイントとプロトコルを把握しておく。** デフォルトの gRPC は `http://localhost:4317`、デフォルトの HTTP/protobuf は `http://localhost:4318` です。HTTP エクスポーターはベースエンドポイントに `/v1/logs` を付加します。

## 移行手順

### 1. パッケージのバージョンを固定する

ルートを決め、それに合うパッケージをインストールします。どちらのルートも同じ SDK ラインを対象にします。

```xml
<!-- .NET 11, both routes -->
<!-- Route A (bridge): keep Serilog, swap the sink -->
<PackageReference Include="Serilog.AspNetCore" Version="9.0.0" />
<PackageReference Include="Serilog.Sinks.OpenTelemetry" Version="4.2.0" />

<!-- Route B (full): Microsoft.Extensions.Logging + OpenTelemetry -->
<PackageReference Include="OpenTelemetry.Extensions.Hosting" Version="1.15.3" />
<PackageReference Include="OpenTelemetry.Exporter.OpenTelemetryProtocol" Version="1.15.3" />
```

検証: コードを変更する前に `dotnet restore` が成功し、`dotnet build` がクリーンであることを確認します。

### 2a. ルート A -- Serilog のシンクを OTLP に差し替える

これは低リスクな道です。既存のエンリッチャー、メッセージテンプレート、`LogContext` 呼び出しはすべて残します。シンク構成だけを置き換えます。

```csharp
// .NET 11, C# 14, Serilog 4.x, Serilog.Sinks.OpenTelemetry 4.2.0
using Serilog;
using Serilog.Sinks.OpenTelemetry;

Log.Logger = new LoggerConfiguration()
    .Enrich.FromLogContext()
    .WriteTo.OpenTelemetry(options =>
    {
        options.Endpoint = "http://localhost:4318/v1/logs";
        options.Protocol = OtlpProtocol.HttpProtobuf;
        options.ResourceAttributes = new Dictionary<string, object>
        {
            ["service.name"] = "orders-api",
            ["service.version"] = "2.4.0"
        };
    })
    .CreateLogger();
```

シンクは `Activity.Current` を読み取り、すべてのログレコードに `TraceId` と `SpanId` を自動的に注入します (`IncludedData.TraceIdField` と `SpanIdField` はデフォルトでオン)。そのため、追加のエンリッチャーなしでシグナルをまたいだ相関が機能します。`_logger.LogInformation("Placed order {OrderId}", id)` のテンプレートはそのまま流れていきます。

検証: アプリを起動し、リクエストを 1 つ投げ、そのログ行がリクエストのトレースと同じ `TraceId` で OTLP バックエンドに表示されることを確認します。

### 2b. ルート B -- Microsoft.Extensions.Logging へ切り替える

`Program.cs` から `UseSerilog()` / `AddSerilog()` と `Log.Logger` のブートストラップを取り除きます。代わりに OpenTelemetry を組み込みのロギングビルダーに組み込みます。

```csharp
// .NET 11, C# 14, OpenTelemetry .NET SDK 1.15.3
using OpenTelemetry.Logs;
using OpenTelemetry.Resources;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.AddOpenTelemetry(options =>
{
    options.IncludeScopes = true;            // keep BeginScope properties
    options.IncludeFormattedMessage = true;  // populate the log body
    options.ParseStateValues = true;         // capture structured attributes
    options.SetResourceBuilder(
        ResourceBuilder.CreateDefault()
            .AddService("orders-api", serviceVersion: "2.4.0"));
    options.AddOtlpExporter(o =>
    {
        o.Endpoint = new Uri("http://localhost:4318");
    });
});

var app = builder.Build();
```

アプリが既にトレースとメトリクスのために `builder.Services.AddOpenTelemetry()` を呼び出している場合は、3 つのシグナルすべてが 1 つのリソースとエクスポーターを共有するよう、統一された形式を優先します。

```csharp
// .NET 11, OpenTelemetry .NET SDK 1.15.3
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("orders-api", serviceVersion: "2.4.0"))
    .WithTracing(t => t.AddAspNetCoreInstrumentation())
    .WithMetrics(m => m.AddAspNetCoreInstrumentation())
    .UseOtlpExporter(); // one call: configures OTLP for traces, metrics, AND logs

// Logs still need the provider on the logging builder:
builder.Logging.AddOpenTelemetry(o =>
{
    o.IncludeScopes = true;
    o.IncludeFormattedMessage = true;
    o.ParseStateValues = true;
});
```

`UseOtlpExporter()` (SDK 1.8 で追加) は、すべてのシグナルに対して OTLP エクスポーターを一度に登録するため、エンドポイントを 3 回繰り返す必要はありません。

検証: `dotnet run` を実行し、`ILogger` の行が正しい `service.name` と内容の入った本文とともにバックエンドに届くことを確認します。

### 3. エンリッチャーをスコープに変換する (ルート B のみ)

Serilog の `LogContext.PushProperty("UserId", id)` には `Microsoft.Extensions.Logging` に同等物がありません。`ILogger.BeginScope` を使えば、`IncludeScopes = true` を設定しているため、プロパティが OTLP レコードに流れ込みます。

```csharp
// Before (Serilog)
using (LogContext.PushProperty("UserId", userId))
{
    _logger.LogInformation("Loaded cart");
}

// After (.NET 11, Microsoft.Extensions.Logging)
using (_logger.BeginScope(new Dictionary<string, object> { ["UserId"] = userId }))
{
    _logger.LogInformation("Loaded cart");
}
```

検証: 出力されたログレコードが `UserId` を属性として持つことを確認します。欠けている場合は `IncludeScopes = true` を忘れています。

### 4. リクエストロギングを置き換える (ルート B のみ)

`app.UseSerilogRequestLogging()` はリクエストごとに 1 行の要約ログを生成していました。OpenTelemetry では、ASP.NET Core インストルメンテーションが既にリクエストごとに HTTP サーバースパンを出力しており、これが「このリクエストで何が起きたか」を表すより良いプリミティブです。それでもログ行が欲しい場合は、HTTP ロギングを追加します。

```csharp
// .NET 11
builder.Services.AddHttpLogging(o => { });
// ...
app.UseHttpLogging();
```

検証: 各リクエストが `TraceId` で相関付けられた HTTP サーバースパン (とオプションの HTTP ログエントリ) を生成することを確認します。

### 5. レベル設定を appsettings に移す

Serilog の `MinimumLevel` ブロックは標準の `Logging:LogLevel` セクションに置き換わり、OpenTelemetry プロバイダーは他と同様にこれを尊重します。

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    }
  }
}
```

検証: カテゴリを `Warning` に設定し、その `Information` の行がバックエンドに表示されなくなることを確認します。

## 検証チェックリスト

どちらのルートのあとでも、古いパッケージを削除する前にこれを実行します。

- `dotnet build` がクリーンで、予期しない `Serilog` の警告がない。
- `dotnet test` が 0 件の失敗で通る。
- リクエストが、空でない本文を持つログレコードをバックエンドに生成する (`IncludeFormattedMessage` が機能している)。
- それらのレコードがリクエストの `TraceId` を共有する (相関が機能している)。
- 構造化されたプロパティ (`OrderId`、スコープの値) が、メッセージ文字列に焼き込まれるのではなく属性として現れる (`ParseStateValues` と `IncludeScopes` が機能している)。
- バックエンドのログ量が想定どおりで、レベルフィルターが静かに削っていたり氾濫させていたりしない。
- シャットダウン時にフラッシュされる。リクエストの途中でアプリを停止し、最後の行がまだ届くことを確認する (バッチプロセッサーは破棄時にフラッシュする)。

## ロールバックプラン

**ルート A は 1 コミットで元に戻せます。** `WriteTo.OpenTelemetry(...)` ブロックを元の `WriteTo.Seq(...)` / `WriteTo.File(...)` 構成に戻し、`Serilog.Sinks.OpenTelemetry` パッケージを削除します。それ以外は何も変えていないので、リスク面はありません。

**ルート B は元に戻せますが簡単ではありません。** 新しいパイプラインが本番で 1 リリースサイクル稼働するまで、Serilog パッケージはインストールしたまま、古い `Program.cs` のブートストラップは git 履歴に残しておきます。差し戻す必要があれば、`UseSerilog()`、`Log.Logger` のブートストラップを復元し、`BeginScope` の呼び出しを `LogContext.PushProperty` に戻します。切り替えはコードベース全体のスコープとリクエストロギングに手を入れるため、差し戻しは 1 行のトグルではなく、それ自体を小さな移行として扱ってください。本番で検証が通るまで、`.csproj` から Serilog パッケージを削除しないでください。

## 私たちがはまった落とし穴

**バックエンドでログ本文が空になる。** `IncludeFormattedMessage` がデフォルトの `false` のままだと、OTLP レコードは構造化された属性を伴って送られますがレンダリングされたメッセージは含まれず、一部のバックエンドでは空行が表示されます。これをオンにしてください。あわせて `ParseStateValues = true` も設定し、名前付きプレースホルダー (`{OrderId}`) がフォーマット済み文字列の中だけでなく属性としても届くようにします。

**スコーププロパティが消える。** `IncludeScopes` はデフォルトで `false` です。すべての `BeginScope` の値や、ASP.NET Core がリクエストスコープに入れたものは、これを有効にするまで破棄されます。これは「移行でログコンテキストの半分を失った」という報告の中で最もよくあるものです。

**`{@Object}` デストラクチャリングがない。** Serilog の `_logger.LogInformation("Got {@Order}", order)` はオブジェクト全体をシリアライズしていました。`Microsoft.Extensions.Logging` は `@` をリテラルテキストとして扱います。実際にクエリするスカラーフィールドをログ出力するか、`System.Text.Json` で明示的にシリアライズしてください。オブジェクト全体をダンプすると属性のカーディナリティも爆発し、一部のバックエンドはそれに課金します。

**2 段階のブートストラップロギングを失う。** Serilog の `CreateBootstrapLogger()` は、ホストがビルドされる前に起きる障害を捕捉していました。OpenTelemetry プロバイダーは `builder.Build()` のあとにしか存在しないため、ごく初期の起動時例外はコンソールにしか出力されません。起動初期の可観測性が重要なら、その期間用に最小限のコンソールロガーを残してください。

**重大度マッピングの意外な点。** Serilog の `Verbose` は OTel の `Trace` になり、`Fatal` は `Critical` になります。重大度の名前で下流のフィルタリングやアラートを行っている場合は、それらのルールを更新してください。`Debug`、`Information`、`Warning`、`Error` は 1 対 1 で対応します。

どのみちロギングを整えるなら、そもそも構造化データをどう出力するかを見直す価値があります。[.NET 11 で Serilog と Seq による構造化ロギングをセットアップする](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) では、`ILogger` にきれいに引き継げるメッセージテンプレートのパターンを解説しており、[ASP.NET Core 11 のネイティブ OpenTelemetry トレーシング](/ja/2026/04/aspnetcore-11-native-opentelemetry-tracing/) では、統一されたパイプラインに移れば追加のインストルメンテーションパッケージが不要になる理由を説明しています。バックグラウンドジョブやホストされるサービスについては、[Hangfire なしでバックグラウンドジョブを監視する](/ja/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) がリクエストパスの外でも同じ相関が機能することを示しており、[Aspire 13.2.4 OpenTelemetry baggage アドバイザリ](/ja/2026/04/aspire-13-2-4-opentelemetry-cve-2026-40894-baggage-dos/) は OTel パッケージにパッチを当て続けることを思い出させてくれます。

Serilog の除去が本当の目標でない限り、ブリッジを選んでください。それは今夜にも OTLP ログとトレース相関をもたらしてくれますし、スコープとリクエストロギングをきちんと変換する静かなスプリントが取れたときに、後から全面的な切り替えを行えます。

## ソース

- [OpenTelemetry .NET logs documentation](https://opentelemetry.io/docs/languages/dotnet/logs/)
- [Serilog.Sinks.OpenTelemetry on GitHub](https://github.com/serilog/serilog-sinks-opentelemetry)
- [OTLP Exporter for OpenTelemetry .NET](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Exporter.OpenTelemetryProtocol/README.md)
- [.NET observability with OpenTelemetry (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel)
- [OpenTelemetry.Exporter.OpenTelemetryProtocol on NuGet](https://www.nuget.org/packages/OpenTelemetry.Exporter.OpenTelemetryProtocol)
