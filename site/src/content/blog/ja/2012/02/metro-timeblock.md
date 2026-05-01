---
title: "Metro TimeBlock"
description: "Metro TimeBlock は、色、背景、サイズを自由に設定できる、Windows Phone 用のカスタマイズ可能な時刻表示コントロールです。"
pubDate: 2012-02-08
updatedDate: 2023-11-05
tags:
  - "metro"
  - "windows-phone"
lang: "ja"
translationOf: "2012/02/metro-timeblock"
translatedBy: "claude"
translationDate: 2026-05-01
---
Metro TimeBlock は私が作った時刻表示コントロールで、好きな色、好きな背景で時刻を表示できます。サイズも調整可能で、現在時刻を表示するか、独自の時刻を表示するかを選べます。

[![Metro TimeBlock](https://lh4.googleusercontent.com/--uwO3WD479Q/TzK6qBeZ-FI/AAAAAAAAAEM/JekVV927X8o/s640/metroTimeBlock.png)](https://lh4.googleusercontent.com/--uwO3WD479Q/TzK6qBeZ-FI/AAAAAAAAAEM/JekVV927X8o/s640/metroTimeBlock.png)

コントロールのプロパティ:

**Time** -- 任意の DateTime オブジェクトを受け取ります。コントロールは、その DateTime に含まれる Time を表示します。現在時刻を表示したい場合は空のままにしてください。

**Spacer** -- 時と分の間、分と秒の間に表示する文字列です。":" や " " のような区切り文字を使ってください。

**Size** -- **Small、Normal、Medium、MediumLarge、Large、ExtraLarge、ExtraExtraLarge、Huge** から選べます。FontSize を許可するのではなく、こうした選択肢にしたのは、背景ブロックの見た目もコントロールしたかったからです。

**Foreground** -- 時刻表示に使う色を指定します。

**Fill** -- コントロールの背景色 (四角いブロック) を設定します。

だいたいそんなところです。問題があったり助けが必要だったりしたら、下のコメントへどうぞ。コードは [こちらのリンク](https://www.dropbox.com/s/mjiba8cugtj8fdz/StartDebugging.zip?dl=0) からダウンロードできます。コントロール本体といくつかのサンプルが含まれています。
