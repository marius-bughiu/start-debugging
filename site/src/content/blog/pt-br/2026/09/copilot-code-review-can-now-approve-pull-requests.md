---
title: "Copilot Code Review agora pode aprovar pull requests"
description: "O changelog de 2026-09-01 do GitHub permite que o Copilot envie uma revisão de aprovação que satisfaz a regra de aprovações obrigatórias de um repositório. Vem desativado por padrão, é limitado por globs de arquivos e é descartado quando chegam novos commits. Veja o que realmente muda na sua proteção de branch."
pubDate: 2026-09-06
tags:
  - "github-copilot"
  - "code-review"
  - "ai-agents"
  - "devops"
lang: "pt-br"
translationOf: "2026/09/copilot-code-review-can-now-approve-pull-requests"
translatedBy: "claude"
translationDate: 2026-09-06
---

Em 2026-09-01 o GitHub lançou a mudança que tira o Copilot Code Review do papel de comentarista e o coloca no de autoridade: [Copilot code review can now approve pull requests](https://github.blog/changelog/2026-09-01-copilot-code-review-can-now-approve-pull-requests/). Está em preview público para Copilot Pro, Pro+, Max, Business e Enterprise.

Duas coisas diferentes chegaram aqui, e confundir as duas é como as equipes se surpreendem.

## Uma avaliação não é uma aprovação

Toda revisão do Copilot agora encerra seu comentário geral com uma avaliação de aprovação: o julgamento do Copilot sobre se o pull request está pronto para ser aprovado. Essa parte está ligada para todo mundo e não muda nada mecanicamente. É uma frase em um comentário e não toca nos seus requisitos de merge.

A segunda coisa é a revisão de aprovação de verdade, enviada por `copilot-pull-request-reviewer[bot]`, que conta para a regra de aprovações obrigatórias de um repositório exatamente como a aprovação de um colega. Isso vem **desativado por padrão** e precisa ser ligado por um administrador no nível de empresa, organização ou repositório.

Se você tem um repositório com "Require 1 approval" em um ruleset de branch e liga isso, você não adicionou um revisor. Você tornou o humano opcional.

## Limite o escopo com globs antes de ligar

A configuração no nível do repositório aceita uma lista de globs de arquivos, um por linha, e só conta uma aprovação do Copilot "em pull requests em que todos os arquivos alterados correspondem a um dos globs". A palavra que faz o trabalho é *todos*. Um pull request que toca `docs/setup.md` e `src/Payments/Charge.cs` não ganha aprovação computável se sua lista de globs for só de documentação. Essa é a postura padrão correta: comece pelos caminhos em que uma aprovação errada é barata.

As aprovações também são descartadas quando novos commits são enviados, igual a uma aprovação humana em um repositório configurado para descartar revisões obsoletas. Então o modo de falha não é um aval velho pegando carona depois de um force push.

## A revisão automática é uma regra de ruleset, e dá para programar

O botão de aprovação fica nas configurações, mas se o Copilot revisa ou não é uma regra de ruleset de branch (`copilot_code_review`), então pode ser criada pela API em vez de no clique:

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

Combine isso com uma consulta de auditoria, porque o GitHub não te entrega um painel para isso. Aprovações são revisões comuns, então você pode contá-las:

```bash
gh api "repos/OWNER/REPO/pulls/123/reviews" \
  --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]") | {state, submitted_at}'
```

Rode isso sobre os pull requests já mesclados e você tem o número que importa: quantos merges passaram do limite de aprovação sem uma pessoa olhar. Ligar `review_on_push` também multiplica o consumo de premium requests, o que se soma ao fato de que [o nível de esforço de revisão padrão passa de Lite para Balanced em 2026-09-28](/pt-br/2026/08/copilot-code-review-defaults-to-balanced-on-september-28/).

Ligue primeiro em arquivos gerados e documentação. Amplie quando tiver os números da auditoria, não antes.
