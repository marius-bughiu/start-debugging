---
title: "EF Core 11 で IAsyncEnumerable<T> を使う方法"
description: "EF Core 11 のクエリは IAsyncEnumerable<T> を直接実装しています。await foreach で行をストリーミングする方法、ToListAsync より好むべきタイミング、接続・トラッキング・キャンセルまわりの落とし穴。"
pubDate: 2026-04-22
tags:
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
lang: "ja"
translationOf: "2026/04/how-to-use-iasyncenumerable-with-ef-core-11"
translatedBy: "claude"
translationDate: 2026-04-24
---

EF Core 11 で大量の行を返すクエリがある場合、処理を始める前に結果全体を `List<T>` にマテリアライズする必要はありません。EF Core の `IQueryable<T>` はすでに `IAsyncEnumerable<T>` を実装しているため、そのまま `await foreach` でき、各行はデータベースが生成するたびに yield されます。`ToListAsync` は不要、カスタムイテレーターも不要、`System.Linq.Async` パッケージも不要です。これが短い答えです。この記事では、その仕組み、EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.0、.NET 11、C# 14) のバージョン固有の詳細、そしてストリーミング設計ではなかったコードベースにストリーミングを後付けしようとする人が引っかかる落とし穴を説明します。

## そもそもなぜ EF Core は `IAsyncEnumerable<T>` を公開するのか

EF Core のクエリパイプラインは data reader を中心に組まれています。`ToListAsync()` を呼ぶと、EF Core は接続を開き、コマンドを実行し、reader を使い切るまでバッファされたリストに行を引き抜き、その後すべてを閉じます。得られるのは `List<T>` で便利ですが、結果セット全体がプロセスのメモリに載り、最後の行が読まれるまで最初の行はコードからは見えません。

`IAsyncEnumerable<T>` はこれを逆さまにします。行を 1 つずつ要求します。EF Core は接続を開き、コマンドを実行し、最初の行が線から到着した瞬間に最初のマテリアライズ済みエンティティを yield します。コードはすぐに動き出します。メモリはループ本体が保持する分に収まります。レポート、エクスポート、そして行を変換してから別の場所に書き込むパイプラインにとって、これが望ましいパターンです。

`DbSet<TEntity>` と任意の LINQ チェーンが返す `IQueryable<TEntity>` はどちらも `IAsyncEnumerable<TEntity>` を実装しているため、明示的な `AsAsyncEnumerable()` 呼び出しは不要です。インターフェースはそこにあります。async foreach の仕組みがそれを検知します。

## 最小例

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore 11.0.0
using Microsoft.EntityFrameworkCore;

await using var db = new AppDbContext();

await foreach (var invoice in db.Invoices
    .Where(i => i.Status == InvoiceStatus.Pending)
    .OrderBy(i => i.CreatedAt))
{
    await ProcessAsync(invoice);
}
```

これで全部です。`ToListAsync` なし。中間アロケーションなし。下にある `DbDataReader` はループの期間ずっと開いたままです。各イテレーションが次の行を線から引き抜き、`Invoice` をマテリアライズし、ループ本体に渡します。

リストベース版と比べてみましょう:

```csharp
// Buffers every row into memory before the first ProcessAsync call
var invoices = await db.Invoices
    .Where(i => i.Status == InvoiceStatus.Pending)
    .OrderBy(i => i.CreatedAt)
    .ToListAsync();

