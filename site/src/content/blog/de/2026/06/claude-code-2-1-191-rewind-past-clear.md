---
title: "Claude Code 2.1.191 lässt /rewind über ein /clear hinaus zurückreichen"
description: "Claude Code v2.1.191 (24. Juni 2026) erweitert /rewind, sodass Sie den Zustand von Konversation und Code aus der Zeit vor einem /clear wiederherstellen können und Kontext zurückbekommen, der zuvor für immer verloren war."
pubDate: 2026-06-26
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "de"
translationOf: "2026/06/claude-code-2-1-191-rewind-past-clear"
translatedBy: "claude"
translationDate: 2026-06-26
---

Claude Code v2.1.191 erschien am 24. Juni 2026, und die herausragende Änderung ist in der Beschreibung klein, in der Praxis aber groß: `/rewind` kann jetzt über ein `/clear` hinaus zurückreichen. Der Kontext, den Sie für einen sauberen Neuanfang gelöscht haben, ist nicht mehr verloren, sondern nur ein Rewind entfernt.

## Was /clear Sie früher gekostet hat

`/clear` setzt die Konversation zurück. Das ist der richtige Schritt, wenn der aktuelle Thread aufgebläht ist, das Modell sich in einer Sackgasse festgefahren hat oder Sie die Aufgabe wechseln und ein frisches Fenster möchten. Der Preis war, dass es eine harte Grenze unter Ihren Verlauf zog. Alles vor dem `/clear` war unerreichbar, obwohl Claude Code Ihre Sitzung bereits fortlaufend mit Prüfpunkten versah.

Diese Grenze entfernt 2.1.191. Die Sitzungsprüfpunkte, die `/rewind` zugrunde liegen, überstehen jetzt ein `/clear`, sodass die Rewind-Auswahl Punkte aus der Zeit vor dem Zurücksetzen anbieten kann.

## Wie /rewind funktioniert

`/rewind` führt Sie durch die Prüfpunkte zurück, die Claude Code bei jedem Schritt einer Sitzung aufzeichnet. Sie öffnen es mit dem Befehl `/rewind` oder durch zweimaliges Drücken von `Esc`:

```text
Esc Esc          # open the rewind picker
/rewind          # same thing, typed
```

Wählen Sie einen Prüfpunkt, und Sie entscheiden, was wiederhergestellt wird: die Konversation, der Code auf der Festplatte oder beides. Diese Unterscheidung ist wichtig. Sie können die Konversation um drei Schritte zurücksetzen, um eine Frage erneut zu stellen, ohne Ihren Arbeitsbaum anzufassen, oder die Dateien in einen bekanntermaßen guten Zustand zurückversetzen und dabei die Diskussion behalten, die Sie dorthin geführt hat.

Vor diesem Release endete die Liste der verfügbaren Prüfpunkte bei Ihrem letzten `/clear`. Jetzt geht sie weiter. Eine typische Wiederherstellung sieht so aus:

```text
# A long debugging thread, then a reset
/clear
# ...new work, then you realize you need the earlier repro
Esc Esc
# the picker now lists checkpoints from before the /clear
# select one, restore conversation + code, keep going
```

## Warum das ändert, wie Sie /clear verwenden

Der ehrliche Grund, warum Menschen zögerten, `/clear` auszuführen, war Verlustaversion. Löschen bedeutete, sich auf den Schnitt festzulegen, also behielten Sie einen veralteten, teuren Kontext für alle Fälle. Das Zurücksetzen umkehrbar zu machen, dreht das um. `/clear` wird zu einer günstigen, alltäglichen Möglichkeit, jedes Fenster knapp zu halten, weil ein falscher Schnitt wiederherstellbar statt endgültig ist.

Es passt auch zur Prüfpunkt-zuerst-Richtung der jüngsten Releases. Ihre Sitzung ist eine Abfolge von Wiederherstellungspunkten, zwischen denen Sie sich bewegen können, nicht ein einziges lineares Transkript, das Sie entweder behalten oder zerstören.

## Der Rest des Releases

2.1.191 behebt außerdem das Springen der Scroll-Position bei Streaming-Antworten, korrigiert einen Fehler bei der Wiederbelebung von Hintergrund-Agenten und verbessert die `/voice`-Meldung, die angezeigt wird, wenn eine Richtlinie es deaktiviert. Der unmittelbar folgende Build, 2.1.193, fügt `autoMode.classifyAllShell` hinzu, um Bash und PowerShell durch den Klassifikator des automatischen Modus zu leiten, und legt die Ablehnungsgründe des automatischen Modus in der Transkript-Ausgabe und in `/permissions` offen.

Die vollständigen Hinweise finden Sie im [Claude Code Changelog](https://code.claude.com/docs/en/changelog).
