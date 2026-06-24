---
title: "Cursor 3.9 empaqueta la configuración de tu agente en plugins portables"
description: "Cursor 3.9 incorpora un sistema de plugins y una página Customize unificada para que skills, reglas, servidores MCP, comandos y hooks viajen juntos como una unidad versionada."
pubDate: 2026-06-24
tags:
  - "cursor"
  - "ai-agents"
  - "mcp"
lang: "es"
translationOf: "2026/06/cursor-3-9-plugins-bundle-skills-rules-mcps-hooks"
translatedBy: "claude"
translationDate: 2026-06-24
---

Cursor 3.9 llegó el 22 de junio de 2026, y lo más destacado no es un cambio de modelo ni un apply más rápido. Es fontanería: un formato de plugin real más una única página Customize que reúne plugins, skills, MCP, subagentes, reglas, comandos y hooks en una sola pantalla que administras a nivel de usuario, equipo o workspace.

Si has configurado un agente de Cursor para un equipo, sabes por qué esto importa. Las piezas que hacen útil a un agente en tu base de código solían vivir en lugares separados: las reglas en archivos `.mdc`, los servidores MCP en su propia configuración, los comandos en otro sitio, los hooks atornillados al final. Incorporar a un compañero implicaba replicarlo todo a mano. Un plugin convierte ese conjunto en un único artefacto versionado y compartible.

## Qué es realmente un plugin

Un plugin es un directorio con un manifiesto en `.cursor-plugin/plugin.json`. Todo lo demás es convención:

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

El manifiesto solo requiere `name` (kebab-case en minúsculas). Cada ruta de componente es opcional, y si la omites Cursor descubre automáticamente las carpetas predeterminadas de arriba:

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

Los servidores MCP usan la misma forma que ya conoces de Cursor y Claude Desktop, así que las configuraciones existentes encajan directamente:

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

Los hooks también van en el paquete. Un plugin puede forzar un paso de formateo después de cada edición o restringir llamadas peligrosas al shell sin que nadie edite la configuración local:

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

## La distribución es la verdadera característica

La página Customize muestra una tabla de clasificación de los plugins, skills y MCP más usados en tu equipo, y cualquiera de ellos se instala con un clic. Los marketplaces de equipo ahora importan repositorios de plugins desde GitLab, BitBucket o Azure DevOps, no solo GitHub, así que un registro interno de la empresa ya no obliga a elegir un proveedor. Los plugins también pueden llevar canvases prediseñados, plantillas de configuración compartidas que un compañero abre y reutiliza, con los canvases de Hex y Atlassian como primeros ejemplos.

El patrón refleja hacia dónde se dirigen Claude Code y el conjunto más amplio de herramientas para agentes: la unidad de reutilización deja de ser un único archivo de reglas y pasa a ser un paquete portable que codifica cómo quiere tu equipo que se comporte el agente. Si has estado copiando y pegando bloques MCP y reglas `.mdc` entre máquinas, fíjalos en un plugin y deja de hacerlo.

Consulta la [referencia de plugins](https://cursor.com/docs/reference/plugins) y el [changelog de 3.9](https://cursor.com/changelog) para la lista completa de campos.
