---
title: "EF Core 11 のインターセプターで監査を行う方法"
description: "ISaveChangesInterceptor を使って EF Core 11 で CreatedBy/ModifiedOn 列をスタンプし、完全な変更履歴を記録します。DI のライフタイム、現在のユーザー、ExecuteUpdate の落とし穴も解説します。"
pubDate: 2026-06-08
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "ja"
translationOf: "2026/06/how-to-use-ef-core-11-interceptors-for-auditing"
translatedBy: "claude"
translationDate: 2026-06-08
---

EF Core 11 で変更を監査するには、`ISaveChangesInterceptor` を実装し(または何もしない基底クラス `SaveChangesInterceptor` を継承し)、書き込みがデータベースに到達する前に `context.ChangeTracker.Entries()` を走査するよう `SavingChangesAsync` をオーバーライドして、`optionsBuilder.AddInterceptors(...)` で登録します。インターセプターの中では、`IAuditable` マーカーを実装するエンティティに監査列(`CreatedBy`、`CreatedOnUtc`、`ModifiedBy`、`ModifiedOnUtc`)をスタンプするか、変更されたプロパティごとに別個の変更履歴行を構築します。これらはすべて `SaveChanges` と同じトランザクション内で実行されるため、監査の失敗はビジネスの書き込みも一緒にロールバックします。この記事では .NET 11、EF Core 11(`Microsoft.EntityFrameworkCore` 11.0)、C# 14 を使用します。

ここでインターセプターが適切なツールである理由は、まさにすべての書き込みが通過しなければならない要所に位置しているからです。呼び出しを忘れることはできず、忘れられたリポジトリのメソッドから迂回することもできず、すべてのプロパティの元の値と現在の値を含む、完全に投入された `ChangeTracker` を見ることができます。それこそが監査ログに必要なデータです。

## なぜ SaveChanges のオーバーライドよりインターセプターが優れているのか

「タイムスタンプをスタンプしたい」への定番の答えは、基底 `DbContext` で `SaveChanges` をオーバーライドすることです。

```csharp
// The pattern people reach for first -- it works, but it has problems
public override int SaveChanges()
{
    foreach (var entry in ChangeTracker.Entries<IAuditable>())
    {
        if (entry.State == EntityState.Added)
            entry.Entity.CreatedOnUtc = DateTime.UtcNow;
    }
    return base.SaveChanges();
}
```

これは監査をあなたの `DbContext` サブクラスに結合します。2 つ目のコンテキスト、独自のコンテキストを同梱するライブラリ、あるいは素の `DbContext` を使うテストが現れた瞬間、この振る舞いは静かに消えます。また `SaveChanges` と `SaveChangesAsync` の両方を手動でオーバーライドすることを強制し、コンテキストを HTTP の関心事に詳しくさせることなく現在のユーザーを注入する、きれいな場所をどこにも与えません。

`ISaveChangesInterceptor` は、独立した、テスト可能な、単一責任のクラスです。一度登録すれば、アタッチされたすべてのコンテキストに適用され、呼び出し側がどの `SaveChanges` オーバーロードを使ったかに応じて、EF Core が同期版または非同期版を自動的に呼び出します。公式の EF Core ドキュメントは、まさにこの種の横断的関心事のためのサポートされたフックとしてインターセプターを説明しています。[Microsoft Learn のインターセプターガイド](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors)を参照してください。

## 実際に使うインターセプターの面

`ISaveChangesInterceptor` は 6 つのメソッドを定義します。同期 3 つと非同期 3 つです。

- `SavingChanges` / `SavingChangesAsync` -- EF が SQL を生成して送信する前に発火します。`ChangeTracker` がまだアプリケーションが設定した内容を反映しているため、監査作業はここに属します。
- `SavedChanges` / `SavedChangesAsync` -- 書き込みが成功した後に発火します。書き込み前には分からなかったデータベース生成値(identity キー、計算列)を捕捉するのに使います。
- `SaveChangesFailed` / `SaveChangesFailedAsync` -- 書き込みが例外をスローしたときに発火するので、処理中の監査行を失敗としてマークできます。

インターフェースを直接実装することはまれです。6 つすべての何もしない仮想実装を提供する `SaveChangesInterceptor` を継承し、必要なものだけをオーバーライドします。

