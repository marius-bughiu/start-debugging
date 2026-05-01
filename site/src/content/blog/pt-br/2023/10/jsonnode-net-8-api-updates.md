---
title: "JsonNode atualizações de API no .NET 8"
description: "Confira as novas APIs adicionadas ao JsonNode e ao JsonArray no .NET 8, incluindo GetValueKind, GetPropertyName, GetElementIndex, ReplaceWith e ParseAsync."
pubDate: 2023-10-23
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/10/jsonnode-net-8-api-updates"
translatedBy: "claude"
translationDate: 2026-05-01
---
No .NET 8, `JsonNode` e `JsonArray` receberam algumas adições à sua API. Já cobrimos [deep copy e deep equality em um artigo anterior](/2023/10/deep-cloning-and-deep-equality-of-a-jsonnode/), mas tem mais coisa.

## `GetValueKind`

```cs
public JsonValueKind GetValueKind(JsonSerializerOptions options = null);
```

Retorna o `JsonValueKind` da instância atual.

## `GetPropertyName`

```cs
public string GetPropertyName();
```

Retorna o nome da propriedade do nó atual dentro do objeto pai. Lança `InvalidOperationException` se o pai não for um `JsonObject`.

## `GetElementIndex`

```cs
public int GetElementIndex();
```

Retorna o índice do nó atual dentro do `JsonArray` pai. Lança `InvalidOperationException` se o pai não for um `JsonArray`.

## `ReplaceWith<T>`

```cs
public void ReplaceWith<T>(T value);
```

Substitui o nó informado pelo valor fornecido.

## `ParseAsync`

```cs
public static Task<JsonNode?> ParseAsync(
        Stream utf8Json,
        JsonNodeOptions? nodeOptions = null,
        JsonDocumentOptions documentOptions = default,
        CancellationToken cancellationToken = default);
```

Faz o parse assíncrono de um stream de dados codificados em UTF-8 que representam um único valor JSON, transformando-o em um `JsonNode`.
