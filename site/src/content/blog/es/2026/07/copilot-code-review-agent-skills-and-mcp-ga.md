---
title: "La revisión de código de Copilot ahora lee tu carpeta .github/skills"
description: "Las agent skills y los servidores MCP en la revisión de código de GitHub Copilot llegaron a GA el 2026-07-29. Aquí está dónde viven los archivos, por qué las skills se cargan desde la rama head y por qué toda llamada a una herramienta MCP en una revisión es de solo lectura."
pubDate: 2026-07-31
tags:
  - "github-copilot"
  - "agent-skills"
  - "mcp"
  - "code-review"
  - "ai-agents"
lang: "es"
translationOf: "2026/07/copilot-code-review-agent-skills-and-mcp-ga"
translatedBy: "claude"
translationDate: 2026-07-31
---

El 2026-07-29 GitHub declaró [las agent skills y el soporte de MCP en la revisión de código de Copilot](https://github.blog/changelog/2026-07-29-copilot-code-review-agent-skills-and-mcp-now-generally-available/) como disponibles de forma general para Copilot Pro, Pro+, Business y Enterprise. Hasta ahora el revisor leía tu diff y tus instrucciones personalizadas, y eso era toda la ventana de contexto. Ahora puede incorporar las mismas carpetas de skills que usa tu agente de código, más contexto de solo lectura desde servidores MCP.

Eso cierra la brecha más molesta de la revisión automatizada: el bot podía decirte que faltaba una comprobación de `null`, pero no tenía idea de que tu equipo exige que cada migración de EF Core incluya un `Down()` no vacío, ni forma de averiguar si el issue que cierra este PR ya había sido revertido el sprint pasado.

## Las skills son carpetas, y el revisor las elige solo

Una skill es un directorio dentro de `.github/skills` con un `SKILL.md` adentro. Copilot compara la tarea con la `description` de cada skill y carga solo lo que parece relevante, así que una skill orientada a revisión necesita un nombre de directorio y una descripción que suenen a trabajo de revisión.

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

El detalle que vale la pena conocer: la revisión de código de Copilot lee las instrucciones y las skills desde la **rama head**, no desde la rama base. Edita una skill y abre un PR, y ese mismo PR será revisado con la skill editada. Puedes iterar sobre las reglas de revisión sin fusionarlas primero, que es lo contrario a como se comporta la mayoría de la configuración de linters en CI.

## MCP viene activado por defecto, y es de solo lectura por diseño

Los servidores MCP para la revisión se configuran en la configuración del repositorio, en Copilot > MCP servers, usando el mismo JSON que consume el agente en la nube. Los servidores de GitHub y de Playwright ya vienen habilitados.

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

Los tokens van en la configuración del repositorio, en Secrets and variables > Agents, y se referencian como `$COPILOT_MCP_*`. Toda llamada a una herramienta MCP hecha durante una revisión está limitada a solo lectura, que es la decisión correcta: un revisor que puede escribir en tu issue tracker es un revisor al que se puede atacar por inyección de prompts desde el cuerpo de un pull request. Ten en cuenta que `"tools": ["*"]` sigue siendo aceptado, y la propia recomendación de GitHub es incluir en la lista permitida herramientas específicas, porque el agente las usa de forma autónoma y sin paso de aprobación.

Si prefieres mantener MCP acotado únicamente al agente en la nube, la opción del repositorio "Allow Copilot to use MCP tools when reviewing pull requests" está activada por defecto y se puede desactivar. Los comentarios de revisión que se apoyaron en una skill o en una herramienta MCP ahora llevan atribución, así que puedes ver qué regla produjo cada observación.

Si tu repositorio todavía tiene una carpeta `.github/prompts/`, este es el empujón para terminar de [migrar esos prompt files a agent skills](/2026/07/migrate-copilot-prompt-files-to-agent-skills/): el mismo `SKILL.md` ahora alimenta al IDE, al agente en la nube y al revisor.
