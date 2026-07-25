---
title: "Declarative Workflows 1.0 de Agent Framework: tu grafo de orquestación ahora es un archivo YAML"
description: "Microsoft Agent Framework lanzó Declarative Workflows 1.0 el 2026-07-23. El paquete agent-framework-declarative 1.0.0 de Python alcanza la paridad con el paquete .NET Microsoft.Agents.AI.Workflows.Declarative, así que el enrutamiento multiagente vive en YAML en vez de C#."
pubDate: 2026-07-25
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "yaml"
lang: "es"
translationOf: "2026/07/agent-framework-declarative-workflows-1-0-yaml-orchestration"
translatedBy: "claude"
translationDate: 2026-07-25
---

Microsoft lanzó [Declarative Workflows 1.0](https://devblogs.microsoft.com/agent-framework/move-agent-orchestration-workflows-out-of-code-with-agent-framework-declarative-workflows-1-0/) para Agent Framework el 2026-07-23. El titular es la paridad: `agent-framework-declarative` de Python llegó a 1.0.0, igualando al paquete .NET `Microsoft.Agents.AI.Workflows.Declarative`, que ya era estable. Ambos cargan ahora el mismo dialecto de YAML y lo ejecutan sobre el mismo runtime de workflows que ejecuta los grafos definidos en código.

Si construiste un sistema multiagente con los [patrones de orquestación que llegaron a 1.0 a principios de este mes](/2026/07/agent-framework-orchestration-patterns-compared/), escribiste el enrutamiento en C#. Cada vez que producto quería una nueva rama de triaje, editabas una cadena de builders, recompilabas e implementabas de nuevo. Los workflows declarativos sacan ese grafo del ensamblado y lo llevan a un archivo que puedes revisar con diff, someter a revisión y versionar como si fuera configuración.

## Cómo se ve el YAML en la práctica

Un workflow es un documento `kind: Workflow` con un trigger y una lista de acciones. Las expresiones son Power Fx, con el prefijo `=`, y leen de los ámbitos `System.*` y `Local.*`:

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

Ese es el router completo. `ConditionGroup` te da ramificación, `SetVariable` te da estado e `InvokeAzureAgent` llama a un agente de Foundry por nombre. El conjunto de acciones de 1.0 también cubre bucles, `InvokeFunctionTool` para funciones locales, llamadas a herramientas MCP y HTTP, pausas con humano en el circuito para aprobaciones, y checkpoint más reanudación.

## Cargarlo desde C#

El lado de .NET son dos tipos. `DeclarativeWorkflowOptions` envuelve un proveedor de agentes, y `DeclarativeWorkflowBuilder.Build<TInput>` compila el YAML en el mismo objeto `Workflow` que habrías construido a mano:

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

Fíjate en que `Build<string>` es genérico sobre el tipo de entrada, y el `Workflow` devuelto fluye hacia `InProcessExecution` exactamente igual que uno construido programáticamente. El checkpointing, los eventos de streaming y los eventos de error no cambian, así que a tu código de host no le importa de qué forma se creó el grafo.

## Dónde deja de ser la herramienta correcta

Lo declarativo es una serialización del modelo de workflows, no un reemplazo. Los ejecutores personalizados, las máquinas de estado a medida y todo lo que necesite control de flujo real más allá de condiciones y bucles siguen perteneciendo a C#. La división práctica: pon el enrutamiento de agentes y el encadenamiento de herramientas en YAML, donde alguien que no programa pueda leerlo, y mantén en código el comportamiento verdaderamente personalizado. Puedes mezclar ambos en una sola aplicación.

Empieza por la [referencia de workflows declarativos en MS Learn](https://learn.microsoft.com/en-us/agent-framework/workflows/declarative) para ver el catálogo completo de acciones.
