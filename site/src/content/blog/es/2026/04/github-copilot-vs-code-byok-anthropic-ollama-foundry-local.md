---
title: "BYOK en GitHub Copilot Chat llega a GA en VS Code: Anthropic, Ollama, Foundry Local"
description: "GitHub Copilot para VS Code lanzó Bring Your Own Key el 22 de abril de 2026. Conecta tu propia cuenta de Anthropic, OpenAI, Gemini, OpenRouter o Azure a Chat, o apunta a un modelo local con Ollama o Foundry Local. La facturación omite la cuota de Copilot y va directo al proveedor."
pubDate: 2026-04-26
tags:
  - "github-copilot"
  - "vscode"
  - "ai-agents"
  - "ollama"
lang: "es"
translationOf: "2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local"
translatedBy: "claude"
translationDate: 2026-04-26
---

[GitHub lanzó BYOK en GA para Copilot Chat en VS Code el 22 de abril de 2026](https://github.blog/changelog/2026-04-22-bring-your-own-language-model-key-in-vs-code-now-available/). La versión corta: ahora puedes conectar tu propia clave de Anthropic, OpenAI, Gemini, OpenRouter o Azure a la interfaz de Copilot Chat y hacer que las solicitudes las facture el proveedor en lugar de consumir la cuota de Copilot. Los modelos locales también funcionan, mediante Ollama o Foundry Local. La característica está en GA para Copilot Business y Enterprise, y cubre Chat, plan agents y custom agents, no las completaciones inline.

## Por qué esto cambia el cálculo del precio de Copilot

Hasta este lanzamiento, Copilot Chat se ejecutaba sobre el pool de modelos hospedado por Microsoft y cada solicitud contaba contra la asignación mensual de tu seat. Eso hacía incómodo el trabajo exploratorio con agentes en modelos rápidos y baratos, o usar un modelo de frontera con el que tu organización ya tiene contrato. Con BYOK, la factura existente de Anthropic o Azure OpenAI de tu organización absorbe el costo y el seat de Copilot queda para lo que mejor hace: code completions, que siguen ejecutándose en los modelos hospedados por GitHub. Según las notas de la versión: "BYOK does not apply to code completions" y "usage doesn't consume GitHub Copilot quota allocations."

El otro desbloqueo es local. Hasta ahora, ejecutar Copilot Chat contra una instancia aislada de Ollama o contra Foundry Local en un portátil de desarrollador era un proyecto de investigación. La característica ahora es de primera clase.

## Configurar un proveedor

Abre la vista de Chat, haz clic en el selector de modelo y ejecuta **Manage Models** (o invoca `Chat: Manage Language Models` desde la Command Palette). VS Code abre el editor Language Models donde eliges un proveedor, pegas una clave y seleccionas un modelo. Los modelos aparecen en el selector de chat de inmediato.

Para endpoints compatibles con OpenAI que no están en la lista integrada (piensa en gateways de LiteLLM, proxies de inferencia on-prem o despliegues de Azure OpenAI tras una URL personalizada), la entrada equivalente en `settings.json` es:

```jsonc
{
  "github.copilot.chat.customOAIModels": {
    "claude-sonnet-4-6-via-litellm": {
      "name": "claude-sonnet-4-6",
      "url": "https://gateway.internal/v1/chat/completions",
      "toolCalling": true,
      "vision": false,
      "thinking": false,
      "maxInputTokens": 200000,
      "maxOutputTokens": 16384
    }
  },
  "inlineChat.defaultModel": "claude-sonnet-4-6-via-litellm"
}
```

La clave sigue viviendo en el almacén seguro, no en `settings.json`. La configuración solo describe la forma del modelo para que VS Code sepa qué capacidades habilitar en el selector (tool calling, visión, extended thinking).

Para Ollama, apunta el proveedor a `http://localhost:11434` y a un tag como `qwen2.5-coder:14b` o `phi-4:14b`. Para Foundry Local, el endpoint compatible con OpenAI usa por defecto `http://localhost:5273/v1` una vez que `foundry service start` está corriendo.

## Qué significa esto para el tooling de equipos .NET

Dos consecuencias prácticas para equipos que ya estandarizaron en Copilot:

1. La configuración `github.copilot.chat.customOAIModels` es por usuario en `settings.json`, pero es una configuración normal de VS Code: puede viajar dentro de una plantilla `.vscode/settings.json` en un repo o de una imagen de [Dev Container](https://code.visualstudio.com/docs/devcontainers/containers). Eso significa que un `dotnet new` template puede pre-cablear un modelo por defecto para todo el equipo.
2. Los administradores de la organización pueden deshabilitar BYOK desde Copilot policy settings en github.com si el cumplimiento exige que todo el tráfico se quede en los modelos hospedados por GitHub. Si necesitas esto desactivado para cargas reguladas, hazlo antes de que el rollout llegue a tus seats; la política se activa automáticamente por defecto en tenants Business y Enterprise.

Si has estado esperando para probar la historia de [Copilot agent skills en Visual Studio 2026](/es/2026/04/visual-studio-2026-copilot-agent-skills/) sin comprometer a todo tu equipo con la facturación hospedada por GitHub, este es el desbloqueo. Misma superficie de agentes, tu factura, tu modelo.
