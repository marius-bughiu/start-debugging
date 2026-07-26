---
title: "Claude Code 2.1.219 reabre los subagentes anidados, hasta tres capas"
description: "La versión 2.1.219 sube la profundidad de generación de subagentes por defecto de 1 a 3, agrega la clave de configuración workflowSizeGuideline y trae una lista de dominios permitidos que falla en cerrado."
pubDate: 2026-07-26
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
lang: "es"
translationOf: "2026/07/claude-code-2-1-219-nested-subagents-three-layers-deep"
translatedBy: "claude"
translationDate: 2026-07-26
---

Las últimas dos semanas de versiones de Claude Code fueron un tira y afloja sobre cuánta cuerda se le da a una flota de agentes. La versión 2.1.213 quitó el anidamiento por completo. La versión 2.1.219, que llegó el 2026-07-24, lo devuelve con un número puesto: los subagentes ahora pueden generar sus propios subagentes hasta una profundidad de 3 por defecto, frente a 1.

## El valor por defecto cambió dos veces en dos semanas

La línea del [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) es directa: "los subagentes ahora pueden generar subagentes anidados hasta una profundidad de 3 por defecto (antes 1); usa CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1 para desactivar el anidamiento".

Vale la pena seguir la historia, porque el comportamiento se movió tres veces. Desde la v2.1.172 hasta la v2.1.216, los subagentes se anidaban hasta cinco capas y el límite no era configurable. Luego 2.1.213 [puso límites estrictos a las flotas de subagentes descontroladas](/es/2026/07/claude-code-2-1-213-caps-runaway-subagent-fleets/) y bajó el valor por defecto a profundidad 1, es decir, un subagente no podía delegar en absoluto: le pedías levantar ayudantes y hacía el trabajo él mismo. La 2.1.219 se queda en 3.

La perilla no cambió, solo su valor por defecto. Para volver a la delegación plana de una sola capa, fíjalo en `settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1"
  }
}
```

La profundidad 3 es un número deliberado, no uno redondo. Es exactamente lo que necesita un despliegue de revisión: tu conversación principal genera un revisor, el revisor genera un verificador por hallazgo, y cada verificador todavía puede delegar una búsqueda puntual. Con profundidad 1 esa forma colapsaba en un único subagente que hacía todo en secuencia dentro de una sola ventana de contexto.

## Una guía de tamaño como contrapeso

Reabrir el anidamiento sin un freno solo recrearía el problema que arregló 2.1.213, así que la misma versión agrega uno. Los flujos de trabajo dinámicos ahora usan por defecto una guía de tamaño mediana, apuntando a menos de 15 agentes, y esa guía ya no es solo un interruptor de `/config`. Hay una clave de configuración para ella:

```json
{
  "workflowSizeGuideline": "medium"
}
```

Ponla en cualquier archivo de configuración y la fila de `/config` se oculta sola. La línea de estado del flujo de trabajo en ejecución ahora también imprime el tamaño actual, así que puedes ver bajo qué guía opera un flujo mientras corre. Ten en cuenta que esto es orientativo: moldea cuántos agentes intenta generar el modelo, no es un techo duro. Los techos reales siguen siendo los límites de concurrencia y de subagentes por sesión.

## Listas de dominios permitidos que fallan en cerrado

El otro cambio que vale la pena configurar hoy es `sandbox.network.strictAllowlist`. Por defecto, el sandbox pregunta la primera vez que un comando necesita un dominio que no habías permitido. Los despliegues gestionados ya podían bloquear en lugar de preguntar mediante `allowManagedDomainsOnly`. Ahora cualquier archivo de configuración puede fallar en cerrado:

```json
{
  "sandbox": {
    "enabled": true,
    "network": {
      "strictAllowlist": true,
      "allowedDomains": ["github.com", "*.npmjs.org"]
    }
  }
}
```

Para ejecuciones desatendidas, esta es la configuración que quieres. Una pregunta que nadie responde es un cuelgue, y con el anidamiento de vuelta hay más procesos que pueden toparse con una.

También en 2.1.219: Claude Opus 5 (`claude-opus-5`) es el modelo Opus por defecto, con 1M de contexto y modo rápido a $10/$50 por Mtok, y Opus 4.7 quedó fuera del modo rápido por completo.
