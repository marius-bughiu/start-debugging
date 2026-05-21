---
title: "C# における IEnumerable vs IAsyncEnumerable vs IQueryable：メソッドは何を返すべきか"
description: "3 つのシーケンスインターフェース、3 つの実行モデル。データベースがクエリを変換できる場合は IQueryable を、プロデューサーが非同期でストリーミングしたい場合は IAsyncEnumerable を、それ以外のメモリ内のものには IEnumerable を使用します。"
pubDate: 2026-05-21
template: vs
tags:
  - "comparison"
  - "csharp"
  - "linq"
  - "ef-core"
  - "async"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-21
---

C# 14 / .NET 11 のメソッドシグネチャで `IEnumerable<T>`、`IAsyncEnumerable<T>`、`IQueryable<T>` のどれを選ぶか迷っている場合、ルールはほぼ機械的です。`IQueryable<T>` を返すのは、コンシューマーがさらに `Where`/`Select`/`OrderBy` 呼び出しを構成でき、基盤となるプロバイダー（EF Core 11、LINQ to SQL、OData クライアント）がそれらをリモートクエリに変換できる場合のみです。`IAsyncEnumerable<T>` を返すのは、プロデューサーがアイテムごとまたはバッチごとに I/O を行い、プロデューサーが完了する前にコンシューマーに処理を開始させたい場合です。`IEnumerable<T>` を返すのは、既にメモリ内にあるもの、または境界で完全にマテリアライズすることを決めたものすべてに対してです。避けるべき間違いは、リポジトリの外に `IQueryable<T>` を漏らすことです。後続の `.Where(...)` はすべて SQL の一部になり（あなたがそれを望んでいたかどうかに関わらず）、「このクエリは実際にどこで実行されるのか」がデバッガーで答えなければならない質問になります。

この投稿は長尺版です。すべての例は `<TargetFramework>net11.0</TargetFramework>` と `<LangVersion>14.0</LangVersion>`、必要に応じて `Microsoft.EntityFrameworkCore 11.0.0` をターゲットにしています。

## 3 つのインターフェース、3 つの実行モデル

紙の上では 3 つのインターフェースは似ています。すべて `T` の単一のシーケンスを公開します。違いは、作業がどこで、いつ行われるかです。

- `IEnumerable<T>` はプルベースの同期シーケンスです。`MoveNext` は呼び出し元のスレッドで実行されます。プロデューサーは、アイテムを yield するメソッド、`List<T>`、`T[]`、または LINQ to Objects のチェーンです。プロデューサーは何も `await` できません。
- `IAsyncEnumerable<T>` はプルベースの非同期シーケンスです。`MoveNextAsync` は `ValueTask<bool>` を返し、プロデューサーがアイテム間で待機できるようにします。コンシューマーは `await foreach` で反復します。C# 8 / .NET Core 3.0 で導入され、`System.Linq.Async` パッケージと EF Core の `AsAsyncEnumerable` を介して現代の LINQ ではファーストクラスです。
- `IQueryable<T>` は式ツリービルダーです。`IQueryable<T>` にチェーンするすべての `Where`、`Select`、`OrderBy` は式ツリーにノードを追加します。ツリーは、終端演算子（`ToList`、`FirstOrDefault`、`Count`、`ToListAsync`）を呼び出したときにのみ、実行可能なもの（SQL 文、OData URL、Cosmos クエリ）に変換されます。それまでは I/O は発生していません。

最も重要な結果：EF Core 呼び出しによって返された `IEnumerable<T>` は、すでにデータベースを離れています。同じ呼び出しによって返された `IQueryable<T>` はそうではありません。この単一の事実が、EF Core コードの他のどの単一の原因よりも多くの「なぜこのクエリは遅いのか」というチケットの原因です。

## 機能マトリックス

