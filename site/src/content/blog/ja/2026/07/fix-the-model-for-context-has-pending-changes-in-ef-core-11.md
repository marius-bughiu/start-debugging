---
title: "解決: EF Core 11 の \"The model for context 'X' has pending changes\""
description: "モデルが直近のマイグレーションのスナップショットと一致しないと EF Core は PendingModelChangesWarning を投げます。マイグレーションを追加するか、誤検知の原因を直します。"
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "migration"
lang: "ja"
translationOf: "2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-29
---

`dotnet ef migrations add <Name>` を実行し、続けて `dotnet ef database update` を実行してください。EF Core 9.0 以降、`Migrate()`、`MigrateAsync()`、`dotnet ef database update` は現在のモデルと直近のマイグレーションが書き出したスナップショットを比較し、差分があれば `PendingModelChangesWarning` を投げます。原因は圧倒的多数のケースで、モデルを変更したのに対応するマイグレーションを作っていないことです。生成したマイグレーションが空だったり、作り直すたびに同じ内容になったりする場合は誤検知です。`HasData` の非決定的な値、モデルスナップショットの欠落、スタートアッププロジェクトにしか存在しない Identity のオプション、あるいは古い EF Core バージョンで作られたスナップショットが原因になります。この記事は C# 14 を使う .NET 11 上の EF Core 11.0 (執筆時点では preview 6、GA は 2026 年 11 月) を対象としており、内容は例外が導入された EF Core 9.0 までそのまま当てはまります。

## エラーの実際の出力

起動時の `Database.Migrate()` 呼び出しから投げられるランタイム例外です。

```
Microsoft.EntityFrameworkCore.Migrations[20409]
System.InvalidOperationException: An error was generated for warning 'Microsoft.EntityFrameworkCore.Migrations.PendingModelChangesWarning': The model for context 'AppDbContext' has pending changes. Add a new migration before updating the database. See https://aka.ms/efcore-docs-pending-changes. This exception can be suppressed or logged by passing event ID 'RelationalEventId.PendingModelChangesWarning' to the 'ConfigureWarnings' method in 'DbContext.OnConfiguring' or 'AddDbContext'.
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.ValidateMigrations(String targetMigration)
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
   at Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions.Migrate(DatabaseFacade databaseFacade)
```

CLI から出る同じ失敗はもっと短く、終了コードは 0 以外になります。

```
Build started...
Build succeeded.
The model for context 'AppDbContext' has pending changes. Add a new migration before updating the database. See https://aka.ms/efcore-docs-pending-changes.
```

イベント ID `20409` は `RelationalEventId.PendingModelChangesWarning` (`CoreEventId.RelationalBaseId + 409`) で、ログカテゴリーは `Microsoft.EntityFrameworkCore.Migrations` です。EF Core 9.0.0 のメッセージには `aka.ms` のリンクがなく、9.0 と 11.0 の文面の違いはそこだけです。

## なぜ起きるのか

このチェックが比較するのは 2 つのモデルです。1 つは EF がいま `DbContext` から構築するデザイン時モデル、もう 1 つは最後に `migrations add` を実行したときに `Migrations/AppDbContextModelSnapshot.cs` へシリアライズされたモデルスナップショットです。データベースは**見ていません**。これがこのエラーについて知っておくべき最も重要な点で、完全に最新のデータベースがあってもエラーは防げませんし、古いデータベースがエラーの原因になることもありません。

この比較は、マイグレーションの生成を支えているものと同じです。EF Core 自身の `Migrator` の実装を見てみます。

```csharp
// efcore/src/EFCore.Relational/Migrations/Internal/Migrator.cs, EF Core 11
public bool HasPendingModelChanges()
    => _migrationsModelDiffer.HasDifferences(
        FinalizeModel(_migrationsAssembly.ModelSnapshot?.Model)?.GetRelationalModel(),
        _designTimeModel.Model.GetRelationalModel());
```

この形から 2 つのことが導けます。第一に、差分は*リレーショナル*モデルに対して取られるため、エンティティクラスだけでなく、列の型、長さ、null 許容性、インデックス、制約名まで見ています。`450` だったものが `HasMaxLength(128)` になっていれば、C# のプロパティが 1 つも変わっていなくても保留中の変更です。第二に、`ModelSnapshot` が `null` の場合はソースモデルも `null` になり、モデル内のすべてのテーブルが差分として扱われます。

