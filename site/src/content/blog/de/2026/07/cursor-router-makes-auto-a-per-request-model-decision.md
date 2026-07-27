---
title: "Cursor Router macht Auto zu einer Modellentscheidung pro Anfrage"
description: "Cursor Router ist am 2026-07-22 erschienen. Auto klassifiziert jetzt jede Anfrage und leitet sie an ein anderes Modell weiter, und die Modi Cost, Balance und Intelligence verändern sowohl die Qualität als auch die Abrechnung."
pubDate: 2026-07-27
tags:
  - "cursor"
  - "ai-agents"
  - "developer-tools"
lang: "de"
translationOf: "2026/07/cursor-router-makes-auto-a-per-request-model-decision"
translatedBy: "claude"
translationDate: 2026-07-27
---

Cursor hat am 2026-07-22 den [Cursor Router](https://cursor.com/blog/router) veröffentlicht, und das verändert still, was die Modelleinstellung Auto bedeutet. Auto war bisher eine einzige Routing-Richtlinie mit dem Ziel, den Token-Verbrauch niedrig zu halten. Jetzt ist es ein Entscheidungssystem, das vor allen Modellen Ihres Kontos sitzt, jede Anfrage nach Aufgabentyp und Komplexität klassifiziert und das Modell für genau diese eine Anfrage auswählt.

## Drei Modi, drei unterschiedliche Rechnungen

Im Modell-Picker wählen Sie Auto und darunter unter "Optimize For" einen Modus. Die [Dokumentation](https://cursor.com/docs/cursor-router) beschreibt sie so:

- **Cost** verwendet die bisherige Auto-Routing-Logik. Der Modus optimiert den Token-Verbrauch und behält die gebündelte Auto-Preisgestaltung bei, abgerechnet pro Million Tokens.
- **Balance** optimiert auf Intelligenz, Geschwindigkeit und Kosten und rechnet pro Anfrage zum Tarif des gerouteten Modells ab.
- **Intelligence** leitet schwierigere Aufgaben an die leistungsfähigsten Modelle weiter, zu geringeren Kosten als der Betrieb eines einzelnen Frontier-Modells. Ebenfalls pro Anfrage abgerechnet.

Diese Abrechnung pro Anfrage ist der Teil, den man zweimal lesen sollte. Cost ist der einzige Modus, der den gebündelten Tarif behält. Cursor selbst gibt an, dass Balance und Intelligence im Schnitt etwa doppelt so viel kosten wie Cost, und je nach gewähltem Modus bis zum Zwei- bis Vierfachen.

Der Kompromiss ist real, kein Marketing. Cursor berichtet, dass Early-Access-Kunden 30 bis 50 Prozent gegenüber Opus 4.8 für alles eingespart haben, bei Kosten pro Commit von 6,76 USD mit Intelligence und 4,63 USD mit Balance. Intelligence liegt bei der Nutzerzufriedenheit nahe an Fable, bei rund 60 Prozent geringeren Kosten für Teams, und Balance liegt über Opus 4.8 bei etwa 36 Prozent geringeren Kosten.

## Das geroutete Modell ist standardmäßig verborgen

Es gibt eine Dashboard-Einstellung, die zu Beginn jeder Antwort anzeigt, an welches Modell Auto weitergeleitet hat. Verborgen ist die Voreinstellung, und Cursor empfiehlt, es dabei zu belassen.

Für die tägliche Arbeit ist das in Ordnung. Für alle, die das Verhalten des Agenten nachvollziehen wollen, nicht. Wenn derselbe Prompt am Montag ein sauberes Refactoring liefert und am Dienstag ein mittelmäßiges, kann der Unterschied das geroutete Modell sein, und standardmäßig verrät das Transkript nichts davon. Wenn Sie den Router vor dem Rollout an ein Team bewerten, schalten Sie die Anzeige zuerst ein und lassen Sie sie während des gesamten Tests aktiv.

## Fixieren Sie das Modell, wenn ein Lauf reproduzierbar sein muss

Routing ist gut für interaktive Arbeit und schlecht für alles, was Sie gegen eine Baseline vergleichen. Für CI-Läufe, Eval-Harnesses und skriptgesteuerte Agent-Jobs fixieren Sie ein explizites Modell, statt Auto zu erben:

```bash
# see the exact model ids this account exposes
agent --list-models

# pin one for a run that has to be repeatable
agent -p "run the failing tests and fix them" \
  --model <id-from-list-models> \
  --output-format json
```

Cursor Router läuft auf Desktop, Web, iOS, in der CLI und im SDK. In Teams-Plänen ist er standardmäßig aktiv, Enterprise-Administratoren aktivieren ihn über das Dashboard, und Einzelpläne (Hobby, Pro, Pro+, Ultra) erhalten ihn einige Monate nach dem Start. Administratoren können einschränken, welche Modi Mitglieder wählen dürfen, den Standard festlegen, einzelne zugrunde liegende Modelle erlauben oder blockieren und die Standardisierung auf Auto weich oder hart erzwingen.

Wenn Ihr Team bereits auf parallele Agentenarbeit setzt, etwa auf die [Side Chats aus Cursor 3.11](/de/2026/07/cursor-3-11-side-chats-parallel-agent-threads/), verändert der Router die Kostenstruktur von all dem auf einen Schlag. Prüfen Sie den von Ihrer Administration gesetzten Modus, bevor Sie annehmen, die Rechnung sei gleich geblieben.
