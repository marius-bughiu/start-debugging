---
title: "Microsoft `mcp`: cableando servidores Model Context Protocol desde C# en .NET 10"
description: "Cómo cablear servidores Model Context Protocol (MCP) en C# sobre .NET 10 usando microsoft/mcp. Cubre contratos de herramientas, validación de entradas, autenticación, observabilidad y patrones listos para producción."
pubDate: 2026-01-10
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "mcp"
  - "ai-agents"
lang: "es"
translationOf: "2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10"
translatedBy: "claude"
translationDate: 2026-04-30
---
El GitHub Trending de hoy (C#, diario) incluye **`microsoft/mcp`**, el repositorio de Microsoft para Model Context Protocol (MCP). Si estás construyendo herramientas internas sobre **.NET 10** y quieres una frontera limpia entre un cliente LLM y tus sistemas reales (archivos, tickets, bases de datos, CI), MCP es la forma a vigilar.

Fuente: [microsoft/mcp](https://github.com/microsoft/mcp)

## El cambio útil: las herramientas se vuelven un contrato, no pegamento ad-hoc

La mayoría de las "integraciones de IA" empiezan como código pegamento ad-hoc: plantillas de prompt, un par de llamadas HTTP y un montón creciente de "una herramienta más". En el momento en que necesitas confiabilidad, auditoría o una historia local de desarrollador, quieres un contrato:

-   un conjunto descubrible de herramientas,
-   entradas y salidas tipadas,
-   transporte predecible,
-   registros sobre los que puedas razonar.

Eso es lo que MCP busca: una frontera de protocolo para que cliente y servidor puedan evolucionar de forma independiente.

## La forma de un servidor MCP minúsculo en C# (lo que vas a implementar de verdad)

La superficie exacta de la API depende de qué biblioteca C# de MCP elijas (y aún es temprano). Sin embargo, la forma del servidor es estable: definir herramientas, validar entradas, ejecutar y devolver salida estructurada.

Aquí va un ejemplo mínimo en estilo C# 14 para .NET 10 que muestra el enfoque "contrato primero". Trátalo como una plantilla para la forma de tus manejadores.

```cs
using System.Text.Json;

public static class CiTools
{
    public static string GetBuildStatus(JsonElement args)
    {
        if (!args.TryGetProperty("pipeline", out var pipelineProp) || pipelineProp.ValueKind != JsonValueKind.String)
            throw new ArgumentException("Missing required string argument: pipeline");

        var pipeline = pipelineProp.GetString()!;

        // Replace with your real implementation (Azure DevOps, GitHub, Jenkins).
        var status = new
        {
            pipeline,
            state = "green",
            lastRunUtc = DateTimeOffset.UtcNow.AddMinutes(-7),
        };

        return JsonSerializer.Serialize(status);
    }
}
```

Las partes importantes no son los detalles del parseo JSON. Las partes importantes son:

-   **Validación de entradas explícita**: MCP hace fácil olvidar que estás construyendo una API. Trátalo como tal.
-   **Sin estado ambiente implícito**: pasa las dependencias, registra todo.
-   **Resultados estructurados**: devuelve formas estables, no cadenas imposibles de comparar.

## Dónde aterriza esto en una base de código real de .NET 10

Si adoptas MCP en producción, te importarán las mismas cosas que te importan en cualquier servicio:

-   **Autenticación**: el servidor debe imponer la identidad, no el cliente.
-   **Mínimo privilegio**: las herramientas deben exponer la menor superficie posible.
-   **Observabilidad**: IDs de solicitud, registros de invocación de herramientas y métricas de fallos.
-   **Determinismo**: las herramientas deben ser seguras de invocar varias veces, e idempotentes cuando sea posible.

Si haces solo una cosa esta semana: clona el repo, hojea los documentos del protocolo y redacta una lista de 5 herramientas que actualmente implementas como "pegamento de prompts". Esa lista suele bastar para justificar una frontera MCP adecuada.

Recurso: [microsoft/mcp](https://github.com/microsoft/mcp)
