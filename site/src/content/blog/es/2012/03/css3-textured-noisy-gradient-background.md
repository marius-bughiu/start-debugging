---
title: "Fondo de gradiente con textura/ruido en CSS"
description: "Cómo crear fondos de gradiente con textura y ruido en CSS combinando capas de gradiente y de imagen de ruido mediante la propiedad background-image."
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
lang: "es"
translationOf: "2012/03/css3-textured-noisy-gradient-background"
translatedBy: "claude"
translationDate: 2026-05-01
---
Los fondos de gradiente con textura se hacen usando gradientes e imágenes de ruido. Para los gradientes CSS puedes usar un generador como [este.](http://www.colorzilla.com/gradient-editor/ "CSS Gradient Generator") Para imágenes de ruido, también puedes usar este [generador de ruido.](http://noisepng.com/ "Noise Generator")

El truco para hacer fondos con textura está en combinar las propiedades de background de CSS. En lugar de usar solo gradientes como fondo o solo imágenes, ¿por qué no combinarlos así:

```css
background-image: url('../images/noise.png'), -moz-linear-gradient(top, #87e0fd 0%, #53cbf1 40%, #05abe0 100%); /* FF3.6+ */
background-image: url('../images/noise.png'), -webkit-gradient(linear, left top, left bottom, color-stop(0%,#87e0fd), color-stop(40%,#53cbf1), color-stop(100%,#05abe0)); /* Chrome,Safari4+ */
background-image: url('../images/noise.png'), -webkit-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Chrome10+,Safari5.1+ */
background-image: url('../images/noise.png'), -o-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Opera 11.10+ */
background-image: url('../images/noise.png'), -ms-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* IE10+ */
background-image: url('../images/noise.png'), linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* W3C */
```

Sí, se puede. Simplemente usa la propiedad background-image como de costumbre, añade una coma y después un gradiente. Usa el generador de ruido para generar la imagen y el generador de gradientes para crear el gradiente que quieras.

También puedes ver una demo aquí: [Demo de fondo con gradiente y textura/ruido](http://startdebugging.net/demos/noisybackground.html "Textured / Noisy Gradient Background Demo")
