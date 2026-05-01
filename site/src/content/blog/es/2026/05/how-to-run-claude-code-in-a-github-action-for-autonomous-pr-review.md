---
title: "Cómo ejecutar Claude Code en una GitHub Action para revisión autónoma de PR"
description: "Configura anthropics/claude-code-action@v1 para que cada pull request reciba una revisión autónoma de Claude Code sin necesidad de un disparador @claude. Incluye el YAML de v1, claude_args para claude-sonnet-4-6 vs claude-opus-4-7, herramientas para comentarios en línea, filtros de ruta, REVIEW.md y la elección entre la action autoalojada y la versión preliminar de investigación de Code Review gestionada."
pubDate: 2026-05-01
tags:
  - "claude-code"
  - "ai-agents"
  - "github-actions"
  - "automation"
  - "anthropic-sdk"
lang: "es"
translationOf: "2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review"
translatedBy: "claude"
translationDate: 2026-05-01
---

Se abre un pull request, GitHub Actions despierta, Claude Code lee el diff en el contexto del resto del repositorio, publica comentarios en línea sobre las líneas que no le gustan y escribe un resumen. Ningún humano escribió `@claude`. Ese es el flujo que este artículo configura de extremo a extremo con `anthropics/claude-code-action@v1` (la versión GA publicada el 26 de agosto de 2025), `claude-sonnet-4-6` para la pasada de revisión y una actualización opcional a `claude-opus-4-7` para rutas sensibles a la seguridad. A mayo de 2026 hay dos formas de hacer esto y no son intercambiables, así que el artículo empieza con la elección y luego recorre la ruta de la Action autoalojada que funciona en cualquier plan.

