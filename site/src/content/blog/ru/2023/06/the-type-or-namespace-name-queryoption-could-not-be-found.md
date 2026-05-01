---
title: "The type or namespace name 'QueryOption' could not be found"
description: "Начиная с Microsoft Graph .NET SDK 5.0, класс QueryOption больше не используется. Вместо него параметры запроса задаются через модификатор requestConfiguration. Если требуется по-прежнему использовать QueryOptions, единственный вариант - откатить пакет Microsoft Graph до версии 4.x."
pubDate: 2023-06-13
updatedDate: 2023-11-05
tags:
  - "microsoft-graph"
lang: "ru"
translationOf: "2023/06/the-type-or-namespace-name-queryoption-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с Microsoft Graph .NET SDK 5.0, класс `QueryOption` больше не используется. Вместо него параметры запроса задаются через модификатор `requestConfiguration`.

Рассмотрим простой пример:

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

Если требуется по-прежнему использовать `QueryOptions`, единственный вариант - откатить пакет Microsoft Graph до версии 4.x.
