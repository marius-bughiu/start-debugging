---
title: "Cursor veröffentlicht ein TypeScript-SDK, das den Coding-Agent zur Bibliothek macht"
description: "Die neue Public Beta von @cursor/sdk gibt denselben Runtime, Harness und dieselben Modelle frei, die hinter Desktop-App, CLI und Web stehen, jetzt als TypeScript-Paket. Sandboxed Cloud-VMs, Subagenten, Hooks, MCP und Token-basierte Abrechnung in wenigen Zeilen Code."
pubDate: 2026-05-04
tags:
  - "cursor"
  - "ai-agents"
  - "typescript"
  - "mcp"
lang: "de"
translationOf: "2026/05/cursor-typescript-sdk-programmatic-coding-agents"
translatedBy: "claude"
translationDate: 2026-05-04
---

Am 29. April 2026 hat Cursor die Public Beta von `@cursor/sdk` gestartet, eine TypeScript-Bibliothek, die denselben Runtime, Harness und dieselben Modelle umschließt, die den Desktop-Editor, die CLI und die Web-App antreiben. Der Pitch ist einfach: Der Agent, der bisher in der Cursor-Oberfläche steckte, ist jetzt eine programmierbare Komponente, die Sie aus Ihren eigenen Diensten heraus aufrufen können. Dasselbe Composer-Modell, derselbe Kontext-Engine, dieselbe Tool-Oberfläche, ansprechbar aus einem Node-Prozess.

Das ist derselbe Wandel, den die SDKs von Anthropic und OpenAI vor Jahren durchlaufen haben, nur für einen auf Code spezialisierten Agenten statt für ein reines Chat-Modell.

## Was in `@cursor/sdk` enthalten ist

Sie installieren es wie jedes andere Paket:

```bash
npm install @cursor/sdk
```

Das minimale "Agent erstellen und Prompt ausführen" sieht in der [offiziellen Dokumentation](https://cursor.com/docs/sdk/typescript) so aus:

```typescript
import { Agent } from "@cursor/sdk";

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2" },
  local: { cwd: process.cwd() },
});

const run = await agent.send("Summarize what this repository does");

for await (const event of run.stream()) {
  console.log(event);
}
```

Das interessante Feld ist `local`. Übergeben Sie es, und der Agent arbeitet gegen Ihr Dateisystem im aktuellen Arbeitsverzeichnis. Lassen Sie es weg und ersetzen Sie es durch `cloud: { ... }`, und derselbe Aufruf läuft jetzt in einer sandboxed VM, die Cursor für Sie bereitstellt, inklusive Codebase-Indexierung, semantischer Suche und Grep auf der Remote-Seite. Der Kontrakt von `Agent.create`, `agent.send` und dem Run-Stream ist zwischen beiden identisch.

Diese Symmetrie ist das eigentliche Feature. CI-Skripte, die Ergebnisse lokal halten müssen, bleiben lokal. Gehostete Agenten, die untrusted Prompts gegen ephemere Clones laufen lassen müssen, können auf den Cloud-Runtime umziehen, ohne den Harness neu zu schreiben.

## Subagenten, Hooks, MCP und Skills

Das SDK hört nicht bei One-Shot-Prompts auf. Es legt dieselben Primitives offen, die die Desktop-App benutzt:

- `Run` bietet Streaming, Warten und Cancellation. Der Stream emittiert `SDKMessage`-Events: Assistant-Tokens, Tool-Calls, Thinking und Status-Updates als Discriminated Union.
- Subagenten erlauben es einem Eltern-Run, eine in sich geschlossene Subtask zu delegieren, ohne sein eigenes Kontextfenster zu verschmutzen.
- Hooks feuern vor und nach Tool-Calls, sodass Sie gefährliche Datei-Schreibvorgänge ablehnen, jeden Shell-Command loggen oder Prompts gemäß Policy umschreiben können.
- MCP-Server hängen sich über `stdio` oder `http` an, das heißt jede bestehende MCP-Integration (GitHub, Linear, Ihre internen Daten) klemmt sich ohne Codeänderung dran.
- Der Namespace `Cursor` kümmert sich um Account-Plumbing: Modelle auflisten, Repositories auflisten, API-Keys verwalten.

Fehler sind typisiert: `AuthenticationError`, `RateLimitError`, `ConfigurationError` und Konsorten. Kein Parsen von Message-Strings mehr.

## Warum das auch für .NET-Teams zählt

Das SDK ist heute nur TypeScript, aber der Cloud-Runtime ist sprachagnostisch, sodass Sie ihn aus einem kleinen Node-Sidecar starten können, in den ein .NET-Service shell-out macht. Kombiniert mit dem [Microsoft Agent Framework](/de/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) auf der C#-Seite zeichnet sich das realistische 2026er-Muster langsam ab: Orchestrierung aus .NET heraus, Code-Edit-Tasks in einen gehosteten Cursor-Agent über das SDK schicken und die Ergebnisse über MCP konsumieren.

Die Abrechnung ist standard-Token-basiert ohne separaten Seat für die SDK-Nutzung, der Experiment-Preis ist also genau das, was das Modell verbrennt. Worauf Sie achten müssen, ist der Lifecycle der Cloud-VM. Lange Runs können sich zu echtem Geld summieren, und das SDK cancelt inaktive Agenten nicht automatisch für Sie.

Die vollständige Beta-Dokumentation lebt unter [cursor.com/docs/sdk/typescript](https://cursor.com/docs/sdk/typescript), und der Launch-Post ist [cursor.com/blog/typescript-sdk](https://cursor.com/blog/typescript-sdk).
