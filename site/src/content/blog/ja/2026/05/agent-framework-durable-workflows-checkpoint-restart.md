---
title: "Microsoft Agent Framework のワークフローが Durable Task スタックでプロセス再起動を生き延びるようになりました"
description: "Agent Framework のワークフローを Microsoft.Agents.AI.DurableTask で包むと、各エグゼキュータステップにチェックポイントが入ります。クラッシュ、再デプロイ、再起動でも、停止した場所から続行されます。"
pubDate: 2026-05-07
tags:
  - "dotnet"
  - "ai-agents"
  - "agent-framework"
  - "csharp"
  - "durable-task"
lang: "ja"
translationOf: "2026/05/agent-framework-durable-workflows-checkpoint-restart"
translatedBy: "claude"
translationDate: 2026-05-07
---

Shyju Krishnankutty が 2026-05-06 に .NET Blog で [Durable Workflows in Microsoft Agent Framework](https://devblogs.microsoft.com/dotnet/durable-workflows-in-microsoft-agent-framework/) を公開しました。見出しは、`Microsoft.Agents.AI.Workflows` のワークフロープログラミングモデルが、プレリリースの `Microsoft.Agents.AI.DurableTask` パッケージ経由で Durable Task スタックに接続できるようになったことです。これにより、マルチステップのエージェント実行は各エグゼキュータの後にチェックポイントを取り、クラッシュ、スケーリングイベント、再デプロイの後に別のプロセスで再開できます。マルチエージェントパイプラインをコンソールデモから実際にホスティングできるものへと持ち上げるために欠けていたピースです。

## 既にあった部分

ワークフローは `Executor<TInput, TOutput>` ノードからなる有向グラフで、`WorkflowBuilder` で配線します。この部分は安定版の [Microsoft.Agents.AI.Workflows](https://www.nuget.org/packages/Microsoft.Agents.AI.Workflows) パッケージに含まれており、新しくはありません。

```csharp
using Microsoft.Agents.AI.Workflows;

Workflow cancelOrder = new WorkflowBuilder(orderLookup)
    .WithName("CancelOrder")
    .AddEdge(orderLookup, orderCancel)
    .AddEdge(orderCancel, sendEmail)
    .Build();

await foreach (var evt in InProcessExecution.RunStreamingAsync(cancelOrder, orderId))
{
    Console.WriteLine(evt);
}
```

`InProcessExecution.RunStreamingAsync` はグラフをメモリ内で実行します。`orderCancel` と `sendEmail` の間でホストが死ぬと、注文はキャンセル済みなのに顧客はメールを受け取れず、リトライ記録もありません。サンプルなら問題ありませんが、お金が絡むものには危険です。

## 2026-05-06 に変わったこと

`Microsoft.Agents.AI.DurableTask` を使うと、同じワークフローを Durable Task の上で実行できます。各エグゼキュータの呼び出しが Durable アクティビティになるため、各ノードの後で進捗にチェックポイントが入り、再起動時にはランタイムが履歴を再生します。発表から: "Stateful, durable execution: workflows survive process restarts and failures" と "automatic checkpointing: progress is saved after each step"。

`Microsoft.Agents.AI.Hosting.AzureFunctions` と、Durable Task Scheduler を対象とする `Microsoft.DurableTask.Client.AzureManaged` / `Microsoft.DurableTask.Worker.AzureManaged` パッケージを組み合わせると、Azure Functions ホストが HTTP トリガー、オーケストレータ、アクティビティ関数を自動生成してくれます。

```csharp
var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureDurableWorkflows(workflows =>
{
    workflows.AddWorkflow("CancelOrder", sp => BuildCancelOrderWorkflow(sp),
        exposeMcpToolTrigger: true);
});

builder.Build().Run();
```

`exposeMcpToolTrigger: true` はそれ自体が注目に値します。ワークフローが MCP ツールとして公開されるため、Claude や Copilot のエージェントが `CancelOrder` を呼び出すと、あとは durable ランタイムが面倒を見てくれます。

## 永続性が有効になると効いてくるパターン

インプロセスでは「あれば便利」だったワークフロー機能のうち 3 つは、実行が数時間に及び得るようになると基幹的なものになります。

- `AddFanOutEdge()` と `AddFanInBarrierEdge()` で並列サブタスク（例えば 3 つのシステムから注文を補強してマージする）を、安全に再開可能なかたちで構成できます。
- `RequestPort.Create<TRequest, TResponse>()` でヒューマンインザループ。ワークフローは駐機して永続化され、応答が届いたときにだけ目覚めます。何時間でも、何日でも構いません。
- `AddSwitch()` は前のエグゼキュータの出力に基づく条件付きルーティングで、LLM に次の分岐を選ばせるよりはるかに安全なパターンです。

`Microsoft.Agents.AI.DurableTask` パッケージはまだプレリリースなので、バージョンは明示的にピン留めし、GA より前の破壊的変更については [Microsoft Agent Framework DevBlogs フィード](https://devblogs.microsoft.com/agent-framework/) を確認してください。
