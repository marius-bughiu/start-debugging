---
title: "EF Core のモデルを最初のクエリの前にウォームアップする方法"
description: "EF Core は最初の DbContext アクセスで概念モデルを遅延構築するため、新しいプロセスでの最初のクエリは以後のどのクエリよりも数百ミリ秒遅くなります。本ガイドでは EF Core 11 で実用に足る三つの対策を扱います: Model に触れて接続を開く起動時の IHostedService、事前コンパイル済みモデルを出荷する dotnet ef dbcontext optimize、そして二つの対策を静かに無効化するキャッシュキーの落とし穴です。"
pubDate: 2026-04-27
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "performance"
  - "startup"
  - "csharp"
lang: "ja"
translationOf: "2026/04/how-to-warm-up-ef-core-model-before-the-first-query"
translatedBy: "claude"
translationDate: 2026-04-29
---

新しい `DbContext` を介した最初のクエリは、アプリケーションが実行する中で最も遅いものであり、データベースとは関係ありません。EF Core は host が起動したときに内部モデルを構築しません。何かが `DbContext.Model` を読む、クエリを実行する、`SaveChanges` を呼ぶ、あるいは単に `DbSet` を列挙するまで待ちます。その時点で規約パイプライン全体をエンティティ型に対して実行しますが、リレーション、インデックス、value converter を持つ 50 エンティティのモデルでは 200~500 ms かかることがあります。同じプロセス内の以後の context は 1 ms 未満でキャッシュ済みモデルを得ます。本ガイドは EF Core 11(`Microsoft.EntityFrameworkCore` 11.0.0、.NET 11、C# 14)で実際に数値を動かす三つの対策を示します: 起動時の明示的なウォームアップ、`dotnet ef dbcontext optimize` が生成する事前コンパイル済みモデル、そして上記二つを静かに無効化するモデルキャッシュキーの落とし穴です。

## データベースが温まっていても最初のクエリが遅い理由

`DbContext.Model` は規約パイプラインによって構築された `IModel` のインスタンスです。規約は数十個の `IConvention` 実装(リレーション発見、キー推論、owned 型検出、外部キー命名、value converter 選択、JSON カラムマッピングなど)で、各エンティティ型のすべてのプロパティと各ナビゲーションを巡回します。出力は不変のモデルグラフで、EF Core はこれを `IModelCacheKeyFactory` が生成するキーの下にプロセス寿命の間保持します。

既定の `AddDbContext<TContext>` 登録では、この作業は遅延します。コールドスタート時のランタイムシーケンスは次のようになります。

1. host が起動。`IServiceProvider` が構築される。`TContext` は scoped として登録される。モデル関連は何も走っていません。
2. 最初の HTTP リクエストが届く。DI コンテナが `TContext` を解決します。コンストラクタは `DbContextOptions<TContext>` を保存して戻ります。まだモデル関連は何も走っていません。
3. ハンドラが `await db.Blogs.ToListAsync()` を書く。EF Core は `Set<Blog>()` を解決し、それが `Model` を読み、規約パイプラインを起動します。これが 200~500 ms です。
4. その後クエリがコンパイルされ(LINQ から SQL への変換、パラメータバインド、executor キャッシュ)、さらに 30~80 ms 加わります。
5. クエリがついにデータベースに到達します。

ステップ 3 と 4 はプロセスごと、`DbContext` 型ごとに一度だけ発生します。同じ context 型を通る 5 番目のリクエストは両方のコストをゼロとして見ます。「最初のリクエストが遅く、以降は速い」がこれだけきれいに再現する理由はそこにあり、データベースのチューニングでは振り払えない理由でもあります。作業はあなたのプロセス内にあって線上にはありません。

新しいプロセスで連続する 2 つのクエリにストップウォッチを置けば、その非対称性が直接見えます。

```csharp
// .NET 11, EF Core 11.0.0, C# 14
var sw = Stopwatch.StartNew();
await using (var db = new BloggingContext(options))
{
    _ = await db.Blogs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == 1);
}
Console.WriteLine($"first:  {sw.ElapsedMilliseconds} ms");

sw.Restart();
await using (var db = new BloggingContext(options))
{
    _ = await db.Blogs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == 1);
}
Console.WriteLine($"second: {sw.ElapsedMilliseconds} ms");
```

SQL Server 2025 を対象とする 30 エンティティのデモモデルで EF Core 11.0.0 を温まったノート PC で動かすと、1 回目のイテレーションはおよそ `380 ms` を、2 回目はおよそ `4 ms` を出力します。モデル構築が支配的です。同じコードがコールドな AWS Lambda(host が呼び出しごとに立ち上がる)に対して動くと、その 380 ms はそのままユーザーから見える p99 レイテンシに着地します。これは [.NET 11 AWS Lambda のコールドスタート時間を縮める](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) で扱った問題のクラスそのものです。

## 対策その一: IHostedService で起動時にモデルをウォームアップ

最も安価な対策は、本番のコードパスを一切変えずに「最初のリクエスト」のコストを「host 起動」へ移すことです。context を解決し、モデルの実体化を強制し、終了するだけが仕事の `IHostedService` を登録します。host は listening ソケットを開く前に `StartAsync` でブロックするので、Kestrel がリクエストを受け付ける時点で規約パイプラインはすでに走り、キャッシュ済みの `IModel` がオプションのインスタンスに座っています。

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class EfCoreWarmup(IServiceProvider sp, ILogger<EfCoreWarmup> log) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        await using var scope = sp.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BloggingContext>();

        // Forces the conventions pipeline to run and the IModel to be cached.
        _ = db.Model;

        // Forces the relational connection-string parsing and the SqlClient pool
        // to allocate one physical connection. ADO.NET keeps it warm in the pool.
        await db.Database.OpenConnectionAsync(ct);
        await db.Database.CloseConnectionAsync();

        log.LogInformation("EF Core warm-up done in {Elapsed} ms", sw.ElapsedMilliseconds);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

`AddDbContext` の後にぶら下げます。

```csharp
// Program.cs, .NET 11, ASP.NET Core 11
builder.Services.AddDbContext<BloggingContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Db")));
builder.Services.AddHostedService<EfCoreWarmup>();
```

これが正しくやっていて、自前のウォームアップではよく外す 3 つのこと:

1. context をスコープに入れます。`AddDbContext` は `TContext` を scoped として登録するので、ルートプロバイダから解決すると例外を投げます。`CreateAsyncScope` は文書化されたパターンです。
2. `db.Model` を読み、`db.Set<Blog>().FirstOrDefault()` を読みません。`Model` を読むことで、いかなる LINQ クエリもコンパイルせずに規約パイプラインを起動でき、スキーマがまだ整っていないことで失敗しうるデータベースへのラウンドトリップ(Aspire の `WaitFor` 順序や、host 起動後に走るマイグレーションを思い浮かべてください)からウォームアップを切り離します。
3. SqlClient プールが温まるように接続を開いて閉じます。プールは物理接続を短い窓の間アイドルで保持するので、最初の本物のリクエストはモデル構築に加えて TCP と TLS のセットアップを払うことはありません。

プール付き context 登録(`AddDbContextPool<TContext>`)も同じウォームアップが必要で、ただプールから解決します。どちらのパターンでも動作しますが、テストでモデルを差し替えるために登録を変えなければならないなら、サービスプロバイダを丸ごと再構築せずに行うサポートされた方法として [EF Core 11 の RemoveDbContext / プールド factory のテストでの差し替え](/ja/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) を参照してください。

この対策はほとんどの ASP.NET Core アプリには十分です。モデルは依然として runtime に構築されますが、コストを host 起動の窓に隠しただけで、その窓は普通は無料か無料に近いです。実際にコストを取り除く対策は次にあります。

## 対策その二: dotnet ef dbcontext optimize で事前コンパイル済みモデルを出荷する

EF Core 6 でコンパイル済みモデル機能が導入され、EF Core 7 で安定化し、EF Core 11 で残りの制限のうち十分なものが直され、コールドスタートを気にするどのサービスでも妥当な既定になりました。アイデア: 規約パイプラインを runtime に走らせる代わりに、ビルド時に走らせて、生成された C# として手書きの `IModel` を放出します。runtime では context が事前構築されたモデルを直接ロードし、規約を完全にスキップします。

CLI コマンドはワンショットです。

```bash
# .NET 11 SDK, dotnet-ef 11.0.0
dotnet ef dbcontext optimize \
  --output-dir GeneratedModel \
  --namespace MyApp.Data.GeneratedModel \
  --context BloggingContext
```

これは `BloggingContextModel.cs`、`BlogEntityType.cs`、`PostEntityType.cs` のようなファイル群のフォルダを書き出します。フォルダをソース管理に追加し、`UseModel` を生成された singleton に向けると、runtime のモデル構築が消えます。

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContext<BloggingContext>(o => o
    .UseSqlServer(builder.Configuration.GetConnectionString("Db"))
    .UseModel(MyApp.Data.GeneratedModel.BloggingContextModel.Instance));
```

同じ 30 エンティティのデモモデルで、最初のクエリはこの変更後 380 ms からおよそ 18 ms へ落ちます。残るコストはその特定のクエリ形状に対する LINQ-to-SQL 変換で、これはクエリ形状ごとであり、同じクエリの 2 回目の呼び出しはすでにキャッシュされます。クエリがリクエストごとに同じものなら、EF のクエリキャッシュがイテレーション 2 でコストを食べ尽くすので、最初のリクエストは事実上定常状態と同じ速さになります。

これを最初にやると噛みつかれる詳細が三つあります。

1. **モデル変更時には再生成。** 最適化されたモデルはスナップショットです。プロパティ、インデックス、`OnModelCreating` のルールを足して `dotnet ef dbcontext optimize` を再実行せずに出荷すると、EF Core が検出して投げる runtime のミスマッチが起きます。コマンドをビルドにフックする(`<Target Name="OptimizeEfModel" BeforeTargets="BeforeBuild">`)か、マイグレーションを走らせるのと同じステップに入れて、ドリフトしないようにしてください。
2. **`--precompile-queries` フラグは EF Core 11 preview に存在します。** 既知のクエリに対して LINQ-to-SQL レイヤーへ最適化を拡張します。`Microsoft.EntityFrameworkCore.Tools` 11.0.0 時点で preview として文書化されており、公式の[事前コンパイル済みクエリのドキュメント](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-queries)で読める属性を放出します。reflection が制限される AOT 拘束のアプリ、あるいはマージナルな 30~80 ms がまだ重要なホットパスで使ってください。
3. **事前コンパイル済みモデルは Native AOT で必須です。** `OnModelCreating` は AOT のトリマーが静的解析できない reflection パスを走らせるため、事前コンパイル済みモデルなしでは公開アプリは `DbContext` に最初に触れたときにクラッシュします。host の残りでも AOT を考えているなら、[Native AOT を ASP.NET Core minimal API で使う](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) と同じ制約が EF Core にも適用されます。

CI で `dotnet ef migrations` を既に動かしているサービスなら、同じステップに `dotnet ef dbcontext optimize` を加えるのは YAML 2 行で、コールドスタートのたびに永続的に元が取れます。

## 二つの対策を破るモデルキャッシュキーの落とし穴

ウォームアップがきれいに走り、事前コンパイル済みモデルもきれいにロードされ、それでも最初のユーザー向けクエリが*まだ*遅い、というバグのカテゴリがあります。原因はほぼ常に `IModelCacheKeyFactory` です。EF Core は実体化された `IModel` を、factory が返すオブジェクトをキーとして静的辞書にキャッシュします。既定の factory は context の型そのものをキーとして返します。`OnModelCreating` が runtime 状態(テナント id、カルチャ、機能フラグ)を参照していると、その状態の値ごとにモデルを別々にキャッシュする必要があり、factory を置き換えて EF Core にそれを伝えなければなりません。

```csharp
// .NET 11, EF Core 11.0.0
public sealed class TenantBloggingContext(
    DbContextOptions<TenantBloggingContext> options,
    ITenantProvider tenant) : DbContext(options)
{
    public string Tenant { get; } = tenant.CurrentTenant;

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Blog>().ToTable($"Blogs_{Tenant}");
    }
}

