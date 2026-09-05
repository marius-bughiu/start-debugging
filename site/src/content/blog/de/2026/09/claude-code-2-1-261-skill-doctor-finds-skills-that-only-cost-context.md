---
title: "Claude Code 2.1.261 bringt /skill-doctor: Skills finden, die nur Kontext kosten"
description: "Der Rumpf einer Skill lädt bei Bedarf, aber Name und Beschreibung stehen in einer Auflistung, die immer im Prompt liegt, begrenzt auf 1% des Kontextfensters. Claude Code 2.1.261 ergänzt /skill-doctor: Der Bericht nennt die geladenen Skills, die nie verwendet werden, und was jede davon kostet, bevor das Budget die Skills verdrängt, die Sie tatsächlich nutzen."
pubDate: 2026-09-05
tags:
  - "claude-code"
  - "agent-skills"
  - "ai-agents"
  - "context-window"
lang: "de"
translationOf: "2026/09/claude-code-2-1-261-skill-doctor-finds-skills-that-only-cost-context"
translatedBy: "claude"
translationDate: 2026-09-05
---

Claude Code 2.1.261 erschien am 4. September mit einem kleinen Befehl, der eine Frage beantwortet, die bei einem vollen `~/.claude/skills`-Verzeichnis bisher niemand beantworten konnte: `/skill-doctor` zeigt, welche geladenen Skills ungenutzt bleiben und was sie an Kontext kosten, damit Sie sie entfernen können. Der Befehl steht noch nicht in der [Befehlsreferenz](https://code.claude.com/docs/en/commands), der zugrunde liegende Mechanismus ist aber dokumentiert, und es lohnt sich, ihn vor der Ausgabe zu verstehen.

## Eine nie aufgerufene Skill ist nicht kostenlos

Das übliche Bild lautet: Skills sind günstig, weil sie verzögert laden. Das stimmt nur halb. Der Rumpf einer `SKILL.md` gelangt erst in die Konversation, wenn die Skill aufgerufen wird. Name und Beschreibung nicht: Claude Code lädt eine Auflistung sämtlicher Skill-Namen und -Beschreibungen in den Kontext, damit das Modell weiß, was verfügbar ist.

Diese Auflistung hat ein festes Budget. Laut der [Skills-Dokumentation](https://code.claude.com/docs/en/skills) "scales at 1% of the model's context window", und der kombinierte Beschreibungstext jedes Eintrags ist unabhängig davon auf 1.536 Zeichen begrenzt. Läuft die Auflistung über das Budget hinaus, verwirft Claude Code Beschreibungen, beginnend bei den am seltensten aufgerufenen Skills.

Eine ungenutzte Skill kostet also mehr als ihre eigenen Tokens. Sie konkurriert um ein gemeinsames Budget mit den Skills, auf die Sie angewiesen sind, und eine gekürzte Beschreibung verliert genau die Schlüsselwörter, die das Modell zur Zuordnung Ihrer Anfrage braucht. Das Ergebnis ist eine Skill, die still nicht mehr auslöst, ohne Fehlermeldung. `/doctor` schätzte bereits die Gesamtkosten der Auflistung und ihre größten Posten; 2.1.261 löst die Sicht pro Skill, verwendet gegen ungenutzt, in einen eigenen Bericht heraus.

## Vom Bericht zur Konfiguration

Sobald klar ist, welche Einträge Ballast sind, ändert `skillOverrides` in `.claude/settings.json` die Sichtbarkeit, ohne die `SKILL.md` eines gemeinsam genutzten Repositorys anzufassen:

```json
{
  "skillOverrides": {
    "legacy-context": "name-only",
    "deploy": "user-invocable-only",
    "old-migration-helper": "off"
  }
}
```

`"name-only"` hält die Skill in der Liste, entfernt aber ihre Beschreibung und gibt Budget frei. `"user-invocable-only"` verbirgt sie vor dem Modell, `/deploy` bleibt tippbar. `"off"` verbirgt sie vor beiden. Bei einer eigenen Skill ist `disable-model-invocation: true` im Frontmatter das Gegenstück; damit verschwindet die Beschreibung vollständig aus dem Kontext. Skills aus Plugins ignorieren `skillOverrides`; die verwalten Sie über `/plugin`.

Wenn der Bericht sagt, dass jede Skill ihren Platz verdient, erhöhen Sie die Obergrenze statt zu streichen: `skillListingBudgetFraction` nimmt einen Bruchteil (`0.02` für 2%), `SLASH_COMMAND_TOOL_CHAR_BUDGET` eine feste Zeichenzahl, und `skillListingMaxDescChars` verschiebt die Grenze von 1.536 Zeichen pro Eintrag. Prüfen Sie danach die Zeile Skills in `/context`, die seit v2.1.196 die Größe der Auflistung nach angewendetem Budget meldet und nicht den vollen Text.

Dasselbe Release bringt zwei weitere Kontextregler: `bashOutputMaxChars` und `taskOutputMaxChars` erhöhen, wie viel Befehls- und Hintergrundausgabe Claude inline erhält, bevor sie in eine Datei ausgelagert wird, bis zu 128K Zeichen, und `--append-subagent-system-prompt-file` liest den System-Prompt eines Subagenten aus einer Datei, wenn er für die Kommandozeile zu groß ist. Falls Sie beim Release-Takt hinterherhängen: [2.1.259 brachte managedMcpServers](/de/2026/09/claude-code-2-1-259-managed-mcp-servers-without-mdm/) zwei Tage zuvor.

Alle Details im [Claude Code Changelog](https://code.claude.com/docs/en/changelog).
