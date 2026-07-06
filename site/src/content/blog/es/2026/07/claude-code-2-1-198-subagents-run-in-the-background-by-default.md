---
title: "Claude Code 2.1.198 ejecuta los subagentes en segundo plano de forma predeterminada"
description: "Claude Code v2.1.198 (2026-07-01) cambia los subagentes a ejecución en segundo plano de forma predeterminada, de modo que el agente principal sigue trabajando mientras se ejecutan, y los agentes en segundo plano que tocan código ahora hacen commit, push y abren un draft PR automáticamente cuando terminan."
pubDate: 2026-07-06
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "es"
translationOf: "2026/07/claude-code-2-1-198-subagents-run-in-the-background-by-default"
translatedBy: "claude"
translationDate: 2026-07-06
---

Claude Code v2.1.198 salió el 2026-07-01 y cambia el modelo de ejecución predeterminado de los subagentes. Hasta ahora, lanzar un subagente (la herramienta Task, agentes personalizados, equipos de agentes) bloqueaba el bucle principal: delegabas una parte del trabajo, el agente padre quedaba en silencio y esperabas a que el hijo regresara antes de que se moviera cualquier otra cosa. A partir de 2.1.198, los subagentes se ejecutan en segundo plano de forma predeterminada y el agente principal sigue trabajando mientras se ejecutan.

## Por qué bloquear era el valor predeterminado equivocado

El propósito de un subagente es el aislamiento. Le entregas un trabajo autónomo (recorrer un directorio, verificar una afirmación, redactar una migración) con su propia ventana de contexto para que el padre no se ahogue en volcados de archivos. Pero si lanzar uno congela al padre hasta que termina, pierdes la otra mitad del beneficio: el paralelismo. Dos búsquedas independientes que podrían haberse ejecutado a la vez se ejecutaban una tras otra, y el costo en tiempo real era la suma, no el máximo.

Ejecutar en segundo plano de forma predeterminada corrige eso. El padre reparte el trabajo y continúa en el hilo principal. Cuando un hijo termina, su resultado vuelve como una notificación sobre la que puedes actuar, en lugar de una barrera detrás de la cual esperabas. Para cualquier cosa descomponible, esta es la diferencia entre una tubería y una cola.

## Agentes en segundo plano que terminan el trabajo

La segunda mitad de la versión es lo que hacen los agentes en segundo plano cuando terminan. Si un agente en segundo plano hizo trabajo de código en un git worktree, ya no se detiene a preguntar qué hacer con el diff. Hace commit, push y abre un draft PR automáticamente, y luego reporta de vuelta.

Ese es un cambio real en el flujo de trabajo. El bucle antiguo era: lanzar el agente, esperar, revisar sus cambios propuestos, y luego hacer commit y push tú mismo. El bucle nuevo es: lanzar el agente, seguir trabajando y encontrar un draft PR esperando revisión cuando aterrice. El estado de borrador es la barrera de seguridad: nada se fusiona por su cuenta, pero la plomería entre "el agente terminó" y "puedo revisar un PR real" ha desaparecido.

```bash
# Before 2.1.198: foreground subagent, main loop blocks until it returns.
# You then stage and push its changes by hand.

# 2.1.198+: subagent runs in the background, you keep working, and a
# code-writing background agent lands its work as a draft PR itself:
#   [background] agent "refactor-auth" finished
#   -> committed, pushed branch agent/refactor-auth, opened draft PR #482
```

Como el valor predeterminado cambió, conviene volver a leer cualquier automatización o documentación que asumía que los subagentes eran síncronos. Los pasos que dependían implícitamente de que un subagente terminara antes de que se ejecutara la siguiente línea ahora necesitan esperar el resultado de forma explícita.

## El resto de 2.1.198

Otros dos elementos vienen en la misma versión. Claude in Chrome ya está disponible de forma general, lo que saca las herramientas de manejo del navegador de la fase preliminar. Y hay una nueva skill `/dataviz` para crear gráficos y paneles. La versión también refuerza la resiliencia de red ante errores transitorios y corrige un lote de errores de tareas en segundo plano, equipos de agentes y Remote Control, el mismo empuje de fiabilidad que continuó en las [correcciones de sesiones en segundo plano de 2.1.200](/es/2026/07/claude-code-2-1-200-renames-default-permission-mode-to-manual/).

Si te apoyas en los subagentes aunque sea un poco, el titular es pequeño de enunciar y grande en la práctica: ya no te hacen esperar. Las notas completas están en el [changelog de Claude Code](https://code.claude.com/docs/en/changelog).
