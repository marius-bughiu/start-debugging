---
title: "ホットパス向けに EF Core でコンパイル済みクエリを使う方法"
description: "EF Core 11 のコンパイル済みクエリを実践的に解説します。EF.CompileAsyncQuery が本当に効くのはどんなときか、static フィールドのパターン、Include とトラッキングの落とし穴、追加の手間を払う価値があったと証明するためのビフォー／アフターのベンチマーク方法までを取り上げます。"
pubDate: 2026-05-02
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "ja"
translationOf: "2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths"
translatedBy: "claude"
translationDate: 2026-05-02
---

短い答え: クエリは `static readonly` フィールドとして `EF.CompileAsyncQuery` 経由で一度だけ宣言し、得られたデリゲートを保存して、呼び出しごとに新しい `DbContext` とパラメーターを渡して実行します。同じ形のクエリが毎秒数千回走るホットな読み取りエンドポイントでは、これで LINQ から SQL への変換ステップを省略でき、EF Core 11 では呼び出しあたりのオーバーヘッドを 20-40% 削減できます。ホットパス以外では、EF Core のクエリキャッシュが構造的に同一の繰り返しクエリの変換結果をすでにメモ化してくれるため、この定型コードに見合いません。

この記事では、.NET 11 上の EF Core 11.0.x における `EF.CompileQuery` と `EF.CompileAsyncQuery` の正確な動作、節約を本物にする static フィールドのパターン、コンパイル済みクエリでできないこと (実行時の `Include` の連結なし、クライアント側合成なし、IQueryable の戻り値なし)、そして自分のスキーマで効果を検証するために自分のリポジトリにそのまま貼り付けられる BenchmarkDotNet のハーネスを取り上げます。以下はすべて SQL Server に対する `Microsoft.EntityFrameworkCore` 11.0.0 を使っていますが、同じ API は PostgreSQL や SQLite でも同様に動作します。

## EF Core 11 における「コンパイル済みクエリ」の実体

`ctx.Orders.Where(o => o.CustomerId == id).ToListAsync()` と書くと、EF Core は呼び出しごとにおおよそ次の 5 つを行います。

1. LINQ 式ツリーをパースする。
2. 内部のクエリキャッシュを参照する (キャッシュキーはツリーの構造的な形とパラメーターの型)。
3. キャッシュミスのときは、ツリーを SQL に変換し、シェイパーデリゲートをビルドする。
4. 接続を開き、バインドされたパラメーター付きで SQL を送信する。
5. 結果の行をエンティティにマテリアライズする。

ステップ 2 は速いですが、無料ではありません。キャッシュ参照はハッシュキーを計算するために式ツリーをたどります。小さなクエリならマイクロ秒のオーダーです。しかし秒間 5000 リクエストをさばくホットなエンドポイントでは、そのマイクロ秒が積み上がります。`EF.CompileAsyncQuery` を使うと、初回以降の呼び出しでステップ 1 から 3 をまるごとスキップできます。起動時に式ツリーを一度 EF に渡すと、`Func` デリゲートが生成され、それ以降の呼び出しは直接ステップ 4 へ向かいます。呼び出しあたりのコストは「パラメーターを組み立て、シェイパーを実行し、行を返す」だけになります。

公式のガイダンスは [EF Core の高度なパフォーマンスドキュメント](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics) にあります。チーム自身のベンチマークによる代表値は、クエリあたりのオーバーヘッドが約 30% 削減されるというもので、変換が総時間に占める割合が大きい、小さくて頻繁に実行されるクエリで効果が最大になります。

## static フィールドのパターン

