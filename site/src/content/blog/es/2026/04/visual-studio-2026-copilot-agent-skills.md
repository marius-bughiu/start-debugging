---
title: "Agent Skills aterrizan en Visual Studio 2026 18.5: Copilot autodescubre SKILL.md desde tu repo"
description: "Visual Studio 2026 18.5.0 deja a GitHub Copilot cargar Agent Skills desde .github/skills, .claude/skills, y ~/.copilot/skills. Packs reutilizables de instrucciones SKILL.md viajan con tu repo."
pubDate: 2026-04-20
tags:
  - "visual-studio"
  - "github-copilot"
  - "agent-skills"
  - "dotnet"
lang: "es"
translationOf: "2026/04/visual-studio-2026-copilot-agent-skills"
translatedBy: "claude"
translationDate: 2026-04-24
---

El release del 14 de abril de 2026 de Visual Studio 2026 (versión 18.5.0) añadió silenciosamente una de las funciones más útiles de Copilot del año: [Agent Skills](https://learn.microsoft.com/en-us/visualstudio/releases/2026/release-notes). Si llevas seis meses copiando y pegando el mismo párrafo "así es como revisamos pull requests en este repo" en Copilot Chat, puedes parar. Los Agent Skills son packs de instrucciones reutilizables que viven junto a tu código, y Copilot en Visual Studio ahora los descubre automáticamente.

## Dónde busca skills Visual Studio

Un skill es solo una carpeta con un archivo `SKILL.md` adentro. Visual Studio 2026 18.5 escanea seis ubicaciones bien conocidas, tres atadas al workspace y tres atadas a tu perfil de usuario:

- Workspace: `.github/skills/`, `.claude/skills/`, `.agents/skills/`
- Personal: `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/`

La duplicación es intencional. La [especificación de agentskills.io](https://agentskills.io/specification) es un formato abierto y las mismas carpetas las leen GitHub Copilot CLI, el agente cloud de Copilot y VS Code. Pon un skill en `.github/skills/` y cada superficie de Copilot que use tu equipo lo verá, no solo el IDE de tu máquina.

## Cómo se ve un SKILL.md de verdad

El archivo es Markdown con un encabezado YAML de frontmatter. El frontmatter tiene dos campos requeridos, `name` y `description`, más algunos opcionales sobre cómo se invoca el skill:

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

El campo `name` debe ser en minúsculas, separado por guiones, máximo 64 caracteres, y debe coincidir con el nombre de la carpeta. El campo `description` es lo que Copilot usa para decidir si carga el skill, así que vale la pena escribirlo como una query de retrieval, no como un tagline. La longitud máxima es 1024 caracteres y deberías usarlos.

## Por qué esto cambia el default

Hasta ahora el patrón habitual era un sprawling `.github/copilot-instructions.md` o un agente custom definido en `.agent.md`. Los Agent Skills son más estrechos por diseño: cada skill es una sola preocupación, cargada bajo demanda, y solo su cuerpo entra en la ventana de contexto cuando la descripción coincide. Para un monorepo .NET con migraciones de EF Core, código de plataforma MAUI y controllers de ASP.NET Core, puedes enviar tres skills separados en lugar de un archivo de instrucciones gigante y dejar de quemar tokens en guidance que es irrelevante para la tarea actual.

Los skills también componen con Custom Agents. Un archivo `.agent.md` puede acotar qué skills jala, que es como los equipos terminan con un agente "backend-reviewer" que solo ve skills de EF Core y ASP.NET Core mientras un agente "mobile-reviewer" ve los de MAUI y Flutter.

Microsoft nota que la UI de browsing y creación todavía está en camino en una update 18.x posterior, así que por ahora son archivos de texto en carpetas. Eso está bien. Los archivos de texto en carpetas son para lo que sirve el control de versiones.
