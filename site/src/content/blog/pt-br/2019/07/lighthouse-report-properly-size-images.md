---
title: "Relatório do Lighthouse: dimensione corretamente as imagens"
description: "Melhore sua pontuação de performance no Lighthouse dimensionando e otimizando corretamente as imagens para a web com ferramentas como o Squoosh."
pubDate: 2019-07-28
updatedDate: 2023-11-15
tags:
  - "lighthouse"
lang: "pt-br"
translationOf: "2019/07/lighthouse-report-properly-size-images"
translatedBy: "claude"
translationDate: 2026-05-01
---
Dimensionar corretamente suas imagens pode melhorar drasticamente os tempos de carregamento da página. Aqui olhamos duas categorias distintas:

-   imagens não otimizadas para a web (sem compressão, formatos ruins)
-   imagens em resolução maior do que o necessário (por exemplo, uma imagem de 800px de largura exibida a 300px)

![Relatório do Lighthouse sobre dimensionar corretamente as imagens](/wp-content/uploads/2019/07/properly-size-images.jpg)

No nosso caso temos três imagens na home não otimizadas ou dimensionadas inadequadamente. Para otimizá-las vou usar o [Squoosh](https://squoosh.app/).

Primeira imagem, o logo da Outworld Apps: tinha 887px de largura e estava sendo exibido em um container de 263px de largura. Redimensionado e otimizado com OptiPNG, seu tamanho caiu de 29.2 KB para 9.13 KB.

Segunda imagem, uma foto minha. 200px por 200px exibida em um container de 86px. Redimensionar + otimizar resultou em uma imagem 76% menor.

A última, uma imagem de um dos artigos. Aqui é importante saber a largura do container dos posts. No meu blog é 523px. A imagem já tem esse tamanho, mas eu colei da ferramenta de captura, então não está nada otimizada, além de ser um PNG quando, neste caso, eu não me importo com transparência - poderia perfeitamente ser um JPEG.

Atualizamos as imagens e pronto.
