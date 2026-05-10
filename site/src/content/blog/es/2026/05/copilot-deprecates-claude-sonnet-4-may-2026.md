---
title: "GitHub Copilot retira Claude Sonnet 4 de todas sus superficies"
description: "GitHub dejó obsoleto claude-sonnet-4 el 6 de mayo de 2026 en Copilot Chat, ediciones en línea, modos ask y agent, y autocompletado de código. El destino de migración recomendado es Claude Sonnet 4.6. Qué buscar en tu repositorio antes de que la próxima selección de modelo anclada se rompa silenciosamente."
pubDate: 2026-05-10
tags:
  - "github-copilot"
  - "ai-agents"
  - "claude"
lang: "es"
translationOf: "2026/05/copilot-deprecates-claude-sonnet-4-may-2026"
translatedBy: "claude"
translationDate: 2026-05-10
---

GitHub [retiró Claude Sonnet 4 de todas las superficies de Copilot el 6 de mayo de 2026](https://github.blog/changelog/2026-05-07-claude-sonnet-4-deprecated/). No solo del selector de modelo en Chat. La obsolescencia abarca Copilot Chat, ediciones en línea, modo ask, modo agent y autocompletado de código. El destino de migración recomendado es Claude Sonnet 4.6 (`claude-sonnet-4-6`).

El changelog en sí ocupa dos párrafos cortos. Lo interesante es lo que no dice.

## Lo que el anuncio realmente cubre

Textualmente: "We have deprecated the following model across all GitHub Copilot experiences (including Copilot Chat, inline edits, ask and agent modes, and code completions) on May 6, 2026."

Esa es la lista completa de superficies nombradas. Copilot CLI no aparece enumerado. Las instrucciones personalizadas tampoco. Si las solicitudes ancladas a `claude-sonnet-4` se redirigen automáticamente a un sucesor o si fallan directamente, no se especifica. "Please update your workflows and integrations to use supported models" es la única guía de migración ofrecida.

Si tienes Sonnet 4 corriendo en algún sitio donde fuera seleccionable, trátalo como retirado y planifica en consecuencia. No asumas que hay un redireccionamiento automático en su lugar.

## Dónde se esconde Sonnet 4 en un repositorio típico

El selector de modelo en el IDE elige un sitio. El modelo anclado en la configuración de tu repositorio elige otro, y ese es el que deja de funcionar silenciosamente. Tres ubicaciones para revisar con grep antes de que envíes el próximo cambio:

```bash
# 1. VS Code workspace and user settings
grep -R "claude-sonnet-4" .vscode/ "$HOME/.config/Code/User/settings.json" 2>/dev/null

# 2. Copilot custom agent / skill manifests
grep -R "claude-sonnet-4" .github/copilot/ .github/agents/ 2>/dev/null

# 3. Workflow files that invoke Copilot CLI or the Copilot agent
grep -R "claude-sonnet-4" .github/workflows/
```

La cadena que debes buscar es el id literal del modelo `claude-sonnet-4`. No `claude-sonnet-4-5` ni `claude-sonnet-4-6`, ambos siguen soportados. Un buscar y reemplazar con un límite de palabra es la jugada segura:

```bash
# Replace only the bare id, leave 4-5 and 4-6 alone
git ls-files | xargs sed -i 's/\bclaude-sonnet-4\b/claude-sonnet-4-6/g'
```

En un archivo de skill de agente Copilot o de instrucción personalizada, el cambio normalmente se ve así:

```yaml
# .github/copilot/agents/review.yml
- name: code-review
-   model: claude-sonnet-4
+   model: claude-sonnet-4-6
    instructions: |
      Review the diff against the project conventions.
```

## Por qué Sonnet 4.6 es el predeterminado correcto, no Opus 4.7

Sonnet 4.6 es la misma familia, perfil de latencia similar, y notablemente más fuerte en los benchmarks de contexto largo y bucle de agente para los que se afinó Sonnet 4. Para revisión de PR, ediciones en línea y bucles de modo agent donde disparas muchas llamadas baratas, Sonnet 4.6 es el reemplazo directo. Recurre a [Claude Opus 4.7 solo en el trabajo que justifique el gasto](/es/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/), como diffs críticos para la seguridad o refactorizaciones difíciles.

Si mantienes un despliegue de Copilot para un equipo, envía el enlace del anuncio, ejecuta el grep y actualiza el modelo anclado en el mismo PR. Las obsolescencias silenciosas que "funcionan la mayor parte del tiempo porque nadie ancló el id" son las que te muerden un martes por la mañana cuando la canalización de un ingeniero es de repente la única compilación roja.
