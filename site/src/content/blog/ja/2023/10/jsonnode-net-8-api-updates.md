---
title: "JsonNode .NET 8 の API アップデート"
description: ".NET 8 で JsonNode と JsonArray に追加された新しい API、GetValueKind、GetPropertyName、GetElementIndex、ReplaceWith、ParseAsync を解説します。"
pubDate: 2023-10-23
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/10/jsonnode-net-8-api-updates"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 の一環として、`JsonNode` と `JsonArray` の API にいくつかの追加が入っています。ディープコピーとディープイコールについては [以前の記事で取り上げました](/2023/10/deep-cloning-and-deep-equality-of-a-jsonnode/) が、それ以外にもあります。

## `GetValueKind`

```cs
public JsonValueKind GetValueKind(JsonSerializerOptions options = null);
```

現在のインスタンスの `JsonValueKind` を返します。

## `GetPropertyName`

```cs
public string GetPropertyName();
```

親オブジェクトから見たときの、現在のノードのプロパティ名を返します。親が `JsonObject` でない場合は `InvalidOperationException` をスローします。

## `GetElementIndex`

```cs
public int GetElementIndex();
```

親 `JsonArray` から見たときの、現在のノードのインデックスを返します。親が `JsonArray` でない場合は `InvalidOperationException` をスローします。

## `ReplaceWith<T>`

```cs
public void ReplaceWith<T>(T value);
```

指定したノードを与えられた値で置き換えます。

## `ParseAsync`

```cs
public static Task<JsonNode?> ParseAsync(
        Stream utf8Json,
        JsonNodeOptions? nodeOptions = null,
        JsonDocumentOptions documentOptions = default,
        CancellationToken cancellationToken = default);
```

単一の JSON 値を表す UTF-8 エンコードのデータストリームを、非同期に `JsonNode` にパースします。
