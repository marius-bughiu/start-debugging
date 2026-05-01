---
title: "JsonNode обновления API в .NET 8"
description: "Разбираем новые API в .NET 8 для JsonNode и JsonArray: GetValueKind, GetPropertyName, GetElementIndex, ReplaceWith и ParseAsync."
pubDate: 2023-10-23
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/10/jsonnode-net-8-api-updates"
translatedBy: "claude"
translationDate: 2026-05-01
---
В рамках .NET 8 у `JsonNode` и `JsonArray` появилось несколько новых пунктов в API. О [deep copy и deep equality мы уже рассказывали в предыдущей статье](/2023/10/deep-cloning-and-deep-equality-of-a-jsonnode/), но это далеко не всё.

## `GetValueKind`

```cs
public JsonValueKind GetValueKind(JsonSerializerOptions options = null);
```

Возвращает `JsonValueKind` для текущего экземпляра.

## `GetPropertyName`

```cs
public string GetPropertyName();
```

Возвращает имя свойства текущего узла в родительском объекте. Бросает `InvalidOperationException`, если родитель не является `JsonObject`.

## `GetElementIndex`

```cs
public int GetElementIndex();
```

Возвращает индекс текущего узла в родительском `JsonArray`. Бросает `InvalidOperationException`, если родитель не является `JsonArray`.

## `ReplaceWith<T>`

```cs
public void ReplaceWith<T>(T value);
```

Заменяет указанный узел переданным значением.

## `ParseAsync`

```cs
public static Task<JsonNode?> ParseAsync(
        Stream utf8Json,
        JsonNodeOptions? nodeOptions = null,
        JsonDocumentOptions documentOptions = default,
        CancellationToken cancellationToken = default);
```

Асинхронно разбирает поток данных в кодировке UTF-8, представляющий одно JSON-значение, в `JsonNode`.
