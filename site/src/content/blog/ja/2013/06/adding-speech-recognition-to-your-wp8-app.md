---
title: "WP8 アプリに音声認識を追加する"
description: "Windows Phone toolkit の SpeechTextBox コントロールを使って、Windows Phone 8 アプリに音声認識を追加します。"
pubDate: 2013-06-23
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "ja"
translationOf: "2013/06/adding-speech-recognition-to-your-wp8-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
アプリに音声認識を追加するため、リリースされたばかりのバージョンの Windows Phone toolkit (2013 年 6 月リリース) を使います。これには SpeechTextBox という、まさに名前のとおりの新コントロールが追加されています。最新ビルドは NuGet で入手するか、CodePlex から ソースをダウンロードできます (メモ: CodePlex は現在アーカイブ化されています)。

プロジェクトで toolkit を参照したら、あとはコントロールを追加するだけです。

```xml
<toolkit:SpeechTextBox SpeechRecognized="SpeechTextBox_SpeechRecognized" />
```

SpeechRecognized イベントの処理は必須ではありません。ただ、認識結果に対して何をするかを自分で選べる、ということを示すために残しています。このイベントには SpeechRecognizedEventArgs パラメーターが付いており、認識されたフレーズの信頼度を確認したり、フレーズのセマンティクスの詳細を取得したりできます。
