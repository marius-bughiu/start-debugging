---
title: "Visual Studio 2013 の Hybrid Apps が使用する Cordova バージョンを変更する"
description: "Visual Studio 2013 の Hybrid Apps で使われる Cordova バージョンを、platforms.js を編集して更新する方法。"
pubDate: 2014-11-08
updatedDate: 2023-11-05
tags:
  - "android"
  - "visual-studio"
lang: "ja"
translationOf: "2014/11/changing-cordova-version-used-hybrid-apps-visual-studio-2013"
translatedBy: "claude"
translationDate: 2026-05-01
---
Cordova のバージョンを更新するには、次の場所にある **platforms.js** を編集する必要があります。

`%APPDATA%\Roaming\npm\node_modules\vs-mda\node_modules\cordova\node_modules\cord‌​ova-lib\src\cordova`

プラットフォームごとに個別にバージョンを変更できますが、すべてで同じバージョンを使うことをおすすめします。
また、単に Cordova 3.5.0 にあるハイ深刻度の cross-application scripting (XAS) 脆弱性に関する Google Play の警告のために更新したい、という場合もあるでしょう。その場合は、該当の脆弱性を修正したバージョン 3.5.1 を指す更新済みのファイルがこちらです: [platforms.js](https://www.dropbox.com/s/c475yechp5crd2p/platforms.js?dl=0 "Download platforms.js") (メモ: この Dropbox のリンクはすでに利用できない可能性があります)。

メモ: Hybrid Apps の CTP 1 を使用している場合、パスは異なります:
`%APPDATA%\npm\node_modules\vs-mda\node_modules\cordova\`
