---
title: "Resolver as abas do Firefox com cores estranhas no Windows 8"
description: "Como resolver o glitch de cor das abas do Firefox no Windows 8 em placas de vídeo nVidia desativando a aceleração por hardware."
pubDate: 2012-11-01
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "pt-br"
translationOf: "2012/11/fix-firefox-tabs-having-strange-colors-in-windows-8"
translatedBy: "claude"
translationDate: 2026-05-01
---
Esse glitch gráfico é um bug conhecido do Firefox rodando no Windows 8. Aparece só em máquinas com placas de vídeo nVidia e é causado pelo uso da aceleração por hardware no navegador.

A solução é simples: **desabilitar a aceleração por hardware** no menu de configurações do navegador. As cores estranhas vão sumir -- e infelizmente a aceleração por hardware também. Mas é tudo o que dá para fazer até o bug ser corrigido.

Você pode acompanhar a issue no bugzilla aqui: [https://bugzilla.mozilla.org/show_bug.cgi?id=686782](https://bugzilla.mozilla.org/show_bug.cgi?id=686782)

E, caso não encontre a opção: abra a janela de opções (Firefox > Options ou Tools > Options) > Advanced > General. Lá, desmarque a caixa "Use hardware acceleration when available". É isso.

Atualização: 8 anos depois, atualizando para SEO, o bug não foi resolvido, mas... quem ainda usa Windows 8 hoje em dia?
