---
title: "MCP C# SDK 2.0 リリース: デフォルトでステートレス、そして古いコードには MCP9005"
description: "ModelContextProtocol 2.0.0 が 2026-07-28 に登場しました。ステートレスな HTTP トランスポートがデフォルトで有効になり、サーバー起点の elicitation は Multi Round-Trip Requests に置き換わり、ElicitAsync と SampleAsync にはアナライザー警告が出ます。"
pubDate: 2026-07-29
tags:
  - "mcp"
  - "dotnet"
  - "csharp"
  - "ai-agents"
lang: "ja"
translationOf: "2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005"
translatedBy: "claude"
translationDate: 2026-07-29
---

2026-07-28 に Jeff Handley 氏が [公式 MCP C# SDK の v2.0](https://devblogs.microsoft.com/dotnet/announcing-v20-of-the-official-mcp-csharp-sdk/) を発表しました。プロトコルのリビジョン `2026-07-28` が確定したのと同じ日のリリースです。`ModelContextProtocol` 2.0.0 は安定版として NuGet に公開されており、`net8.0`、`net9.0`、`net10.0`、`netstandard2.0` を対象としています。1.x 向けにサーバーを構築している場合、差分を読まずに受け入れられるバージョンアップではありません。

## ハンドシェイクは消えました

目玉の変更はアーキテクチャに関わるもので、しかも引き算です。`2026-07-28` では `initialize` ハンドシェイクも `Mcp-Session-Id` も存在しません。クライアントは `server/discover` を呼び出し、以降のすべてのリクエストがプロトコルバージョン、クライアント情報、ケイパビリティをリクエストごとの `_meta` に載せて運びます。[GitHub の MCP サーバーが Redis のセッションストアを削除できた](/ja/2026/07/github-mcp-server-goes-stateless-redis-session-store/)のは、まさにこれが理由です。

C# SDK ではこれがデフォルト値の反転として現れます。`HttpServerTransportOptions.Stateless` は `true` になったので、今日スキャフォールドしたサーバーはスティッキールーティングなしで水平スケールします。セッションに戻すには明示的に指定します。

```csharp
builder.Services
    .AddMcpServer()
    .WithHttpTransport(options => options.Stateless = false)
    .WithToolsFromAssembly();
```

## MCP9005 が移行チェックリストです

サーバー起点のリクエストはステートレスなトランスポートでは生き残れません。`ElicitAsync`、`SampleAsync`、`RequestRootsAsync` は廃止扱いになり、診断 `MCP9005` を出します。2.0.0 に対してコンパイルすれば、その警告一覧がそのまま移行計画になります。ツール呼び出しの途中でサーバーからクライアントに手を伸ばしていた箇所は、すべて書き直しが必要です。

置き換えとなるのが Multi Round-Trip Requests です。サーバーがクライアントを呼び出すのではなく、ツールが必要な入力を添えて例外をスローし、クライアントがローカルでそれを解決し、回答を付けて呼び出しを再試行します。

```csharp
throw new InputRequiredException(
    inputRequests: new Dictionary<string, InputRequest>
    {
        ["closeReason"] = InputRequest.ForElicitation(...)
    },
    requestState: ticketId.ToString());
```

セッションなしでこれを成立させる仕掛けが `requestState` です。これは相関用のトークンであり、サーバーのメモリに置かれるのではなくクライアントが往復させます。

クライアント側は簡単なほうの半分です。ハンドラーを登録しておけば、`McpClient` が MRTR を透過的に解決します。

```csharp
var client = await McpClient.CreateAsync(
    clientTransport,
    clientOptions: new()
    {
        Handlers = new McpClientHandlers
        {
            ElicitationHandler = (requestParams, ct) =>
                ValueTask.FromResult(
                    new ElicitResult { Action = "accept" })
        }
    });
```

## 古い相手とまだ通信できる組み合わせ

2.0.0 のクライアントは `2026-07-28` を優先し、サーバーが `server/discover` に応答しない場合は自動的にレガシーな `initialize` ハンドシェイクへフォールバックします。2.0.0 のサーバーは 1.x クライアントからの `initialize` を引き続き受け付けます。唯一動かない組み合わせは、古いクライアントとステートレスなサーバーの組み合わせです。`2025-11-25` のクライアントに対して MRTR をレガシーな elicitation に翻訳するにはセッション状態が必要なので、ここだけは橋渡しできません。

もう一つの鋭い角は Tasks です。1.3.x と 1.4.x の実験的な Tasks サポートは削除され、SEP-2663 に沿って再設計された `ModelContextProtocol.Extensions.Tasks` パッケージに置き換わりました。Apps と Tasks はコアに組み込まれるのではなくオプトインのパッケージになり、`.WithTasks(store)` と `.WithMcpApps()` で有効化します。

ゲートウェイの背後でサーバーを運用している人にとって純粋にうれしい追加もあります。`[McpHeader]` はツールのパラメーターを HTTP ヘッダーに昇格させるので、プロキシは JSON-RPC のボディをパースせずにそれでルーティングできます。

```csharp
public static async Task<string> GetOrderStatus(
    [McpHeader("Region")] string region,
    string orderId)
```

まずは `dotnet add package ModelContextProtocol --version 2.0.0` を実行してビルドし、他に手を付ける前に `MCP9005` の一覧を読んでください。[v2.0.0 のリリースノート](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.0.0) には 10 件の破壊的変更がすべて列挙されており、`UnsupportedProtocolVersion` を `-32022` へ移す JSON-RPC エラーコードの再採番も含まれています。
