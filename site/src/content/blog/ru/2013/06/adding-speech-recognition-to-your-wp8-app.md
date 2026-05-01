---
title: "Добавляем распознавание речи в приложение WP8"
description: "Добавьте распознавание речи в ваше приложение Windows Phone 8 с помощью контрола SpeechTextBox из Windows Phone toolkit."
pubDate: 2013-06-23
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "ru"
translationOf: "2013/06/adding-speech-recognition-to-your-wp8-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Чтобы добавить распознавание речи в наше приложение, воспользуемся свежевыпущенной версией Windows Phone toolkit (релиз июня 2013), в которой появился симпатичный новый контрол SpeechTextBox (делающий именно то, о чём вы подумали). Последнюю сборку можно получить через NuGet или скачать исходники с CodePlex (примечание: CodePlex с тех пор архивирован).

После того как добавили ссылку на toolkit в проекте, нужно лишь добавить контрол:

```xml
<toolkit:SpeechTextBox SpeechRecognized="SpeechTextBox_SpeechRecognized" />
```

Обрабатывать событие SpeechRecognized необязательно. Я оставил его, чтобы показать, что вы сами можете решать, что делать с результатом распознавания речи. Событие приходит с параметром SpeechRecognizedEventArgs, через который можно узнать уровень уверенности по распознанной фразе и получить детали о её семантике.
