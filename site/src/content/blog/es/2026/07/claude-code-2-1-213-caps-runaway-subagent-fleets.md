---
title: "Claude Code 2.1.213 pone límites estrictos a las flotas de subagentes descontroladas"
description: "La versión 2.1.213 limita los subagentes concurrentes y detiene por defecto los generados de forma anidada, sobre los límites por sesión de 2.1.212. Estos son los nuevos valores por defecto y variables de entorno."
pubDate: 2026-07-22
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
lang: "es"
translationOf: "2026/07/claude-code-2-1-213-caps-runaway-subagent-fleets"
translatedBy: "claude"
translationDate: 2026-07-22
---

Si alguna vez viste un flujo de trabajo de Claude Code desplegarse, generar subagentes que generan sus propios subagentes y agotar en silencio tu presupuesto mientras ibas por un café, las dos últimas versiones son para ti. Claude Code 2.1.213, lanzado esta semana, agrega un límite de concurrencia a los subagentes y les impide anidarse por defecto. Se apoya directamente en los topes por sesión que llegaron en 2.1.212. Juntos convierten el "esperemos que el bucle termine" en un conjunto de límites explícitos y ajustables.

## Qué cambia 2.1.213

Cambiaron dos comportamientos, y ambos son barreras de seguridad alrededor del trabajo con agentes en paralelo.

Primero, ahora hay un tope de cuántos subagentes se ejecutan a la vez. El valor por defecto es 20. Si un flujo de trabajo intenta lanzar más, los sobrantes se ponen en cola en lugar de dispararse todos a la vez. Lo puedes sobrescribir con una variable de entorno:

```bash
export CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=8
```

Segundo, y más importante, los subagentes ya no generan subagentes anidados por defecto. Antes de 2.1.213, un subagente podía delegar en otro subagente, que podía delegar de nuevo, y la profundidad era prácticamente ilimitada. Así era como un único prompt de nivel superior podía dispararse hasta decenas de sesiones concurrentes. Ahora la profundidad de generación está limitada, y optas por un anidamiento más profundo de forma explícita:

```bash
# Allow subagents to spawn one more level down
export CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2
```

El registro de cambios de 2.1.213 también corrige una brecha relacionada: `--max-budget-usd` no detenía los subagentes en segundo plano. Así que si dependías de un tope en dólares para frenar un trabajo descontrolado, ahora también frena los que están en segundo plano.

## Los topes por sesión de 2.1.212

Los límites de 2.1.213 se apoyan sobre dos topes por sesión de 2.1.212, unas pocas compilaciones después de la [versión 2.1.208](/es/2026/07/claude-code-2-1-208-vim-insert-mode-remaps-jj-to-escape/). Una sola sesión ahora tiene un presupuesto estricto tanto para las generaciones de subagentes como para las búsquedas web, cada uno con un valor por defecto de 200:

```bash
export CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION=50
export CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION=100
```

2.1.212 también sacó de la ruta crítica las llamadas a herramientas MCP de larga duración. Cualquier llamada MCP que se ejecute más de dos minutos pasa ahora a segundo plano de forma automática, por lo que una herramienta lenta ya no bloquea el turno. Puedes ajustar el umbral o desactivar el comportamiento:

```bash
# Background MCP calls after 90 seconds instead of 120
export CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=90000
```

## Por qué importa

Las flotas de agentes son baratas de arrancar y caras de ejecutar. El modo de fallo nunca fue un único subagente, era la recursión: un orquestador generando trabajadores, trabajadores generando ayudantes, y ningún número acotando el total. Valores por defecto de 20 concurrentes, sin anidamiento y 200 generaciones por sesión significan que un prompt que se porta mal ahora choca contra un muro en vez de contra una factura. Si estás creando flujos de trabajo con despliegue en abanico, lee los valores por defecto y luego sube los dos o tres que tu trabajo real realmente necesita, en vez de quitar todos los límites.

Todos los detalles están en el [registro de cambios de Claude Code](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
