---
title: "Copilot Code Review pasa a esfuerzo Balanced el 28 de septiembre"
description: "Los changelogs de GitHub del 27 y 28 de agosto de 2026 eliminan el límite de 20 000 líneas por revisión, empiezan a revisar PRs creados por bots y cambian el nivel de esfuerzo por defecto de Lite a Balanced el 28 de septiembre. Los tres suben el consumo de créditos de IA en el mismo mes."
pubDate: 2026-08-31
tags:
  - "github-copilot"
  - "code-review"
  - "ai-agents"
  - "devops"
lang: "es"
translationOf: "2026/08/copilot-code-review-defaults-to-balanced-on-september-28"
translatedBy: "claude"
translationDate: 2026-08-31
---

GitHub publicó dos entradas de changelog con un día de diferencia que, leídas juntas, cambian tanto lo que revisa Copilot code review como lo que cuesta. El 27 de agosto de 2026 desapareció el límite de tamaño de la revisión y los pull requests creados por bots pasaron a ser revisables. El 28 de agosto de 2026 GitHub anunció que el **28 de septiembre de 2026** el nivel de esfuerzo por defecto cambia de Lite a Balanced. Nada de esto es opcional.

## Tres multiplicadores que llegan en el mismo mes

La entrada del 27 de agosto, [Copilot code review: resolution reasons and expanded capabilities](https://github.blog/changelog/2026-08-27-copilot-code-review-resolution-reasons-and-expanded-capabilities/), eliminó el techo que antes detenía una revisión en 300 archivos o 20 000 líneas de código. Los refactors grandes y los PRs con código generado que Copilot omitía en silencio ahora se revisan completos. La misma entrada hizo elegibles para revisión automática los pull requests creados por bots, incluyendo explícitamente el Copilot cloud agent, así que los PRs abiertos por agentes ahora los revisa el revisor en lugar de entrar directo a una cola humana.

Luego la [entrada sobre políticas y facturación](https://github.blog/changelog/2026-08-28-upcoming-changes-to-github-copilot-policies-and-billing/) cambia el esfuerzo por defecto. La propia documentación de GitHub es directa sobre el compromiso: Lite es una "standard review", Balanced hace "deeper analysis of complex logic, security-sensitive code, and cross-service changes", y las revisiones Balanced "use more AI credits, and may consume marginally more GitHub Actions minutes."

Más PRs revisados, diffs más grandes por revisión y una pasada de modelo más profunda en cada una. Si presupuestaste créditos de IA a partir de la factura de julio, septiembre no va a coincidir.

## Fija Lite antes del 28 de septiembre si quieres el comportamiento actual

El nivel de esfuerzo vive tanto en el ámbito de la organización como en el del repositorio, y gana el del repositorio. Settings, luego Copilot, luego Code review, bajo "Code, planning, and automation". Ponerlo explícitamente en Lite antes del 28 de septiembre conserva el comportamiento actual; dejarlo sin tocar te inscribe en Balanced.

Vale la pena auditar al mismo tiempo el flag `review_on_push` de tus rulesets. Vuelve a revisar en cada push, así que se multiplica contra el nuevo valor por defecto en lugar de sumarse. El tipo de regla es `copilot_code_review`, de modo que puedes inspeccionarlo sin entrar a cada repositorio:

```bash
gh api /repos/OWNER/REPO/rulesets --jq '.[].id' \
  | xargs -I{} gh api /repos/OWNER/REPO/rulesets/{} \
      --jq '.rules[] | select(.type=="copilot_code_review")'
```

Una regla que se dispara en cada push se ve así:

```json
{
  "type": "copilot_code_review",
  "parameters": {
    "review_on_push": true,
    "review_draft_pull_requests": true
  }
}
```

En una rama donde la gente hace seis pushes antes de pedir revisión, `review_on_push` más `review_draft_pull_requests` son seis revisiones Balanced de un diff que nadie ha mirado todavía.

## Las razones de resolución por fin hacen medibles los comentarios

El único cambio inequívocamente bueno: resolver un comentario de revisión de Copilot ahora exige una razón desde un desplegable junto a "Resolve conversation". Las opciones son **Addressed**, **Won't fix** e **Incorrect**. Ese tercer valor es el que importa, porque es la primera vez que la tasa de falsos positivos de la revisión automatizada es un número que puedes extraer y no una sensación que tienen tus ingenieros senior. Antes de soltar Balanced sobre todos los repositorios, dedica un sprint a etiquetar con Lite y mira cuál es la proporción real.

Otras dos fechas de la misma entrada: las nuevas asignaciones de asientos Business y Enterprise requieren pago antes del acceso a partir del 1 de septiembre de 2026, los clientes existentes verán cargos por asiento por adelantado desde el 1 de octubre de 2026, y la experiencia unificada de Copilot que llega el 28 de septiembre extiende la retención de datos del chat de 28 días a la vida de la cuenta. Esa última viene activada por defecto y salirte te cuesta Copilot Chat en github.com y en móvil por completo, así que es una revisión de cumplimiento, no una preferencia.

Sobre el lado del contexto de revisión del mismo producto, mira [Copilot code review ahora lee tu carpeta .github/skills](/es/2026/07/copilot-code-review-agent-skills-and-mcp-ga/).
