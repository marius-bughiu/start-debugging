---
title: "Declarative Workflows 1.0 в Agent Framework: граф оркестрации теперь YAML-файл"
description: "Microsoft Agent Framework выпустил Declarative Workflows 1.0 2026-07-23. Python-пакет agent-framework-declarative 1.0.0 сравнялся с .NET-пакетом Microsoft.Agents.AI.Workflows.Declarative, поэтому маршрутизация между агентами живёт в YAML, а не в C#."
pubDate: 2026-07-25
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "yaml"
lang: "ru"
translationOf: "2026/07/agent-framework-declarative-workflows-1-0-yaml-orchestration"
translatedBy: "claude"
translationDate: 2026-07-25
---

2026-07-23 Microsoft выпустила [Declarative Workflows 1.0](https://devblogs.microsoft.com/agent-framework/move-agent-orchestration-workflows-out-of-code-with-agent-framework-declarative-workflows-1-0/) для Agent Framework. Главное здесь паритет: Python-пакет `agent-framework-declarative` дошёл до 1.0.0 и сравнялся с уже стабильным .NET-пакетом `Microsoft.Agents.AI.Workflows.Declarative`. Оба теперь загружают один и тот же диалект YAML и исполняют его в той же среде выполнения workflow, что исполняет графы, описанные кодом.

Если вы собирали мультиагентную систему на [паттернах оркестрации, которые дошли до 1.0 в начале этого месяца](/2026/07/agent-framework-orchestration-patterns-compared/), маршрутизацию вы писали на C#. Каждый раз, когда продукту нужна была новая ветка триажа, вы правили цепочку билдеров, пересобирали и разворачивали заново. Декларативные workflow выносят этот граф из сборки в файл, который можно сравнить через diff, отправить на ревью и версионировать как конфигурацию.

## Как выглядит сам YAML

Workflow это документ `kind: Workflow` с триггером и списком действий. Выражения записываются на Power Fx с префиксом `=` и читают области видимости `System.*` и `Local.*`:

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

Это весь маршрутизатор целиком. `ConditionGroup` даёт ветвление, `SetVariable` даёт состояние, а `InvokeAzureAgent` вызывает именованного агента Foundry. Набор действий в 1.0 покрывает также циклы, `InvokeFunctionTool` для локальных функций, вызовы MCP- и HTTP-инструментов, паузы с участием человека для согласований, а также контрольные точки и возобновление.

## Загрузка из C#

Со стороны .NET это два типа. `DeclarativeWorkflowOptions` оборачивает провайдер агентов, а `DeclarativeWorkflowBuilder.Build<TInput>` компилирует YAML в тот же объект `Workflow`, который вы собрали бы вручную:

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

Обратите внимание, что `Build<string>` обобщён по типу входных данных, а возвращённый `Workflow` попадает в `InProcessExecution` ровно так же, как собранный программно. Контрольные точки, потоковые события и события ошибок не меняются, так что вашему хостовому коду безразлично, каким способом описан граф.

## Где этот инструмент перестаёт подходить

Декларативный формат это сериализация модели workflow, а не замена ей. Собственные исполнители, самописные конечные автоматы и всё, чему нужен настоящий поток управления сверх условий и циклов, по-прежнему пишутся на C#. Практическое разделение выглядит так: маршрутизацию агентов и последовательность вызова инструментов кладите в YAML, где их прочитает и не разработчик, а действительно нестандартное поведение оставляйте в коде. Смешивать оба подхода в одном приложении можно.

Полный каталог действий смотрите в [справочнике по декларативным workflow на MS Learn](https://learn.microsoft.com/en-us/agent-framework/workflows/declarative).
