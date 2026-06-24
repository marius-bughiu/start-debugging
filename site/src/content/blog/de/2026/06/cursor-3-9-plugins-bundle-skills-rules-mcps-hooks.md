---
title: "Cursor 3.9 bündelt Ihre Agenten-Konfiguration in portable Plugins"
description: "Cursor 3.9 bringt ein Plugin-System und eine vereinheitlichte Customize-Seite, sodass Skills, Regeln, MCP-Server, Befehle und Hooks als eine versionierte Einheit zusammen reisen."
pubDate: 2026-06-24
tags:
  - "cursor"
  - "ai-agents"
  - "mcp"
lang: "de"
translationOf: "2026/06/cursor-3-9-plugins-bundle-skills-rules-mcps-hooks"
translatedBy: "claude"
translationDate: 2026-06-24
---

Cursor 3.9 erschien am 22. Juni 2026, und die Schlagzeile ist kein Modellwechsel und kein schnelleres Apply. Es ist Infrastruktur: ein echtes Plugin-Format plus eine einzige Customize-Seite, die Plugins, Skills, MCP, Subagenten, Regeln, Befehle und Hooks auf einem Bildschirm zusammenführt, den Sie auf Benutzer-, Team- oder Workspace-Ebene verwalten.

Wer schon einmal einen Cursor-Agenten für ein Team eingerichtet hat, weiß, warum das wichtig ist. Die Bausteine, die einen Agenten in Ihrer Codebasis nützlich machen, lebten bisher an getrennten Orten: Regeln in `.mdc`-Dateien, MCP-Server in eigener Konfiguration, Befehle anderswo, Hooks hinterher angeschraubt. Eine neue Kollegin einzuarbeiten bedeutete, all das von Hand zu replizieren. Ein Plugin macht aus diesem Bündel ein einziges versioniertes, teilbares Artefakt.

## Was ein Plugin tatsächlich ist

Ein Plugin ist ein Verzeichnis mit einem Manifest unter `.cursor-plugin/plugin.json`. Alles andere ist Konvention:

```
my-stack/
├── .cursor-plugin/
│   └── plugin.json     # manifest
├── skills/             # subdirs with SKILL.md
├── rules/              # .mdc rule files
├── commands/           # slash commands
├── hooks/hooks.json
└── mcp.json            # MCP server definitions
```

Das Manifest verlangt nur `name` (kebab-case in Kleinbuchstaben). Jeder Komponentenpfad ist optional, und wenn Sie ihn weglassen, erkennt Cursor die Standardordner oben automatisch:

```json
{
  "name": "enterprise-plugin",
  "version": "1.2.0",
  "description": "Security scanning and compliance checks",
  "author": { "name": "ACME DevTools", "email": "devtools@acme.com" },
  "keywords": ["enterprise", "security", "compliance"],
  "rules": "rules/",
  "skills": "skills/",
  "commands": "commands/",
  "hooks": "hooks/hooks.json",
  "mcpServers": "mcp.json"
}
```

Die MCP-Server verwenden dieselbe Form, die Sie bereits von Cursor und Claude Desktop kennen, sodass bestehende Konfigurationen direkt passen:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "POSTGRES_CONNECTION_STRING": "${POSTGRES_URL}" }
    }
  }
}
```

Auch die Hooks gehören ins Bündel. Ein Plugin kann nach jeder Bearbeitung einen Formatierungsdurchlauf erzwingen oder gefährliche Shell-Aufrufe blockieren, ohne dass jemand die lokalen Einstellungen bearbeitet:

```json
{
  "hooks": {
    "afterFileEdit": [{ "command": "./scripts/format-code.sh" }],
    "beforeShellExecution": [
      { "command": "./scripts/validate-shell.sh", "matcher": "rm|curl|wget" }
    ]
  }
}
```

## Die Verteilung ist die eigentliche Funktion

Die Customize-Seite zeigt eine Bestenliste der meistgenutzten Plugins, Skills und MCP in Ihrem Team, und jedes davon lässt sich mit einem Klick installieren. Team-Marktplätze importieren nun Plugin-Repositories aus GitLab, BitBucket oder Azure DevOps, nicht nur aus GitHub, sodass eine unternehmensinterne Registry keine Anbieterwahl mehr erzwingt. Plugins können außerdem vorgefertigte Canvases mitbringen, geteilte Konfigurationsvorlagen, die eine Kollegin öffnet und wiederverwendet, mit den Hex- und Atlassian-Canvases als ersten Beispielen.

Das Muster spiegelt wider, wohin sich Claude Code und das breitere Agenten-Tooling bewegen: Die Wiederverwendungseinheit ist nicht mehr eine einzelne Regeldatei, sondern ein portables Bündel, das kodiert, wie Ihr Team das Verhalten des Agenten haben möchte. Wer MCP-Blöcke und `.mdc`-Regeln zwischen Rechnern hin- und herkopiert hat, fixiert sie in einem Plugin und hört damit auf.

Die vollständige Feldliste finden Sie in der [Plugin-Referenz](https://cursor.com/docs/reference/plugins) und im [3.9-Changelog](https://cursor.com/changelog).
