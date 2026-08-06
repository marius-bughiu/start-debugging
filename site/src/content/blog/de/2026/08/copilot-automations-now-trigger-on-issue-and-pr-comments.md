---
title: "Copilot-Automatisierungen starten jetzt bei Issue- und PR-Kommentaren"
description: "Das GitHub-Changelog vom 2026-08-03 ergänzt die Automatisierungen des Copilot Cloud Agent um einen Kommentar-Trigger und ersetzt damit den issue_comment-Workflow samt PAT und REST-Aufruf, den Teams seit Juni selbst gebaut haben."
pubDate: 2026-08-06
tags:
  - "github-copilot"
  - "ai-agents"
  - "automation"
  - "ci-cd"
lang: "de"
translationOf: "2026/08/copilot-automations-now-trigger-on-issue-and-pr-comments"
translatedBy: "claude"
translationDate: 2026-08-06
---

Am 2026-08-03 hat GitHub [Trigger Copilot automations with comments](https://github.blog/changelog/2026-08-03-trigger-copilot-automations-with-comments/) veröffentlicht. Automatisierungen des Copilot Cloud Agent können jetzt starten, wenn ein Issue- oder Pull-Request-Kommentar erstellt wird, abgeglichen mit einem von Ihnen festgelegten Kommentartext. Es ist ein einzeiliger Changelog-Eintrag, der erstaunlich viel YAML überflüssig macht.

## Die bisherigen Trigger waren ereignisförmig, nicht gesprächsförmig

Automatisierungen kamen am 2026-06-02 mit vier Triggern: nach Zeitplan (stündlich, täglich oder wöchentlich), wenn ein Issue erstellt wird, wenn ein Pull Request geöffnet wird und wenn ein Pull Request synchronisiert wird. Jeder davon feuert in dem Moment, in dem etwas einen Zustand erreicht. Keiner deckt das Muster ab, zu dem Teams tatsächlich greifen: ein Mensch liest erst den Thread und sagt dann "los".

Also haben Sie den Kleber selbst geschrieben. Die Form war immer dieselbe: ein `issue_comment`-Workflow, ein String-Guard, ein Token und ein `POST` an die [Agent Tasks REST API](/2026/06/trigger-github-copilot-coding-agent-task-from-rest-api/).

```yaml
name: copilot-on-comment
on:
  issue_comment:
    types: [created]

jobs:
  dispatch:
    if: startsWith(github.event.comment.body, '/copilot fix')
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch an agent task
        env:
          GH_USER_TOKEN: ${{ secrets.COPILOT_USER_TOKEN }}
        run: |
          curl -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2026-03-10" \
            -H "Authorization: Bearer $GH_USER_TOKEN" \
            https://api.github.com/agents/repos/${{ github.repository }}/tasks \
            -d '{
              "prompt": "Investigate the stack trace in issue #${{ github.event.issue.number }} and open a fix PR.",
              "base_ref": "main",
              "create_pull_request": true
            }'
```

Jede Zeile darin ist Wartungsfläche. `secrets.COPILOT_USER_TOKEN` muss ein User-to-Server-Token sein, weil das eingebaute `GITHUB_TOKEN` keine Agent-Tasks auslöst, und es läuft nach dem Kalender irgendeiner Person ab. Der Guard ist ein reiner Präfixvergleich, also löst `/copilot fixup` ihn ebenfalls aus. `X-GitHub-Api-Version: 2026-03-10` fixiert eine öffentliche Preview, deren Antwortformat sich ändern kann. Und weil die Trigger-Phrase in einer Datei liegt, ist eine Änderung daran ein Pull Request.

## Wie die Konfiguration stattdessen aussieht

Öffnen Sie den Tab **Agents** im Repository, wählen Sie **Automations** in der Seitenleiste und klicken Sie auf **Create new**. Eine Automatisierung besteht aus einem Namen, einem Prompt, einem oder mehreren Triggern, einem optionalen Modell und einer Menge von Tools. Beim neuen Trigger geben Sie an, welcher Kommentartext sie starten soll, und das ist die gesamte Integration. Kein Token, keine Workflow-Datei, kein API-Versions-Header.

Bei der Tool-Liste liegt die eigentliche Denkarbeit. Sie ist die Berechtigungsgrenze des Laufs und keine Komforteinstellung: Sie entscheidet, was der Agent anfassen darf, sobald ein Kommentar ihn weckt. Die Schaltfläche **Suggest tools** schlägt anhand Ihres Prompts eine Auswahl vor, aber behandeln Sie das als Ausgangspunkt und kürzen Sie es auf das, was die Aufgabe wirklich braucht.

## Einschränkungen, die Sie vor der Planung prüfen sollten

Automatisierungen erfordern ein **privates oder internes** Repository. In öffentlichen Repositories sind sie nicht verfügbar, ein Open-Source-Projekt kann damit also keine eingehenden Issues triagieren. Zum Anlegen brauchen Sie Schreibzugriff, der Plan muss Copilot Pro, Pro+, Max, Business oder Enterprise sein, und bei Business und Enterprise muss eine Administration zuerst die Cloud-Agent-Richtlinie aktivieren. Mit **Run now** testen Sie eine Automatisierung, bevor ein echter Kommentar sie auslöst.

Eine Folge lohnt das Nachdenken. Bisher brauchte das Auslösen eines Agents ein Token, das eine wartende Person bewusst bereitgestellt hat. Jetzt kann jede Person, die im Repository einen Issue kommentieren darf, Agent-Zeit verbrauchen. Private und interne Sichtbarkeit begrenzt den Wirkungsradius, aber halten Sie die Trigger-Phrase spezifisch und die Tool-Liste schmal.
