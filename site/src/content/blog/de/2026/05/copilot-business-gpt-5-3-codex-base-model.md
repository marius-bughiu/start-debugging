---
title: "GPT-5.3-Codex wird das Basismodell für Copilot Business und Enterprise"
description: "Am 17. Mai 2026 hat GitHub das Standardmodell von Copilot in den Business- und Enterprise-Plänen von GPT-4.1 auf GPT-5.3-Codex umgestellt. GPT-4.1 bleibt bis zum 1. Juni kostenfrei, danach fällt es unter nutzungsbasierte Abrechnung. Was sich für gepinnte Modelle in Repository und CI ändert."
pubDate: 2026-05-18
tags:
  - "github-copilot"
  - "ai-agents"
  - "openai"
lang: "de"
translationOf: "2026/05/copilot-business-gpt-5-3-codex-base-model"
translatedBy: "claude"
translationDate: 2026-05-18
---

GitHub hat damit begonnen, [GPT-5.3-Codex am 17. Mai 2026 als neues Basismodell für Copilot Business und Enterprise auszurollen](https://github.blog/changelog/2026-05-17-gpt-5-3-codex-is-now-the-base-model-for-copilot-business-and-enterprise/). Es ersetzt GPT-4.1 als Standard für die gesamte Plan-Stufe und ist das erste Long-Term-Support-Modell (LTS) von GitHub und OpenAI in Copilot: Das LTS-Fenster garantiert, dass das Modell bis zum 2027-02-04 auswählbar bleibt.

Einzelplätze (Copilot Pro, Pro+, Free) sind nicht betroffen. Die Änderung wechselt ausschließlich den Standard für Business und Enterprise.

## Was das "Basismodell" tatsächlich steuert

Das Basismodell ist dasjenige, das Copilot verwendet, wenn eine Anfrage kein bestimmtes Modell pinnt. Überall dort, wo Sie `model: gpt-4.1` in einer Copilot-Konfiguration eingetragen haben, bleibt es vorerst unverändert. Überall dort, wo Sie Copilot die Wahl überlassen, hat sich die Antwort gerade von GPT-4.1 auf GPT-5.3-Codex verschoben.

GPT-5.3-Codex hat einen Premium-Request-Multiplikator von 1x, identisch zu GPT-4.1, sodass die Kosten pro Anfrage in den Business- und Enterprise-SKUs sich durch diesen Wechsel nicht verändern. Inline-Completions, Chat ohne gepinntes Modell und die `auto`-Auswahl des Cloud Agents kippen alle gleichzeitig um.

## Was sich für Repositories ändert, die den alten Standard pinnen

Zwei Stellen, die vor dem 2026-06-01 zu scannen sind. Nach diesem Datum werden Anfragen, die weiterhin auf `gpt-4.1` gepinnt sind, über den nutzungsbasierten Zähler abgerechnet, anstatt enthalten zu sein.

```bash
# 1. Workflow files that pin a Copilot model
grep -RE "model:\s*gpt-4\.1" .github/ 2>/dev/null

# 2. Copilot agent and Chat custom instructions
grep -R "gpt-4.1" .copilot/ .github/copilot-instructions.md 2>/dev/null
```

Wenn die CI des Projekts Copilot CLI oder Cloud-Agent-Tasks gegen ein gepinntes GPT-4.1 fährt, gibt es zwei Optionen: den Pin auf `gpt-5.3-codex` heben oder die zusätzliche Posten-Abrechnung ab dem 1. Juni akzeptieren. Ein YAML-Pin für den neuen Standard hat dieselbe Form:

```yaml
# .github/workflows/copilot-review.yml
- uses: github/copilot-action@v1
  with:
    model: gpt-5.3-codex
    effort: high
```

## Warum GitHub eine Codex-Variante für den LTS-Slot gewählt hat

GPT-5.3-Codex ist das auf Code abgestimmte Geschwistermodell in der GPT-5.3-Familie. Die von GitHub im Rollout-Post genannte Kennzahl war die Code-Survival-Rate, der Anteil akzeptierter Vorschläge, die nach nachfolgenden Bearbeitungen und PR-Merges noch in der Datei stehen. Das Changelog meldet eine deutlich höhere Rate bei Business- und Enterprise-Kunden in der Rollout-Kohorte gegenüber GPT-4.1, und das ist die Begründung, es als LTS-Basis statt des generalistischen GPT-5.3 zu benennen.

Die LTS-Kennzeichnung wiegt schwerer als der eigentliche Modellwechsel. GitHub depreziert Modelle laufend und mit kurzer Vorwarnung. [Claude Sonnet 4 wurde elf Tage zuvor von allen Copilot-Oberflächen entfernt](/de/2026/05/copilot-deprecates-claude-sonnet-4-may-2026/), mit einem Changelog von zwei Absätzen und ohne Migrationsfenster. Die Codex-LTS-Zusage ist die erste datierte Verfügbarkeitsgarantie von GitHub für ein Copilot-Modell, und der Rest der Reihe hat sie nicht.

Der GPT-4.1-Zugriff bleibt bis zum 2026-06-01 ohne Aufpreis bestehen. Danach läuft der Zähler.
