---
title: "Microsoft Agent Framework controla las llamadas a herramientas riesgosas con FunctionApprovalRequestContent"
description: "Envuelve un AIFunction en ApprovalRequiredAIFunction y el agente se detiene a mitad de la ejecución para pedir permiso. Así funciona el flujo de solicitud y respuesta en C#."
pubDate: 2026-05-06
tags:
  - "dotnet"
  - "ai-agents"
  - "agent-framework"
  - "csharp"
  - "human-in-the-loop"
lang: "es"
translationOf: "2026/05/agent-framework-human-in-the-loop-tool-approval-csharp"
translatedBy: "claude"
translationDate: 2026-05-06
---

Jeremy Likness publicó [Building Blocks for AI Part 3](https://devblogs.microsoft.com/dotnet/microsoft-agent-framework-building-blocks-for-ai-part-3/) en el .NET Blog el 4 de mayo de 2026, y la pieza que vale la pena destacar para quien lleva agentes a producción es el flujo de aprobación humana en el ciclo de llamadas a herramientas. Microsoft Agent Framework 1.0 (`Microsoft.Agents.AI` en NuGet) lo trata como un estado de ejecución de primera clase: cuando se invoca una herramienta sensible, el agente no la llama. Se pausa, expone la llamada, y espera a que tu aplicación la apruebe o rechace antes de que la siguiente ejecución continúe.

## Marca una función como que requiere aprobación

El envoltorio es `ApprovalRequiredAIFunction`. Construyes un `AIFunction` normal a partir de un delegado, lo envuelves una vez, y luego pasas la instancia envuelta a `AsAIAgent`. El modelo sigue viendo el mismo esquema; solo cambia el sitio de llamada del framework.

```csharp
using System.ComponentModel;
using Azure.AI.Projects;
using Azure.Identity;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

[Description("Get the weather for a given location.")]
static string GetWeather([Description("The location to get the weather for.")] string location)
    => $"The weather in {location} is cloudy with a high of 15C.";

AIFunction weatherFunction = AIFunctionFactory.Create(GetWeather);
AIFunction approvalRequired = new ApprovalRequiredAIFunction(weatherFunction);

AIAgent agent = new AIProjectClient(
    new Uri("<your-foundry-project-endpoint>"),
    new DefaultAzureCredential())
    .AsAIAgent(
        model: "gpt-4o-mini",
        instructions: "You are a helpful assistant",
        tools: [approvalRequired]);
```

No cambias el cuerpo de la función. Cualquier cosa que deba requerir un paso de confirmación (escrituras a la base de datos, llamadas de pago, correo saliente, cualquier cosa que no quieras que un argumento alucinado active) recibe el envoltorio, y solo esas.

## Detecta la solicitud

Cuando el modelo decide llamar a una herramienta con aprobación obligatoria, el framework devuelve una respuesta que contiene uno o más elementos `FunctionApprovalRequestContent` en lugar del valor de retorno de la herramienta. Después de cada `RunAsync`, escaneas el contenido de los mensajes en busca de ellos.

```csharp
AgentSession session = await agent.CreateSessionAsync();
AgentResponse response = await agent.RunAsync(
    "What is the weather like in Amsterdam?", session);

var requests = response.Messages
    .SelectMany(m => m.Contents)
    .OfType<FunctionApprovalRequestContent>()
    .ToList();

foreach (var req in requests)
{
    Console.WriteLine($"Approval needed for {req.FunctionCall.Name}");
    Console.WriteLine($"Arguments: {req.FunctionCall.Arguments}");
}
```

`FunctionCall.Name` y `FunctionCall.Arguments` son lo que renderizas para el usuario. Muestra los argumentos reales, no solo el nombre de la función. El propósito de la barrera es que el modelo eligió los argumentos, y `delete_account(id: 42)` es la parte sobre la que quieres un ojo humano.

## Devuelve la respuesta

La respuesta se construye a partir de la propia solicitud. `requestContent.CreateResponse(true)` produce un `FunctionApprovalResponseContent`; pasa `false` para rechazar. Envuélvelo en un `ChatMessage` de usuario, ejecuta de nuevo sobre la misma sesión, y el agente o bien ejecuta la herramienta o continúa sin su resultado.

```csharp
var approvalMessage = new ChatMessage(
    ChatRole.User,
    [requests[0].CreateResponse(approve: true)]);

AgentResponse final = await agent.RunAsync(approvalMessage, session);
Console.WriteLine(final);
```

## Itera, no asumas

Un único turno de usuario puede producir varias solicitudes de aprobación, sobre todo con un planificador que agrupa llamadas. La documentación es explícita: sigue buscando `FunctionApprovalRequestContent` después de cada ejecución hasta que la respuesta no contenga ninguna. Si solo manejas la primera solicitud y das por terminado, vas a perder silenciosamente las llamadas a herramientas posteriores y vas a terminar con una respuesta a la que le faltan datos.

Para escenarios de flujo de trabajo, `AgentWorkflowBuilder.BuildSequential()` ya entiende el contrato de aprobación: pausa el flujo y emite un `RequestInfoEvent`, sin plomería extra. Ejemplo ejecutable completo en el [repositorio microsoft/agent-framework](https://github.com/microsoft/agent-framework/tree/main/dotnet/samples/02-agents/Agents/Agent_Step01_UsingFunctionToolsWithApprovals), y la API está documentada en [learn.microsoft.com](https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval).
