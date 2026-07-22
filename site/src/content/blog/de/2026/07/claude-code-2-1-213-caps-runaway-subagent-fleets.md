---
title: "Claude Code 2.1.213 setzt harte Grenzen für außer Kontrolle geratene Subagenten-Flotten"
description: "Version 2.1.213 begrenzt gleichzeitige Subagenten und stoppt verschachtelte Starts standardmäßig, aufbauend auf den Sitzungsgrenzen von 2.1.212. Hier sind die neuen Standardwerte und Umgebungsvariablen."
pubDate: 2026-07-22
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
lang: "de"
translationOf: "2026/07/claude-code-2-1-213-caps-runaway-subagent-fleets"
translatedBy: "claude"
translationDate: 2026-07-22
---

Wenn Sie jemals beobachtet haben, wie ein Claude-Code-Workflow auffächert, Subagenten startet, die ihre eigenen Subagenten starten, und still Ihr Budget aufbraucht, während Sie sich einen Kaffee holen, dann sind die letzten beiden Releases für Sie. Claude Code 2.1.213, diese Woche veröffentlicht, fügt eine Grenze für gleichzeitige Subagenten hinzu und verhindert standardmäßig deren Verschachtelung. Es baut direkt auf den Sitzungsobergrenzen auf, die mit 2.1.212 kamen. Zusammen verwandeln sie das "Hoffen, dass die Schleife endet" in eine Reihe expliziter, anpassbarer Grenzen.

## Was sich in 2.1.213 ändert

Zwei Verhaltensweisen haben sich geändert, und beide sind Sicherheitsschienen rund um parallele Agentenarbeit.

Erstens gibt es jetzt eine Obergrenze dafür, wie viele Subagenten gleichzeitig laufen. Der Standardwert ist 20. Wenn ein Workflow versucht, mehr zu starten, werden die überzähligen in eine Warteschlange gestellt, statt alle gleichzeitig zu feuern. Sie überschreiben das mit einer Umgebungsvariablen:

```bash
export CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=8
```

Zweitens, und folgenreicher: Subagenten starten standardmäßig keine verschachtelten Subagenten mehr. Vor 2.1.213 konnte ein Subagent an einen anderen Subagenten delegieren, der wiederum delegieren konnte, und die Tiefe war praktisch unbegrenzt. So konnte ein einzelner Prompt auf oberster Ebene zu Dutzenden gleichzeitiger Sitzungen anwachsen. Jetzt ist die Starttiefe begrenzt, und Sie aktivieren tiefere Verschachtelung explizit:

```bash
# Allow subagents to spawn one more level down
export CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2
```

Das Changelog von 2.1.213 behebt auch eine verwandte Lücke: `--max-budget-usd` stoppte die Subagenten im Hintergrund nicht. Wenn Sie sich also auf eine Dollar-Obergrenze verlassen haben, um einen außer Kontrolle geratenen Job anzuhalten, hält sie jetzt auch die im Hintergrund an.

## Die Sitzungsobergrenzen von 2.1.212

Die Grenzen von 2.1.213 sitzen auf zwei Sitzungsobergrenzen von 2.1.212 auf, einige Builds nach dem [Release 2.1.208](/de/2026/07/claude-code-2-1-208-vim-insert-mode-remaps-jj-to-escape/). Eine einzelne Sitzung hat jetzt ein hartes Budget sowohl für Subagenten-Starts als auch für Websuchen, jeweils mit einem Standardwert von 200:

```bash
export CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION=50
export CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION=100
```

2.1.212 hat außerdem lang laufende MCP-Toolaufrufe aus dem kritischen Pfad genommen. Jeder MCP-Aufruf, der länger als zwei Minuten läuft, wechselt jetzt automatisch in den Hintergrund, sodass ein langsames Tool den Zug nicht mehr blockiert. Sie können den Schwellenwert anpassen oder das Verhalten abschalten:

```bash
# Background MCP calls after 90 seconds instead of 120
export CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=90000
```

## Warum das wichtig ist

Agenten-Flotten sind billig zu starten und teuer im Betrieb. Der Fehlerfall war nie ein einzelner Subagent, sondern die Rekursion: ein Orchestrator, der Worker startet, Worker, die Helfer starten, und keine einzige Zahl, die die Gesamtsumme begrenzt. Standardwerte von 20 gleichzeitigen, keine Verschachtelung und 200 Starts pro Sitzung bedeuten, dass ein fehlerhafter Prompt jetzt gegen eine Wand läuft statt gegen eine Rechnung. Wenn Sie auffächernde Workflows bauen, lesen Sie die Standardwerte und erhöhen Sie dann die zwei oder drei, die Ihre tatsächliche Arbeit wirklich braucht, statt alle Grenzen aufzuheben.

Alle Einzelheiten finden Sie im [Claude-Code-Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
