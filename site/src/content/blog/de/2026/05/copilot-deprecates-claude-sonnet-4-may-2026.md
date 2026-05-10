---
title: "GitHub Copilot entfernt Claude Sonnet 4 aus allen Oberflächen"
description: "GitHub hat claude-sonnet-4 am 6. Mai 2026 in Copilot Chat, Inline-Bearbeitungen, Ask- und Agent-Modi sowie Code-Vervollständigungen abgekündigt. Empfohlenes Migrationsziel ist Claude Sonnet 4.6. Wonach Sie in Ihrem Repository mit grep suchen sollten, bevor die nächste fest verdrahtete Modellauswahl stillschweigend bricht."
pubDate: 2026-05-10
tags:
  - "github-copilot"
  - "ai-agents"
  - "claude"
lang: "de"
translationOf: "2026/05/copilot-deprecates-claude-sonnet-4-may-2026"
translatedBy: "claude"
translationDate: 2026-05-10
---

GitHub hat [Claude Sonnet 4 am 6. Mai 2026 aus allen Copilot-Oberflächen entfernt](https://github.blog/changelog/2026-05-07-claude-sonnet-4-deprecated/). Nicht nur aus dem Modellauswahlmenü im Chat. Die Abkündigung umfasst Copilot Chat, Inline-Bearbeitungen, Ask-Modus, Agent-Modus und Code-Vervollständigungen. Empfohlenes Migrationsziel ist Claude Sonnet 4.6 (`claude-sonnet-4-6`).

Das Changelog selbst besteht aus zwei kurzen Absätzen. Der interessante Teil ist das, was es nicht sagt.

## Was die Ankündigung tatsächlich abdeckt

Wörtlich: "We have deprecated the following model across all GitHub Copilot experiences (including Copilot Chat, inline edits, ask and agent modes, and code completions) on May 6, 2026."

Das ist die vollständige Liste der namentlich genannten Oberflächen. Copilot CLI wird nicht aufgezählt. Custom Instructions werden nicht aufgezählt. Ob Anfragen, die auf `claude-sonnet-4` festgelegt sind, automatisch an einen Nachfolger umgeleitet werden oder direkt fehlschlagen, wird nicht angegeben. "Please update your workflows and integrations to use supported models" ist die einzige angebotene Migrationsanleitung.

Wenn Sie Sonnet 4 irgendwo im Einsatz haben, wo es auswählbar war, behandeln Sie es als entfernt und planen Sie entsprechend. Gehen Sie nicht davon aus, dass eine automatische Umleitung aktiv ist.

## Wo sich Sonnet 4 in einem typischen Repository versteckt

Die Modellauswahl in der IDE wählt einen Ort. Das festgelegte Modell in Ihrer Repository-Konfiguration wählt einen anderen, und das ist dasjenige, das stillschweigend nicht mehr funktioniert. Drei Stellen, an denen Sie mit grep suchen sollten, bevor Sie die nächste Änderung ausliefern:

```bash
# 1. VS Code workspace and user settings
grep -R "claude-sonnet-4" .vscode/ "$HOME/.config/Code/User/settings.json" 2>/dev/null

# 2. Copilot custom agent / skill manifests
grep -R "claude-sonnet-4" .github/copilot/ .github/agents/ 2>/dev/null

# 3. Workflow files that invoke Copilot CLI or the Copilot agent
grep -R "claude-sonnet-4" .github/workflows/
```

Die zu suchende Zeichenkette ist die wörtliche Modell-ID `claude-sonnet-4`. Nicht `claude-sonnet-4-5`, nicht `claude-sonnet-4-6`, beide werden weiterhin unterstützt. Ein Suchen-und-Ersetzen mit Wortgrenze ist der sichere Weg:

```bash
# Replace only the bare id, leave 4-5 and 4-6 alone
git ls-files | xargs sed -i 's/\bclaude-sonnet-4\b/claude-sonnet-4-6/g'
```

In einer Copilot-Agent-Skill- oder Custom-Instruction-Datei sieht die Änderung typischerweise so aus:

```yaml
# .github/copilot/agents/review.yml
- name: code-review
-   model: claude-sonnet-4
+   model: claude-sonnet-4-6
    instructions: |
      Review the diff against the project conventions.
```

## Warum Sonnet 4.6 die richtige Voreinstellung ist, nicht Opus 4.7

Sonnet 4.6 gehört zur selben Familie, hat ein ähnliches Latenzprofil und ist deutlich stärker bei Long-Context- und Agent-Loop-Benchmarks, auf die Sonnet 4 abgestimmt war. Für PR-Review, Inline-Bearbeitungen und Agent-Modus-Loops, in denen Sie viele günstige Aufrufe absetzen, ist Sonnet 4.6 der direkte Ersatz. Greifen Sie nur dann zu [Claude Opus 4.7, wenn die Arbeit die Mehrkosten rechtfertigt](/de/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/), etwa bei sicherheitskritischen Diffs oder schwierigen Refactorings.

Wenn Sie einen Copilot-Rollout für ein Team verwalten, schicken Sie den Ankündigungslink herum, führen Sie das grep aus und aktualisieren Sie das festgelegte Modell im selben PR. Stille Abkündigungen, die "die meiste Zeit funktionieren, weil niemand die ID festgelegt hat", sind diejenigen, die Sie an einem Dienstagmorgen einholen, wenn die Pipeline eines Entwicklers plötzlich der einzige rote Build ist.
