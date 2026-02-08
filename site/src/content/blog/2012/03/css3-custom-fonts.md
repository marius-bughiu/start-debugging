---
title: "CSS How to use Custom Fonts"
description: "CSS3 allows the use of custom fonts trough the @font-face rule. They are really easy to add and the syntax looks like this: This declares a font for use within your web page. An example would be: Now to apply the custom font to your text you can use the font-family property: A great source…"
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
---
CSS3 allows the use of custom fonts trough the `@font-face` rule. They are really easy to add and the syntax looks like this:

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

```xml
<h1 style="font-family: CODEBold">Start Debugging</h1>
```

A great source for custom fonts would be [dafont.com](http://www.dafont.com/ "dafont.com")  
Check out a demo here: [Custom Fonts Demo](http://startdebugging.net/demos/customfonts.html "Custom Fonts Demo")
