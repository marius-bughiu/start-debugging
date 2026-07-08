---
title: "Claude Sonnet 5 ist das neue Standardmodell von Claude Code: berechnen Sie Ihre Token-Budgets neu"
description: "Claude Sonnet 5 (claude-sonnet-5) erschien am 2026-06-30 und steht nun hinter dem Alias 'sonnet' in Claude Code. Sein neuer Tokenizer erzeugt für denselben Text etwa 30% mehr Tokens, daher müssen für Sonnet 4.6 abgestimmte Kostenschätzungen und max_tokens-Grenzen neu berechnet werden."
pubDate: 2026-07-08
tags:
  - "claude-code"
  - "ai-agents"
  - "llm"
lang: "de"
translationOf: "2026/07/claude-sonnet-5-claude-code-default-new-tokenizer-token-budgets"
translatedBy: "claude"
translationDate: 2026-07-08
---

Claude Sonnet 5 (`claude-sonnet-5`) erschien am 2026-06-30, und es ist keine Vorschau, für die Sie sich entscheiden müssen. In der Anthropic-API wird der Alias `sonnet` nun darauf aufgelöst, und in Claude Code ist es das Standardmodell des Kontos für Pro-, Team-Standard- und Enterprise-Abonnementplätze. Das bedeutet, dass viele Menschen es bereits verwenden, ohne eine einzige Konfigurationszeile zu ändern. Der Haken ist, dass "direktes Upgrade" nicht "dieselbe Token-Mathematik" bedeutet, und wenn Sie Kosten berechnen oder `max_tokens` von Hand dimensionieren, sind die für Sonnet 4.6 abgestimmten Zahlen jetzt falsch.

## Der Tokenizer hat sich unbemerkt geändert

Sonnet 5 bringt einen neuen Tokenizer. Derselbe Eingabetext erzeugt ungefähr 30% mehr Tokens als bei Sonnet 4.6. Der Preis pro Token bleibt unverändert, $3/$15 pro Million Eingabe-/Ausgabe-Tokens (mit einem Einführungspreis von $2/$10, der bis 2026-08-31 gilt), aber 30% mehr Tokens für identischen Text bedeuten, dass die Kosten einer gleichwertigen Anfrage steigen, obwohl die Preisliste es nicht getan hat.

Drei Dinge, die Sie in Tokens messen, verschieben sich:

- **Kosten pro Anfrage.** Jede Schätzung, die aus einer Sonnet-4.6-Token-Zählung abgeleitet wurde, ist jetzt zu niedrig.
- **`max_tokens`-Budgets.** Eine Ausgabegrenze, die nahe an Ihrer erwarteten Antwort dimensioniert ist, kann bei Sonnet 5 abgeschnitten werden, weil dieselbe Antwort mehr Tokens verbraucht.
- **Kontextkapazität in Textbegriffen.** Das Fenster umfasst 1M Tokens, aber jeder Token deckt im Durchschnitt weniger Text ab, sodass dasselbe Fenster weniger Prosa fasst.

Extrapolieren Sie nicht. Zählen Sie gegen das Modell mit dem Token-Zähl-Endpunkt neu, bevor Sie einem Budget vertrauen:

```bash
curl https://api.anthropic.com/v1/messages/count_tokens \
  --header "x-api-key: $ANTHROPIC_API_KEY" \
  --header "anthropic-version: 2023-06-01" \
  --header "content-type: application/json" \
  --data '{
    "model": "claude-sonnet-5",
    "messages": [{ "role": "user", "content": "Summarize this build log." }]
  }'
```

Führen Sie dieselbe Payload gegen `claude-sonnet-4-6` aus und vergleichen Sie `input_tokens`. Diese Differenz ist Ihre Budgetkorrektur.

## Drei API-Verhalten, die jetzt 400 zurückgeben

Wenn Sie Sonnet 5 direkt aufrufen, geben drei Anfragen, die bei Sonnet 4.6 funktionierten, jetzt `400` zurück:

- **Sampling-Parameter.** Das Setzen von `temperature`, `top_p` oder `top_k` auf einen Nicht-Standardwert wird abgelehnt. Entfernen Sie sie und steuern Sie stattdessen über den System-Prompt.
- **Manuelles Extended Thinking.** `thinking: {"type": "enabled", "budget_tokens": N}` ist weg. Verwenden Sie das adaptive Thinking, das standardmäßig aktiviert ist.
- **Assistant-Prefill.** Weiterhin nicht unterstützt, unverändert gegenüber Sonnet 4.6.

## Was das innerhalb von Claude Code bedeutet

Sonnet 5 erfordert Claude Code v2.1.197 oder neuer; führen Sie `claude update` aus, wenn `sonnet` sich noch auf 4.6 auflöst. In der Anthropic-API läuft es immer mit dem nativen 1M-Kontextfenster, ohne `[1m]`-Suffix und ohne Nutzungsguthaben, und Sitzungen kompaktieren sich automatisch bei etwa 967K Tokens. Wenn Sie zur Kostenkontrolle eine harte Obergrenze von 200K benötigen, setzen Sie `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`. Und wenn Sie genau steuern möchten, wann Ihr Team die Version wechselt, fixieren Sie die vollständige ID, statt auf den Alias zu setzen:

```json
{
  "model": "claude-sonnet-5"
}
```

Die Migration selbst ist tatsächlich ein Austausch der Modell-ID in einer einzigen Zeile. Die Arbeit steckt in den Budgets rundherum. Alle Details finden Sie in den [Sonnet-5-Versionshinweisen](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5).
