---
title: "Adding speech recognition to your WP8 app"
description: "Add speech recognition to your Windows Phone 8 app using the SpeechTextBox control from the Windows Phone toolkit."
pubDate: 2013-06-23
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
---
To add speech recognition to our app we will be using the newly released version of the Windows Phone toolkit (release June 2013) – which adds a nice new control called SpeechTextBox (that does exactly what you think). You can get the latest build using NuGet or you can download the source from CodePlex (note: CodePlex has since been archived).

Once you've referenced the toolkit in your project, all you need to do is add the control:

```xml
<toolkit:SpeechTextBox SpeechRecognized="SpeechTextBox_SpeechRecognized" />
```

Handling the SpeechRecognized event is not necessary. I’ve left it there just to point out that you can choose what you want to do with the speech recognition result. The event comes with a SpeechRecognizedEventArgs parameter which allows you to check the level of confidence for the recognized phrase and also get details about the phrase semantics.
