---
title: "EF Core 11 で名前付きクエリフィルターを使ってソフト削除とマルチテナンシーを実装する方法"
description: "EF Core 11 で同じエンティティに 2 つの独立したグローバルクエリフィルターを適用します。ソフト削除フィルターとテナントフィルターにそれぞれ名前を付け、IgnoreQueryFilters で一方だけを無効化できるようにします。"
pubDate: 2026-07-03
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "ja"
translationOf: "2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

EF Core 11 で同じエンティティにソフト削除フィルターとマルチテナンシーフィルターの両方を適用するには、それぞれに名前を付けます。`OnModelCreating` で `HasQueryFilter("SoftDeletionFilter", e => !e.IsDeleted)` と `HasQueryFilter("TenantFilter", e => e.TenantId == _tenantId)` を呼び出します。どちらも既定ですべてのクエリに適用されます。管理画面でソフト削除された行を表示する必要があるときは、`IgnoreQueryFilters(["SoftDeletionFilter"])` でそのフィルターだけを無効化します。テナントフィルターは有効なままなので、別のテナントのデータを漏らすことは決してありません。名前付きクエリフィルターは EF Core 10 で登場し、EF Core 11 ではフィルターを重ねる標準的な方法です（`Microsoft.EntityFrameworkCore` 11.0、.NET 11、C# 14）。この記事では、テナント ID をコンテキストに配線し、削除を自動的にスタンプし、フィルターを選択的に無効化する完全な設定と、行を静かに取りこぼす join の落とし穴を示します。

## エンティティごとに 1 つのフィルターでは決して足りなかった理由

グローバルクエリフィルターは、EF Core がエンティティ型へのすべてのクエリに注入する追加の `Where` 句です。2 つのユースケースが主流です。ソフト削除は `DELETE` を発行する代わりに `IsDeleted` フラグを立てて行をテーブルに残すので、監査証跡と取り消しの道が得られます。マルチテナンシーは多数の顧客の行を `TenantId` 列を持つ 1 つのテーブルに保存し、フィルターはクエリが現在のテナントの行だけを見ることを保証します。どちらもまさに、すべての `Where` に手で書きたくない横断的な述語です。なぜなら、忘れる 1 か所がそのままデータ漏洩のバグになるからです。

EF Core 10 より前の問題は、各エンティティ型がちょうど 1 つのフィルターしか持てなかったことです。`HasQueryFilter` を 2 回呼び出しても述語は重ならず、最初のものを静かに置き換えてしまいました。

```csharp
// EF Core 9 and earlier -- the second call WINS, soft delete is lost
modelBuilder.Entity<Invoice>().HasQueryFilter(i => !i.IsDeleted);
modelBuilder.Entity<Invoice>().HasQueryFilter(i => i.TenantId == _tenantId);
// Result: only the tenant filter is active. Deleted rows come back.
```

回避策は、すべてを `&&` で 1 つの式に結合することでした。

```csharp
// EF Core 9 -- works, but the two concerns are now welded together
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);
```

これはコンパイルされ、正しくフィルターしますが、鋭い刃があります。半分だけをオフにできないのです。`IgnoreQueryFilters()` は全か無かです。管理レポートがソフト削除された請求書を含める必要が生じた瞬間、`IgnoreQueryFilters()` を呼び出すと、今度はテナントフィルターも消えてしまいます。マルチテナントシステムでは、これは不便ではなく、セキュリティインシデントです。名前付きフィルターは、まさに「一方を無効化し、もう一方を残す」を可能にするために存在します。

## 1 つのエンティティに 2 つの名前付きフィルターを定義する

EF Core 11 では、`HasQueryFilter` に第 1 引数としてフィルターキーを取るオーバーロードがあります。名前を渡すと、呼び出しは上書きではなく合成されます。

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
public class Invoice
{
    public int Id { get; set; }
    public int TenantId { get; set; }
    public bool IsDeleted { get; set; }
    public decimal Amount { get; set; }
}

public class BillingContext(string tenantId) : DbContext
{
    private readonly int _tenantId = int.Parse(tenantId);

