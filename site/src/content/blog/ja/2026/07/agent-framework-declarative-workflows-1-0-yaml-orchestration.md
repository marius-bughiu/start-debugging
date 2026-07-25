---
title: "Agent Framework Declarative Workflows 1.0: オーケストレーションのグラフが YAML ファイルになりました"
description: "Microsoft Agent Framework は 2026-07-23 に Declarative Workflows 1.0 をリリースしました。Python の agent-framework-declarative 1.0.0 が .NET の Microsoft.Agents.AI.Workflows.Declarative パッケージと同等になり、マルチエージェントのルーティングが C# ではなく YAML に置けるようになりました。"
pubDate: 2026-07-25
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "yaml"
lang: "ja"
translationOf: "2026/07/agent-framework-declarative-workflows-1-0-yaml-orchestration"
translatedBy: "claude"
translationDate: 2026-07-25
---

Microsoft は 2026-07-23 に Agent Framework 向けの [Declarative Workflows 1.0](https://devblogs.microsoft.com/agent-framework/move-agent-orchestration-workflows-out-of-code-with-agent-framework-declarative-workflows-1-0/) をリリースしました。要点は同等性です。Python の `agent-framework-declarative` が 1.0.0 に到達し、すでに安定版だった .NET の `Microsoft.Agents.AI.Workflows.Declarative` パッケージに追いつきました。両者は同じ YAML の方言を読み込み、コードで定義したグラフを動かすのと同じワークフローランタイム上で実行します。

[今月初めに 1.0 へ到達したオーケストレーションパターン](/2026/07/agent-framework-orchestration-patterns-compared/)でマルチエージェントシステムを構築した場合、ルーティングは C# で書いていたはずです。プロダクト側がトリアージの分岐を追加したいと言うたびに、ビルダーのチェーンを編集し、再ビルドし、デプロイし直す必要がありました。宣言的ワークフローはそのグラフをアセンブリの外に出し、diff で比較でき、レビューにかけられ、構成ファイルと同じようにバージョン管理できるファイルにします。

## YAML は実際どう書くのか

ワークフローは `kind: Workflow` のドキュメントで、トリガーとアクションのリストを持ちます。式は Power Fx で、先頭に `=` を付け、`System.*` と `Local.*` のスコープから読み取ります。

```yaml
kind: Workflow
trigger:
  kind: OnConversationStart
  id: support_router
  actions:
    - kind: SetVariable
      id: set_category
      variable: Local.category
      value: =System.LastMessage.Text

    - kind: ConditionGroup
      id: route_request
      conditions:
        - condition: =Local.category = "billing"
          id: billing_route
          actions:
            - kind: InvokeAzureAgent
              id: billing_agent
              agent:
                name: BillingAgent
              conversationId: =System.ConversationId
      elseActions:
        - kind: InvokeAzureAgent
          id: general_agent
          agent:
            name: GeneralAgent
          conversationId: =System.ConversationId
```

これでルーターは全部です。`ConditionGroup` が分岐を、`SetVariable` が状態を提供し、`InvokeAzureAgent` が名前付きの Foundry エージェントを呼び出します。1.0 のアクションセットにはループ、ローカル関数を呼ぶ `InvokeFunctionTool`、MCP と HTTP のツール呼び出し、承認のための human-in-the-loop の一時停止、チェックポイントと再開も含まれます。

## C# から読み込む

.NET 側は 2 つの型だけです。`DeclarativeWorkflowOptions` がエージェントプロバイダーをラップし、`DeclarativeWorkflowBuilder.Build<TInput>` が YAML を、手書きで組み立てた場合と同じ `Workflow` オブジェクトへコンパイルします。

```csharp
using Azure.Identity;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Agents.AI.Workflows.Declarative;

AzureAgentProvider agentProvider = new(
    new Uri(foundryEndpoint),
    new DefaultAzureCredential());

DeclarativeWorkflowOptions options = new(agentProvider)
{
    Configuration = configuration,
};

Workflow workflow = DeclarativeWorkflowBuilder.Build<string>(
    Path.Combine(AppContext.BaseDirectory, "support-router.yaml"),
    options);

StreamingRun run = await InProcessExecution.RunStreamingAsync(
    workflow,
    "billing",
    CheckpointManager.CreateInMemory());

await foreach (WorkflowEvent evt in run.WatchStreamAsync())
{
    if (evt is AgentResponseEvent response)
    {
        Console.WriteLine(response.Response.Text);
    }
}
```

`Build<string>` が入力型でジェネリックになっている点、そして返された `Workflow` がプログラムで構築したものとまったく同じように `InProcessExecution` へ渡る点に注目してください。チェックポイント、ストリーミングのイベント、エラーイベントはいずれも変わらないため、ホスト側のコードはグラフがどちらの方法で書かれたかを気にしません。

## これが適切な道具ではなくなる場面

宣言的な形式はワークフローモデルのシリアライズであり、置き換えではありません。カスタムのエグゼキューター、独自のステートマシン、条件とループを超える本格的な制御フローが必要なものは、引き続き C# の領域です。実務上の分け方はこうです。エージェントのルーティングとツールの順序付けは、開発者でなくても読める YAML に置き、本当にカスタムな振る舞いはコード側に残します。1 つのアプリケーションで両方を混在させることもできます。

アクションの一覧は [MS Learn の宣言的ワークフローのリファレンス](https://learn.microsoft.com/en-us/agent-framework/workflows/declarative) から確認してください。
