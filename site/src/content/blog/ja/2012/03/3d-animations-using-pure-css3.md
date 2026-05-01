---
title: "純粋な CSS3 だけで作る 3D アニメーション"
description: "WebKit と Firefox に対応した形で、CSS3 の perspective と transform transition だけで 3D アニメーションを作る方法を学びます。"
pubDate: 2012-03-04
updatedDate: 2023-11-05
tags:
  - "css"
lang: "ja"
translationOf: "2012/03/3d-animations-using-pure-css3"
translatedBy: "claude"
translationDate: 2026-05-01
---
私がこの記事と関連するいくつかの記事を書こうと思ったきっかけは [このページ](http://demo.marcofolio.net/3d_animation_css3/ "CSS3 3D Animations") (Chrome と Safari でのみ動作) です。CSS だけでここまでできるのは驚きです。中身を覗いてみましょう -- このエフェクトの CSS は次のようになっています。

```css
#movieposters li { 
    display:inline; float:left;
    -webkit-perspective: 500; -webkit-transform-style: preserve-3d;
    -webkit-transition-property: perspective; -webkit-transition-duration: 0.5s; 
}

#movieposters li:hover { 
    -webkit-perspective: 5000; 
}

#movieposters li img { 
    border:10px solid #fcfafa; 
    -webkit-transform: rotateY(30deg);
    -moz-box-shadow:0 3px 10px #888; 
    -webkit-box-shadow:0 3px 10px #888;
    -webkit-transition-property: transform; 
    -webkit-transition-duration: 0.5s; 
}

#movieposters li:hover img { 
    -webkit-transform: rotateY(0deg); 
}
```

ややごちゃごちゃしています。ですが、border と shadow を取り除いてコードを少し整理すると、実はそれほど複雑ではないことが分かります。

```css
#movieposters li {
    display:inline; float:left;
    -webkit-perspective: 500;
    -webkit-transform-style: preserve-3d;
    -webkit-transition-property: perspective;
    -webkit-transition-duration: 0.5s;
}

#movieposters li:hover {
    -webkit-perspective: 5000;
}

#movieposters li img {
    -webkit-transform: rotateY(30deg);
    -webkit-transition-property: transform;
    -webkit-transition-duration: 0.5s;
}

#movieposters li:hover img {
    -webkit-transform: rotateY(0deg);
}
```

ご覧のとおり、本質的には 2 つのトランジションです。

-   list item に対する perspective のトランジション。hover 時に 500 から 5000 へ、所要時間 0.5s
-   list item 内の画像に対する transform のローテーショントランジション。同じ所要時間で、30 度から 0 度へ

値をいろいろ変えて、どんな素敵な効果が得られるか試してみてください。良い効果ができたら、そのリンクをコメントで教えてくれてもよいです。

## Firefox で動かす

本当に気になったのは、Firefox では動かないという点でした。なぜか？Google で何度か検索すると答えは明らかでした -- -webkit- 系のコマンドは webkit ベースのブラウザー向けで、Firefox は -moz- プレフィックスのコマンドを必要とします。本当はとうに知っていてしかるべきでした……。

そこでコマンドごとに新しい行を追加し、-webkit- を -moz- に置き換えれば動くと思ったのです。動きはしましたが、アニメーションが起きない、という問題が残りました。検索を重ねても答えが出ないので、開発者の真の精神に則って stackoverflow.com に行き、質問しました。数時間後、最初の回答が付き、幸いそこに私の問題の解決策がありました ([こちらで確認できます](http://stackoverflow.com/questions/9549624/moz-transition-duration-not-working "Firefox Transitions not working"))。transition-property も -moz- 付きのプロパティにする必要があります。webkit のように transform や perspective のような単純なプロパティは効かないので、代わりに -moz-transform と -moz-perspective を使う必要がありました。

最終的に使った CSS の全体は次のとおりです。

```css
#movieposters li {
    display:inline; float:left;
    -webkit-perspective: 500;
    -webkit-transform-style: preserve-3d;
    -webkit-transition-property: perspective;
    -webkit-transition-duration: 0.5s;
    -moz-transition-duration: 0.5s;
    -moz-perspective: 500;
    -moz-transform-style: preserve-3d;
    -moz-transition-property: -moz-perspective;
}

#movieposters li:hover {
    -webkit-perspective: 5000;
    -moz-perspective: 5000;
}

#movieposters li img {
    -webkit-transform: rotateY(30deg);
    -webkit-transition-property: transform;
    -webkit-transition-duration: 0.5s;
    -moz-transition-duration: 0.5s;
    -moz-transform: rotateY(30deg);
    -moz-transition-property: -moz-transform;
    width: 210px;
}

#movieposters li:hover img {
    -webkit-transform: rotateY(0deg);
    -moz-transform: rotateY(0deg);
}
```

デモはこちらです: [3D CSS Animation](http://startdebugging.net/demos/3dcssanimation.html "3D CSS Animation")