```csharp
// .NET 11, EF Core 11, C# 14
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

public sealed class AuditableEntityInterceptor : SaveChangesInterceptor
{
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        StampAuditColumns(eventData.Context);
        return base.SavingChangesAsync(eventData, result, cancellationToken);
    }

    public override InterceptionResult<int> SavingChanges(
        DbContextEventData eventData,
        InterceptionResult<int> result)
    {
        StampAuditColumns(eventData.Context);
        return base.SavingChanges(eventData, result);
    }

    private static void StampAuditColumns(DbContext? context)
    {
        if (context is null) return;
        // implementation below
    }
}
```

人がつまずく 2 つの詳細があります。1 つ目は、`eventData.Context` は null 許容なのでガードすること。2 つ目は、`SavingChanges` と `SavingChangesAsync` の両方をオーバーライドしなければならないこと。EF Core は一方をもう一方にルーティングしません。非同期版だけをオーバーライドし、コードパスのどこかで同期の `SaveChanges()` が呼ばれると、監査ロジックは決して実行されません。共有のプライベートメソッドで両方をオーバーライドするのが安全な既定です。すべてを非同期パスに強制したい場合は、同期オーバーライドから `NotSupportedException` をスローして、はぐれた同期呼び出しが監査を静かにスキップするのではなく大声で失敗するようにします。

戻り値の `InterceptionResult<int>` は、保存を抑制または置き換える方法です。監査ではこれをほぼ望まないので、受け取った `result` をそのまま通す(`base.Saving...` がやること)のが正しいです。

## 監査可能なエンティティへの監査列のスタンプ

軽量なパターン: マーカーインターフェースとシャドウまたは実プロパティです。契約を一度定義します。

```csharp
// .NET 11, C# 14
public interface IAuditable
{
    DateTime CreatedOnUtc { get; set; }
    string? CreatedBy { get; set; }
    DateTime? ModifiedOnUtc { get; set; }
    string? ModifiedBy { get; set; }
}
```

では `StampAuditColumns` を埋めます。鍵となる呼び出しは `ChangeTracker.Entries<IAuditable>()` で、インターフェースを実装する追跡対象エンティティのみを、すでに `EntityState` で分割された状態で返します。

```csharp
// .NET 11, EF Core 11, C# 14
private void StampAuditColumns(DbContext? context)
{
    if (context is null) return;

    var now = _timeProvider.GetUtcNow().UtcDateTime; // TimeProvider, .NET 8+
    var user = _currentUser.UserId ?? "system";

    foreach (var entry in context.ChangeTracker.Entries<IAuditable>())
    {
        switch (entry.State)
        {
            case EntityState.Added:
                entry.Entity.CreatedOnUtc = now;
                entry.Entity.CreatedBy = user;
                break;

            case EntityState.Modified:
                entry.Entity.ModifiedOnUtc = now;
                entry.Entity.ModifiedBy = user;
                break;

            case EntityState.Deleted:
                // optional: convert hard delete to soft delete here
                break;
        }
    }
}
```

指摘しておくべき微妙な点: 唯一変更されたプロパティが owned コレクションのメンバーシップであるエンティティ、または変更が関連エンティティに対するものであるエンティティが、ここで `Modified` として現れることがあります。「子が変更されたためだけに変更された」を無視したい場合は、追加で `entry.Properties.Any(p => p.IsModified)` をチェックできます。ほとんどの監査列のユースケースでは、単純な `State` チェックが望むものです。

`DateTime.UtcNow` を直接呼ぶのではなく、`TimeProvider` を注入してください。これにより、偽のクロックでインターセプターをユニットテスト可能になります。タイムスタンプはテストで最もアサートしたいものなので、これは重要です。

## 正しいライフタイムでインターセプターを登録する

ここが最も多くのバグ報告を生む落とし穴です。インターセプターは現在のユーザーを必要とし、それは通常 `IHttpContextAccessor` から来ます。これによりインターセプターは実質的に scoped(リクエストごと)になります。しかし安易な `AddInterceptors(new AuditableEntityInterceptor())` は、DI なしの singleton 同然のインスタンスを作ります。

インターセプターを DI に登録し、コンテキストを設定するときに解決します。

```csharp
// .NET 11, ASP.NET Core 11 -- Program.cs
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUser, HttpContextCurrentUser>();
builder.Services.AddScoped<AuditableEntityInterceptor>();

builder.Services.AddDbContext<AppDbContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
    options.AddInterceptors(
        sp.GetRequiredService<AuditableEntityInterceptor>());
});
```

