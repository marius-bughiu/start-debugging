---
title: "Copilot Code Review passa para esforço Balanced em 28 de setembro"
description: "Os changelogs do GitHub de 27 e 28 de agosto de 2026 removem o limite de 20.000 linhas por revisão, passam a revisar PRs criados por bots e mudam o nível de esforço padrão de Lite para Balanced em 28 de setembro. Os três aumentam o consumo de créditos de IA no mesmo mês."
pubDate: 2026-08-31
tags:
  - "github-copilot"
  - "code-review"
  - "ai-agents"
  - "devops"
lang: "pt-br"
translationOf: "2026/08/copilot-code-review-defaults-to-balanced-on-september-28"
translatedBy: "claude"
translationDate: 2026-08-31
---

O GitHub publicou duas entradas de changelog com um dia de diferença que, lidas juntas, mudam tanto o que o Copilot code review analisa quanto o que ele custa. Em 27 de agosto de 2026 o limite de tamanho da revisão desapareceu e pull requests criados por bots passaram a ser revisáveis. Em 28 de agosto de 2026 o GitHub anunciou que em **28 de setembro de 2026** o nível de esforço padrão muda de Lite para Balanced. Nada disso é opcional.

## Três multiplicadores chegando no mesmo mês

A entrada de 27 de agosto, [Copilot code review: resolution reasons and expanded capabilities](https://github.blog/changelog/2026-08-27-copilot-code-review-resolution-reasons-and-expanded-capabilities/), removeu o teto que antes parava uma revisão em 300 arquivos ou 20.000 linhas de código. Refatorações grandes e PRs com código gerado que o Copilot pulava em silêncio agora são revisados por inteiro. A mesma entrada tornou pull requests criados por bots elegíveis para revisão automática, incluindo explicitamente o Copilot cloud agent, então PRs abertos por agentes agora passam pelo revisor em vez de irem direto para uma fila humana.

Em seguida, a [entrada sobre políticas e cobrança](https://github.blog/changelog/2026-08-28-upcoming-changes-to-github-copilot-policies-and-billing/) muda o esforço padrão. A própria documentação do GitHub é direta sobre o trade-off: Lite é uma "standard review", Balanced faz "deeper analysis of complex logic, security-sensitive code, and cross-service changes", e revisões Balanced "use more AI credits, and may consume marginally more GitHub Actions minutes."

Mais PRs revisados, diffs maiores por revisão e uma passada de modelo mais profunda em cada uma. Se você orçou créditos de IA com base na fatura de julho, setembro não vai bater.

## Fixe Lite antes de 28 de setembro se quiser o comportamento de hoje

O nível de esforço existe tanto no escopo da organização quanto no do repositório, e o do repositório vence. Settings, depois Copilot, depois Code review, sob "Code, planning, and automation". Definir explicitamente como Lite antes de 28 de setembro preserva o comportamento atual; deixar sem mexer inscreve você no Balanced.

Vale auditar ao mesmo tempo o flag `review_on_push` nos seus rulesets. Ele revisa novamente a cada push, então multiplica contra o novo padrão mais profundo em vez de somar. O tipo da regra é `copilot_code_review`, então dá para inspecionar sem clicar por todos os repositórios:

```bash
gh api /repos/OWNER/REPO/rulesets --jq '.[].id' \
  | xargs -I{} gh api /repos/OWNER/REPO/rulesets/{} \
      --jq '.rules[] | select(.type=="copilot_code_review")'
```

Uma regra que dispara a cada push tem esta cara:

```json
{
  "type": "copilot_code_review",
  "parameters": {
    "review_on_push": true,
    "review_draft_pull_requests": true
  }
}
```

Em uma branch onde as pessoas fazem seis pushes antes de pedir revisão, `review_on_push` mais `review_draft_pull_requests` são seis revisões Balanced de um diff que ninguém olhou ainda.

## Os motivos de resolução finalmente tornam os comentários mensuráveis

A única mudança inequivocamente boa: resolver um comentário de revisão do Copilot agora exige um motivo em um dropdown ao lado de "Resolve conversation". As opções são **Addressed**, **Won't fix** e **Incorrect**. Esse terceiro valor é o que importa, porque é a primeira vez que a taxa de falsos positivos da revisão automatizada é um número que você consegue extrair, e não uma sensação que seus engenheiros seniores têm. Antes de soltar o Balanced em todos os repositórios, gaste um sprint marcando os motivos no Lite e veja qual é a proporção real.

Outras duas datas da mesma entrada: novas atribuições de assento Business e Enterprise exigem pagamento antes do acesso a partir de 1 de setembro de 2026, clientes existentes verão cobranças antecipadas por assento a partir de 1 de outubro de 2026, e a experiência unificada do Copilot que chega em 28 de setembro estende a retenção de dados do chat de 28 dias para a vida da conta. Essa última vem ligada por padrão e sair dela custa o Copilot Chat no github.com e no celular por completo, então é uma revisão de conformidade, não uma preferência.

Sobre o lado do contexto de revisão do mesmo produto, veja [Copilot code review agora lê sua pasta .github/skills](/pt-br/2026/07/copilot-code-review-agent-skills-and-mcp-ga/).
