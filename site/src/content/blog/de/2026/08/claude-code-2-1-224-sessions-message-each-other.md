---
title: "Claude Code 2.1.224 lässt eine Sitzung einer anderen schreiben"
description: "Sitzungsübergreifendes Messaging kam am 2026-08-07. ListAgents und SendMessage bewegen reinen Text zwischen Ihren Sitzungen, und crossSessionInbound entscheidet, was tatsächlich ankommt."
pubDate: 2026-08-10
tags:
  - "claude-code"
  - "ai-agents"
  - "developer-tools"
lang: "de"
translationOf: "2026/08/claude-code-2-1-224-sessions-message-each-other"
translatedBy: "claude"
translationDate: 2026-08-10
---

Zwei Terminals, dasselbe Repository. Das eine hat gerade in der Migration eine Spalte umbenannt, gegen die das andere weiterhin Abfragen schreibt. Bis vergangene Woche waren Sie selbst die Lösung, mit Kopieren und Einfügen zwischen Fenstern. Claude Code 2.1.224, veröffentlicht am 2026-08-07, schließt diese Lücke: Eine Sitzung kann einer anderen Sitzung auf derselben Maschine eine Nachricht übergeben.

## ListAgents findet sie, SendMessage stellt zu

Zwei Tools erledigen die Arbeit, und Sie rufen keines davon auf. `ListAgents` listet die Agenten auf, die eine Sitzung erreichen kann, `SendMessage` adressiert einen davon namentlich. Sie beschreiben nur die Absicht:

```text
Tell the session working on the payments API that the tenant_id column landed
```

Den Nachrichtentext schreibt Claude selbst. Um die Liste selbst zu sehen, führen Sie `/list-agents` aus, auch als `/peers` verfügbar. Eine Sitzung hört auf den Namen, den Sie mit `--name` oder `/rename` gesetzt haben; ohne einen solchen leitet Claude Code einen Namen aus dem Arbeitsverzeichnis ab, etwa `myapp-3f`.

Die Zustellung auf derselben Maschine läuft über einen Unix-Socket pro Sitzung und passiert nie die Server von Anthropic. `/status` zeigt den Pfad in einer Zeile `Peer address`, und Hooks sowie Bash-Befehle erhalten ihn als `CLAUDE_CODE_MESSAGING_SOCKET`. Auf diesem Weg schreibt ein Skript zurück in die Sitzung, die es gestartet hat.

Die Voraussetzungen sind eng: v2.1.224 oder neuer, macOS oder Linux (WSL 2 zählt, natives Windows nicht), und nicht auf Amazon Bedrock, Google Cloud's Agent Platform oder Microsoft Foundry.

## Was der Kanal nicht transportiert

Eine Nachricht ist reiner Text. Kein Gesprächsverlauf, keine Dateien, keine Berechtigungen. Beim Eintreffen teilt Claude Code der empfangenden Sitzung mit, dass der Text von einem anderen Agenten stammt und nicht von Ihnen, und diese Einordnung hat Zähne: Die Nachricht kann keine offene Berechtigungsabfrage beantworten, kann den Empfänger nicht dazu bringen, `CLAUDE.md` oder seine Berechtigungsregeln umzuschreiben, und ein `/compact` im Text kommt als wirkungsloser Text an statt als Befehl.

Der Umgang mit eingehenden Nachrichten ist eine Einstellung, `crossSessionInbound`, mit drei Werten: `accept`, `hold` und `refuse`. Ohne gesetzten Wert entscheidet Claude Code pro Nachricht anhand der Berechtigungsmodus-Klassen beider Sitzungen. Eine Sitzung in `bypassPermissions` hält alles zurück, was eine nachfragende Sitzung sendet, und eine nachfragende Sitzung hält alles zurück, was eine überspringende sendet. Zurückgehaltene Nachrichten öffnen einen Bestätigungsdialog, der nach fünf Minuten abläuft und über `dialogExpiry` einstellbar ist.

Dieses Standardverhalten erklärt, warum ein Headless-Worker verstummt. Eine `claude -p`-Sitzung bindet einen Posteingangs-Socket und erscheint in der Liste, kann aber keinen Bestätigungsdialog darstellen, sodass eine zurückgehaltene Nachricht zurückgehalten bleibt. Geben Sie ihr ein explizites accept in ihrem `--settings`-Wert:

```json
{
  "crossSessionInbound": "accept"
}
```

Das Abschalten ist das Spiegelbild, und Administratoren können es über Managed Settings durchsetzen:

```json
{
  "permissions": {
    "deny": ["SendMessage", "ListAgents"]
  },
  "crossSessionInbound": "refuse"
}
```

Ein Deny für `SendMessage` entfernt auch das Messaging zu Subagenten und zu Teammitgliedern eines Agenten-Teams, denn dasselbe Tool bedient beides. Wer auf die [dreistufige Verschachtelung setzt, die 2.1.219 wieder geöffnet hat](/de/2026/07/claude-code-2-1-219-nested-subagents-three-layers-deep/), zahlt für diese Deny-Regel mehr als es aussieht.

## Über Maschinen hinweg, einen Tag später

Version 2.1.225, veröffentlicht am 2026-08-08, erweitert die Reichweite. Laut [Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) kann `SendMessage` nun ein Gespräch mit Ihren Remote-Control-Sitzungen auf anderen Maschinen namentlich beginnen, wobei `ListAgents` sie als `name [ref]` anzeigt. Zuvor war maschinenübergreifender Verkehr reine Antwortsache, so wie es die [Dokumentation](https://code.claude.com/docs/en/cross-session-messaging) weiterhin beschreibt.

Diese Nachrichten laufen über die Server von Anthropic auf der Remote-Control-Verbindung, also gibt es dafür einen Schalter. `isolatePeerMachines` auf `true` verlangt Ihre ausdrückliche Zustimmung, bevor etwas die Maschine verlässt, selbst im Modus `bypassPermissions`, und ein `true` aus jedem Einstellungsbereich setzt sich durch.

Ausuferndes Geplauder begrenzt der Transport, nicht das gute Benehmen: Wiederholungen sind pro Absender ratenbegrenzt, identische innerhalb eines kurzen Fensters werden verworfen, und höchstens 50 angenommene Nachrichten warten in der Warteschlange einer Sitzung, die sie noch nicht gelesen hat.
