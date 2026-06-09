---
title: "Claude Code 2.1.169 agrega --safe-mode y un /cd que mantiene la caché de prompts caliente"
description: "Claude Code v2.1.169 (8 de junio de 2026) incorpora una opción --safe-mode que desactiva todas las personalizaciones para depurar con limpieza, y un comando /cd que mueve tu sesión a un nuevo directorio sin romper la caché de prompts a mitad de ejecución."
pubDate: 2026-06-09
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "es"
translationOf: "2026/06/claude-code-2-1-169-safe-mode-and-cd"
translatedBy: "claude"
translationDate: 2026-06-09
---

Claude Code v2.1.169 llegó el 8 de junio de 2026 con dos cambios que atacan los dos momentos más molestos de una sesión larga de agente: la espiral de depuración "¿es mi configuración o la herramienta?" y el reinicio de la caché de prompts que pagas cada vez que necesitas trabajar en un directorio distinto. Ambos son opciones pequeñas. Ambos eliminan un costo real.

## `--safe-mode` te da una base limpia contra la cual hacer bisección

Cuando Claude Code empieza a comportarse de forma extraña, un hook se dispara cuando no debería, un servidor MCP se cuelga al iniciar, una skill secuestra un comando de barra, la pregunta difícil es si el error está en el CLI o en tu propia pila de personalizaciones. Hasta ahora, responder eso significaba mover `CLAUDE.md` a un lado de forma manual, comentar los hooks en `settings.json` y desactivar plugins uno por uno.

v2.1.169 colapsa todo eso en una sola opción:

```bash
# Start with CLAUDE.md, plugins, skills, hooks, and MCP servers all disabled
claude --safe-mode

# Same thing via env var, handy in CI or a wrapper script
CLAUDE_CODE_SAFE_MODE=1 claude
```

Si el problema desaparece en modo seguro, es tuyo, y puedes reactivar las personalizaciones grupo por grupo hasta que vuelva a aparecer. Si persiste, es del CLI, y tienes una reproducción limpia para reportar. Este es el equivalente, en un CLI de agente, a arrancar Windows en modo seguro o lanzar un editor con `--disable-extensions`: no es una solución, sino el camino más rápido a un veredicto.

## `/cd` mueve la sesión sin reiniciar la caché

El otro cambio es más sutil y ahorra dinero real en ejecuciones largas. Claude Code almacena en caché el prefijo de la conversación con la caché de prompts de Anthropic, que tiene un TTL corto y es lo que mantiene los turnos siguientes rápidos y baratos. Cambiar tu directorio de trabajo solía implicar salir y relanzar, lo que descartaba esa caché. El siguiente turno releía todo tu contexto sin caché: más lento, y facturado a la tarifa completa de `cache_creation` en lugar de la tarifa barata de lectura de caché.

El nuevo comando `/cd` mueve una sesión activa a un nuevo directorio en el sitio:

```text
# Working in the API project, now need to touch the shared library
/cd ../shared-lib

# Absolute paths work too
/cd C:\S\start-debugging\site
```

La sesión conserva su historial y su caché caliente, así que el turno justo después de `/cd` sigue siendo un acierto de caché. En una tarea multirepo donde rebotas entre un árbol de backend y uno de frontend, esta es la diferencia entre pagar por un contexto en caché y volver a pagarlo en cada cambio de directorio.

## Una tercera perilla que vale la pena conocer

La misma versión agrega `disableBundledSkills` (y `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`), que oculta al modelo las skills, los workflows y los comandos de barra integrados de Claude Code. Si tienes tu propio conjunto con criterio y los integrados te estorban, ese es tu interruptor de apagado.

Esto continúa el patrón de las [correcciones de plugins y worktree de v2.1.128](/es/2026/05/claude-code-2-1-128-plugin-zip-worktree-fix/): cambios poco vistosos en el CLI que quitan una clase de molestia del bucle diario. Las notas completas están en la [página de la versión v2.1.169](https://github.com/anthropics/claude-code/releases/tag/v2.1.169).