    public DbSet<Invoice> Invoices => Set<Invoice>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>()
            .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
            .HasQueryFilter("TenantFilter", i => i.TenantId == _tenantId);
    }
}
```

これで、普通のクエリは両方の述語でフィルターされます。

```csharp
// SELECT ... FROM Invoices WHERE NOT IsDeleted AND TenantId = @__tenantId
var invoices = await context.Invoices.ToListAsync();
```

両方の述語は、`&&` 版が生成していたのとまったく同じように、`AND` で結合されて同じ SQL `WHERE` 句に着地します。違いは完全に次に何ができるかにあります。各述語には、名前でつかめる取っ手が付きました。

コンパイラーが捕まえないルールが 1 つあります。同じエンティティ型で名前付きフィルターと無名フィルターを混在させることはできません。`Invoice` のいずれかのフィルターに名前が付いたら、すべてに名前が必要です。すでに名前付きフィルターを持つエンティティに無名の `HasQueryFilter(i => ...)` を付けると、モデル構築時に例外がスローされます。エンティティごとに 1 つのスタイルを選び、それを貫いてください。

## テナント ID をコンテキストに載せる

ソフト削除フィルターは定数式ですが、テナントフィルターには実行時の値が必要で、フィルターはコンテキストインスタンス上に存在する状態しか読めません。もっともきれいな配線は、コンテキストが構築されるときに現在のテナントを一度だけ解決することです。ASP.NET Core アプリでは、通常これは認証済みユーザーから読み取り、依存性注入でコンテキストに渡すことを意味します。

```csharp
// .NET 11 -- resolve tenant per request and feed it to the context
builder.Services.AddScoped<ITenantProvider, HttpTenantProvider>();

builder.Services.AddDbContext<BillingContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
});

// A small provider that pulls the tenant from the current principal
public sealed class HttpTenantProvider(IHttpContextAccessor accessor) : ITenantProvider
{
    public int TenantId =>
        int.Parse(accessor.HttpContext!.User.FindFirstValue("tenant_id")!);
}
```

次に、コンテキストからプロバイダーを参照します。テナントをフィールドにキャッシュするのではなく、フィルター内で遅延的に読み取ることは見た目以上に重要で、次のセクションでその理由を説明します。

```csharp
// EF Core 11 -- the filter closes over a field EF re-reads on each query
public class BillingContext(DbContextOptions<BillingContext> options,
                            ITenantProvider tenant) : DbContext(options)
{
    private int TenantId => tenant.TenantId;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>()
            .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
            .HasQueryFilter("TenantFilter", i => i.TenantId == TenantId);
    }
}
```

EF Core はテナント式をモデル構築時ではなくクエリ時に評価するので、プロパティはクエリごとに読み取られ、パラメーターに変換されます。これにより、コンパイル済みのクエリプランをテナント間で再利用可能に保ちつつ、行を分離できます。

### DbContext プーリングの罠

`AddDbContextPool` を使う場合は注意してください。プールされたコンテキストはリクエスト間で再利用され、再利用時にコンストラクターは再実行されません。コンストラクター内でフィールドに取り込まれたテナント ID は、そのプールされたインスタンスを受け取る 2 番目のリクエストでは古くなります。テナントスコープのコンテキストではプーリングを避けるか、上記のようにクエリ時に読み取られる scoped プロバイダーを通じてテナントを解決してください。構築時に凍結された値ではいけません。これは、名前付きテナントフィルターが本番でデータを漏らす最も一般的な経路です。

## 呼び出し箇所すべてに触れずにソフト削除する

フィルターは削除された行を隠しますが、何かが依然として `IsDeleted = true` を設定しなければなりません。これをサービス全体に散らばらせたくはありません。`SaveChangesAsync` をオーバーライドし、すべての書き込みが通過するチョークポイントで削除を更新に変換します。

```csharp
// EF Core 11 -- intercept deletes and turn them into soft deletes
public override async Task<int> SaveChangesAsync(CancellationToken ct = default)
{
    ChangeTracker.DetectChanges();

    foreach (var entry in ChangeTracker.Entries<Invoice>()
                 .Where(e => e.State == EntityState.Deleted))
    {
        entry.State = EntityState.Modified;
        entry.CurrentValues["IsDeleted"] = true;
    }

    return await base.SaveChangesAsync(ct);
}
```

これで、`context.Invoices.Remove(invoice)` の後に `SaveChangesAsync` を実行すると、フラグを切り替える `UPDATE` が発行され、クエリフィルターが通常の読み取りから行を消します。すでに監査スタンプ用に `ISaveChangesInterceptor` を実行しているなら、そちらがこのロジックのさらに良い置き場所です。`SaveChanges` を触らずに保ち、どのリポジトリから呼ばれても生き延びるインターセプター版については、[EF Core 11 のインターセプターを監査に使う方法](/ja/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)を参照してください。

## 一方のフィルターを無効化し、もう一方を残す

これこそが名前付けの全目的です。`IgnoreQueryFilters` はフィルター名のコレクションを受け取り、それらだけがオフになります。

```csharp
// EF Core 11 -- see deleted invoices, but STILL scoped to the current tenant
var withDeleted = await context.Invoices
    .IgnoreQueryFilters(["SoftDeletionFilter"])
    .ToListAsync();
