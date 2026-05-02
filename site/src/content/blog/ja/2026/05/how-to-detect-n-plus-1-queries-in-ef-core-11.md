---
title: "EF Core 11 で N+1 クエリを検出する方法"
description: "EF Core 11 で N+1 クエリを見つけるための実践ガイドです。実際のコードで N+1 がどのように現れるか、ログ、診断インターセプター、OpenTelemetry を使ってどのように可視化するか、そしてホットパスがリグレッションしたときにビルドを壊すテストの書き方を解説します。"
pubDate: 2026-05-02
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "ja"
translationOf: "2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-05-02
---

短い答え：EF Core 11 の `LogTo` を `Microsoft.EntityFrameworkCore.Database.Command` カテゴリ、`Information` レベルでオンにし、疑わしいエンドポイントを 1 回だけ実行します。同じ `SELECT` がパラメーター値だけ違って 50 回連続して発火し、1 つの `JOIN` ではない場合、N+1 です。永続的な解決策は単に `Include` を追加することではなく、リクエストごとにコマンド数を数える `DbCommandInterceptor` と、論理操作ごとのコマンド数の上限をアサートするユニットテストを配線して、リグレッションが静かに戻ってこられないようにすることです。

この投稿では、EF Core 11 でも N+1 がどのように現れ続けるか（遅延読み込み、プロジェクション内に隠れた navigation アクセス、誤った split query）、3 層の検出（ログ、インターセプター、OpenTelemetry）、そしてエンドポイントがクエリ予算を超えたときに失敗するテストで CI でゲートする方法を扱います。すべての例は .NET 11、EF Core 11（`Microsoft.EntityFrameworkCore` 11.0.x）、SQL Server を使用していますが、プロバイダー固有のイベント名以外のすべては PostgreSQL や SQLite にもまったく同じように適用されます。

## EF Core 11 における N+1 の実際の姿

教科書的な定義は「N 件の親行を読み込む 1 つのクエリ、その後、関連するコレクションや参照を読み込むために親ごとに 1 つの追加クエリが発行され、合計で N+1 回の往復になるもの」です。実際の EF Core 11 のコードベースでは、トリガーは `Include` 上を明示的に `foreach` で回すことではほとんどありません。私が最もよく見る 4 つの形は次のとおりです：

1. **遅延読み込みがまだオン**：誰かが何年も前に `UseLazyLoadingProxies()` を追加し、コードベースが成長して、Razor ページが今や 200 件の注文を反復し、`order.Customer.Name` にアクセスしています。アクセスごとに別々のクエリが発行されます。
2. **メソッドを呼び出すプロジェクション**：`Select(o => new OrderDto(o.Id, FormatCustomer(o.Customer)))` で `FormatCustomer` が SQL に翻訳できないため、EF Core はクライアントサイドの評価にフォールバックし、行ごとに `Customer` を再取得します。
3. **誤った形に対する `AsSplitQuery`**：`.Include(o => o.Lines).Include(o => o.Customer).AsSplitQuery()` は、1 つの親 join を複数の往復に正しく分割しますが、すでに親を反復している `foreach` の中に `.AsSplitQuery()` を追加すると、往復回数を掛け算してしまいます。
4. **navigation アクセスと混ざった `IAsyncEnumerable`**：[EF Core 11 での IAsyncEnumerable](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) で `IAsyncEnumerable<Order>` をストリーミングし、コンシューマー側で `order.Customer.Email` に触れる。navigation がまだ読み込まれていない場合、列挙の各ステップで新しい往復が発生します。

これら 4 つすべてが見つけにくい理由は、`DbContext` API がデフォルトで決して例外を投げず、警告も出さないからです。クエリプランは問題ありません。唯一のシグナルはネットワーク上のチャットですが、それは見ようとしない限り見えません。

## 具体的な再現

小さなモデルを立ち上げて動かします：

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public sealed class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!;
    public decimal Total { get; set; }
}

