---
title: "Claude Code 2.1.122 permite escolher um nível de serviço do Bedrock a partir de uma variável de ambiente"
description: "Claude Code v2.1.122 adiciona a variável de ambiente ANTHROPIC_BEDROCK_SERVICE_TIER, enviada como o cabeçalho X-Amzn-Bedrock-Service-Tier. Defina como flex para 50 por cento de desconto nas chamadas do agente ou priority para respostas mais rápidas, sem tocar no código do SDK."
pubDate: 2026-04-30
tags:
  - "claude-code"
  - "ai-agents"
  - "aws-bedrock"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/04/claude-code-2-1-122-bedrock-service-tier"
translatedBy: "claude"
translationDate: 2026-04-30
---

O lançamento do Claude Code v2.1.122 em 28 de abril de 2026 trouxe um botão de uma linha que qualquer pessoa rodando o agente na AWS Bedrock vinha esperando em silêncio: uma nova variável de ambiente `ANTHROPIC_BEDROCK_SERVICE_TIER` que seleciona o nível de serviço do Bedrock a cada requisição. Defina como `default`, `flex` ou `priority`, e o CLI encaminha o valor como o cabeçalho `X-Amzn-Bedrock-Service-Tier`. Sem mudanças no código do SDK. Sem edições de configuração JSON. Uma variável de ambiente.

## Por que isso importa antes mesmo de você ler o resto

A AWS introduziu os níveis de inferência Priority e Flex no Bedrock em novembro de 2025 como uma forma de trocar latência por custo. Segundo a [página de níveis de serviço do Bedrock](https://aws.amazon.com/bedrock/service-tiers/), Flex é um desconto de 50 por cento sobre o preço Standard em troca de "maior latência", e Priority é um prêmio de 75 por cento que coloca suas requisições à frente da fila. Para um agente como o Claude Code, que dispara sequências longas de turnos de uso de ferramentas ao longo de uma sessão, a conta fala alto. Uma tarefa evergreen longa que rodava em default poderia custar metade em Flex se você pode absorver o tempo de parede extra, e uma sessão de depuração em que você está acompanhando o terminal poderia parecer mais ágil em Priority.

Até a v2.1.122, a única maneira de escolher um nível com o Claude Code no Bedrock era envolver a camada de requisições por conta própria ou passar por um proxy capaz de injetar o cabeçalho. A [requisição de funcionalidade](https://github.com/anthropics/claude-code/issues/16329) que foi atendida neste lançamento fecha essa lacuna.

## O uso real

```bash
# Cheap background agents that triage issues overnight
export ANTHROPIC_BEDROCK_SERVICE_TIER=flex
claude --from-pr https://github.acme.internal/acme/api/pull/482

# Interactive debug session, paying for speed
export ANTHROPIC_BEDROCK_SERVICE_TIER=priority
claude
```

O CLI envia o valor literalmente como `X-Amzn-Bedrock-Service-Tier` na requisição InvokeModel, que é o mesmo encanamento que o CloudTrail e o CloudWatch já registram em `ServiceTier` e `ResolvedServiceTier`. Então, se seu time de plataforma tem dashboards do gasto do Bedrock por nível, o tráfego do Claude Code agora cai no balde certo sem trabalho extra.

## Cuidado com ResolvedServiceTier

O cabeçalho é uma requisição, não uma garantia. A AWS retorna o nível que realmente serviu para você em `ResolvedServiceTier`, e requisições Flex podem ser rebaixadas se o pool flex do modelo estiver saturado. A lista completa de quais modelos suportam Priority e Flex está na [página de preços do Bedrock](https://aws.amazon.com/bedrock/pricing/), e ela atrasa em semanas em relação aos lançamentos mais recentes de modelos, então confirme que o ID do modelo com o qual você roda o Claude Code está nela antes de fixar `flex` em um job de CI. Se um nível não for suportado, a AWS volta ao nível padrão de forma transparente e cobra de acordo.

A linha `ANTHROPIC_BEDROCK_SERVICE_TIER` está enterrada no meio do changelog, mas é a alavanca de custo mais barata no Claude Code hospedado no Bedrock agora. As notas completas estão na [página da versão Claude Code v2.1.122](https://github.com/anthropics/claude-code/releases).
