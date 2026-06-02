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
Hier ist ein vollständiges, eigenständiges Beispiel mit einer von Google gehosteten Schriftart, das Sie in eine HTML-Datei einfügen und in jedem Browser öffnen können:

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
