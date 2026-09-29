---
title: "Blazor получает компоненты агентного UI в .NET 11 RC1: ChatPage, UIAgent и подтверждение вызова инструментов"
description: "Microsoft.AspNetCore.Components.AI - экспериментальный пакет Blazor в .NET 11 RC1, который превращает любой IChatClient в потоковый чат-интерфейс с подтверждением вызова инструментов, типизированным отображением инструментов и общим состоянием поверх AG-UI."
pubDate: 2026-09-29
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnet-core"
  - "ai-agents"
  - "microsoft-extensions-ai"
  - "ag-ui"
lang: "ru"
translationOf: "2026/09/blazor-ai-components-agentic-ui-dotnet-11-rc1"
translatedBy: "claude"
translationDate: 2026-09-29
---

28 сентября 2026 года Дэниел Рот опубликовал [Build Agentic UI with the new Blazor AI components](https://devblogs.microsoft.com/dotnet/build-agentic-ui-blazor/), первый полноценный разбор `Microsoft.AspNetCore.Components.AI`. Пакет незаметно появился в [.NET 11 RC1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/aspnetcore.md#experimental-blazor-ai-components-for-agentic-user-interfaces) и помечен как экспериментальный: он остаётся предварительной версией на протяжении всего цикла .NET 11. Он даёт то, что каждая команда, делающая фронтенд для агента, до сих пор переписывала вручную: потоковое отображение сообщений, показ вызовов инструментов, шлюзы подтверждения человеком и состояние, которое может редактировать агент.

## От IChatClient до рабочей страницы чата

Всё строится вокруг `UIAgent`, который оборачивает любой `IChatClient` из `Microsoft.Extensions.AI`, потребляет поток `ChatResponseUpdate` и преобразует его в наблюдаемые экземпляры `ContentBlock`, которые отображаются Razor-компонентами. Самый быстрый путь - `ChatPage`, готовая оболочка со списком сообщений, полем ввода, статусом потоковой передачи и повтором:

```bash
dotnet add package Microsoft.AspNetCore.Components.AI --prerelease
```

```razor
<link rel="stylesheet" href="@Assets["_content/Microsoft.AspNetCore.Components.AI/ai-chat.css"]" />

<ChatPage Agent="_agent" Placeholder="Type a message...">
    <WelcomeContent>
        <p>Ask the agent a question.</p>
    </WelcomeContent>
</ChatPage>

@code {
    private UIAgent _agent = default!;

    protected override void OnInitialized()
    {
        IChatClient chatClient = GetChatClient();
        _agent = new UIAgent(chatClient);
    }
}
```

Когда оболочки становится мало, `ChatPage` раскладывается на `AgentBoundary`, `MessageList`, `MessageInput` и `BlockRenderer<TBlock>`, так что вы можете сами скомпоновать диалог и выбрать Razor-разметку для каждого типа блока.

## Подтверждение и типизированное отображение инструментов

Больше всего меня интересует механизм подтверждения. Оберните ответственный инструмент в `ApprovalRequiredAIFunction`, и агент приостановится на `FunctionApprovalBlock`, пока пользователь не примет решение:

```razor
<BlockRenderer TBlock="FunctionApprovalBlock" Context="block">
    @if (block.Status == ApprovalStatus.Pending)
    {
        <button @onclick="block.Approve">Approve</button>
        <button @onclick="() => block.Reject()">Reject</button>
    }
</BlockRenderer>
```

Для серверных инструментов вы описываете отображение вызова с помощью блока, созданного генератором исходного кода, а затем регистрируете его через `options.AddGeneratedToolBlocks()`:

```csharp
[ToolBlock("get_weather")]
public partial class WeatherToolBlock : FunctionInvocationContentBlock
{
    [ToolParameter(Name = "location")]
    public string? Location { get; set; }

    [ToolResult]
    public WeatherInfo? Weather { get; set; }
}
```

Клиентские инструменты - это обычные делегаты `AIFunctionFactory.Create`, добавленные в `ChatOptions.Tools`, поэтому модель может обращаться обратно к компоненту (в примере акцентный цвет страницы задаётся через `InvokeAsync`).

## Общее состояние и AG-UI

`UIAgent<TState>` добавляет строго типизированный объект состояния, который агент и пользователь редактируют вместе. `StateMapper` в `UIAgentOptions` применяет входящее состояние, а предиктивное состояние позволяет агенту подготовить изменение, которое интерфейс либо фиксирует через `AcceptPredictiveState()`, либо отбрасывает через `RejectPredictiveState()`.

Состояние передаётся по [AG-UI](https://docs.ag-ui.com/sdk/dotnet): `STATE_SNAPSHOT` заменяет его, `STATE_DELTA` изменяет его по RFC 6902 JSON Patch, а события `REASONING_*` отображаются как сворачиваемые панели рассуждений. Чтобы подключить интерфейс к удалённому агенту, передайте в `UIAgent` клиент `AGUIChatClient` вместо клиента модели:

```csharp
HttpClient http = httpClientFactory.CreateClient("agentserver");
IChatClient client = new AGUIChatClient(new AGUIChatClientOptions(http, endpoint));
```

Серверная часть - это `AddAGUIServer()` плюс `MapAGUIServer("/agentic_chat", agent)` из `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` или `AGUI.Server`, отдельного пакета, о котором я писал в [AG-UI .NET SDK 1.0](/ru/2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework/).

## Стоит ли использовать уже сейчас

Нужен SDK .NET 11 RC1, а API явно открыт для обратной связи, так что до GA ожидайте переименований. Для нового внутреннего инструмента с агентом это уже самый короткий путь от `IChatClient` до интерфейса с подтверждением действий. Полный набор сценариев находится в [репозитории с примерами AgenticUI](https://github.com/danroth27/AgenticUI).
