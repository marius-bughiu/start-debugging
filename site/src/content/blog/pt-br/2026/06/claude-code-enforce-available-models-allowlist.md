---
title: "O Claude Code 2.1.175 fecha a brecha do availableModels com enforceAvailableModels"
description: "Por meses o availableModels restringiu o seletor de modelos mas deixou a opção Default totalmente aberta. O Claude Code 2.1.175 adiciona enforceAvailableModels para que administradores possam finalmente fixar uma allowlist estrita de modelos."
pubDate: 2026-06-15
tags:
  - "claude-code"
  - "ai-agents"
  - "governance"
lang: "pt-br"
translationOf: "2026/06/claude-code-enforce-available-models-allowlist"
translatedBy: "claude"
translationDate: 2026-06-15
---

Se a sua organização padronizou o uso de `availableModels` para controlar quais modelos Claude os desenvolvedores podem executar, existiu esse tempo todo um buraco silencioso nessa cerca. A allowlist governava `/model`, a flag `--model`, `ANTHROPIC_MODEL`, subagentes e overrides de advisor, mas nunca tocou na única opção que todo seletor exibe: Default. Um desenvolvedor podia escolher Default e cair no que for o default do sistema para o seu tier, passando direto pela sua lista curada. O Claude Code 2.1.175, lançado em 2026-06-12, finalmente fecha essa lacuna com uma nova configuração gerenciada: `enforceAvailableModels`.

## Por que Default era o vazamento

`availableModels` sempre foi uma allowlist para modelos *nomeados*. A entrada Default é especial. Ela não é um alias de modelo, ela resolve para o default de runtime do tier da conta (Opus 4.8 na API da Anthropic para Max e pay-as-you-go, Sonnet 4.6 em assentos de assinatura, e assim por diante). Como Default contorna a lista de nomeados, um administrador que definisse isto:

```json
{
  "availableModels": ["claude-sonnet-4-5", "haiku"]
}
```

ainda não conseguia impedir um usuário de selecionar Default e obter o modelo mais novo do tier. Para times que fixam uma versão específica por motivos de custo ou conformidade, isso era um bypass real, não teórico.

## O que enforceAvailableModels realmente faz

Defina como `true` nas configurações gerenciadas ou de policy junto com uma lista `availableModels` não vazia. Quando o default do tier não está na allowlist, Default agora resolve para a primeira entrada permitida em vez do default do tier.

```json
{
  "model": "claude-sonnet-4-5",
  "availableModels": ["claude-sonnet-4-5", "haiku"],
  "enforceAvailableModels": true,
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5"
  }
}
```

As duas configurações cobrem escopos diferentes. `enforceAvailableModels` faz Default obedecer à allowlist, enquanto o bloco `env` fixa qual versão um alias permitido como `sonnet` resolve. Uma ressalva que vale memorizar: um `availableModels: []` vazio nunca ativa a aplicação, então os usuários mantêm o Default do seu tier independentemente do que `enforceAvailableModels` diga.

## A rodada de reforço do 2.1.176

Um dia depois, o 2.1.176 vedou duas bordas adjacentes. Escolhas de modelo por alias não podem mais ser redirecionadas para um modelo bloqueado através das variáveis de ambiente `ANTHROPIC_DEFAULT_*_MODEL`, e `/fast` agora se recusa a alternar quando a mudança cairia em um modelo fora da allowlist.

Igualmente importante é o comportamento de merge. Quando `availableModels` está definido nas configurações gerenciadas ou de policy, esse valor substitui o resultado mesclado por completo. Entradas adicionadas nas configurações de usuário ou de projeto não podem ampliá-lo, e `enforceAvailableModels` é substituído da mesma forma. A partir do 2.1.175 essa é a única maneira de aplicar uma allowlist estrita; versões anteriores mesclavam a lista gerenciada com entradas de menor precedência, o que significava que um desenvolvedor podia silenciosamente acrescentar a ela.

Se você executa o Claude Code em um time e se importa com quais modelos de fato rodam, atualize para o 2.1.175 ou posterior e combine `availableModels` com `enforceAvailableModels`. As regras completas de precedência estão na [documentação de configuração de modelos](https://code.claude.com/docs/en/model-config).