public sealed class ShopContext(DbContextOptions<ShopContext> options)
    : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();
}
```

次に、可能な限り最悪のループを書きます：

```csharp
// Triggers N+1 if Customer is not eagerly loaded
var orders = await ctx.Orders.ToListAsync();
foreach (var order in orders)
{
    Console.WriteLine($"{order.Id}: {order.Customer?.Name}");
}
```

遅延読み込みなしでは、`order.Customer` は `null` になり、`Orders` からの `SELECT` が 1 つだけ見えます。これは別のバグ、つまり静かなデータの欠損ですが、N+1 ではありません。遅延読み込みをオンにすると、同じコードが古典的なアンチパターンになります：

```csharp
options.UseLazyLoadingProxies();
```

これで、`Orders` からの `SELECT` が 1 つ、その後、注文ごとに `SELECT * FROM Customers WHERE Id = @p0` が 1 つずつ発行されます。1000 件の注文では 1001 回の往復です。最初に必要なのは、それを見る方法です。

## レイヤー 1：LogTo と適切なカテゴリによる構造化ログ

最も速い検出シグナルは EF Core 組み込みのコマンドロガーです。EF Core 11 は `DbContextOptionsBuilder` 上に `LogTo` を公開し、イベントを `Microsoft.EntityFrameworkCore.Database.Command.CommandExecuting` 経由でルーティングします：

```csharp
services.AddDbContext<ShopContext>(options =>
{
    options.UseSqlServer(connectionString);
    options.LogTo(
        Console.WriteLine,
        new[] { RelationalEventId.CommandExecuting },
        LogLevel.Information);
});
```

ループを 1 回実行すると、コンソールが同じパラメーター化されたステートメントのコピーで埋まります。実アプリを見ているなら、代わりに `ILoggerFactory` 経由でロガーへ送ってください：

```csharp
var loggerFactory = LoggerFactory.Create(b => b.AddConsole());
options.UseLoggerFactory(loggerFactory);
options.EnableSensitiveDataLogging(); // only in dev
```

`EnableSensitiveDataLogging` のスイッチがパラメーター値を可視化します。これがないと SQL は見えても値は見えず、「100 個のうち `@p0` 以外は同じ」と気づくのがずっと難しくなります。本番ではオフのままにしてください。クエリパラメーターをログ出力するため、PII やシークレットを含む可能性があります。これに関する公式ガイダンスは [EF Core のログドキュメント](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/) にあります。

放水ホースが見えるようになれば、手動の検出ルールはシンプルです：1 つの論理的なユーザー操作に対して、異なる SQL ステートメントの数は小さな定数で抑えられているべきです。一覧エンドポイントは行数に応じてクエリ数をスケールさせるべきではありません。スケールしているなら、見つけたということです。

## レイヤー 2：スコープごとにクエリ数を数える DbCommandInterceptor

「ログを取って grep する」フローは個人開発者には十分ですが、チームには最悪です。次のレイヤーは、リクエストごとのカウンターを保持し、それに対してアサートできるようにするインターセプターです。EF Core 11 は実行されたすべてのコマンドで呼び出される [`DbCommandInterceptor`](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors) を出荷しています：

```csharp
// .NET 11, EF Core 11.0.0
public sealed class CommandCounter
{
    private int _count;
    public int Count => _count;
    public void Increment() => Interlocked.Increment(ref _count);
    public void Reset() => Interlocked.Exchange(ref _count, 0);
}

