---
title: "O Claude Agent SDK e o claude -p ganham seu próprio pool de créditos em 15 de junho"
description: "A Anthropic vai separar o uso programático do Claude da sua assinatura em 2026-06-15. Veja o que conta como programático, o crédito por plano e como evitar que seus agentes de CI parem em silêncio."
pubDate: 2026-06-05
tags:
  - "claude-code"
  - "ai-agents"
  - "anthropic"
lang: "pt-br"
translationOf: "2026/06/claude-agent-sdk-separate-credit-pool-june-15"
translatedBy: "claude"
translationDate: 2026-06-05
---

Se você executa o Claude em um pipeline, marque 2026-06-15 no seu calendário. A partir desse dia, a Anthropic tira todo o uso programático do Claude dos limites da sua assinatura e o coloca em um pool de créditos mensal separado e finito, cobrado pelos preços de lista da API. O chat interativo e o terminal interativo ficam exatamente como estão. A mudança atinge apenas as cargas de trabalho que você não consegue acompanhar em tempo real, que são justamente as mais propensas a quebrar em silêncio.

## O que conta como "programático"

A separação é sobre como o Claude é invocado, não sobre qual modelo você chama. O seguinte consome do novo pool de créditos em vez dos limites de uso do seu plano:

- O Claude Agent SDK em qualquer projeto com scripts ou pessoal.
- `claude -p`, o modo headless não interativo do Claude Code.
- Claude Code rodando dentro do GitHub Actions.
- Aplicativos de terceiros que se autenticam através do Agent SDK.

O chat web, desktop e mobile, mais a sessão de terminal interativa que você controla manualmente, continuam na sua assinatura. O Claude Cowork também. Se uma pessoa está digitando, nada muda.

## O crédito por plano

Cada plano recebe um crédito mensal fixo, dimensionado aproximadamente ao seu nível:

| Plano | Crédito mensal |
| --- | --- |
| Pro | $20 |
| Max 5x | $100 |
| Max 20x | $200 |
| Team Standard (por assento) | $20 |
| Team Premium (por assento) | $100 |
| Enterprise Premium (por assento) | $200 |

Quando esse crédito acaba, as requisições são cobradas pelos preços de lista da API ou rejeitadas, dependendo de um botão de "usage credits" nas configurações da sua conta. Um loop de agente noturno que cabia confortavelmente em uma assinatura Max 20x agora pode acabar no meio do mês, e um job de CI que antes "simplesmente funcionava" pode começar a retornar erros assim que o pool esvaziar.

## Torne a automação previsível: dê a ela sua própria chave

A correção mais limpa é parar de fazer a automação pegar emprestada sua assinatura. Aponte as cargas headless para uma chave de API dedicada, para que o gasto seja medido, atribuível e isolado do seu assento interativo. No GitHub Actions isso é uma mudança de uma linha:

```yaml
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Claude Code headless
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          claude -p "Triage the newest issue and label it" \
            --allowedTools "Bash(gh:*)"
```

Com `ANTHROPIC_API_KEY` definida, `claude -p` e o Agent SDK se autenticam contra a conta de API em vez do seu crédito de assinatura, então o pool de 15 de junho nunca entra em cena para esse job. Você paga preços de lista de qualquer forma, mas agora a conta fica onde você pode orçá-la.

## Antes do prazo

Três coisas valem a pena fazer esta semana. Reivindique o crédito único do e-mail que a Anthropic enviou (é uma ação manual nas configurações da conta). Audite quanto seu uso programático realmente custa pelos preços da API, para saber se o crédito cobre uma semana ou um mês. Depois, avise quem administra seu CI que a cota mensal agora é finita, e decida por pipeline se o excedente deve ser cobrado ou falhar de forma estrita.

Para os termos oficiais, leia as [notas de versão do Claude](https://support.claude.com/en/articles/12138966-release-notes) e o [newsroom da Anthropic](https://www.anthropic.com/news).
