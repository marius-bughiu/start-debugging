---
title: "Cursor Router transforma o Auto em uma decisão de modelo por requisição"
description: "O Cursor Router chegou em 2026-07-22. O Auto agora classifica cada requisição e a roteia para um modelo diferente, e os modos Cost, Balance e Intelligence mudam tanto a qualidade que você recebe quanto a forma como é cobrado."
pubDate: 2026-07-27
tags:
  - "cursor"
  - "ai-agents"
  - "developer-tools"
lang: "pt-br"
translationOf: "2026/07/cursor-router-makes-auto-a-per-request-model-decision"
translatedBy: "claude"
translationDate: 2026-07-27
---

A Cursor lançou o [Cursor Router](https://cursor.com/blog/router) em 2026-07-22, e isso muda silenciosamente o que a configuração de modelo Auto significa. O Auto costumava ser uma única política de roteamento voltada a manter o gasto de tokens baixo. Agora é um sistema de decisão que fica na frente de todos os modelos da sua conta, classifica cada requisição por tipo de tarefa e complexidade, e escolhe o modelo para aquela requisição específica.

## Três modos, três contas diferentes

No seletor de modelos você escolhe Auto e depois um modo em "Optimize For". A [documentação](https://cursor.com/docs/cursor-router) descreve assim:

- **Cost** usa a lógica de roteamento anterior do Auto. Otimiza o gasto de tokens e mantém o preço empacotado do Auto, cobrado por milhão de tokens.
- **Balance** otimiza inteligência, velocidade e custo, e cobra por requisição na tarifa do modelo roteado.
- **Intelligence** roteia para os modelos mais capazes em tarefas mais difíceis, a um custo menor do que rodar um único modelo de fronteira. Também cobrado por requisição.

Essa cobrança por requisição é a parte que vale ler duas vezes. Cost é o único modo que mantém a tarifa empacotada. A própria orientação da Cursor é que Balance e Intelligence custam em média cerca do dobro de Cost, e até duas a quatro vezes mais dependendo do modo selecionado.

A troca é real, não marketing. A Cursor relata que clientes do acesso antecipado cortaram de 30 a 50 por cento em relação a rodar Opus 4.8 para tudo, com custos por commit de US$ 6,76 no Intelligence e US$ 4,63 no Balance. O Intelligence fica perto do Fable em satisfação do usuário a um custo cerca de 60 por cento menor para times, e o Balance fica acima do Opus 4.8 a um custo cerca de 36 por cento menor.

## O modelo roteado fica oculto por padrão

Existe uma configuração no dashboard para exibir para qual modelo o Auto roteou no início de cada resposta. Oculto é o padrão, e a Cursor recomenda deixar assim.

Para o trabalho do dia a dia, tudo bem. Para quem tenta raciocinar sobre o comportamento do agente, não. Quando o mesmo prompt produz uma refatoração limpa na segunda-feira e uma medíocre na terça, a diferença pode ser o modelo roteado, e por padrão nada na transcrição informa isso. Se você está avaliando o router antes de liberá-lo para um time, ative a exibição primeiro e deixe ligada durante todo o teste.

## Fixe o modelo quando a execução precisa ser reproduzível

Roteamento é ótimo para trabalho interativo e ruim para qualquer coisa que você compare com uma linha de base. Para execuções de CI, harnesses de avaliação e jobs de agente em scripts, fixe um modelo explícito em vez de herdar o Auto:

```bash
# see the exact model ids this account exposes
agent --list-models

# pin one for a run that has to be repeatable
agent -p "run the failing tests and fix them" \
  --model <id-from-list-models> \
  --output-format json
```

O Cursor Router roda em desktop, web, iOS, na CLI e no SDK. Está ligado por padrão nos planos Teams, administradores Enterprise o habilitam pelo dashboard, e os planos individuais (Hobby, Pro, Pro+, Ultra) recebem alguns meses após o lançamento. Administradores podem restringir quais modos os membros escolhem, definir o padrão, permitir ou bloquear modelos subjacentes específicos, e aplicar de forma suave ou rígida a padronização no Auto.

Se o seu time já se apoia em trabalho paralelo de agentes, como os [side chats que chegaram no Cursor 3.11](/pt-br/2026/07/cursor-3-11-side-chats-parallel-agent-threads/), o router muda o formato de custo de tudo isso de uma vez. Confira o modo que o seu administrador definiu antes de supor que a conta continuou igual.
