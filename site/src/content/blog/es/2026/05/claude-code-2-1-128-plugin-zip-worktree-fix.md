---
title: "Claude Code 2.1.128 carga plugins desde archivos .zip y deja de descartar commits no enviados"
description: "Claude Code v2.1.128 (4 de mayo de 2026) agrega soporte de --plugin-dir para archivos .zip, hace que EnterWorktree cree la rama desde el HEAD local y evita que el CLI filtre su propio endpoint OTLP a los subprocesos de Bash."
pubDate: 2026-05-05
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "es"
translationOf: "2026/05/claude-code-2-1-128-plugin-zip-worktree-fix"
translatedBy: "claude"
translationDate: 2026-05-05
---

Claude Code v2.1.128 llegó el 4 de mayo de 2026 con tres cambios que solucionan silenciosamente problemas de flujo de trabajo que muchos sufrimos sin darnos cuenta: los plugins ahora se pueden cargar directamente desde un `.zip`, `EnterWorktree` por fin crea la rama desde `HEAD` local en lugar de `origin/<default>`, y los subprocesos ya no heredan las variables de entorno `OTEL_*` del propio CLI. Ninguno es llamativo, pero todos eliminan toda una clase de "espera, ¿por qué pasó eso?".

## `--plugin-dir` ahora acepta archivos comprimidos de plugins

Hasta v2.1.128, `--plugin-dir` solo aceptaba un directorio. Si querías compartir un plugin interno con un colega o fijar una versión, tenías que subirlo a un marketplace, comprometer el árbol descomprimido en el repositorio o escribir un script wrapper que descomprimiera antes de iniciar. Nada de eso escalaba más allá de uno o dos plugins.

El nuevo comportamiento es exactamente lo que esperas:

```bash
# Old: had to point at an unpacked directory
claude --plugin-dir ./plugins/my-team-tooling

# New in v2.1.128: zip works directly
claude --plugin-dir ./plugins/my-team-tooling-1.4.0.zip

# Mix and match in the same launch
claude \
  --plugin-dir ./plugins/local-dev \
  --plugin-dir ./dist/release-bundle.zip
```

También hay una corrección en esta versión que combina con esto. El panel `/plugin` Components solía mostrar "Marketplace 'inline' not found" para plugins cargados vía `--plugin-dir`. v2.1.128 lo detiene. Y el JSON `init.plugin_errors` del modo headless ahora reporta fallos de carga de `--plugin-dir` (zip corrupto, manifest faltante) junto con los errores existentes de degradación de dependencias, así los scripts de CI pueden fallar ruidosamente en lugar de enviar silenciosamente un conjunto de plugins roto.

## `EnterWorktree` ya no descarta tus commits no enviados

Esta es una corrección de bug real disfrazada de cambio de comportamiento. `EnterWorktree` es la herramienta que Claude Code usa para crear un worktree aislado para una tarea de un agente. Antes de esta versión, la nueva rama se creaba desde `origin/<default-branch>`, lo que suena razonable hasta que te das cuenta de lo que significa: cualquier commit que tuvieras local en `main` pero que aún no hubieras enviado simplemente no formaba parte del worktree que veía el agente.

En v2.1.128, `EnterWorktree` crea la rama desde `HEAD` local, que es lo que la documentación ya afirmaba. Concretamente:

```bash
# You're on main with a local-only commit
git log --oneline -2
# a1b2c3d feat: WIP rate limiter (NOT pushed)
# 9876543 chore: bump deps (origin/main)

# Agent calls EnterWorktree
# v2.1.126 and earlier: branch starts at 9876543, your WIP commit is GONE
# v2.1.128: branch starts at a1b2c3d, the agent sees your WIP
```

Si alguna vez una tarea larga de un agente saltó silenciosamente el cambio que hiciste hace cinco minutos, probablemente fue por esto.

## Las variables de entorno OTEL ya no se filtran a los subprocesos

El propio Claude Code está instrumentado con OpenTelemetry y lee `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` y compañía desde el entorno. Hasta v2.1.128 esas variables eran heredadas por cada subproceso que lanzaba el CLI: llamadas de la herramienta Bash, hooks, servidores MCP, procesos LSP. Si ejecutabas una aplicación .NET vía la herramienta Bash que también estaba instrumentada con OTel, alegremente enviaba sus trazas al recolector del CLI.

La corrección en v2.1.128 elimina `OTEL_*` del entorno antes del exec. Tus aplicaciones ahora usan el endpoint OTLP con el que fueron configuradas, no el que tu editor casualmente reporta. Si genuinamente quieres que un proceso hijo comparta el recolector del CLI, define la variable explícitamente en tu script de ejecución.

Algunos otros elementos notables: el `/color` simple ahora elige un color de sesión aleatorio, `/mcp` muestra la cuenta de herramientas por servidor y marca los que se conectaron con cero herramientas, las llamadas paralelas a herramientas de shell ya no cancelan llamadas hermanas cuando un comando de solo lectura (`grep`, `git diff`) falla, y los resúmenes de progreso de subagentes por fin alcanzan la caché de prompts para aproximadamente 3x menor costo de `cache_creation` en ejecuciones multi-agente cargadas. El modo Vim también recibió una pequeña pero correcta corrección: `Space` en modo NORMAL mueve el cursor a la derecha, igualando el comportamiento real de vi.

Esto continúa la tendencia que inició la [versión v2.1.126 con project purge](/es/2026/05/claude-code-2-1-126-project-purge/): cambios pequeños y dirigidos al CLI que quitan instrumentos contundentes de las manos del usuario. Las notas completas están en la [página de la versión v2.1.128](https://github.com/anthropics/claude-code/releases/tag/v2.1.128).
