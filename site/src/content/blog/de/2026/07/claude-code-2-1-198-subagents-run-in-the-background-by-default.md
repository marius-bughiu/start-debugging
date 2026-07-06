---
title: "Claude Code 2.1.198 führt Subagenten standardmäßig im Hintergrund aus"
description: "Claude Code v2.1.198 (2026-07-01) stellt Subagenten standardmäßig auf Hintergrundausführung um, sodass der Hauptagent weiterarbeitet, während sie laufen, und Hintergrundagenten, die Code anfassen, jetzt automatisch committen, pushen und einen draft PR öffnen, wenn sie fertig sind."
pubDate: 2026-07-06
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "de"
translationOf: "2026/07/claude-code-2-1-198-subagents-run-in-the-background-by-default"
translatedBy: "claude"
translationDate: 2026-07-06
---

Claude Code v2.1.198 erschien am 2026-07-01 und ändert das Standard-Ausführungsmodell für Subagenten. Bisher blockierte das Starten eines Subagenten (das Task-Tool, benutzerdefinierte Agenten, Agententeams) den Hauptloop: Sie delegierten einen Teil der Arbeit, der übergeordnete Agent verstummte, und Sie warteten auf die Rückkehr des Kindes, bevor sich sonst etwas bewegte. Ab 2.1.198 laufen Subagenten standardmäßig im Hintergrund, und der Hauptagent arbeitet weiter, während sie laufen.

## Warum Blockieren der falsche Standard war

Der Sinn eines Subagenten ist Isolation. Sie übergeben ihm eine in sich geschlossene Aufgabe (ein Verzeichnis durchsuchen, eine Behauptung prüfen, eine Migration entwerfen) mit eigenem Kontextfenster, damit der übergeordnete Agent nicht in Datei-Dumps ertrinkt. Doch wenn das Starten eines Subagenten den übergeordneten Agenten bis zu dessen Ende einfriert, verlieren Sie die andere Hälfte des Nutzens: den Parallelismus. Zwei unabhängige Abfragen, die gleichzeitig hätten laufen können, liefen nacheinander, und die reale Zeit war die Summe, nicht das Maximum.

Die Hintergrundausführung als Standard behebt das. Der übergeordnete Agent verteilt die Arbeit und macht auf dem Hauptthread weiter. Wenn ein Kind fertig ist, kommt sein Ergebnis als Benachrichtigung zurück, auf die Sie reagieren können, statt als Barriere, hinter der Sie gewartet haben. Für alles Zerlegbare ist das der Unterschied zwischen einer Pipeline und einer Warteschlange.

## Hintergrundagenten, die die Arbeit abschließen

Die zweite Hälfte des Releases betrifft das, was Hintergrundagenten tun, wenn sie fertig sind. Hat ein Hintergrundagent Code-Arbeit in einem git worktree erledigt, hält er nicht mehr an, um zu fragen, was mit dem Diff geschehen soll. Er committet, pusht und öffnet automatisch einen draft PR und meldet dann zurück.

Das ist eine echte Änderung im Arbeitsablauf. Der alte Loop war: Agent starten, warten, seine vorgeschlagenen Änderungen prüfen und dann selbst committen und pushen. Der neue Loop ist: Agent starten, weiterarbeiten und einen draft PR vorfinden, der auf Prüfung wartet, sobald er ankommt. Der Entwurfsstatus ist das Sicherheitsgeländer: Nichts wird von allein gemergt, aber die Klempnerei zwischen "Agent fertig" und "ich kann einen echten PR prüfen" ist weg.

```bash
# Before 2.1.198: foreground subagent, main loop blocks until it returns.
# You then stage and push its changes by hand.

# 2.1.198+: subagent runs in the background, you keep working, and a
# code-writing background agent lands its work as a draft PR itself:
#   [background] agent "refactor-auth" finished
#   -> committed, pushed branch agent/refactor-auth, opened draft PR #482
```

Da sich der Standard geändert hat, lohnt es sich, jede Automatisierung oder Dokumentation erneut zu lesen, die von synchronen Subagenten ausging. Schritte, die implizit darauf bauten, dass ein Subagent fertig war, bevor die nächste Zeile lief, müssen das Ergebnis jetzt explizit abwarten.

## Der Rest von 2.1.198

Zwei weitere Punkte kommen im selben Release. Claude in Chrome ist jetzt allgemein verfügbar und holt die Werkzeuge zur Browsersteuerung aus der Preview. Und es gibt eine neue `/dataviz`-Skill zum Erstellen von Diagrammen und Dashboards. Das Release stärkt außerdem die Netzwerkresilienz bei transienten Fehlern und behebt eine Reihe von Bugs bei Hintergrundaufgaben, Agententeams und Remote Control, derselbe Zuverlässigkeitsschub, der sich in den [Fixes für Hintergrundsitzungen von 2.1.200](/de/2026/07/claude-code-2-1-200-renames-default-permission-mode-to-manual/) fortsetzte.

Wenn Sie sich auch nur ein wenig auf Subagenten stützen, ist die Schlagzeile kurz gesagt und in der Praxis groß: Sie lassen Sie nicht mehr warten. Vollständige Notizen finden Sie im [Claude Code Changelog](https://code.claude.com/docs/en/changelog).
