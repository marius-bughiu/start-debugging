---
title: "Blazor erhält agentische UI-Komponenten in .NET 11 RC1: ChatPage, UIAgent und Tool-Genehmigungen"
description: "Microsoft.AspNetCore.Components.AI ist ein experimentelles Blazor-Paket in .NET 11 RC1, das jeden IChatClient in eine Streaming-Chat-Oberfläche mit Tool-Genehmigungen, typisiertem Tool-Rendering und gemeinsamem Zustand über AG-UI verwandelt."
pubDate: 2026-09-29
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnet-core"
  - "ai-agents"
  - "microsoft-extensions-ai"
  - "ag-ui"
lang: "de"
translationOf: "2026/09/blazor-ai-components-agentic-ui-dotnet-11-rc1"
translatedBy: "claude"
translationDate: 2026-09-29
---

Am 28. September 2026 hat Daniel Roth [Build Agentic UI with the new Blazor AI components](https://devblogs.microsoft.com/dotnet/build-agentic-ui-blazor/) veröffentlicht, die erste echte Anleitung zu `Microsoft.AspNetCore.Components.AI`. Das Paket wurde still mit [.NET 11 RC1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/aspnetcore.md#experimental-blazor-ai-components-for-agentic-user-interfaces) ausgeliefert und ist als experimentell markiert: Es bleibt für den gesamten .NET-11-Zyklus eine Vorabversion. Es liefert genau den Teil, den jedes Team, das ein Agenten-Frontend baut, bisher von Hand neu geschrieben hat: Rendering von Nachrichten im Streaming, Anzeige von Tool-Aufrufen, Genehmigungsschranken für Menschen und Zustand, den der Agent bearbeiten kann.

## Von IChatClient zur funktionierenden Chat-Seite

Alles hängt an `UIAgent`. Diese Klasse umhüllt jeden `Microsoft.Extensions.AI`-`IChatClient`, verarbeitet den `ChatResponseUpdate`-Stream und bildet ihn auf beobachtbare `ContentBlock`-Instanzen ab, die Razor-Komponenten rendern. Der schnellste Weg ist `ChatPage`, eine vollständige Hülle mit Nachrichtenliste, Eingabe, Streaming-Status und Wiederholen:

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

Wenn die Hülle nicht mehr genügt, lässt sich `ChatPage` in `AgentBoundary`, `MessageList`, `MessageInput` und `BlockRenderer<TBlock>` zerlegen. So können Sie die Unterhaltung selbst gestalten und pro Block-Typ eigenen Razor-Inhalt wählen.

## Genehmigungen und typisiertes Tool-Rendering

Der Teil, der mir am wichtigsten ist, ist der Genehmigungsablauf. Umhüllen Sie ein folgenreiches Tool mit `ApprovalRequiredAIFunction`, und der Agent pausiert bei einem `FunctionApprovalBlock`, bis der Benutzer entschieden hat:

```razor
<BlockRenderer TBlock="FunctionApprovalBlock" Context="block">
    @if (block.Status == ApprovalStatus.Pending)
    {
        <button @onclick="block.Approve">Approve</button>
        <button @onclick="() => block.Reject()">Reject</button>
    }
</BlockRenderer>
```

Für Backend-Tools deklarieren Sie mit einem quellgenerierten Block, wie ein Aufruf gerendert wird, und registrieren ihn anschließend mit `options.AddGeneratedToolBlocks()`:

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

Frontend-Tools sind einfache `AIFunctionFactory.Create`-Delegates, die zu `ChatOptions.Tools` hinzugefügt werden. Das Modell kann damit in die Komponente zurückrufen (das Beispiel setzt über `InvokeAsync` die Akzentfarbe der Seite).

## Gemeinsamer Zustand und AG-UI

`UIAgent<TState>` ergänzt ein stark typisiertes Zustandsobjekt, das Agent und Benutzer gemeinsam bearbeiten. Ein `StateMapper` in `UIAgentOptions` wendet eingehenden Zustand an, und mit Predictive State kann der Agent eine Änderung vormerken, die die UI mit `AcceptPredictiveState()` übernimmt oder mit `RejectPredictiveState()` verwirft.

Der Zustand wird über [AG-UI](https://docs.ag-ui.com/sdk/dotnet) übertragen: `STATE_SNAPSHOT` ersetzt ihn, `STATE_DELTA` ändert ihn per RFC 6902 JSON Patch, und `REASONING_*`-Ereignisse erscheinen als einklappbare Reasoning-Bereiche. Um die UI auf einen entfernten Agenten zu richten, übergeben Sie `UIAgent` statt eines Modell-Clients einen `AGUIChatClient`:

```csharp
HttpClient http = httpClientFactory.CreateClient("agentserver");
IChatClient client = new AGUIChatClient(new AGUIChatClientOptions(http, endpoint));
```

Die Serverseite besteht aus `AddAGUIServer()` plus `MapAGUIServer("/agentic_chat", agent)`, entweder aus `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` oder aus `AGUI.Server`, dem eigenständigen Paket, das ich in [AG-UI .NET SDK 1.0](/de/2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework/) behandelt habe.

## Lohnt sich der Einsatz schon jetzt

Es benötigt das .NET 11 RC1 SDK, und die API ist ausdrücklich offen für Feedback, daher sind vor GA Umbenennungen zu erwarten. Für ein neues internes Agenten-Tool ist es bereits der kürzeste Weg von `IChatClient` zu einer UI mit Genehmigungsschranke. Alle Szenarien finden Sie im [AgenticUI-Beispiel-Repository](https://github.com/danroth27/AgenticUI).
