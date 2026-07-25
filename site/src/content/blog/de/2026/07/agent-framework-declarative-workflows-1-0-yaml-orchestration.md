---
title: "Agent Framework Declarative Workflows 1.0: Der Orchestrierungsgraph ist jetzt eine YAML-Datei"
description: "Microsoft Agent Framework hat am 2026-07-23 Declarative Workflows 1.0 veröffentlicht. Das Python-Paket agent-framework-declarative 1.0.0 erreicht Parität mit dem .NET-Paket Microsoft.Agents.AI.Workflows.Declarative, sodass Multi-Agent-Routing in YAML statt in C# liegt."
pubDate: 2026-07-25
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "yaml"
lang: "de"
translationOf: "2026/07/agent-framework-declarative-workflows-1-0-yaml-orchestration"
translatedBy: "claude"
translationDate: 2026-07-25
---

Microsoft hat am 2026-07-23 [Declarative Workflows 1.0](https://devblogs.microsoft.com/agent-framework/move-agent-orchestration-workflows-out-of-code-with-agent-framework-declarative-workflows-1-0/) für das Agent Framework veröffentlicht. Die Schlagzeile ist Parität: Pythons `agent-framework-declarative` hat 1.0.0 erreicht und liegt damit gleichauf mit dem bereits stabilen .NET-Paket `Microsoft.Agents.AI.Workflows.Declarative`. Beide laden nun denselben YAML-Dialekt und führen ihn auf derselben Workflow-Laufzeit aus, die auch codebasierte Graphen ausführt.

Wer ein Multi-Agent-System mit den [Orchestrierungsmustern gebaut hat, die Anfang dieses Monats 1.0 erreichten](/2026/07/agent-framework-orchestration-patterns-compared/), hat das Routing in C# geschrieben. Jedes Mal, wenn das Produktteam einen neuen Triage-Zweig wollte, wurde eine Builder-Kette bearbeitet, neu kompiliert und neu bereitgestellt. Deklarative Workflows holen diesen Graphen aus der Assembly heraus in eine Datei, die sich per Diff vergleichen, im Review prüfen und wie Konfiguration versionieren lässt.

## Wie das YAML tatsächlich aussieht

Ein Workflow ist ein Dokument mit `kind: Workflow`, einem Trigger und einer Liste von Aktionen. Ausdrücke sind Power Fx, mit `=` als Präfix, und lesen aus den Gültigkeitsbereichen `System.*` und `Local.*`:

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

Das ist der komplette Router. `ConditionGroup` liefert Verzweigung, `SetVariable` liefert Zustand, und `InvokeAzureAgent` ruft einen benannten Foundry-Agenten auf. Der Aktionsumfang von 1.0 deckt außerdem Schleifen ab, `InvokeFunctionTool` für lokale Funktionen, MCP- und HTTP-Toolaufrufe, Human-in-the-Loop-Pausen für Freigaben sowie Checkpoint und Fortsetzung.

## Laden aus C#

Auf der .NET-Seite sind es zwei Typen. `DeclarativeWorkflowOptions` kapselt einen Agent-Provider, und `DeclarativeWorkflowBuilder.Build<TInput>` kompiliert das YAML in dasselbe `Workflow`-Objekt, das man sonst von Hand gebaut hätte:

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

Beachtenswert: `Build<string>` ist generisch über den Eingabetyp, und das zurückgegebene `Workflow` fließt genauso in `InProcessExecution` wie ein programmatisch gebautes. Checkpointing, Streaming-Ereignisse und Fehlerereignisse bleiben unverändert, der Host-Code kennt den Unterschied also gar nicht.

## Wo das nicht mehr das richtige Werkzeug ist

Deklarativ ist eine Serialisierung des Workflow-Modells, kein Ersatz dafür. Eigene Executor-Implementierungen, maßgeschneiderte Zustandsautomaten und alles, was echten Kontrollfluss jenseits von Bedingungen und Schleifen braucht, gehört weiterhin nach C#. Die praktische Aufteilung: Agent-Routing und Tool-Abfolgen ins YAML, wo auch Nicht-Entwickler sie lesen können, und wirklich individuelles Verhalten im Code belassen. Beides lässt sich in einer Anwendung kombinieren.

Den vollständigen Aktionskatalog liefert die [Referenz zu deklarativen Workflows auf MS Learn](https://learn.microsoft.com/en-us/agent-framework/workflows/declarative).
