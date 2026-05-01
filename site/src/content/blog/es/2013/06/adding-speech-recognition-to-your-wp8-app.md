---
title: "Añadir reconocimiento de voz a tu app WP8"
description: "Añade reconocimiento de voz a tu app de Windows Phone 8 usando el control SpeechTextBox del Windows Phone toolkit."
pubDate: 2013-06-23
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "es"
translationOf: "2013/06/adding-speech-recognition-to-your-wp8-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Para añadir reconocimiento de voz a nuestra app usaremos la versión recién publicada del Windows Phone toolkit (release de junio de 2013), que añade un nuevo control llamado SpeechTextBox (que hace exactamente lo que estás pensando). Puedes obtener la última build con NuGet o descargar el código fuente de CodePlex (nota: CodePlex ya ha sido archivado).

Una vez que hayas referenciado el toolkit en tu proyecto, lo único que tienes que hacer es añadir el control:

```xml
<toolkit:SpeechTextBox SpeechRecognized="SpeechTextBox_SpeechRecognized" />
```

Manejar el evento SpeechRecognized no es necesario. Lo he dejado ahí solo para señalar que puedes elegir qué hacer con el resultado del reconocimiento de voz. El evento incluye un parámetro SpeechRecognizedEventArgs que te permite comprobar el nivel de confianza para la frase reconocida y obtener detalles sobre la semántica de la frase.
