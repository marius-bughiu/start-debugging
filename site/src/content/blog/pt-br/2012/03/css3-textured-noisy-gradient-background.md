---
title: "Fundo de gradiente com textura/ruído em CSS"
description: "Como criar fundos de gradiente com textura e ruído em CSS combinando camadas de gradiente e imagens de ruído com a propriedade background-image."
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
lang: "pt-br"
translationOf: "2012/03/css3-textured-noisy-gradient-background"
translatedBy: "claude"
translationDate: 2026-05-01
---
Fundos de gradiente com textura são feitos combinando gradientes e imagens de ruído. Para gradientes CSS você pode usar um gerador como [este.](http://www.colorzilla.com/gradient-editor/ "CSS Gradient Generator") Para imagens de ruído, também dá para usar este [gerador de ruído.](http://noisepng.com/ "Noise Generator")

O truque para criar fundos texturizados está em combinar as propriedades de background do CSS. Em vez de usar só gradientes como fundo, ou só imagens, por que não combinar assim:

```css
background-image: url('../images/noise.png'), -moz-linear-gradient(top, #87e0fd 0%, #53cbf1 40%, #05abe0 100%); /* FF3.6+ */
background-image: url('../images/noise.png'), -webkit-gradient(linear, left top, left bottom, color-stop(0%,#87e0fd), color-stop(40%,#53cbf1), color-stop(100%,#05abe0)); /* Chrome,Safari4+ */
background-image: url('../images/noise.png'), -webkit-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Chrome10+,Safari5.1+ */
background-image: url('../images/noise.png'), -o-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Opera 11.10+ */
background-image: url('../images/noise.png'), -ms-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* IE10+ */
background-image: url('../images/noise.png'), linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* W3C */
```

Sim, dá para fazer. Use a propriedade background-image como de costume, adicione uma vírgula e em seguida um gradiente. Use o gerador de ruído para gerar a imagem e o gerador de gradientes para criar o gradiente desejado.

Você também pode ver uma demo aqui: [Demo de fundo com gradiente e textura/ruído](http://startdebugging.net/demos/noisybackground.html "Textured / Noisy Gradient Background Demo")
