---
title: "The type or namespace name 'QueryOption' could not be found"
description: "Ab dem Microsoft Graph .NET SDK 5.0 wird die Klasse QueryOption nicht mehr verwendet. Stattdessen werden Abfrageoptionen über den Modifier requestConfiguration gesetzt. Wenn Sie weiterhin QueryOptions verwenden müssen, bleibt nur das Downgrade des Microsoft Graph Pakets auf eine 4.x-Version."
pubDate: 2023-06-13
updatedDate: 2023-11-05
tags:
  - "microsoft-graph"
lang: "de"
translationOf: "2023/06/the-type-or-namespace-name-queryoption-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab dem Microsoft Graph .NET SDK 5.0 wird die Klasse `QueryOption` nicht mehr verwendet. Stattdessen werden Abfrageoptionen über den Modifier `requestConfiguration` gesetzt.

Sehen wir uns ein einfaches Beispiel an:

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

Wenn Sie weiterhin `QueryOptions` verwenden müssen, bleibt als einzige Alternative das Downgrade des Microsoft Graph Pakets auf eine 4.x-Version.