// SQL: WHERE TenantId = @__tenantId   (soft-delete predicate dropped, tenant kept)
```

テナントフィルターは触られないので、「削除済みを含むすべての請求書」を見ている管理者が別の顧客のデータを見ることは決してありません。引数なしの `IgnoreQueryFilters()` は依然として存在し、依然としてすべてを無効化します。これはテナントでフィルターされたエンティティではほぼ絶対に望まないものです。テナント列を持つあらゆるテーブルでは、引数なしの呼び出しをコードの臭いとして扱ってください。

### フィルターは文字列リテラルではなく定数で名付ける

フィルター名はマジックストリングであり、`IgnoreQueryFilters(["SoftDeletonFilter"])` のタイプミスは何も無効化しないまま静かに失敗します。名前を一度だけ固定しましょう。

```csharp
// EF Core 11 -- one source of truth for filter names
public static class InvoiceFilters
{
    public const string SoftDelete = nameof(SoftDelete);
    public const string Tenant = nameof(Tenant);
}

modelBuilder.Entity<Invoice>()
    .HasQueryFilter(InvoiceFilters.SoftDelete, i => !i.IsDeleted)
    .HasQueryFilter(InvoiceFilters.Tenant, i => i.TenantId == TenantId);
```

次に、ignore の呼び出しを拡張メソッドでラップして、どの呼び出し側もフィルター名を打ち込まないようにします。

```csharp
// EF Core 11 -- intent-revealing API, filter name hidden
public static IQueryable<Invoice> IncludeDeleted(this IQueryable<Invoice> query)
    => query.IgnoreQueryFilters([InvoiceFilters.SoftDelete]);

// Call site reads like English and cannot leak tenants
var report = await context.Invoices.IncludeDeleted().ToListAsync();
```

## 行を静かに取りこぼす必須ナビゲーションの join

クエリフィルターで最もやっかいな落とし穴は名前付けとは無関係で、すべてのテーブルがフィルターを持つマルチテナントモデルで最も強く噛みつきます。フィルターされたエンティティがナビゲーションの必須側にあるとき、EF Core は `Include` を `INNER JOIN` に変換します。フィルターが親行を除去すると、inner join は子も除去し、期待より少ない結果になります。

必須の `Post` 子を持つフィルター済み `Blog` を考えます。

```csharp
// EF Core 11 -- required navigation plus a filter on the principal
modelBuilder.Entity<Blog>().HasMany(b => b.Posts).WithOne(p => p.Blog).IsRequired();
modelBuilder.Entity<Blog>().HasQueryFilter("UrlFilter", b => b.Url.Contains("fish"));

