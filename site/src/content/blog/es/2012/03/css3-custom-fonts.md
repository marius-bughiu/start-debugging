---
title: "CSS: cómo usar fuentes personalizadas"
description: "Aprende a usar fuentes personalizadas en CSS3 con la regla @font-face, incluyendo ejemplos de sintaxis y una demo."
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
lang: "es"
translationOf: "2012/03/css3-custom-fonts"
translatedBy: "claude"
translationDate: 2026-05-01
---
CSS3 permite usar fuentes personalizadas mediante la regla `@font-face`. Son realmente fáciles de añadir y la sintaxis es así:

```css
@font-face {
    font-family: someFont;
    src: url('path/font.ttf');
}
```

Esto declara una fuente para usar dentro de tu página web. Un ejemplo sería:

```css
@font-face {
    font-family: CODEBold;
    src: url('../fonts/CODEBold.otf');
}
```

Ahora, para aplicar la fuente personalizada a tu texto puedes usar la propiedad font-family:

```html
<h1 style="font-family: CODEBold">Start Debugging</h1>
```

Una gran fuente para tipografías personalizadas es [dafont.com](http://www.dafont.com/ "dafont.com")
Mira una demo aquí: [Custom Fonts Demo](http://startdebugging.net/demos/customfonts.html "Custom Fonts Demo")
