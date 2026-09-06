---
title: "Copilot Code Review ya puede aprobar pull requests"
description: "El changelog del 2026-09-01 de GitHub permite que Copilot envíe una revisión de aprobación que satisface la regla de aprobaciones obligatorias de un repositorio. Está desactivado por defecto, se limita con globs de archivos y se descarta al llegar nuevos commits. Esto es lo que realmente cambia en tu protección de ramas."
pubDate: 2026-09-06
tags:
  - "github-copilot"
  - "code-review"
  - "ai-agents"
  - "devops"
lang: "es"
translationOf: "2026/09/copilot-code-review-can-now-approve-pull-requests"
translatedBy: "claude"
translationDate: 2026-09-06
---

El 2026-09-01 GitHub lanzó el cambio que convierte a Copilot Code Review de comentarista en autoridad: [Copilot code review can now approve pull requests](https://github.blog/changelog/2026-09-01-copilot-code-review-can-now-approve-pull-requests/). Está en versión preliminar pública para Copilot Pro, Pro+, Max, Business y Enterprise.

Aquí aterrizaron dos cosas distintas, y confundirlas es la forma en que los equipos se llevan sorpresas.

## Una valoración no es una aprobación

Cada revisión de Copilot ahora termina su comentario general con una valoración de aprobación: el juicio de Copilot sobre si el pull request está listo para aprobarse. Esa parte está activa para todos y no cambia nada a nivel mecánico. Es una frase en un comentario y no toca tus requisitos de merge.

Lo segundo es la revisión de aprobación real, enviada por `copilot-pull-request-reviewer[bot]`, que cuenta para la regla de aprobaciones obligatorias de un repositorio exactamente igual que la aprobación de un compañero. Eso está **desactivado por defecto** y un administrador debe activarlo a nivel de empresa, organización o repositorio.

Si tienes un repositorio con "Require 1 approval" en un ruleset de rama y activas esto, no has agregado un revisor. Has vuelto opcional al humano.

## Limita el alcance con globs antes de activarlo

La configuración a nivel de repositorio acepta una lista de globs de archivos, uno por línea, y solo cuenta una aprobación de Copilot "en pull requests donde todos los archivos modificados coinciden con alguno de los globs". La palabra clave es *todos*. Un pull request que toca `docs/setup.md` y `src/Payments/Charge.cs` no obtiene una aprobación computable si tu lista de globs es solo de documentación. Esa es la postura correcta por defecto: empieza por las rutas donde una aprobación equivocada sale barata.

Las aprobaciones también se descartan cuando se envían nuevos commits, igual que una aprobación humana en un repositorio configurado para descartar revisiones obsoletas. Así que el modo de fallo no es un visto bueno rancio que sobrevive a un force push.

## La revisión automática es una regla de ruleset, y se puede automatizar

El interruptor de aprobación vive en la configuración, pero si Copilot revisa o no es una regla de ruleset de rama (`copilot_code_review`), así que se puede crear desde la API en lugar de hacer clics:

```bash
gh api repos/OWNER/REPO/rulesets --method POST --input - <<'JSON'
{
  "name": "copilot-review-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    {
      "type": "copilot_code_review",
      "parameters": {
        "review_on_push": true,
        "review_draft_pull_requests": false
      }
    }
  ]
}
JSON
```

Acompáñalo con una consulta de auditoría, porque GitHub no te entrega un panel para esto. Las aprobaciones son revisiones normales, así que puedes contarlas:

```bash
gh api "repos/OWNER/REPO/pulls/123/reviews" \
  --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]") | {state, submitted_at}'
```

Ejecútalo sobre los pull requests fusionados y obtienes el número que importa: cuántos merges superaron su umbral de aprobación sin que una persona mirara. Activar `review_on_push` también multiplica el consumo de premium requests, lo que se suma a que [el nivel de esfuerzo de revisión por defecto pasa de Lite a Balanced el 2026-09-28](/es/2026/08/copilot-code-review-defaults-to-balanced-on-september-28/).

Actívalo primero en archivos generados y documentación. Amplíalo cuando tengas los números de la auditoría, no antes.