foreach (var invoice in invoices)
{
    await ProcessAsync(invoice);
}
```

50 行なら差は見えません。500 万行なら、ストリーミング版は最初のインボイスを処理し終えた頃に、バッファ版はまだリストのアロケーションすら終わっていません。

## キャンセルトークンを正しく渡す方法

`IQueryable<T>.GetAsyncEnumerator(CancellationToken)` のオーバーロードはトークンを受け取りますが、`await foreach (var x in query)` と書いたときに渡せる場所がありません。解決策は `WithCancellation` です:

```csharp
public async Task ExportPendingAsync(CancellationToken ct)
{
    await foreach (var invoice in db.Invoices
        .Where(i => i.Status == InvoiceStatus.Pending)
        .AsNoTracking()
        .WithCancellation(ct))
    {
        ct.ThrowIfCancellationRequested();
        await writer.WriteAsync(invoice, ct);
    }
}
```

`WithCancellation` はシーケンスを別のイテレーターでラップしません。トークンを `GetAsyncEnumerator` の呼び出しに通すだけで、EF Core はそれを `DbDataReader.ReadAsync` に転送します。呼び出し側がトークンをキャンセルすると、保留中の `ReadAsync` がキャンセルされ、サーバー側でコマンドが中止され、`OperationCanceledException` が `await foreach` を通して浮上します。

トークンを省略しないでください。ストリーミング EF Core クエリでトークンを忘れると、HTTP クライアントが切断したときに本番環境でハングするリクエストになります。リストベースの経路も同じように失敗しますが、こちらのほうが痛いです。なぜなら接続がマテリアライズのステップだけでなくループ全体にわたって保持されているからです。

## 本当に必要でない限りトラッキングを切ってください

`AsNoTracking()` はバッファリングよりもストリーミングでさらに重要です。change tracking がオンだと、enumerator から yield された各エンティティが `ChangeTracker` に追加されます。これは `DbContext` を dispose するまで GC が回収できない参照です。トラッキング付きのクエリで 100 万行をストリーミングすると、ストリーミングの意味が失われます: メモリは行数に比例して増え、`ToListAsync` と同じです。

```csharp
await foreach (var row in db.AuditEvents
    .AsNoTracking()
    .Where(e => e.OccurredAt >= cutoff)
    .WithCancellation(ct))
{
    await sink.WriteAsync(row, ct);
}
```

エンティティを変更してループ内で `SaveChangesAsync` を呼ぶつもりの場合だけトラッキングを維持してください。ただし次のセクションが主張するように、それはほとんど避けるべきです。

## 同じコンテキストで 1 つがストリーミング中に 2 つ目のクエリは開けない

これは本番でもっともよくある落とし穴です。列挙を開始すると EF Core が開く `DbDataReader` は接続を保持します。ループ内で同じ接続を必要とする別の EF Core メソッドを呼ぶと、こうなります:

```
System.InvalidOperationException: There is already an open DataReader associated
with this Connection which must be closed first.
```

SQL Server では Multiple Active Result Sets を有効にすることで回避できます (接続文字列に `MultipleActiveResultSets=True`)。ただし MARS 自体にパフォーマンス上のトレードオフがあり、すべてのプロバイダーでサポートされているわけではありません。よりよいパターンは、1 つのコンテキストで操作を混在させないことです。次のいずれかです:

- 必要な ID をまず収集してストリームを閉じ、その後にフォローアップ作業を行う、または
- 内側の呼び出しには 2 つ目の `DbContext` を使う。

```csharp
await foreach (var order in queryCtx.Orders
    .AsNoTracking()
    .WithCancellation(ct))
{
    await using var writeCtx = await factory.CreateDbContextAsync(ct);
    writeCtx.Orders.Attach(order);
    order.ProcessedAt = DateTime.UtcNow;
    await writeCtx.SaveChangesAsync(ct);
}
```

`IDbContextFactory<TContext>` (DI 配線で `AddDbContextFactory` 経由で登録) は、scoped ライフタイムと戦わずに 2 つ目のコンテキストを得るためのもっともきれいな方法です。

## ストリーミングとトランザクションは相性が悪い

ストリーミング enumerator はループが走っている間ずっと接続を開いたままにします。そのループがトランザクションにも参加しているなら、トランザクションもループ全体にわたって開いたままです。長時間実行されるトランザクションは、ロックエスカレーション、ブロックされたライター、そして負荷時にだけ出現するタイムアウトの原因です。

これを正気に保つ 2 つのルール:

1. 一貫したスナップショットが本当に必要な場合を除いて、ストリーミング読み込みの周りでトランザクションを開かない。
2. スナップショットが必要なら、SQL Server では `SNAPSHOT` 分離レベル、選択したプロバイダーでは `REPEATABLE READ` 分離レベルを検討し、ループ本体はホットパスとして扱う。HTTP 呼び出しなし、ユーザー向けの待機なし。

一括処理ジョブの通常の形は: ストリーミング読み込み、別コンテキスト上の短いトランザクションで行ごとまたはバッチで書き込み、コミット、次へ。

## `AsAsyncEnumerable` は存在し、時々は必要

`IAsyncEnumerable<T>` を受け取るメソッドに EF Core のクエリを渡したい場合、インターフェースが実装されているので `IQueryable<T>` を直接渡してもコンパイルはされますが、呼び出し箇所では違和感があります。`AsAsyncEnumerable` はランタイムでは no-op ですが、意図を明示します:

```csharp
public async Task ExportAsync(IAsyncEnumerable<Invoice> source, CancellationToken ct)
{
    // Consumes a generic async sequence. Does not know it is EF.
}

await ExportAsync(
    db.Invoices.AsNoTracking().AsAsyncEnumerable(),
    ct);
