---
title: "CSS: как использовать кастомные шрифты"
description: "Узнайте, как использовать кастомные шрифты в CSS3 через правило @font-face: примеры синтаксиса и демо."
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
lang: "ru"
translationOf: "2012/03/css3-custom-fonts"
translatedBy: "claude"
translationDate: 2026-05-01
---
CSS3 позволяет использовать кастомные шрифты через правило `@font-face`. Их очень легко добавлять, синтаксис выглядит так:

```css
@font-face {
    font-family: someFont;
    src: url('path/font.ttf');
}
```

Так вы объявляете шрифт для использования на странице. Пример:

```css
@font-face {
    font-family: CODEBold;
    src: url('../fonts/CODEBold.otf');
}
```

Теперь, чтобы применить кастомный шрифт к тексту, используйте свойство font-family:

```html
<h1 style="font-family: CODEBold">Start Debugging</h1>
```

Отличный источник кастомных шрифтов - [dafont.com](http://www.dafont.com/ "dafont.com")
Вот законченный самодостаточный пример с шрифтом, размещённым Google: вставьте в HTML-файл и откройте в любом браузере.

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
