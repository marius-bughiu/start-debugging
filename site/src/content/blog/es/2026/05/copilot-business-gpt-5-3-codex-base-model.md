---
title: "GPT-5.3-Codex se convierte en el modelo base de Copilot Business y Enterprise"
description: "El 17 de mayo de 2026 GitHub cambió el modelo Copilot por defecto en los planes Business y Enterprise de GPT-4.1 a GPT-5.3-Codex. GPT-4.1 sigue gratis hasta el 1 de junio, luego entra en facturación por uso. Esto es lo que cambia para los modelos fijados en tu repositorio y CI."
pubDate: 2026-05-18
tags:
  - "github-copilot"
  - "ai-agents"
  - "openai"
lang: "es"
translationOf: "2026/05/copilot-business-gpt-5-3-codex-base-model"
translatedBy: "claude"
translationDate: 2026-05-18
---

GitHub empezó a [desplegar GPT-5.3-Codex como nuevo modelo base para los planes Copilot Business y Enterprise el 17 de mayo de 2026](https://github.blog/changelog/2026-05-17-gpt-5-3-codex-is-now-the-base-model-for-copilot-business-and-enterprise/). Reemplaza a GPT-4.1 como predeterminado para todo el nivel de plan y es el primer modelo de soporte a largo plazo (LTS) de GitHub y OpenAI en Copilot: la ventana LTS garantiza que el modelo siga siendo seleccionable hasta el 2027-02-04.

Las cuentas individuales (Copilot Pro, Pro+, Free) no se ven afectadas. El cambio solo modifica el modelo por defecto para Business y Enterprise.

## Qué controla realmente el "modelo base"

El modelo base es el que Copilot usa cuando una solicitud no fija un modelo específico. Donde hayas escrito `model: gpt-4.1` en una configuración de Copilot, eso no cambia por ahora. Donde dejes que Copilot elija, la respuesta acaba de pasar de GPT-4.1 a GPT-5.3-Codex.

GPT-5.3-Codex tiene un multiplicador de premium request de 1x, igual que GPT-4.1, así que el costo por solicitud en los SKU de Business y Enterprise no se mueve con este cambio. Las completaciones inline, el Chat sin modelo fijado y la selección `auto` del cloud agent cambian todas a la vez.

## Qué cambia para repositorios que fijan el predeterminado anterior

Dos lugares para revisar antes del 2026-06-01. Después de esa fecha, las solicitudes aún fijadas a `gpt-4.1` empezarán a facturarse bajo el medidor de uso en lugar de estar incluidas.

```bash
# 1. Workflow files that pin a Copilot model
grep -RE "model:\s*gpt-4\.1" .github/ 2>/dev/null

# 2. Copilot agent and Chat custom instructions
grep -R "gpt-4.1" .copilot/ .github/copilot-instructions.md 2>/dev/null
```

Si el CI del proyecto ejecuta Copilot CLI o tareas del cloud agent contra un GPT-4.1 fijado, hay dos opciones: subir el pin a `gpt-5.3-codex` o aceptar el cargo extra a partir del 1 de junio. Un pin YAML para el nuevo predeterminado se ve así:

```yaml
# .github/workflows/copilot-review.yml
- uses: github/copilot-action@v1
  with:
    model: gpt-5.3-codex
    effort: high
```

## Por qué GitHub eligió una variante Codex para el slot LTS

GPT-5.3-Codex es el hermano afinado para código en la familia GPT-5.3. La métrica declarada por GitHub en la publicación del despliegue fue la tasa de supervivencia de código, la proporción de sugerencias aceptadas que siguen en el archivo tras ediciones posteriores y merges de PR. El changelog reporta una tasa significativamente más alta entre clientes Business y Enterprise en la cohorte del despliegue frente a GPT-4.1, y esa es la justificación para designarlo como la base LTS en lugar del GPT-5.3 generalista.

La designación LTS importa más que el propio cambio de modelo. GitHub deprecia modelos de forma continua y con poco aviso. [Claude Sonnet 4 fue eliminado de todas las superficies de Copilot once días antes](/es/2026/05/copilot-deprecates-claude-sonnet-4-may-2026/) con un changelog de dos párrafos y sin ventana de migración. El compromiso LTS de Codex es la primera garantía de disponibilidad con fecha de GitHub sobre un modelo de Copilot, y el resto del catálogo no la tiene.

El acceso a GPT-4.1 continúa sin cargo adicional hasta el 2026-06-01. Después de eso, el medidor arranca.
