---
title: "Os workflows do Microsoft Agent Framework agora sobrevivem a reinícios de processo via o stack Durable Task"
description: "Embrulhe um Workflow do Agent Framework em Microsoft.Agents.AI.DurableTask e cada passo de executor recebe checkpoint. Crash, redeploy, restart: a execução continua de onde parou."
pubDate: 2026-05-07
tags:
  - "dotnet"
  - "ai-agents"
  - "agent-framework"
  - "csharp"
  - "durable-task"
lang: "pt-br"
translationOf: "2026/05/agent-framework-durable-workflows-checkpoint-restart"
translatedBy: "claude"
translationDate: 2026-05-07
---

Shyju Krishnankutty publicou [Durable Workflows in Microsoft Agent Framework](https://devblogs.microsoft.com/dotnet/durable-workflows-in-microsoft-agent-framework/) no .NET Blog em 2026-05-06. A manchete é que o modelo de programação de workflows de `Microsoft.Agents.AI.Workflows` agora se conecta ao stack Durable Task pelo pacote prerelease `Microsoft.Agents.AI.DurableTask`, de modo que uma execução multi-passo de um agente pode fazer checkpoint após cada executor e retomar em outro processo após uma queda, evento de escalonamento ou redeploy. Esta é a peça que faltava para tirar um pipeline multi-agente de uma demo de console e levar para algo que você consiga realmente hospedar.

## A parte que já existia

Um workflow é um grafo dirigido de nós `Executor<TInput, TOutput>` ligados com `WorkflowBuilder`. Esta parte está no pacote estável [Microsoft.Agents.AI.Workflows](https://www.nuget.org/packages/Microsoft.Agents.AI.Workflows) e não é nova:

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

`InProcessExecution.RunStreamingAsync` executa o grafo em memória. Se o host morre entre `orderCancel` e `sendEmail`, o pedido fica cancelado, o cliente nunca recebe o e-mail, e não há registro de retry. Suficiente para amostras, perigoso para qualquer coisa que toque dinheiro.

## O que mudou em 2026-05-06

`Microsoft.Agents.AI.DurableTask` permite executar o mesmo workflow sobre Durable Task. Cada invocação de executor vira uma atividade Durable, então o progresso recebe checkpoint após cada nó e o runtime reproduz o histórico ao reiniciar. Do anúncio: "Stateful, durable execution: workflows survive process restarts and failures" e "automatic checkpointing: progress is saved after each step".

Combinado com `Microsoft.Agents.AI.Hosting.AzureFunctions` e os pacotes `Microsoft.DurableTask.Client.AzureManaged` / `Microsoft.DurableTask.Worker.AzureManaged` apontando para o Durable Task Scheduler, um host Azure Functions gera para você o trigger HTTP, o orquestrador e as funções de atividade:

```csharp
var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureDurableWorkflows(workflows =>
{
    workflows.AddWorkflow("CancelOrder", sp => BuildCancelOrderWorkflow(sp),
        exposeMcpToolTrigger: true);
});

builder.Build().Run();
```

`exposeMcpToolTrigger: true` é o detalhe que merece destaque por si só: o workflow aparece como uma ferramenta MCP, então um agente Claude ou Copilot pode chamar `CancelOrder` e o runtime durável cuida do resto.

## Padrões que ficam mais úteis com a durabilidade ativada

Três características de workflows que eram bons-de-ter em processo passam a ser estruturais quando a execução pode durar horas:

- `AddFanOutEdge()` e `AddFanInBarrierEdge()` para subtarefas paralelas (por exemplo, enriquecer um pedido a partir de três sistemas e depois mesclar), agora retomáveis com segurança.
- `RequestPort.Create<TRequest, TResponse>()` para humano no loop. O workflow estaciona, persiste e só acorda quando a resposta chega. Horas, dias, o que for.
- `AddSwitch()` para roteamento condicional baseado na saída de um executor anterior, que é um padrão bem mais seguro do que deixar o LLM escolher a próxima ramificação.

O pacote `Microsoft.Agents.AI.DurableTask` ainda é prerelease, então fixe a versão explicitamente e fique de olho no [feed do Microsoft Agent Framework DevBlogs](https://devblogs.microsoft.com/agent-framework/) por mudanças que quebrem compatibilidade antes do GA.
