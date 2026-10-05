---
title: "Orleans 10.4: ストリームのサブスクリプションをキャッシュ内の最も古いメッセージから開始できるようになりました"
description: "Orleans 10.4.0 で StreamSubscriptionStartPosition.EarliestAvailable が追加され、新しいストリームのサブスクライバーが pulling agent のキューキャッシュに残っているメッセージをリプレイできるようになりました。このリリースでは、RPC 引数のワイヤー ID、リクエストレイテンシのメトリクス、SQLite 永続化スクリプトも変更されています。"
pubDate: 2026-10-05
tags:
  - "orleans"
  - "dotnet"
  - "streaming"
  - "distributed-systems"
lang: "ja"
translationOf: "2026/10/orleans-10-4-stream-subscriptions-can-start-from-earliest-available"
translatedBy: "claude"
translationDate: 2026-10-05
---

Orleans [v10.4.0](https://github.com/dotnet/orleans/releases/tag/v10.4.0) は 2026年10月3日にリリースされました。リリースノートは多岐にわたります(すべてのクラスタリングプロバイダーにおけるメンバーシップの一貫性、フレームワーク API 全体への cancellation token の対応、NativeAOT に適したコーデック、オプトインのシリアライザー Hot Reload)が、多くのアプリケーションコードに影響するのはストリーミングの変更です。トークンを持たないサブスクリプションに対して、ついに開始位置を指定できるようになりました。

## 新しいサブスクライバーがこれまで取りこぼしていたもの

Orleans の永続ストリームのサブスクライバーには、これまで 2 つのモードがありました。`StreamSequenceToken` を渡すと、巻き戻し可能なプロバイダーがその位置からリプレイします。何も渡さなければライブ配信になり、サブスクリプションのハンドシェイク後に届いたものだけを受け取ります。pulling agent がそのストリームについてすでにキューキャッシュに保持していたメッセージは、見ることができませんでした。

このギャップは、よくあるパターンで問題になります。グレインがストリーム上の最初のイベントをきっかけにアクティブ化し、サブスクライブしますが、まさにそのイベントと、アクティブ化の最中に届いたほかのイベントを失ってしまいます。回避策はシーケンストークンを自分で追跡することでしたが、そもそもトークンを一度でも受け取っていなければ機能しません。

## EarliestAvailable でサブスクライブする

[PR #10936](https://github.com/dotnet/orleans/pull/10936) で `StreamSubscriptionStartPosition` 列挙型が追加されました。値は `Latest`(デフォルトで、従来と同じ動作)と `EarliestAvailable` の 2 つで、アイテムオブザーバーとバッチオブザーバー向けの `SubscribeAsync` オーバーロードも用意されています。

```csharp
using Orleans.Streams;

public sealed class OrderProjectionGrain : Grain, IOrderProjectionGrain, IAsyncObserver<OrderEvent>
{
    public override async Task OnActivateAsync(CancellationToken cancellationToken)
    {
        var stream = this.GetStreamProvider("orders")
            .GetStream<OrderEvent>(StreamId.Create("orders", this.GetPrimaryKeyString()));

        await stream.SubscribeAsync(this, StreamSubscriptionStartPosition.EarliestAvailable);
    }

    public Task OnNextAsync(OrderEvent item, StreamSequenceToken? token = null) => Task.CompletedTask;
    public Task OnCompletedAsync() => Task.CompletedTask;
    public Task OnErrorAsync(Exception ex) => Task.CompletedTask;
}
```

`EarliestAvailable` は、その `StreamId` についてローカルのキューキャッシュがまだ保持している最も古いメッセージから、そのメッセージを含めて開始します。何も保持されていなければ、次のメッセージを待ちます。Event Hubs、SQS、Azure Queues にさかのぼることはありません。リプレイの範囲はキャッシュ内に限られ、レシーバーのチェックポイントには影響しません。

優先順位は明確です。具体的なシーケンストークンが最優先で、次に渡した開始位置、その次にプロバイダーのデフォルト、最後に `Latest` となります。プロバイダーのデフォルトは `StreamPullingAgentOptions` にあり、引数なしでサブスクライブする既存コードに関係します。

```csharp
siloBuilder.AddMemoryStreams("orders", streams =>
    streams.ConfigurePullingAgent(ob => ob.Configure(options =>
        options.InitialSubscriptionStartPosition =
            StreamSubscriptionStartPosition.EarliestAvailable)));
```

組み込みのプール型、シンプル型、Event Hubs のキャッシュはこの機能をサポートしています。サポートのないカスタム `IQueueCache` では、暗黙のうちにライブ配信へフォールバックするのではなく、サブスクリプションが確定的に失敗します。ローリングアップグレード中は、pulling agent をホストするすべてのサイロが 10.4.0 で動作してから有効にしてください。

## 見逃せないアップグレード時の 3 つの注意点

リリースノートでは、次の項目が互換性に影響する変更として挙げられています。

- **RPC 引数の ID**: パラメーターレベルの `[Id]` 属性がシリアル化される引数 ID を制御するようになり、自動 ID はシリアル化されるパラメーターのみを数えます。グレインインターフェースがパラメーターの `[Id]` を使っている場合や、`CancellationToken` を最後以外の位置に置いている場合、ワイヤーフォーマットは 10.3.1 と異なります。クライアントとサイロを同時にアップグレードするか、コントラクトをバージョン管理してください。
- **メトリクス**: リクエストレイテンシは、ミリ秒の小数で表される `orleans-app-requests-latency` という名前の単一の `Histogram<double>` になり、`-bucket`、`-count`、`-sum` の各インストゥルメントは置き換えられました。`orleans-grains` は `type` ではなく `grain_type` ディメンションを使います。ダッシュボードとアラートの更新が必要です。
- **SQLite 永続化**: 既存のデータベースで、10.4.0 の `Sqlite-Main.sql` と `Sqlite-Persistence.sql` スクリプトを再実行してください。これらは冪等で、ライター競合時のアトミック性の問題を修正します。

[サブスクリプション開始位置のドキュメント](https://github.com/dotnet/orleans/blob/main/docs/site/src/content/docs/streaming/subscription-start-positions.md)に詳細なセマンティクスが記載されています。また、リリースノートには、`10.4.0-alpha.1` として提供されるジャーナリングと Durable Jobs のプレビュー変更も記載されています。
