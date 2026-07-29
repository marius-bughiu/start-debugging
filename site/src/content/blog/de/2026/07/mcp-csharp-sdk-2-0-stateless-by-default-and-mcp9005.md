---
title: "MCP C# SDK 2.0 ist da: standardmäßig zustandslos und MCP9005 auf altem Code"
description: "ModelContextProtocol 2.0.0 erschien am 2026-07-28 mit standardmäßig aktivem zustandslosem HTTP-Transport, Multi Round-Trip Requests anstelle der servergesteuerten Elicitation und einer Analyzer-Warnung auf ElicitAsync und SampleAsync."
pubDate: 2026-07-29
tags:
  - "mcp"
  - "dotnet"
  - "csharp"
  - "ai-agents"
lang: "de"
translationOf: "2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005"
translatedBy: "claude"
translationDate: 2026-07-29
---

Am 2026-07-28 kündigte Jeff Handley [v2.0 des offiziellen MCP C# SDK](https://devblogs.microsoft.com/dotnet/announcing-v20-of-the-official-mcp-csharp-sdk/) an, veröffentlicht am selben Tag, an dem die Protokollrevision `2026-07-28` final wurde. `ModelContextProtocol` 2.0.0 liegt als stabile Version auf NuGet und unterstützt `net8.0`, `net9.0`, `net10.0` und `netstandard2.0`. Wer einen Server gegen 1.x gebaut hat, sollte dieses Versions-Update nicht ohne einen Blick in den Diff übernehmen.

## Der Handshake ist weg

Die zentrale Änderung ist architektonisch, und sie ist eine Subtraktion. Unter `2026-07-28` gibt es keinen `initialize`-Handshake und keine `Mcp-Session-Id`. Clients rufen `server/discover` auf, und jede folgende Anfrage trägt Protokollversion, Client-Informationen und Capabilities im `_meta` der jeweiligen Anfrage. Genau deshalb konnte [der GitHub MCP Server seinen Redis-Session-Store löschen](/de/2026/07/github-mcp-server-goes-stateless-redis-session-store/).

Im C# SDK zeigt sich das als umgedrehter Standardwert. `HttpServerTransportOptions.Stateless` ist jetzt `true`, ein heute erzeugter Server skaliert also horizontal ohne Sticky Routing. Sessions aktiviert man explizit zurück:

```csharp
builder.Services
    .AddMcpServer()
    .WithHttpTransport(options => options.Stateless = false)
    .WithToolsFromAssembly();
```

## MCP9005 ist die Migrationsliste

Servergesteuerte Anfragen überleben einen zustandslosen Transport nicht. `ElicitAsync`, `SampleAsync` und `RequestRootsAsync` sind jetzt als obsolet markiert und erzeugen die Diagnose `MCP9005`. Kompilieren Sie gegen 2.0.0, und die Warnungsliste ist Ihr Migrationsplan: Jede Stelle, an der der Server mitten im Tool-Aufruf zum Client zurückgegriffen hat, muss neu geschrieben werden.

Der Ersatz heißt Multi Round-Trip Requests. Statt dass der Server den Client aufruft, wirft das Tool eine Exception mit den benötigten Eingaben, der Client löst sie lokal auf und wiederholt den Aufruf dann mit den angehängten Antworten:

```csharp
throw new InputRequiredException(
    inputRequests: new Dictionary<string, InputRequest>
    {
        ["closeReason"] = InputRequest.ForElicitation(...)
    },
    requestState: ticketId.ToString());
```

`requestState` ist der Kniff, der das ohne Session funktionieren lässt: Es ist Ihr Korrelations-Token, das der Client zurückreicht, statt im Serverspeicher zu liegen.

Clients bekommen die einfachere Hälfte. `McpClient` löst MRTR transparent auf, solange ein Handler registriert ist:

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

## Was weiterhin mit alten Gegenstellen spricht

Ein 2.0.0-Client bevorzugt `2026-07-28` und fällt automatisch auf den alten `initialize`-Handshake zurück, wenn der Server nicht auf `server/discover` antwortet. Ein 2.0.0-Server akzeptiert weiterhin `initialize` von 1.x-Clients. Die einzige Kombination, die nicht funktioniert, ist ein alter Client gegen einen zustandslosen Server, und das ist genau der Fall, der sich nicht überbrücken lässt: MRTR gegen einen `2025-11-25`-Client braucht Session-State, um in die alte Elicitation übersetzt zu werden.

Die zweite scharfe Kante: Die experimentelle Tasks-Unterstützung aus 1.3.x und 1.4.x ist verschwunden, ersetzt durch ein neu entworfenes Paket `ModelContextProtocol.Extensions.Tasks` im Einklang mit SEP-2663. Apps und Tasks sind jetzt Opt-in-Pakete statt fester Bestandteil des Kerns und werden mit `.WithTasks(store)` und `.WithMcpApps()` aktiviert.

Eine wirklich schöne Ergänzung für alle, die Server hinter einem Gateway betreiben: `[McpHeader]` hebt einen Tool-Parameter zu einem HTTP-Header, sodass der Proxy darauf routen kann, ohne den JSON-RPC-Body zu parsen.

```csharp
public static async Task<string> GetOrderStatus(
    [McpHeader("Region")] string region,
    string orderId)
```

Beginnen Sie mit `dotnet add package ModelContextProtocol --version 2.0.0`, kompilieren Sie, und lesen Sie die `MCP9005`-Liste, bevor Sie sonst etwas anfassen. Die [Release Notes zu v2.0.0](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.0.0) listen alle 10 Breaking Changes auf, darunter die Neunummerierung der JSON-RPC-Fehlercodes, die `UnsupportedProtocolVersion` auf `-32022` verschiebt.
