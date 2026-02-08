---
title: "HttpClient get JSON as AsyncEnumerable"
description: "The new GetFromJsonAsAsyncEnumerable extension method in .NET 8 deserializes HTTP response JSON into an IAsyncEnumerable. Learn how to use it with await foreach."
pubDate: 2023-10-24
updatedDate: 2023-11-01
tags:
  - "net"
  - "net-8"
---
A new extension method – `GetFromJsonAsAsyncEnumerable<T>` – has been added to the `HttpClient` part of .NET 8. This new method will take the response body JSON and deserialize it into an async enumerable operation.

The complete signature of the extension method is as follows:

```cs
[RequiresUnreferencedCode(HttpContentJsonExtensions.SerializationUnreferencedCodeMessage)]
[RequiresDynamicCode(HttpContentJsonExtensions.SerializationDynamicCodeMessage)]
public static IAsyncEnumerable<TValue?> GetFromJsonAsAsyncEnumerable<TValue>(
    this HttpClient client,
    [StringSyntax(StringSyntaxAttribute.Uri)] string? requestUri,
    CancellationToken cancellationToken = default) =>
    GetFromJsonAsAsyncEnumerable<TValue>(client, requestUri, options: null, cancellationToken);
```

Let’s take a look at how to use it. First thing to note is that the `GetFromJsonAsAsyncEnumerable` is not `async`, as the async part is being handled by the `IAsyncEnumerable` returned.

```cs
IAsyncEnumerable<Hotel> hotels = client.GetFromJsonAsAsyncEnumerable<Hotel>("https://foo.bar/api/hotels");
```

Next, we take the `hotels` result and use an `await foreach` to await and iterate on each element of the `IAsyncEnumerable`.

```cs
await foreach (var hotel in hotels)
{
    Console.WriteLine($"{hotel.stars}* | {hotel.name}");
}
```

Inside the body of the `foreach` you can do anything you want with your `hotel`. Full example below:

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