```

また、呼び出しが `IQueryable` の世界を離れることも強制します。`AsAsyncEnumerable()` を通すと、それ以降の LINQ 演算子は SQL ではなくクライアント側で async iterator 演算子として動きます。受け取るメソッドが誤ってクエリを書き換えないよう、ここではその動きが望ましいのです。

## ループを早期に抜けると何が起きるか

async iterator は dispose 時にクリーンアップします。`await foreach` が何らかの理由 (break、例外、または完了) で抜けると、コンパイラは enumerator に対して `DisposeAsync` を呼び出し、`DbDataReader` を閉じて接続をプールに戻します。だから `DbContext` の `await using` は依然として重要ですが、個々のクエリには独自の using ブロックは不要です。

目立たない結果: 1000 万行のクエリの最初の行の後で `break` すると、EF Core は残りの行を読みませんが、データベースはすでに多くをスプールしているかもしれません。クエリプランはあなたが興味を失ったことを知りません。SQL Server では、クライアント側の `DbDataReader.Close` が TDS ストリーム経由でキャンセルを送り、サーバーは撤退しますが、巨大な行数ではループが抜けた後も数秒のサーバー側作業が見えることがあります。これはほとんど問題になりませんが、テストがすでにパスした後にサーバー側でクエリが動いていると debugger が示すときに知っておく価値があります。

## ストリーミングソースの上で `ToListAsync` を誤用しない

たまに誰かがこう書きます:

```csharp
// Pointless: materializes the whole thing, then streams it
var all = await db.Invoices.ToListAsync(ct);
await foreach (var item in all.ToAsyncEnumerable()) { }
```

メリットはありません。ストリーミングしたいなら `IQueryable` から直接 `await foreach` に行ってください。バッファリングしたいなら `List<T>` のままで普通の `foreach` を使ってください。両者を混ぜると、どちらが欲しかったのか分かっていなかった人の痕跡が見えます。

同様に、EF Core クエリに対して `.ToAsyncEnumerable()` を呼ぶのは EF Core 11 では冗長です: ソースはすでにインターフェースを実装しています。コンパイルも動きもしますが、追加しないでください。

## クライアント評価はいまだに忍び込む

EF Core のクエリ翻訳器は優秀ですが、すべての LINQ 式が SQL に変換されるわけではありません。変換できない場合、EF Core 11 はデフォルトで最終演算子で throw します (EF Core 2.x の静かなクライアント評価とは異なります)。ストリーミングでもこれは変わりません: `.Where` フィルターが EF Core が翻訳できないメソッドを参照していると、クエリ全体が列挙時に失敗し、`await foreach` の開始時ではありません。

驚きは、`await foreach` では例外が最初の `MoveNextAsync` で浮上することです。これはループヘッダーの内側であり、その前ではありません。セットアップエラーと処理エラーを区別したいなら、セットアップを `try` で包んでください:

```csharp
try
{
    await foreach (var row in query.WithCancellation(ct))
    {
        try { await ProcessAsync(row, ct); }
        catch (Exception ex) { log.LogWarning(ex, "Row {Id} failed", row.Id); }
    }
}
catch (Exception ex)
{
    log.LogError(ex, "Query failed before first row");
    throw;
}
```

## `ToListAsync` がまだ正しい答えのとき

ストリーミングが万能というわけではありません。次の場合は `ToListAsync` を選んでください:

- 結果セットが小さく有界 (数千行以下など)。
- 結果を複数回イテレートする必要がある。
- `Count`、インデックス、その他 `IList<T>` の操作が必要。
- 結果を UI コントロールにバインドするか、マテリアライズ済みコレクションを期待するレスポンスボディにシリアライズする予定。

ストリーミングは、結果が大きいとき、メモリが問題のとき、消費側自身が async (`PipeWriter`、`IBufferWriter<T>`、`Channel<T>`、メッセージバス) のとき、または first-byte のレイテンシが全体スループットより重要なときに勝ちます。

## EF Core 11 ストリーミングの簡易チェックリスト

- `IQueryable<T>` に対して直接 `await foreach`。`ToListAsync` は不要。
- 具体的な理由がない限り常に `AsNoTracking()`。
- 常に `WithCancellation(ct)`。
- ループ内で書き込み用に 2 つ目のコンテキストが必要なら `IDbContextFactory<TContext>` を使う。
- ストリーミング読み込みを長いトランザクションで包まない。
- MARS なしに同じコンテキストで 2 つ目の reader を開かない。
- 最初の `MoveNextAsync` で翻訳エラーや接続エラーが浮上することを想定する。

## 関連

- [EF Core 11 で record を正しく使う方法](/2026/04/how-to-use-records-with-ef-core-11-correctly/) は、エンティティが不変のときのストリーミング読み込みとよく組み合わさります。
- [`dotnet ef update add` による EF Core 11 の 1 ステップマイグレーション](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) は同じリリースのツーリング面をカバーします。
- [.NET 9 の Task.WhenEach でタスクをストリーミング](/2026/01/streaming-tasks-with-net-9-task-wheneach/) はモダン .NET のもう 1 つの主要な `IAsyncEnumerable<T>` パターンです。
- [HttpClient GetFromJsonAsAsyncEnumerable](/2023/10/httpclient-get-json-as-asyncenumerable/) は同じストリーミングの形を HTTP 側で示します。
- [EF Core 11 preview 3 の split query でのリファレンス JOIN の剪定](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) は同じリリースのパフォーマンス面の文脈です。

## 参考資料

- [EF Core Async Queries, MS Learn](https://learn.microsoft.com/en-us/ef/core/miscellaneous/async)
- [`DbContext` ライフタイムとプーリング, MS Learn](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/)
- [`IDbContextFactory<TContext>`, MS Learn](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor)
- [GitHub 上の EF Core ソースの `AsyncEnumerableReader`](https://github.com/dotnet/efcore)