public sealed class TenantModelCacheKeyFactory : IModelCacheKeyFactory
{
    public object Create(DbContext context, bool designTime) =>
        context is TenantBloggingContext t ? (context.GetType(), t.Tenant, designTime) : context.GetType();
}
```

オプションに置き換えを登録します。

```csharp
builder.Services.AddDbContext<TenantBloggingContext>(o => o
    .UseSqlServer(connStr)
    .ReplaceService<IModelCacheKeyFactory, TenantModelCacheKeyFactory>());
```

ウォームアップ対策なしだとここで二つのことがおかしくなります。

- テナント `acme` の最初のリクエストはキャッシュキー `(TenantBloggingContext, "acme", false)` でモデルを再構築します。テナント `globex` の最初のリクエストは `(TenantBloggingContext, "globex", false)` で再び再構築します。それぞれ異なるキャッシュキーが規約パイプラインを 1 度ずつ叩きます。1 つのテナントしか解決しないナイーブなウォームアップは、N 個のキャッシュのうち 1 つしか温めません。
- 必要以上の状態(例えば `IConfiguration` のスナップショット全体)をクローズオーバーするキャッシュキー factory はキャッシュを断片化させます。リクエストのたびにモデルが再構築されることが分かったら、`IModelCacheKeyFactory.Create` の戻り値をログに出して、それが不安定でないかを確認してください。

最初に紹介したウォームアップ対策はそのまま使えますが、関心のあるキャッシュキーの次元を巡回する必要があります。hosted service で、起動完了を宣言する前に既知のテナントごとに context を解決します。テナント集合が無制限なら(マルチテナント SaaS の顧客ごとサブドメインなど)事前コンパイル済みモデル対策も救ってくれません。`dotnet ef dbcontext optimize` は 1 つのスナップショットを生成するのであって、テナントごとの族を生成するのではないからです。その場合は、テナントごとの初回ヒットコストを受け入れ、より厳しい `UseQuerySplittingBehavior` と [EF Core 11 が split queries で reference join を刈り取る方法](/ja/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) で扱った小さなリレーショナル改善でそれに上限をかけます。

## 実用的な作業順序

「何を、どの順番でやるべきか」のために来たなら、これが私が実サービスで実行する手順です。

1. 計測する。新しいプロセスで最初の 3 クエリにストップウォッチをかけてください。最初のクエリが 50 ms 未満なら何もしないでください。
2. `EfCoreWarmup` `IHostedService` を追加する。30 行のコードで、ユーザーから見える 300 ms を host 起動時の 300 ms に変換します。
3. 起動時間そのものが重要なら(Lambda、Cloud Run、autoscaler)、`dotnet ef dbcontext optimize` を実行して `UseModel(...)` する。コマンドを CI に加える。
4. カスタムの `IModelCacheKeyFactory` があるなら、それが何を捕えているか監査する。キー集合が列挙可能であることを確認し、各エントリを温める。無制限なら、キーごとのコストを受け入れて、それと闘うのをやめる。
5. 2 番目のクエリも遅いなら、コストは LINQ 変換にあって、モデル構築ではない。`DbContextOptionsBuilder.EnableSensitiveDataLogging` と `RelationalEventId.QueryExecuting` でフィルタした `LogTo` を調べるか、クエリを事前コンパイルする。

これは任意のキャッシュをウォームアップするのと同じ形状です: コストの所在を見つけ、前に動かし、ストップウォッチで動かしたことを検証する。

## 関連

- [変更追跡を壊さずに DbContext をモックする方法](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [EF Core 11 で IAsyncEnumerable を使う方法](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [.NET 11 AWS Lambda のコールドスタート時間を縮める方法](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)
- [EF Core 11: RemoveDbContext とプールド factory のテストでの差し替え](/ja/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)
- [EF Core 11 preview 3 が split queries で reference join を刈り取る](/ja/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/)

## 出典

- [EF Core compiled models](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-models) - Microsoft Learn
- [EF Core advanced performance topics: compiled queries](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-queries) - Microsoft Learn
- [`dotnet ef dbcontext optimize` reference](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#dotnet-ef-dbcontext-optimize) - Microsoft Learn
- [`IModelCacheKeyFactory` API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.imodelcachekeyfactory) - Microsoft Learn
- [EF Core testing strategies](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) - Microsoft Learn
