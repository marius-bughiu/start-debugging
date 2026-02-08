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
Check out a demo here: [Custom Fonts Demo](http://startdebugging.net/demos/customfonts.html "Custom Fonts Demo")
