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
Демо здесь: [Custom Fonts Demo](http://startdebugging.net/demos/customfonts.html "Custom Fonts Demo")
