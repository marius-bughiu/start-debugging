---
title: "Agent Framework 1.22: AsIChatClient で AIAgent を IChatClient として振る舞わせる"
description: "Microsoft Agent Framework .NET 1.22.0 が AIAgent.AsIChatClient() を追加し、IChatClient.AsAIAgent() から始まった往復を閉じました。インストラクションとツールを保ったままのエージェントが、IChatClient を受け取るあらゆる API に差し込めます。"
pubDate: 2026-09-20
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
lang: "ja"
translationOf: "2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient"
translatedBy: "claude"
translationDate: 2026-09-20
---

Microsoft Agent Framework [dotnet-1.22.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.22.0) が 2026-09-18 にリリースされました。注目すべき項目は [PR #7687](https://github.com/microsoft/agent-framework/pull/7687)、`AsIChatClient` です。`Microsoft.Extensions.AI` には以前からチャットクライアントをエージェントに変える `ChatClientExtensions.AsAIAgent()` がありました。その逆方向は存在しませんでした。今回それが加わり、往復が閉じました。

## 逆方向がなかったことの何が痛かったのか

`IChatClient` を受け取る .NET の API は増え続けています。`Microsoft.Extensions.AI.Evaluation` の評価器、キャッシュやテレメトリのミドルウェア、そして `ChatClientBuilder` のパイプライン上に構築されたものすべてです。`AIAgent` はより豊かなオブジェクトです。インストラクション、ツールセット、セッション、そして周囲に巻いたミドルウェアをまとめて持っています。そうした API に素の `IChatClient` を渡すということは、それらを手作業で組み直すか、評価の審査役に、審査役たらしめているシステムプロンプトを一切持たないモデルを渡すことを意味していました。

`AsIChatClient` は `Microsoft.Agents.AI` にあり、シグネチャは次のとおりです。

```csharp
public static IChatClient AsIChatClient(
    this AIAgent agent,
    AgentSession? session = null,
    string? conversationId = null,
    bool allowNonChatClientAgents = false)
```

審査役のエージェントは、呼び出し 1 回で審査役のチャットクライアントになります。

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIAgent judge = chatClient.CreateAIAgent(
    instructions: "You score answers for factual accuracy. Reply with JSON only.",
    name: "Judge");

IChatClient judgeClient = judge.AsIChatClient();
```

アダプターの実体は内部クラスの `AIAgentChatClient` で、`GetResponseAsync` と `GetStreamingResponseAsync` を `RunAsync` と `RunStreamingAsync` にマッピングし、指定した `ChatOptions` を `ChatClientAgentRunOptions` として運びます。キャンセルもそのまま伝わり、キーなしの `GetService<IChatClient>()` はアダプター自身を返し、それ以外のサービス要求はエージェントへ転送されます。

## ガードと、それを外すとき

既定では、エージェントが `ChatClientAgent` であるか、キーなしの `GetService<ChatClientAgent>()` からそれを返さない限り、この呼び出しは `InvalidOperationException` をスローします。`DelegatingAIAgent` を基にしたデコレーターはその要求を転送するため、ラップされたエージェントでも通ります。

`allowNonChatClientAgents: true` を指定すればどんな種類のエージェントでもラップできますが、細かい条件があります。この経路を生き延びるのは `ChatOptions.ResponseFormat` だけです。温度やツールなどは黙って無視されます。ワークフローのエージェントやリモートの A2A エージェントには、それらを適用するチャットオプションが存在しないからです。

もう一つの鋭い角がセッションです。既定のステートレスモードでは、空でない `ChatOptions.ConversationId` は例外になり、生のレスポンス ID は返されるコピー側でクリアされます。`session` を渡すと、クライアントはどのレスポンスに対しても安定した会話 ID を 1 つだけ報告します。渡した ID か、インスタンスごとに生成された ID です。サービス側の ID を漏らすことは決してなく、プロバイダーの会話状態は本来あるべきセッションの内側にとどまります。それ以外の空でない ID は未知のものとして例外になります。

この API には `[Experimental]` が付いているため、対応する診断を抑制するまではビルドエラーになります。

同じリリースの中でコードを grep する価値がある行がもう 1 つあります。[PR #8531](https://github.com/microsoft/agent-framework/pull/8531) により、`ChatClientAgent` のツールは、下位の関数呼び出し用チャットクライアントに設定されるのではなく、実行ごとに渡されるようになりました。これでクライアントを共有するエージェント間でツールが重複したり漏れ出したりしなくなります。この変更は BREAKING とされており、`AgentSessionStore` を `Microsoft.Agents.AI.Abstractions` へ移した件も同様です。

`Microsoft.Agents.AI` 1.22.0 へ更新してください。先週のリリースを飛ばしているなら、その前に [1.21 が LocalCodeAct とホスト環境について何を変えたか](/ja/2026/09/agent-framework-1-21-localcodeact-stops-inheriting-host-environment/) を確認しておくとよいでしょう。
