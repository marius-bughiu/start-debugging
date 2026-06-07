---
title: "El SDK de GitHub Copilot llega a GA: integra el runtime de agentes de Copilot en tus propias apps de C#"
description: "En Build 2026 GitHub lanzó Copilot SDK 1.0 GA con un paquete de .NET de primera clase. Ahora puedes manejar desde código C# el mismo runtime de agente con planificación, llamadas a herramientas y sesiones multironda, BYOK incluido."
pubDate: 2026-06-07
tags:
  - "github-copilot"
  - "copilot-sdk"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "mcp"
lang: "es"
translationOf: "2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp"
translatedBy: "claude"
translationDate: 2026-06-07
---

GitHub anunció que el [SDK de GitHub Copilot alcanzó disponibilidad general](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/) el 2 de junio de 2026 en Build, y la parte que merece tu atención como desarrollador de .NET es el paquete `GitHub.Copilot.SDK`. Te da acceso directo y programático al mismo runtime de agente que está detrás de Copilot en el editor: planificación, invocación de herramientas, edición de archivos, streaming y sesiones multironda. El argumento de venta es que no tienes que construir tú la capa de orquestación. El runtime que ya procesa millones de turnos de agente al día ahora es una dependencia de NuGet.

## Lo que obtienes en realidad

El SDK llegó en seis lenguajes en su GA (`@github/copilot-sdk`, `github-copilot-sdk` para Python, Go, Rust, Java y `GitHub.Copilot.SDK` para .NET). Para Node.js, Python y .NET la CLI de Copilot se incluye automáticamente como dependencia transitiva, así que no hay un binario aparte que instalar ni mantener en el PATH. Agregas un paquete y ya tienes un host de agentes:

```bash
dotnet add package GitHub.Copilot.SDK
```

Una sesión es la unidad de trabajo. Inicias un cliente, abres una sesión contra un modelo y escuchas eventos tipados en lugar de hacer sondeos. Aquí está el recorrido completo para un solo prompt:

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

El streaming es un flag, no una API distinta: pon `Streaming = true` en `SessionConfig` y recibirás fragmentos `AssistantMessageDeltaEvent` que acumulas hasta el `AssistantMessageEvent` final.

## Las herramientas son métodos comunes, y MCP viene integrado

La pieza que hace que esto sea algo más que un envoltorio de chat son las herramientas personalizadas. `CopilotTool.DefineTool` recibe un delegado y reutiliza la factoría de funciones de `Microsoft.Extensions.AI`, así que una herramienta es simplemente un método de C# tipado con un `[Description]` en cada parámetro:

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

Si ya construiste [un servidor MCP personalizado en C#](/es/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/), el agente puede conectarse a él directamente, así que tus herramientas existentes vienen contigo sin reescribir nada.

## BYOK para que no quede atado a la facturación de GitHub

La autenticación es la otra razón para mirar esto. De fábrica, el SDK toma tu sesión de la CLI `copilot` o los tokens de entorno (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`). Pero bring-your-own-key funciona con OpenAI, Microsoft Foundry, Anthropic y otros proveedores, así que puedes apuntar el runtime a un modelo que ya pagas:

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

También trae trazado OpenTelemetry con propagación de contexto de traza W3C, así que las llamadas a herramientas y los turnos del agente aparecen en las mismas trazas que el resto de tu servicio. Para quien ha estado escribiendo a mano un bucle de herramientas sobre un cliente de chat crudo, el paquete GA es la primera vez que el propio runtime de agente de GitHub es algo que puedes hacer `dotnet add` y enviar a producción. El [cookbook de .NET y la guía de inicio](https://github.com/github/copilot-sdk) son el siguiente lugar al que ir.
