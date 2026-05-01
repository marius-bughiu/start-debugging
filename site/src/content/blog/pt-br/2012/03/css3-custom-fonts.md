---
title: "CSS: como usar fontes personalizadas"
description: "Aprenda a usar fontes personalizadas em CSS3 com a regra @font-face, com exemplos de sintaxe e uma demo."
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
lang: "pt-br"
translationOf: "2012/03/css3-custom-fonts"
translatedBy: "claude"
translationDate: 2026-05-01
---
O CSS3 permite usar fontes personalizadas com a regra `@font-face`. São bem fáceis de adicionar e a sintaxe é assim:

```css
@font-face {
    font-family: someFont;
    src: url('path/font.ttf');
}
```

Isso declara uma fonte para uso dentro da sua página. Um exemplo:

```css
@font-face {
    font-family: CODEBold;
    src: url('../fonts/CODEBold.otf');
}
```

Para aplicar a fonte personalizada ao seu texto, use a propriedade font-family:

```html
<h1 style="font-family: CODEBold">Start Debugging</h1>
```

Uma ótima fonte para tipografias personalizadas é o [dafont.com](http://www.dafont.com/ "dafont.com")
Veja uma demo aqui: [Custom Fonts Demo](http://startdebugging.net/demos/customfonts.html "Custom Fonts Demo")
