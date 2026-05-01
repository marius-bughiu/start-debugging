---
title: "Spracherkennung zu Ihrer WP8-App hinzufügen"
description: "Fügen Sie Ihrer Windows-Phone-8-App Spracherkennung hinzu, indem Sie das SpeechTextBox-Control aus dem Windows Phone Toolkit verwenden."
pubDate: 2013-06-23
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "de"
translationOf: "2013/06/adding-speech-recognition-to-your-wp8-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Für die Spracherkennung in unserer App nutzen wir die kürzlich veröffentlichte Version des Windows Phone Toolkits (Release Juni 2013), die ein nettes neues Control namens SpeechTextBox bringt (das genau das tut, was Sie sich darunter vorstellen). Den neuesten Build erhalten Sie über NuGet, oder Sie laden den Quellcode von CodePlex (Hinweis: CodePlex wurde inzwischen archiviert).

Sobald Sie das Toolkit in Ihrem Projekt referenziert haben, müssen Sie nur noch das Control einfügen:

```xml
<toolkit:SpeechTextBox SpeechRecognized="SpeechTextBox_SpeechRecognized" />
```

Das Behandeln des SpeechRecognized-Events ist nicht zwingend erforderlich. Ich habe es nur eingefügt, um zu zeigen, dass Sie selbst entscheiden können, was mit dem Ergebnis der Spracherkennung passiert. Das Event liefert einen SpeechRecognizedEventArgs-Parameter, mit dem Sie den Konfidenzwert für die erkannte Phrase prüfen und Details zur Phrase-Semantik abrufen können.
