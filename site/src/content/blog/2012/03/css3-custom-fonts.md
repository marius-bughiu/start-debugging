---
title: "CSS How to use Custom Fonts"
description: "Learn how to use custom fonts in CSS3 with the @font-face rule, including syntax examples and a demo."
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
---
CSS3 allows the use of custom fonts through the `@font-face` rule. They are really easy to add and the syntax looks like this:

```css
@font-face {
    font-family: someFont;
    src: url('path/font.ttf');
}
```

This declares a font for use within your web page. An example would be:

```css
@font-face {
    font-family: CODEBold;
    src: url('../fonts/CODEBold.otf');
}
```

Now to apply the custom font to your text you can use the font-family property:

```html
<h1 style="font-family: CODEBold">Start Debugging</h1>
```

A great source for custom fonts would be [dafont.com](http://www.dafont.com/ "dafont.com")  
Here's a complete, self-contained example using a Google-hosted font you can paste into an HTML file and open in any browser:

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
