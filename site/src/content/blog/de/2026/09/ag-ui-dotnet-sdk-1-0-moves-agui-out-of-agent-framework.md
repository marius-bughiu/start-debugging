---
title: "AG-UI .NET SDK 1.0: AGUI.Server und AGUI.Client lösen das Protokoll aus Agent Framework heraus"
description: "Das AG-UI-Protokoll hat jetzt ein eigenständiges .NET SDK: AGUI.Server 1.0.0 streamt jeden IChatClient als AG-UI-Events über SSE, und AGUIChatClient konsumiert einen AG-UI-Endpunkt als IChatClient, bis hinunter zu .NET Framework 4.7.2. Agent-Framework-Nutzer bekommen umbenannte APIs."
pubDate: 2026-09-27
tags:
  - "ag-ui"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
  - "agent-framework"
lang: "de"
translationOf: "2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework"
translatedBy: "claude"
translationDate: 2026-09-27
---

Am 25. September 2026 [kündigte das .NET-Team ein eigenständiges .NET SDK für das AG-UI-Protokoll an](https://devblogs.microsoft.com/dotnet/ag-ui-dotnet-sdk/). Die Pakete landeten am 17. September als `1.0.0` auf NuGet: `AGUI.Abstractions`, `AGUI.Formatting`, `AGUI.Protobuf`, `AGUI.Server` und `AGUI.Client`, MIT-lizenziert, beheimatet in [ag-ui-protocol/ag-ui unter sdks/dotnet](https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/dotnet). Bis jetzt bedeutete AG-UI-Unterstützung in .NET eine Abhängigkeit von Microsoft Agent Framework. Diese Kopplung ist weg.

## Was AG-UI ist, in einem Absatz

[AG-UI](https://docs.ag-ui.com/) ist ein Wire-Protokoll zwischen einem Agenten-Backend und einem Frontend. Der Client sendet per POST ein `RunAgentInput` (Nachrichten, Tools, State), und der Server antwortet mit einem Stream typisierter Events: `RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, Tool-Call-Events, `STATE_DELTA`, `RUN_FINISHED`. Server-Sent Events ist der Standard-Transport, mit einem optionalen Protobuf-Codec für einen Teil der Events. Frontends wie CopilotKit sprechen es bereits, sodass ein .NET-Backend, das korrekte AG-UI-Events ausgibt, direkt hineinpasst.

## Jeder IChatClient wird zu einem AG-UI-Endpunkt

`AGUI.Server` zielt auf `net8.0`, `net9.0` und `net10.0` und braucht nur einen `Microsoft.Extensions.AI`-`IChatClient`. Keine Agenten-Abstraktion nötig:

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

Die eigentliche Arbeit passiert in `AsAGUIEventStreamAsync`. Sie umschließt den Lauf mit `RUN_STARTED` und `RUN_FINISHED`, schließt einen offenen Text- oder Reasoning-Block, bevor zu einer anderen Nachricht oder einem Tool-Call gewechselt wird, und faltet mehrere Interrupts zu einem einzigen abschließenden `RUN_FINISHED` zusammen. Genau das sind die Reihenfolge-Regeln, bei denen ein selbstgebauter SSE-Mapper typischerweise scheitert, und ein Frontend, das ein `TEXT_MESSAGE_CONTENT` für einen nie gestarteten Block erhält, schlägt meist stillschweigend fehl.

## Die Client-Seite reicht bis .NET Framework 4.7.2

`AGUI.Client` zielt zusätzlich auf `netstandard2.0` und `net472`. Sein `AGUIChatClient` implementiert `IChatClient`, sodass ein entfernter AG-UI-Agent für Ihren Code wie jedes andere Modell aussieht:

```csharp
using AGUI.Client;

using var httpClient = new HttpClient();
IChatClient agent = new AGUIChatClient(
    new AGUIChatClientOptions(httpClient, "http://localhost:5001"));

await foreach (var update in agent.GetStreamingResponseAsync("Summarize ticket 4211"))
    Console.Write(update.Text);
```

Das ist nützlich für eine bestehende WinForms- oder WPF-Anwendung auf .NET Framework, die einen woanders gehosteten Agenten aufrufen muss, ohne vorher zu migrieren.

## Breaking Renames für Agent-Framework-Nutzer

Wenn Sie bereits `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` (aktuell `1.22.0-preview.260918.1`) verwendet haben: Das Hosting-Paket baut jetzt auf dem neuen SDK auf, und die Namen haben sich geändert:

| Vorher | Nachher |
| --- | --- |
| `AddAGUI()` / `MapAGUI()` | `AddAGUIServer()` / `MapAGUIServer()` |
| Namespace `Microsoft.Agents.AI.AGUI` | `AGUI.Client`, `AGUI.Server`, `AGUI.Abstractions` |
| positionaler `AGUIChatClient`-Konstruktor | `AGUIChatClientOptions` |

```csharp
builder.Services.AddAGUIServer();
var app = builder.Build();

AIAgent agent = chatClient.AsAIAgent(
    name: "AGUIAssistant",
    instructions: "You are a helpful assistant.");

app.MapAGUIServer("/", agent);
```

Zusammen mit `AsIChatClient` aus [Agent Framework 1.22](/de/2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient/) von letzter Woche fügen sich die Teile jetzt in beide Richtungen zusammen: Ein `AIAgent` kann ein `IChatClient` sein, ein `IChatClient` kann ein AG-UI-Endpunkt sein, und ein AG-UI-Endpunkt kann wieder ein `IChatClient` sein. Wenn Sie nur ein streamendes Chat-Backend für ein CopilotKit-artiges Frontend brauchen, ist `AGUI.Server` plus Ihr vorhandener Chat-Client jetzt die kleinste Abhängigkeit, die das korrekt erledigt.
