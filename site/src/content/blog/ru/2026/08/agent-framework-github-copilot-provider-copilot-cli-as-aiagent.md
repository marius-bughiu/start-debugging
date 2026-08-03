---
title: "Провайдер Copilot в Agent Framework превращает Copilot CLI в обычный AIAgent"
description: "Microsoft.Agents.AI.GitHub.Copilot 1.16.0 вышел 2026-07-30. Среда выполнения Copilot CLI теперь скрыта за абстракцией AIAgent, разрешения по умолчанию запрещены, а Squad подключает целую команду агентов как один AIAgent."
pubDate: 2026-08-03
tags:
  - "agent-framework"
  - "github-copilot"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "mcp"
lang: "ru"
translationOf: "2026/08/agent-framework-github-copilot-provider-copilot-cli-as-aiagent"
translatedBy: "claude"
translationDate: 2026-08-03
---

Microsoft выложила `Microsoft.Agents.AI.GitHub.Copilot` 1.16.0 в NuGet 2026-07-30, и [вышедшая в тот же день запись в блоге Agent Framework](https://devblogs.microsoft.com/agent-framework/building-agent-teams-with-agent-framework-github-copilot-cli-and-squad/) описывает интеграцию с GitHub Copilot как полностью поддерживаемую и в C#, и в Python. Практический итог: среда выполнения Copilot CLI, та самая, что выполняет команды shell, правит файлы, забирает URL и говорит на MCP, теперь доступна через обычную абстракцию `AIAgent`.

## Две строки до кодового агента

```bash
dotnet add package Microsoft.Agents.AI.GitHub.Copilot
```

```csharp
using GitHub.Copilot;
using Microsoft.Agents.AI;

await using CopilotClient copilotClient = new();
await copilotClient.StartAsync();

AIAgent agent = copilotClient.AsAIAgent();

Console.WriteLine(await agent.RunAsync("What is Microsoft Agent Framework?"));
```

`AsAIAgent` дополнительно принимает `tools:` и `instructions:`, поэтому `AIFunction`, уже зарегистрированный где-то ещё, подключается напрямую. Обратно вы получаете стандартный `AIAgent`, а значит `RunStreamingAsync`, `CreateSessionAsync` для многоходового контекста и любой workflow или оркестрация, уже построенные поверх Agent Framework, работают с ним без изменений. Именно этим он отличается от прямой работы с [Copilot SDK](/ru/2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp/): цикл событий сессии писать вручную больше не нужно, а Copilot становится просто ещё одним провайдером.

## Разрешения по умолчанию запрещены

Деталь, на которой спотыкаются первым делом: агент не может выполнять команды shell, трогать файловую систему или забирать URL, пока вы не передадите ему обработчик разрешений:

```csharp
SessionConfig sessionConfig = new()
{
    OnPermissionRequest = PromptPermission,
};

AIAgent agent = copilotClient.AsAIAgent(sessionConfig);
```

Ваш обработчик возвращает `PermissionDecision.ApproveOnce()` или `PermissionDecision.Reject()`. Есть сокращение `PermissionHandler.ApproveAll`, и [страница провайдера на MS Learn](https://learn.microsoft.com/en-us/agent-framework/agents/providers/github-copilot) прямо говорит запускать это в контейнере или dev container, а не на рабочей машине. Серверы MCP тоже идут в комплекте, локальные через stdio и удалённые через HTTP, настраиваются в `SessionConfig.McpServers`. А вот интерпретатор кода, поиск по файлам и размещённый веб-поиск не идут: документация помечает все три как неподдерживаемые для этого провайдера.

## Squad едет на той же абстракции

Вторая половина анонса это Squad, открытая многоагентная схема, где координатор и несколько специалистов живут в вашем репозитории как файлы markdown в каталоге `.squad/`. Пакет `Squad.Agents.AI` оборачивает всю команду в `DelegatingAIAgent`, так что весь состав предстаёт перед вашим приложением как один `AIAgent`:

```csharp
builder.Services.AddSquadAgent(o =>
{
    o.SquadFolderPath = @"C:\path\to\your\team-root";
});

var squad = host.Services.GetRequiredService<AIAgent>();
var session = await squad.CreateSessionAsync();
var response = await squad.RunAsync("What can this Squad team do?", session);
```

Каждая передача задачи специалисту порождает span OpenTelemetry с именем `squad.subagent {Name}`, поэтому ветвление видно в Aspire или Jaeger без дополнительной обвязки. Сам Squad пока в альфе (`Squad.Agents.AI` на версии 0.5.5, с превью 0.5.6), и ему нужны `dotnet add package Squad.Agents.AI --prerelease` плюс npm-пакет `@bradygaster/squad-cli` для создания каталога.

Провайдер это та часть, которую стоит взять в работу уже на этой неделе. Squad же служит любопытным доказательством: как только кодовый агент становится просто `AIAgent`, целая команда таких агентов тоже может им стать.
