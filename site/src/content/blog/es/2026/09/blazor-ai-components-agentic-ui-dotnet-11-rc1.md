---
title: "Blazor incorpora componentes de UI agéntica en .NET 11 RC1: ChatPage, UIAgent y aprobaciones de herramientas"
description: "Microsoft.AspNetCore.Components.AI es un paquete experimental de Blazor en .NET 11 RC1 que convierte cualquier IChatClient en una UI de chat con streaming, aprobaciones de herramientas, renderizado tipado de herramientas y estado compartido sobre AG-UI."
pubDate: 2026-09-29
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnet-core"
  - "ai-agents"
  - "microsoft-extensions-ai"
  - "ag-ui"
lang: "es"
translationOf: "2026/09/blazor-ai-components-agentic-ui-dotnet-11-rc1"
translatedBy: "claude"
translationDate: 2026-09-29
---

El 28 de septiembre de 2026 Daniel Roth publicó [Build Agentic UI with the new Blazor AI components](https://devblogs.microsoft.com/dotnet/build-agentic-ui-blazor/), la primera guía real de `Microsoft.AspNetCore.Components.AI`. El paquete llegó sin mucho ruido con [.NET 11 RC1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/aspnetcore.md#experimental-blazor-ai-components-for-agentic-user-interfaces) y está marcado como experimental: seguirá como versión preliminar durante todo el ciclo de .NET 11. Lo que ofrece es la parte que todo equipo que construye un frontend para agentes ha estado reescribiendo a mano: renderizado de mensajes en streaming, visualización de llamadas a herramientas, puertas de aprobación humana y estado que el agente puede editar.

## De IChatClient a una página de chat funcional

Todo cuelga de `UIAgent`, que envuelve cualquier `IChatClient` de `Microsoft.Extensions.AI`, consume el flujo de `ChatResponseUpdate` y lo convierte en instancias observables de `ContentBlock` que los componentes Razor renderizan. El camino más rápido es `ChatPage`, un shell completo con lista de mensajes, entrada, estado de streaming y reintento:

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

Cuando el shell se te quede corto, `ChatPage` se descompone en `AgentBoundary`, `MessageList`, `MessageInput` y `BlockRenderer<TBlock>`, de modo que puedes organizar la conversación a tu manera y elegir el contenido Razor para cada tipo de bloque.

## Aprobaciones y renderizado tipado de herramientas

La pieza que más me interesa es el flujo de aprobación. Envuelve una herramienta con consecuencias en `ApprovalRequiredAIFunction` y el agente se pausa en un `FunctionApprovalBlock` hasta que el usuario decida:

```razor
<BlockRenderer TBlock="FunctionApprovalBlock" Context="block">
    @if (block.Status == ApprovalStatus.Pending)
    {
        <button @onclick="block.Approve">Approve</button>
        <button @onclick="() => block.Reject()">Reject</button>
    }
</BlockRenderer>
```

Para las herramientas de backend declaras cómo se renderiza una llamada con un bloque generado por código fuente y luego lo registras con `options.AddGeneratedToolBlocks()`:

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

Las herramientas de frontend son simples delegados de `AIFunctionFactory.Create` añadidos a `ChatOptions.Tools`, de modo que el modelo puede llamar de vuelta al componente (el ejemplo establece el color de acento de la página mediante `InvokeAsync`).

## Estado compartido y AG-UI

`UIAgent<TState>` añade un objeto de estado fuertemente tipado que el agente y el usuario editan juntos. Un `StateMapper` en `UIAgentOptions` aplica el estado entrante, y el estado predictivo permite que el agente prepare un cambio que la UI confirma con `AcceptPredictiveState()` o descarta con `RejectPredictiveState()`.

El estado viaja sobre [AG-UI](https://docs.ag-ui.com/sdk/dotnet): `STATE_SNAPSHOT` lo reemplaza, `STATE_DELTA` lo modifica con JSON Patch de RFC 6902, y los eventos `REASONING_*` aparecen como paneles de razonamiento plegables. Para apuntar la UI a un agente remoto, entrega a `UIAgent` un `AGUIChatClient` en lugar de un cliente de modelo:

```csharp
HttpClient http = httpClientFactory.CreateClient("agentserver");
IChatClient client = new AGUIChatClient(new AGUIChatClientOptions(http, endpoint));
```

Del lado del servidor se usa `AddAGUIServer()` más `MapAGUIServer("/agentic_chat", agent)`, ya sea de `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` o de `AGUI.Server`, el paquete independiente que cubrí en [AG-UI .NET SDK 1.0](/es/2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework/).

## ¿Ya conviene usarlo?

Requiere el SDK de .NET 11 RC1 y la API está abierta explícitamente a comentarios, así que espera cambios de nombre antes de la versión GA. Para una nueva herramienta interna con agentes ya es el camino más corto desde `IChatClient` hasta una UI con aprobaciones. El conjunto completo de escenarios está en el [repositorio de ejemplo AgenticUI](https://github.com/danroth27/AgenticUI).
