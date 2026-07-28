---
title: "El servidor MCP de GitHub se volvió sin estado y eliminó su almacén de sesiones en Redis"
description: "El 2026-07-23 GitHub lanzó la revisión 2026-07-28 de MCP antes de la fecha de la especificación. Lo notable es lo que se resta: sin handshake initialize, sin Mcp-Session-Id, sin Redis."
pubDate: 2026-07-28
tags:
  - "mcp"
  - "ai-agents"
  - "http"
  - "architecture"
lang: "es"
translationOf: "2026/07/github-mcp-server-goes-stateless-redis-session-store"
translatedBy: "claude"
translationDate: 2026-07-28
---

El 2026-07-23 GitHub anunció que [el servidor MCP de GitHub es compatible con la siguiente especificación de MCP](https://github.blog/changelog/2026-07-23-github-mcp-server-supports-the-next-mcp-specification/), la revisión fechada `2026-07-28`, días antes de que llegara esa fecha. Poner una revisión aún no publicada delante del tráfico de producción es una apuesta. Lo que hace que el anuncio valga la pena es que los cambios principales son todos restas: el almacenamiento de sesiones en Redis, la inspección de paquetes en la capa del proxy y una escritura en base de datos por cada conexión de cliente.

## El handshake y la cabecera de sesión desaparecieron

La revisión `2026-07-28` elimina el handshake de `initialize` y `notifications/initialized`, y elimina la cabecera `Mcp-Session-Id` de Streamable HTTP. Todo lo que el handshake solía establecer ahora viaja en cada solicitud individual dentro de `_meta`, reflejado en cabeceras HTTP para que un balanceador de carga pueda enrutar sin analizar el cuerpo:

```http
POST /mcp HTTP/1.1
Content-Type: application/json
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: get_weather

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": { "location": "Seattle, WA" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "ExampleClient", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

El cuerpo sigue siendo la fuente de verdad. Si una cabecera no coincide con él, el servidor debe responder `400 Bad Request` con el error JSON-RPC `-32020` (`HeaderMismatch`), lo que impide que un gateway enrute por un valor mientras el servidor ejecuta otro.

Ese único cambio es la razón por la que la dependencia de Redis pudo desaparecer. Un almacén de sesiones existía solo para que la segunda solicitud de un cliente encontrara el estado que creó la primera. Sin handshake no hay estado que encontrar, así que cualquier solicitud puede llegar a cualquier instancia y la inicialización deja de escribir en una base de datos.

## Los dos cambios que cuestan trabajo real

Las solicitudes iniciadas por el servidor desaparecieron. Sampling, roots y elicitation solían llegar como solicitudes JSON-RPC enviadas desde el servidor. Con Multi Round-Trip Requests (SEP-2322), el servidor devuelve en su lugar `resultType: "input_required"` con un arreglo `inputRequests`, y el cliente reintenta la llamada original llevando `inputResponses`. GitHub manejó ambas épocas detrás de un wrapper del SDK de Go en vez de romper a los clientes más antiguos.

La reanudabilidad también desapareció. La cabecera `Last-Event-ID` y los IDs de evento SSE se eliminaron, así que un flujo de respuesta interrumpido pierde la solicitud en curso y el cliente debe reemitirla con un nuevo ID de solicitud. Si tu servidor asumía la repetición al reconectar, esa suposición ahora es asunto tuyo.

También vale la pena notarlo antes de planear una migración: Tasks salió del núcleo hacia la extensión `io.modelcontextprotocol/tasks` con `tasks/list` eliminado, y Roots, Sampling y Logging quedan formalmente obsoletos con una ventana de doce meses.

## En qué situación queda tu servidor

Si ya ejecutas Streamable HTTP sin generador de identificadores de sesión, tienes casi todo el camino recorrido, que es el argumento práctico para [elegir Streamable HTTP en lugar de stdio o del transporte SSE heredado](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) para cualquier cosa en red. Los SDK de tier 1 lanzaron soporte en beta preservando la compatibilidad hacia atrás, así que las implementaciones existentes no necesitan ninguna acción para seguir funcionando. Lee la [lista completa de cambios](https://modelcontextprotocol.io/specification/draft/changelog) antes de dar por hecho que eso también aplica a tu propio código.
