---
title: "The type or namespace name 'QueryOption' could not be found"
description: "Microsoft Graph .NET SDK 5.0 から、QueryOption クラスは使用されなくなりました。代わりにクエリオプションは requestConfiguration 修飾子で設定します。どうしても QueryOptions を使う必要がある場合は、Microsoft Graph パッケージを 4.x にダウングレードするしかありません。"
pubDate: 2023-06-13
updatedDate: 2023-11-05
tags:
  - "microsoft-graph"
lang: "ja"
translationOf: "2023/06/the-type-or-namespace-name-queryoption-could-not-be-found"
translatedBy: "claude"
translationDate: 2026-05-01
---
Microsoft Graph .NET SDK 5.0 から、`QueryOption` クラスは使用されなくなりました。代わりに、クエリオプションは `requestConfiguration` 修飾子で設定します。

簡単な例を見てみましょう。

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

どうしても `QueryOptions` を使う必要がある場合、唯一の選択肢は Microsoft Graph パッケージを 4.x のバージョンにダウングレードすることです。
