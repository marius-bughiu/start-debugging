---
title: "Claude Sonnet 5 é o novo modelo padrão do Claude Code: recalcule seus orçamentos de tokens"
description: "O Claude Sonnet 5 (claude-sonnet-5) chegou em 2026-06-30 e agora sustenta o alias 'sonnet' no Claude Code. Seu novo tokenizador emite cerca de 30% mais tokens para o mesmo texto, então estimativas de custo e limites de max_tokens ajustados para o Sonnet 4.6 precisam de um recálculo."
pubDate: 2026-07-08
tags:
  - "claude-code"
  - "ai-agents"
  - "llm"
lang: "pt-br"
translationOf: "2026/07/claude-sonnet-5-claude-code-default-new-tokenizer-token-budgets"
translatedBy: "claude"
translationDate: 2026-07-08
---

O Claude Sonnet 5 (`claude-sonnet-5`) chegou em 2026-06-30, e não é uma versão prévia pela qual você precisa optar. Na API da Anthropic, o alias `sonnet` agora se resolve para ele, e no Claude Code ele é o modelo padrão da conta para os assentos de assinatura Pro, Team Standard e Enterprise. Isso significa que muita gente já está usando ele sem mudar uma linha de configuração. O detalhe é que "atualização direta" não significa "a mesma matemática de tokens", e se você calcula o custo ou dimensiona `max_tokens` manualmente, os números que ajustou para o Sonnet 4.6 agora estão errados.

## O tokenizador mudou sem você perceber

O Sonnet 5 traz um novo tokenizador. O mesmo texto de entrada produz aproximadamente 30% mais tokens do que no Sonnet 4.6. O preço por token não mudou, $3/$15 por milhão de tokens de entrada/saída (com um preço introdutório de $2/$10 em vigor até 2026-08-31), mas 30% mais tokens para um texto idêntico significa que o custo de uma requisição equivalente sobe mesmo que a tabela de preços não tenha mudado.

Três coisas que você mede em tokens mudam:

- **Custo por requisição.** Qualquer estimativa derivada de uma contagem de tokens do Sonnet 4.6 agora fica baixa.
- **Orçamentos de `max_tokens`.** Um limite de saída dimensionado próximo da sua resposta esperada pode truncar no Sonnet 5, porque a mesma resposta gasta mais tokens.
- **Capacidade de contexto em termos de texto.** A janela é de 1M tokens, mas cada token cobre em média menos texto, então a mesma janela comporta menos prosa.

Não extrapole. Reconte contra o modelo com o endpoint de contagem de tokens antes de confiar em qualquer orçamento:

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

Execute o mesmo payload contra `claude-sonnet-4-6` e compare `input_tokens`. Esse delta é a sua correção de orçamento.

## Três comportamentos da API que agora retornam 400

Se você chama o Sonnet 5 diretamente, três requisições que funcionavam no Sonnet 4.6 agora retornam `400`:

- **Parâmetros de amostragem.** Definir `temperature`, `top_p` ou `top_k` com um valor não padrão é rejeitado. Remova-os e oriente pelo prompt do sistema.
- **Pensamento estendido manual.** `thinking: {"type": "enabled", "budget_tokens": N}` foi removido. Use o pensamento adaptativo, que está ativado por padrão.
- **Prefill do assistente.** Continua sem suporte, sem mudança em relação ao Sonnet 4.6.

## O que isso significa dentro do Claude Code

O Sonnet 5 requer o Claude Code v2.1.197 ou posterior; execute `claude update` se `sonnet` ainda se resolver para o 4.6. Na API da Anthropic ele sempre roda com a janela de contexto nativa de 1M, sem sufixo `[1m]` e sem créditos de uso, e as sessões se autocompactam por volta de 967K tokens. Se você precisa de um teto rígido de 200K para controlar o custo, defina `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`. E se você quer controlar exatamente quando o seu time troca de versão, fixe o ID completo em vez de acompanhar o alias:

```json
{
  "model": "claude-sonnet-5"
}
```

A migração em si é genuinamente uma troca de uma linha no ID do modelo. O trabalho está nos orçamentos ao redor dela. Todos os detalhes estão nas [notas de versão do Sonnet 5](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5).
