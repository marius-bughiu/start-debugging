---
title: "Lighthouse のレポート: 画像のサイズを適切に設定する"
description: "Squoosh などのツールを使って画像のサイズを適切に設定し、Web 向けに最適化することで、Lighthouse のパフォーマンススコアを改善します。"
pubDate: 2019-07-28
updatedDate: 2023-11-15
tags:
  - "lighthouse"
lang: "ja"
translationOf: "2019/07/lighthouse-report-properly-size-images"
translatedBy: "claude"
translationDate: 2026-05-01
---
画像のサイズを適切に設定するだけで、ページの読み込み時間を大幅に改善できます。ここでは大きく 2 つのカテゴリーを見ていきます。

-   Web 向けに最適化されていない画像 (未圧縮、不適切な形式)
-   必要以上に解像度が高い画像 (例えば、幅 800px の画像が 300px で表示されている場合)

![Lighthouse の "画像サイズを適切に" レポート](/wp-content/uploads/2019/07/properly-size-images.jpg)

私の場合、トップページに最適化されていない、もしくはサイズが不適切な画像が 3 つあります。最適化には [Squoosh](https://squoosh.app/) を使用します。

1 枚目 -- Outworld Apps のロゴ: 幅 887px だったものが、263px 幅のコンテナーに表示されていました。リサイズして OptiPNG で最適化したところ、サイズは 29.2 KB から 9.13 KB に減りました。

2 枚目 -- 私の写真。200px × 200px が 86px のコンテナーに表示されています。リサイズと最適化で 76% 小さい画像になりました。

最後の 1 枚は、とある記事の画像です。ここでは投稿コンテナーの幅を把握しておくことが重要で、私のブログでは 523px です。画像はすでにそのサイズですが、Snipping Tool からコピー貼り付けしたものなので、まったく最適化されていません。さらに、このケースでは透過性が不要なのに PNG なので、JPEG でも十分でした。

画像を差し替えれば完了です。