`EF.CompileAsyncQuery` の最も多い誤用は、クエリを実行するメソッドの中で呼び出してしまうことです。これでは呼び出しごとにデリゲートが作り直され、コンパイルしないより明確に悪くなります。うまく動くパターンは、これを static フィールドに置くことです。

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public static class OrderQueries
{
    public static readonly Func<ShopContext, int, Task<Order?>> GetOrderById =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int id) =>
                ctx.Orders
                    .AsNoTracking()
                    .FirstOrDefault(o => o.Id == id));

    public static readonly Func<ShopContext, int, IAsyncEnumerable<Order>> GetOrdersByCustomer =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int customerId) =>
                ctx.Orders
                    .AsNoTracking()
                    .Where(o => o.CustomerId == customerId)
                    .OrderByDescending(o => o.PlacedAt));
}
```

注目すべき点は 2 つあります。第一に、パラメーターリストは位置で決まり、型もデリゲートに焼き込まれます。`int id` はデリゲートのシグネチャの一部です。後から任意の `Expression<Func<Order, bool>>` を渡すことはできません。それを許してしまうと、そもそもの目的が崩れるからです。第二に、デリゲートは呼び出しごとに `DbContext` インスタンスを渡して実行します。

```csharp
public sealed class OrderService(IDbContextFactory<ShopContext> factory)
{
    public async Task<Order?> Get(int id)
    {
        await using var ctx = await factory.CreateDbContextAsync();
        return await OrderQueries.GetOrderById(ctx, id);
    }
}
```

ここではファクトリーパターンが重要です。コンパイル済みクエリはコンテキスト間でスレッドセーフですが、`DbContext` 自体はそうではありません。1 つのコンテキストを複数のスレッドで共有してコンパイル済みクエリを並行実行すると、他の並行 EF Core 利用と同じ競合状態を引き起こします。呼び出しごとのインスタンスには [プールされた DbContext ファクトリー](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor) を使ってください。そうしないと、新しいコンテキストの確保と構成のコストがクエリのコンパイルで節約した分を簡単に飲み込んでしまいます。

## 2 種類のフレーバーとそれぞれが効くとき

EF Core 11 は `EF` 上に 2 つの static メソッドを提供します。

- `EF.CompileQuery` は同期的な `Func<,...>` を返します。戻り値の型はラムダに応じて `T`、`IEnumerable<T>`、または `IQueryable<T>` のいずれかです。
- `EF.CompileAsyncQuery` は、単一行の終端演算子 (`First`、`FirstOrDefault`、`Single`、`Count`、`Any` など) なら `Task<T>`、ストリーミングクエリなら `IAsyncEnumerable<T>` を返します。

サーバーワークロードでは、ほぼ常に async バリアントが望ましいです。同期バリアントはデータベースへのラウンドトリップで呼び出し元のスレッドをブロックします。コンソールアプリやデスクトップクライアントなら問題ありませんが、ASP.NET Core で負荷がかかるとスレッドプールを枯渇させます。唯一の例外は、本当にブロックしたい起動時マイグレーションや CLI ツールです。

少し注意が必要なのは、`EF.CompileAsyncQuery` が `CancellationToken` パラメーターを直接受け取らないことです。トークンは周囲の非同期機構によってキャプチャされます。長時間実行されるコンパイル済みクエリをキャンセルしたい場合、[長時間タスクのキャンセルガイド](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) のパターンが依然として適用できます。リクエストスコープに `CancellationToken` を登録し、接続経由で `DbCommand` にそれを尊重させます。コンパイル済みクエリは、コンパイルされていないクエリと同じ `DbCommand.ExecuteReaderAsync` のパスを通じてトークンを伝播します。

## ゲインを示す再現コード

可能な限り小さなモデルをビルドしましょう。

```csharp
// .NET 11, EF Core 11.0.0
public sealed class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public sealed class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public decimal Total { get; set; }
    public DateTime PlacedAt { get; set; }
}

public sealed class ShopContext(DbContextOptions<ShopContext> options)
    : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();
}
```

次に、同じルックアップを実装する 2 つの版を書きます。1 つはコンパイル済み、もう 1 つはそうでないものです。

```csharp
// .NET 11, EF Core 11.0.0
public static class Bench
{
    public static readonly Func<ShopContext, int, Task<Order?>> Compiled =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int id) =>
                ctx.Orders
                    .AsNoTracking()
                    .FirstOrDefault(o => o.Id == id));

    public static Task<Order?> NotCompiled(ShopContext ctx, int id) =>
        ctx.Orders
            .AsNoTracking()
            .FirstOrDefaultAsync(o => o.Id == id);
}
```

両方を BenchmarkDotNet 0.14 に投入し、Testcontainers でバックされた SQL Server を組み合わせます。これは [Testcontainers の統合テストガイド](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) で使うのと同じハーネスです。

```csharp
// .NET 11, BenchmarkDotNet 0.14.0, Testcontainers 4.11
[MemoryDiagnoser]
public class CompiledQueryBench
{
    private IDbContextFactory<ShopContext> _factory = null!;

    [GlobalSetup]
    public async Task Setup()
    {
        // Initialise the container, run migrations, seed N rows.
        // Resolve the IDbContextFactory<ShopContext> from your service provider.
    }

