---
title: "GitHub Copilot SDK が GA に到達: Copilot のエージェントランタイムを自分の C# アプリに組み込む"
description: "Build 2026 で GitHub は第一級の .NET パッケージを備えた Copilot SDK 1.0 GA を出荷しました。計画、ツール呼び出し、マルチターンセッションを備えた同じエージェントランタイムを C# コードから操作でき、BYOK にも対応します。"
pubDate: 2026-06-07
tags:
  - "github-copilot"
  - "copilot-sdk"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "mcp"
lang: "ja"
translationOf: "2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp"
translatedBy: "claude"
translationDate: 2026-06-07
---

GitHub は 2026 年 6 月 2 日の Build で [GitHub Copilot SDK が一般提供に到達した](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/)ことを発表しました。.NET 開発者として注目すべき部分は `GitHub.Copilot.SDK` パッケージです。これは、エディター内の Copilot の背後にあるのと同じエージェントランタイム、つまり計画、ツール呼び出し、ファイル編集、ストリーミング、マルチターンセッションへの直接的かつプログラム的なアクセスを提供します。セールスポイントは、オーケストレーション層を自分で作る必要がないことです。すでに 1 日に数百万回のエージェントターンを処理しているランタイムが、いまや NuGet の依存関係になりました。

## 実際に得られるもの

SDK は GA 時点で 6 つの言語で登場しました(`@github/copilot-sdk`、Python・Go・Rust・Java 向けの `github-copilot-sdk`、そして .NET 向けの `GitHub.Copilot.SDK`)。Node.js、Python、.NET については Copilot CLI が推移的依存関係として自動的に同梱されるため、別途インストールしたり PATH に保持したりするバイナリはありません。パッケージを 1 つ追加すれば、エージェントホストが手に入ります:

```bash
dotnet add package GitHub.Copilot.SDK
```

セッションが作業の単位です。クライアントを起動し、モデルに対してセッションを開き、ポーリングではなく型付きイベントをリッスンします。以下は単一のプロンプトに対する一連の流れです:

```csharp
using GitHub.Copilot;

await using var client = new CopilotClient();
await client.StartAsync();

await using var session = await client.CreateSessionAsync(new SessionConfig
{
    Model = "gpt-5",
    OnPermissionRequest = PermissionHandler.ApproveAll,
});

var done = new TaskCompletionSource();

session.On<SessionEvent>(evt =>
{
    if (evt is AssistantMessageEvent msg)
        Console.WriteLine(msg.Data.Content);
    else if (evt is SessionIdleEvent)
        done.SetResult();
});

await session.SendAsync(new MessageOptions { Prompt = "What is 2+2?" });
await done.Task;
```

ストリーミングは別の API ではなくフラグです。`SessionConfig` で `Streaming = true` を設定すると `AssistantMessageDeltaEvent` の断片が届くので、最終的な `AssistantMessageEvent` まで蓄積していきます。

## ツールは普通のメソッド、MCP は組み込み

これを単なるチャットのラッパー以上のものにしている要素が、カスタムツールです。`CopilotTool.DefineTool` はデリゲートを受け取り、`Microsoft.Extensions.AI` の関数ファクトリーを再利用するので、ツールは各パラメーターに `[Description]` を付けた型付きの C# メソッドにすぎません:

```csharp
using Microsoft.Extensions.AI;
using System.ComponentModel;

var session = await client.CreateSessionAsync(new SessionConfig
{
    Model = "gpt-5",
    Tools =
    [
        CopilotTool.DefineTool(
            async ([Description("Issue ID")] string id) => await FetchIssueAsync(id),
            factoryOptions: new AIFunctionFactoryOptions
            {
                Name = "lookup_issue",
                Description = "Fetch issue details",
            }),
    ],
});
```

すでに [C# でカスタム MCP サーバー](/ja/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/)を作っているなら、エージェントはそれに直接接続できるので、既存のツールは書き直しなしでそのまま使えます。

## GitHub の課金に縛られないための BYOK

認証はもう一つの注目理由です。デフォルトでは SDK は `copilot` CLI のログインや環境トークン(`COPILOT_GITHUB_TOKEN`、`GH_TOKEN`、`GITHUB_TOKEN`)を拾います。しかし bring-your-own-key は OpenAI、Microsoft Foundry、Anthropic などのプロバイダーで機能するので、すでに料金を支払っているモデルにランタイムを向けることができます:

```csharp
var session = await client.CreateSessionAsync(new SessionConfig
{
    Provider = new ProviderConfig
    {
        Type = "openai",
        BaseUrl = "https://api.openai.com/v1",
        ApiKey = "your-api-key",
    },
});
```

さらに W3C トレースコンテキスト伝播を伴う OpenTelemetry のトレーシングも同梱されており、エージェントのツール呼び出しやターンがサービスの他の部分と同じトレースに現れます。生のチャットクライアントの上でツールループを手書きしてきた人にとって、この GA パッケージは、GitHub 自身のエージェントランタイムを `dotnet add` して出荷できる最初の機会です。次に向かうべき場所は [.NET のクックブックと入門ガイド](https://github.com/github/copilot-sdk)です。
