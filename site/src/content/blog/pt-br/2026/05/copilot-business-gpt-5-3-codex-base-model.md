---
title: "GPT-5.3-Codex vira o modelo base do Copilot Business e Enterprise"
description: "Em 17 de maio de 2026 o GitHub trocou o modelo padrão do Copilot nos planos Business e Enterprise de GPT-4.1 para GPT-5.3-Codex. O GPT-4.1 continua gratuito até 1 de junho, depois cai na cobrança por uso. Veja o que muda para os modelos fixados no seu repositório e no CI."
pubDate: 2026-05-18
tags:
  - "github-copilot"
  - "ai-agents"
  - "openai"
lang: "pt-br"
translationOf: "2026/05/copilot-business-gpt-5-3-codex-base-model"
translatedBy: "claude"
translationDate: 2026-05-18
---

O GitHub começou a [implantar o GPT-5.3-Codex como novo modelo base dos planos Copilot Business e Enterprise em 17 de maio de 2026](https://github.blog/changelog/2026-05-17-gpt-5-3-codex-is-now-the-base-model-for-copilot-business-and-enterprise/). Ele substitui o GPT-4.1 como padrão para toda a faixa de plano e é o primeiro modelo com suporte de longo prazo (LTS) do GitHub e da OpenAI no Copilot: a janela LTS garante que o modelo continue selecionável até 2027-02-04.

Contas individuais (Copilot Pro, Pro+, Free) não são afetadas. A mudança só altera o padrão para Business e Enterprise.

## O que o "modelo base" realmente controla

Modelo base é aquele que o Copilot usa quando uma requisição não fixa um modelo específico. Onde você escreveu `model: gpt-4.1` em uma configuração do Copilot, isso fica igual por enquanto. Onde você deixa o Copilot escolher, a resposta acabou de mudar de GPT-4.1 para GPT-5.3-Codex.

O GPT-5.3-Codex tem multiplicador de premium request de 1x, igual ao GPT-4.1, então o custo por requisição nos SKUs Business e Enterprise não muda com essa troca. Completions inline, Chat sem modelo fixado e a seleção `auto` do cloud agent viram todas ao mesmo tempo.

## O que muda para repositórios que fixam o padrão antigo

Dois lugares para varrer antes de 2026-06-01. Depois dessa data, requisições ainda fixadas em `gpt-4.1` passam a ser cobradas pelo medidor de uso em vez de estarem incluídas.

```bash
# 1. Workflow files that pin a Copilot model
grep -RE "model:\s*gpt-4\.1" .github/ 2>/dev/null

# 2. Copilot agent and Chat custom instructions
grep -R "gpt-4.1" .copilot/ .github/copilot-instructions.md 2>/dev/null
```

Se o CI do projeto roda Copilot CLI ou tarefas do cloud agent contra um GPT-4.1 fixado, há duas opções: subir o pin para `gpt-5.3-codex` ou aceitar o item de cobrança extra a partir de 1 de junho. Um pin YAML para o novo padrão tem este formato:

```yaml
# .github/workflows/copilot-review.yml
- uses: github/copilot-action@v1
  with:
    model: gpt-5.3-codex
    effort: high
```

## Por que o GitHub escolheu uma variante Codex para o slot LTS

GPT-5.3-Codex é o irmão ajustado para código na família GPT-5.3. A métrica declarada pelo GitHub no post foi a taxa de sobrevivência de código, a fração de sugestões aceitas que permanecem no arquivo após edições posteriores e merges de PR. O changelog relata uma taxa significativamente maior entre clientes Business e Enterprise na coorte da implantação em relação ao GPT-4.1, e essa é a justificativa para designá-lo como base LTS em vez do GPT-5.3 generalista.

A designação LTS pesa mais do que a troca de modelo em si. O GitHub deprecia modelos continuamente e com pouco aviso. [O Claude Sonnet 4 foi removido de todas as superfícies do Copilot onze dias antes](/pt-br/2026/05/copilot-deprecates-claude-sonnet-4-may-2026/) com um changelog de dois parágrafos e sem janela de migração. O compromisso LTS do Codex é a primeira garantia de disponibilidade datada do GitHub sobre um modelo do Copilot, e o restante da linha não tem isso.

O acesso ao GPT-4.1 continua sem custo adicional até 2026-06-01. Depois disso, o medidor liga.
