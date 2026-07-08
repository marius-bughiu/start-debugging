---
title: "Claude Sonnet 5 es el nuevo modelo predeterminado de Claude Code: recalcula tus presupuestos de tokens"
description: "Claude Sonnet 5 (claude-sonnet-5) llegó el 2026-06-30 y ahora respalda el alias 'sonnet' en Claude Code. Su nuevo tokenizador emite alrededor de un 30% más de tokens para el mismo texto, así que las estimaciones de costo y los límites de max_tokens ajustados para Sonnet 4.6 necesitan un recuento."
pubDate: 2026-07-08
tags:
  - "claude-code"
  - "ai-agents"
  - "llm"
lang: "es"
translationOf: "2026/07/claude-sonnet-5-claude-code-default-new-tokenizer-token-budgets"
translatedBy: "claude"
translationDate: 2026-07-08
---

Claude Sonnet 5 (`claude-sonnet-5`) llegó el 2026-06-30, y no es una versión preliminar a la que tengas que optar. En la API de Anthropic el alias `sonnet` ahora se resuelve a él, y en Claude Code es el modelo predeterminado de la cuenta para los asientos de suscripción Pro, Team Standard y Enterprise. Eso significa que mucha gente ya lo está usando sin cambiar una sola línea de configuración. El detalle es que "actualización directa" no significa "la misma matemática de tokens", y si calculas el costo o dimensionas `max_tokens` a mano, los números que ajustaste para Sonnet 4.6 ahora están mal.

## El tokenizador cambió sin avisarte

Sonnet 5 incorpora un nuevo tokenizador. El mismo texto de entrada produce aproximadamente un 30% más de tokens que en Sonnet 4.6. El precio por token no cambia, $3/$15 por millón de tokens de entrada/salida (con un precio introductorio de $2/$10 vigente hasta el 2026-08-31), pero un 30% más de tokens para un texto idéntico significa que el costo de una solicitud equivalente sube aunque la lista de precios no lo haya hecho.

Tres cosas que mides en tokens cambian:

- **Costo por solicitud.** Cualquier estimación derivada de un recuento de tokens de Sonnet 4.6 ahora se queda corta.
- **Presupuestos de `max_tokens`.** Un límite de salida dimensionado cerca de tu respuesta esperada puede truncarse en Sonnet 5, porque la misma respuesta gasta más tokens.
- **Capacidad de contexto en términos de texto.** La ventana es de 1M tokens, pero cada token cubre en promedio menos texto, así que la misma ventana contiene menos prosa.

No extrapoles. Vuelve a contar contra el modelo con el endpoint de conteo de tokens antes de confiar en cualquier presupuesto:

```bash
curl https://api.anthropic.com/v1/messages/count_tokens \
  --header "x-api-key: $ANTHROPIC_API_KEY" \
  --header "anthropic-version: 2023-06-01" \
  --header "content-type: application/json" \
  --data '{
    "model": "claude-sonnet-5",
    "messages": [{ "role": "user", "content": "Summarize this build log." }]
  }'
```

Ejecuta el mismo payload contra `claude-sonnet-4-6` y compara `input_tokens`. Esa diferencia es tu corrección de presupuesto.

## Tres comportamientos de la API que ahora dan 400

Si llamas a Sonnet 5 directamente, tres solicitudes que funcionaban en Sonnet 4.6 ahora devuelven `400`:

- **Parámetros de muestreo.** Establecer `temperature`, `top_p` o `top_k` en un valor no predeterminado se rechaza. Elimínalos y guía con el prompt del sistema en su lugar.
- **Pensamiento extendido manual.** `thinking: {"type": "enabled", "budget_tokens": N}` desapareció. Usa el pensamiento adaptativo, que está activado por defecto.
- **Prefill del asistente.** Sigue sin admitirse, sin cambios respecto a Sonnet 4.6.

## Qué significa dentro de Claude Code

Sonnet 5 requiere Claude Code v2.1.197 o posterior; ejecuta `claude update` si `sonnet` todavía se resuelve a 4.6. En la API de Anthropic siempre se ejecuta con la ventana de contexto nativa de 1M, sin sufijo `[1m]` y sin créditos de uso, y las sesiones se autocompactan alrededor de los 967K tokens. Si necesitas un tope estricto de 200K para controlar el costo, establece `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`. Y si quieres controlar exactamente cuándo tu equipo cambia de versión, fija el ID completo en lugar de depender del alias:

```json
{
  "model": "claude-sonnet-5"
}
```

La migración en sí es genuinamente un cambio de una sola línea en el ID del modelo. El trabajo está en los presupuestos que la rodean. Todos los detalles están en las [notas de la versión de Sonnet 5](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5).
