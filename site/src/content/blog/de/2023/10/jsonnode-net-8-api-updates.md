---
title: "JsonNode API-Neuerungen in .NET 8"
description: "Entdecken Sie die neuen API-Erweiterungen in .NET 8 für JsonNode und JsonArray, darunter GetValueKind, GetPropertyName, GetElementIndex, ReplaceWith und ParseAsync."
pubDate: 2023-10-23
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/10/jsonnode-net-8-api-updates"
translatedBy: "claude"
translationDate: 2026-05-01
---
Mit .NET 8 erhalten `JsonNode` und `JsonArray` einige neue API-Erweiterungen. Über [Deep Copy und Deep Equality haben wir bereits in einem früheren Artikel berichtet](/2023/10/deep-cloning-and-deep-equality-of-a-jsonnode/), aber es gibt noch mehr.

## `GetValueKind`

```cs
public JsonValueKind GetValueKind(JsonSerializerOptions options = null);
```

Gibt den `JsonValueKind` der aktuellen Instanz zurück.

## `GetPropertyName`

```cs
public string GetPropertyName();
```

Gibt den Property-Namen des aktuellen Knotens im übergeordneten Objekt zurück. Wirft eine `InvalidOperationException`, wenn das übergeordnete Element kein `JsonObject` ist.

## `GetElementIndex`

```cs
public int GetElementIndex();
```

Gibt den Index des aktuellen Knotens im übergeordneten `JsonArray` zurück. Wirft eine `InvalidOperationException`, wenn das übergeordnete Element kein `JsonArray` ist.

## `ReplaceWith<T>`

```cs
public void ReplaceWith<T>(T value);
```

Ersetzt den angegebenen Knoten durch den übergebenen Wert.

## `ParseAsync`

```cs
public static Task<JsonNode?> ParseAsync(
        Stream utf8Json,
        JsonNodeOptions? nodeOptions = null,
        JsonDocumentOptions documentOptions = default,
        CancellationToken cancellationToken = default);
```

Parst asynchron einen Stream UTF-8-kodierter Daten, der einen einzelnen JSON-Wert darstellt, in einen `JsonNode`.
