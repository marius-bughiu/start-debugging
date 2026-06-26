---
title: "Claude Code 2.1.191 deixa o /rewind voltar para antes de um /clear"
description: "O Claude Code v2.1.191 (24 de junho de 2026) estende o /rewind para que você possa restaurar o estado da conversa e do código de antes de rodar /clear, recuperando contexto que antes ficava perdido para sempre."
pubDate: 2026-06-26
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
lang: "pt-br"
translationOf: "2026/06/claude-code-2-1-191-rewind-past-clear"
translatedBy: "claude"
translationDate: 2026-06-26
---

O Claude Code v2.1.191 foi lançado em 24 de junho de 2026, e a mudança de destaque é pequena na descrição mas grande na prática: o `/rewind` agora pode voltar para antes de um `/clear`. O contexto que você apagou para começar do zero não foi mais perdido, ele está a apenas um rewind de distância.

## O que o /clear costumava custar

O `/clear` reinicia a conversa. É a jogada certa quando a thread atual está inchada, o modelo está fixado em um beco sem saída, ou você está trocando de tarefa e quer uma janela nova. O custo era que ele traçava um piso firme sob o seu histórico. Tudo antes do `/clear` ficava inacessível, mesmo que o Claude Code já estivesse criando pontos de verificação da sua sessão conforme você avançava.

Esse piso é o que o 2.1.191 remove. Os pontos de verificação de sessão que sustentam o `/rewind` agora sobrevivem a um `/clear`, então o seletor de rewind pode oferecer pontos de antes do reinício.

## Como o /rewind funciona

O `/rewind` leva você para trás pelos pontos de verificação que o Claude Code registra a cada passo de uma sessão. Você o abre com o comando `/rewind` ou pressionando `Esc` duas vezes:

```text
Esc Esc          # open the rewind picker
/rewind          # same thing, typed
```

Escolha um ponto de verificação e você decide o que restaurar: a conversa, o código no disco, ou ambos. Essa distinção importa. Você pode voltar a conversa para um ponto de três passos atrás para refazer uma pergunta sem tocar na sua árvore de trabalho, ou restaurar os arquivos para um estado sabidamente bom mantendo a discussão que levou até ali.

Antes deste lançamento, a lista de pontos de verificação disponíveis parava no seu `/clear` mais recente. Agora ela continua. Uma recuperação típica fica assim:

```text
# A long debugging thread, then a reset
/clear
# ...new work, then you realize you need the earlier repro
Esc Esc
# the picker now lists checkpoints from before the /clear
# select one, restore conversation + code, keep going
```

## Por que isso muda como você usa o /clear

A razão honesta pela qual as pessoas hesitavam em rodar o `/clear` era a aversão à perda. Limpar significava se comprometer com o corte, então você mantinha um contexto velho e caro só por precaução. Tornar o reinício reversível inverte isso. O `/clear` vira uma forma barata e rotineira de manter cada janela enxuta, porque um corte errado pode ser recuperado em vez de ser permanente.

Isso também combina com a direção de "pontos de verificação primeiro" dos lançamentos recentes. Sua sessão é uma sequência de pontos de restauração entre os quais você pode se mover, não uma única transcrição linear que você mantém ou destrói.

## O resto do lançamento

O 2.1.191 também corrige o salto da posição de rolagem durante respostas em streaming, conserta um bug de ressurreição de agentes em segundo plano e melhora a mensagem do `/voice` mostrada quando uma política o desabilita. O build imediatamente seguinte, 2.1.193, adiciona `autoMode.classifyAllShell` para rotear Bash e PowerShell pelo classificador do modo automático e expõe os motivos de negação do modo automático na transcrição e em `/permissions`.

As notas completas estão no [changelog do Claude Code](https://code.claude.com/docs/en/changelog).
