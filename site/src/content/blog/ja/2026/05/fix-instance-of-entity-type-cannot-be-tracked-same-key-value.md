---
title: "修正: The instance of entity type cannot be tracked because another instance with the same key value is already being tracked"
description: "EF Core 11 は、1 つの DbContext 内で 2 つのオブジェクトが主キーを共有するとこの例外をスローします。古い方をデタッチするか、その場で更新してください。読み取り側の AsNoTracking で衝突を防げます。"
pubDate: 2026-05-07
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "change-tracker"
lang: "ja"
translationOf: "2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value"
translatedBy: "claude"
translationDate: 2026-05-07
---

修正方法: `DbContext` の変更トラッカーに既にこの主キーを持つエンティティが存在しており、そこに同じキーを持つ 2 つ目のインスタンスを渡してしまっています。`SetValues` で追跡中のインスタンスをその場で更新するか、自分のインスタンスをアタッチする前にデタッチするか、あるいは `AsNoTracking` で読み取って最初から何も追跡されないようにしてください。長寿命のコンテキストや「読み込んでから `Update(newDto)`」というパターンが典型的な原因です。

```text
System.InvalidOperationException: The instance of entity type 'Customer' cannot be tracked because another instance with the same key value for {'Id'} is already being tracked. When attaching existing entities, ensure that only one entity instance with a given key value is attached. Consider using 'DbContextOptions.EnableSensitiveDataLogging' to see the conflicting key values.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.IdentityMap`1.ThrowIdentityConflict(InternalEntityEntry entry)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.IdentityMap`1.Add(...)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.StateManager.StartTracking(...)
   at Microsoft.EntityFrameworkCore.DbContext.SetEntityState(...)
   at Microsoft.EntityFrameworkCore.DbContext.Update[TEntity](TEntity entity)
```

このガイドは .NET 11 preview 4 と `Microsoft.EntityFrameworkCore` 11.0.0-preview.4 を対象に書かれています。挙動は EF Core 2.0 以来同じで、リリース間で変わるのは内部のスタックトレース詳細だけです。例外は `IdentityMap<T>` の不変条件から発生します: `DbContext` は `(EntityType, PrimaryKey)` のペアごとに最大 1 つの追跡インスタンスしか保持せず、2 つ目のインスタンスはその場で拒否されます。

## なぜ identity map が存在するのか

EF Core の変更トラッカーはひとつのルールを中心に構築されています: 各エンティティ型ごとに、各主キー値は最大 1 つの CLR オブジェクトにマップされる、というルールです。このルールがあるからこそ `SaveChanges` は曖昧さなしに行が `Added`、`Modified`、`Unchanged` のいずれかを判断でき、関連データを部分的に読み込んだときにナビゲーション fix-up が動きます。同じキーを持つ 2 つのオブジェクトは「customer 42 の現在の状態は何か?」に対して競合する 2 つの答えを意味するため、変更トラッカーは 2 つ目を受け入れることを拒否します。あなたが見ている例外はその拒否であり、`SaveChanges` の呼び出しが実行される前、`DbContext` が `Attach`、`Update`、`Add`、あるいはグラフを辿る任意の操作中に競合に気づいた瞬間にスローされます。

## 最小再現コード

失敗パターンはほぼ常にこの形をしています: HTTP ハンドラーがリクエストを検証するためにエンティティを読み込み、次に DTO から同じエンティティを再生成して EF Core に更新を依頼する、という流れです。

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public record CustomerDto(int Id, string Name, string Email);