    [Benchmark(Baseline = true)]
    public async Task<Order?> NotCompiled()
    {
        await using var ctx = await _factory.CreateDbContextAsync();
        return await Bench.NotCompiled(ctx, 42);
    }

    [Benchmark]
    public async Task<Order?> Compiled()
    {
        await using var ctx = await _factory.CreateDbContextAsync();
        return await Bench.Compiled(ctx, 42);
    }
}
```

2024 年のラップトップ上、ローカルの SQL Server 2025 コンテナに対して、コンパイル済み版はウォームな実行で約 25% 高速になり、LINQ 変換パイプラインが走らない分、アロケーションプロファイルも小さくなります。正確な数字は行数や列の形に大きく依存しますが、単一行の主キールックアップでは意味のある向上が期待できます。

興味深い結果は、ちょうど 1 回しか走らないクエリでは、勝ち目がないということです。コンパイル済み版もデリゲートを初回呼び出しするときに同じ変換を行います。ホットパスが「呼び出しごとに違う形」なら、コンパイル済みクエリは適切なツールではありません。報酬は繰り返しに対して支払われます。

## コンパイル済みクエリでできないこと

コンパイル済みクエリは固定された式ツリーに対する静的解析です。つまり、よくある LINQ パターンのいくつかは対象外になります。

- **条件付きの `Include` は不可**。ラムダの中で `query.Include(o => o.Customer).If(includeLines, q => q.Include(o => o.Lines))` のようなことはできません。形はコンパイル時に固定されます。
- **さらなる合成のための `IQueryable` の返却は不可**。`IAsyncEnumerable<Order>` を返せば `await foreach` で列挙できますが、その結果に対して `.Where(...)` を呼んでもサーバー側でフィルターされません。クライアント側で実行されてしまい、ゲインが帳消しになります。
- **状態のクロージャキャプチャは不可**。`EF.CompileAsyncQuery` に渡すラムダは自己完結している必要があります。外側のスコープからローカル変数やサービスフィールドをキャプチャすると、実行時に「An expression tree may not contain a closure-captured variable in a compiled query.」という例外が出ます。修正は、その値をデリゲートのシグネチャのパラメーターとして追加することです。
- **`Expression` 型の値を伴う `Skip` と `Take` は不可**。デリゲート上では `int` パラメーターでなければなりません。EF Core 8 でパラメーター駆動のページングがサポートされ、EF Core 11 でも維持されていますが、`Expression<Func<int>>` を渡すことはできません。
- **クライアント評価可能なメソッドは不可**。`Where` から `MyHelper.Format(x)` を呼ぶと、EF はそれを変換できません。コンパイルされていないクエリなら実行時の警告が出ます。コンパイル済みクエリではコンパイル時に厳格な例外になり、こちらの方がむしろ良い失敗モードです。

これらの制約は、高速化を得るための代償です。実際のクエリで分岐する形が必要なら、通常の LINQ クエリを書いて、EF Core のクエリキャッシュに仕事をさせてください。キャッシュは優秀です。ただ無料ではないというだけです。

## トラッキング、AsNoTracking、ここで効く理由

この記事のほとんどの例で `AsNoTracking()` を使っています。これは飾りではありません。トラッキング対象のエンティティに対するコンパイル済みクエリでも、マテリアライズの段階で変更トラッカーを通るので、せっかく削った分のオーバーヘッドが戻ってきます。読み取り専用のホットパスでは、`AsNoTracking` がデフォルトの選択です。

実際にトラッキングが必要 (ユーザーがエンティティを変更して `SaveChangesAsync` を呼ぶ) なら、計算は変わってきます。変更トラッカーの作業が呼び出しあたりのコストを支配するため、コンパイル済みクエリで節約できる割合は小さくなります。その場合のゲインはせいぜい 5-10% 程度で、定型コードに見合うことはまれです。

[N+1 検出ガイド](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) には、ある系があります。ナビゲーションのために `Include` を使うクエリをコンパイルすると、デカルト爆発がコンパイル済み SQL に焼き込まれます。後から `AsSplitQuery` を機会主義的に挟むことはできません。一度決めたら、その呼び出し場所に合った形を選んでください。

## ウォームアップと初回呼び出し

コンパイル作業は、static フィールドへの代入時ではなく、デリゲートへの初回呼び出しまで遅延されます。コールドスタートに厳しい P99 レイテンシ目標がある場合、コンパイル済みクエリのコードパスにヒットする最初のリクエストは、通常の初回リクエストのオーバーヘッドに加えて変換コストを支払うことになります。

最もきれいな修正方法は、アプリケーションの起動時に EF Core のモデルとコンパイル済みクエリの両方をウォームアップすることです。これは [EF Core ウォームアップガイド](/ja/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) で扱っているのと同じ考え方です。

```csharp
// .NET 11, ASP.NET Core 11
var app = builder.Build();

