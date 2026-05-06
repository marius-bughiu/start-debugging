---
title: "Microsoft Agent Framework は FunctionApprovalRequestContent でリスクの高いツール呼び出しをゲートします"
description: "AIFunction を ApprovalRequiredAIFunction でラップすると、エージェントは実行の途中で停止して許可を求めます。C# でのリクエストとレスポンスのフローを解説します。"
pubDate: 2026-05-06
tags:
  - "dotnet"
  - "ai-agents"
  - "agent-framework"
  - "csharp"
  - "human-in-the-loop"
lang: "ja"
translationOf: "2026/05/agent-framework-human-in-the-loop-tool-approval-csharp"
translatedBy: "claude"
translationDate: 2026-05-06
---

Jeremy Likness は 2026 年 5 月 4 日に [Building Blocks for AI Part 3](https://devblogs.microsoft.com/dotnet/microsoft-agent-framework-building-blocks-for-ai-part-3/) を .NET Blog で公開しました。エージェントを本番に投入する人にとって注目すべき部分は、ツール呼び出しの human-in-the-loop 承認フローです。Microsoft Agent Framework 1.0（NuGet 上の `Microsoft.Agents.AI`）では、これを第一級の実行状態として扱います。機微なツールが呼び出されると、エージェントはそれを呼び出しません。一時停止して呼び出しを表に出し、アプリケーションがそれを承認または拒否するまで、次の実行は続きません。

## 関数を承認必須としてマークする

ラッパーは `ApprovalRequiredAIFunction` です。デリゲートから通常の `AIFunction` を作成し、一度ラップしてから、ラップ済みのインスタンスを `AsAIAgent` に渡します。モデルからは同じスキーマが見えており、変わるのはフレームワーク側の呼び出し箇所だけです。

```csharp
using System.ComponentModel;
using Azure.AI.Projects;
using Azure.Identity;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

[Description("Get the weather for a given location.")]
static string GetWeather([Description("The location to get the weather for.")] string location)
    => $"The weather in {location} is cloudy with a high of 15C.";

AIFunction weatherFunction = AIFunctionFactory.Create(GetWeather);
AIFunction approvalRequired = new ApprovalRequiredAIFunction(weatherFunction);

AIAgent agent = new AIProjectClient(
    new Uri("<your-foundry-project-endpoint>"),
    new DefaultAzureCredential())
    .AsAIAgent(
        model: "gpt-4o-mini",
        instructions: "You are a helpful assistant",
        tools: [approvalRequired]);
```

関数本体は変更しません。確認ステップを必要とすべきもの（DB への書き込み、決済呼び出し、送信メール、ハルシネーションした引数で発火させたくないものすべて）にラッパーを付与し、それ以外には付けません。

## リクエストを検出する

モデルが承認ゲート付きのツールを呼び出すと判断した場合、フレームワークはツールの戻り値の代わりに 1 つ以上の `FunctionApprovalRequestContent` 項目を含むレスポンスを返します。各 `RunAsync` の後、メッセージのコンテンツを走査してそれらを探します。

```csharp
AgentSession session = await agent.CreateSessionAsync();
AgentResponse response = await agent.RunAsync(
    "What is the weather like in Amsterdam?", session);

var requests = response.Messages
    .SelectMany(m => m.Contents)
    .OfType<FunctionApprovalRequestContent>()
    .ToList();

foreach (var req in requests)
{
    Console.WriteLine($"Approval needed for {req.FunctionCall.Name}");
    Console.WriteLine($"Arguments: {req.FunctionCall.Arguments}");
}
```

`FunctionCall.Name` と `FunctionCall.Arguments` がユーザーに表示する内容です。関数名だけでなく、実際の引数を表示してください。このゲートの本質は、モデルが引数を選んだという点にあり、`delete_account(id: 42)` こそ人間の目で見るべき部分です。

## レスポンスを返送する

レスポンスはリクエスト自体から構築します。`requestContent.CreateResponse(true)` は `FunctionApprovalResponseContent` を生成し、拒否する場合は `false` を渡します。これをユーザーの `ChatMessage` でラップし、同じセッションで再度実行すると、エージェントはツールを実行するか、その結果なしで処理を続行します。

```csharp
var approvalMessage = new ChatMessage(
    ChatRole.User,
    [requests[0].CreateResponse(approve: true)]);

AgentResponse final = await agent.RunAsync(approvalMessage, session);
Console.WriteLine(final);
```

## 仮定せず、ループする

1 回のユーザーターンで複数の承認リクエストが発生することがあり、特に呼び出しをバッチ化するプランナーではよくあります。ドキュメントは明確です。レスポンスに `FunctionApprovalRequestContent` が含まれなくなるまで、各実行の後にチェックを続けてください。最初のリクエストだけを処理して終わりにすると、後続のツール呼び出しが暗黙のうちに失われ、データが欠落したレスポンスになってしまいます。

ワークフローのシナリオでは、`AgentWorkflowBuilder.BuildSequential()` が承認の契約をすでに理解しています。ワークフローを一時停止し、追加の配線なしで `RequestInfoEvent` を発行します。完全な実行可能サンプルは [microsoft/agent-framework リポジトリ](https://github.com/microsoft/agent-framework/tree/main/dotnet/samples/02-agents/Agents/Agent_Step01_UsingFunctionToolsWithApprovals) にあり、API は [learn.microsoft.com](https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval) で文書化されています。
