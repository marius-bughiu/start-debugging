---
title: ".NET Extensions 10.11: バッファーされたログがついにスコープを保持できるようになりました"
description: "2026-10-15 にリリースされた Microsoft.Extensions.Telemetry 10.11.0 は、グローバルおよびリクエスト単位のログ バッファリングに実験的な IncludeScopes オプションを追加しました。これにより BeginScope の OrderId や TenantId が、黙って失われることなく Flush() 後も残ります。"
pubDate: 2026-10-16
tags:
  - "dotnet"
  - "logging"
  - "observability"
  - "aspnetcore"
  - "csharp"
lang: "ja"
translationOf: "2026/10/dotnet-extensions-10-11-log-buffering-keeps-scopes-with-includescopes"
translatedBy: "claude"
translationDate: 2026-10-16
---

[.NET Extensions 10.11.0](https://github.com/dotnet/extensions/releases/tag/v10.11.0) が 2026-10-15 に NuGet で公開されました。AI 関連の修正はほとんどが小さなものですが、テレメトリの変更が 1 つ、ログ バッファリングの登場以来ずっと残っていた穴を塞いでいます。バッファーされたログ レコードは、`ILogger.BeginScope` の値をすべて失っていました。`Information` ログをバッファーし、例外が発生して `Flush()` を呼ぶと、スコープに入れておいた `OrderId`、`TenantId`、リクエスト ID が抜けたレコードが出力されていたのです。障害のデバッグに必要なコンテキストそのものです。

## これまでの Flush の出力

ログ バッファリングは `Microsoft.Extensions.Telemetry` (グローバル バッファー) と `Microsoft.AspNetCore.Diagnostics.Middleware` (リクエスト単位のバッファー) にあります。ルールに一致したレコードは循環バッファーに保持され、`Flush()` を呼んだときにだけ書き出されます。次は JSON コンソール ロガーを使った最小の再現コードです。このロガーは通常、`IncludeScopes` が有効ならスコープを出力します。

```csharp
var builder = Host.CreateApplicationBuilder();
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(o => o.IncludeScopes = true);
builder.Logging.AddGlobalBuffer(o =>
{
    o.Rules.Add(new LogBufferingFilterRule(logLevel: LogLevel.Information));
    o.IncludeScopes = true; // new in 10.11.0, EXTEXP0003
});
using var host = builder.Build();
var logger = host.Services.GetRequiredService<ILogger<Program>>();
var buffer = host.Services.GetRequiredService<GlobalLogBuffer>();

using (logger.BeginScope(new Dictionary<string, object?> { ["OrderId"] = 4711, ["TenantId"] = "contoso" }))
{
    logger.LogInformation("Reserving stock for {Sku}", "SKU-42");
    buffer.Flush();
}
```

SDK 10.0.302 上でファイルベース アプリとして実行しました。`Microsoft.Extensions.Telemetry` 10.10.0 (そこではコンパイルできない `IncludeScopes` の行は削除) では、Flush がスコープの内側で行われているにもかかわらず、出力されたレコードにスコープの痕跡はまったくありません。

```text
{"EventId":0,"LogLevel":"Information","Category":"Program","Message":"Reserving stock for SKU-42","Exception":"","State":{"Message":null,"Sku":"SKU-42","{OriginalFormat}":"Reserving stock for {Sku}"}}
```

10.11.0 で `IncludeScopes = true` にした場合です。

```text
{"EventId":0,"LogLevel":"Information","Category":"Program","Message":"Reserving stock for SKU-42","Exception":"","State":{"Message":null,"Sku":"SKU-42","OrderId":"4711","TenantId":"contoso","{OriginalFormat}":"Reserving stock for {Sku}"}}
```

## 仕組み

[PR #7813](https://github.com/dotnet/extensions/pull/7813) は、Flush の時点ではなく、レコードがバッファーされた瞬間にスコープを取得します。これが望ましい動作です。誰かが `Flush()` を呼ぶころには、元のスコープはたいてい終わっているからです。バッファーは DI から `IExternalScopeProvider` を受け取り (`ExtendedLoggerFactory` と共有)、各スコープの名前と値のペアをレコードにコピーします。

知っておくべき点がいくつかあります。

- スコープはスコープとしてではなく、**属性**として現れます。`IBufferedLogger` プロバイダーは `BufferedLogRecord.Attributes` で受け取り、それ以外のプロバイダーは `ILogger.Log` に渡される state にマージされた形で受け取ります。上の出力で `Scopes` 配列ではなく `State` に入っているのはこのためです。
- 取得されるのは `IEnumerable<KeyValuePair<string, object?>>` を実装したスコープだけです。`BeginScope("Checkout")` のような単純な文字列スコープはスキップされ、`{OriginalFormat}` のペアは破棄されます。`ActivityTrackingOptions` のスコープ (trace ID、span ID) は含まれます。
- 既定ではオフで、`EXTEXP0003` の実験的 API であり、構成からバインドできます。オプションはバッファーされるレコードごとに読み直されるので、構成の再読み込みはすぐに反映されます。

ASP.NET Core のリクエスト単位のバッファリングでは、同じスイッチが `PerRequestLogBufferingOptions` にあります。

```csharp
builder.Logging.AddPerIncomingRequestBuffer(o =>
{
    o.Rules.Add(new LogBufferingFilterRule(logLevel: LogLevel.Information));
    o.IncludeScopes = true;
});
```

## 10.11.0 のその他の変更

このリリースでは、リクエスト終了時のリクエスト単位バッファリングで発生する `ArgumentNullException` (#7811) と、ルール セレクターのキャッシュが原因のバッファリングの競合状態 (#7803) も修正されています。実験的な HTTP レイテンシ エンリッチャーを使っている場合、`AddHttpLatencyTelemetry` は `AddHttpServerLatencyTelemetry` に名前が変わりました (#7730)。AI 側では、関数が例外をスローした場合にも `FunctionInvocationContext.Terminate` が尊重されるようになり (#7801)、`ChatResponseUpdate.Clone` が `ContinuationToken` を保持するようになりました (#7699)。このシリーズの前回のリリースは [Microsoft.Extensions.AI 10.10.1](/ja/2026/09/microsoft-extensions-ai-10-10-1-fixes-openai-2-14-typeloadexception/) でした。

アップグレードするには次を実行します。

```bash
dotnet add package Microsoft.Extensions.Telemetry --version 10.11.0
```

ログをバッファーしてスコープの値で相関付けているなら、`IncludeScopes` を有効にしてください。これがないと、障害時に Flush したログには、相関付けに必要な ID が含まれません。