`AddDbContext` は既定で scoped であり、設定コールバックがリクエストスコープの `IServiceProvider` を受け取るため、ここで scoped なインターセプターを解決すると、各リクエストに正しい `ICurrentUser` を持つ独自のインスタンスが与えられます。`IHttpContextAccessor` に依存しているのにインターセプターを singleton として登録すると、古い `HttpContext` を捕捉するか、「Cannot consume scoped service from singleton」の検証に引っかかります。まさにそのメッセージを見たことがあるなら、[cannot consume scoped service from singleton の修正](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)が、なぜコンテナがそれを拒否するのかを説明しています。

ユーザーは、コンストラクターではなく `SavingChanges` が実行される瞬間に accessor 経由で読み取り、ルックアップが常にアクティブなリクエストを反映するようにします。

```csharp
// .NET 11, C# 14
public sealed class HttpContextCurrentUser(IHttpContextAccessor accessor) : ICurrentUser
{
    public string? UserId =>
        accessor.HttpContext?.User.FindFirst("sub")?.Value;
}
```

## タイムスタンプだけでなく、完全な変更履歴を記録する

列のスタンプは「誰がいつこの行に触れたか」に答えます。変更履歴は「正確に何が変わったか」に答えます。そのためには、変更されたプロパティを走査し、元の値と現在の値を記録します。EF Core は `PropertyEntry` を通じて両方を提供します。

```csharp
// .NET 11, EF Core 11, C# 14
private static List<AuditTrail> BuildTrail(DbContext context, DateTime now, string user)
{
    var trail = new List<AuditTrail>();

    foreach (var entry in context.ChangeTracker.Entries())
    {
        if (entry.Entity is AuditTrail) continue; // never audit the audit table
        if (entry.State is EntityState.Detached or EntityState.Unchanged) continue;

        var record = new AuditTrail
        {
            TableName = entry.Metadata.GetTableName(),
            Action = entry.State.ToString(),
            UserId = user,
            TimestampUtc = now,
            Changes = new Dictionary<string, object?>()
        };

        foreach (var prop in entry.Properties)
        {
            if (entry.State == EntityState.Added)
                record.Changes[prop.Metadata.Name] = prop.CurrentValue;
            else if (entry.State == EntityState.Modified && prop.IsModified)
                record.Changes[prop.Metadata.Name] =
                    new { Old = prop.OriginalValue, New = prop.CurrentValue };
            else if (entry.State == EntityState.Deleted)
                record.Changes[prop.Metadata.Name] = prop.OriginalValue;
        }

        trail.Add(record);
    }

    return trail;
}
```

`Changes` を JSON 列にシリアライズすれば、クエリ可能な履歴が手に入ります。`entry.Properties` はスカラープロパティのみを列挙することに注意してください。ナビゲーションと owned 型を気にするなら、`entry.References` と `entry.Collections` が必要です。

## 一時キーの問題と、なぜ SavedChanges が存在するのか

データベース生成キーを持つ挿入行では、`SavingChanges` の間の `prop.CurrentValue` は一時的なプレースホルダーであり、本物の identity 値ではありません。EF Core はまだデータベースと通信していません。監査履歴が新しい行の主キーを記録する場合、`SavingChanges` でそれを捕捉すると間違った値を書き込みます。

これこそが `SavedChanges` が存在する理由のすべてです。きれいなパターンは二段階です。`SavingChanges` で監査行を構築し、インターセプターのインスタンス上に保持し、その後本物になったキー値を解決して `SavedChangesAsync` で履歴を永続化します。

```csharp
// .NET 11, EF Core 11, C# 14
private readonly List<(EntityEntry Entry, AuditTrail Record)> _pending = [];

public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
    DbContextEventData eventData, InterceptionResult<int> result,
    CancellationToken ct = default)
{
    _pending.Clear();
    var ctx = eventData.Context!;
    foreach (var entry in ctx.ChangeTracker.Entries())
        // ... stash (entry, partial record) into _pending
    return base.SavingChangesAsync(eventData, result, ct);
}

public override async ValueTask<int> SavedChangesAsync(
    SaveChangesCompletedEventData eventData, int result,
    CancellationToken ct = default)
{
    foreach (var (entry, record) in _pending)
        record.EntityId = entry.Property("Id").CurrentValue?.ToString();

    // persist _pending to the audit store now that keys are real
    return await base.SavedChangesAsync(eventData, result, ct);
}
```