public class CustomersController(AppDb db) : ControllerBase
{
    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, CustomerDto dto)
    {
        var existing = await db.Customers.FirstOrDefaultAsync(c => c.Id == id);
        if (existing is null) return NotFound();

        var updated = new Customer
        {
            Id = dto.Id,
            Name = dto.Name,
            Email = dto.Email
        };

        db.Update(updated); // throws: id is already tracked from the read above
        await db.SaveChangesAsync();
        return NoContent();
    }
}
```

最初の `FirstOrDefaultAsync` の呼び出しは `existing` (id 42) を `Unchanged` 状態でアタッチします。次に `db.Update(updated)` は id 42 を持つ別の CLR オブジェクトをアタッチしようとします。変更トラッカーはそれを拒否します。例外メッセージには "another instance with the same key value" と書かれており、これは正確ですが疲れた午後には読み違えやすい表現です: 「2 つのインスタンス」とは、EF Core が既に知っているものと、あなたが今渡そうとしているものです。

## 3 つの修正方法、優先順位順

この順番で適用してください。最初の 2 つは問題を完全に回避します。3 つ目は本当にどうしようもない場合のためのものです。

### 1. SetValues で追跡中のエンティティをその場で更新する

行を既に読み込んだのなら、変更トラッカーが味方です。追跡中のインスタンスを変更し、EF Core に差分を計算させてください:

```csharp
// .NET 11, EF Core 11.0.0
[HttpPut("{id:int}")]
public async Task<IActionResult> Update(int id, CustomerDto dto)
{
    var existing = await db.Customers.FirstOrDefaultAsync(c => c.Id == id);
    if (existing is null) return NotFound();

    db.Entry(existing).CurrentValues.SetValues(dto);
    await db.SaveChangesAsync();
    return NoContent();
}
```

`CurrentValues.SetValues` はソースオブジェクトから一致するプロパティ名を追跡中のエンティティにコピーし、実際に変更されたカラムだけを `Modified` としてマークします。生成される `UPDATE` 文はダーティなカラムのみに触れます。これは「DTO から既存行を編集する」ための最もクリーンなパターンで、identity map 内に留まり最小限の SQL を生成します。

### 2. AsNoTracking で読み込んでから Update する

存在チェックのためだけに行を読み込んでいたのなら、追跡なしで行ってください:

```csharp
// .NET 11, EF Core 11.0.0
[HttpPut("{id:int}")]
public async Task<IActionResult> Update(int id, CustomerDto dto)
{
    var exists = await db.Customers
        .AsNoTracking()
        .AnyAsync(c => c.Id == id);
    if (!exists) return NotFound();

    var updated = new Customer { Id = dto.Id, Name = dto.Name, Email = dto.Email };
    db.Update(updated);
    await db.SaveChangesAsync();
    return NoContent();
}
```

`AnyAsync` はエンティティをマテリアライズしないので、何も追跡されません。`db.Update(updated)` は新しいインスタンスを `Modified` 状態でアタッチし、EF Core はすべてのプロパティを 1 回の `UPDATE` ラウンドトリップで書き込みます。修正 1 と比べたトレードオフは、ダーティかどうかにかかわらず全カラムが回線に書き込まれる点です。EF Core が比較できる元の値を持っていないからです。広いテーブルでは無駄が多く、狭いテーブルではこれが最もシンプルなコードです。

何が追跡され何が追跡されないかというより広範なパターンについては、[変更トラッカーのエントリー API](/2026/04/efcore-11-changetracker-getentriesforstate/) のまとめを参照してください。

### 3. 既存のエンティティをデタッチしてから自分のものをアタッチする

二重インスタンスの状況をどうしても回避できないとき (長寿命のコンテキスト、裏で読み込みを行うサードパーティライブラリなど) は、まず競合しているエントリーをデタッチしてください:

```csharp
// .NET 11, EF Core 11.0.0
public async Task ReplaceCustomer(int id, Customer incoming)
{
    var local = db.ChangeTracker.Entries<Customer>()
        .FirstOrDefault(e => e.Entity.Id == id);

    if (local is not null)
        local.State = EntityState.Detached;

    db.Update(incoming);
    await db.SaveChangesAsync();
}
```

`ChangeTracker.Entries<T>()` はインメモリで動作し、データベースには触れません。`State = Detached` を設定するとエントリーが identity map から取り除かれ、新しいインスタンスのためにキーが解放されます。これはデフォルトではなく緊急脱出口です。なぜなら、他のコードがデタッチされたインスタンスへの参照を保持している場合に、どちらのインスタンスが「勝つ」のかを考える必要が出てくるからです。

EF Core 11 では、問題のオブジェクトを既に手元に持っているときに `db.Entry(local.Entity).State = EntityState.Detached` を直接公開しています。どちらの形式も同じことを行います: identity map からエントリーを取り除く、ということです。

## これを引き起こす一般的なパターン

### Singleton として登録された、または Singleton にキャプチャされた DbContext

「コードは 1 回しか更新していないはずなのに」という報告の大半は、`DbContext` のライフタイム不一致が原因です。`DbContext` は `Scoped`、つまりリクエストごとに 1 つを意図しています。`Singleton` として登録されている (または `Singleton` に注入されている) と、各リクエストが同じ identity map にエンティティを積み上げ、同じキーの 2 回目の更新でスローされます。

```csharp
// Bad: long-lived AppDb captures the change tracker for the lifetime of the host
builder.Services.AddSingleton<AppDb>();

