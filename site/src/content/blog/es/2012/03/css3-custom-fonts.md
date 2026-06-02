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
Aquí tienes un ejemplo completo y autocontenido usando una fuente alojada por Google que puedes pegar en un archivo HTML y abrir en cualquier navegador:

```html
<!doctype html>
<html>
<head>
  <style>
    @font-face {
      font-family: "Press Start 2P";
      src: url("https://fonts.gstatic.com/s/pressstart2p/v17/e3t4euO8T-267oIAQAu6jDQyK3nVivM.woff2") format("woff2");
    }

    h1 {
      font-family: "Press Start 2P", monospace;
      font-size: 32px;
    }
  </style>
</head>
<body>
  <h1>Start Debugging</h1>
</body>
</html>
```
