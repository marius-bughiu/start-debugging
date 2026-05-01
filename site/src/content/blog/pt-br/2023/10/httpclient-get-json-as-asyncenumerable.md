---
title: "HttpClient obter JSON como AsyncEnumerable"
description: "O novo método de extensão GetFromJsonAsAsyncEnumerable no .NET 8 desserializa o JSON da resposta HTTP em um IAsyncEnumerable. Aprenda a usá-lo com await foreach."
pubDate: 2023-10-24
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/10/httpclient-get-json-as-asyncenumerable"
translatedBy: "claude"
translationDate: 2026-05-01
---
Um novo método de extensão, `GetFromJsonAsAsyncEnumerable<T>`, foi adicionado ao `HttpClient` no .NET 8. Esse novo método pega o JSON do corpo da resposta e o desserializa em uma operação enumerável assíncrona.

A assinatura completa do método de extensão é a seguinte:

```cs
[RequiresUnreferencedCode(HttpContentJsonExtensions.SerializationUnreferencedCodeMessage)]
[RequiresDynamicCode(HttpContentJsonExtensions.SerializationDynamicCodeMessage)]
public static IAsyncEnumerable<TValue?> GetFromJsonAsAsyncEnumerable<TValue>(
    this HttpClient client,
    [StringSyntax(StringSyntaxAttribute.Uri)] string? requestUri,
    CancellationToken cancellationToken = default) =>
    GetFromJsonAsAsyncEnumerable<TValue>(client, requestUri, options: null, cancellationToken);
```

Vamos ver como usá-lo. A primeira coisa a notar é que `GetFromJsonAsAsyncEnumerable` não é `async`, porque a parte assíncrona é tratada pelo `IAsyncEnumerable` retornado.

```cs
IAsyncEnumerable<Hotel> hotels = client.GetFromJsonAsAsyncEnumerable<Hotel>("https://foo.bar/api/hotels");
```

Em seguida, pegamos o resultado `hotels` e usamos um `await foreach` para aguardar e iterar sobre cada elemento do `IAsyncEnumerable`.

```cs
await foreach (var hotel in hotels)
{
    Console.WriteLine($"{hotel.stars}* | {hotel.name}");
}
```

Dentro do corpo do `foreach` você pode fazer o que quiser com o seu `hotel`. Veja o exemplo completo abaixo:

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
