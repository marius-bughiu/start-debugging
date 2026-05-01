---
title: "Como usar appsettings.json com Xamarin.Forms"
description: "Aprenda a usar arquivos de configuração appsettings.json com Xamarin.Forms embutindo o arquivo como recurso e construindo um objeto IConfiguration."
pubDate: 2020-11-13
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "xamarin-forms"
lang: "pt-br"
translationOf: "2020/11/how-to-use-appsettings-json-with-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
Há duas diferenças-chave em relação ao ASP.NET:

-   primeiro, trabalharemos com um Embedded Resource em vez de um arquivo em disco
-   segundo, registraremos o arquivo `appsettings.json` por conta própria

Para começar, adicione um arquivo `appsettings.json` no seu projeto compartilhado. Garanta que o `Build Action` esteja como `Embedded Resource`. Adicione algumas chaves + valores no arquivo que possamos usar para teste. Por exemplo:

```json
{
  "ChatHubUrl": "https://signalrchatweb.azurewebsites.net/"
}
```

Em seguida, precisamos obter o stream do recurso.

```cs
Stream resourceStream = GetType().GetTypeInfo().Assembly.GetManifestResourceStream("SignalRChat.appsettings.json");
```

E usá-lo para construir um objeto `IConfiguration`.

```cs
var configuration = new ConfigurationBuilder()
                .AddJsonStream(resourceStream)
                .Build();
```

Agora, para extrair os valores de configuração dele, use-o como faria com qualquer outro dicionário.

```cs
configuration["ChatHubUrl"];
```

Outra opção é registrá-lo no seu container de IoC como um `IConfiguration`, injetá-lo nos seus viewmodels e usá-lo da mesma forma.

Um exemplo completo costumava ficar no repositório Xamarin Forms -- SignalR Chat no GitHub, que não está mais disponível.
