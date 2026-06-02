---
title: "Текстурный/шумный градиентный фон в CSS"
description: "Как создавать в CSS текстурные, зашумлённые градиентные фоны, комбинируя слои градиента и изображения шума через свойство background-image."
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
lang: "ru"
translationOf: "2012/03/css3-textured-noisy-gradient-background"
translatedBy: "claude"
translationDate: 2026-05-01
---
Текстурные градиентные фоны делаются с помощью градиентов и изображений шума. Для CSS-градиентов можно использовать генератор вроде [этого.](http://www.colorzilla.com/gradient-editor/ "CSS Gradient Generator") Для изображений шума - этот [генератор шума.](http://noisepng.com/ "Noise Generator")

Хитрость текстурных фонов - в комбинации CSS-свойств background. Вместо того чтобы использовать только градиенты или только изображения, почему бы не объединить их так:

```css
background-image: url('../images/noise.png'), -moz-linear-gradient(top, #87e0fd 0%, #53cbf1 40%, #05abe0 100%); /* FF3.6+ */
background-image: url('../images/noise.png'), -webkit-gradient(linear, left top, left bottom, color-stop(0%,#87e0fd), color-stop(40%,#53cbf1), color-stop(100%,#05abe0)); /* Chrome,Safari4+ */
background-image: url('../images/noise.png'), -webkit-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Chrome10+,Safari5.1+ */
background-image: url('../images/noise.png'), -o-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Opera 11.10+ */
background-image: url('../images/noise.png'), -ms-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* IE10+ */
background-image: url('../images/noise.png'), linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* W3C */
```

Да, так можно. Используйте свойство background-image как обычно, добавьте запятую и затем градиент. Сгенерируйте изображение генератором шума, а нужный градиент - генератором градиентов.

Вот законченная самодостаточная версия, которую можно вставить в HTML-файл — она использует встроенный SVG-шум как data URL, поэтому внешних изображений не требуется.

```html
<!doctype html>
<html>
<head>
  <style>
    body {
      min-height: 100vh;
      margin: 0;
      background-image:
        url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.35'/></svg>"),
        linear-gradient(to bottom, #87e0fd 0%, #53cbf1 40%, #05abe0 100%);
    }
  </style>
</head>
<body></body>
</html>
```

Тот же приём работает с любым градиентом — поставьте шум (или любую текстуру) первым в значении `background-image`, разделённом запятыми, чтобы наложить его поверх градиента.
