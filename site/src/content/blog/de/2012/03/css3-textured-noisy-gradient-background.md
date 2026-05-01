---
title: "CSS-Verlaufshintergrund mit Textur/Noise"
description: "Wie Sie in CSS texturierte, noisy Gradient-Hintergründe erstellen, indem Sie über die background-image-Eigenschaft Gradient- und Noise-Bildebenen kombinieren."
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
lang: "de"
translationOf: "2012/03/css3-textured-noisy-gradient-background"
translatedBy: "claude"
translationDate: 2026-05-01
---
Texturierte Verlaufshintergründe entstehen durch die Kombination von Gradients und Noise-Bildern. Für CSS-Gradients können Sie einen Generator wie [diesen](http://www.colorzilla.com/gradient-editor/ "CSS Gradient Generator") verwenden. Für Noise-Bilder können Sie ebenfalls diesen [Noise-Generator](http://noisepng.com/ "Noise Generator") nutzen.

Der Trick für texturierte Hintergründe liegt darin, die CSS-Background-Eigenschaften zu kombinieren. Statt nur Gradients oder nur Bilder als Hintergrund zu verwenden, warum nicht beides kombinieren, etwa so:

```css
background-image: url('../images/noise.png'), -moz-linear-gradient(top, #87e0fd 0%, #53cbf1 40%, #05abe0 100%); /* FF3.6+ */
background-image: url('../images/noise.png'), -webkit-gradient(linear, left top, left bottom, color-stop(0%,#87e0fd), color-stop(40%,#53cbf1), color-stop(100%,#05abe0)); /* Chrome,Safari4+ */
background-image: url('../images/noise.png'), -webkit-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Chrome10+,Safari5.1+ */
background-image: url('../images/noise.png'), -o-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Opera 11.10+ */
background-image: url('../images/noise.png'), -ms-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* IE10+ */
background-image: url('../images/noise.png'), linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* W3C */
```

Ja, das geht. Nutzen Sie einfach die background-image-Eigenschaft wie gewohnt, fügen Sie ein Komma hinzu und dann einen Gradient. Verwenden Sie den Noise-Generator, um das Bild zu erzeugen, und den Gradient-Generator, um Ihren gewünschten Gradient zu erstellen.

Eine Demo finden Sie hier: [Textured / Noisy Gradient Background Demo](http://startdebugging.net/demos/noisybackground.html "Textured / Noisy Gradient Background Demo")
