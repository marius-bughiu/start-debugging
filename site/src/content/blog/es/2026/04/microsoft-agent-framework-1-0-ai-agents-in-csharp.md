---
title: "Microsoft Agent Framework 1.0: construyendo agentes de IA en C# puro"
description: "Microsoft Agent Framework llega a 1.0 con APIs estables, conectores multi-proveedor, orquestación multi-agente, e interoperabilidad A2A/MCP. Aquí está cómo se ve en la práctica en .NET 10."
pubDate: 2026-04-07
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "ai"
  - "microsoft-agent-framework"
lang: "es"
translationOf: "2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

Microsoft entregó [Agent Framework 1.0](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/) el 3 de abril de 2026, tanto para .NET como para Python. Esta es la versión lista para producción: APIs estables, compromiso de soporte a largo plazo, y una ruta de actualización clara desde el preview que aterrizó a principios de este año.

Agent Framework unifica la fontanería empresarial de Semantic Kernel con los patrones de orquestación multi-agente de AutoGen en un solo framework. Si has estado siguiendo esos dos proyectos por separado, esa división se acabó.

## Lo que viene en la caja

La versión 1.0 cubre cinco áreas que antes requerían unir múltiples bibliotecas:

**Conectores de servicio** de primera mano para Azure OpenAI, OpenAI, Anthropic Claude, Amazon Bedrock, Google Gemini, y Ollama. Cambiar de proveedor es un cambio de una línea porque cada conector implementa `IChatClient` de `Microsoft.Extensions.AI`.

Patrones de **orquestación multi-agente** trasladados desde Microsoft Research y AutoGen: secuencial, concurrente, handoff, group chat, y Magentic-One. Estos no son demos de juguete, son los mismos patrones que el equipo de AutoGen validó en entornos de investigación.

**Soporte MCP** permite a los agentes descubrir e invocar herramientas expuestas por cualquier servidor Model Context Protocol. El soporte del protocolo **A2A (Agent-to-Agent)** va más allá, permitiendo que agentes que corren en diferentes frameworks o runtimes se coordinen a través de mensajería estructurada.

Un pipeline de **middleware** para interceptar y transformar el comportamiento del agente en cada etapa de ejecución, más **proveedores de memoria** enchufables para historial de conversación, estado clave-valor, y recuperación vectorial.

## Un agente mínimo en cinco líneas

La ruta más rápida de cero a un agente corriendo:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;

AIAgent agent = new OpenAIClient("your-api-key")
    .GetChatClient("gpt-4o-mini")
    .AsIChatClient()
    .CreateAIAgent(
        instructions: "You are a senior .NET architect. Be concise and production-focused.");

var response = await agent.RunAsync("Design a retry policy for transient SQL failures.");
Console.WriteLine(response);
```

`AsIChatClient()` puentea el cliente OpenAI a la abstracción `IChatClient`. `CreateAIAgent()` lo envuelve con contexto de instrucción, registro de herramientas, e hilo de conversación. Reemplaza `OpenAIClient` con cualquier otro conector soportado y el resto del código se mantiene idéntico.

## Agregando herramientas

Los agentes se vuelven útiles cuando pueden llamar a tu código. Registra herramientas con `AIFunctionFactory`:

```csharp
using Microsoft.Agents.AI;

var tools = new[]
{
    AIFunctionFactory.Create((string query) =>
    {
        // search your internal docs, database, etc.
        return $"Results for: {query}";
    }, "search_docs", "Search internal documentation")
};

AIAgent agent = chatClient.CreateAIAgent(
    instructions: "Use search_docs to answer questions from internal docs.",
    tools: tools);
```

El framework maneja el descubrimiento de herramientas, la generación de esquemas, y la invocación automáticamente. Las herramientas expuestas por MCP funcionan de la misma forma, el agente las resuelve en runtime desde cualquier servidor compatible con MCP.

## Por qué esto importa ahora

Antes de 1.0, construir un agente .NET significaba elegir entre Semantic Kernel (buena integración empresarial, orquestación limitada) o AutoGen (patrones multi-agente potentes, historia .NET más áspera). Agent Framework elimina esa elección. Un paquete, un modelo de programación, listo para producción.

Los paquetes NuGet son `Microsoft.Agents.AI` para el core y `Microsoft.Agents.AI.OpenAI` (o la variante específica del proveedor) para los conectores. Instala con:

```bash
dotnet add package Microsoft.Agents.AI.OpenAI
```

La documentación y muestras completas están en [GitHub](https://github.com/microsoft/agent-framework) y [Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/overview/).