| 能力                                            | `IEnumerable<T>`         | `IAsyncEnumerable<T>`        | `IQueryable<T>`                     |
| ----------------------------------------------- | ------------------------ | ---------------------------- | ----------------------------------- |
| 実行モデル                                      | 同期プル                 | 非同期プル                   | 遅延、プロバイダーが変換            |
| 作業の実行場所                                  | 呼び出し元スレッド、メモリ内 | プロデューサー側、awaitable | リモートプロバイダー（DB、OData、Cosmos）|
| アイテム間で `await` できるか                   | できない                 | できる                       | n/a（アイテムごとの作業なし）       |
| 利用可能な LINQ 演算子                          | LINQ to Objects          | LINQ to Objects (Async)      | プロバイダー固有のサブセット        |
| 戻り後の構成可能性                              | 可能（メモリ内）         | 可能（メモリ内）             | 可能（リモートで変換）              |
| バッファリングなしのストリーミング              | 可能（遅延 `yield return`）| 可能                       | プロバイダーに依存                  |
| キャンセル                                      | なし、ループは同期       | アイテムごとの `CancellationToken` | クエリごと `ToListAsync(token)` |
| リポジトリから返す際のリスク                    | 低                       | 中（プロバイダーの寿命）     | 高（呼び出し元が SQL を追加できる） |
| 最適な用途                                      | メモリ内コレクション     | リモートストリーム、server-sent | リポジトリ内部のクエリオブジェクト |
| マテリアライズのタイミング                      | 各 `MoveNext` で         | 各 `await MoveNextAsync` で  | 終端演算子で                        |

マトリックスがこの投稿です。以下はすべて理由です。

## `IEnumerable<T>` が正しい戻り値型のとき

`IEnumerable<T>` は「アイテムがある、シーケンスをくれ」のデフォルトです。同期的で、すべての LINQ to Objects 演算子を持ち、安価に構成できます。以下に使用します：

- メモリ内コレクションまたは純粋な計算から yield するメソッド。
- すでにデータをマテリアライズし、その上のビューを返すメソッド（`return list.Where(x => x.IsActive);`）。
- `File.ReadLines` で読むファイルや逆シリアル化された DOM のような同期ソースを歩くメソッド。

落とし穴は、非同期 I/O 呼び出しをラップするリポジトリメソッドの戻り値型として `IEnumerable<T>` を使用することです。これは、リポジトリに内部で `.ToList()` を強制してストリーミング特性を失わせるか、呼び出し元に `.Result` とスレッドプールのブロックを強制します。どちらも間違いです。ソースが非同期の場合、シグネチャは `IAsyncEnumerable<T>` または `Task<List<T>>` であるべきで、`IEnumerable<T>` ではありません。

```csharp
// .NET 11, C# 14
public static IEnumerable<string> ReadLowercaseLines(string path)
{
    foreach (var line in File.ReadLines(path))
    {
        yield return line.ToLowerInvariant();
    }
}
```

`File.ReadLines` はファイルを遅延的に読む `IEnumerable<string>` を返します。変換は遅延のままです。最初のアイテムが呼び出し元に届く前にファイル全体がロードされることを強制するものは何もありません。

`yield return` キーワードがこれを機能させます。これは、アイテムを 1 つずつ返し、yield 間でメソッドを中断するステートマシンを生成するようコンパイラーに指示します。これは `await foreach` プラス `yield return` を組み合わせたものの同期版の鏡像です。

## `IAsyncEnumerable<T>` が正しい戻り値型のとき

`IAsyncEnumerable<T>` は、プロデューサーがアイテム間で `await` する必要があるときに手を伸ばすものです。代表的な例はページネーションされた HTTP エンドポイントです。ページ 1 を取得し、各アイテムを yield し、ページ 2 を取得し、各アイテムを yield します。ページ 2 がまだ進行中の間に、コンシューマーにページ 1 の作業を開始してほしいのです。また、コンシューマーがプロデューサーをきれいに停止できるように、`CancellationToken` を配管しておきたいです。

以下に使用します：

