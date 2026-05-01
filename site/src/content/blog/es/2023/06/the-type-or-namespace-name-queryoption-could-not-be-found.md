---
title: "The type or namespace name 'QueryOption' could not be found"
description: "A partir del SDK 5.0 de Microsoft Graph .NET, la clase QueryOption ya no se utiliza. En su lugar, las opciones de consulta se definen mediante el modificador requestConfiguration. Si necesitas seguir usando QueryOptions, la única alternativa es bajar la versión del paquete Microsoft Graph a una 4.x."
pubDate: 2023-06-13
updatedDate: 2023-11-05
tags:
  - "microsoft-graph"
lang: "es"
translationOf: "2023/06/the-type-or-namespace-name-queryoption-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir del SDK 5.0 de Microsoft Graph .NET, la clase `QueryOption` ya no se utiliza. En su lugar, las opciones de consulta se definen mediante el modificador `requestConfiguration`.

Veamos un ejemplo simple:

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

Si necesitas seguir usando `QueryOptions`, la única alternativa es bajar la versión del paquete Microsoft Graph a una 4.x.
