---
title: "GitHub Copilot SDK достиг GA: встройте среду выполнения агента Copilot в собственные приложения на C#"
description: "На Build 2026 GitHub выпустил Copilot SDK 1.0 GA с полноценным пакетом для .NET. Теперь из кода на C# можно управлять той же средой выполнения агента с планированием, вызовом инструментов и многоходовыми сессиями, включая BYOK."
pubDate: 2026-06-07
tags:
  - "github-copilot"
  - "copilot-sdk"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "mcp"
lang: "ru"
translationOf: "2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp"
translatedBy: "claude"
translationDate: 2026-06-07
---

GitHub объявил, что [GitHub Copilot SDK достиг общей доступности](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/) 2 июня 2026 года на Build, и часть, заслуживающая вашего внимания как разработчика .NET, -- это пакет `GitHub.Copilot.SDK`. Он даёт прямой программный доступ к той же среде выполнения агента, что стоит за Copilot в редакторе: планирование, вызов инструментов, редактирование файлов, стриминг и многоходовые сессии. Главный аргумент в том, что вам не нужно самостоятельно строить слой оркестрации. Среда выполнения, которая уже обрабатывает миллионы ходов агента в день, теперь является зависимостью NuGet.

## Что вы на самом деле получаете

SDK вышел в шести языках на момент GA (`@github/copilot-sdk`, `github-copilot-sdk` для Python, Go, Rust, Java и `GitHub.Copilot.SDK` для .NET). Для Node.js, Python и .NET CLI Copilot подключается автоматически как транзитивная зависимость, поэтому нет отдельного бинарника, который нужно устанавливать или держать в PATH. Вы добавляете один пакет и получаете хост агента:

```bash
dotnet add package GitHub.Copilot.SDK
```

Сессия -- это единица работы. Вы запускаете клиент, открываете сессию к модели и слушаете типизированные события вместо опроса. Вот полный цикл для одного промпта:

```csharp
using GitHub.Copilot;

await using var client = new CopilotClient();
await client.StartAsync();

await using var session = await client.CreateSessionAsync(new SessionConfig
{
    Model = "gpt-5",
    OnPermissionRequest = PermissionHandler.ApproveAll,
});

var done = new TaskCompletionSource();

session.On<SessionEvent>(evt =>
{
    if (evt is AssistantMessageEvent msg)
        Console.WriteLine(msg.Data.Content);
    else if (evt is SessionIdleEvent)
        done.SetResult();
});

await session.SendAsync(new MessageOptions { Prompt = "What is 2+2?" });
await done.Task;
```

Стриминг -- это флаг, а не отдельный API: установите `Streaming = true` в `SessionConfig`, и вы будете получать фрагменты `AssistantMessageDeltaEvent`, которые накапливаете до финального `AssistantMessageEvent`.

## Инструменты -- это обычные методы, а MCP встроен

Элемент, который делает это чем-то большим, чем обёртка над чатом, -- это пользовательские инструменты. `CopilotTool.DefineTool` принимает делегат и переиспользует фабрику функций `Microsoft.Extensions.AI`, так что инструмент -- это просто типизированный метод C# с `[Description]` на каждом параметре:

```csharp
using Microsoft.Extensions.AI;
using System.ComponentModel;

var session = await client.CreateSessionAsync(new SessionConfig
{
    Model = "gpt-5",
    Tools =
    [
        CopilotTool.DefineTool(
            async ([Description("Issue ID")] string id) => await FetchIssueAsync(id),
            factoryOptions: new AIFunctionFactoryOptions
            {
                Name = "lookup_issue",
                Description = "Fetch issue details",
            }),
    ],
});
```

Если вы уже создали [собственный MCP-сервер на C#](/ru/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/), агент может подключиться к нему напрямую, поэтому ваши существующие инструменты переходят вместе с вами без переписывания.

## BYOK, чтобы не быть привязанным к биллингу GitHub

Аутентификация -- это вторая причина присмотреться. По умолчанию SDK подхватывает ваш вход через CLI `copilot` или токены окружения (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`). Но bring-your-own-key работает с OpenAI, Microsoft Foundry, Anthropic и другими провайдерами, поэтому вы можете направить среду выполнения на модель, за которую уже платите:

```csharp
var session = await client.CreateSessionAsync(new SessionConfig
{
    Provider = new ProviderConfig
    {
        Type = "openai",
        BaseUrl = "https://api.openai.com/v1",
        ApiKey = "your-api-key",
    },
});
```

Он также поставляется с трассировкой OpenTelemetry и распространением контекста трассировки W3C, так что вызовы инструментов и ходы агента появляются в тех же трассах, что и остальной ваш сервис. Для тех, кто писал цикл инструментов вручную поверх сырого чат-клиента, GA-пакет -- это первый случай, когда собственную среду выполнения агента от GitHub можно подключить через `dotnet add` и отправить в продакшен. [Cookbook для .NET и руководство по началу работы](https://github.com/github/copilot-sdk) -- следующее место, куда стоит заглянуть.
