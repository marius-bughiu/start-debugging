---
title: "JsonNode – .NET 8 API updates"
description: "Explore the new .NET 8 API additions to JsonNode and JsonArray, including GetValueKind, GetPropertyName, GetElementIndex, ReplaceWith, and ParseAsync."
pubDate: 2023-10-23
updatedDate: 2023-11-01
tags:
  - "net"
  - "net-8"
---
Part of .NET 8, `JsonNode` and `JsonArray` get a few new additions to their API. We’ve already covered [deep copy and deep equality in an earlier article](/2023/10/deep-cloning-and-deep-equality-of-a-jsonnode/), but there’s more.

## `GetValueKind`

```cs
public JsonValueKind GetValueKind(JsonSerializerOptions options = null);
```

Returns the `JsonValueKind` of the current instance.

## `GetPropertyName`

```cs
public string GetPropertyName();
```

Returns property name of the current node from the parent object. Throws an `InvalidOperationException` if the parent is not a `JsonObject`.

## `GetElementIndex`

```cs
public int GetElementIndex();
```

Returns the index of the current node from the parent `JsonArray`. Throws an `InvalidOperationException` if the parent is not a `JsonArray`.

## `ReplaceWith<T>`

```cs
public void ReplaceWith<T>(T value);
```

Replaces the given node with the provided value.

## `ParseAsync`

```cs
public static Task<JsonNode?> ParseAsync(
        Stream utf8Json,
        JsonNodeOptions? nodeOptions = null,
        JsonDocumentOptions documentOptions = default,
        CancellationToken cancellationToken = default);
```

Asynchronously parses a stream of UTF-8 encoded data representing a single JSON value into a `JsonNode`.
