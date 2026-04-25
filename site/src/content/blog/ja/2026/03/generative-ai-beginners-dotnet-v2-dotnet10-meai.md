---
title: "Generative AI for Beginners .NET v2: Microsoft.Extensions.AI で .NET 10 向けに再構築"
description: "Microsoft の .NET 開発者向け無料生成 AI コースがバージョン 2 を出荷。.NET 10 向けに再構築され、Semantic Kernel から Microsoft.Extensions.AI の IChatClient パターンへ移行しました。"
pubDate: 2026-03-29
tags:
  - "dotnet"
  - "dotnet-10"
  - "ai"
  - "ai-agents"
  - "llm"
  - "microsoft-extensions-ai"
  - "generative-ai"
lang: "ja"
translationOf: "2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai"
translatedBy: "claude"
translationDate: 2026-04-25
---

Microsoft は [Generative AI for Beginners .NET](https://aka.ms/genainet) をバージョン 2 に更新しました。このコースは無料、オープンソースで、現在は重要なアーキテクチャ上の変更とともに .NET 10 向けに完全に再構築されています。Semantic Kernel が主要な抽象化から外れ、[Microsoft.Extensions.AI](https://learn.microsoft.com/en-us/dotnet/ai/microsoft-extensions-ai) (MEAI) に置き換えられました。

## Microsoft.Extensions.AI へのシフト

バージョン 1 はオーケストレーションとモデルアクセスのために Semantic Kernel に依存していました。バージョン 2 は MEAI の `IChatClient` インターフェースに標準化します。これは .NET 10 の一部として出荷され、`ILogger` と同じ依存性注入規約に従います。

登録パターンはどの .NET 開発者にも馴染みのあるものになります。

```csharp
var builder = Host.CreateApplicationBuilder();

// Register any IChatClient-compatible provider
builder.Services.AddChatClient(new OllamaChatClient("phi4"));

var app = builder.Build();
var client = app.Services.GetRequiredService<IChatClient>();

var response = await client.GetStreamingResponseAsync("What is AOT compilation?");
await foreach (var update in response)
    Console.Write(update.Text);
```

このインターフェースはプロバイダー非依存です。`OllamaChatClient` を Azure OpenAI 実装に交換するには、1 行の変更が必要です。コースはこれを意図的に使用しています。スキルは 1 つのベンダーの SDK にあなたを閉じ込めるのではなく、プロバイダー間で移転します。

## 5 つのレッスンがカバーするもの

再構築されたカリキュラムは 5 つの自己完結したレッスンで実行されます。

1. **基礎** -- LLM のメカニクス、トークン、コンテキストウィンドウ、.NET 10 がモデル API とどう統合するか
2. **コアテクニック** -- チャット完了、プロンプトエンジニアリング、関数呼び出し、構造化出力、RAG の基礎
3. **AI パターン** -- セマンティック検索、検索拡張生成、ドキュメント処理パイプライン
4. **エージェント** -- ツール使用、マルチエージェントオーケストレーション、.NET 10 の組み込み MCP クライアントサポートを使用した Model Context Protocol (MCP) 統合
5. **責任ある AI** -- バイアス検出、コンテンツセーフティ API、透明性ガイドライン

エージェントレッスンは、.NET 10 の MCP サポートを追跡してきた場合に特に関連があります。コースは `Microsoft.Extensions.AI.Abstractions` MCP クライアントを使用してマルチエージェントオーケストレーションをその機能に直接接続するので、フレームワークの体操なしでローカルまたはリモートの MCP サーバーに対してサンプルを実行できます。

## バージョン 1 からの移行

バージョン 1 の 11 個の Semantic Kernel サンプルはリポジトリ内の非推奨フォルダに移動されました -- まだ動作しますが、推奨パターンとしては提示されなくなりました。バージョン 1 を進めた場合、コアコンセプトは同じままです。移行はほとんどが API 層での交換です。Semantic Kernel の `Kernel` と `IKernelBuilder` を `IChatClient` と標準の `IServiceCollection` 拡張に置き換えます。

コースリポジトリは [github.com/microsoft/generative-ai-for-beginners-dotnet](https://github.com/microsoft/generative-ai-for-beginners-dotnet) にあります。コース自体は [aka.ms/genainet](https://aka.ms/genainet) から始まります。
