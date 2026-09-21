---
title: "Aspire 13.5.4 で Kafka ヘルスチェックがプローブのたびに producer をリークしなくなりました"
description: "Aspire 13.5.4 より前は、AddKafka リソースに対する AppHost のヘルスチェックが実行のたびに新しい Confluent の producer を作成し、誰も破棄しませんでした。そのためポーリングスレッドが積み上がり、AppHost が CPU を消費していました。この修正と、その背後にある HealthCheckRegistration.Factory の落とし穴は、独自のヘルスチェックにも当てはまります。"
pubDate: 2026-09-21
tags:
  - "aspire"
  - "kafka"
  - "dotnet"
  - "health-checks"
  - "dependency-injection"
lang: "ja"
translationOf: "2026/09/aspire-13-5-4-fixes-kafka-health-check-thread-leak"
translatedBy: "claude"
translationDate: 2026-09-21
---

[Aspire 13.5.4](https://github.com/microsoft/aspire/releases/tag/v13.5.4) は 2026-09-15 にリリースされました。AppHost で `AddKafka` を呼び出しているなら、適用する価値のあるパッチリリースです。13.5.3 までは、`Aspire.Hosting.Kafka` が登録する Kafka ヘルスチェックが実行のたびにまったく新しい Confluent.Kafka の producer を作成し、それを一度も破棄していませんでした。producer はそれぞれ独自のポーリングスレッドを起動するため、長時間動作する AppHost には `SafeKafkaHandle.Poll` で止まったスレッドが少しずつ溜まっていきました。[issue #20091](https://github.com/microsoft/aspire/issues/20091) の報告では、macOS 上の AppHost が CPU 350-400% に張り付き、スレッドサンプリングのトレースではサンプリングされた 1,934 スレッドのうち 1,901 が Kafka のポーリングループ内にありました。

AppHost の `dotnet run` を午後いっぱい開いたままにして、ファンが回り出した理由を不思議に思ったことがあるなら、これが有力な原因です。

## producer はどこから来ていたのか

ホスティング統合は `HealthCheckRegistration` の factory の中でチェックを構築していました。

```csharp
var healthCheckRegistration = new HealthCheckRegistration(
    healthCheckKey,
    sp =>
    {
        var options = new KafkaHealthCheckOptions();
        options.Configuration = new ProducerConfig();
        options.Configuration.BootstrapServers = connectionString
            ?? throw new InvalidOperationException("Connection string is unavailable");
        return new KafkaHealthCheck(options);
    },
    failureStatus: default,
    tags: default);
builder.Services.AddHealthChecks().Add(healthCheckRegistration);
```

`HealthCheckService` はチェックを実行するたびにこの factory を呼び出します。`KafkaHealthCheck` は producer を遅延作成し、`Dispose()` で解放しますが、factory が返すオブジェクトはコンテナーから解決されたものではなく `new` で生成されたものでした。ヘルスチェックのランナーは実行ごとに DI スコープを作成して破棄しますが、スコープが破棄するのは自分自身が作成したインスタンスだけです。チェックの `Dispose()` を呼ぶものは誰もいなかったため、プローブのたびに producer とポーリングスレッドが 1 つずつ残されていきました。

このコードは、Xabaril のヘルスチェックパッケージにある `AddKafka(...)` を意図的に避けていました。このヘルパーはシングルトンを登録するため、Kafka リソースが 2 つあると factory が最後に追加されたリソースの接続文字列を読んでしまうからです ([Xabaril #2298](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks/issues/2298))。この回避策は構成のバグを直した代わりに、有効期間のバグを持ち込みました。

## 修正: チェックの所有者を DI にする

[PR #20092](https://github.com/microsoft/aspire/pull/20092) (13.5.4 には #20094 としてバックポート) は、Kafka リソースごとにキー付きシングルトンを 1 つ登録し、factory がそれを解決するようにしています。

```csharp
builder.Services.AddKeyedSingleton<KafkaHealthCheck>(healthCheckKey, (sp, _) =>
{
    var options = new KafkaHealthCheckOptions();
    options.Configuration = new ProducerConfig();
    options.Configuration.BootstrapServers = connectionString
        ?? throw new InvalidOperationException("Connection string is unavailable");
    return new KafkaHealthCheck(options);
});

var healthCheckRegistration = new HealthCheckRegistration(
    healthCheckKey,
    sp => sp.GetRequiredKeyedService<KafkaHealthCheck>(healthCheckKey),
    failureStatus: default,
    tags: default);
```

`"{name}_check"` をキーにすることで各リソースの bootstrap servers が分離され、producer はプローブ間で再利用され、AppHost のシャットダウン時にルートコンテナーが破棄します。実際の Kafka 8.2.0 ブローカー 2 台を使った PR の計測では、84 回のヘルスチェック実行で 13.5.3 はチェックのインスタンス 84 個とポーリングスレッド 84 本を生み、修正後はインスタンス 2 個とスレッド 2 本、破棄後に残ったスレッドは 0 本でした。

## アップグレード

AppHost プロジェクトの Aspire パッケージを更新します。

```xml
<PackageReference Include="Aspire.Hosting.Kafka" Version="13.5.4" />
```

AppHost のコード変更は不要で、パブリック API の変更もありません。同じリリースでは、リージョンが自動選択された場合の DevTunnel の失敗 (13.3 で入ったリグレッション) も修正され、エミュレーターだけを使う AppHost では使われない `azure-environment` リソースが非表示になり、`IAwsRadiusProviderBuilder` と `IAzureRadiusProviderBuilder` に実験的診断 `ASPIRERADIUS003` が付きました。これらのインターフェースを直接参照している場合、新たな warning-as-error として現れる可能性があります。

## 自分のヘルスチェックにも同じパターンがないか確認する

このバグは Kafka 固有のものではありません。`new SomethingDisposable(...)` を返す `HealthCheckRegistration` の factory はどれも、プローブごとに 1 インスタンスをリークします。ヘルスチェック publisher の既定の周期である 30 秒で計算すると、チェック 1 つあたり 1 日に 2,880 個のオブジェクトがリークします。Aspire が今やっているようにチェックを DI に登録して factory で解決するか、高コストなクライアント (producer、接続、`HttpClient`) をシングルトンに置き、チェック自体は安価でステートレスなオブジェクトにしてください。まだ 13.5 系を使っているなら、[`WithTerminal()` に関する以前の記事](/ja/2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard/) で 13.5 のダッシュボードのその他の変更を紹介しています。
