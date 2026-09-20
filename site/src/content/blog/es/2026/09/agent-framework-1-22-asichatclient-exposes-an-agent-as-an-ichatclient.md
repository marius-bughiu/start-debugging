---
title: "Agent Framework 1.22: AsIChatClient permite que un AIAgent se haga pasar por un IChatClient"
description: "Microsoft Agent Framework .NET 1.22.0 agrega AIAgent.AsIChatClient(), que cierra el viaje de ida y vuelta con IChatClient.AsAIAgent(). Tu agente, con sus instrucciones y herramientas intactas, ahora encaja en cualquier API que reciba un IChatClient."
pubDate: 2026-09-20
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
lang: "es"
translationOf: "2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient"
translatedBy: "claude"
translationDate: 2026-09-20
---

Microsoft Agent Framework [dotnet-1.22.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.22.0) salió el 2026-09-18, y la entrada que merece tu atención es la [PR #7687](https://github.com/microsoft/agent-framework/pull/7687): `AsIChatClient`. `Microsoft.Extensions.AI` ya tenía desde hace tiempo `ChatClientExtensions.AsAIAgent()`, que convierte un cliente de chat en un agente. La dirección inversa no existía. Ahora sí, y el viaje de ida y vuelta queda cerrado.

## Por qué dolía la dirección que faltaba

La lista de APIs de .NET que aceptan un `IChatClient` no deja de crecer: los evaluadores de `Microsoft.Extensions.AI.Evaluation`, el middleware de caché y de telemetría, y todo lo construido sobre la canalización de `ChatClientBuilder`. Un `AIAgent` es el objeto más rico. Lleva instrucciones, un conjunto de herramientas, una sesión y todo el middleware con el que lo hayas envuelto. Entregar a una de esas APIs un `IChatClient` pelado significaba reconstruir todo eso a mano, o darle al evaluador que actúa como juez un modelo sin nada del system prompt que lo convierte en juez.

`AsIChatClient` vive en `Microsoft.Agents.AI` y tiene esta forma:

```csharp
public static IChatClient AsIChatClient(
    this AIAgent agent,
    AgentSession? session = null,
    string? conversationId = null,
    bool allowNonChatClientAgents = false)
```

Así, un agente juez se convierte en un cliente de chat juez con una sola llamada:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIAgent judge = chatClient.CreateAIAgent(
    instructions: "You score answers for factual accuracy. Reply with JSON only.",
    name: "Judge");

IChatClient judgeClient = judge.AsIChatClient();
```

El adaptador es un `AIAgentChatClient` interno que mapea `GetResponseAsync` y `GetStreamingResponseAsync` sobre `RunAsync` y `RunStreamingAsync`, y transporta tus `ChatOptions` como `ChatClientAgentRunOptions`. La cancelación fluye a través de él, y un `GetService<IChatClient>()` sin clave devuelve el adaptador, mientras que cualquier otra solicitud de servicio se reenvía al agente.

## La protección, y cuándo desactivarla

Por omisión la llamada lanza `InvalidOperationException` salvo que el agente sea un `ChatClientAgent` o devuelva uno desde un `GetService<ChatClientAgent>()` sin clave. Los decoradores construidos sobre `DelegatingAIAgent` reenvían esa solicitud, así que un agente envuelto sigue pasando la prueba.

Pon `allowNonChatClientAgents: true` y se envolverá cualquier tipo de agente, pero lee la letra chica: solo `ChatOptions.ResponseFormat` sobrevive al viaje. La temperatura, las herramientas y lo demás se ignoran en silencio, porque un agente de flujo de trabajo o un agente A2A remoto no tiene opciones de chat a las que aplicarlas.

Las sesiones son el otro filo. En el modo sin estado predeterminado, un `ChatOptions.ConversationId` no vacío lanza una excepción, y los identificadores crudos de respuesta se limpian en las copias que recibes. Pasa una `session` y el cliente reportará un único identificador de conversación estable para cada respuesta: el que tú suministraste, o uno generado por instancia. Nunca filtra el identificador del lado del servicio, lo que mantiene el estado de conversación del proveedor dentro de la sesión, que es donde corresponde. Cualquier otro identificador no vacío lanza una excepción por desconocido.

La API está marcada con `[Experimental]`, así que espera un error de compilación hasta que suprimas el diagnóstico al que apunta.

Hay otra línea en la misma versión que conviene buscar en tu código: la [PR #8531](https://github.com/microsoft/agent-framework/pull/8531) ahora pasa las herramientas de `ChatClientAgent` por ejecución en lugar de fijarlas en el cliente de chat subyacente que invoca funciones, lo que evita que las herramientas se dupliquen o se filtren entre agentes que comparten un cliente. Está marcada como BREAKING, igual que la promoción de `AgentSessionStore` a `Microsoft.Agents.AI.Abstractions`.

Actualiza a `Microsoft.Agents.AI` 1.22.0 y, si te saltaste la versión de la semana pasada, revisa [qué cambió 1.21 sobre LocalCodeAct y el entorno de tu host](/es/2026/09/agent-framework-1-21-localcodeact-stops-inheriting-host-environment/) antes de seguir.
