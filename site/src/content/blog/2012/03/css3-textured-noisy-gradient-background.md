---
title: "CSS Textured / Noisy Gradient Background"
description: "Textured gradient backgrounds are made by using gradients and noise images. For CSS gradients you can use a generator like this one. For noise images, again, you can use this noise generator. The trick for making textured backgrounds lays in combining the CSS background properties. Instead of using only gradients as a background or only…"
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
---
Textured gradient backgrounds are made by using gradients and noise images. For CSS gradients you can use a generator like [this one.](http://www.colorzilla.com/gradient-editor/ "CSS Gradient Generator") For noise images, again, you can use this [noise generator.](http://noisepng.com/ "Noise Generator")

The trick for making textured backgrounds lays in combining the CSS background properties. Instead of using only gradients as a background or only images, why not combine them like this:

```css
background-image: url('../images/noise.png'), -moz-linear-gradient(top, #87e0fd 0%, #53cbf1 40%, #05abe0 100%); /* FF3.6+ */
background-image: url('../images/noise.png'), -webkit-gradient(linear, left top, left bottom, color-stop(0%,#87e0fd), color-stop(40%,#53cbf1), color-stop(100%,#05abe0)); /* Chrome,Safari4+ */
background-image: url('../images/noise.png'), -webkit-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Chrome10+,Safari5.1+ */
background-image: url('../images/noise.png'), -o-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Opera 11.10+ */
background-image: url('../images/noise.png'), -ms-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* IE10+ */
background-image: url('../images/noise.png'), linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* W3C */
```

Yea, it’s possible. Just use the background-image property as usual, add a semicolon and then a gradient. Use the noise generator to generate the image and the gradient generator for creating your desired gradient.

You can also check out a demo here: [Textured / Noisy Gradient Background Demo](http://startdebugging.net/demos/noisybackground.html "Textured / Noisy Gradient Background Demo")
