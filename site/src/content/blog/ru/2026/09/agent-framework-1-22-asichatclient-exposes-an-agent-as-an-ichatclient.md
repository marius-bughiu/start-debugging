---
title: "Agent Framework 1.22: AsIChatClient позволяет AIAgent выступить в роли IChatClient"
description: "Microsoft Agent Framework .NET 1.22.0 добавляет AIAgent.AsIChatClient() и замыкает круг, начатый IChatClient.AsAIAgent(). Агент сохраняет инструкции и инструменты и теперь подходит любому API, который принимает IChatClient."
pubDate: 2026-09-20
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
lang: "ru"
translationOf: "2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient"
translatedBy: "claude"
translationDate: 2026-09-20
---

Microsoft Agent Framework [dotnet-1.22.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.22.0) вышел 2026-09-18, и внимания в нём заслуживает [PR #7687](https://github.com/microsoft/agent-framework/pull/7687): `AsIChatClient`. В `Microsoft.Extensions.AI` уже давно есть `ChatClientExtensions.AsAIAgent()`, превращающий чат-клиент в агента. Обратного направления не было. Теперь оно появилось, и круг замкнулся.

## Чем было плохо отсутствие обратного направления

Список API .NET, принимающих `IChatClient`, продолжает расти: оценщики из `Microsoft.Extensions.AI.Evaluation`, middleware кеширования и телеметрии, всё, что построено на конвейере `ChatClientBuilder`. `AIAgent` -- объект более богатый. Он несёт инструкции, набор инструментов, сессию и все обёртки middleware, которые вы вокруг него выстроили. Передавая такому API голый `IChatClient`, всё это приходилось собирать заново вручную либо отдавать оценщику-судье модель без того системного промпта, который и делает её судьёй.

`AsIChatClient` находится в `Microsoft.Agents.AI` и выглядит так:

```csharp
public static IChatClient AsIChatClient(
    this AIAgent agent,
    AgentSession? session = null,
    string? conversationId = null,
    bool allowNonChatClientAgents = false)
```

Агент-судья превращается в чат-клиент-судью одним вызовом:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIAgent judge = chatClient.CreateAIAgent(
    instructions: "You score answers for factual accuracy. Reply with JSON only.",
    name: "Judge");

IChatClient judgeClient = judge.AsIChatClient();
```

Адаптером служит внутренний `AIAgentChatClient`, который отображает `GetResponseAsync` и `GetStreamingResponseAsync` на `RunAsync` и `RunStreamingAsync` и передаёт ваши `ChatOptions` дальше как `ChatClientAgentRunOptions`. Отмена операции проходит насквозь, а `GetService<IChatClient>()` без ключа возвращает адаптер, тогда как любой другой запрос сервиса переадресуется агенту.

## Проверка на входе и когда её отключать

По умолчанию вызов бросает `InvalidOperationException`, если только агент не является `ChatClientAgent` или не возвращает такой из `GetService<ChatClientAgent>()` без ключа. Декораторы на основе `DelegatingAIAgent` этот запрос переадресуют, поэтому обёрнутый агент проверку проходит.

Укажите `allowNonChatClientAgents: true`, и обёрнут будет агент любого типа, но мелкий шрифт читать обязательно: переход переживает только `ChatOptions.ResponseFormat`. Температура, инструменты и всё остальное молча игнорируются, потому что у агента-workflow или удалённого агента A2A нет опций чата, к которым их можно было бы применить.

Второе острое место -- сессии. В режиме без состояния, который включён по умолчанию, непустой `ChatOptions.ConversationId` приводит к исключению, а исходные идентификаторы ответов очищаются в возвращаемых копиях. Передайте `session`, и клиент будет сообщать один и тот же стабильный идентификатор беседы для каждого ответа: переданный вами либо сгенерированный для этого экземпляра. Идентификатор со стороны сервиса он не раскрывает никогда, благодаря чему состояние беседы у провайдера остаётся внутри сессии, где ему и место. Любой другой непустой идентификатор отвергается как неизвестный.

API помечен атрибутом `[Experimental]`, так что до подавления соответствующей диагностики сборка будет падать с ошибкой.

Ещё одна строка того же релиза стоит поиска по вашему коду: [PR #8531](https://github.com/microsoft/agent-framework/pull/8531) теперь передаёт инструменты `ChatClientAgent` на каждый запуск, а не выставляет их на нижележащем чат-клиенте с вызовом функций, из-за чего инструменты больше не дублируются и не утекают между агентами, использующими общий клиент. Это изменение помечено как BREAKING, как и перенос `AgentSessionStore` в `Microsoft.Agents.AI.Abstractions`.

Обновитесь до `Microsoft.Agents.AI` 1.22.0, а если вы пропустили релиз прошлой недели, сначала посмотрите, [что версия 1.21 изменила в LocalCodeAct и окружении вашего хоста](/ru/2026/09/agent-framework-1-21-localcodeact-stops-inheriting-host-environment/).
