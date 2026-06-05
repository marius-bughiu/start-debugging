---
title: "Das Claude Agent SDK und claude -p erhalten am 15. Juni einen eigenen Kreditpool"
description: "Anthropic trennt die programmatische Claude-Nutzung am 2026-06-15 von Ihrem Abonnement. Das zählt als programmatisch, so groß ist der Kredit pro Plan, und so verhindern Sie, dass Ihre CI-Agenten still stehen bleiben."
pubDate: 2026-06-05
tags:
  - "claude-code"
  - "ai-agents"
  - "anthropic"
lang: "de"
translationOf: "2026/06/claude-agent-sdk-separate-credit-pool-june-15"
translatedBy: "claude"
translationDate: 2026-06-05
---

Wenn Sie Claude in einer Pipeline ausführen, markieren Sie den 2026-06-15 in Ihrem Kalender. Ab diesem Tag verschiebt Anthropic die gesamte programmatische Claude-Nutzung aus den Grenzen Ihres Abonnements in einen separaten, endlichen monatlichen Kreditpool, der zu den Listenpreisen der API abgerechnet wird. Der interaktive Chat und das interaktive Terminal bleiben genau so, wie sie sind. Die Änderung betrifft nur die Workloads, die Sie nicht in Echtzeit beobachten können, und das sind genau jene, die am ehesten still ausfallen.

## Was als "programmatisch" zählt

Bei der Trennung geht es darum, wie Claude aufgerufen wird, nicht darum, welches Modell Sie aufrufen. Das Folgende verbraucht den neuen Kreditpool statt der Nutzungsgrenzen Ihres Plans:

- Das Claude Agent SDK in jedem skriptbasierten oder persönlichen Projekt.
- `claude -p`, der nicht interaktive Headless-Modus von Claude Code.
- Claude Code innerhalb von GitHub Actions.
- Drittanbieter-Apps, die sich über das Agent SDK authentifizieren.

Der Web-, Desktop- und Mobile-Chat sowie die interaktive Terminalsitzung, die Sie von Hand steuern, bleiben auf Ihrem Abonnement. Ebenso Claude Cowork. Wenn ein Mensch tippt, ändert sich nichts.

## Der Kredit pro Plan

Jeder Plan erhält einen festen monatlichen Kredit, der ungefähr seiner Stufe entspricht:

| Plan | Monatlicher Kredit |
| --- | --- |
| Pro | $20 |
| Max 5x | $100 |
| Max 20x | $200 |
| Team Standard (pro Platz) | $20 |
| Team Premium (pro Platz) | $100 |
| Enterprise Premium (pro Platz) | $200 |

Sobald dieser Kredit aufgebraucht ist, werden Anfragen entweder zu den Listenpreisen der API abgerechnet oder abgelehnt, abhängig von einem "usage credits"-Schalter in Ihren Kontoeinstellungen. Eine nächtliche Agent-Schleife, die bequem in ein Max-20x-Abonnement passte, kann nun mitten im Monat leerlaufen, und ein CI-Job, der zuvor "einfach funktionierte", kann beginnen, Fehler zurückzugeben, sobald der Pool leer ist.

## Machen Sie die Automatisierung vorhersehbar: geben Sie ihr einen eigenen Schlüssel

Die sauberste Lösung besteht darin, die Automatisierung nicht länger Ihr Abonnement ausleihen zu lassen. Richten Sie Headless-Workloads auf einen dedizierten API-Schlüssel aus, damit die Ausgaben gemessen, zuordenbar und von Ihrem interaktiven Platz isoliert sind. In GitHub Actions ist das eine Änderung von einer Zeile:

```yaml
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Claude Code headless
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          claude -p "Triage the newest issue and label it" \
            --allowedTools "Bash(gh:*)"
```

Mit gesetztem `ANTHROPIC_API_KEY` authentifizieren sich `claude -p` und das Agent SDK gegen das API-Konto statt gegen Ihren Abonnementkredit, sodass der Pool vom 15. Juni für diesen Job nie ins Spiel kommt. Sie zahlen ohnehin Listenpreise, aber jetzt landet die Rechnung dort, wo Sie sie einplanen können.

## Vor dem Stichtag

Drei Dinge lohnen sich diese Woche. Fordern Sie den einmaligen Kredit aus der E-Mail an, die Anthropic versandt hat (es ist eine manuelle Aktion in den Kontoeinstellungen). Prüfen Sie, was Ihre programmatische Nutzung zu API-Preisen tatsächlich kostet, damit Sie wissen, ob der Kredit eine Woche oder einen Monat abdeckt. Informieren Sie dann die für Ihr CI Verantwortlichen, dass das monatliche Kontingent nun endlich ist, und entscheiden Sie pro Pipeline, ob ein Überschuss abgerechnet werden oder hart fehlschlagen soll.

Die maßgeblichen Bedingungen finden Sie in den [Claude-Versionshinweisen](https://support.claude.com/en/articles/12138966-release-notes) und im [Anthropic-Newsroom](https://www.anthropic.com/news).
