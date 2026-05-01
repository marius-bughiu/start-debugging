---
title: "Metro TimeBlock"
description: "Metro TimeBlock é um controle de exibição de horário customizável para Windows Phone que permite definir qualquer cor, fundo e tamanho."
pubDate: 2012-02-08
updatedDate: 2023-11-05
tags:
  - "metro"
  - "windows-phone"
lang: "pt-br"
translationOf: "2012/02/metro-timeblock"
translatedBy: "claude"
translationDate: 2026-05-01
---
Metro TimeBlock é um controle de exibição de horário que eu fiz, que permite mostrar o horário em qualquer cor e com o fundo que você quiser. O tamanho também é ajustável e você pode escolher exibir o horário atual ou um horário específico.

[![Metro TimeBlock](https://lh4.googleusercontent.com/--uwO3WD479Q/TzK6qBeZ-FI/AAAAAAAAAEM/JekVV927X8o/s640/metroTimeBlock.png)](https://lh4.googleusercontent.com/--uwO3WD479Q/TzK6qBeZ-FI/AAAAAAAAAEM/JekVV927X8o/s640/metroTimeBlock.png)

Propriedades do controle:

**Time** -- recebe qualquer objeto DateTime. O controle exibirá o Time fornecido dentro desse DateTime. Deixe em branco para exibir o horário atual.

**Spacer** -- é a string a ser exibida entre as horas e os minutos e entre os minutos e os segundos. Use separadores como ":" ou " ".

**Size** -- você pode escolher entre **Small, Normal, Medium, MediumLarge, Large, ExtraLarge, ExtraExtraLarge** e **Huge**. Optei por isso em vez de permitir FontSize porque assim também controlo como os blocos de fundo aparecem.

**Foreground** -- indica ao controle qual cor usar para exibir o horário.

**Fill** -- define a cor de fundo do controle (os blocos quadrados).

É basicamente isso. Se tiver algum problema ou precisar de ajuda, deixe um comentário abaixo. Você pode baixar o código por [este link](https://www.dropbox.com/s/mjiba8cugtj8fdz/StartDebugging.zip?dl=0); ele contém tanto o controle quanto alguns exemplos.
