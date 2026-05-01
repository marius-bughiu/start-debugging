---
title: "CSS: Wie man Custom Fonts verwendet"
description: "Erfahren Sie, wie Sie in CSS3 mit der @font-face-Regel benutzerdefinierte Fonts einsetzen, einschließlich Syntaxbeispielen und einer Demo."
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
lang: "de"
translationOf: "2012/03/css3-custom-fonts"
translatedBy: "claude"
translationDate: 2026-05-01
---
CSS3 erlaubt die Nutzung benutzerdefinierter Fonts über die Regel `@font-face`. Sie lassen sich sehr leicht einbinden, die Syntax sieht so aus:

```css
@font-face {
    font-family: someFont;
    src: url('path/font.ttf');
}
```

Damit deklarieren Sie einen Font zur Verwendung in Ihrer Webseite. Ein Beispiel:

```css
@font-face {
    font-family: CODEBold;
    src: url('../fonts/CODEBold.otf');
}
```

Um den Custom Font auf Ihren Text anzuwenden, nutzen Sie die font-family-Eigenschaft:

```html
<h1 style="font-family: CODEBold">Start Debugging</h1>
```

Eine gute Quelle für Custom Fonts ist [dafont.com](http://www.dafont.com/ "dafont.com")
Eine Demo finden Sie hier: [Custom Fonts Demo](http://startdebugging.net/demos/customfonts.html "Custom Fonts Demo")
