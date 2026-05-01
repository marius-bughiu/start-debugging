---
title: "JsonNode actualizaciones de API en .NET 8"
description: "Explora las nuevas APIs añadidas en .NET 8 a JsonNode y JsonArray, incluidas GetValueKind, GetPropertyName, GetElementIndex, ReplaceWith y ParseAsync."
pubDate: 2023-10-23
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/10/jsonnode-net-8-api-updates"
translatedBy: "claude"
translationDate: 2026-05-01
---
Como parte de .NET 8, `JsonNode` y `JsonArray` reciben algunas incorporaciones nuevas a su API. Ya cubrimos [deep copy y deep equality en un artículo anterior](/2023/10/deep-cloning-and-deep-equality-of-a-jsonnode/), pero hay más.

## `GetValueKind`

```cs
public JsonValueKind GetValueKind(JsonSerializerOptions options = null);
```

Devuelve el `JsonValueKind` de la instancia actual.

## `GetPropertyName`

```cs
public string GetPropertyName();
```

Devuelve el nombre de la propiedad del nodo actual dentro del objeto padre. Lanza una `InvalidOperationException` si el padre no es un `JsonObject`.

## `GetElementIndex`

```cs
public int GetElementIndex();
```

Devuelve el índice del nodo actual dentro del `JsonArray` padre. Lanza una `InvalidOperationException` si el padre no es un `JsonArray`.

## `ReplaceWith<T>`

```cs
public void ReplaceWith<T>(T value);
```

Reemplaza el nodo dado con el valor proporcionado.

## `ParseAsync`

```cs
public static Task<JsonNode?> ParseAsync(
        Stream utf8Json,
        JsonNodeOptions? nodeOptions = null,
        JsonDocumentOptions documentOptions = default,
        CancellationToken cancellationToken = default);
```

Parsea de forma asíncrona un stream de datos codificados en UTF-8 que representan un único valor JSON, convirtiéndolo en un `JsonNode`.
