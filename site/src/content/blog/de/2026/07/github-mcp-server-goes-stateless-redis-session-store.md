---
title: "Der MCP-Server von GitHub arbeitet jetzt zustandslos und hat seinen Redis-Sitzungsspeicher gelöscht"
description: "Am 2026-07-23 hat GitHub die MCP-Revision 2026-07-28 vor dem Datum der Spezifikation ausgeliefert. Bemerkenswert ist die Subtraktion: kein initialize-Handshake, kein Mcp-Session-Id, kein Redis."
pubDate: 2026-07-28
tags:
  - "mcp"
  - "ai-agents"
  - "http"
  - "architecture"
lang: "de"
translationOf: "2026/07/github-mcp-server-goes-stateless-redis-session-store"
translatedBy: "claude"
translationDate: 2026-07-28
---

Am 2026-07-23 hat GitHub angekündigt, dass [der MCP-Server von GitHub die nächste MCP-Spezifikation unterstützt](https://github.blog/changelog/2026-07-23-github-mcp-server-supports-the-next-mcp-specification/), die Revision mit dem Datum `2026-07-28`, also Tage bevor dieses Datum erreicht war. Eine noch nicht veröffentlichte Revision vor den Produktionsverkehr zu stellen, ist eine Wette. Lesenswert ist die Ankündigung, weil die zentralen Änderungen ausschließlich Subtraktionen sind: der Redis-Sitzungsspeicher, die Paketinspektion in der Proxy-Schicht und ein Datenbankschreibvorgang bei jeder Client-Verbindung.

## Handshake und Sitzungs-Header sind verschwunden

Die Revision `2026-07-28` entfernt den Handshake aus `initialize` und `notifications/initialized` und sie entfernt den Header `Mcp-Session-Id` aus Streamable HTTP. Alles, was der Handshake bisher etabliert hat, reist nun mit jeder einzelnen Anfrage in `_meta` und wird in HTTP-Header gespiegelt, damit ein Load Balancer routen kann, ohne den Body zu parsen:

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

Der Body bleibt die maßgebliche Quelle. Weicht ein Header davon ab, muss der Server mit `400 Bad Request` und dem JSON-RPC-Fehler `-32020` (`HeaderMismatch`) antworten. Das verhindert, dass ein Gateway nach dem einen Wert routet, während der Server nach dem anderen ausführt.

Diese eine Änderung ist der Grund, warum die Redis-Abhängigkeit entfallen konnte. Ein Sitzungsspeicher existierte nur, damit die zweite Anfrage eines Clients den Zustand findet, den die erste erzeugt hat. Ohne Handshake gibt es keinen Zustand zu finden, also kann jede Anfrage auf jeder Instanz landen und die Initialisierung schreibt nicht mehr in eine Datenbank.

## Die zwei Änderungen, die echte Arbeit kosten

Vom Server initiierte Anfragen gibt es nicht mehr. Sampling, Roots und Elicitation kamen bisher als JSON-RPC-Anfragen vom Server. Unter Multi Round-Trip Requests (SEP-2322) liefert der Server stattdessen `resultType: "input_required"` mit einem Array `inputRequests` zurück, und der Client wiederholt den ursprünglichen Aufruf mit `inputResponses`. GitHub hat beide Epochen hinter einem Wrapper des Go-SDK abgebildet, statt ältere Clients zu brechen.

Auch die Wiederaufnahme unterbrochener Streams ist weg. Der Header `Last-Event-ID` und die SSE-Event-IDs wurden entfernt, deshalb verliert ein abgebrochener Antwort-Stream die laufende Anfrage, und der Client muss sie mit einer neuen Anfrage-ID erneut senden. Wer sich beim Reconnect auf Wiederholung verlassen hat, muss das nun selbst lösen.

Ebenfalls erwähnenswert, bevor Sie eine Migration planen: Tasks ist aus dem Kern in die Erweiterung `io.modelcontextprotocol/tasks` gewandert, `tasks/list` wurde entfernt, und Roots, Sampling sowie Logging gelten formal als veraltet, mit einem Zeitfenster von zwölf Monaten.

## Was das für Ihren Server bedeutet

Wer Streamable HTTP bereits ohne Sitzungs-ID-Generator betreibt, hat den größten Teil des Wegs hinter sich. Genau das ist das praktische Argument dafür, [Streamable HTTP gegenüber stdio oder dem alten SSE-Transport zu wählen](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/), sobald etwas über das Netz läuft. Die Tier-1-SDKs haben Beta-Unterstützung ausgeliefert und dabei die Abwärtskompatibilität erhalten, bestehende Bereitstellungen brauchen also keine Maßnahme, um weiterzulaufen. Lesen Sie die [vollständige Liste der Änderungen](https://modelcontextprotocol.io/specification/draft/changelog), bevor Sie annehmen, dass das auch für Ihren eigenen Code gilt.
