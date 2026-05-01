---
title: "Windows 8 で Firefox のタブが妙な色になる問題を直す"
description: "Windows 8 で nVidia 製グラフィックスカードを使うと発生する Firefox のタブ色の glitch を、ハードウェアアクセラレーションを無効にして直す方法。"
pubDate: 2012-11-01
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "ja"
translationOf: "2012/11/fix-firefox-tabs-having-strange-colors-in-windows-8"
translatedBy: "claude"
translationDate: 2026-05-01
---
このグラフィック glitch は、Windows 8 上で動く Firefox の既知のバグです。nVidia のグラフィックスカードを搭載したマシンでのみ発生するようで、ブラウザーのハードウェアアクセラレーションが原因です。

対処は簡単で -- ブラウザーの設定メニューから **ハードウェアアクセラレーションを無効化** するだけです。妙な色は消えますが、残念ながらブラウザーのハードウェアアクセラレーションも消えます。バグが修正されるまでは、これしかできません。

bugzilla の issue はこちらで追えます: [https://bugzilla.mozilla.org/show_bug.cgi?id=686782](https://bugzilla.mozilla.org/show_bug.cgi?id=686782)

設定の場所が分からない場合: オプションウィンドウを開きます (Firefox > Options または Tools > Options) > Advanced > General。そこで "Use hardware acceleration when available" のチェックを外します。これで完了です。

更新: 8 年経って SEO のために更新しますが、バグは直っていません。とはいえ、いまだに Windows 8 を使っている人はいるのでしょうか…？
