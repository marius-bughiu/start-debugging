---
title: "AG-UI .NET SDK 1.0: AGUI.Server y AGUI.Client sacan el protocolo de Agent Framework"
description: "El protocolo AG-UI ahora tiene un SDK independiente para .NET: AGUI.Server 1.0.0 transmite cualquier IChatClient como eventos AG-UI por SSE, y AGUIChatClient consume un endpoint AG-UI como si fuera un IChatClient, hasta .NET Framework 4.7.2. Los usuarios de Agent Framework reciben APIs renombradas."
pubDate: 2026-09-27
tags:
  - "ag-ui"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
  - "agent-framework"
lang: "es"
translationOf: "2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework"
translatedBy: "claude"
translationDate: 2026-09-27
---

El 25 de septiembre de 2026 el equipo de .NET [anunció un SDK de .NET de primera clase para el protocolo AG-UI](https://devblogs.microsoft.com/dotnet/ag-ui-dotnet-sdk/). Los paquetes llegaron a NuGet como `1.0.0` el 17 de septiembre: `AGUI.Abstractions`, `AGUI.Formatting`, `AGUI.Protobuf`, `AGUI.Server` y `AGUI.Client`, con licencia MIT, alojados en [ag-ui-protocol/ag-ui bajo sdks/dotnet](https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/dotnet). Hasta ahora, dar soporte a AG-UI en .NET significaba depender de Microsoft Agent Framework. Ese acoplamiento desaparece.

## Qué es AG-UI, en un párrafo

[AG-UI](https://docs.ag-ui.com/) es un protocolo de cable entre un backend de agentes y un frontend. El cliente hace POST de un `RunAgentInput` (mensajes, herramientas, estado), y el servidor responde con un stream de eventos tipados: `RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, eventos de llamada a herramientas, `STATE_DELTA`, `RUN_FINISHED`. Server-Sent Events es el transporte por defecto, con un códec protobuf opcional para parte del conjunto de eventos. Frontends como CopilotKit ya lo hablan, así que un backend de .NET que emite eventos AG-UI correctos se conecta directamente con ellos.

## Cualquier IChatClient se convierte en un endpoint AG-UI

`AGUI.Server` apunta a `net8.0`, `net9.0` y `net10.0`, y solo necesita un `IChatClient` de `Microsoft.Extensions.AI`. No hace falta ninguna abstracción de agente:

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

El trabajo interesante ocurre en `AsAGUIEventStreamAsync`. Envuelve la ejecución en `RUN_STARTED` y `RUN_FINISHED`, cierra un bloque de texto o de razonamiento abierto antes de pasar a otro mensaje o llamada a herramienta, y condensa varias interrupciones en un único `RUN_FINISHED` terminal. Esas son exactamente las reglas de orden que un mapeador SSE hecho a mano suele equivocar, y un frontend que recibe un `TEXT_MESSAGE_CONTENT` para un bloque que nunca se abrió normalmente falla en silencio.

## El lado cliente llega hasta .NET Framework 4.7.2

`AGUI.Client` también apunta a `netstandard2.0` y `net472`. Su `AGUIChatClient` implementa `IChatClient`, así que para tu código un agente AG-UI remoto se ve como cualquier otro modelo:

```csharp
using AGUI.Client;

using var httpClient = new HttpClient();
IChatClient agent = new AGUIChatClient(
    new AGUIChatClientOptions(httpClient, "http://localhost:5001"));

await foreach (var update in agent.GetStreamingResponseAsync("Summarize ticket 4211"))
    Console.Write(update.Text);
```

Eso es útil para una app heredada de WinForms o WPF en .NET Framework que necesita llamar a un agente alojado en otro lugar sin migrar primero.

## Cambios de nombre incompatibles para usuarios de Agent Framework

Si ya usabas `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` (actualmente `1.22.0-preview.260918.1`), el paquete de hosting ahora se construye sobre el nuevo SDK y los nombres cambiaron:

| Antes | Después |
| --- | --- |
| `AddAGUI()` / `MapAGUI()` | `AddAGUIServer()` / `MapAGUIServer()` |
| namespace `Microsoft.Agents.AI.AGUI` | `AGUI.Client`, `AGUI.Server`, `AGUI.Abstractions` |
| constructor posicional de `AGUIChatClient` | `AGUIChatClientOptions` |

```csharp
builder.Services.AddAGUIServer();
var app = builder.Build();

AIAgent agent = chatClient.AsAIAgent(
    name: "AGUIAssistant",
    instructions: "You are a helpful assistant.");

app.MapAGUIServer("/", agent);
```

Combinado con [`AsIChatClient` en Agent Framework 1.22](/es/2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient/) de la semana pasada, las piezas ahora se componen en ambas direcciones: un `AIAgent` puede ser un `IChatClient`, un `IChatClient` puede ser un endpoint AG-UI, y un endpoint AG-UI puede volver a ser un `IChatClient`. Si solo necesitas un backend de chat con streaming para un frontend estilo CopilotKit, `AGUI.Server` más tu cliente de chat existente es ahora la dependencia más pequeña que lo hace correctamente.
