---
title: "Claude Code 2.1.122 erlaubt die Auswahl der Bedrock-Service-Stufe per Umgebungsvariable"
description: "Claude Code v2.1.122 fügt die Umgebungsvariable ANTHROPIC_BEDROCK_SERVICE_TIER hinzu, die als Header X-Amzn-Bedrock-Service-Tier gesendet wird. Setzen Sie sie auf flex für 50 Prozent Rabatt auf Agent-Aufrufe oder priority für schnellere Antworten, ohne SDK-Code anzufassen."
pubDate: 2026-04-30
tags:
  - "claude-code"
  - "ai-agents"
  - "aws-bedrock"
  - "dotnet"
lang: "de"
translationOf: "2026/04/claude-code-2-1-122-bedrock-service-tier"
translatedBy: "claude"
translationDate: 2026-04-30
---

Das Claude Code v2.1.122 Release vom 28. April 2026 hat einen Einzeiler-Schalter gebracht, auf den alle, die den Agent auf AWS Bedrock betreiben, still gewartet haben: eine neue Umgebungsvariable `ANTHROPIC_BEDROCK_SERVICE_TIER`, die die Bedrock-Service-Stufe für jeden Request auswählt. Setzen Sie sie auf `default`, `flex` oder `priority`, und das CLI leitet den Wert als Header `X-Amzn-Bedrock-Service-Tier` weiter. Keine SDK-Codeänderungen. Keine JSON-Konfigurationsanpassungen. Eine Umgebungsvariable.

## Warum das wichtig ist, bevor Sie den Rest lesen

AWS hat die Priority- und Flex-Inferenzstufen für Bedrock im November 2025 eingeführt, um Latenz gegen Kosten einzutauschen. Laut der [Bedrock-Service-Tiers-Seite](https://aws.amazon.com/bedrock/service-tiers/) bietet Flex 50 Prozent Rabatt gegenüber dem Standard-Preis im Austausch für "erhöhte Latenz", und Priority ist ein Aufschlag von 75 Prozent, der Ihre Anfragen an den Anfang der Warteschlange stellt. Für einen Agent wie Claude Code, der über eine Sitzung hinweg lange Sequenzen von Tool-Use-Turns abfeuert, ist die Rechnung deutlich. Eine lange Evergreen-Aufgabe, die auf default lief, könnte auf Flex die Hälfte kosten, wenn Sie die zusätzliche Wandzeit verkraften, und eine Debug-Sitzung, bei der Sie das Terminal beobachten, könnte sich auf Priority flotter anfühlen.

Bis v2.1.122 war der einzige Weg, eine Stufe mit Claude Code auf Bedrock zu wählen, die Request-Schicht selbst zu umhüllen oder über einen Proxy zu gehen, der den Header einschleusen kann. Der [Feature-Request](https://github.com/anthropics/claude-code/issues/16329), der in diesem Release gelandet ist, schließt diese Lücke.

## Die tatsächliche Nutzung

```bash
# Cheap background agents that triage issues overnight
export ANTHROPIC_BEDROCK_SERVICE_TIER=flex
claude --from-pr https://github.acme.internal/acme/api/pull/482

# Interactive debug session, paying for speed
export ANTHROPIC_BEDROCK_SERVICE_TIER=priority
claude
```

Das CLI schickt den Wert wortwörtlich als `X-Amzn-Bedrock-Service-Tier` im InvokeModel-Request, was dieselbe Klempnerei ist, die CloudTrail und CloudWatch bereits unter `ServiceTier` und `ResolvedServiceTier` aufzeichnen. Wenn Ihr Plattformteam also Dashboards für die Bedrock-Ausgaben pro Stufe hat, landet der Claude-Code-Traffic jetzt ohne zusätzliche Arbeit im richtigen Eimer.

## Vorsicht bei ResolvedServiceTier

Der Header ist eine Anfrage, keine Garantie. AWS gibt die Stufe, die tatsächlich bedient wurde, in `ResolvedServiceTier` zurück, und Flex-Anfragen können herabgestuft werden, wenn der Flex-Pool des Modells gesättigt ist. Die vollständige Liste, welche Modelle Priority und Flex unterstützen, steht auf der [Bedrock-Preisseite](https://aws.amazon.com/bedrock/pricing/), und sie hinkt den neuesten Modell-Releases um Wochen hinterher. Bestätigen Sie also, dass die Modell-ID, mit der Sie Claude Code betreiben, dort gelistet ist, bevor Sie `flex` in einen CI-Job einbacken. Wenn eine Stufe nicht unterstützt wird, fällt AWS transparent auf die Standardstufe zurück und stellt entsprechend in Rechnung.

Die `ANTHROPIC_BEDROCK_SERVICE_TIER`-Zeile ist mitten im Changelog vergraben, aber sie ist gerade jetzt der billigste Kostenhebel für Claude Code auf Bedrock. Die vollständigen Notizen finden Sie auf der [Claude Code v2.1.122 Release-Seite](https://github.com/anthropics/claude-code/releases).
