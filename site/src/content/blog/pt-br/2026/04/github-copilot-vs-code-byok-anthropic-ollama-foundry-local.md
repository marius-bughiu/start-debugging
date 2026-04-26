---
title: "BYOK do GitHub Copilot Chat chega ao GA no VS Code: Anthropic, Ollama, Foundry Local"
description: "O GitHub Copilot para VS Code lançou Bring Your Own Key em 22 de abril de 2026. Conecte sua própria conta Anthropic, OpenAI, Gemini, OpenRouter ou Azure ao Chat, ou aponte para um modelo local via Ollama ou Foundry Local. A cobrança ignora a cota do Copilot e vai direto para o provedor."
pubDate: 2026-04-26
tags:
  - "github-copilot"
  - "vscode"
  - "ai-agents"
  - "ollama"
lang: "pt-br"
translationOf: "2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local"
translatedBy: "claude"
translationDate: 2026-04-26
---

[O GitHub lançou BYOK em GA para o Copilot Chat no VS Code em 22 de abril de 2026](https://github.blog/changelog/2026-04-22-bring-your-own-language-model-key-in-vs-code-now-available/). Resumindo: agora você pode plugar sua própria chave Anthropic, OpenAI, Gemini, OpenRouter ou Azure na interface do Copilot Chat e fazer com que as requisições sejam cobradas pelo provedor em vez de consumir a cota do Copilot. Modelos locais também funcionam, via Ollama ou Foundry Local. A funcionalidade está em GA para Copilot Business e Enterprise, e cobre Chat, plan agents e custom agents, mas não as completions inline.

## Por que isso muda a equação do preço do Copilot

Até este lançamento, o Copilot Chat rodava no pool de modelos hospedado pela Microsoft e cada requisição contava contra a alocação mensual do seu seat. Isso tornava desconfortável fazer trabalho exploratório de agentes em modelos rápidos e baratos, ou usar um modelo de fronteira com o qual sua organização já tem contrato. Com BYOK, a fatura existente da Anthropic ou Azure OpenAI da sua organização absorve o custo e o seat do Copilot fica reservado para o que ele faz de melhor: code completions, que continuam rodando nos modelos hospedados pelo GitHub. De acordo com as notas da versão: "BYOK does not apply to code completions" e "usage doesn't consume GitHub Copilot quota allocations."

O outro desbloqueio é local. Até agora, rodar o Copilot Chat contra uma instância isolada do Ollama ou contra o Foundry Local em um notebook de desenvolvedor era um projeto de pesquisa. A funcionalidade agora é de primeira classe.

## Configurando um provedor

Abra a visão de Chat, clique no seletor de modelo e execute **Manage Models** (ou invoque `Chat: Manage Language Models` na Command Palette). O VS Code abre o editor Language Models onde você escolhe um provedor, cola uma chave e seleciona um modelo. Os modelos aparecem no seletor de chat imediatamente.

Para endpoints compatíveis com OpenAI que não estão na lista nativa (pense em gateways LiteLLM, proxies de inferência on-prem ou deployments do Azure OpenAI atrás de uma URL personalizada), a entrada equivalente em `settings.json` é:

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

A chave continua morando no armazenamento seguro, não em `settings.json`. A configuração apenas descreve o formato do modelo para que o VS Code saiba quais capacidades habilitar no seletor (tool calling, visão, extended thinking).

Para Ollama, aponte o provedor para `http://localhost:11434` e uma tag como `qwen2.5-coder:14b` ou `phi-4:14b`. Para Foundry Local, o endpoint compatível com OpenAI usa por padrão `http://localhost:5273/v1` assim que `foundry service start` estiver rodando.

## O que isso significa para o tooling de times .NET

Dois desdobramentos práticos para times que já padronizaram no Copilot:

1. A configuração `github.copilot.chat.customOAIModels` é por usuário em `settings.json`, mas é uma configuração normal do VS Code: pode viajar dentro de um template `.vscode/settings.json` em um repositório ou de uma imagem de [Dev Container](https://code.visualstudio.com/docs/devcontainers/containers). Isso significa que um `dotnet new` template pode pré-configurar um modelo padrão para o time inteiro.
2. Administradores da organização podem desabilitar BYOK em Copilot policy settings no github.com se a conformidade exigir que todo o tráfego permaneça nos modelos hospedados pelo GitHub. Se você precisa disso desligado para cargas reguladas, faça antes do rollout chegar aos seus seats; a política ativa automaticamente por padrão em tenants Business e Enterprise.

Se você estava esperando para experimentar a história dos [Copilot agent skills no Visual Studio 2026](/pt-br/2026/04/visual-studio-2026-copilot-agent-skills/) sem comprometer o time inteiro com a cobrança hospedada pelo GitHub, este é o desbloqueio. Mesma superfície de agentes, sua fatura, seu modelo.