- ページネーションされたリモートソース（ページを返す HTTP API、Server-Sent Events、メッセージキューコンシューマー）。
- メモリにマテリアライズせずに結果を CSV や別の HTTP レスポンスにストリーミングする EF Core 11 クエリ。
- バックプレッシャーが重要なプロデューサー：コンシューマーが読み、処理し、その後で次のアイテムを要求します。

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<Order> FetchAllAsync(
    HttpClient http,
    [EnumeratorCancellation] CancellationToken cancellationToken = default)
{
    string? next = "/api/orders?page=1";
    while (next is not null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var page = await http.GetFromJsonAsync<PageOf<Order>>(next, cancellationToken)
                   ?? throw new InvalidOperationException("page was null");
        foreach (var order in page.Items)
        {
            yield return order;
        }
        next = page.NextLink;
    }
}
```

人々がはまる 2 つの詳細。まず、`[EnumeratorCancellation]` は、呼び出し側の `WithCancellation(...)` からのトークンをイテレーターに配線するために必須です。これがないと、`await foreach (var x in source.WithCancellation(token))` を呼び出してもトークンは黙って破棄されます。次に、非同期イテレーターメソッドは、下流の演算子から来る例外のために `yield return` の周りで `try/catch` を使用することはできません。例外はプロデューサーではなくコンシューマーを通って流れます。リトライロジックが必要な場合は、I/O 呼び出しを明示的にラップしてください。

EF Core 11 では、`DbSet<T>` 上の同等物は `AsAsyncEnumerable` です：

```csharp
// .NET 11, C# 14, EF Core 11.0.0
await foreach (var order in db.Orders
    .Where(o => o.Status == "shipped")
    .AsAsyncEnumerable()
    .WithCancellation(cancellationToken))
{
    await sink.WriteAsync(order, cancellationToken);
}
```

これにより SQL データリーダーが開いたままになり、必要に応じて行がプルされます。完全なセットが `List<Order>` に座ることはありません。EF Core 固有の詳細については、[EF Core 11 で IAsyncEnumerable を使用する方法](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) を参照してください。

## `IQueryable<T>` が正しい戻り値型のとき

`IQueryable<T>` は、呼び出し元がまだ構成することが期待されるリポジトリ内またはクエリビルダーヘルパー内では正しい形状です。ネットワーク境界を越えたり、次の呼び出し元が理解できないかもしれないレイヤーから出ていったりするときには間違った形状です。

以下に使用します：

- 既存の `IQueryable<T>` を取って `Where` 句を追加する `Queryable` 拡張：`q.WhereActive()`。プロバイダーが述語を変換します。マテリアライズされたデータ上では実行しません。
- 呼び出し元がさらにフィルター、ページング、カウントするであろう、狭くプロジェクト固有のクエリを公開するリポジトリメソッド：`IQueryable<Invoice> Unpaid(int customerId)`。
- コンシューマーが式を構築することが期待されるライブラリ API、例えば OData コントローラーや独自の検索 DSL。

噛みつくパターンは、呼び出し元がメモリ内データを返すと想定するサービスレイヤーから `IQueryable<T>` を公開することです：

```csharp
// アンチパターン：パブリックサービスから IQueryable<T> を返さない
public IQueryable<Order> GetRecentOrders() => _db.Orders.Where(o => o.At > _start);

// 呼び出し元、はるか遠く
var bad = service.GetRecentOrders()
                 .Where(o => SomeLocalMethod(o))   // EF Core がスロー：変換不可
                 .OrderBy(o => o.Total)
                 .Take(50)
                 .ToList();
```

`SomeLocalMethod` は EF Core が変換できない C# メソッドです。`Where` 呼び出しは、プロバイダーが SQL に降ろせない式を追加し、マテリアライズ時に例外が発生します。あるいはもっと悪いことに、クライアント評価に静かにフォールバックするプロバイダーでは、誤ってすべての行をネットワーク越しに引き寄せてプロセス内でフィルターします。EF Core 11 はデフォルトでスローします。チェーンの途中に挿入された `AsEnumerable` 切り替えのある古いコードはさらに読みづらいです。

修正は境界でマテリアライズすることです：

```csharp
// .NET 11, C# 14
public async Task<IReadOnlyList<Order>> GetRecentOrdersAsync(
    int count, CancellationToken ct)
{
    return await _db.Orders
        .Where(o => o.At > _start)
        .OrderByDescending(o => o.At)
        .Take(count)
        .ToListAsync(ct);
}
```

このメソッドは具体的でマテリアライズされたコレクションを返すようになりました。呼び出し元は誤って SQL を追加できません。呼び出し元が異なるフィルターを望む場合は、パラメーターや新しいメソッドを介して明示的に求めます。これは [EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) を駆動するのと同じ理由です：クエリの境界がどこにあるかを明示的にしてください。

## ベンチマーク：100 万行を 3 つの方法でストリーミングする

実数値です。セットアップ：SQL Server 2022 内の 1,000,000 の狭い行（`Guid Id`、`int Status`、`DateTime At`）。コンシューマーはフィルター（`Status == 1`）を通過する行をカウントし、タイムスタンプの合計を書き出します。これを 3 つの方法で行います：

- `ToList()` で生成され、その後列挙される `IEnumerable<T>`。
- `AsAsyncEnumerable()` で生成される `IAsyncEnumerable<T>`。
- 同じメソッド内で `await Where(...).CountAsync()` を介して消費される `IQueryable<T>`。

```csharp
// .NET 11, C# 14, EF Core 11.0.0, BenchmarkDotNet 0.14.0
[MemoryDiagnoser]
public class SequenceShapes
{
    private AppDb _db = null!;