インターセプターが保存ごとの状態を `_pending` に保持するようになったため、共有 singleton ではなく、必ず scoped か transient でなければなりません。singleton は並行リクエスト間で `_pending` を交錯させ、履歴を破壊します。これが、上記の DI 登録が `AddScoped` を使うもう 1 つの理由です。

ホットパスで `ChangeTracker` を走査していて `DetectChanges` がプロファイリングに現れる場合、特定の状態のエンティティだけが必要なときに、EF Core 11 の [`GetEntriesForState` API は完全な DetectChanges スキャンをスキップします](/ja/2026/04/efcore-11-changetracker-getentriesforstate/)。

## 監査を静かにスキップする落とし穴: ExecuteUpdate と ExecuteDelete

`SaveChangesInterceptor` は `SaveChanges` と `SaveChangesAsync` に対してのみ発火します。一括操作の `ExecuteUpdate` と `ExecuteDelete` は単一の SQL 文に直接変換され、エンティティを `ChangeTracker` に決して読み込まないため、監査インターセプターを完全に迂回します。これは設計上の仕様であり、「なぜこの変更が監査ログにないのか」という混乱の頻繁な原因です。

```csharp
// This UPDATE is NOT audited -- it never touches the ChangeTracker
await db.Orders
    .Where(o => o.Status == OrderStatus.Pending)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Cancelled));
```

監査が必要なコードパスなら、追跡対象エンティティと `SaveChanges` を経由させるか、呼び出し箇所で一括操作を明示的に監査します。2 つの書き込みスタイル間のトレードオフは、[EF Core 11 の一括書き込みのための ExecuteUpdate と ExecuteDelete](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) のガイドで扱っています。スループットのために一括パスを選び、それがインターセプターの外にあることを受け入れ、それを驚きではなく明示的な決定にしてください。

## 同じフックからの論理削除

インターセプターは SQL が生成される前に `EntityState.Deleted` エントリを見るため、物理削除を論理削除に変換する自然な場所です。状態を `Modified` に切り替えてフラグを設定します。

```csharp
// .NET 11, EF Core 11, C# 14
case EntityState.Deleted when entry.Entity is ISoftDeletable sd:
    entry.State = EntityState.Modified;
    sd.IsDeleted = true;
    sd.DeletedOnUtc = now;
    sd.DeletedBy = user;
    break;
```

これをグローバルクエリフィルター(`modelBuilder.Entity<T>().HasQueryFilter(e => !e.IsDeleted)`)と組み合わせて、論理削除された行が通常のクエリから消えるようにします。インターセプターとフィルターは 1 つの機能の 2 つの半分であることを覚えておいてください。インターセプターがフラグを書き、フィルターがそれを隠します。

## 動作を検証する

インターセプターは普通のクラスなので、ユニットテストが容易です。偽の `TimeProvider` と `ICurrentUser` で 1 つ構築し、インターセプターで設定されたコンテキストにエンティティを追加し、`SaveChangesAsync` を呼び出して、スタンプされた値をアサートします。エンドツーエンドのカバレッジには、`AddInterceptors` 経由で登録されたインターセプターを持つ in-memory または SQLite のコンテキストが、実際の EF パイプラインを動かします。そのテストハーネスを偽のコンテキストの周りに構築する場合、変更追跡を無傷に保つルールは [変更追跡を壊さずに DbContext をモックする方法](/ja/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) にあり、監査の書き込みがコンテキストの並行使用について例外をスローし始めたら、[a second operation was started on this context instance](/ja/2026/05/fix-second-operation-was-started-on-this-context-instance/) を参照してください。

要約: `SaveChangesInterceptor` を継承し、`SavingChanges` と `SavingChangesAsync` の両方をオーバーライドし、データのために `ChangeTracker.Entries()` を走査し、現在のユーザーを読めるようにインターセプターを DI 経由で scoped として登録し、本物のキーが必要なときは `SavedChangesAsync` を使い、`ExecuteUpdate`/`ExecuteDelete` がこのすべてを迂回することを忘れないでください。これで、ドメインロジックに監査コードを 1 行も漏らすことなく、実世界の .NET 監査要件の大多数をカバーできます。

一次情報源: Microsoft Learn の [EF Core インターセプターのドキュメント](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors)。この記事が土台とする、別個の監査データベースの正規サンプルが含まれています。