EF チームの動機は単純です。モデルがマイグレーションより先に進んでいる状態で黙ってマイグレーションを適用すると、コードと一致しないデータベースができあがり、その不整合はずっと後になって本番環境で「列がない」という例外として表面化します。EF Core 9.0 より前は、`Migrate()` は手元にあるマイグレーションを適用して何も言わずに戻っていました。

## 最小の再現コード

ファイル 2 つと、忘れられたコマンド 1 つです。

```csharp
// .NET 11, EF Core 11.0.0, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
using Microsoft.EntityFrameworkCore;

public class Blog
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public string? Slug { get; set; }   // added after the last migration
}

public class AppDbContext : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer("Server=.;Database=Demo;Trusted_Connection=True;Encrypt=False");
}
```

```csharp
// Program.cs, .NET 11
using var db = new AppDbContext();
db.Database.Migrate();   // throws PendingModelChangesWarning
```

`Slug` を追加し、`dotnet ef migrations add AddBlogSlug` を飛ばすと、次の `Migrate()` が例外を投げます。ここでデータベースは無関係です。削除しても、作り直しても、新しいサーバーに向けても、まったく同じ例外が出ます。

## 修正方法、可能性の高い順

**1. 忘れていたマイグレーションを追加する。** 大半のケースではこれが正しい修正です。

```bash
dotnet ef migrations add AddBlogSlug
```

その後 `dotnet ef database update` で適用するか、次回起動時の `Migrate()` に任せます。EF Core 11 ではこの 2 ステップを 1 つにまとめることもでき、再ビルドできないコンテナーでアプリケーションが動いている場合に便利です。`dotnet ef database update AddBlogSlug --add` はマイグレーションを生成し、Roslyn でコンパイルし、単一のコマンドで適用します。詳しくは[マイグレーションの作成と適用を 1 ステップで行う方法](/ja/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)を参照してください。

**2. 欠落した、あるいは手で編集されたスナップショットを作り直す。** 誰かがマイグレーションクラスを手書きした、`AppDbContextModelSnapshot.cs` を削除した、あるいはそのファイルのマージ競合を片側まるごと採用して解決した場合、スナップショットはマイグレーションが生み出すモデルをもう表していません。ツールを使って `dotnet ef migrations add` を一度実行してください。生成されたマイグレーションに実際のずれが入り、副作用としてスナップショットが書き直されます。エラーを消すためにスナップショットを手で編集してはいけません。次に生成されるマイグレーションは、そこに残したものと比較されるからです。

**3. 非決定的な `HasData` の値を定数に置き換える。** シードオブジェクトの中の `Guid.NewGuid()` や `DateTime.UtcNow` はモデルが構築されるたびに評価されるため、モデルは実行のたびに本当にスナップショットと異なります。EF Core はこのケースを個別に検出し、エラーに続けて 2 つ目の診断メッセージを出します。

> The model for context '{contextType}' changes each time it is built. This is usually caused by dynamic values used in a 'HasData' call (e.g. `new DateTime()`, `Guid.NewGuid()`). Add a new migration and examine its contents to locate the cause, and replace the dynamic call with a static, hardcoded value.

