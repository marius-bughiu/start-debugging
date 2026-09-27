---
title: "AG-UI .NET SDK 1.0: AGUI.Server と AGUI.Client がプロトコルを Agent Framework から切り離す"
description: "AG-UI プロトコルに単体の .NET SDK が登場しました。AGUI.Server 1.0.0 はあらゆる IChatClient を SSE 経由で AG-UI イベントとしてストリーミングし、AGUIChatClient は AG-UI エンドポイントを .NET Framework 4.7.2 まで IChatClient として利用できるようにします。Agent Framework ユーザーには API 名の変更があります。"
pubDate: 2026-09-27
tags:
  - "ag-ui"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
  - "agent-framework"
lang: "ja"
translationOf: "2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework"
translatedBy: "claude"
translationDate: 2026-09-27
---

2026-09-25 に、.NET チームは [AG-UI プロトコル向けの本格的な .NET SDK を発表しました](https://devblogs.microsoft.com/dotnet/ag-ui-dotnet-sdk/)。パッケージは 2026-09-17 に `1.0.0` として NuGet に公開されています。`AGUI.Abstractions`、`AGUI.Formatting`、`AGUI.Protobuf`、`AGUI.Server`、`AGUI.Client` の5つで、MIT ライセンスで、[ag-ui-protocol/ag-ui の sdks/dotnet 以下](https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/dotnet)に置かれています。これまで .NET での AG-UI サポートは、Microsoft Agent Framework への依存を意味していました。その結合は今回なくなりました。

## AG-UI とは何か、一段落で

[AG-UI](https://docs.ag-ui.com/) は、エージェントのバックエンドとフロントエンドの間をつなぐワイヤープロトコルです。クライアントは `RunAgentInput`(メッセージ、ツール、状態)を POST し、サーバーは `RUN_STARTED`、`TEXT_MESSAGE_CONTENT`、ツール呼び出し系のイベント、`STATE_DELTA`、`RUN_FINISHED` といった型付きイベントのストリームで応答します。既定のトランスポートは Server-Sent Events で、イベントセットの一部にはオプションで protobuf コーデックも使えます。CopilotKit のようなフロントエンドはすでにこのプロトコルを話すので、正しい AG-UI イベントを出す .NET バックエンドはそのまま接続できます。

## あらゆる IChatClient が AG-UI エンドポイントになる

`AGUI.Server` は `net8.0`、`net9.0`、`net10.0` をターゲットにしており、必要なのは `Microsoft.Extensions.AI` の `IChatClient` だけです。エージェントの抽象化は一切不要です。

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(CreateChatClient());
builder.Services.Configure<JsonOptions>(options =>
    options.SerializerOptions.TypeInfoResolverChain.Insert(
        0, AGUIJsonUtilities.DefaultTypeInfoResolver));

var app = builder.Build();

app.MapPost("/", (RunAgentInput input, IChatClient chatClient,
    IOptions<JsonOptions> jsonOptions, CancellationToken ct) =>
{
    var context = input.ToChatRequestContext(jsonOptions.Value.SerializerOptions);

    var events = chatClient
        .GetStreamingResponseAsync(context.Messages, context.ChatOptions, ct)
        .AsAGUIEventStreamAsync(context, ct);

    return TypedResults.ServerSentEvents(events);
});

await app.RunAsync();
```

肝心の処理は `AsAGUIEventStreamAsync` の中にあります。実行全体を `RUN_STARTED` と `RUN_FINISHED` で包み、別のメッセージやツール呼び出しに切り替える前に開いたままのテキストブロックや推論ブロックを閉じ、複数の割り込みを1つの終端 `RUN_FINISHED` にまとめます。これはまさに、自前で書いた SSE マッパーが間違えがちな順序のルールであり、開始されていないブロックに対して `TEXT_MESSAGE_CONTENT` を受け取ったフロントエンドは、たいてい何も表示されないまま黙って失敗します。

## クライアント側は .NET Framework 4.7.2 まで届く

`AGUI.Client` は `netstandard2.0` と `net472` もターゲットにしています。その `AGUIChatClient` は `IChatClient` を実装しているため、コードから見ればリモートの AG-UI エージェントも他のモデルと変わりません。

```csharp
using AGUI.Client;

using var httpClient = new HttpClient();
IChatClient agent = new AGUIChatClient(
    new AGUIChatClientOptions(httpClient, "http://localhost:5001"));

await foreach (var update in agent.GetStreamingResponseAsync("Summarize ticket 4211"))
    Console.Write(update.Text);
```

これは、移行を先に済ませることなく、どこか別の場所でホストされているエージェントを呼び出す必要がある、.NET Framework 上のレガシーな WinForms や WPF アプリで役に立ちます。

## Agent Framework ユーザー向けの破壊的な名称変更

すでに `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore`(現在 `1.22.0-preview.260918.1`)を使っていた場合、このホスティングパッケージは今回新しい SDK の上に構築され直され、名前も変わりました。

| 変更前 | 変更後 |
| --- | --- |
| `AddAGUI()` / `MapAGUI()` | `AddAGUIServer()` / `MapAGUIServer()` |
| `Microsoft.Agents.AI.AGUI` 名前空間 | `AGUI.Client`、`AGUI.Server`、`AGUI.Abstractions` |
| `AGUIChatClient` の位置引数コンストラクター | `AGUIChatClientOptions` |

```csharp
builder.Services.AddAGUIServer();
var app = builder.Build();

AIAgent agent = chatClient.AsAIAgent(
    name: "AGUIAssistant",
    instructions: "You are a helpful assistant.");

app.MapAGUIServer("/", agent);
```

先週の [Agent Framework 1.22 の `AsIChatClient`](/ja/2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient/) と組み合わせると、これで両方向の合成が揃いました。`AIAgent` は `IChatClient` になれて、`IChatClient` は AG-UI エンドポイントになれて、AG-UI エンドポイントもまた `IChatClient` に戻れます。CopilotKit 風のフロントエンド向けにストリーミングのチャットバックエンドだけが必要なら、`AGUI.Server` と既存のチャットクライアントを組み合わせるのが、それを正しくこなす最小の依存関係になります。
