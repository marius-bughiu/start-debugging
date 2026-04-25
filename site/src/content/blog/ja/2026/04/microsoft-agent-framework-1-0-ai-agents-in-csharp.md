---
title: "Microsoft Agent Framework 1.0: 純粋な C# で AI エージェントを構築"
description: "Microsoft Agent Framework が安定した API、マルチプロバイダーコネクター、マルチエージェントオーケストレーション、A2A/MCP 相互運用性で 1.0 に到達。.NET 10 上での実際の見え方を紹介します。"
pubDate: 2026-04-07
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "ai"
  - "microsoft-agent-framework"
lang: "ja"
translationOf: "2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

Microsoft は 2026 年 4 月 3 日に [Agent Framework 1.0](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/) を .NET と Python の両方で出荷しました。これは本番環境対応のリリースです。安定した API、長期サポートのコミットメント、そして今年初めにリリースされた preview からの明確なアップグレードパスを備えています。

Agent Framework は Semantic Kernel のエンタープライズの配管と AutoGen からのマルチエージェントオーケストレーションパターンを単一のフレームワークに統合します。これら 2 つのプロジェクトを別々に追跡してきた場合、その分裂は終わりました。

## 箱の中身

1.0 リリースは、以前は複数のライブラリを縫い合わせる必要があった 5 つの領域をカバーします。

Azure OpenAI、OpenAI、Anthropic Claude、Amazon Bedrock、Google Gemini、Ollama 向けの一級の **サービスコネクター**。プロバイダーの切り替えは 1 行の変更で済みます。すべてのコネクターが `Microsoft.Extensions.AI` の `IChatClient` を実装しているからです。

Microsoft Research と AutoGen から持ち込まれた **マルチエージェントオーケストレーション** パターン: 順次、並行、handoff、group chat、Magentic-One。これらはおもちゃのデモではなく、AutoGen チームが研究環境で検証したのと同じパターンです。

**MCP サポート** によりエージェントは任意の Model Context Protocol サーバーが公開するツールを発見して呼び出せます。**A2A (Agent-to-Agent)** プロトコルサポートはさらに進み、異なるフレームワークやランタイムで動作するエージェントが構造化メッセージングを通じて協調できるようにします。

エージェントの動作をすべての実行段階で傍受して変換するための **ミドルウェアパイプライン**、加えて会話履歴、キーバリュー状態、ベクトル取得用のプラガブルな **メモリプロバイダー**。

## 5 行の最小エージェント

ゼロから動作するエージェントまでの最速パス:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;

AIAgent agent = new OpenAIClient("your-api-key")
    .GetChatClient("gpt-4o-mini")
    .AsIChatClient()
    .CreateAIAgent(
        instructions: "You are a senior .NET architect. Be concise and production-focused.");

var response = await agent.RunAsync("Design a retry policy for transient SQL failures.");
Console.WriteLine(response);
```

`AsIChatClient()` は OpenAI クライアントを `IChatClient` 抽象化に橋渡しします。`CreateAIAgent()` は指示コンテキスト、ツール登録、会話スレッディングでそれをラップします。`OpenAIClient` を他のサポートされたコネクターに置き換えても、残りのコードは同一のままです。

## ツールを追加する

エージェントはあなたのコードを呼び出せるようになると有用になります。`AIFunctionFactory` でツールを登録します。

```csharp
using Microsoft.Agents.AI;

var tools = new[]
{
    AIFunctionFactory.Create((string query) =>
    {
        // search your internal docs, database, etc.
        return $"Results for: {query}";
    }, "search_docs", "Search internal documentation")
};

AIAgent agent = chatClient.CreateAIAgent(
    instructions: "Use search_docs to answer questions from internal docs.",
    tools: tools);
```

フレームワークはツールの発見、スキーマ生成、呼び出しを自動的に処理します。MCP で公開されたツールも同じように動作し、エージェントは MCP 準拠のサーバーから実行時にそれらを解決します。

## なぜこれが今重要か

1.0 以前、.NET エージェントを構築することは Semantic Kernel (良いエンタープライズ統合、限られたオーケストレーション) か AutoGen (強力なマルチエージェントパターン、より粗い .NET ストーリー) の選択を意味していました。Agent Framework はその選択を取り除きます。1 つのパッケージ、1 つのプログラミングモデル、本番対応です。

NuGet パッケージはコア用の `Microsoft.Agents.AI` とコネクター用の `Microsoft.Agents.AI.OpenAI` (またはプロバイダー固有のバリアント) です。インストール:

```bash
dotnet add package Microsoft.Agents.AI.OpenAI
```

完全なドキュメントとサンプルは [GitHub](https://github.com/microsoft/agent-framework) と [Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/overview/) にあります。
