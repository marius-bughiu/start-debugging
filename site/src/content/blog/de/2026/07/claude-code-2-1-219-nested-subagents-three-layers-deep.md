---
title: "Claude Code 2.1.219 öffnet verschachtelte Subagenten wieder, drei Ebenen tief"
description: "Version 2.1.219 hebt die Standardtiefe für das Starten von Subagenten von 1 auf 3, ergänzt den Konfigurationsschlüssel workflowSizeGuideline und liefert eine Netzwerk-Allowlist, die im Zweifel blockiert."
pubDate: 2026-07-26
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
lang: "de"
translationOf: "2026/07/claude-code-2-1-219-nested-subagents-three-layers-deep"
translatedBy: "claude"
translationDate: 2026-07-26
---

Die letzten zwei Wochen an Claude-Code-Releases waren ein Tauziehen darüber, wie viel Leine eine Agentenflotte bekommt. Version 2.1.213 nahm die Verschachtelung komplett weg. Version 2.1.219, veröffentlicht am 2026-07-24, gibt sie mit einer Zahl versehen zurück: Subagenten können jetzt standardmäßig eigene Subagenten bis Tiefe 3 starten, vorher 1.

## Der Standardwert kippte zweimal in zwei Wochen

Die Zeile im [Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) ist unmissverständlich: "Subagenten können jetzt verschachtelte Subagenten bis Tiefe 3 standardmäßig starten (vorher 1); setzen Sie CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1, um die Verschachtelung zu deaktivieren".

Die Vorgeschichte lohnt sich, denn das Verhalten hat sich dreimal bewegt. Von v2.1.172 bis v2.1.216 verschachtelten sich Subagenten bis zu fünf Ebenen tief, und das Limit war nicht konfigurierbar. Dann setzte 2.1.213 [harte Grenzen für außer Kontrolle geratene Subagenten-Flotten](/de/2026/07/claude-code-2-1-213-caps-runaway-subagent-fleets/) und senkte den Standard auf Tiefe 1, was bedeutete: Ein Subagent konnte überhaupt nicht delegieren. Bat man ihn um Helfer, erledigte er die Arbeit selbst. 2.1.219 landet bei 3.

Der Schalter bleibt derselbe, nur sein Standardwert hat sich bewegt. Für flache Delegation mit einer einzigen Ebene setzen Sie ihn in der `settings.json` fest:

```json
{
  "env": {
    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1"
  }
}
```

Tiefe 3 ist eine bewusste Zahl, keine runde. Genau das braucht ein Review-Fan-out: Die Hauptunterhaltung startet einen Reviewer, der Reviewer startet pro Befund einen Verifizierer, und jeder Verifizierer kann immer noch eine eng gefasste Recherche delegieren. Bei Tiefe 1 fiel diese Form in einen einzigen Subagenten zusammen, der alles nacheinander in einem Kontextfenster erledigte.

## Eine Größenrichtlinie als Gegengewicht

Die Verschachtelung ohne Bremse wieder zu öffnen, würde nur das Problem zurückholen, das 2.1.213 gelöst hat. Deshalb bringt dasselbe Release eine mit. Dynamische Workflows verwenden jetzt standardmäßig eine mittlere Größenrichtlinie mit dem Ziel von weniger als 15 Agenten, und diese Richtlinie ist nicht mehr nur ein Schalter in `/config`. Es gibt einen Konfigurationsschlüssel dafür:

```json
{
  "workflowSizeGuideline": "medium"
}
```

Setzen Sie ihn in einer beliebigen Settings-Datei, dann blendet sich die `/config`-Zeile aus. Die Statuszeile eines laufenden Workflows zeigt jetzt zusätzlich die aktuelle Größe, sodass Sie während der Ausführung sehen, unter welcher Richtlinie ein Workflow arbeitet. Beachten Sie: Das ist eine Empfehlung. Sie beeinflusst, wie viele Agenten das Modell anstrebt, und ist keine harte Obergrenze. Die echten Obergrenzen sind weiterhin die Limits für Parallelität und Subagenten pro Sitzung.

## Netzwerk-Allowlists, die im Zweifel blockieren

Die andere Änderung, die sich heute zu konfigurieren lohnt, ist `sandbox.network.strictAllowlist`. Standardmäßig fragt die Sandbox nach, sobald ein Befehl zum ersten Mal eine nicht freigegebene Domain braucht. Verwaltete Deployments konnten über `allowManagedDomainsOnly` bereits blockieren statt zu fragen. Jetzt kann jede Settings-Datei im Zweifel blockieren:

```json
{
  "sandbox": {
    "enabled": true,
    "network": {
      "strictAllowlist": true,
      "allowedDomains": ["github.com", "*.npmjs.org"]
    }
  }
}
```

Für unbeaufsichtigte Läufe ist das die gewünschte Einstellung. Eine Rückfrage, die niemand beantwortet, ist ein Hänger, und mit wieder aktivierter Verschachtelung gibt es mehr Prozesse, die darauf stoßen können.

Ebenfalls in 2.1.219: Claude Opus 5 (`claude-opus-5`) ist das Standard-Opus-Modell mit 1M Kontext und Fast Mode zu $10/$50 pro Mtok, und Opus 4.7 fällt komplett aus dem Fast Mode heraus.
