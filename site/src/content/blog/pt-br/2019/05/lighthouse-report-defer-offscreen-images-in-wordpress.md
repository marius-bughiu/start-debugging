---
title: "Relatório do Lighthouse: adiar imagens fora da tela no WordPress"
description: "Melhore a pontuação de performance do Lighthouse do seu site WordPress adiando imagens fora da tela com lazy loading."
pubDate: 2019-05-01
updatedDate: 2023-11-05
tags:
  - "lighthouse"
lang: "pt-br"
translationOf: "2019/05/lighthouse-report-defer-offscreen-images-in-wordpress"
translatedBy: "claude"
translationDate: 2026-05-01
---
Uma das coisas mais importantes quando falamos de performance percebida é a rapidez com que uma página carrega no primeiro acesso, e um dos pontos-chave para ter uma página rápida é carregar apenas o que é necessário, quando é necessário.

É claro que isso pode parecer trabalhoso, mas existem alguns ganhos fáceis nessa área, especialmente quando falamos de imagens. As imagens normalmente consomem a maior parte da banda quando se carrega um site e, tradicionalmente, você simplesmente carrega tudo.

Existem várias desvantagens em fazer isso:

-   Você está usando recursos para algo que o usuário pode nem chegar a ver.
-   Possíveis implicações de custo tanto para o usuário quanto para você. O usuário pode estar em uma conexão móvel com franquia, enquanto você pode estar hospedando na nuvem e pagando por banda de saída.
-   Experiência ruim do usuário e performance percebida fraca porque você está baixando e processando conteúdo inútil (fora da tela) em vez de focar no que está visível.
-   O ponto anterior também pode resultar em penalizações de page ranking aplicadas pelo Google, já que ele favorece páginas mais responsivas.

A solução: adiar e carregar imagens apenas quando elas entram em campo de visão. E, como mencionei, é um ganho fácil: existe um plugin que faz exatamente isso: [Lazy Load Optimizer](https://wordpress.org/support/plugin/lazy-load-optimizer/).

Basta adicioná-lo ao seu site WordPress e pronto. Agora, quando os usuários acessarem sua página, eles vão baixar apenas as imagens dentro do campo de visão. Todas as outras serão carregadas de forma lazy conforme o usuário rola.

Só isso já subiu a nota de performance do blog em 20 pontos, de 41 para 61. Vamos ver até onde dá pra ir.

## Resolução de problemas

Eu mesmo tive alguns problemas depois de instalar o plugin, com algumas imagens estourando assim:

![](/wp-content/uploads/2019/04/image-6-1024x490.png)

Isso aconteceu por causa de algumas estilizações hardcoded que eu tinha nas próprias tags img, o que de qualquer forma é considerado má prática. Movi tudo para um par de classes CSS que carregam separadamente e agora está tudo certo.
