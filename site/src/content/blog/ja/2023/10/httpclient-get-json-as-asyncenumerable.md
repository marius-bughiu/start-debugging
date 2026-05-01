---
title: "HttpClient で JSON を AsyncEnumerable として取得する"
description: ".NET 8 で追加された GetFromJsonAsAsyncEnumerable 拡張メソッドは、HTTP レスポンスの JSON を IAsyncEnumerable にデシリアライズします。await foreach と組み合わせた使い方を解説します。"
pubDate: 2023-10-24
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/10/httpclient-get-json-as-asyncenumerable"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 の `HttpClient` に、新しい拡張メソッド `GetFromJsonAsAsyncEnumerable<T>` が追加されました。このメソッドは、レスポンスボディの JSON を非同期な enumerable な操作にデシリアライズします。

拡張メソッドのシグネチャはこちらです。

```cs
[RequiresUnreferencedCode(HttpContentJsonExtensions.SerializationUnreferencedCodeMessage)]
[RequiresDynamicCode(HttpContentJsonExtensions.SerializationDynamicCodeMessage)]
public static IAsyncEnumerable<TValue?> GetFromJsonAsAsyncEnumerable<TValue>(
    this HttpClient client,
    [StringSyntax(StringSyntaxAttribute.Uri)] string? requestUri,
    CancellationToken cancellationToken = default) =>
    GetFromJsonAsAsyncEnumerable<TValue>(client, requestUri, options: null, cancellationToken);
```

使い方を見ていきましょう。まず気をつけたいのは、`GetFromJsonAsAsyncEnumerable` 自体は `async` ではないという点です。非同期な部分は、返ってくる `IAsyncEnumerable` 側が担います。

```cs
IAsyncEnumerable<Hotel> hotels = client.GetFromJsonAsAsyncEnumerable<Hotel>("https://foo.bar/api/hotels");
```

次に、`hotels` の結果に対して `await foreach` を使い、`IAsyncEnumerable` の各要素を非同期に待ちながらイテレートします。

```cs
await foreach (var hotel in hotels)
{
    Console.WriteLine($"{hotel.stars}* | {hotel.name}");
}
```

`foreach` の本体内では、`hotel` に対して好きな処理を行えます。完全な例は以下のとおりです。

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
