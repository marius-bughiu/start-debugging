---
title: "StackExchange.Redis 3.3 はサーバーに切断される前に Redis ノードから移動します"
description: "StackExchange.Redis 3.3.0 は Redis Enterprise、Redis Cloud、Azure Managed Redis 向けにオプトインのメンテナンス通知 (スマートクライアントハンドオフ) を追加しました。移行中のタイムアウト緩和、トポロジの再読み込み、エンドポイントが消える前の事前移動を行います。有効化の方法と、最初に遭遇する SER010 エラーを解説します。"
pubDate: 2026-09-23
tags:
  - "redis"
  - "stackexchange-redis"
  - "dotnet"
  - "resilience"
lang: "ja"
translationOf: "2026/09/stackexchange-redis-3-3-smart-client-handoffs"
translatedBy: "claude"
translationDate: 2026-09-23
---

[StackExchange.Redis 3.3.0](https://github.com/StackExchange/StackExchange.Redis/releases/tag/3.3.0) は 2026-09-18 にリリースされ、続いて 2026-09-22 に [3.3.1](https://github.com/StackExchange/StackExchange.Redis/releases/tag/3.3.1) が出ました。目玉機能はサーバーネイティブのメンテナンス通知で、他の Redis クライアントでは "smart client handoffs" や "hitless upgrades" と呼ばれているものです。Redis Enterprise と Redis Cloud は、シャードの移行中、ノードのフェイルオーバー中、あるいは接続先のエンドポイントがまもなく置き換えられることを .NET クライアントに通知できるようになり、クライアントはソケットが切れるのを待たずにそれに応じて動作します。

マネージド Redis のメンテナンス時間帯に `RedisTimeoutException` が集中して発生した経験があるなら、これはその種の問題に対する修正です。

## 各通知に対するクライアントの動作

通知は、コマンドを運ぶのと同じ接続上で RESP3 のプッシュフレームとして届きます。[PR #3191 の設計メモ](https://github.com/StackExchange/StackExchange.Redis/pull/3191) によると、クライアントはあなたがコードを書かなくても次のように反応します。

- `MIGRATING`、`FAILING_OVER`、`SMIGRATING`: そのサーバーでのコマンドタイムアウトが緩和されます (デフォルトは 10 秒、`maintRelaxedTimeout`)。
- `MIGRATED`、`FAILED_OVER`: 時間帯が終了し、状態が落ち着くまで短い緩和期間が続きます。
- `SMIGRATED`: クラスタートポロジが再読み込みされ、スロットが移動したシャード化サブスクリプションが再購読されます。
- `MOVING`: クライアントは置き換え先のアドレスを問い合わせ、処理中の作業を完了させ、サーバーが接続を閉じる前に接続を切り替えます。

最も重要なのは最後の項目です。作者の計測では、DNS の更新は `MOVING` 通知から 4 から 19 秒遅れていましたが、サーバーは古いソケットをおよそ 16 から 19 秒で閉じます。置き換え先のエンドポイントをサーバーに指定させることで (`maintMovingEndpointType=Auto`、デフォルト)、ハンドオフは 1 秒以内に完了する直接の移動になります。

## 3.3 での有効化

認識された Redis Cloud や Azure Managed Redis のホスト名に接続する場合でも、現時点ではオプトインです。[ドキュメント](https://seredis.dev/ServerMaintenanceEvent) によると、これらのプロバイダーに対する自動有効化は今後のリリースで予定されています。接続文字列を使う方法が最も簡単です。

```csharp
var muxer = await ConnectionMultiplexer.ConnectAsync(
    "my-redis.example.com:6379,maintNotifications=Auto,maintRelaxedTimeout=15");
```

厳密に型指定された API は experimental とマークされており、3.3.1 では警告ではなくコンパイルエラーになります。

```text
error SER010: 'StackExchange.Redis.ConfigurationOptions.MaintenanceNotifications' is for
evaluation purposes only and is subject to change or removal in future updates.
```

プロパティとイベント型を使いたい場合は、明示的に抑制してください。

```csharp
#pragma warning disable SER010
using StackExchange.Redis;
using StackExchange.Redis.Maintenance;

var options = ConfigurationOptions.Parse("my-redis.example.com:6379");
options.MaintenanceNotifications = MaintenanceNotificationMode.Auto;

var muxer = await ConnectionMultiplexer.ConnectAsync(options);
muxer.ServerMaintenanceEvent += (_, e) =>
{
    if (e is PushMaintenanceEvent m)
        Console.WriteLine($"{m.NotificationType} seq {m.SequenceId} from {m.EndPoint}");
};
```

`MaintenanceNotificationMode` には 3 つの値があります。`Disabled` が現在のデフォルトです。`Auto` はハンドシェイク時に要求し、サーバーが拒否してもそのまま続行します。`Enabled` は通知を受け取れない場合に接続を拒否します。接続が RESP2 になった場合も同様なので、ステージング環境で機能が有効になっていることを確認する手段として役立ちます。

## 本番投入前に確認すべき 2 点

RESP3 が必須です。`protocol=resp2`、6.0 未満の `defaultVersion`、またはコマンドマップで `HELLO` を無効にしている場合、`Auto` では機能が黙って無効になります。

意図的なハンドオフは、`FailureType == ConnectionFailureType.MaintenanceHandoff` を持つ `ConnectionFailed` イベントとしても現れます。`ConnectionFailed` でアラートを出している場合は、この値を除外してください。そうしないと、計画されたメンテナンスのたびに呼び出しが鳴ります。

オプトインではない変更が 1 つあります。3.3.0 では `topologyRefreshSeconds` が追加され、デフォルトで 30 分ごとにトポロジを再読み込みします (ジッター付き、`0` で無効化)。これは、ハンドシェイクには応答するものの、すでにデプロイメントに属していないエンドポイントに対処するためのものです。

すでに `HybridCache` の背後で Redis を使っている場合は、[ASP.NET Core 11 で Redis を L2 キャッシュとして HybridCache を使う方法](/ja/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) を参照してください。その接続文字列に `maintNotifications=Auto` を追加するのは、今月できる最も安上がりな回復性の向上です。