await using (var scope = app.Services.CreateAsyncScope())
{
    var factory = scope.ServiceProvider
        .GetRequiredService<IDbContextFactory<ShopContext>>();
    await using var ctx = await factory.CreateDbContextAsync();

    // Touch the model
    _ = ctx.Model;

    // Trigger compilation by invoking each hot-path delegate once
    _ = await OrderQueries.GetOrderById(ctx, 0);
}

await app.RunAsync();
```

`Id == 0` に対するクエリは `null` を返しますが、変換は行わせます。このブロックの後、最初の本物のリクエストはデリゲート内に SQL がキャッシュされた状態でデータベースにヒットします。

## コンパイル済みクエリを完全に避けるべきとき

コードベースのすべてのクエリをコンパイルしたくなる誘惑があります。抵抗してください。EF Core チーム自身のガイダンスは、コンパイル済みクエリを「マイクロ最適化が本当に必要な場面に限り、控えめに」使うようにと言っています。理由は次のとおりです。

- 内部のクエリキャッシュは、構造的に同一の繰り返しクエリの変換をすでにメモ化しています。ほとんどのワークロードでは、ウォームアップ後のキャッシュヒット率は 99% を超えます。
- コンパイル済みクエリはクエリ形状の真のソースをもう 1 つ追加 (static フィールドと呼び出し場所) し、リファクタリングを面倒にします。
- スタックトレースが手がかりになりにくくなります。コンパイル済みクエリでの例外はデリゲート呼び出しの場所を指し、元の LINQ 式は指しません。

正直な判断ルールは「まずプロファイリングする」です。エンドポイントを現実的な負荷で [`dotnet-trace`](/ja/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) と一緒に走らせ、EF Core のクエリ基盤に時間がどれだけ費やされているかを確認します。総リクエスト時間に対する割合が一桁台なら、放っておいてください。`RelationalQueryCompiler`、`QueryTranslationPostprocessor`、`QueryCompilationContext` で 20% 以上を見るなら、それはコンパイル済みクエリの候補です。

## うまく組み合わさる 2 つのパターン

コンパイル済みクエリは、同じ形を叩き続けるタイトループやバックグラウンド処理で最も役立ちます。

```csharp
// .NET 11, EF Core 11.0.0 - a streaming export
public static readonly Func<ShopContext, DateTime, IAsyncEnumerable<Order>> OrdersSince =
    EF.CompileAsyncQuery(
        (ShopContext ctx, DateTime since) =>
            ctx.Orders
                .AsNoTracking()
                .Where(o => o.PlacedAt >= since)
                .OrderBy(o => o.PlacedAt));

await foreach (var order in OrdersSince(ctx, cutoff).WithCancellation(ct))
{
    await writer.WriteRowAsync(order, ct);
}
```

これを [EF Core 11 の `IAsyncEnumerable<T>`](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) と組み合わせると、結果セットをバッファせず、リストを確保せず、バッチごとにコンパイル済み SQL を再利用するストリーミングエクスポートが得られます。毎晩何百万行もまたいで走るエクスポートジョブでは、その組み合わせがレイテンシとメモリ圧迫の両方を測定可能なレベルで減らします。

もう 1 つのパターンは、高カーディナリティのルックアップエンドポイントです。秒間数千リクエスト規模の公開 API で、単一行の主キーフェッチを行うようなものです。そこでは呼び出しあたりの節約が呼び出し回数倍に効き、`FirstOrDefault` のコンパイル済みクエリと [レスポンスキャッシュ](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/response) を組み合わせると、EF Core における「無料の」読み取りに最も近いものが得られます。

それ以外のすべてについては、クエリは普通の LINQ で書き、クエリキャッシュに任せて、変換ステップがボトルネックだとプロファイラーが告げたときだけ見直してください。コンパイル済みクエリはメスであって、大ハンマーではありません。
