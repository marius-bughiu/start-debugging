---
title: "MCP C# SDK 2.3: McpClient.ServerInfo ahora es anulable, y tu compilación puede notarlo"
description: "ModelContextProtocol 2.3.0, publicado el 20 de octubre de 2026, cambia McpClient.ServerInfo de Implementation a Implementation? porque los servidores 2026-07-28 pueden omitir su identidad en server/discover. Aquí está el porqué, qué se rompe con advertencias como errores y la corrección de una línea."
pubDate: 2026-10-21
tags:
  - "mcp"
  - "dotnet"
  - "csharp"
  - "ai-agents"
lang: "es"
translationOf: "2026/10/mcp-csharp-sdk-2-3-serverinfo-is-nullable"
translatedBy: "claude"
translationDate: 2026-10-21
---

El [MCP C# SDK 2.3.0](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.3.0) se publicó el 20 de octubre de 2026 y trae un cambio que normalmente no esperarías en una versión menor: `McpClient.ServerInfo` ahora está anotado como `Implementation?` en lugar de `Implementation`. La firma del CLR es idéntica, así que nada se rompe en tiempo de ejecución ni para los llamadores ya compilados. Lo que se rompe es cualquier proyecto con `<Nullable>enable</Nullable>` y `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` que acceda directamente a la propiedad.

## Por qué un servidor conectado puede no tener identidad

En la revisión `2026-07-28` del protocolo, el handshake es `server/discover` en lugar del `initialize` heredado. Durante el descubrimiento, los metadatos `io.modelcontextprotocol/serverInfo` son opcionales. Un servidor puede responder al descubrimiento, anunciar sus herramientas y atender llamadas sin decir nunca quién es.

Antes de la 2.3.0, el SDK no modelaba ese caso. La conexión a un servidor así tenía éxito, pero leer `ServerInfo` después lanzaba `InvalidOperationException`, la misma excepción que obtienes cuando el cliente no está conectado en absoluto. Un servidor perfectamente válido parecía una conexión rota. El [PR #1903](https://github.com/modelcontextprotocol/csharp-sdk/pull/1903) lo corrigió devolviendo `null`:

```csharp
public override Implementation? ServerInfo => _serverCapabilities is null
    ? throw new InvalidOperationException("The client is not connected.")
    : _serverInfo;
```

De ahí salen tres reglas:

- Aún sin conexión: sigue lanzando `InvalidOperationException`.
- Conectado mediante `2026-07-28` y el servidor omitió su identidad: `null`.
- Conectado mediante el `initialize` heredado: nunca `null`, porque esa ruta sigue exigiendo `serverInfo`.

Los metadatos mal formados siguen haciendo fallar la conexión con una `JsonException`, así que `null` significa realmente "no proporcionado", no "basura".

## La corrección en el código del cliente

Código como este ahora produce CS8602 en el acceso a `.Name`:

```csharp
await using var client = await McpClient.CreateAsync(transport);

logger.LogInformation("Connected to {Server} {Version}",
    client.ServerInfo.Name, client.ServerInfo.Version);
```

Maneja el caso nulo de forma explícita:

```csharp
await using var client = await McpClient.CreateAsync(transport);

var name = client.ServerInfo?.Name ?? "Unknown server";
var version = client.ServerInfo?.Version ?? "n/a";

logger.LogInformation("Connected to {Server} {Version}", name, version);
```

Resiste la tentación del operador `!`. Silencia la advertencia y trae de vuelta una `NullReferenceException` la primera vez que alguien apunte tu cliente a un servidor que solo hace descubrimiento. Las notas de la versión también son tajantes en que esta identidad autodeclarada "no debe usarse para decisiones de seguridad". Si tu código controla el acceso a herramientas según `ServerInfo.Name`, eso ya estaba mal, y un `null` aquí es un buen momento para reemplazarlo por una configuración que tú controles.

## El resto de la 2.3.0

La versión trae sobre todo trabajo de interoperabilidad y confiabilidad que vale la pena adoptar de todos modos:

- `McpClientOptions.TimeProvider` permite que las pruebas controlen los tiempos de espera del cliente con `FakeTimeProvider` en lugar de esperas reales. OAuth ahora queda excluido del presupuesto corto de `DiscoverProbeTimeout`, pero sigue limitado por `InitializationTimeout`.
- Las herramientas, los prompts y los recursos se listan en orden de registro (#1924), así que la salida de `tools/list` es estable entre ejecuciones.
- Las respuestas Streamable HTTP modernas esperan el primer mensaje del protocolo antes de enviar los encabezados. Un handler que permanece en silencio durante mucho tiempo ahora puede necesitar notificaciones de progreso o un tiempo de espera HTTP más largo.
- Los clientes stdio cierran el stdin del servidor antes de esperar una salida ordenada, y las respuestas POST del SSE heredado se liberan de forma determinista.
- Las respuestas HTTP 400 de Streamable HTTP incluyen el error de análisis JSON, lo que hace mucho más rápido depurar cargas útiles mal formadas del cliente.

Actualizar es solo cambiar la versión del paquete:

```bash
dotnet add package ModelContextProtocol --version 2.3.0
```

Si todavía estás en la 1.x, haz primero la [migración de 1.x a 2.x](/2026/09/migrate-mcp-csharp-sdk-1-x-to-2-0-without-breaking-old-clients/), luego compila con las advertencias como errores y deja que el compilador te muestre cada acceso a `ServerInfo`.
