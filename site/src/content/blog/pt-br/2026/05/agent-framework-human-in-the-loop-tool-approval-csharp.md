---
title: "Microsoft Agent Framework controla chamadas de ferramentas arriscadas com FunctionApprovalRequestContent"
description: "Envolva um AIFunction em ApprovalRequiredAIFunction e o agente para no meio da execução para pedir permissão. Veja como funciona o fluxo de requisição e resposta em C#."
pubDate: 2026-05-06
tags:
  - "dotnet"
  - "ai-agents"
  - "agent-framework"
  - "csharp"
  - "human-in-the-loop"
lang: "pt-br"
translationOf: "2026/05/agent-framework-human-in-the-loop-tool-approval-csharp"
translatedBy: "claude"
translationDate: 2026-05-06
---

Jeremy Likness publicou [Building Blocks for AI Part 3](https://devblogs.microsoft.com/dotnet/microsoft-agent-framework-building-blocks-for-ai-part-3/) no .NET Blog em 4 de maio de 2026, e a parte que vale a pena destacar para quem coloca agentes em produção é o fluxo de aprovação humana no laço de chamadas de ferramentas. O Microsoft Agent Framework 1.0 (`Microsoft.Agents.AI` no NuGet) trata isso como um estado de execução de primeira classe: quando uma ferramenta sensível é invocada, o agente não a chama. Ele pausa, expõe a chamada e espera que sua aplicação aprove ou rejeite antes que a próxima execução continue.

## Marque uma função como exigindo aprovação

O wrapper é `ApprovalRequiredAIFunction`. Você constrói um `AIFunction` normal a partir de um delegate, envolve uma vez e depois passa a instância envolvida para `AsAIAgent`. O modelo continua vendo o mesmo schema; apenas o ponto de chamada do framework muda.

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

Você não muda o corpo da função. Qualquer coisa que deva exigir um passo de confirmação (escritas no banco de dados, chamadas de pagamento, e-mails de saída, qualquer coisa que você não queira que um argumento alucinado dispare) recebe o wrapper, e somente essas.

## Detecte a requisição

Quando o modelo decide chamar uma ferramenta gated por aprovação, o framework retorna uma resposta que contém um ou mais itens `FunctionApprovalRequestContent` em vez do valor de retorno da ferramenta. Depois de cada `RunAsync`, você varre o conteúdo das mensagens em busca deles.

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

`FunctionCall.Name` e `FunctionCall.Arguments` são o que você renderiza para o usuário. Mostre os argumentos reais, não apenas o nome da função. O propósito do gate é que o modelo escolheu os argumentos, e `delete_account(id: 42)` é a parte sobre a qual você quer um olho humano.

## Devolva a resposta

A resposta é construída a partir da própria requisição. `requestContent.CreateResponse(true)` produz um `FunctionApprovalResponseContent`; passe `false` para rejeitar. Envolva em um `ChatMessage` de usuário, execute novamente na mesma sessão, e o agente ou executa a ferramenta ou prossegue sem o resultado dela.

```csharp
var approvalMessage = new ChatMessage(
    ChatRole.User,
    [requests[0].CreateResponse(approve: true)]);

AgentResponse final = await agent.RunAsync(approvalMessage, session);
Console.WriteLine(final);
```

## Itere, não assuma

Um único turno de usuário pode produzir várias requisições de aprovação, especialmente com um planejador que agrupa chamadas. A documentação é explícita: continue procurando por `FunctionApprovalRequestContent` depois de cada execução até que a resposta não contenha nenhum. Se você tratar apenas a primeira requisição e considerar finalizado, vai descartar silenciosamente as chamadas de ferramenta subsequentes e terminar com uma resposta que está faltando dados.

Para cenários de workflow, `AgentWorkflowBuilder.BuildSequential()` já entende o contrato de aprovação: pausa o workflow e emite um `RequestInfoEvent`, sem encanamento extra. Exemplo executável completo no [repositório microsoft/agent-framework](https://github.com/microsoft/agent-framework/tree/main/dotnet/samples/02-agents/Agents/Agent_Step01_UsingFunctionToolsWithApprovals), e a API está documentada em [learn.microsoft.com](https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval).
