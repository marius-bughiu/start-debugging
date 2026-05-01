---
title: "HttpClient JSON als AsyncEnumerable abrufen"
description: "Die neue Erweiterungsmethode GetFromJsonAsAsyncEnumerable in .NET 8 deserialisiert den JSON-Body einer HTTP-Antwort in ein IAsyncEnumerable. Erfahren Sie, wie Sie sie mit await foreach einsetzen."
pubDate: 2023-10-24
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/10/httpclient-get-json-as-asyncenumerable"
translatedBy: "claude"
translationDate: 2026-05-01
---
Mit .NET 8 wurde dem `HttpClient` eine neue Erweiterungsmethode hinzugefügt: `GetFromJsonAsAsyncEnumerable<T>`. Sie nimmt den JSON-Body der Antwort und deserialisiert ihn in eine asynchrone Enumeration.

Die vollständige Signatur der Erweiterungsmethode lautet:

```cs
[RequiresUnreferencedCode(HttpContentJsonExtensions.SerializationUnreferencedCodeMessage)]
[RequiresDynamicCode(HttpContentJsonExtensions.SerializationDynamicCodeMessage)]
public static IAsyncEnumerable<TValue?> GetFromJsonAsAsyncEnumerable<TValue>(
    this HttpClient client,
    [StringSyntax(StringSyntaxAttribute.Uri)] string? requestUri,
    CancellationToken cancellationToken = default) =>
    GetFromJsonAsAsyncEnumerable<TValue>(client, requestUri, options: null, cancellationToken);
```

Schauen wir uns den Einsatz an. Zuerst fällt auf, dass `GetFromJsonAsAsyncEnumerable` selbst nicht `async` ist, denn der asynchrone Teil wird über das zurückgegebene `IAsyncEnumerable` abgewickelt.

```cs
IAsyncEnumerable<Hotel> hotels = client.GetFromJsonAsAsyncEnumerable<Hotel>("https://foo.bar/api/hotels");
```

Anschließend nehmen wir das Ergebnis `hotels` und iterieren mit einem `await foreach` asynchron über jedes Element des `IAsyncEnumerable`.

```cs
await foreach (var hotel in hotels)
{
    Console.WriteLine($"{hotel.stars}* | {hotel.name}");
}
```

Innerhalb des `foreach`-Bodys können Sie mit Ihrem `hotel` machen, was Sie möchten. Vollständiges Beispiel unten:

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
