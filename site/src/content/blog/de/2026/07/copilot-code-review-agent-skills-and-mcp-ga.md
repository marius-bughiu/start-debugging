---
title: "Copilot Code Review liest jetzt Ihren Ordner .github/skills"
description: "Agent Skills und MCP-Server in GitHub Copilot Code Review sind am 2026-07-29 allgemein verfügbar geworden. Wo die Dateien liegen, warum Skills aus dem Head-Branch geladen werden und warum jeder MCP-Toolaufruf in einem Review nur lesend erfolgt."
pubDate: 2026-07-31
tags:
  - "github-copilot"
  - "agent-skills"
  - "mcp"
  - "code-review"
  - "ai-agents"
lang: "de"
translationOf: "2026/07/copilot-code-review-agent-skills-and-mcp-ga"
translatedBy: "claude"
translationDate: 2026-07-31
---

Am 2026-07-29 hat GitHub [Agent Skills und MCP-Unterstützung in Copilot Code Review](https://github.blog/changelog/2026-07-29-copilot-code-review-agent-skills-and-mcp-now-generally-available/) für Copilot Pro, Pro+, Business und Enterprise allgemein verfügbar gemacht. Bisher las der Reviewer Ihren Diff und Ihre benutzerdefinierten Anweisungen, und das war das gesamte Kontextfenster. Jetzt kann er dieselben Skill-Ordner heranziehen, die auch Ihr Coding-Agent nutzt, dazu lesenden Kontext aus MCP-Servern.

Damit schließt sich die ärgerlichste Lücke im automatisierten Review: Der Bot konnte melden, dass eine `null`-Prüfung fehlt, aber er wusste nichts davon, dass Ihr Team für jede EF Core Migration ein nicht leeres `Down()` verlangt, und er hatte keine Möglichkeit nachzusehen, ob das Issue, das dieser PR schließt, im letzten Sprint bereits zurückgenommen wurde.

## Skills sind Ordner, und der Reviewer wählt sie selbst aus

Eine Skill ist ein Verzeichnis unter `.github/skills` mit einer `SKILL.md` darin. Copilot gleicht die Aufgabe mit der `description` jeder Skill ab und lädt nur das, was relevant wirkt. Eine auf Reviews ausgerichtete Skill braucht daher einen Verzeichnisnamen und eine Beschreibung, die nach Review-Arbeit klingen.

```md
---
name: ef-core-migration-review
description: Review EF Core migrations for a non-empty Down(), no data loss on column drops, and an explicit index name. Use when the diff touches Migrations/.
---

## What to flag

- A `Down()` method with only `// no-op` or an empty body. Every migration must be reversible.
- `DropColumn` without a preceding data copy. Comment with the backfill snippet from `references/backfill.md`.
- `CreateIndex` without an explicit `name:` argument.
```

Das Detail, das man kennen sollte: Copilot Code Review liest Anweisungen und Skills aus dem **Head-Branch**, nicht aus dem Base-Branch. Wer eine Skill bearbeitet und einen PR öffnet, bekommt genau diesen PR von der bearbeiteten Skill geprüft. Sie können also an Review-Regeln arbeiten, ohne sie vorher zu mergen, das Gegenteil des Verhaltens der meisten CI-basierten Lint-Konfigurationen.

## MCP ist standardmäßig aktiv und per Design nur lesend

MCP-Server für Reviews werden in den Repository-Einstellungen unter Copilot > MCP servers konfiguriert, mit demselben JSON, das auch der Cloud-Agent verwendet. Die Server für GitHub und Playwright sind bereits aktiviert.

```json
{
  "mcpServers": {
    "issue-tracker": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer $COPILOT_MCP_TRACKER_TOKEN" },
      "tools": ["search_issues", "get_issue"]
    }
  }
}
```

Tokens liegen in den Repository-Einstellungen unter Secrets and variables > Agents und werden als `$COPILOT_MCP_*` referenziert. Jeder MCP-Toolaufruf während eines Reviews ist auf Lesezugriff beschränkt, und das ist die richtige Entscheidung: Ein Reviewer, der in Ihren Issue Tracker schreiben kann, ist ein Reviewer, der sich über den Text eines Pull Requests per Prompt Injection steuern lässt. Beachten Sie, dass `"tools": ["*"]` weiterhin akzeptiert wird. GitHub empfiehlt jedoch, gezielt einzelne Tools auf die Allowlist zu setzen, weil der Agent sie autonom und ohne Freigabeschritt verwendet.

Wenn Sie MCP lieber nur für den Cloud-Agent freigeben möchten: Die Repository-Einstellung "Allow Copilot to use MCP tools when reviewing pull requests" ist standardmäßig aktiv und lässt sich abschalten. Review-Kommentare, die auf einer Skill oder einem MCP-Tool beruhen, tragen jetzt eine Quellenangabe, sodass erkennbar ist, welche Regel welche Anmerkung erzeugt hat.

Wenn Ihr Repository noch einen Ordner `.github/prompts/` hat, ist das der Anlass, [die Prompt-Dateien endgültig auf Agent Skills zu migrieren](/2026/07/migrate-copilot-prompt-files-to-agent-skills/): Dieselbe `SKILL.md` speist jetzt die IDE, den Cloud-Agent und den Reviewer.
