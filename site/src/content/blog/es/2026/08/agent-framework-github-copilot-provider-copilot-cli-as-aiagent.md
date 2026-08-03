---
title: "El proveedor de Copilot de Agent Framework convierte el Copilot CLI en un AIAgent común"
description: "Microsoft.Agents.AI.GitHub.Copilot 1.16.0 se publicó el 2026-07-30. El runtime del Copilot CLI ahora vive detrás de la abstracción AIAgent, los permisos se deniegan por defecto y Squad conecta todo un equipo de agentes como un solo AIAgent."
pubDate: 2026-08-03
tags:
  - "agent-framework"
  - "github-copilot"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "mcp"
lang: "es"
translationOf: "2026/08/agent-framework-github-copilot-provider-copilot-cli-as-aiagent"
translatedBy: "claude"
translationDate: 2026-08-03
---

Microsoft publicó `Microsoft.Agents.AI.GitHub.Copilot` 1.16.0 en NuGet el 2026-07-30, y la [publicación del blog de Agent Framework que salió el mismo día](https://devblogs.microsoft.com/agent-framework/building-agent-teams-with-agent-framework-github-copilot-cli-and-squad/) describe la integración con GitHub Copilot como totalmente soportada tanto en C# como en Python. El efecto práctico: el runtime del Copilot CLI, ese que ejecuta comandos de shell, edita archivos, descarga URLs y habla MCP, ahora es accesible a través de la abstracción `AIAgent` común.

## Dos líneas para tener un agente de código

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

`AsAIAgent` acepta opcionalmente `tools:` e `instructions:`, así que un `AIFunction` que ya registraste en otro lado entra directamente. Lo que recibes de vuelta es un `AIAgent` estándar, lo que significa que `RunStreamingAsync`, `CreateSessionAsync` para contexto multi-turno, y cualquier workflow u orquestación que ya construiste sobre Agent Framework funcionan contra él sin cambios. Esa es la diferencia respecto a manejar [el Copilot SDK directamente](/es/2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp/): dejas de escribir a mano el bucle de eventos de la sesión y tratas a Copilot como un proveedor más.

## Los permisos se deniegan por defecto

El detalle que te va a morder primero es que el agente no puede ejecutar comandos de shell, tocar el sistema de archivos ni descargar URLs hasta que le entregues un manejador de permisos:

```csharp
SessionConfig sessionConfig = new()
{
    OnPermissionRequest = PromptPermission,
};

AIAgent agent = copilotClient.AsAIAgent(sessionConfig);
```

Tu manejador devuelve `PermissionDecision.ApproveOnce()` o `PermissionDecision.Reject()`. Existe un atajo `PermissionHandler.ApproveAll`, y la [página del proveedor en MS Learn](https://learn.microsoft.com/en-us/agent-framework/agents/providers/github-copilot) es directa: eso se ejecuta dentro de un contenedor o dev container, no en tu máquina de trabajo. Los servidores MCP también vienen incluidos, locales por stdio y remotos por HTTP, configurados con `SessionConfig.McpServers`. El intérprete de código, la búsqueda de archivos y la búsqueda web alojada no: la documentación marca los tres como no soportados para este proveedor.

## Squad aprovecha la misma abstracción

La segunda mitad del anuncio es Squad, un esquema multiagente de código abierto donde un coordinador y un puñado de especialistas viven en tu repositorio como archivos markdown bajo `.squad/`. El paquete `Squad.Agents.AI` envuelve al equipo completo como un `DelegatingAIAgent`, así que toda la plantilla se presenta ante tu aplicación como un solo `AIAgent`:

```csharp
builder.Services.AddSquadAgent(o =>
{
    o.SquadFolderPath = @"C:\path\to\your\team-root";
});

var squad = host.Services.GetRequiredService<AIAgent>();
var session = await squad.CreateSessionAsync();
var response = await squad.RunAsync("What can this Squad team do?", session);
```

Cada despacho hacia un especialista emite un span de OpenTelemetry llamado `squad.subagent {Name}`, así que la ramificación aparece en Aspire o Jaeger sin cableado extra. Squad todavía está en alfa (`Squad.Agents.AI` va por la 0.5.5, con previews de la 0.5.6), y necesita `dotnet add package Squad.Agents.AI --prerelease` más el paquete npm `@bradygaster/squad-cli` para generar la carpeta.

El proveedor es la parte que vale la pena adoptar esta semana. Squad es la prueba interesante de que, una vez que un agente de código es simplemente un `AIAgent`, un equipo entero de ellos también puede serlo.
