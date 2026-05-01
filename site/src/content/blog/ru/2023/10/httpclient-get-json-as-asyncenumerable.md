---
title: "HttpClient получаем JSON как AsyncEnumerable"
description: "Новый метод-расширение GetFromJsonAsAsyncEnumerable в .NET 8 десериализует JSON из тела HTTP-ответа в IAsyncEnumerable. Узнайте, как использовать его с await foreach."
pubDate: 2023-10-24
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/10/httpclient-get-json-as-asyncenumerable"
translatedBy: "claude"
translationDate: 2026-05-01
---
В части `HttpClient` в .NET 8 появился новый метод-расширение — `GetFromJsonAsAsyncEnumerable<T>`. Он берёт JSON из тела ответа и десериализует его в асинхронно перечисляемую операцию.

Полная сигнатура метода-расширения такова:

```cs
[RequiresUnreferencedCode(HttpContentJsonExtensions.SerializationUnreferencedCodeMessage)]
[RequiresDynamicCode(HttpContentJsonExtensions.SerializationDynamicCodeMessage)]
public static IAsyncEnumerable<TValue?> GetFromJsonAsAsyncEnumerable<TValue>(
    this HttpClient client,
    [StringSyntax(StringSyntaxAttribute.Uri)] string? requestUri,
    CancellationToken cancellationToken = default) =>
    GetFromJsonAsAsyncEnumerable<TValue>(client, requestUri, options: null, cancellationToken);
```

Посмотрим, как его использовать. Прежде всего обратите внимание, что `GetFromJsonAsAsyncEnumerable` сам по себе не `async` — асинхронной частью занимается возвращаемый `IAsyncEnumerable`.

```cs
IAsyncEnumerable<Hotel> hotels = client.GetFromJsonAsAsyncEnumerable<Hotel>("https://foo.bar/api/hotels");
```

Дальше берём результат `hotels` и используем `await foreach`, чтобы дождаться и пройтись по каждому элементу `IAsyncEnumerable`.

```cs
await foreach (var hotel in hotels)
{
    Console.WriteLine($"{hotel.stars}* | {hotel.name}");
}
```

Внутри тела `foreach` с `hotel` можно делать что угодно. Полный пример ниже:

```cs
using System.Net.Http.Json;

using var client = new HttpClient();
IAsyncEnumerable<Hotel> hotels = client.GetFromJsonAsAsyncEnumerable<Hotel>("https://foo.bar/api/hotels");

await foreach (var hotel in hotels)
{
    Console.WriteLine($"{hotel.stars}* | {hotel.name}");
}

public record Hotel(string name, string address, int stars);
```