var allPosts = await db.Posts.ToListAsync();                       // returns 6
var withBlog = await db.Posts.Include(p => p.Blog).ToListAsync();  // returns 3
```

2 番目のクエリは、ブログがフィルターされたすべての投稿を取りこぼします。`INNER JOIN` が一致するブログ行を要求するからです。Microsoft のドキュメントはこれを直接指摘しています。グローバルクエリフィルターが定義されたエンティティに到達するために必須ナビゲーションを使うと「予期しない結果につながることがある」。修正は 2 つあります。ナビゲーションをオプショナルにして、EF に `LEFT JOIN` を生成させます。

```csharp
// EF Core 11 -- LEFT JOIN keeps the children even when the parent is filtered
modelBuilder.Entity<Blog>().HasMany(b => b.Posts).WithOne(p => p.Blog).IsRequired(false);
```

あるいは、マルチテナンシーにはより良い方法として、両端に同じフィルターを一貫して適用し、宙に浮くはずの子行をその発生源で除去します。

```csharp
// EF Core 11 -- matching filters on both entities keep the two queries in sync
modelBuilder.Entity<Blog>().HasQueryFilter("UrlFilter", b => b.Url.Contains("fish"));
modelBuilder.Entity<Post>().HasQueryFilter("UrlFilter", p => p.Blog.Url.Contains("fish"));
```

一貫したフィルターのアプローチは、テナント列がすべてのテーブルに存在する場合の正しい既定値です。`Blog` と `Post` の両方に `TenantFilter` があれば、`INNER JOIN` も `LEFT JOIN` も他テナントの行を浮かび上がらせることはできません。

## 採用前に知っておく価値のある制限

いくつかの制約が、これをどこまで押し進められるかを形作ります。フィルターは継承階層のルートエンティティ型にしか定義できないので、table-per-hierarchy マッピングで派生型ごとに異なるフィルターを付けることはできません。EF Core はフィルター定義の循環を検出しないので、`Post` を参照する `Blog` のフィルターと、`Blog` を参照する `Post` のフィルターは、変換中に無限ループに陥ることがあります。慎重に定義してください。そして、`OnModelCreating` で直接ではなく `IEntityTypeConfiguration<T>` クラスでエンティティを構成する場合、`Configure` 内にはテナントを読み取れるコンテキストのインスタンスがありません。文書化された回避策は、構成クラスにプライベートなコンテキストフィールドを追加し、フィルター式からそれを参照することです。

パフォーマンスに関する注記。テナント値はクエリパラメーターになるため、ソフト削除とテナントの述語は、インライン化された定数のようにクエリプランのキャッシュを断片化しません。これにより、名前付きフィルターは重いマルチテナント負荷の下でも安価なままです。フィルターを追加しながらクエリ数を監査しているなら、[EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)と突き合わせてください。ナビゲーションを通り抜けるフィルターは、計画していなかった join を追加することがあるからです。

名前付きクエリフィルターは、グローバルフィルターを鈍器から組み立て可能なものへと変えます。2 つの述語、2 つの名前、そしてちょうど 1 つのクエリのためにちょうど 1 つを持ち上げられる能力。それが、ソフト削除のトグルと偶発的なテナント侵害との違いです。

## 関連記事

- [EF Core 11 のインターセプターを監査に使う方法](/ja/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [EF Core 11 で ExecuteUpdate と ExecuteDelete を一括書き込みに使う方法](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [Fix: EF Core 11 でエンティティを削除するときの FOREIGN KEY constraint failed](/ja/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [EF Core 11 の AsNoTracking と AsNoTrackingWithIdentityResolution](/ja/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [EF Core 11 でキーセット（カーソル）ページネーションを行う方法](/ja/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/)

## 出典

- [Global Query Filters、EF Core ドキュメント（Microsoft Learn）](https://learn.microsoft.com/en-us/ef/core/querying/filters)
- [What's New in EF Core 10（Microsoft Learn）](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Named Query Filters in EF 10、Milan Jovanovic](https://www.milanjovanovic.tech/blog/named-query-filters-in-ef-10-multiple-query-filters-per-entity/)
