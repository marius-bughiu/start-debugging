---
title: "Declarative Workflows 1.0 do Agent Framework: seu grafo de orquestração agora é um arquivo YAML"
description: "O Microsoft Agent Framework lançou o Declarative Workflows 1.0 em 2026-07-23. O pacote agent-framework-declarative 1.0.0 do Python alcança paridade com o pacote .NET Microsoft.Agents.AI.Workflows.Declarative, então o roteamento multiagente vive em YAML em vez de C#."
pubDate: 2026-07-25
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "yaml"
lang: "pt-br"
translationOf: "2026/07/agent-framework-declarative-workflows-1-0-yaml-orchestration"
translatedBy: "claude"
translationDate: 2026-07-25
---

A Microsoft lançou o [Declarative Workflows 1.0](https://devblogs.microsoft.com/agent-framework/move-agent-orchestration-workflows-out-of-code-with-agent-framework-declarative-workflows-1-0/) para o Agent Framework em 2026-07-23. O destaque é a paridade: o `agent-framework-declarative` do Python chegou ao 1.0.0, igualando o pacote .NET `Microsoft.Agents.AI.Workflows.Declarative`, que já era estável. Os dois agora carregam o mesmo dialeto de YAML e o executam sobre o mesmo runtime de workflows que executa os grafos definidos em código.

Se você construiu um sistema multiagente com os [padrões de orquestração que chegaram ao 1.0 no início deste mês](/2026/07/agent-framework-orchestration-patterns-compared/), escreveu o roteamento em C#. Toda vez que o time de produto queria um novo ramo de triagem, você editava uma cadeia de builders, recompilava e implantava de novo. Os workflows declarativos tiram esse grafo do assembly e o colocam em um arquivo que você pode comparar com diff, revisar e versionar como configuração.

## Como o YAML realmente se parece

Um workflow é um documento `kind: Workflow` com um trigger e uma lista de ações. As expressões são Power Fx, com o prefixo `=`, e leem dos escopos `System.*` e `Local.*`:

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

Esse é o roteador inteiro. `ConditionGroup` dá ramificação, `SetVariable` dá estado e `InvokeAzureAgent` chama um agente do Foundry pelo nome. O conjunto de ações do 1.0 também cobre laços, `InvokeFunctionTool` para funções locais, chamadas a ferramentas MCP e HTTP, pausas com humano no circuito para aprovações, e checkpoint mais retomada.

## Carregando a partir do C#

O lado .NET são dois tipos. `DeclarativeWorkflowOptions` encapsula um provedor de agentes, e `DeclarativeWorkflowBuilder.Build<TInput>` compila o YAML no mesmo objeto `Workflow` que você teria construído na mão:

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

Repare que `Build<string>` é genérico sobre o tipo de entrada, e o `Workflow` retornado flui para o `InProcessExecution` exatamente como um construído programaticamente. O checkpointing, os eventos de streaming e os eventos de erro não mudam, então o código do seu host não se importa com a forma de autoria do grafo.

## Onde isso deixa de ser a ferramenta certa

O declarativo é uma serialização do modelo de workflows, não um substituto dele. Executores personalizados, máquinas de estado sob medida e qualquer coisa que precise de controle de fluxo real além de condições e laços continuam pertencendo ao C#. A divisão prática: coloque o roteamento de agentes e o encadeamento de ferramentas em YAML, onde alguém que não programa consegue ler, e mantenha em código o comportamento realmente personalizado. Você pode misturar os dois em uma única aplicação.

Comece pela [referência de workflows declarativos no MS Learn](https://learn.microsoft.com/en-us/agent-framework/workflows/declarative) para ver o catálogo completo de ações.