修正は値をハードコードすることです。

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Entity<Blog>().HasData(new Blog
{
    Id = 1,
    Name = "Start Debugging",
    // Not Guid.NewGuid(), not DateTime.UtcNow.
    PublicId = Guid.Parse("9e4f49fe-0786-44c6-9061-53d2aa84fab3"),
    CreatedUtc = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
});
```

以前のマイグレーションはランダムな値を取り込んでいるので、モデルを直したらマイグレーションを作り直してください。データが本当に動的でなければならないなら、そもそもモデルに置く対象ではありません。スナップショットの外で動作する `UseSeeding`/`UseAsyncSeeding` に移してください。手順の全体は [HasData から UseAsyncSeeding への移行](/ja/2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11/)にまとめてあり、トレードオフは [HasData vs UseSeeding](/ja/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/) で整理しています。

**4. EF のツールにアプリケーションと同じ設定を渡す。** ASP.NET Core Identity が典型例です。`Stores.SchemaVersion` や `Stores.MaxLengthForKeys` のようなオプションはモデルを変えますが、設定されるのはアプリケーションの DI コンテナーの中なので、`DbContext` のプロジェクトだけを対象にツールを実行すると EF のツールからは見えません。その結果、スナップショットは動作中のアプリケーションが構築するモデルとは別のモデルを表すことになります。アプリケーションをスタートアッププロジェクトとして渡すか、

```bash
dotnet ef migrations add AddBlogSlug --project src/Data --startup-project src/Web
```

コンテキストの隣に `IDesignTimeDbContextFactory<T>` を実装して、両方の経路が同じようにモデルを構築するようにします。

```csharp
// .NET 11, EF Core 11.0.0
public class AppDbContextDesignTimeFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var services = new ServiceCollection();
        services.AddDefaultIdentity<ApplicationUser>(options =>
            {
                options.Stores.SchemaVersion = IdentitySchemaVersions.Version2;
                options.Stores.MaxLengthForKeys = 256;
            })
            .AddEntityFrameworkStores<AppDbContext>();

        var optionsBuilder = new DbContextOptionsBuilder<AppDbContext>();
        optionsBuilder.UseApplicationServiceProvider(services.BuildServiceProvider());
        optionsBuilder.UseSqlServer();
        return new AppDbContext(optionsBuilder.Options);
    }
}
```

**5. 古い EF Core バージョンが書いたスナップショットを作り直す。** スナップショットの生成はリリースごとに改善されるため、EF Core 6 が作ったスナップショットは、コードを一切変えていなくても EF Core 11 のモデルとの差分になり得ます。これも EF Core は `RelationalEventId.OldMigrationVersion` (`20414`) で検出します。"Pending model changes were detected for context '{contextType}', but the model snapshot was created with EF Core version '{efVersion}'." 空のマイグレーションを追加して現在のバージョンでスナップショットを書き直し、その `Up` が本当に空であることを確認したうえで残してください。これは [EF Core 6 から EF Core 11 への移行](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)では定番の手順です。

**6. 抑制する。ただし本当に誤検知である 2 つのケースに限る。** EF のサービスを差し替えてマイグレーションを動的に生成または選択している場合や、移行すべきものが残っていないと確認できている場合は、この特定のイベントだけを抑制します。

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContext<AppDbContext>(options => options
    .UseSqlServer(connectionString)
    .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning)));
```

完全に黙らせるのではなくログに残したい場合は、代わりに `w.Log(RelationalEventId.PendingModelChangesWarning)` を使います。最後のマイグレーションを生成したプロバイダーと適用するプロバイダーが違う場合 (ローカルは SQLite、本番は SQL Server) も抑制しか手がありませんが、Microsoft はこれを明確にサポート対象外で将来動かなくなる可能性が高いとしています。プロバイダーごとに別のマイグレーション一式を生成してください。

## 自分がどの原因に当たるかを見分ける方法

例外ではなく、コマンドから始めてください。`dotnet ef migrations has-pending-model-changes` は EF Core 8.0 からあり、モデルがずれていると 0 以外の終了コードで終わります。デプロイ前の CI で実行するのにちょうどよいコマンドです。

```bash
dotnet ef migrations has-pending-model-changes
```

プログラムからの同等物である `context.Database.HasPendingModelChanges()` を使えば、同じチェックを、マイグレーションを忘れたプルリクエストで失敗するテストにできます。

```csharp
// .NET 11, EF Core 11.0.0, xUnit v3
[Fact]
public void Model_has_no_pending_changes()
{
    using var context = new AppDbContext();
    Assert.False(context.Database.HasPendingModelChanges());
}
```

次にマイグレーションを生成して読みます。生成された `Up` メソッドこそが差分の中身です。`AddColumn` があればどのプロパティを忘れたかが分かり、既存の `nvarchar(450)` 列に対する `maxLength: 128` の `AlterColumn` があればモデルとデータベーススキーマで長さの認識が食い違っていることが分かり、毎回新しい GUID が入る `InsertData` があれば原因 3 だと分かります。実体のないマイグレーションだった場合は `dotnet ef migrations remove` で削除してください。

生成されたマイグレーションが空なのにエラーが出続ける場合、EF 自身の比較はスキャフォールダーが出力していない何かを見ています。`HasPendingModelChanges` がやっていることをなぞって、生の操作を出力してみましょう。

```csharp
// .NET 11, EF Core 11.0.0. Uses EF internals: pin your EF version if you keep this.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

using var context = new AppDbContext();

var differ = context.GetService<IMigrationsModelDiffer>();
var initializer = context.GetService<IModelRuntimeInitializer>();
var snapshot = context.GetService<IMigrationsAssembly>().ModelSnapshot?.Model;

var source = snapshot is null ? null : initializer.Initialize(snapshot).GetRelationalModel();
var target = context.GetService<IDesignTimeModel>().Model.GetRelationalModel();

foreach (var operation in differ.GetDifferences(source, target))
{
    Console.WriteLine(operation.GetType().Name);
}
```

