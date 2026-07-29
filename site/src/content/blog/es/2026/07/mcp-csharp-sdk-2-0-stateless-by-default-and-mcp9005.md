---
title: "Llega el MCP C# SDK 2.0: sin estado por defecto y MCP9005 sobre tu código viejo"
description: "ModelContextProtocol 2.0.0 salió el 2026-07-28 con el transporte HTTP sin estado activado por defecto, Multi Round-Trip Requests en lugar de la elicitación iniciada por el servidor, y una advertencia del analizador sobre ElicitAsync y SampleAsync."
pubDate: 2026-07-29
tags:
  - "mcp"
  - "dotnet"
  - "csharp"
  - "ai-agents"
lang: "es"
translationOf: "2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005"
translatedBy: "claude"
translationDate: 2026-07-29
---

El 2026-07-28 Jeff Handley anunció [la v2.0 del SDK oficial de MCP para C#](https://devblogs.microsoft.com/dotnet/announcing-v20-of-the-official-mcp-csharp-sdk/), publicada el mismo día en que la revisión del protocolo `2026-07-28` quedó final. `ModelContextProtocol` 2.0.0 está en NuGet como versión estable, con soporte para `net8.0`, `net9.0`, `net10.0` y `netstandard2.0`. Si construiste un servidor sobre 1.x, esta no es una subida de versión que puedas tomar sin leer el diff.

## El handshake desapareció

El cambio principal es arquitectónico, y es una resta. Bajo `2026-07-28` no hay handshake `initialize` ni `Mcp-Session-Id`. Los clientes llaman a `server/discover`, y cada solicitud posterior lleva la versión del protocolo, la información del cliente y las capacidades en el `_meta` de cada solicitud. Eso es lo que permitió que [el servidor MCP de GitHub eliminara su almacén de sesiones en Redis](/es/2026/07/github-mcp-server-goes-stateless-redis-session-store/).

En el SDK de C# esto aparece como un cambio de valor por defecto. `HttpServerTransportOptions.Stateless` ahora es `true`, así que un servidor que generes hoy escala horizontalmente sin enrutamiento con afinidad de sesión. Vuelves a las sesiones de forma explícita:

```csharp
builder.Services
    .AddMcpServer()
    .WithHttpTransport(options => options.Stateless = false)
    .WithToolsFromAssembly();
```

## MCP9005 es la lista de migración

Las solicitudes iniciadas por el servidor no sobreviven a un transporte sin estado. `ElicitAsync`, `SampleAsync` y `RequestRootsAsync` ahora están marcados como obsoletos y producen el diagnóstico `MCP9005`. Compila contra 2.0.0 y la lista de advertencias es tu plan de migración: cada punto donde el servidor solía llamar de vuelta al cliente en medio de una invocación de herramienta hay que reescribirlo.

El reemplazo es Multi Round-Trip Requests. En lugar de que el servidor llame al cliente, la herramienta lanza una excepción con las entradas que necesita, el cliente las resuelve localmente y luego reintenta la llamada con las respuestas adjuntas:

```csharp
throw new InputRequiredException(
    inputRequests: new Dictionary<string, InputRequest>
    {
        ["closeReason"] = InputRequest.ForElicitation(...)
    },
    requestState: ticketId.ToString());
```

`requestState` es el truco que hace que esto funcione sin sesión: es tu token de correlación, devuelto por el cliente en lugar de quedar guardado en la memoria del servidor.

Los clientes se llevan la mitad fácil. `McpClient` resuelve MRTR de forma transparente siempre que registres un manejador:

```csharp
var client = await McpClient.CreateAsync(
    clientTransport,
    clientOptions: new()
    {
        Handlers = new McpClientHandlers
        {
            ElicitationHandler = (requestParams, ct) =>
                ValueTask.FromResult(
                    new ElicitResult { Action = "accept" })
        }
    });
```

## Qué sigue hablando con pares antiguos

Un cliente 2.0.0 prefiere `2026-07-28` y cae automáticamente al handshake `initialize` heredado cuando el servidor no responde a `server/discover`. Un servidor 2.0.0 sigue aceptando `initialize` de clientes 1.x. La única combinación que no funciona es un cliente antiguo contra un servidor sin estado, que es justo el caso que no se puede puentear, porque MRTR contra un cliente `2025-11-25` requiere estado de sesión para traducirse a la elicitación heredada.

El otro filo peligroso: el soporte experimental de Tasks de 1.3.x y 1.4.x desapareció, reemplazado por un paquete `ModelContextProtocol.Extensions.Tasks` rediseñado y alineado con SEP-2663. Apps y Tasks ahora son paquetes opcionales en lugar de estar integrados en el núcleo, y se activan con `.WithTasks(store)` y `.WithMcpApps()`.

Una adición genuinamente buena para quien ejecute servidores detrás de una pasarela: `[McpHeader]` promueve un parámetro de herramienta a cabecera HTTP, así tu proxy puede enrutar sobre ella sin parsear el cuerpo JSON-RPC.

```csharp
public static async Task<string> GetOrderStatus(
    [McpHeader("Region")] string region,
    string orderId)
```

Empieza con `dotnet add package ModelContextProtocol --version 2.0.0`, compila y lee la lista de `MCP9005` antes de tocar cualquier otra cosa. Las [notas de la versión v2.0.0](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.0.0) enumeran los 10 cambios incompatibles, incluida la renumeración de códigos de error JSON-RPC que mueve `UnsupportedProtocolVersion` a `-32022`.
