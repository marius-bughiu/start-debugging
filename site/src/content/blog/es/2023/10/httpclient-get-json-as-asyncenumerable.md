---
title: "HttpClient obtener JSON como AsyncEnumerable"
description: "El nuevo método de extensión GetFromJsonAsAsyncEnumerable en .NET 8 deserializa el JSON de la respuesta HTTP en un IAsyncEnumerable. Aprende a usarlo con await foreach."
pubDate: 2023-10-24
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/10/httpclient-get-json-as-asyncenumerable"
translatedBy: "claude"
translationDate: 2026-05-01
---
Se ha añadido un nuevo método de extensión, `GetFromJsonAsAsyncEnumerable<T>`, a la parte de `HttpClient` de .NET 8. Este nuevo método toma el JSON del cuerpo de la respuesta y lo deserializa en una operación enumerable asíncrona.

La firma completa del método de extensión es la siguiente:

```cs
[RequiresUnreferencedCode(HttpContentJsonExtensions.SerializationUnreferencedCodeMessage)]
[RequiresDynamicCode(HttpContentJsonExtensions.SerializationDynamicCodeMessage)]
public static IAsyncEnumerable<TValue?> GetFromJsonAsAsyncEnumerable<TValue>(
    this HttpClient client,
    [StringSyntax(StringSyntaxAttribute.Uri)] string? requestUri,
    CancellationToken cancellationToken = default) =>
    GetFromJsonAsAsyncEnumerable<TValue>(client, requestUri, options: null, cancellationToken);
```

Veamos cómo usarlo. Lo primero a notar es que `GetFromJsonAsAsyncEnumerable` no es `async`, ya que la parte asíncrona la gestiona el `IAsyncEnumerable` que se devuelve.

```cs
IAsyncEnumerable<Hotel> hotels = client.GetFromJsonAsAsyncEnumerable<Hotel>("https://foo.bar/api/hotels");
```

A continuación, tomamos el resultado `hotels` y usamos un `await foreach` para esperar e iterar sobre cada elemento del `IAsyncEnumerable`.

```cs
await foreach (var hotel in hotels)
{
    Console.WriteLine($"{hotel.stars}* | {hotel.name}");
}
```

Dentro del cuerpo del `foreach` puedes hacer lo que quieras con tu `hotel`. Ejemplo completo a continuación:

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
