---
title: "Microsoft.Extensions.AI 10.9 にルーティングとフェイルオーバーのチャットクライアントが登場"
description: "Microsoft.Extensions.AI 10.9.0 で RoutingChatClient、OrderedFailoverChatClient、SemanticRoutingChatClient が追加されました。実際のパッケージで検証した内容として、何がフェイルオーバーし何がしないのか、そしてなぜ MEAI001 がビルドを壊すのかを解説します。"
pubDate: 2026-08-14
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "resilience"
  - "csharp"
lang: "ja"
translationOf: "2026/08/microsoft-extensions-ai-10-9-routing-and-failover-chat-clients"
translatedBy: "claude"
translationDate: 2026-08-14
---

2026-08-13 に .NET チームが [Routing and Failover for Microsoft.Extensions.AI](https://devblogs.microsoft.com/dotnet/routing-and-failover-for-microsoft-extensions-ai/) を公開しました。注目すべきなのは、これらの型がすでに `Microsoft.Extensions.AI` 10.9.0 として NuGet に上がっており、今日から使える点です。これまでは、安価なモデルにリクエストを送って失敗したら大きなモデルにフォールバックする、という処理のために `IChatClient` を `try`/`catch` で手作業でラップする必要がありました。今はそれを担う型が 4 つあります。`Microsoft.Extensions.AI.Abstractions` の `RoutingChatClient` と `RoutingContext`、そして `Microsoft.Extensions.AI` の `FailoverChatClient`、`OrderedFailoverChatClient`、`SemanticRoutingChatClient` です。

## 順序付きのクライアント一覧が 2 行で書ける

`OrderedFailoverChatClient` は、成功するクライアントが見つかるまでリストを順にたどります。コンストラクターは `(IReadOnlyList<IChatClient> clients, bool leaveOpen = false)` なので、内側のクライアントを DI コンテナーが所有している場合は `leaveOpen: true` を渡してください。

```csharp
using var failover = new OrderedFailoverChatClient(
    [primaryClient, backupClient, lastResortClient],
    leaveOpen: true);

ChatResponse response = await failover.GetResponseAsync(
    [new ChatMessage(ChatRole.User, "hi")]);
```

すべてのクライアントが例外を投げた場合、受け取るのは集約された例外ではなく最後の例外です。`AggregateException` を前提にした `catch` を書く前に知っておく価値があります。

## つまずきやすいストリーミングの規則

ストリーミング呼び出しではフェイルオーバーは無料ではありません。再試行ループがクライアントを選び直すのは、呼び出し側にまだ何も渡していない間だけです。これを確認するために、フェイクのクライアントで 3 つのケースを実行しました。

- 非ストリーミングのプライマリーが例外を投げた場合。`SelectClientAsync` が再度実行され、バックアップが応答し、呼び出し側は失敗をまったく認識しません。
- ストリーミングのプライマリーが最初の `ChatResponseUpdate` より前に例外を投げた場合。同じくバックアップへきれいに切り替わります。
- ストリーミングのプライマリーが 2 件の更新をすでに返した後で例外を投げた場合。例外は列挙の途中で表面化し、部分的な 2 件のチャンクは消費されたままになります。

設計時に考慮すべきなのは 3 つ目のケースです。`FailoverChatClientAttempt.OutputCommitted` が `true` になった時点でストリームの途中からの復旧はできないため、届いたトークンを順に追記していく UI には独自の打ち切り処理が必要になります。

## コストで振り分けるか、意味で振り分けるか

順序付きリスト以外の振り分けをしたい場合、`RoutingChatClient.Create` はコールバックを受け取ります。

```csharp
using var router = RoutingChatClient.Create((context, ct) =>
    new ValueTask<IChatClient>(
        context.Messages.Last().Text.Length > 20 ? powerfulClient : cheapClient));
```

`RoutingContext` が公開しているのは `Messages` と `ChatOptions` だけですが、セッションを固定するために `AdditionalProperties` でルーティングするには十分です。再試行ループも併せて欲しい場合は `FailoverChatClient` を継承し、`MaximumAttemptsPerRequest`（`int?`）で上限を設定してください。

`SemanticRoutingChatClient` はエンベディングの類似度で選択します。完全なシグネチャには、元記事に載っている以上のパラメーターがあります。

```csharp
SemanticRoutingChatClient(
    IEmbeddingGenerator<string, Embedding<float>> embeddingGenerator,
    IReadOnlyDictionary<IChatClient, IReadOnlyList<string>> clientProfiles,
    IChatClient defaultClient,
    float scoreThreshold = 0.3f,
    int topK = 1,
    ScoreAggregation scoreAggregation = ScoreAggregation.Mean,
    bool leaveOpen = false)
```

`ScoreAggregation` は `Mean` か `Sum` のいずれかで、`scoreThreshold` を下回ったものはすべて `defaultClient` に流れます。

## MEAI001 は警告ではなくエラー

これらの型にはいずれも `[Experimental("MEAI001")]` が付いており、コンパイラーは既定でこれをエラーとして扱います。

```
error MEAI001: 'Microsoft.Extensions.AI.OrderedFailoverChatClient' is for evaluation
purposes only and is subject to change or removal in future updates.
```

利用する場合は csproj に `<NoWarn>MEAI001</NoWarn>` を追加してください。API の形はまだ動いている段階なので、ルーティングの判断は自前のインターフェースの背後に隠しておくのが安全です。まだプロバイダーの SDK を直接使っているなら、[Microsoft.Extensions.AI への移行](https://startdebugging.net/2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai/)がこのすべての前提になります。
