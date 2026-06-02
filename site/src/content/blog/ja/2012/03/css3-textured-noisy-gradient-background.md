---
title: "CSS で作るテクスチャ／ノイズ入り gradient 背景"
description: "background-image プロパティで gradient とノイズ画像のレイヤーを組み合わせ、CSS でテクスチャ／ノイズ入りの gradient 背景を作る方法を解説します。"
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
lang: "ja"
translationOf: "2012/03/css3-textured-noisy-gradient-background"
translatedBy: "claude"
translationDate: 2026-05-01
---
テクスチャ入りの gradient 背景は、gradient とノイズ画像を組み合わせて作ります。CSS gradient には [このような生成ツール](http://www.colorzilla.com/gradient-editor/ "CSS Gradient Generator") を使えます。ノイズ画像にも、こちらの [ノイズ生成ツール](http://noisepng.com/ "Noise Generator") を使えます。

テクスチャ背景のコツは、CSS の background プロパティを組み合わせる点にあります。背景に gradient だけ、あるいは画像だけを使うのではなく、次のように両方を組み合わせてみてはどうでしょうか。

```css
background-image: url('../images/noise.png'), -moz-linear-gradient(top, #87e0fd 0%, #53cbf1 40%, #05abe0 100%); /* FF3.6+ */
background-image: url('../images/noise.png'), -webkit-gradient(linear, left top, left bottom, color-stop(0%,#87e0fd), color-stop(40%,#53cbf1), color-stop(100%,#05abe0)); /* Chrome,Safari4+ */
background-image: url('../images/noise.png'), -webkit-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Chrome10+,Safari5.1+ */
background-image: url('../images/noise.png'), -o-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* Opera 11.10+ */
background-image: url('../images/noise.png'), -ms-linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* IE10+ */
background-image: url('../images/noise.png'), linear-gradient(top, #87e0fd 0%,#53cbf1 40%,#05abe0 100%); /* W3C */
```

そう、これは可能です。background-image プロパティを通常どおり使い、カンマを入れて、続けて gradient を書きます。ノイズ画像はノイズ生成ツールで作成し、gradient は gradient 生成ツールで好みのものを作ってください。

完結した自己完結版です。HTML ファイルに貼り付けるだけで動きます。インライン SVG をデータ URL として使うので、外部画像の依存はありません。

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

同じやり方はどんなグラデーションでも動きます。`background-image` のカンマ区切り値の先頭にノイズ (または任意のテクスチャ画像) を置けば、グラデーションの上に重ねられます。
