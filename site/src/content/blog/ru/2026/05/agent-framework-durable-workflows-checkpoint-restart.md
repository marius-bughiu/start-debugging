---
title: "Workflow в Microsoft Agent Framework теперь переживают перезапуск процесса благодаря стеку Durable Task"
description: "Оберните Workflow Agent Framework в Microsoft.Agents.AI.DurableTask, и каждый шаг исполнителя получает чекпоинт. Падение, передеплой, перезапуск: запуск продолжится с того же места."
pubDate: 2026-05-07
tags:
  - "dotnet"
  - "ai-agents"
  - "agent-framework"
  - "csharp"
  - "durable-task"
lang: "ru"
translationOf: "2026/05/agent-framework-durable-workflows-checkpoint-restart"
translatedBy: "claude"
translationDate: 2026-05-07
---

Шиджу Кришнанкутти опубликовал [Durable Workflows in Microsoft Agent Framework](https://devblogs.microsoft.com/dotnet/durable-workflows-in-microsoft-agent-framework/) в .NET Blog 2026-05-06. Главная новость: модель программирования workflow из `Microsoft.Agents.AI.Workflows` теперь интегрируется со стеком Durable Task через предварительный пакет `Microsoft.Agents.AI.DurableTask`, благодаря чему многошаговый запуск агента может ставить чекпоинт после каждого исполнителя и продолжаться в другом процессе после падения, события масштабирования или передеплоя. Это та недостающая часть, которая позволяет вывести мульти-агентный конвейер из консольной демки в нечто, что действительно можно хостить.

## То, что уже было

Workflow это направленный граф узлов `Executor<TInput, TOutput>`, соединённых через `WorkflowBuilder`. Эта часть находится в стабильном пакете [Microsoft.Agents.AI.Workflows](https://www.nuget.org/packages/Microsoft.Agents.AI.Workflows) и не является новой:

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

`InProcessExecution.RunStreamingAsync` выполняет граф в памяти. Если хост умирает между `orderCancel` и `sendEmail`, заказ отменён, клиент никогда не получит письмо, и нет записи о повторных попытках. Для примеров приемлемо, для всего, что касается денег, опасно.

## Что изменилось 2026-05-06

`Microsoft.Agents.AI.DurableTask` позволяет выполнять тот же workflow поверх Durable Task. Каждый вызов исполнителя становится Durable-активностью, поэтому прогресс получает чекпоинт после каждого узла, а runtime переигрывает историю при перезапуске. Из анонса: "Stateful, durable execution: workflows survive process restarts and failures" и "automatic checkpointing: progress is saved after each step".

В сочетании с `Microsoft.Agents.AI.Hosting.AzureFunctions` и пакетами `Microsoft.DurableTask.Client.AzureManaged` / `Microsoft.DurableTask.Worker.AzureManaged`, нацеленными на Durable Task Scheduler, хост Azure Functions сам генерирует HTTP-триггер, оркестратор и activity-функции:

```csharp
var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureDurableWorkflows(workflows =>
{
    workflows.AddWorkflow("CancelOrder", sp => BuildCancelOrderWorkflow(sp),
        exposeMcpToolTrigger: true);
});

builder.Build().Run();
```

`exposeMcpToolTrigger: true` заслуживает отдельного внимания: workflow появляется как MCP-инструмент, и агент Claude или Copilot может вызвать `CancelOrder`, а durable runtime берёт на себя остальное.

## Паттерны, которые становятся полезнее с включённой долговечностью

Три возможности workflow, которые были приятным дополнением в процессе, становятся несущими, как только запуск может длиться часами:

- `AddFanOutEdge()` и `AddFanInBarrierEdge()` для параллельных подзадач (например, обогатить заказ из трёх систем и затем объединить), теперь безопасно возобновляемых.
- `RequestPort.Create<TRequest, TResponse>()` для участия человека. Workflow паркуется, сохраняется и просыпается только когда приходит ответ. Часы, дни, как угодно.
- `AddSwitch()` для условной маршрутизации по выходу предыдущего исполнителя; это куда более безопасный паттерн, чем позволять LLM выбирать следующую ветку.

Пакет `Microsoft.Agents.AI.DurableTask` всё ещё в предварительной версии, поэтому фиксируйте версию явно и следите за [фидом Microsoft Agent Framework DevBlogs](https://devblogs.microsoft.com/agent-framework/) на предмет ломающих изменений до GA.