// Good: scoped per request, change tracker resets between requests
builder.Services.AddDbContext<AppDb>(o => o.UseSqlServer(cs));
```

`Singleton` の中で本当にコンテキストが必要な場合 (たとえば `BackgroundService` や Hangfire ジョブ) は、`IDbContextFactory<AppDb>` を注入し、作業単位ごとに新しいコンテキストを作成してください:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

public class CustomerSyncService(IDbContextFactory<AppDb> factory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            // ... work with db ...
        }
    }
}
```

### Eager 読み込みされたグラフが手動でアタッチされたエンティティとぶつかる

customer をその注文と一緒に eager 読み込みし、後で別の場所から `Attach(customer)` しようとすると (別のクエリ結果、シリアライズされたリクエストボディ、キャッシュヒットなど)、注文グラフは既に追跡されているものと衝突します。読み取り側のクエリを `AsNoTracking()` まで下げてグラフをマップに入れないようにするか、`db.Entry(customer).State = EntityState.Modified` をルートにだけ使い、子は明示的に辿ってください。

### テストでモックされた DbContext

テストを書くためにモックの `DbContext` を使っていると、モックが identity map を正しく実装していないことがよくあり、本番でこのエラーに当たってもテストはパスします。逆もあります: 実際の in-memory プロバイダーがモックでは追跡しなかったエンティティを追跡し、テスト対象のシステムとは無関係な理由でテストが失敗するパターンです。修正は実プロバイダーに対してテストすることです。[DbContext モッキングの落とし穴](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) ガイドが、モックが提供するもの・しないものをカバーしています。

### EnableSensitiveDataLogging はあなたのデバッガーです

例外メッセージが "Consider using `DbContextOptions.EnableSensitiveDataLogging` to see the conflicting key values" と言っているのには理由があります。これがないと、EF Core はログに PII が漏れるのを避けるため、エラー内に実際の主キーを隠します。どの行が重複しているかを確認するために、ローカルで有効化してください:

```csharp
// .NET 11, EF Core 11.0.0 -- development only
builder.Services.AddDbContext<AppDb>(o => o
    .UseSqlServer(cs)
    .EnableSensitiveDataLogging()
    .EnableDetailedErrors());
```

これを本番に出してはいけません。同じフラグがコマンドごとにパラメーター値をログに出力します。

## このエラーに似て非なるバリアント

### "Cannot insert explicit value for identity column"

別の例外、別の原因です: SQL Server が `IDENTITY` カラムに対する非ゼロの主キーを拒否しています。修正は `SET IDENTITY_INSERT ON`、あるいはより一般的には insert 時にキーを割り当てないことです。変更トラッカーは関与していません。

### "An attempt was made to use the model while it was being created"

これは起動順序のバグで、典型的には静的な `DbContext` フィールドや `OnModelCreating` 内でモデルを読み取ることで起こります。identity map もここでは関与していません。

### "A second operation was started on this context instance before a previous operation completed"

これは並行性であり、キー競合ではありません。スコープ付き `DbContext` はスレッドセーフではなく、同じインスタンス上で 2 つの並列 `await` を行うとこの例外が発生します。別のエラーで、修正も別 (これも `IDbContextFactory`、または作業をシリアライズすること) です。

## 関連記事

EF Core のより広い文脈については、[N+1 クエリ検出](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) のまとめ、[ホットパスでのコンパイル済みクエリ](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) のガイド、そして [EF Core エンティティとしての records](/2026/04/how-to-use-records-with-ef-core-11-correctly/) のウォークスルーを参照してください。最後の記事には `with` 式まわりの independent な identity map の落とし穴があります。リクエストハンドラーではなく起動コードでこのエラーに当たった場合は、[DefaultConnection ルックアップのチェックリスト](/2026/05/fix-no-connection-string-named-defaultconnection/) が設定側をカバーします。実データベースをコードに渡すテストフィクスチャには、[Testcontainers ウォークスルー](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) が最もクリーンなセットアップです。

## ソース

- [Tracking and No-Tracking Queries](https://learn.microsoft.com/en-us/ef/core/querying/tracking)、EF Core ドキュメント。
- [Change Tracker API](https://learn.microsoft.com/en-us/ef/core/change-tracking/)、EF Core ドキュメント。
- [Working with disconnected entity graphs](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities)、EF Core ドキュメント。
- [`IDbContextFactory<TContext>` インターフェース](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1)、Microsoft Learn。
- [`PropertyValues.SetValues` メソッド](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.propertyvalues.setvalues)、Microsoft Learn。