`IMigrationsModelDiffer` は公開インターフェースですが内部利用向けのサービスなので、これは本番コードではなくデバッグ用のツールとして扱ってください。

## 落とし穴とよく似たケース

**ロールバックで発生しなくなったのは 9.0.2 から。** EF Core 9.0.0 と 9.0.1 は、古いマイグレーションを明示的に指定した場合でも `PendingModelChangesWarning` を投げていたため、警告を抑制しない限りロールバックできませんでした。これは 9.0.2 で修正され、ターゲットのマイグレーションを指定していないときだけチェックが走るようになりました。したがって `dotnet ef database update AddBlogSlug` や `dotnet ef database update 0` は保留中の変更があっても動作します。

**"No migrations were found in assembly" は EF Core 11 の兄弟であって、同じエラーではありません。** `RelationalEventId.MigrationsNotFound` (`20406`) は以前は情報ログでしたが、EF Core 11.0 から既定で例外を投げます。マイグレーションが 1 つもないときに発生し、たいていは DACPAC や手書きの SQL でスキーマを管理しているのに習慣で `Migrate()` を呼んでいるケースです。`Migrate()` の呼び出しを削除するか、`w.Ignore(RelationalEventId.MigrationsNotFound)` でこの別イベントを抑制してください。

**`DbContext` の型ごとにマイグレーションが必要です。** `AppDbContext` にマイグレーションを追加しても `AuditDbContext` には何の効果もありません。例外にはコンテキスト名が入っているので、それを読んで `dotnet ef migrations add <Name> --context AuditDbContext` としてください。

**マルチターゲットのプロジェクトは EF Core 10 以降 `--framework` が必要です。** プロジェクトが `<TargetFrameworks>` を使っている場合、ツールはモデルの比較に到達する前に "The project targets multiple frameworks" で止まります。`--framework net11.0` を渡してください。

**`EnsureCreated()` はこのエラーを投げません。** マイグレーションをまったく使わないため、スナップショットも読まず、マイグレーション履歴も適用しません。テストでは `EnsureCreated()`、本番では `Migrate()` という組み合わせなら、失敗するのは本番の経路だけです。

**データベースのスキーマは依然として検証されません。** このチェックを通ったということは、モデルが直近のマイグレーションと一致しているという意味です。そのマイグレーションが適用済みかどうか、本番で誰かが列を手で書き換えていないかどうかについては何も保証しません。そのギャップを埋めるのは、[migration bundle による EF Core 11 マイグレーションの適用](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)で説明したように、スキーマ変更を独立したデプロイ手順として実行することです。

## 関連記事

- [migration bundle で EF Core 11 のマイグレーションを本番に適用する](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)：`has-pending-model-changes` チェックをデプロイパイプラインのどこに置くか。
- [マイグレーションの作成と適用を 1 コマンドで行う](/ja/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)：EF Core 11 の `--add` オプション。
- [HasData から UseAsyncSeeding への移行](/ja/2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11/)：このエラーを繰り返し引き起こすシードデータの恒久的な対策。
- [EF Core 11 の HasData vs UseSeeding](/ja/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/)：どちらのシード機構がモデルに属し、どちらが属さないか。
- [EF Core 6 から EF Core 11 への移行](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)：同じアップグレードで浮上する他の破壊的変更。

## 参考資料

- [EF Core 9 の破壊的変更: 保留中のモデル変更があるとマイグレーション適用時に例外が投げられる](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes)：原因と回避策の公式な一覧。Identity のデザイン時ファクトリーのサンプルもここにあります。
- [EF Core 11 の破壊的変更: マイグレーションが見つからない場合に既定で例外を投げるようになった](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)：`MigrationsNotFound` の変更。
- [マイグレーションの管理: 保留中のモデル変更の確認](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing)：`has-pending-model-changes` と `HasPendingModelChanges()`。
- [dotnet/efcore#35285: 9.0 の PendingModelChangesWarning エラーの背景と情報](https://github.com/dotnet/efcore/issues/35285)：誤検知に関する EF チーム自身の整理。
- [dotnet/efcore#35342](https://github.com/dotnet/efcore/issues/35342) と 9.0.2 での修正：ロールバックのリグレッション。
- [dotnet/efcore の Migrator.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs) と [RelationalStrings.resx](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Properties/RelationalStrings.resx)：比較処理そのものと、メッセージの正確な文面。
