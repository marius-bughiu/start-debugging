---
title: ".NET 11 RC1 の Blazor にエージェント型 UI コンポーネントが登場: ChatPage、UIAgent、ツール承認"
description: "Microsoft.AspNetCore.Components.AI は .NET 11 RC1 の実験的な Blazor パッケージです。任意の IChatClient を、ツール承認、型付きツール表示、AG-UI 経由の共有状態を備えたストリーミングチャット UI に変換します。"
pubDate: 2026-09-29
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnet-core"
  - "ai-agents"
  - "microsoft-extensions-ai"
  - "ag-ui"
lang: "ja"
translationOf: "2026/09/blazor-ai-components-agentic-ui-dotnet-11-rc1"
translatedBy: "claude"
translationDate: 2026-09-29
---

2026年9月28日、Daniel Roth 氏が [Build Agentic UI with the new Blazor AI components](https://devblogs.microsoft.com/dotnet/build-agentic-ui-blazor/) を公開しました。`Microsoft.AspNetCore.Components.AI` を本格的に解説した最初の記事です。このパッケージは [.NET 11 RC1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/aspnetcore.md#experimental-blazor-ai-components-for-agentic-user-interfaces) でひっそりと出荷され、実験的扱いです。.NET 11 のサイクル全体を通してプレリリースのままです。提供されるのは、エージェントのフロントエンドを作るチームが毎回手作業で書き直してきた部分です。ストリーミングメッセージの表示、ツール呼び出しの表示、人間による承認ゲート、そしてエージェントが編集できる状態です。

## IChatClient から動作するチャットページまで

すべては `UIAgent` を中心に構成されています。`UIAgent` は任意の `Microsoft.Extensions.AI` の `IChatClient` をラップし、`ChatResponseUpdate` ストリームを消費して、Razor コンポーネントが表示する監視可能な `ContentBlock` インスタンスに変換します。最短の手順は `ChatPage` です。メッセージ一覧、入力欄、ストリーミング状態、再試行を備えた完成済みのシェルです。

```bash
dotnet add package Microsoft.AspNetCore.Components.AI --prerelease
```

```razor
<link rel="stylesheet" href="@Assets["_content/Microsoft.AspNetCore.Components.AI/ai-chat.css"]" />

<ChatPage Agent="_agent" Placeholder="Type a message...">
    <WelcomeContent>
        <p>Ask the agent a question.</p>
    </WelcomeContent>
</ChatPage>

@code {
    private UIAgent _agent = default!;

    protected override void OnInitialized()
    {
        IChatClient chatClient = GetChatClient();
        _agent = new UIAgent(chatClient);
    }
}
```

シェルでは足りなくなったら、`ChatPage` を `AgentBoundary`、`MessageList`、`MessageInput`、`BlockRenderer<TBlock>` に分解できます。会話のレイアウトを自分で組み、ブロックの種類ごとに Razor のコンテンツを選べます。

## 承認フローと型付きツール表示

私が最も注目しているのは承認フローです。影響の大きいツールを `ApprovalRequiredAIFunction` で包むと、エージェントは `FunctionApprovalBlock` で一時停止し、ユーザーが判断するまで待ちます。

```razor
<BlockRenderer TBlock="FunctionApprovalBlock" Context="block">
    @if (block.Status == ApprovalStatus.Pending)
    {
        <button @onclick="block.Approve">Approve</button>
        <button @onclick="() => block.Reject()">Reject</button>
    }
</BlockRenderer>
```

バックエンドのツールでは、ソースジェネレーターで生成されるブロックで呼び出しの表示方法を宣言し、`options.AddGeneratedToolBlocks()` で登録します。

```csharp
[ToolBlock("get_weather")]
public partial class WeatherToolBlock : FunctionInvocationContentBlock
{
    [ToolParameter(Name = "location")]
    public string? Location { get; set; }

    [ToolResult]
    public WeatherInfo? Weather { get; set; }
}
```

フロントエンドのツールは、`ChatOptions.Tools` に追加する単純な `AIFunctionFactory.Create` のデリゲートです。これにより、モデルがコンポーネントを呼び戻せます (サンプルでは `InvokeAsync` を通じてページのアクセントカラーを設定しています)。

## 共有状態と AG-UI

`UIAgent<TState>` は、エージェントとユーザーが一緒に編集する、厳密に型付けされた状態オブジェクトを追加します。`UIAgentOptions` の `StateMapper` が受信した状態を適用します。予測状態 (predictive state) を使うと、エージェントが変更を仮に用意し、UI 側が `AcceptPredictiveState()` で確定するか、`RejectPredictiveState()` で破棄できます。

状態は [AG-UI](https://docs.ag-ui.com/sdk/dotnet) を介して送られます。`STATE_SNAPSHOT` は状態を置き換え、`STATE_DELTA` は RFC 6902 JSON Patch で更新し、`REASONING_*` イベントは折りたたみ可能な推論パネルとして表示されます。UI をリモートのエージェントに向けるには、モデルクライアントの代わりに `AGUIChatClient` を `UIAgent` に渡します。

```csharp
HttpClient http = httpClientFactory.CreateClient("agentserver");
IChatClient client = new AGUIChatClient(new AGUIChatClientOptions(http, endpoint));
```

サーバー側は `AddAGUIServer()` と `MapAGUIServer("/agentic_chat", agent)` です。`Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` か `AGUI.Server` のどちらでも使えます。後者は、私が [AG-UI .NET SDK 1.0](/ja/2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework/) で取り上げたスタンドアロンのパッケージです。

## もう使うべきか

.NET 11 RC1 SDK が必要で、API は明示的にフィードバックを募集している段階なので、GA までに名前が変わることを想定してください。新しい社内向けエージェントツールであれば、`IChatClient` から承認ゲート付きの UI までの最短経路としてすでに有力です。シナリオの全体は [AgenticUI サンプルリポジトリ](https://github.com/danroth27/AgenticUI) にあります。
