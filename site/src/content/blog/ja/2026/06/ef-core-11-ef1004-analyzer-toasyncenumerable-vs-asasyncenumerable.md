---
title: "EF Core 11 の新しい EF1004 アナライザーが静かな非同期ミスを検出します"
description: "EF Core 11 Preview 5 には EF1004 アナライザーが含まれます。IQueryable に対する ToAsyncEnumerable() を指摘し、await foreach の中でデータベースクエリを誤って同期的に列挙しないようにします。"
pubDate: 2026-06-14
tags:
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
lang: "ja"
translationOf: "2026/06/ef-core-11-ef1004-analyzer-toasyncenumerable-vs-asasyncenumerable"
translatedBy: "claude"
translationDate: 2026-06-14
---

2026-06-09 にリリースされた .NET 11 Preview 5 は、診断 ID `EF1004` を持つ新しい EF Core アナライザーを追加します。これは、.NET 10 で `System.Linq.AsyncEnumerable` が BCL に入って以来はるかに犯しやすくなったミスを検出します。それは、EF Core のクエリに対して `ToAsyncEnumerable()` を呼び出し、気づかないうちに同期的に実行してしまうことです。

## 間違った呼び出しがどのように紛れ込むか

`System.Linq.AsyncEnumerable` がランタイムに同梱されるようになったため、その拡張メソッドはほぼどこでも利用できます。その 1 つが `ToAsyncEnumerable()` で、任意の `IEnumerable<T>` を `IAsyncEnumerable<T>` に適合させます。EF Core の `IQueryable<T>` も `IEnumerable<T>` であるため、この呼び出しは問題なくコンパイルされ、`await foreach` の隣で正しく見えます。

```csharp
// Looks async. Is not.
await foreach (var blog in db.Blogs.ToAsyncEnumerable())
{
    Console.WriteLine(blog.Name);
}
```

問題は、`ToAsyncEnumerable()` が同期的な列挙をラップしている点です。ブロッキングな列挙子を使って `IQueryable` を走査するため、データベースへのラウンドトリップは呼び出し元のスレッドで実行されます。`await foreach` はストリーミングの構文を与えてくれますが、非同期の動作は一切ありません。負荷がかかると、これはまさにスレッドプールを枯渇させ、本番環境でのみ現れるデッドロックを生み出す形になります。

## EF1004 が代わりに期待するもの

EF Core は独自の `AsAsyncEnumerable()` メソッドを公開しています。こちらはクエリを EF Core の非同期パイプラインを通して処理するため、各行はスレッドをブロックすることなく `DbDataReader` から出てくるたびにマテリアライズされます。

```csharp
// Runs through EF Core's async query pipeline.
await foreach (var blog in db.Blogs.AsAsyncEnumerable())
{
    Console.WriteLine(blog.Name);
}
```

2 つのメソッド名は 3 文字だけ異なり、どちらも `IAsyncEnumerable<T>` を返し、どちらもコンパイルされます。Preview 5 より前は、どちらを選んだのかを知らせてくれるものは何もありませんでした。`EF1004` は、`IQueryable<T>` に対して `ToAsyncEnumerable()` を呼び出した瞬間にビルド時に発火し、`AsAsyncEnumerable()` を指し示します。

## エラーに変える

このアナライザーは EF Core アナライザーパッケージに含まれ、通常のビルド中に実行されます。そのため、`Microsoft.EntityFrameworkCore` 11.0.0 を参照するプロジェクトでは、追加の設定なしで警告が得られます。誰も同期版を出荷しないことを保証したい場合は、プロジェクトファイルでそれを昇格させてください。

```xml
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);EF1004</WarningsAsErrors>
</PropertyGroup>
```

これは、[EF Core 11 で IAsyncEnumerable&lt;T&gt; を使う方法](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)で扱っているストリーミングのパターンと自然に組み合わさります。`AsAsyncEnumerable()` こそが、`await foreach` を実際にストリーミングさせる呼び出しです。EF1004 は、よく似たメソッドがコードレビューをすり抜けるのを防ぐガードレールにすぎません。

出典: [.NET 11 Preview 5 の EF Core リリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/efcore.md)および [.NET 11 Preview 5 の発表](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/)。
