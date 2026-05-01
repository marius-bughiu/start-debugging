---
title: "get_category_link が /blog/ を含む誤った URL を生成する"
description: "WordPress の get_category_link がパスに /blog/ を含む誤った URL を生成し、カテゴリーページで 404 になる問題の対処法。"
pubDate: 2020-04-04
updatedDate: 2023-11-05
tags:
  - "wordpress"
lang: "ja"
translationOf: "2020/04/get_category_link-generating-incorrect-url-including-blog"
translatedBy: "claude"
translationDate: 2026-05-01
---
最近ブログに SEO 監査ツールをかけたところ、カテゴリーリンクがすべて 404 になっていました。よく見てみると URL に /blog/ が含まれている一方で、実際に動作する URL はそれが付いていないものでした。次のとおりです。

`https://startdebugging.net/blog/category/opinion/` -- 動作しない
`https://startdebugging.net/category/opinion/` -- 動作する

どうやら原因は、投稿のパーマリンク形式をカスタムにし、ベースに /blog/ を使っていたために、それがカテゴリー URL にも反映されてしまっていたことのようです。

## どう直すか

パーマリンク設定 (Settings > Permalink) で必ず "Category base" を指定してください。私の場合は単に "category" にしました。

![Wordpress, Settings > Permalinks > Category base](/wp-content/uploads/2020/04/image-1.png)
