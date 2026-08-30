---
title: "PreModelSwitch: Claude Code ya puede vetar un cambio de modelo"
description: "Claude Code 2.1.251 agrega los eventos de hook PreModelSwitch y PostModelSwitch. El matcher se dispara con el nombre canónico del modelo al que cambias, y el código de salida 2 cancela el cambio."
pubDate: 2026-08-30
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
lang: "es"
translationOf: "2026/08/claude-code-premodelswitch-hook-gates-model-changes"
translatedBy: "claude"
translationDate: 2026-08-30
---

Todos los eventos de hook que Claude Code había lanzado antes de esta semana vigilaban algo que hace el modelo: `PreToolUse` ve un comando de Bash antes de que se ejecute, `PermissionRequest` ve la solicitud antes de que la respondas, `PreCompact` ve la transcripción antes de que se resuma. La versión 2.1.251, publicada el 2026-08-28, agregó el primer par que vigila al modelo mismo. `PreModelSwitch` y `PostModelSwitch` se disparan cuando la sesión cambia qué pesos están respondiendo.

## Por qué un cambio de modelo merece un control

El modelo de una sesión no es una preferencia, es una entrada. Cambia Opus por Haiku a mitad de una refactorización y la siguiente llamada a herramienta la planifica otro razonador sobre la misma transcripción. A los equipos esto les importa por tres razones distintas: costo (un cambio de `/model` hacia arriba puede multiplicar la cuenta de los turnos restantes), reproducibilidad (un reporte de bug que dice "Claude hizo X" es imposible de falsar si el modelo cambió a mitad de sesión) y políticas (algunas organizaciones solo están autorizadas a enviar código a modelos específicos).

Hasta 2.1.251 no existía ninguna costura donde aplicar nada de eso. Ahora sí.

## Bloquear un cambio

Registra el hook en `settings.json`. Aquí el matcher no es el nombre de una herramienta: coincide con el nombre canónico del modelo *al que* cambia la sesión:

```json
{
  "hooks": {
    "PreModelSwitch": [
      {
        "matcher": "claude-opus-5",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/check-model-switch.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Los matchers son expresiones regulares, así que tanto `claude-opus-4-6|claude-opus-5` como `.*opus.*` funcionan si quieres atrapar una familia entera en lugar de un solo ID.

El hook lee el evento por stdin. `PreModelSwitch` y `PostModelSwitch` reciben `from_model` y `to_model` en lugar de los campos habituales de herramienta, junto con `session_id`, `prompt_id`, `transcript_path` y `cwd`:

```bash
#!/usr/bin/env bash
to_model=$(jq -r '.to_model')

if [ -n "$OPUS_BUDGET_EXHAUSTED" ]; then
  cat <<JSON
{
  "hookSpecificOutput": {
    "hookEventName": "PreModelSwitch",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Opus budget for this repo is spent. Staying on $to_model is blocked until the cycle resets."
  }
}
JSON
fi
exit 0
```

Salir con el código 2 también bloquea el cambio, que es la versión de una línea si no quieres emitir JSON. Un detalle filoso que conviene conocer: un hook `PreModelSwitch` cancelado por su `timeout` también bloquea el cambio. Este evento falla en modo cerrado, a diferencia de casi todo el resto del ciclo de vida.

## PostModelSwitch se dispara cuando tú no lo pediste

`PostModelSwitch` es la mitad de auditoría, y cubre más que tus propias llamadas a `/model`. Según la documentación se ejecuta "after the session's model changes, including changes Claude Code makes on its own, such as restoring the model when you resume a session". Ese es justamente el caso que vuelve difícil responder después "qué modelo escribió esto", así que agregar `from_model`, `to_model` y `session_id` a un archivo de registro aquí es la observabilidad más barata que vas a sumar en toda la semana.

La misma versión también corrigió las peticiones de Opus 5 que fallaban con "effort is not supported when thinking is disabled" en effort xhigh o max, y cerró [cuatro formas distintas de esquivar el control de permisos](/es/2026/08/claude-code-2-1-251-four-ways-around-the-permission-check/). Todos los detalles están en la [referencia de hooks](https://code.claude.com/docs/en/hooks).
