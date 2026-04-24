---
title: "Agent Skills landen in Visual Studio 2026 18.5: Copilot entdeckt SKILL.md automatisch aus Ihrem Repo"
description: "Visual Studio 2026 18.5.0 lässt GitHub Copilot Agent Skills aus .github/skills, .claude/skills und ~/.copilot/skills laden. Wiederverwendbare SKILL.md-Instruction-Packs reisen mit Ihrem Repo."
pubDate: 2026-04-20
tags:
  - "visual-studio"
  - "github-copilot"
  - "agent-skills"
  - "dotnet"
lang: "de"
translationOf: "2026/04/visual-studio-2026-copilot-agent-skills"
translatedBy: "claude"
translationDate: 2026-04-24
---

Das Release von Visual Studio 2026 vom 14. April 2026 (Version 18.5.0) hat leise eines der nützlichsten Copilot-Features des Jahres hinzugefügt: [Agent Skills](https://learn.microsoft.com/en-us/visualstudio/releases/2026/release-notes). Wenn Sie die letzten sechs Monate denselben "so reviewen wir Pull Requests in diesem Repo"-Absatz in den Copilot Chat copy-pasten, können Sie aufhören. Agent Skills sind wiederverwendbare Instruction-Packs, die neben Ihrem Code leben, und Copilot in Visual Studio entdeckt sie jetzt automatisch.

## Wo Visual Studio nach Skills sucht

Ein Skill ist einfach ein Ordner mit einer `SKILL.md`-Datei darin. Visual Studio 2026 18.5 scannt sechs bekannte Orte, drei an den Workspace gebunden und drei an Ihr Benutzerprofil:

- Workspace: `.github/skills/`, `.claude/skills/`, `.agents/skills/`
- Persönlich: `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/`

Die Duplizierung ist beabsichtigt. Die [agentskills.io-Spezifikation](https://agentskills.io/specification) ist ein offenes Format, und dieselben Ordner werden von der GitHub Copilot CLI, dem Copilot Cloud Agent und VS Code gelesen. Legen Sie einen Skill in `.github/skills/` und jede Copilot-Oberfläche, die Ihr Team verwendet, sieht ihn, nicht nur die IDE auf Ihrem Rechner.

## Wie eine SKILL.md tatsächlich aussieht

Die Datei ist Markdown mit einem YAML-Frontmatter-Header. Das Frontmatter hat zwei erforderliche Felder, `name` und `description`, plus einige optionale für die Art, wie der Skill aufgerufen wird:

```markdown
---
name: efcore-migration-review
description: Reviews EF Core migration files in this repo. Use whenever the user asks Copilot to add, squash, or review a migration under src/Infrastructure/Migrations.
argument-hint: [migration file path]
user-invocable: true
disable-model-invocation: false
---

# EF Core migration review

When reviewing a migration under `src/Infrastructure/Migrations`:

1. Reject any migration that drops a column without a corresponding data backfill step.
2. Flag `AlterColumn` calls that change nullability on tables with more than 10M rows. Point at `docs/ops/large-table-playbook.md`.
3. Require a matching `Down()` that is a true inverse, not an empty stub.

Reference implementation: see `examples/add-index-migration.md` in this skill folder.
```

Das `name`-Feld muss kleingeschrieben sein, mit Bindestrichen getrennt, maximal 64 Zeichen, und muss zum Ordnernamen passen. Das `description`-Feld ist das, was Copilot verwendet, um zu entscheiden, ob der Skill geladen wird, also lohnt es sich, es wie eine Retrieval-Query zu schreiben, nicht wie eine Tagline. Die maximale Länge beträgt 1024 Zeichen, und Sie sollten sie nutzen.

## Warum das den Default ändert

Bis jetzt war das übliche Muster eine ausufernde `.github/copilot-instructions.md` oder ein Custom Agent, definiert in `.agent.md`. Agent Skills sind absichtlich enger geschnitten: jeder Skill ist ein einzelnes Anliegen, on demand geladen, und nur sein Body landet im Context Window, wenn die Beschreibung passt. Für ein .NET-Monorepo mit EF-Core-Migrations, MAUI-Plattformcode und ASP.NET-Core-Controllern können Sie drei separate Skills ausliefern statt einer riesigen Instructions-Datei und aufhören, Tokens auf Anleitungen zu verbrennen, die für die aktuelle Aufgabe irrelevant sind.

Skills komponieren auch mit Custom Agents. Eine `.agent.md`-Datei kann scopen, welche Skills sie hereinzieht, was der Weg ist, wie Teams mit einem "backend-reviewer"-Agent enden, der nur EF-Core- und ASP.NET-Core-Skills sieht, während ein "mobile-reviewer"-Agent die MAUI- und Flutter-Skills sieht.

Microsoft merkt an, dass die Browsing- und Erstellungs-UI noch in einem späteren 18.x-Update kommt, also sind es vorerst Textdateien in Ordnern. Das ist in Ordnung. Textdateien in Ordnern sind, wofür Versionskontrolle da ist.
