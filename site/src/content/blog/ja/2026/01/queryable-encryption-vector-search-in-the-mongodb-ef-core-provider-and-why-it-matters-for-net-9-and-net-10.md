---
title: "MongoDB EF Core プロバイダーの Queryable Encryption とベクトル検索 (.NET 9 と .NET 10 にとって何が大事か)"
description: "MongoDB EF Core プロバイダーが Queryable Encryption とベクトル検索をサポートしました。すでに EF Core を使っている .NET 9 / .NET 10 アプリにとって、それが何を意味するかを解説します。"
pubDate: 2026-01-08
tags:
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/01/queryable-encryption-vector-search-in-the-mongodb-ef-core-provider-and-why-it-matters-for-net-9-and-net-10"
translatedBy: "claude"
translationDate: 2026-04-30
---
2026 年 1 月 7 日、Microsoft はセキュリティと検索が交差する素敵なアップデートを公開しました: MongoDB EF Core プロバイダーが、EF Core スタイルの LINQ サーフェスから **Queryable Encryption** (等価および範囲) と **ベクトル検索** をサポートするようになりました。あなたの .NET 9 や .NET 10 アプリがすでに EF Core を流暢に話しているなら、これはドメイン層に染み出す「MongoDB 専用コード」の量を減らせる類の機能です。

### 暗号化されたクエリでも LINQ のように見える

Queryable Encryption が興味深いのは、単なる「保存時の暗号化」ではないからです。要点は、機密フィールドを暗号化したまま、_等価_ や _範囲_ の述語を表現できることです。

マッピングは `OnModelCreating` で明示的に行います。元の記事はこのように暗号化設定を示しています:

```cs
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Employee>(entity =>
    {
        entity.Property(e => e.TaxPayerId)
            .IsEncryptedForEquality(<Your Data Encryption Key GUID>));

        entity.Property(e => e.Salary)
            .HasBsonRepresentation(BsonType.Decimal128)
            // Salaries from 0 to 10 million, no decimal place precision
            .IsEncryptedForRange(0m, 10000000m, 0,
                <Your Data Encryption Key GUID>));              
    });
}
```

マッピングしてしまえば、クエリは普通の EF Core クエリのように読めます:

```cs
// Encrypted Equality Query
var specificEmployee = db.Employees.Where(e => e.TaxPayerId == "45678");

// Encrypted Range Query
var seniorEmployees = db.Employees.Where(e => e.Salary >= 100000m && e.Salary < 200000m);
```

大きな勝ちはアーキテクチャ面にあります: コードレビューでクエリの意図 (誰が給与でフィルターしているか、誰が納税者 ID でマッチしているか) を見える形に保ちつつ、アプリ全体にアドホックな暗号化配線をばら撒かずに済みます。

### DbContext からのベクトル検索

検索がキーワードマッチから類似度マッチへと移っているため、ベクトル検索はあちこちに登場しています。プロバイダーはベクトルフィールドのマッピングと、ベクトル検索のクエリ API を追加します。

DevBlogs の記事から、float の配列をバイナリベクトルとしてマッピングします:

```cs
b.Property(e => e.PlotEmbedding)
   .HasElementName("plot_embedding_voyage_3_large")
   .HasBinaryVectorDataType(BinaryVectorDataType.Float32);

// OR in the model:
[BinaryVector(BinaryVectorDataType.Float32)]
public float[]? PlotEmbedding { get; set; }
```

そして類似度でクエリできます:

```cs
var similarMovies = await db.Movies.VectorSearch(
        e => e.PlotEmbedding,
        myCustom.PlotEmbedding,
        limit: 10)
    .ToListAsync();
```

.NET 9 や .NET 10 で構築しているなら、これによって「レコメンド/検索」のロジックを既存の EF Core パターンに近づけて保ち、メンテすべきカスタムクエリパイプラインを減らせます。

完全な背景とプロバイダーの詳細が知りたい場合は、元の記事を読んでください: [Secure and Intelligent: Queryable Encryption and Vector Search in MongoDB EF Core Provider](https://devblogs.microsoft.com/dotnet/mongodb-efcore-provider-queryable-encryption-vector-search/).