    [GlobalSetup] public void Setup() => _db = AppDb.Connect();

    [Benchmark]
    public long Materialize_Then_Enumerate()
    {
        var rows = _db.Events.ToList();              // pull all 1,000,000
        long sum = 0; long count = 0;
        foreach (var r in rows)
            if (r.Status == 1) { sum += r.At.Ticks; count++; }
        return sum + count;
    }

    [Benchmark]
    public async Task<long> StreamAsync()
    {
        long sum = 0; long count = 0;
        await foreach (var r in _db.Events.AsAsyncEnumerable())
            if (r.Status == 1) { sum += r.At.Ticks; count++; }
        return sum + count;
    }

    [Benchmark(Baseline = true)]
    public async Task<long> Queryable_Aggregate()
    {
        var count = await _db.Events.Where(e => e.Status == 1).CountAsync();
        var sum   = await _db.Events.Where(e => e.Status == 1)
                                    .SumAsync(e => (long)e.At.Ticks);
        return sum + count;
    }
}
```

方法論：BenchmarkDotNet 0.14.0、.NET 11.0.0 RTM、EF Core 11.0.0、ループバック越しの同一マシン上の SQL Server 2022 16.0.4135。Windows 11 24H2、AMD Ryzen 9 7900X、64 GB DDR5。数値は代表的な単一実行から。

| メソッド                        | 平均         | 割り当て    |
| ------------------------------- | ------------ | ----------- |
| Queryable_Aggregate (baseline)  | 38 ms        | 1.4 KB      |
| StreamAsync                     | 1,210 ms     | 410 MB      |
| Materialize_Then_Enumerate      | 1,380 ms     | 432 MB      |

パターンは 3 つのインターフェースの動作と一致しています。`IQueryable<T>` はデータベースにカウントと合計を行わせ、2 つのスカラーを返送させます。`IAsyncEnumerable<T>` は `ToList` してループするより全体時間を約 12 パーセント節約し、スパイク状のメモリプロファイルを節約します（`Materialize_Then_Enumerate` の `List<Event>` 割り当ては `dotnet-counters` で単一の `gen2` スパイクとして見えます）。しかし、どちらも queryable 形式に 30 倍負けます。なぜなら、その作業は本来データベースに属するもので、クライアントではないからです。

教訓は「常に IQueryable を使う」ではありません。プロバイダーのクエリ言語で表現できる操作なら、行を引き出さないこと。行を引き出さなければならない場合（CSV エクスポート、変換できない変換、個別のアイテムを欲しがる下流サービス）は、マテリアライズされた `IEnumerable<T>` よりも `IAsyncEnumerable<T>` を選ぶこと、です。

## あなたのために決めてしまう落とし穴

いくつかのことは、好みに関係なくあなたのために決めてしまいます。

- **`IQueryable<T>` は生きているプロバイダーを必要とします。** メソッドが戻るときに `DbContext` が破棄されるメソッドから `IQueryable<T>` を返すのは、変装した use-after-free です。式ツリーはまだ存在しますが、呼び出し元がそれをマテリアライズした瞬間に、`ObjectDisposedException` が飛びます。queryable の寿命の間コンテキストを生きたまま保つか、戻る前にマテリアライズするかのどちらかです。

- **`IAsyncEnumerable<T>` は `[EnumeratorCancellation]` を必要とします。** これがないと、呼び出し元が `.WithCancellation(token)` を介して渡すキャンセルトークンはプロデューサーに到達しません。コンパイラーは警告しません。バグは静かで、トークンは無視されます。Roslyn アナライザー `CA1068` は欠けているパラメーターをキャッチします。`CA2016` は、内部の非同期呼び出しへのトークン配管の欠如をキャッチします。

- **LINQ 演算子は異なります。** `Skip`、`Take`、`OrderBy`、`Select`、`Where`、`First`、`Count` は 3 つすべてに存在します。しかし、`IAsyncEnumerable<T>` は `WhereAsync`、`SelectAwait`、`SelectMany`、`GroupBy` などのために `System.Linq.Async` パッケージを必要とします。`IQueryable<T>` はプロバイダーが変換できるサブセットのみをサポートします。それ以外はすべてスロー（EF Core 11）するか、静かにクライアント評価にフォールバックします（一部の古いプロバイダー）。

- **`IQueryable<T>` は永続化モデルをリークします。** 呼び出し元が `.Where(...)` を書けるなら、呼び出し元は SQL を書いています。エンティティのカラム名のリファクタリングは、すべての queryable コンシューマーがそのカラムに触れているため、コードベース全体を検索する変更になります。マテリアライズされた DTO を返すリポジトリはスキーマを隠します。`IQueryable<Entity>` を返すものは隠しません。

- **チェーン内でそれらを混ぜること。** `IQueryable<T>` チェーンの途中で `.AsEnumerable()` または `.AsAsyncEnumerable()` を呼び出すと、残りがメモリ内評価に変換されます。その時点以降のすべての `Where` はクライアントで実行されます。これは時々あなたが望むことです（変換しない複雑な述語）。多くの場合はパフォーマンスのバグです。切り替えを明示的にし、横にコメントを置いてください。

- **`using` 内の `yield return` は問題ないが、リソースはイテレーターと同じ長さ生きる。** `FileStream` を開いて行を yield する同期イテレーターは、コンシューマーが列挙子を破棄するか反復を終了するまでファイルを開いたままにします。同じことが、より悪い失敗モードで、`DbDataReader` を保持する非同期イテレーターにも当てはまります。常に完了まで反復するか、`await foreach` を using/awaiting ブロック内で呼び出してください。

## 意見的な推奨、再述

メモリ内作業にはデフォルトで `IEnumerable<T>`。プロデューサーが `await` を必要とする瞬間に `IAsyncEnumerable<T>` に手を伸ばし、初日から `[EnumeratorCancellation]` を配管します。`IQueryable<T>` はリポジトリまたはクエリビルダーレイヤー内に留めます。サービス境界を越える前に、マテリアライズされた `IReadOnlyList<T>` または `IAsyncEnumerable<T>` に変換します。

筋肉記憶に刻む価値のある 2 つの系：

- 「呼び出し元が必要とする最小の力を返す」。概念的にリストを返すメソッドは、`IQueryable<T>` ではなく `IReadOnlyList<T>` を返すべきです。呼び出し元が必要としない力は、呼び出し元が誤用できる力です。
- 「マテリアライゼーションは境界である」。それがどこで起こるかを 1 か所で 1 回決め、その契約に向けてレイヤーの残りを書きます。すべてのメソッドが「念のため」`IQueryable<T>` を返すコードベースは、`.ToList()` 呼び出しがランダムに散在し、誰も所有しない遅いクエリの予算で終わります。

## 関連

- [EF Core 11 で IAsyncEnumerable を使用する方法](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [一括挿入における EF Core 11 vs Dapper：実際のベンチマーク](/ja/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [ホットパスで EF Core のコンパイル済みクエリを使用する方法](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [バッファリングなしで ASP.NET Core エンドポイントからファイルをストリーミングする方法](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

## 参考資料

- [IQueryable Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.linq.iqueryable-1)
- [IAsyncEnumerable Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.iasyncenumerable-1)
- [Generate asynchronous streams (async iterators) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/generate-consume-asynchronous-stream)
- [EnumeratorCancellationAttribute -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute)
- [Client vs server evaluation -- EF Core docs](https://learn.microsoft.com/en-us/ef/core/querying/client-eval)
- [System.Linq.Async on NuGet](https://www.nuget.org/packages/System.Linq.Async)
