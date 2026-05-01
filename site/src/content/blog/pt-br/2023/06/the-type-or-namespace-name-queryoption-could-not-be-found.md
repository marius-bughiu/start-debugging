---
title: "The type or namespace name 'QueryOption' could not be found"
description: "A partir do Microsoft Graph .NET SDK 5.0, a classe QueryOption não é mais usada. Em vez disso, as opções de consulta são definidas pelo modificador requestConfiguration. Se você precisa continuar usando QueryOptions, a única alternativa é fazer downgrade do pacote Microsoft Graph para uma versão 4.x."
pubDate: 2023-06-13
updatedDate: 2023-11-05
tags:
  - "microsoft-graph"
lang: "pt-br"
translationOf: "2023/06/the-type-or-namespace-name-queryoption-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do Microsoft Graph .NET SDK 5.0, a classe `QueryOption` não é mais usada. Em vez disso, as opções de consulta são definidas pelo modificador `requestConfiguration`.

Vamos a um exemplo simples:

```cs
var groups = await graphServiceClient
    .Groups
    .GetAsync(requestConfiguration =>
    {
        requestConfiguration.QueryParameters.Select = new string[] { "id", "createdDateTime","displayName"};
        requestConfiguration.QueryParameters.Expand = new string[] { "members" };
        requestConfiguration.QueryParameters.Filter = "startswith(displayName%2C+'J')";
    });
```

Se você precisa continuar usando `QueryOptions`, a única alternativa é fazer downgrade do pacote Microsoft Graph para uma versão 4.x.