public sealed class CountingInterceptor(CommandCounter counter) : DbCommandInterceptor
{
    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result)
    {
        counter.Increment();
        return base.ReaderExecuting(command, eventData, result);
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        counter.Increment();
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }
}
```

リクエスト単位のスコープで配線します：

```csharp
services.AddScoped<CommandCounter>();
services.AddScoped<CountingInterceptor>();
services.AddDbContext<ShopContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
    options.AddInterceptors(sp.GetRequiredService<CountingInterceptor>());
});
```

これで、任意のコードパスが「今、何個の SQL コマンドを送ったか？」を O(1) で尋ねられます。ASP.NET Core 11 では、これをリクエストの周りに巻き付けます：

```csharp
app.Use(async (ctx, next) =>
{
    var counter = ctx.RequestServices.GetRequiredService<CommandCounter>();
    await next();
    if (counter.Count > 50)
    {
        var logger = ctx.RequestServices.GetRequiredService<ILogger<Program>>();
        logger.LogWarning(
            "{Path} executed {Count} SQL commands",
            ctx.Request.Path,
            counter.Count);
    }
});
```

「リクエストあたり 50 コマンドを超えたら」という騒がしい警告は、負荷テストや本番のシャドーラン中にすべての違反者を表面化させるのに十分です。これは後の CI ゲートの基礎にもなります。

これが本番でログより上手く機能する理由は量です。`Information` レベルのコマンドロガーは実アプリを溺れさせます。カウンターはリクエストあたり 1 つの整数と、違反者だけに対する条件付きのログ行 1 つです。

## レイヤー 3：データがすでにある OpenTelemetry

すでに [.NET 11 のための OpenTelemetry ガイド](/ja/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) のセットアップに従っているなら、別のカウンターはまったく必要ありません。[`OpenTelemetry.Instrumentation.EntityFrameworkCore`](https://www.nuget.org/packages/OpenTelemetry.Instrumentation.EntityFrameworkCore) パッケージは、実行されたコマンドごとに SQL を `db.statement` として 1 つの span を出力します：

```csharp
services.AddOpenTelemetry()
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddEntityFrameworkCoreInstrumentation(o =>
        {
            o.SetDbStatementForText = true;
        })
        .AddOtlpExporter());
