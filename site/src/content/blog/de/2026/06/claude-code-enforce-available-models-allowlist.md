---
title: "Claude Code 2.1.175 schließt mit enforceAvailableModels das availableModels-Schlupfloch"
description: "Monatelang beschränkte availableModels die Modellauswahl, ließ aber die Option Default weit offen. Claude Code 2.1.175 ergänzt enforceAvailableModels, sodass Administratoren endlich eine strikte Modell-Allowlist festlegen können."
pubDate: 2026-06-15
tags:
  - "claude-code"
  - "ai-agents"
  - "governance"
lang: "de"
translationOf: "2026/06/claude-code-enforce-available-models-allowlist"
translatedBy: "claude"
translationDate: 2026-06-15
---

Wenn sich Ihre Organisation auf `availableModels` standardisiert hat, um zu steuern, welche Claude-Modelle Entwickler ausführen dürfen, gab es die ganze Zeit ein stilles Loch in diesem Zaun. Die Allowlist regelte `/model`, das `--model`-Flag, `ANTHROPIC_MODEL`, Subagenten und Advisor-Overrides, aber sie betraf nie die eine Option, die jede Auswahl anzeigt: Default. Ein Entwickler konnte Default wählen und beim systemseitigen Standard für seine Stufe landen und so glatt an Ihrer kuratierten Liste vorbeisegeln. Claude Code 2.1.175, veröffentlicht am 2026-06-12, schließt diese Lücke endlich mit einer neuen verwalteten Einstellung: `enforceAvailableModels`.

## Warum Default das Leck war

`availableModels` war immer eine Allowlist für *benannte* Modelle. Der Default-Eintrag ist besonders. Er ist kein Modell-Alias, er löst sich zum Laufzeitstandard der Kontostufe auf (Opus 4.8 auf der Anthropic API für Max und Pay-as-you-go, Sonnet 4.6 auf Abonnement-Sitzen und so weiter). Weil Default die benannte Liste umgeht, konnte ein Administrator, der dies festgelegt hatte:

```json
{
  "availableModels": ["claude-sonnet-4-5", "haiku"]
}
```

einen Nutzer trotzdem nicht davon abhalten, Default zu wählen und das neueste Stufenmodell zu erhalten. Für Teams, die aus Kosten- oder Compliance-Gründen eine bestimmte Version festlegen, war das eine echte Umgehung, keine theoretische.

## Was enforceAvailableModels tatsächlich bewirkt

Setzen Sie es in den verwalteten Einstellungen oder Richtlinieneinstellungen auf `true`, zusammen mit einer nicht leeren `availableModels`-Liste. Wenn der Stufenstandard nicht in der Allowlist enthalten ist, löst sich Default jetzt zum ersten erlaubten Eintrag auf statt zum Stufenstandard.

```json
{
  "model": "claude-sonnet-4-5",
  "availableModels": ["claude-sonnet-4-5", "haiku"],
  "enforceAvailableModels": true,
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5"
  }
}
```

Die beiden Einstellungen decken unterschiedliche Bereiche ab. `enforceAvailableModels` zwingt Default, der Allowlist zu folgen, während der `env`-Block festlegt, zu welcher Version ein erlaubter Alias wie `sonnet` aufgelöst wird. Ein Vorbehalt, den Sie sich merken sollten: Ein leeres `availableModels: []` aktiviert die Durchsetzung nie, sodass Nutzer ihren Stufen-Default behalten, egal was `enforceAvailableModels` sagt.

## Der Härtungsdurchlauf in 2.1.176

Einen Tag später schloss 2.1.176 zwei angrenzende Kanten. Alias-Modellauswahlen können nicht mehr über `ANTHROPIC_DEFAULT_*_MODEL`-Umgebungsvariablen zu einem blockierten Modell umgeleitet werden, und `/fast` weigert sich jetzt umzuschalten, wenn der Wechsel auf einem Modell außerhalb der Allowlist landen würde.

Ebenso wichtig ist das Merge-Verhalten. Wenn `availableModels` in den verwalteten Einstellungen oder Richtlinieneinstellungen gesetzt ist, ersetzt dieser Wert das gemergte Ergebnis vollständig. In Nutzer- oder Projekteinstellungen hinzugefügte Einträge können es nicht erweitern, und `enforceAvailableModels` wird auf dieselbe Weise ersetzt. Seit 2.1.175 ist dies der einzige Weg, eine strikte Allowlist durchzusetzen; frühere Versionen mergten die verwaltete Liste mit Einträgen niedrigerer Priorität, was bedeutete, dass ein Entwickler still etwas anhängen konnte.

Wenn Sie Claude Code in einem Team einsetzen und Ihnen wichtig ist, welche Modelle tatsächlich ausgeführt werden, aktualisieren Sie auf 2.1.175 oder höher und kombinieren Sie `availableModels` mit `enforceAvailableModels`. Die vollständigen Prioritätsregeln finden Sie in der [Dokumentation zur Modellkonfiguration](https://code.claude.com/docs/en/model-config).
