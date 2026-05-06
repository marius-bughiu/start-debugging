---
title: "Microsoft Agent Framework пропускает рискованные вызовы инструментов через FunctionApprovalRequestContent"
description: "Оберните AIFunction в ApprovalRequiredAIFunction, и агент остановится посреди выполнения, чтобы запросить разрешение. Вот как работает поток запроса и ответа в C#."
pubDate: 2026-05-06
tags:
  - "dotnet"
  - "ai-agents"
  - "agent-framework"
  - "csharp"
  - "human-in-the-loop"
lang: "ru"
translationOf: "2026/05/agent-framework-human-in-the-loop-tool-approval-csharp"
translatedBy: "claude"
translationDate: 2026-05-06
---

Джереми Ликнесс опубликовал [Building Blocks for AI Part 3](https://devblogs.microsoft.com/dotnet/microsoft-agent-framework-building-blocks-for-ai-part-3/) в .NET Blog 4 мая 2026 года, и часть, которую стоит выделить для всех, кто выводит агентов в продакшен, это поток одобрения вызовов инструментов с участием человека. Microsoft Agent Framework 1.0 (`Microsoft.Agents.AI` в NuGet) рассматривает это как первоклассное состояние выполнения: когда вызывается чувствительный инструмент, агент не вызывает его. Он приостанавливается, выводит вызов наружу и ждёт, пока ваше приложение одобрит или отклонит его, прежде чем следующее выполнение продолжится.

## Пометьте функцию как требующую одобрения

Обёртка это `ApprovalRequiredAIFunction`. Вы создаёте обычный `AIFunction` из делегата, оборачиваете его один раз и затем передаёте обёрнутый экземпляр в `AsAIAgent`. Модель по-прежнему видит ту же схему; меняется только место вызова со стороны фреймворка.

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

Тело функции не меняется. Всё, что должно требовать шага подтверждения (записи в базу данных, платёжные вызовы, исходящая почта, всё, что вы не хотите запускать галлюцинированным аргументом), получает обёртку, и только это.

## Обнаружьте запрос

Когда модель решает вызвать инструмент с обязательным одобрением, фреймворк возвращает ответ, содержащий один или несколько элементов `FunctionApprovalRequestContent` вместо возвращаемого значения инструмента. После каждого `RunAsync` вы сканируете содержимое сообщений в их поиске.

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

`FunctionCall.Name` и `FunctionCall.Arguments` это то, что вы выводите пользователю. Покажите фактические аргументы, а не только имя функции. Весь смысл этой преграды в том, что модель сама выбрала аргументы, и `delete_account(id: 42)` это та часть, на которую вы хотите взгляд человека.

## Отправьте ответ обратно

Ответ строится из самого запроса. `requestContent.CreateResponse(true)` производит `FunctionApprovalResponseContent`; передайте `false`, чтобы отклонить. Оберните это в пользовательское `ChatMessage`, запустите снова на той же сессии, и агент либо выполнит инструмент, либо продолжит без его результата.

```csharp
var approvalMessage = new ChatMessage(
    ChatRole.User,
    [requests[0].CreateResponse(approve: true)]);

AgentResponse final = await agent.RunAsync(approvalMessage, session);
Console.WriteLine(final);
```

## Циклитесь, не предполагайте

Один пользовательский ход может породить несколько запросов на одобрение, особенно с планировщиком, который пакетирует вызовы. Документация это явно подчёркивает: продолжайте искать `FunctionApprovalRequestContent` после каждого выполнения, пока ответ не перестанет их содержать. Если вы обработаете только первый запрос и сочтёте дело сделанным, вы тихо потеряете последующие вызовы инструментов и получите ответ, в котором не хватает данных.

Для сценариев workflow, `AgentWorkflowBuilder.BuildSequential()` уже понимает контракт одобрения: он приостанавливает workflow и испускает `RequestInfoEvent`, без дополнительной проводки. Полный исполняемый пример в [репозитории microsoft/agent-framework](https://github.com/microsoft/agent-framework/tree/main/dotnet/samples/02-agents/Agents/Agent_Step01_UsingFunctionToolsWithApprovals), и API задокументирован на [learn.microsoft.com](https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval).