La respuesta corta: usa `anthropics/claude-code-action@v1` disparada en `pull_request: [opened, synchronize]` con un prompt y `--allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"`. Omite el filtrado por mención `@claude`. Si tu organización tiene un plan Team o Enterprise y no usa Zero Data Retention, la [versión preliminar de investigación de Code Review gestionada](https://code.claude.com/docs/en/code-review) es la alternativa de menor fricción para el mismo trabajo.

## Dos primitivas, dos modelos de costo, una decisión

Anthropic ofrece dos productos separados de "Claude revisa tu PR" en 2026. Se ven similares desde fuera y se comportan de forma muy distinta:

| Capacidad                        | claude-code-action@v1                   | Code Review gestionado (preview)              |
| :------------------------------- | :-------------------------------------- | :----------------------------------------- |
| Dónde se ejecuta                 | Tus runners de GitHub Actions           | Infraestructura de Anthropic               |
| Qué configuras                   | Un workflow YAML en `.github/workflows/` | Toggle en `claude.ai/admin-settings`       |
| Superficie de disparadores       | Cualquier evento de GitHub que puedas escribir | Desplegable por repo: opened, cada push, manual |
| Modelo                           | `--model claude-sonnet-4-6` o cualquier ID | Flota multiagente, modelo no seleccionable |
| Comentarios en línea sobre líneas del diff | Vía el servidor MCP `mcp__github_inline_comment` | Nativos, con marcadores de severidad       |
| Costo                            | Tokens de API más tus minutos de Actions | $15-25 por revisión, facturado como uso extra |
| Requisito de plan                | Cualquier plan con una API key          | Team o Enterprise, solo no-ZDR             |
| Disponible en Bedrock / Vertex   | Sí (`use_bedrock: true`, `use_vertex: true`) | No                                       |
| Prompt personalizado             | Texto libre en la entrada `prompt`      | `CLAUDE.md` más `REVIEW.md`                |

El producto gestionado es la respuesta correcta cuando está disponible para ti. Ejecuta una flota de agentes especializados en paralelo y corre un paso de verificación antes de publicar un hallazgo, lo que mantiene los falsos positivos bajos. La contrapartida es que no puedes fijar un modelo, y el precio escala con el tamaño del PR de manera que una revisión de $25 sobre una refactorización de 2000 líneas puede impactar a un manager que esperaba facturación por tasa de tokens.

La Action es la respuesta correcta cuando quieres control total del prompt, quieres usar Bedrock o Vertex por residencia de datos, quieres filtrar por rutas o nombres de rama, o no estás en un plan Team o Enterprise. Todo lo que sigue es la ruta de la Action.

## El workflow mínimo viable de revisión autónoma

Empieza en cualquier repo donde seas admin. Desde una terminal con [Claude Code 2.x](https://code.claude.com/docs/en/setup) instalado:

```text
# Claude Code 2.x
claude
/install-github-app
```

El comando slash te guía por la instalación de la [Claude GitHub App](https://github.com/apps/claude) en el repo y por el almacenamiento de `ANTHROPIC_API_KEY` como secreto del repo. Solo funciona para usuarios directos de la API de Anthropic. Para Bedrock o Vertex configuras OIDC a mano, lo que la [documentación de GitHub Actions](https://code.claude.com/docs/en/github-actions) cubre bajo "Using with AWS Bedrock & Google Vertex AI."

Coloca esto en `.github/workflows/claude-review.yml`:

```yaml
# claude-code-action v1 (GA Aug 26, 2025), Claude Code 2.x
name: Claude Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 1

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            REPO: ${{ github.repository }}
            PR NUMBER: ${{ github.event.pull_request.number }}

            Review the diff for correctness, security, and obvious bugs.
            Focus on logic errors, unhandled error paths, missing input
            validation, and tests that do not actually exercise the new
            behavior. Skip style nits. Post inline comments on the lines
            you have something concrete to say about, then a one-paragraph
            summary as a top-level PR comment.

          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 8
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

Eso es todo. Sin filtrado por disparador `@claude`, sin condicional `if:` sobre el cuerpo del comentario, sin `mode: agent`. La [versión v1](https://code.claude.com/docs/en/github-actions) de la Action detecta automáticamente el modo de automatización siempre que proporciones una entrada `prompt` en un evento que no sea de comentario, así que ya no escribes el condicional tú. El bloque `permissions` otorga exactamente lo que necesita el prompt: leer el repo, escribir comentarios de PR y (para OIDC contra proveedores cloud) emitir un token de identidad.

Hay algunas cosas en este YAML que importan y son fáciles de equivocar.

`actions/checkout@v6` con `fetch-depth: 1`. La Action lee el diff del PR vía `gh`, pero el prompt también le permite abrir archivos en el directorio de trabajo para verificar un hallazgo antes de publicarlo. Sin checkout, cada turno de "mira el código alrededor" falla y Claude o adivina o se queda sin tiempo.

`--allowedTools "mcp__github_inline_comment__create_inline_comment,..."`. La Action incluye un servidor MCP que envuelve la API de revisión de GitHub. Sin esta lista permitida, Claude no tiene forma de adjuntar un comentario a una línea específica. Recurrirá a un solo comentario grande de nivel superior en el PR, lo que es la mitad del valor. Las entradas `Bash(gh pr ...)` están delimitadas a leer el diff y publicar el comentario de resumen.

`--max-turns 8`. Presupuesto de conversación. Ocho son suficientes para que el modelo lea el diff, abra tres o cuatro archivos por contexto y publique comentarios. Subirlo más rara vez es la victoria que parece; si las revisiones están agotando el tiempo, restringe el filtro de rutas o cambia el modelo, no gastes más turnos.

## v1 rompió muchos workflows beta

Si vienes de `claude-code-action@beta`, tu YAML antiguo no se ejecuta. La [tabla de cambios incompatibles](https://code.claude.com/docs/en/github-actions#breaking-changes-reference) de v1 es la chuleta de migración:

| Entrada beta          | Equivalente en v1                      |
| :-------------------- | :------------------------------------- |
| `mode: tag` / `agent` | Eliminado, se autodetecta del evento   |
| `direct_prompt`       | `prompt`                               |
| `override_prompt`     | `prompt` con variables de GitHub       |
| `custom_instructions` | `claude_args: --append-system-prompt`  |
| `max_turns: "10"`     | `claude_args: --max-turns 10`          |
| `model: ...`          | `claude_args: --model ...`             |
| `allowed_tools: ...`  | `claude_args: --allowedTools ...`      |
| `claude_env: ...`     | Formato JSON `settings`                |

El patrón es claro: cada ajuste en forma de CLI se colapsa en `claude_args`, y todo lo que servía para desambiguar "¿esto es el flujo de disparador por comentario o el flujo de automatización?" se quitó porque v1 lo deduce del evento. La migración es mecánica, pero el orden importa. Si dejas `mode: tag` en su lugar, v1 falla de forma cerrada con un error de configuración en lugar de ejecutar silenciosamente la ruta equivocada.

## Elegir el modelo: Sonnet 4.6 es el predeterminado por una razón

La Action usa `claude-sonnet-4-6` por defecto cuando `--model` no está configurado, y ese es el predeterminado correcto para revisión de PR. Sonnet 4.6 es más rápido, más barato por token y está bien calibrado para el bucle de "escanea un diff, encuentra los bugs obvios" que la revisión de PR realmente es. Opus 4.7 es la actualización a la que recurres cuando el diff toca autenticación, cifrado, flujos de pago, o cualquier cosa donde un bug pasado por alto cuesta más que una revisión de $5.

El patrón más limpio son dos workflows. Sonnet 4.6 en cada PR, Opus 4.7 solo cuando el filtro de rutas dice que vale la pena el gasto:

```yaml
# Opus 4.7 review for security-critical paths only
on:
  pull_request:
    types: [opened, synchronize]
    paths:
      - "src/auth/**"
      - "src/billing/**"
      - "src/api/middleware/**"

jobs:
  review-opus:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 1 }

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Treat this diff as security-sensitive. Flag any changes to
            authentication, session handling, secret storage, or trust
            boundaries. Cite a file:line for every claim about behavior,
            do not infer from naming.
          claude_args: |
            --model claude-opus-4-7
            --max-turns 12
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr diff:*),Bash(gh pr view:*),Bash(gh pr comment:*)"
```

El mismo truco funciona al revés: filtra el workflow de Sonnet con `paths-ignore: ["docs/**", "*.md", "src/gen/**"]` para que los PRs solo de docs no consuman tokens.

## Añadir comentarios en línea y seguimiento de progreso

El servidor MCP `mcp__github_inline_comment__create_inline_comment` es la pieza que lleva a Claude de "escribe un comentario largo de PR" a "deja sugerencias en líneas específicas del diff". Se permite mediante `--allowedTools` y eso es todo el cableado necesario. El modelo decide cuándo invocarlo.

Para revisiones más grandes donde quieres una señal visible de que la ejecución está viva, la Action incluye una entrada `track_progress`. Configura `track_progress: true` y la Action publica un comentario de seguimiento con casillas, las marca a medida que Claude completa cada parte de la revisión y marca como hecho al final. El patrón completo del [ejemplo oficial `pr-review-comprehensive.yml`](https://github.com/anthropics/claude-code-action/tree/main/examples) es:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    track_progress: true
    prompt: |
      REPO: ${{ github.repository }}
      PR NUMBER: ${{ github.event.pull_request.number }}

      Comprehensive review covering: code quality, security, performance,
      test coverage, documentation. Inline comments for specific issues,
      one top-level summary at the end.
    claude_args: |
      --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

`track_progress` es lo más cercano que tiene v1 a la antigua experiencia de usuario `mode: agent` de la beta, y es la elección correcta cuando las revisiones rutinariamente llevan más de un minuto o dos y el autor del PR quiere saber que está corriendo.

## Calibrar lo que el revisor señala

Un workflow que comenta cada nombre de variable y cada coma faltante será silenciado en una semana. Dos archivos en la raíz del repo gobiernan lo que el modelo se toma en serio: `CLAUDE.md` para el comportamiento general, y (solo para la versión preliminar gestionada de Code Review) `REVIEW.md` para reglas específicas de revisión. La Action no carga automáticamente `REVIEW.md`, pero lee `CLAUDE.md` igual que una sesión local de Claude Code, y un `CLAUDE.md` ajustado más un `prompt` ajustado cubren el mismo terreno.

Las reglas que realmente mueven la calidad de la revisión son concretas, específicas del repo y cortas:

```markdown
# CLAUDE.md (excerpt)

## What "important" means here
Reserve "important" for findings that would break behavior in
production, leak data, or block a rollback: incorrect logic,
unscoped database queries, PII in logs, migrations that are not
backward compatible. Style and naming are nits at most.

## Cap the nits
Report at most five nits per review. If you found more, say
"plus N similar items" in the summary.

## Do not report
- Anything CI already enforces (lint, format, type errors)
- Generated files under `src/gen/` and any `*.lock`
- Test-only code that intentionally violates production rules

## Always check
- New API routes have an integration test
- Log lines do not include user IDs or request bodies
- Database queries are scoped to the caller's tenant
```

Pegar más o menos este contenido en la entrada `prompt` también funciona y tiene la ventaja de que las reglas se versionan junto con el archivo del workflow. De cualquier manera, la palanca que importa es "decir no al volumen de nimiedades en voz alta", porque la voz de revisión predeterminada de Sonnet es más exhaustiva de lo que la mayoría de los equipos quiere.

## Forks, secretos y la trampa de `pull_request_target`

El evento por defecto `on: pull_request` se ejecuta en el contexto de la rama head del PR. Para PRs desde forks, eso significa que el workflow se ejecuta sin acceso a los secretos del repo, incluyendo `ANTHROPIC_API_KEY`. La solución que parece obvia es cambiar a `pull_request_target`, que se ejecuta en el contexto de la rama base y tiene acceso a los secretos. No hagas esto para revisión autónoma de Claude, porque `pull_request_target` hace checkout del código de la rama base por defecto y eso significa que estás revisando el árbol equivocado, y si cambias el checkout para obtener la ref head estás ejecutando herramientas guiadas por el modelo contra código controlado por un atacante con secretos en el alcance.

Los patrones soportables son: dejar `on: pull_request` y aceptar que los PRs de forks no se revisan (usa la versión preliminar gestionada de Code Review si necesitas cubrirlos), o ejecutar un workflow manual que los mantenedores disparan en un PR de fork tras haber inspeccionado el diff. La [guía de seguridad](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md) completa vale la pena leerla una vez antes de implementar esto en cualquier sitio fuera de un repo privado.

## Cuándo recurrir a Bedrock o Vertex en su lugar

Si tu organización pasa por AWS Bedrock o Google Vertex AI, la Action soporta ambos con `use_bedrock: true` o `use_vertex: true` más un paso autenticado por OIDC antes de que la Action se ejecute. El formato del ID de modelo cambia (Bedrock usa la forma con prefijo regional, por ejemplo `us.anthropic.claude-sonnet-4-6`), y la documentación de proveedores cloud guía la configuración de IAM y Workload Identity Federation. Los patrones de disparador y prompt mostrados arriba no cambian. El mismo enfoque está documentado para Microsoft Foundry. El único producto gestionado por Anthropic que no soporta estas rutas es la versión preliminar de investigación de Code Review, lo que es una de las razones por las que la Action autoalojada sigue siendo útil incluso después de que la versión preliminar gestionada llegue a GA.

## Relacionados

- [Cómo programar una tarea recurrente de Claude Code que clasifica issues de GitHub](/es/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)
- [Cómo construir un servidor MCP personalizado en TypeScript que envuelve una CLI](/es/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/)
- [Cómo añadir prompt caching a una app del SDK de Anthropic y medir la tasa de aciertos](/es/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/)
- [Claude Code 2.1.119: revisar pull requests desde GitLab y Bitbucket](/es/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/)
- [El agente de codificación de GitHub Copilot en dotnet/runtime: diez meses de datos](/es/2026/03/copilot-coding-agent-dotnet-runtime-ten-months-data/)

## Fuentes

- [Documentación de Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions)
- [Documentación de Claude Code Code Review (versión preliminar de investigación)](https://code.claude.com/docs/en/code-review)
- [`anthropics/claude-code-action` en GitHub](https://github.com/anthropics/claude-code-action)
- [Ejemplo `pr-review-comprehensive.yml`](https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-comprehensive.yml)
- [Ejemplo `pr-review-filtered-paths.yml`](https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-filtered-paths.yml)