```

子 span を HTTP の親の下にグループ化するバックエンド（Aspire ダッシュボード、Jaeger、Honeycomb、Grafana Tempo）では、N+1 のエンドポイントは、1 つの HTTP ルートと、形が同じ SQL span のスタックを持つ flame graph として現れます。視覚的なシグナルは見間違えようがありません：繰り返される子 span の四角いブロックは、毎回 N+1 です。これがあれば、日常のトリアージにログ層は実際必要ありません。

本番では `SetDbStatementForText = true` に注意してください。レンダリングされた SQL をコレクターに送るため、`WHERE` 句から識別可能な値を含む可能性があります。多くのチームは非本番ではオンにし、本番ではオフにする（あるいはサニタイズする）ようにしています。

## レイヤー 4：ビルドを壊すテスト

開発と本番での検出は必要ですが、N+1 への緩やかなリグレッションを防ぐ唯一のものはテストです。このパターンは同じカウンタリングインターセプターと、実際のデータベースを叩く [Testcontainers ベースの統合テスト](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) を使います：

```csharp
// .NET 11, xUnit 2.9, EF Core 11.0.0, Testcontainers 4.11
[Fact]
public async Task Get_orders_endpoint_executes_at_most_two_commands()
{
    await using var factory = new ShopFactory(); // WebApplicationFactory<Program>
    var counter = factory.Services.GetRequiredService<CommandCounter>();
    counter.Reset();

    var client = factory.CreateClient();
    var response = await client.GetAsync("/orders?take=100");

    response.EnsureSuccessStatusCode();
    Assert.InRange(counter.Count, 1, 2);
}
```

「1 から 2」という予算は現実的な形を反映しています：`Orders` の `SELECT` が 1 つ、`Include` で含めるなら `Customers` のためにオプションでもう 1 つ。将来の変更で `Include` が遅延読み込みに変われば、カウントは 101 に跳ね上がり、テストは失敗します。テストは SQL を知る必要も、正確なテキストを気にする必要もありません。エンドポイントごとの契約を強制するだけです。

微妙な落とし穴：カウンターはスコープ付きですが、古い EF Core バージョンでは `WebApplicationFactory` がそれをルートプロバイダーから解決します。EF Core 11 で安全なパターンは、リクエストごとのミドルウェア経由でカウンターを公開し、それを `HttpContext.Items` に格納してから、ライフタイムを制御するテストでだけ `factory.Services` から読むことです。そうしないと、別のリクエストに属するカウンターを読むリスクがあります。

## なぜ `ConfigureWarnings` だけでは話が完結しないのか

EF Core にはバージョン 3 から `ConfigureWarnings` があり、多くのガイドが `RelationalEventId.MultipleCollectionIncludeWarning` や `CoreEventId.LazyLoadOnDisposedContextWarning` で例外を投げるよう勧めます。どちらも有用ですが、どちらも N+1 を直接捕まえません。それぞれが特定の形を捕まえます：

- `MultipleCollectionIncludeWarning` は、1 つの非分割クエリ内で兄弟コレクションを 2 つ `Include` した際に発火し、デカルト積の爆発を警告します。これは別の問題（あまりに多くの行を返す 1 つの大きなクエリ）であり、解決策は `AsSplitQuery` ですが、それ自体も誤って使うと N+1 になり得ます。
- `LazyLoadOnDisposedContextWarning` は、`DbContext` が消えた後でしか発火しません。古典的な N+1 を生むコンテキスト内の遅延読み込みは捕まえません。

「あなたは今、同じクエリを 100 回実行しました」と言うただ 1 つの警告はありません。だからこそカウンターのアプローチが要となります：これは設定ではなく振る舞いを観察するからです。

## 検出した後の修正パターン

検出は仕事の半分です。カウンターのテストが失敗したら、修正は通常次のいずれかの形に収まります：

- **`Include` を追加する**。navigation が常に必要なときの最もシンプルな修正です。
- **プロジェクションに切り替える**。`Select(o => new OrderListDto(o.Id, o.Customer.Name))` は単一の SQL `JOIN` に翻訳され、完全なグラフのマテリアライズを避けます。
- **`AsSplitQuery` を使う**。親が複数の大きなコレクションを持つ場合。コレクションあたり 1 往復でも、親に対して `O(1)` でスケールします。
- **一括プリロード**。親クエリの後に外部キーのリストを持っているなら、行ごとの検索ではなく、1 つの後続 `WHERE Id IN (...)` で取ります。EF Core 11 のパラメーターリスト変換が、これを簡潔にします。
- **遅延読み込みを完全にオフにする**。`UseLazyLoadingProxies` は実行時のサプライズに見合うことがめったにありません。静的解析と明示的な `Include` のほうが、午前 3 時よりも PR の時点で多くのバグを見つけます。

ユニットテストで `DbContext` をモックすると、これらは何ひとつ表面化しません。それは、実データベースに対する統合テストに頼るもう 1 つの理由です。これは [DbContext のモックに関する投稿](/ja/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) と同じ主張です：モックは change tracker を行儀よく振る舞わせますが、N+1 を可視化するネットワーク上のチャットを再現することはできません。

## 次に見るべき場所

上のパターンは 95% 以上の N+1 を捕まえますが、隅を埋める 2 つのニッチなツールがあります。`dotnet-trace` の `database` プロファイルは、すべての ADO.NET コマンドをオフラインレビュー用に記録します。これは負荷テストでだけリグレッションが再現する場合に有用です（フローについては [dotnet-trace のガイド](/ja/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) を参照）。そして [`MiniProfiler`](https://miniprofiler.com/) は、リクエストごとの UI オーバーレイとして今でもよく動きます。「このページは 47 個の SQL クエリを実行しました」と告げる、開発者向けバッジが欲しいときに便利です。

これらすべてに共通する考えは同じです：マージ前にリグレッションを入れた開発者がそれを見られるくらい早く、ネットワーク上の活動を表面化させること。EF Core 11 はこれを以前のどのバージョンよりも簡単にしますが、オプトインしたときに限ります。デフォルトは沈黙です。
