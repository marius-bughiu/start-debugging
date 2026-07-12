---
title: "Side Chats in Cursor 3.11: eine Frage abzweigen, ohne den Hauptagenten zu entgleisen"
description: "Cursor 3.11 (10. Juli 2026) fuehrt Side Chats ein, dauerhafte parallele Agenten-Threads, die Sie mit /side oder /btw oeffnen und mit einer Erwaehnung wieder in die Hauptunterhaltung zurueckholen. Dazu Transkriptsuche mit Cmd+K und neue Cloud-Agent-Hooks."
pubDate: 2026-07-12
tags:
  - "cursor"
  - "ai-agents"
  - "llm"
  - "productivity"
lang: "de"
translationOf: "2026/07/cursor-3-11-side-chats-parallel-agent-threads"
translatedBy: "claude"
translationDate: 2026-07-12
---

Cursor 3.11 erschien am 10. Juli 2026, und die zentrale Funktion loest ein konkretes Aergernis: Sie stecken tief in einer Agenten-Aufgabe, ein Nebengedanke kommt Ihnen ("Moment, verwendet dieses Repository ueberhaupt irgendwo `IAsyncEnumerable`?"), und diese Frage zu stellen entgleist den Thread, den Sie gerade aufgebaut haben. Side Chats geben Ihnen einen Ort, um diese Frage zu stellen, ohne die Hauptunterhaltung zu beruehren.

## Ein Side Chat ist ein vollstaendiger Agent, kein Notizzettel

Das wichtige Detail ist, dass ein Side Chat kein leichtgewichtiges Popup ist. Es ist eine vollstaendige, dauerhafte Agenten-Unterhaltung, die parallel zu Ihrem Haupt-Chat laeuft. Sie koennen ihr nachgehen, sie schliessen und spaeter wieder aufgreifen, und sie behaelt die ganze Zeit ihren eigenen Kontext. Das unterscheidet sie davon, den Prompt zu loeschen und neu zu tippen: Der Nebengedanke wird zu einem eigenen dauerhaften Thread, zu dem Sie zurueckkehren koennen.

Sie oeffnen ihn auf drei Arten: den Befehl `/side`, das Kuerzel `/btw` oder die Plus-Schaltflaeche oben im Chat-Panel.

```text
# In the middle of a refactor, spin off a question without losing your place:
/btw where do we register the JWT bearer handler?

# Or explicitly:
/side compare our current retry policy to Polly's default
```

Side Chats sind auf Lesen, Suchen und Antworten ausgelegt, waehrend Ihr Hauptagent seinen eigenen Zustand unangetastet behaelt. Die Hauptaufgabe verliert ihren Plan nicht, nur weil Sie eine Antwort gesucht haben.

## Die Antwort mit einer Erwaehnung zurueckholen

Was dies zu mehr als einem zweiten Tab macht, ist der Rueckweg. Sobald ein Side Chat etwas herausgefunden hat, erwaehnen Sie ihn mit @ aus dem Haupt-Thread, um diesen Kontext zurueckzuholen:

```text
# Back in the main chat, fold the side chat's findings into the real work:
@side-chat: retry-policy apply that Polly comparison to OrderService
```

Der Ablauf ist also: abzweigen, isoliert untersuchen und dann die Schlussfolgerung wieder in den Hauptagenten einpflanzen, ohne etwas erneut erklaert zu haben. Die Isolierung haelt den Hauptkontext sauber, waehrend Sie erkunden; die Erwaehnung bedeutet, dass die Erkundung nicht vergeblich war.

## Der Rest von 3.11

Zwei weitere Aenderungen sind erwaehnenswert. Die Unterhaltungssuche laeuft jetzt ueber einen lokalen Index: `Cmd+K` sucht ueber Tausende frueherer Agenten-Transkripte, und `Cmd+F` springt innerhalb einer einzelnen Unterhaltung zwischen Treffern. Die Repository- und Projektauswahl wurde neu gebaut, um nach Ort einzugrenzen (This Computer, Cloud, Remote Machines) und um ein Projekt zu erstellen oder GitHub/GitLab zu verbinden, ohne die Auswahl zu verlassen.

Fuer alle, die Agentenverhalten skripten, fuegt 3.11 ausserdem Cloud-Agent-Hooks wie `beforeSubmitPrompt` und `afterAgentResponse` hinzu, mit denen Sie das Denken eines Agenten und das Verhalten seiner Subagenten beobachten und steuern koennen:

```json
{
  "hooks": {
    "beforeSubmitPrompt": "./scripts/inject-guardrails.sh",
    "afterAgentResponse": "./scripts/lint-agent-output.sh"
  }
}
```

Wenn Sie bereits parallele Worker betreiben, liegen Side Chats eine Ebene darunter: nicht ein weiterer Agent, der Arbeit erledigt, sondern ein Ort, um laut zu denken, ohne dass der Hauptagent mithoert, bis Sie entscheiden, dass er es soll. Wie sich die schwergewichtigere Multi-Worker-Geschichte zwischen den Werkzeugen vergleicht, lesen Sie in [Cursor-Subagents vs. Claude-Code-Subagents](/2026/07/cursor-subagents-vs-claude-code-subagents/). Die vollstaendigen Hinweise finden Sie im [Cursor-Changelog](https://cursor.com/changelog).
