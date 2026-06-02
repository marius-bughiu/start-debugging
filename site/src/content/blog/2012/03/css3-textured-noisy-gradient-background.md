---
title: "CSS Textured / Noisy Gradient Background"
description: "How to create textured, noisy gradient backgrounds in CSS by combining gradient and noise image layers using the background-image property."
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
---
Textured gradient backgrounds are made by using gradients and noise images. For CSS gradients you can use a generator like [this one.](http://www.colorzilla.com/gradient-editor/ "CSS Gradient Generator") For noise images, again, you can use this [noise generator.](http://noisepng.com/ "Noise Generator")

The trick for making textured backgrounds lies in combining the CSS background properties. Instead of using only gradients as a background or only images, why not combine them like this:

```css
background-image: url('../images/noise.png'), -moz-linear-gradient(top, #87e0fd 0%, #53cbf1 40%, #05abe0 100%); /* FF3.6+ */
background-image: url('../images/noise.png'), -webkit-gradient(linear, left top, left bottom, color-stop(0%,#87e0fd), color-stop(40%,#53cbf1), color-stop(100%,#05abe0)); /* Chrome,Safari4+ */
background-image: url('../images/noise.png'), -webkit-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Chrome10+,Safari5.1+ */
background-image: url('../images/noise.png'), -o-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Opera 11.10+ */
background-image: url('../images/noise.png'), -ms-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* IE10+ */
background-image: url('../images/noise.png'), linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* W3C */
```

Yes, it's possible. Just use the background-image property as usual, add a comma and then a gradient. Use the noise generator to generate the image and the gradient generator for creating your desired gradient.

Here's a complete, self-contained version you can paste into an HTML file — it uses inline SVG noise as a data URL so there are no external image dependencies:

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

The same trick works with any gradient — list the noise (or any texture image) first in the comma-separated `background-image` value to stack it on top of the gradient.
