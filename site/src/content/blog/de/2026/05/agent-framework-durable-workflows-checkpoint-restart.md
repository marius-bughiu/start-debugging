---
title: "Workflows in Microsoft Agent Framework überleben Prozessneustarts jetzt via Durable Task"
description: "Verpacken Sie einen Agent-Framework-Workflow in Microsoft.Agents.AI.DurableTask, und jeder Executor-Schritt bekommt einen Checkpoint. Crash, Redeploy, Neustart: Der Lauf macht dort weiter, wo er gestoppt wurde."
pubDate: 2026-05-07
tags:
  - "dotnet"
  - "ai-agents"
  - "agent-framework"
  - "csharp"
  - "durable-task"
lang: "de"
translationOf: "2026/05/agent-framework-durable-workflows-checkpoint-restart"
translatedBy: "claude"
translationDate: 2026-05-07
---

Shyju Krishnankutty hat am 2026-05-06 [Durable Workflows in Microsoft Agent Framework](https://devblogs.microsoft.com/dotnet/durable-workflows-in-microsoft-agent-framework/) im .NET Blog veröffentlicht. Die Schlagzeile lautet: Das Workflow-Programmiermodell aus `Microsoft.Agents.AI.Workflows` verbindet sich jetzt über das Prerelease-Paket `Microsoft.Agents.AI.DurableTask` mit dem Durable-Task-Stack. Damit kann ein mehrstufiger Agentenlauf nach jedem Executor einen Checkpoint setzen und nach einem Crash, Skalierungsereignis oder Redeploy in einem anderen Prozess fortgesetzt werden. Das ist das fehlende Stück, um eine Multi-Agent-Pipeline aus der Konsolendemo in eine echte Hosting-Umgebung zu bringen.

## Der Teil, der bereits existierte

Ein Workflow ist ein gerichteter Graph aus `Executor<TInput, TOutput>`-Knoten, verdrahtet mit `WorkflowBuilder`. Dieser Teil steckt im stabilen Paket [Microsoft.Agents.AI.Workflows](https://www.nuget.org/packages/Microsoft.Agents.AI.Workflows) und ist nicht neu:

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

`InProcessExecution.RunStreamingAsync` führt den Graphen im Speicher aus. Stirbt der Host zwischen `orderCancel` und `sendEmail`, ist die Bestellung storniert, die Kundin bekommt nie die E-Mail, und es gibt keinen Retry-Datensatz. Für Beispiele tragbar, für alles, was Geld berührt, riskant.

## Was sich am 2026-05-06 geändert hat

`Microsoft.Agents.AI.DurableTask` lässt denselben Workflow auf Durable Task laufen. Jede Executor-Aufruf wird zu einer Durable-Activity, der Fortschritt bekommt nach jedem Knoten einen Checkpoint, und das Runtime spielt die History beim Neustart erneut ab. Aus der Ankündigung: "Stateful, durable execution: workflows survive process restarts and failures" und "automatic checkpointing: progress is saved after each step".

Kombiniert mit `Microsoft.Agents.AI.Hosting.AzureFunctions` und den Paketen `Microsoft.DurableTask.Client.AzureManaged` / `Microsoft.DurableTask.Worker.AzureManaged` für den Durable Task Scheduler erzeugt ein Azure-Functions-Host den HTTP-Trigger, den Orchestrator und die Activity-Functions automatisch:

```csharp
var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureDurableWorkflows(workflows =>
{
    workflows.AddWorkflow("CancelOrder", sp => BuildCancelOrderWorkflow(sp),
        exposeMcpToolTrigger: true);
});

builder.Build().Run();
```

`exposeMcpToolTrigger: true` verdient eigene Aufmerksamkeit: Der Workflow erscheint als MCP-Tool, sodass ein Claude- oder Copilot-Agent `CancelOrder` aufrufen kann, und das durable Runtime erledigt den Rest.

## Muster, die durch Durability spürbar nützlicher werden

Drei Workflow-Features, die in-process nett, aber optional waren, werden tragend, sobald ein Lauf Stunden dauern darf:

- `AddFanOutEdge()` und `AddFanInBarrierEdge()` für parallele Teilaufgaben (z. B. eine Bestellung aus drei Systemen anreichern und dann zusammenführen), nun sicher fortsetzbar.
- `RequestPort.Create<TRequest, TResponse>()` für Human-in-the-Loop. Der Workflow parkt, persistiert und wacht erst auf, wenn die Antwort eintrifft. Stunden, Tage, egal.
- `AddSwitch()` für bedingtes Routing anhand der Ausgabe eines früheren Executors, was deutlich sicherer ist, als das LLM den nächsten Zweig wählen zu lassen.

Das Paket `Microsoft.Agents.AI.DurableTask` ist noch Prerelease, pinnen Sie die Version also explizit und beobachten Sie den [Microsoft Agent Framework DevBlogs Feed](https://devblogs.microsoft.com/agent-framework/) auf Breaking Changes vor der GA.
