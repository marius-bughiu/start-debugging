---
title: "Generative AI for Beginners .NET v2: reconstruido para .NET 10 con Microsoft.Extensions.AI"
description: "El curso gratuito de IA generativa para desarrolladores .NET de Microsoft entrega la Versión 2, reconstruida para .NET 10 y migrada de Semantic Kernel al patrón IChatClient de Microsoft.Extensions.AI."
pubDate: 2026-03-29
tags:
  - "dotnet"
  - "dotnet-10"
  - "ai"
  - "ai-agents"
  - "llm"
  - "microsoft-extensions-ai"
  - "generative-ai"
lang: "es"
translationOf: "2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai"
translatedBy: "claude"
translationDate: 2026-04-25
---

Microsoft ha actualizado [Generative AI for Beginners .NET](https://aka.ms/genainet) a la Versión 2. El curso es gratuito, de código abierto, y ahora reconstruido enteramente para .NET 10 con un cambio arquitectónico significativo: Semantic Kernel queda fuera como la abstracción principal, reemplazado por [Microsoft.Extensions.AI](https://learn.microsoft.com/en-us/dotnet/ai/microsoft-extensions-ai) (MEAI).

## El cambio a Microsoft.Extensions.AI

La Versión 1 se apoyaba en Semantic Kernel para orquestación y acceso a modelos. La Versión 2 estandariza en la interfaz `IChatClient` de MEAI, que se entrega como parte de .NET 10 y sigue las mismas convenciones de inyección de dependencias que `ILogger`.

El patrón de registro será familiar para cualquier desarrollador .NET:

```csharp
var builder = Host.CreateApplicationBuilder();

// Register any IChatClient-compatible provider
builder.Services.AddChatClient(new OllamaChatClient("phi4"));

var app = builder.Build();
var client = app.Services.GetRequiredService<IChatClient>();

var response = await client.GetStreamingResponseAsync("What is AOT compilation?");
await foreach (var update in response)
    Console.Write(update.Text);
```

La interfaz es agnóstica al proveedor. Intercambiar `OllamaChatClient` por una implementación de Azure OpenAI requiere cambiar una sola línea. El curso usa esto deliberadamente -- las habilidades se transfieren entre proveedores en lugar de encerrarte en el SDK de un único vendor.

## Lo que cubren las cinco lecciones

El currículum reestructurado corre en cinco lecciones autocontenidas:

1. **Fundamentos** -- mecánicas de LLM, tokens, ventanas de contexto, y cómo .NET 10 se integra con APIs de modelos
2. **Técnicas centrales** -- completados de chat, ingeniería de prompts, llamadas a funciones, salidas estructuradas, y básicos de RAG
3. **Patrones de IA** -- búsqueda semántica, generación aumentada por recuperación, pipelines de procesamiento de documentos
4. **Agentes** -- uso de herramientas, orquestación multi-agente, e integración Model Context Protocol (MCP) usando el soporte de cliente MCP integrado de .NET 10
5. **IA responsable** -- detección de sesgos, APIs de seguridad de contenido, y guías de transparencia

La lección de agentes es particularmente relevante si has estado siguiendo el soporte MCP de .NET 10. El curso conecta la orquestación multi-agente directamente con esa característica usando el cliente MCP de `Microsoft.Extensions.AI.Abstractions`, así que puedes correr muestras contra servidores MCP locales o remotos sin gimnasia de framework.

## Migrando de la Versión 1

Las once muestras de Semantic Kernel de la Versión 1 fueron movidas a una carpeta deprecada dentro del repo -- todavía corren, pero ya no se presentan como el patrón recomendado. Si trabajaste a través de la Versión 1, los conceptos centrales siguen siendo los mismos. La migración es mayormente un intercambio en la capa de API: reemplaza `Kernel` y `IKernelBuilder` de Semantic Kernel con `IChatClient` y las extensiones estándar `IServiceCollection`.

El repositorio del curso está en [github.com/microsoft/generative-ai-for-beginners-dotnet](https://github.com/microsoft/generative-ai-for-beginners-dotnet). El curso en sí comienza en [aka.ms/genainet](https://aka.ms/genainet).
