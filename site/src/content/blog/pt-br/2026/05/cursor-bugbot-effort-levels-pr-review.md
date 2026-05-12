---
title: "Cursor Bugbot ganha níveis de esforço Default, High e Custom"
description: "Em 11 de maio de 2026, o Cursor lançou os níveis de esforço para o Bugbot. Default encontra 0.7 bugs por revisão, High eleva esse número para 0.95 e Custom permite descrever em linguagem natural quando cada modo deve entrar em ação."
pubDate: 2026-05-12
tags:
  - "cursor"
  - "bugbot"
  - "ai-agents"
  - "pull-requests"
lang: "pt-br"
translationOf: "2026/05/cursor-bugbot-effort-levels-pr-review"
translatedBy: "claude"
translationDate: 2026-05-12
---

Em 11 de maio de 2026, o Cursor [lançou os níveis de esforço para o Bugbot](https://cursor.com/changelog), o agente de revisão de PR que comenta nas pull requests abertas contra os repos que ele observa. Até agora, toda revisão executava o mesmo loop com o mesmo orçamento. A nova versão entrega aos admins do Teams e aos usuários Individual com cobrança por uso três botões: Default, High e Custom. Os números que o Cursor publicou junto com a versão valem ser fixados antes de falar de como configurar.

## Default contra High, em bugs medidos por execução

O Cursor relata dois números concretos no [changelog](https://cursor.com/changelog):

- **Default** tem média de **0.7 bugs encontrados por revisão** e é descrito como "optimized for efficiency and speed." Mais de 79% dos problemas que ele aponta são resolvidos antes da PR ser mergeada, que é a parte que importa para a relação sinal-ruído.
- **High** tem média de **0.95 bugs encontrados por revisão**. Gasta mais em tokens de raciocínio e leva mais tempo por PR.

Isso é um aumento de 36% nos bugs por execução, pago com latência e tokens extras. Se a troca vale a pena é uma pergunta sobre onde suas PRs se agrupam: um repo com uma longa cauda de regressões sutis é um problema diferente de um repo onde a maioria dos bugs é óbvia em dez segundos de leitura do diff. O Cursor não está tomando essa decisão por você, que é o ponto do terceiro modo.

## Custom é um roteador em linguagem natural

O modo Custom não dá um slider nem um schema YAML. Você escreve uma instrução curta e o Bugbot a usa como prompt de roteamento para escolher Default ou High por revisão. O padrão que o Cursor sugere na [documentação do Bugbot](https://docs.cursor.com/en/bugbot) lê mais como uma regra de triagem do que como um arquivo de configuração:

```text
Use High effort for any PR that:
- touches files under src/billing/** or src/auth/**
- changes a database migration (paths matching db/migrations/**)
- modifies a public API surface (anything in src/api/v1/**)

Use Default effort for everything else, including
documentation, tests, and dependency bumps.
```

Você cola isso no dashboard do Bugbot, na configuração de esforço do seu repo. Na próxima PR, o Bugbot lê os metadados do diff, aplica a regra e escolhe um modo antes de a revisão começar. Não há passo de compilação nem `bugbot.yaml`. Se a regra for ambígua, o Bugbot volta para Default.

## Onde configurar

O esforço vive no nível do repositório, não no nível do usuário, então um mesmo repo não pode ter um engenheiro em High e outro em Default. A configuração está no dashboard do Bugbot em `cursor.com/dashboard/bugbot/<repo>`, sob "Review effort." Os admins do Teams definem isso globalmente para os repos de uma organização. Os usuários do plano Individual com cobrança por uso veem o mesmo painel para seus próprios repos. Planos Individual de tarifa fixa não recebem seleção de esforço: esse balde fica no Default.

## Escolher um modo sem queimar o orçamento

A leitura honesta é que **High não é um botão "deixe mais inteligente," é um botão "gaste mais"**. Um aumento de 36% nos bugs por execução também implica cerca de 36% mais tokens cobrados contra seu limite de uso, e o impacto de latência aparece de forma mais dolorosa nas PRs que você quer mergear antes do almoço. Custom é o único modo que permite manter essa conta sob controle: escreva uma regra que mire as partes do código onde um bug perdido realmente custa caro e deixe o resto em Default. Se você não consegue articular essa regra em três linhas de português, provavelmente não precisa de High de jeito nenhum.

A versão chega junto com [os recursos de build em paralelo e split de PR do Cursor 3.3](/pt-br/2026/05/cursor-3-3-build-in-parallel-split-prs/), que é o padrão mais amplo: o Cursor está desagregando seus agentes em botões que você pode configurar por fluxo de trabalho, e não num único default que precisa agradar a todos.
