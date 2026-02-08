---
title: "The type or namespace name ‘QueryOption’ could not be found"
description: "Starting with Microsoft Graph .NET SDK 5.0, the QueryOption class is no longer used. Instead, query options are set using the requestConfiguration modifier. Let’s take a simple example: If you must use QueryOptions, your only alternative is to downgrade the Microsoft Graph package to a 4.x version."
pubDate: 2023-06-13
updatedDate: 2023-11-05
tags:
  - "microsoft-graph"
---
Starting with Microsoft Graph .NET SDK 5.0, the `QueryOption` class is no longer used. Instead, query options are set using the `requestConfiguration` modifier.

Let’s take a simple example:

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

If you must use `QueryOptions`, your only alternative is to downgrade the Microsoft Graph package to a 4.x version.
