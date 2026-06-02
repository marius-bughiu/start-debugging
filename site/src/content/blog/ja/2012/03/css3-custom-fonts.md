---
title: "CSS でカスタムフォントを使う方法"
description: "@font-face ルールを使って CSS3 でカスタムフォントを使う方法を、構文の例とデモを交えて解説します。"
pubDate: 2012-03-02
updatedDate: 2023-11-05
tags:
  - "css"
lang: "ja"
translationOf: "2012/03/css3-custom-fonts"
translatedBy: "claude"
translationDate: 2026-05-01
---
CSS3 では `@font-face` ルールを使ってカスタムフォントを利用できます。追加はとても簡単で、構文は次のとおりです。

```css
@font-face {
    font-family: someFont;
    src: url('path/font.ttf');
}
```

これでフォントをページ内で使用できるよう宣言できます。例えば次のような記述です。

```css
@font-face {
    font-family: CODEBold;
    src: url('../fonts/CODEBold.otf');
}
```

カスタムフォントをテキストに適用するには、font-family プロパティを使います。

```html
<h1 style="font-family: CODEBold">Start Debugging</h1>
```

カスタムフォントの良い入手先としては [dafont.com](http://www.dafont.com/ "dafont.com") があります。
Google がホストしているフォントを使った、HTML ファイルに貼り付けてどのブラウザーでも開ける完結したサンプルです。

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
