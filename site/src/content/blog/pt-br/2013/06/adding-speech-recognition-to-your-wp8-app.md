---
title: "Adicionando reconhecimento de voz ao seu app WP8"
description: "Adicione reconhecimento de voz ao seu app Windows Phone 8 usando o controle SpeechTextBox do Windows Phone toolkit."
pubDate: 2013-06-23
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "windows-phone"
lang: "pt-br"
translationOf: "2013/06/adding-speech-recognition-to-your-wp8-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Para adicionar reconhecimento de voz ao nosso app, vamos usar a versão recém-lançada do Windows Phone toolkit (release de junho de 2013), que adiciona um controle bem legal chamado SpeechTextBox (que faz exatamente o que você imagina). Você pode pegar a última build pelo NuGet ou baixar o código-fonte do CodePlex (observação: o CodePlex já foi arquivado).

Depois de referenciar o toolkit no seu projeto, basta adicionar o controle:

```xml
<toolkit:SpeechTextBox SpeechRecognized="SpeechTextBox_SpeechRecognized" />
```

Tratar o evento SpeechRecognized não é obrigatório. Deixei aí só para mostrar que você pode escolher o que fazer com o resultado do reconhecimento de voz. O evento traz um parâmetro SpeechRecognizedEventArgs que permite verificar o nível de confiança da frase reconhecida e também obter detalhes sobre a semântica.
