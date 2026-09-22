---
title: "OpenTelemetry .NET 1.19.1 で net8.0 のワイルドカード NotSupportedException が修正されました"
description: "OpenTelemetry 1.19.0 はワイルドカードのソース用正規表現を RegexOptions.NonBacktracking に切り替えましたが、net8.0 では十分な数のソースを登録すると例外がスローされます。2026-09-21 にリリースされた 1.19.1 は、マッチタイムアウト付きのコンパイル済み正規表現に戻しています。"
pubDate: 2026-09-22
tags:
  - "dotnet"
  - "opentelemetry"
  - "observability"
  - "dotnet-8"
lang: "ja"
translationOf: "2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8"
translatedBy: "claude"
translationDate: 2026-09-22
---

[OpenTelemetry .NET 1.19.1](https://github.com/open-telemetry/opentelemetry-dotnet/releases/tag/core-1.19.1) は 1.19.0 の 3 日後、2026-09-21 にリリースされました。注目すべき変更はちょうど 1 つだけですが、アプリが `net8.0` をターゲットにしていて、多数のアクティビティソースやメーターを登録している場合、この変更が `TracerProvider` が正常に動くか起動時にクラッシュするかの分かれ目になります。

## 1.19.0 で何が壊れたのか

SDK は、`AddSource("...")` と `AddMeter("...")` に渡された名前のうち少なくとも 1 つが `*` または `?` を含む場合、それらをまとめて 1 つの正規表現に変換します。1.19.0 向けにマージされた [PR #7760](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7760) は、モダンな .NET ではこの正規表現を `RegexOptions.NonBacktracking` で構築するようにして堅牢化しました。リストにどんなパターンが入っても壊滅的なバックトラッキングが起きないようにする、という意図自体は妥当でした。

問題は、非バックトラッキングエンジンがパターンをオートマトンにコンパイルする際にサイズの上限が固定されており、その上限が .NET 8 では 1,000 ノード (.NET 9 以降では 10,000) だという点です。ソースごとに選択肢の分岐が 1 つ追加されるので、すぐに膨らみます。数十のソースを事前登録している Grafana OpenTelemetry ディストリビューションは、[issue #7787](https://github.com/open-telemetry/opentelemetry-dotnet/issues/7787) で報告されているとおり、すぐにこの上限に達しました。

```text
System.NotSupportedException : The specified pattern with RegexOptions.NonBacktracking
could result in an automata as large as '1285' nodes, which is larger than the configured
limit of '1000'.
   at OpenTelemetry.WildcardHelper.GetWildcardRegex(IEnumerable`1 patterns)
   at OpenTelemetry.Trace.TracerProviderSdk..ctor(IServiceProvider serviceProvider, Boolean ownsServiceProvider)
```

発生条件に注意してください。リストのどこかにワイルドカードが 1 つでもあれば、すべてのソース名が正規表現に取り込まれます。`net8.0` では、リストが十分に長ければ次のような構成だけで発生します。

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing
        .AddSource("MyCompany.Orders", "MyCompany.Billing", "MyCompany.Shipping")
        .AddSource(internalSourceNames)   // a few hundred names from config
        .AddSource("AWSSDK.*")            // one wildcard switches on regex mode
        .AddOtlpExporter());
```

`net9.0`、`net10.0`、.NET Framework のビルドではこの例外は発生しませんでした。ただしコストの影響は受けていました。PR によると、非バックトラッキングの `Regex` はバックトラッキング版に比べて約 35 倍のメモリを保持するため、プロセスの存続期間中に多数のプロバイダーを構築するテストスイートやホストでは `OutOfMemoryException` に陥る可能性がありました。

## 1.19.1 の対処方法

[PR #7788](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7788) はすべてのターゲットフレームワークで `NonBacktracking` を廃止してコンパイル済み正規表現に戻し、保護はマッチタイムアウトで維持しています。

```csharp
var pattern = "^(?:" + convertedPattern + ")$";

return new Regex(pattern, RegexOptions.Compiled | RegexOptions.IgnoreCase, RegexMatchTimeout);
// RegexMatchTimeout = TimeSpan.FromSeconds(1)
```

`WildcardHelper.IsMatch` は `RegexMatchTimeoutException` をキャッチして `false` を返すため、異常なパターンがあってもスレッドがハングするのではなく、1 つのソースがリッスンされなくなるだけで済みます。同じ変更は `AddView` のワイルドカードのインストゥルメント名にも適用されています。こちらもモダンな .NET では `NonBacktracking` を使っていました。

## アップグレード

OpenTelemetry のコアパッケージは足並みをそろえてバージョンが上がるので、すべてまとめて更新してください。

```bash
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.19.1
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.19.1
```

1.18.x を使っている場合は、1.19.0 を完全に飛ばしてかまいません。すでに `net8.0` で 1.19.0 を展開していて例外が出ていないなら、現時点ではノード上限を下回っているだけです。今後ソースをいくつか追加すれば起動時に上限に達していたはずなので、いずれにしてもアップグレードしてください。全体的なセットアップを復習したい場合は、[.NET 11 と無料のバックエンドで OpenTelemetry を使う方法](/ja/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) の解説が今もそのまま通用します。

より広い教訓として覚えておく価値があります。`RegexOptions.NonBacktracking` はタダで使える安全スイッチではありません。バックトラッキングのリスクと引き換えに、オートマトンのサイズ上限と大きなメモリフットプリントを抱えることになり、.NET 8 ではその上限がごく普通の構成でも到達するほど小さいのです。
