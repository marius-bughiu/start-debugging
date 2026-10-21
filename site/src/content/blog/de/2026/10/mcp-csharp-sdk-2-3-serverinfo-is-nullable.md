---
title: "MCP C# SDK 2.3: McpClient.ServerInfo ist jetzt nullbar, und Ihr Build könnte es bemerken"
description: "ModelContextProtocol 2.3.0, veröffentlicht am 20. Oktober 2026, ändert McpClient.ServerInfo von Implementation zu Implementation?, weil Server mit 2026-07-28 ihre Identität in server/discover weglassen dürfen. Hier steht, warum das so ist, was unter Warnungen-als-Fehler bricht und wie die Korrektur in einer Zeile aussieht."
pubDate: 2026-10-21
tags:
  - "mcp"
  - "dotnet"
  - "csharp"
  - "ai-agents"
lang: "de"
translationOf: "2026/10/mcp-csharp-sdk-2-3-serverinfo-is-nullable"
translatedBy: "claude"
translationDate: 2026-10-21
---

Das [MCP C# SDK 2.3.0](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.3.0) erschien am 20. Oktober 2026 und bringt eine Änderung mit, die eine Minor-Version normalerweise nicht enthalten würde: `McpClient.ServerInfo` ist jetzt als `Implementation?` statt als `Implementation` annotiert. Die CLR-Signatur ist identisch, daher bricht zur Laufzeit und für bereits kompilierte Aufrufer nichts. Es bricht jedes Projekt mit `<Nullable>enable</Nullable>` und `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`, das die Eigenschaft direkt dereferenziert.

## Warum ein verbundener Server keine Identität haben kann

Mit der Protokollrevision `2026-07-28` ist der Handshake `server/discover` statt des älteren `initialize`. Bei der Discovery sind die Metadaten `io.modelcontextprotocol/serverInfo` optional. Ein Server kann auf Discovery antworten, seine Tools bekannt machen und Aufrufe bedienen, ohne je zu sagen, wer er ist.

Vor 2.3.0 bildete das SDK das nicht ab. Die Verbindung zu einem solchen Server gelang, aber das anschließende Lesen von `ServerInfo` warf `InvalidOperationException`, dieselbe Ausnahme, die Sie erhalten, wenn der Client gar nicht verbunden ist. Ein völlig gültiger Server wirkte wie eine defekte Verbindung. [PR #1903](https://github.com/modelcontextprotocol/csharp-sdk/pull/1903) behebt das, indem stattdessen `null` zurückgegeben wird:

```csharp
public override Implementation? ServerInfo => _serverCapabilities is null
    ? throw new InvalidOperationException("The client is not connected.")
    : _serverInfo;
```

Daraus ergeben sich drei Regeln:

- Noch nicht verbunden: wirft weiterhin `InvalidOperationException`.
- Verbunden über `2026-07-28`, und der Server hat seine Identität weggelassen: `null`.
- Verbunden über das ältere `initialize`: nie `null`, denn dieser Pfad verlangt `serverInfo` weiterhin.

Fehlerhafte Metadaten lassen die Verbindung weiterhin mit einer `JsonException` scheitern, `null` bedeutet also wirklich "nicht angegeben" und nicht "Müll".

## Die Korrektur im Client-Code

Code wie dieser löst jetzt CS8602 beim Zugriff auf `.Name` aus:

```csharp
await using var client = await McpClient.CreateAsync(transport);

logger.LogInformation("Connected to {Server} {Version}",
    client.ServerInfo.Name, client.ServerInfo.Version);
```

Behandeln Sie den Null-Fall explizit:

```csharp
await using var client = await McpClient.CreateAsync(transport);

var name = client.ServerInfo?.Name ?? "Unknown server";
var version = client.ServerInfo?.Version ?? "n/a";

logger.LogInformation("Connected to {Server} {Version}", name, version);
```

Verzichten Sie auf den Operator `!`. Er unterdrückt die Warnung und bringt eine `NullReferenceException` zurück, sobald jemand Ihren Client auf einen Server richtet, der nur Discovery bietet. Die Release Notes sagen außerdem deutlich, dass diese selbst gemeldete Identität "nicht für Sicherheitsentscheidungen verwendet werden darf". Wenn Ihr Code den Zugriff auf Tools von `ServerInfo.Name` abhängig macht, war das schon vorher falsch, und ein `null` an dieser Stelle ist ein guter Anlass, es durch Konfiguration unter Ihrer Kontrolle zu ersetzen.

## Der Rest von 2.3.0

Das Release besteht größtenteils aus Arbeit an Interoperabilität und Zuverlässigkeit, die Sie ohnehin mitnehmen sollten:

- `McpClientOptions.TimeProvider` erlaubt es Tests, Client-Timeouts mit `FakeTimeProvider` zu steuern, statt echt zu warten. OAuth ist jetzt vom kurzen Budget `DiscoverProbeTimeout` ausgenommen, unterliegt aber weiterhin `InitializationTimeout`.
- Tools, Prompts und Ressourcen werden in der Reihenfolge ihrer Registrierung aufgelistet (#1924), sodass die Ausgabe von `tools/list` über mehrere Läufe hinweg stabil ist.
- Moderne Streamable-HTTP-Antworten warten auf die erste Protokollnachricht, bevor sie Header senden. Ein Handler, der lange schweigt, benötigt nun eventuell Fortschrittsbenachrichtigungen oder ein längeres HTTP-Timeout.
- Stdio-Clients schließen die stdin des Servers, bevor sie auf ein geordnetes Beenden warten, und ältere SSE-POST-Antworten werden deterministisch freigegeben.
- Streamable-HTTP-400-Antworten enthalten den JSON-Parsefehler, wodurch fehlerhafte Client-Payloads deutlich schneller zu debuggen sind.

Das Upgrade besteht aus einer Paketaktualisierung:

```bash
dotnet add package ModelContextProtocol --version 2.3.0
```

Falls Sie noch auf 1.x sind, führen Sie zuerst die [Migration von 1.x auf 2.x](/2026/09/migrate-mcp-csharp-sdk-1-x-to-2-0-without-breaking-old-clients/) durch, kompilieren Sie dann mit Warnungen als Fehler und lassen Sie sich vom Compiler jede Dereferenzierung von `ServerInfo` zeigen.
