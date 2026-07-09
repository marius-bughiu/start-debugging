---
title: "VS Code 1.128 bringt Claude-Agent-Host-Sitzungen mit mehreren Chats"
description: "VS Code 1.128 (8. Juli 2026) erlaubt es einer einzigen Claude-Agent-Host-Sitzung, mehrere parallele Chats zu halten, jeder mit eigenem Verlauf, Titel und Modell. Das schaltet chat.agentHost.enabled wirklich frei, und so fügen sich Quick Chat und BYOK ein."
pubDate: 2026-07-09
tags:
  - "claude-code"
  - "ai-agents"
  - "llm"
lang: "de"
translationOf: "2026/07/vscode-1-128-multi-chat-claude-agent-host-sessions"
translatedBy: "claude"
translationDate: 2026-07-09
---

VS Code 1.128 erschien am 8. Juli 2026, und das Wichtigste ist keine Copilot-Funktion. Es ist, dass eine einzige Claude-Agent-Host-Sitzung jetzt mehrere verwandte Chats gleichzeitig halten kann, jeder mit eigenem Verlauf, Titel und eigener Modellauswahl, alle unter einer übergeordneten Sitzung gruppiert. Der Agent-Host-Modus wird vom Claude Agent SDK von Anthropic betrieben, das direkt in VS Code läuft, und diese Version verwandelt ihn von einer Einzelthread-Erfahrung in etwas, das eher einer Werkbank ähnelt.

## Warum eine Sitzung mit mehreren Chats zählt

Vor 1.128 bedeutete das Erkunden zweier Ansätze für dasselbe Problem entweder, den Kontext durch einen Wechsel mitten im Thread zu zerstören, oder eine ganz neue Sitzung zu starten und die gemeinsame Einrichtung zu verlieren. Mehrere Chats lösen das. Sie können von einem früheren Zug abzweigen, den ursprünglichen Chat unversehrt lassen und beide parallel ausführen. Jeder Chat verfolgt sein eigenes Modell, sodass Sie ein günstigeres Modell gegen ein stärkeres bei derselben Aufgabe antreten lassen und die Diffs nebeneinander vergleichen können, ohne die Sitzung zu verlassen.

Dies ist an den Agent-Host-Modus gebunden. Aktivieren Sie ihn in `settings.json`:

```json
{
  "chat.agentHost.enabled": true
}
```

Damit wird das **Agents**-Fenster zur Zentrale. Neue Chats erscheinen in einem Abschnitt **Chats** unter der übergeordneten Sitzung, und Sie fokussieren das Fenster mit dem Befehl `workbench.action.openAgentsWindow`.

## Quick Chats verzichten auf die Arbeitsbereich-Voraussetzung

Die zweite Änderung, die Reibung beseitigt, sind Quick Chats. Sie können jetzt ein Gespräch aus dem Agents-Fenster heraus starten, ohne zuerst einen Ordner zu öffnen. Das klingt nebensächlich, bis Sie merken, wie oft Sie einem Agenten etwas fragen möchten, das nichts mit dem aktuell geöffneten Projekt zu tun hat, und dafür zuvor einen Zwischen-Arbeitsbereich öffnen mussten. Quick Chats werden nur von Agent-Host-Sitzungen unterstützt und laufen daher über denselben Schalter `chat.agentHost.enabled`.

Auch Subagenten werden erwähnt: Der Agent-Host kann an einen Subagenten delegieren, und Sie sehen das Transkript des Subagenten schreibgeschützt, sodass eine Delegation den Verlauf des übergeordneten Chats nicht verschmutzt.

## Eigene Modell-Schlüssel mitbringen

Es gibt außerdem eine experimentelle Einstellung für Teams, die über ihren eigenen Modellanbieter statt über den mitgelieferten Weg leiten möchten:

```json
{
  "chat.agentHost.byokModels.enabled": true
}
```

Die BYOK-Unterstützung ist in 1.128 als experimentell gekennzeichnet, behandeln Sie sie also als Vorschau und nicht als etwas, das ein Team diese Woche standardisieren sollte. Kombinieren Sie sie mit `chat.byokUtilityModelDefault`, wenn Sie steuern möchten, welches Modell die günstigeren Utility-Aufrufe übernimmt.

Zum Abschluss der Version wurde Copilot Vision allgemein verfügbar, sodass das Einfügen, Ziehen oder Ablegen von Bildern und PDFs in den Chat keine Vorschau mehr ist, und der Agent kann über einen Tool-Aufruf auf diese Anhänge zugreifen.

Der Teil mit den mehreren Chats ist der, den es sich zuerst zu testen lohnt. Wenn Sie den Claude-Agent-Host in VS Code bereits ausführen, aktivieren Sie `chat.agentHost.enabled`, öffnen Sie das Agents-Fenster und zweigen Sie einen Chat ab, statt einen neu zu starten. Die vollständigen Hinweise finden Sie in den [Versionshinweisen zu VS Code 1.128](https://code.visualstudio.com/updates/v1_128).
