---
title: "EF Core 11 が DiskANN インデックスでネイティブな SQL Server ベクトル検索を追加"
description: "EF Core 11 Preview 2 は SQL Server 2025 の VECTOR_SEARCH() と DiskANN ベクトルインデックスを LINQ から直接サポートします。インデックスのセットアップ、近似クエリの実行方法、EF Core 10 の VectorDistance アプローチからの変更点を紹介します。"
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "ef-core"
  - "sql-server"
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2026/04/efcore-11-sql-server-vector-search-diskann-indexes"
translatedBy: "claude"
translationDate: 2026-04-25
---

EF Core 10 は LINQ クエリで埋め込み間の正確な距離を計算するための `EF.Functions.VectorDistance()` を導入しました。これは動作しますが、数百万行に対する正確な検索は高価です。EF Core 11 Preview 2 は SQL Server 2025 の近似ベクトル検索: DiskANN インデックスとテーブル値関数 `VECTOR_SEARCH()` をサポートすることでギャップを埋め、すべて `DbContext` を通して配線されています。

## ベクトルインデックスのセットアップ

`OnModelCreating` で希望する距離メトリック (コサイン、ドット積、またはユークリッド) でインデックスを宣言します。

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasVectorIndex(b => b.Embedding, "cosine");
}
```

マイグレーションを追加すると、EF は SQL Server 2025 の DiskANN エンジンをターゲットにした `CREATE VECTOR INDEX` DDL を生成します。インデックスは通常の B-tree とフルテキストインデックスと並んで存在し、同じマイグレーションパイプラインを通じて管理されます。

## VectorSearch() でクエリする

インデックスが存在したら、`DbSet` 上の新しい拡張メソッド `VectorSearch()` を使用します。

```csharp
float[] queryEmbedding = GetEmbeddingForQuery("distributed caching");

var results = await context.Blogs
    .VectorSearch(b => b.Embedding, "cosine", queryEmbedding, topN: 5)
    .ToListAsync();
```

これは SQL Server のテーブル値関数 `VECTOR_SEARCH()` に変換され、DiskANN インデックスに対して近似最近傍ルックアップを実行します。`topN` パラメータは、返される結果の数を上限設定します。

戻り値の型は `VectorSearchResult<TEntity>` で、エンティティと計算された距離の両方を公開します。

```csharp
var results = await context.Blogs
    .VectorSearch(b => b.Embedding, "cosine", queryEmbedding, topN: 10)
    .Select(r => new { r.Value.Name, r.Distance })
    .ToListAsync();
```

## 正確 vs 近似: どちらをいつ使うか

EF Core 10 の `VectorDistance()` は引き続き動作し、正確な結果を提供します。データセットが小さいときや、レイテンシより精度が重要なときに使用してください。DiskANN インデックスを伴う `VectorSearch()` は少量のリコール精度と引き換えに、大きなテーブルでの劇的に良いスループットを得られます。

実際には、ほとんどの RAG とレコメンデーションのワークロードは近似パスを望んでいます。以前ベクトル検索を専用データベース (Qdrant、Pinecone、pgvector) にオフロードしていた場合、これはすでに実行している SQL Server に戻し、EF Core がスキーマを管理するようになります。

## 要件

この機能は DiskANN ベクトルインデックスを導入した SQL Server 2025 をターゲットにしています。`VECTOR_SEARCH()` 関数と関連する `CREATE VECTOR INDEX` 構文は執筆時点で SQL Server で実験的なので、変更を予想してください。EF Core の API はその実験的なステータスを反映しています。

完全なセットアップ詳細については、[EF Core ベクトル検索ドキュメント](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/vector-search) を参照してください。
