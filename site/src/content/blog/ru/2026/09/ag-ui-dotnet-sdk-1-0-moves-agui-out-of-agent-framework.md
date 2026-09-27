---
title: "AG-UI .NET SDK 1.0: AGUI.Server и AGUI.Client выносят протокол из Agent Framework"
description: "У протокола AG-UI появился самостоятельный .NET SDK: AGUI.Server 1.0.0 превращает любой IChatClient в поток событий AG-UI через SSE, а AGUIChatClient использует AG-UI endpoint как IChatClient, вплоть до .NET Framework 4.7.2. Пользователям Agent Framework достались переименованные API."
pubDate: 2026-09-27
tags:
  - "ag-ui"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
  - "agent-framework"
lang: "ru"
translationOf: "2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework"
translatedBy: "claude"
translationDate: 2026-09-27
---

25 сентября 2026 года команда .NET [анонсировала полноценный .NET SDK для протокола AG-UI](https://devblogs.microsoft.com/dotnet/ag-ui-dotnet-sdk/). Пакеты появились в NuGet в версии `1.0.0` 17 сентября: `AGUI.Abstractions`, `AGUI.Formatting`, `AGUI.Protobuf`, `AGUI.Server` и `AGUI.Client`, под лицензией MIT, в репозитории [ag-ui-protocol/ag-ui, каталог sdks/dotnet](https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/dotnet). До сих пор поддержка AG-UI в .NET означала зависимость от Microsoft Agent Framework. Этой связки больше нет.

## Что такое AG-UI, в одном абзаце

[AG-UI](https://docs.ag-ui.com/) это протокол обмена между бэкендом агента и фронтендом. Клиент отправляет POST с `RunAgentInput` (сообщения, инструменты, состояние), а сервер отвечает потоком типизированных событий: `RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, события вызова инструментов, `STATE_DELTA`, `RUN_FINISHED`. Транспорт по умолчанию Server-Sent Events, плюс опциональный protobuf-кодек для части событий. Фронтенды вроде CopilotKit уже говорят на этом протоколе, так что .NET-бэкенд, который выдаёт корректные события AG-UI, подключается к ним напрямую.

## Любой IChatClient становится AG-UI endpoint

`AGUI.Server` нацелен на `net8.0`, `net9.0` и `net10.0` и требует только `IChatClient` из `Microsoft.Extensions.AI`. Абстракция агента не нужна:

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(CreateChatClient());
builder.Services.Configure<JsonOptions>(options =>
    options.SerializerOptions.TypeInfoResolverChain.Insert(
        0, AGUIJsonUtilities.DefaultTypeInfoResolver));

var app = builder.Build();

app.MapPost("/", (RunAgentInput input, IChatClient chatClient,
    IOptions<JsonOptions> jsonOptions, CancellationToken ct) =>
{
    var context = input.ToChatRequestContext(jsonOptions.Value.SerializerOptions);

    var events = chatClient
        .GetStreamingResponseAsync(context.Messages, context.ChatOptions, ct)
        .AsAGUIEventStreamAsync(context, ct);

    return TypedResults.ServerSentEvents(events);
});

await app.RunAsync();
```

Самое интересное происходит в `AsAGUIEventStreamAsync`. Метод оборачивает запуск в `RUN_STARTED` и `RUN_FINISHED`, закрывает открытый текстовый блок или блок рассуждений перед переходом к другому сообщению или вызову инструмента и сворачивает несколько прерываний в один завершающий `RUN_FINISHED`. Именно эти правила порядка обычно ломаются в самописном SSE-маппере, а фронтенд, получивший `TEXT_MESSAGE_CONTENT` для блока, который так и не был открыт, как правило, падает молча.

## Клиентская часть работает даже на .NET Framework 4.7.2

`AGUI.Client` дополнительно нацелен на `netstandard2.0` и `net472`. Его `AGUIChatClient` реализует `IChatClient`, так что удалённый AG-UI агент выглядит для вашего кода как любая другая модель:

```csharp
using AGUI.Client;

using var httpClient = new HttpClient();
IChatClient agent = new AGUIChatClient(
    new AGUIChatClientOptions(httpClient, "http://localhost:5001"));

await foreach (var update in agent.GetStreamingResponseAsync("Summarize ticket 4211"))
    Console.Write(update.Text);
```

Это полезно для унаследованного WinForms- или WPF-приложения на .NET Framework, которому нужно вызвать агента, размещённого где-то ещё, без предварительной миграции.

## Ломающие переименования для пользователей Agent Framework

Если вы уже использовали `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` (сейчас `1.22.0-preview.260918.1`), пакет хостинга теперь построен на новом SDK, и имена изменились:

| Было | Стало |
| --- | --- |
| `AddAGUI()` / `MapAGUI()` | `AddAGUIServer()` / `MapAGUIServer()` |
| пространство имён `Microsoft.Agents.AI.AGUI` | `AGUI.Client`, `AGUI.Server`, `AGUI.Abstractions` |
| позиционный конструктор `AGUIChatClient` | `AGUIChatClientOptions` |

```csharp
builder.Services.AddAGUIServer();
var app = builder.Build();

AIAgent agent = chatClient.AsAIAgent(
    name: "AGUIAssistant",
    instructions: "You are a helpful assistant.");

app.MapAGUIServer("/", agent);
```

Вместе с [`AsIChatClient` из Agent Framework 1.22](/ru/2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient/), вышедшим на прошлой неделе, части теперь складываются в обе стороны: `AIAgent` может быть `IChatClient`, `IChatClient` может быть AG-UI endpoint, а AG-UI endpoint снова может стать `IChatClient`. Если вам нужен только потоковый чат-бэкенд для фронтенда в стиле CopilotKit, `AGUI.Server` плюс ваш существующий chat client теперь самая маленькая зависимость, которая делает это правильно.
