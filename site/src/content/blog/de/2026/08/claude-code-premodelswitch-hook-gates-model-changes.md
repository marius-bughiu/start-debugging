---
title: "PreModelSwitch: Claude Code kann einen Modellwechsel jetzt ablehnen"
description: "Claude Code 2.1.251 ergänzt die Hook-Events PreModelSwitch und PostModelSwitch. Der Matcher greift auf den kanonischen Namen des Zielmodells, und Exit-Code 2 bricht den Wechsel ab."
pubDate: 2026-08-30
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
lang: "de"
translationOf: "2026/08/claude-code-premodelswitch-hook-gates-model-changes"
translatedBy: "claude"
translationDate: 2026-08-30
---

Jedes Hook-Event, das Claude Code vor dieser Woche ausgeliefert hat, bewacht etwas, das das Modell tut: `PreToolUse` sieht einen Bash-Befehl, bevor er läuft, `PermissionRequest` sieht die Anfrage, bevor Sie sie beantworten, `PreCompact` sieht das Transkript, bevor es zusammengefasst wird. Version 2.1.251, veröffentlicht am 2026-08-28, ergänzt das erste Paar, das das Modell selbst bewacht. `PreModelSwitch` und `PostModelSwitch` feuern, wenn die Sitzung wechselt, welche Gewichte antworten.

## Warum ein Modellwechsel eine Kontrollinstanz verdient

Das Modell einer Sitzung ist keine Vorliebe, es ist eine Eingabe. Wird Opus mitten in einem Refactoring gegen Haiku getauscht, plant ein anderer Reasoner den nächsten Tool-Aufruf auf demselben Transkript. Teams kümmert das aus drei getrennten Gründen: Kosten (ein `/model`-Wechsel nach oben kann die Rechnung für die restlichen Turns vervielfachen), Reproduzierbarkeit (ein Bug-Report mit "Claude hat X getan" ist nicht falsifizierbar, wenn das Modell mitten in der Sitzung gewechselt hat) und Richtlinien (manche Organisationen dürfen Code nur an bestimmte Modelle senden).

Bis 2.1.251 gab es keine Naht, an der sich davon irgendetwas durchsetzen ließ. Jetzt gibt es sie.

## Einen Wechsel blockieren

Registrieren Sie den Hook in `settings.json`. Der Matcher ist hier kein Tool-Name, er trifft auf den kanonischen Namen des Modells zu, *zu dem* die Sitzung wechselt:

```json
{
  "hooks": {
    "PreModelSwitch": [
      {
        "matcher": "claude-opus-5",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/check-model-switch.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Matcher sind reguläre Ausdrücke, also funktionieren `claude-opus-4-6|claude-opus-5` und `.*opus.*` beide, wenn Sie eine ganze Familie statt einer einzelnen ID abfangen wollen.

Der Hook liest das Event über stdin. `PreModelSwitch` und `PostModelSwitch` erhalten `from_model` und `to_model` anstelle der üblichen Tool-Felder, dazu `session_id`, `prompt_id`, `transcript_path` und `cwd`:

```bash
#!/usr/bin/env bash
to_model=$(jq -r '.to_model')

if [ -n "$OPUS_BUDGET_EXHAUSTED" ]; then
  cat <<JSON
{
  "hookSpecificOutput": {
    "hookEventName": "PreModelSwitch",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Opus budget for this repo is spent. Staying on $to_model is blocked until the cycle resets."
  }
}
JSON
fi
exit 0
```

Ein Exit mit Code 2 blockiert den Wechsel ebenfalls, das ist die Einzeiler-Variante, wenn Sie kein JSON ausgeben wollen. Eine scharfe Kante, die man kennen sollte: Ein `PreModelSwitch`-Hook, der an seinem `timeout` abgebrochen wird, blockiert den Wechsel ebenfalls. Dieses Event fällt geschlossen aus, anders als der Rest des Lebenszyklus.

## PostModelSwitch feuert auch ungefragt

`PostModelSwitch` ist die Audit-Hälfte, und sie deckt mehr ab als Ihre eigenen `/model`-Aufrufe. Laut Dokumentation läuft es "after the session's model changes, including changes Claude Code makes on its own, such as restoring the model when you resume a session". Genau dieser Fall macht die Frage "welches Modell hat das geschrieben" im Nachhinein schwer beantwortbar, deshalb ist das Anhängen von `from_model`, `to_model` und `session_id` an eine Logdatei die billigste Observability, die Sie diese Woche ergänzen.

Dieselbe Version behob außerdem Opus-5-Anfragen, die mit "effort is not supported when thinking is disabled" bei Effort xhigh oder max fehlschlugen, und schloss [vier verschiedene Wege an der Berechtigungsprüfung vorbei](/de/2026/08/claude-code-2-1-251-four-ways-around-the-permission-check/). Alle Details stehen in der [Hooks-Referenz](https://code.claude.com/docs/en/hooks).
