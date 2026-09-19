---
title: "EF Core 11 のマイグレーションで主キー、外部キー、インデックスにカスタム命名規則を適用する方法"
description: "EF Core 11 が生成する PK_、FK_、AK_、IX_ の名前を 1 つの IModelFinalizingConvention ですべて付け替え、明示的に指定した名前を優先させ、識別子の長さ制限に収め、既存データベースで次のマイグレーションが生成するクラスター化インデックスの再構築を回避します。"
pubDate: 2026-09-19
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "ja"
translationOf: "2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-19
---

結論から言うと、`IModelFinalizingConvention` を実装したクラスを 1 つ書き、各エンティティ型で宣言されているキー、外部キー、インデックスをループし、規約ビルダー (`key.Builder.HasName(...)`、`fk.Builder.HasConstraintName(...)`、`index.Builder.HasDatabaseName(...)`) を通して名前を設定します。登録は `ConfigureConventions` で `configurationBuilder.Conventions.Add(_ => new ConstraintNamingConvention())` と書きます。ビルダーは名前を `Convention` ソースとして記録するので、Fluent API や `[Index(Name = ...)]` で明示的に設定した名前は引き続き優先されます。新しいデータベースならこれで作業は完了です。既存のデータベースでは、次のマイグレーションが名前を変えるためだけにすべての主キーと外部キーを削除して追加し直すので、そのマイグレーションを手で編集して名前の変更に置き換えてください。

この記事の内容はすべて .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`) と `Microsoft.EntityFrameworkCore.SqlServer` `11.0.0-rc.1.26425.128` で実行しています。掲載している DDL とマイグレーション SQL は、SQL Server モデルに対する `Database.GenerateCreateScript()` と `IMigrationsSqlGenerator` の実際の出力です。データベースサーバーは使っていないので実行時間の計測はなく、EF Core が送信する SQL だけを示しています。

## EF Core 11 がデフォルトで選ぶ名前

小さなモデルから始めます。一意の `Slug` 代替キーを持つ `Blog`、`Blog` と (任意で) `Author` を参照する `Post`、`Author.Email` の一意インデックス、`Post` の複合インデックス、そして `Post` と `Tag` の間のスキップナビゲーションによる多対多です。

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public string Slug { get; set; } = "";
    public List<Post> Posts { get; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
    public int? AuthorId { get; set; }
    public Author? Author { get; set; }
    public List<Tag> Tags { get; } = [];
}

public class Author { public int Id { get; set; } public string Email { get; set; } = ""; }
public class Tag { public int Id { get; set; } public string Name { get; set; } = ""; public List<Post> Posts { get; } = []; }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();
    public DbSet<Author> Authors => Set<Author>();
    public DbSet<Tag> Tags => Set<Tag>();

    protected override void OnModelCreating(ModelBuilder mb)
    {
        mb.Entity<Blog>().HasAlternateKey(b => b.Slug);
        mb.Entity<Author>().HasIndex(a => a.Email).IsUnique();
        mb.Entity<Post>().HasIndex(p => new { p.BlogId, p.Title });
    }
}
```

生成される SQL Server の DDL は 4 つのパターンを使います。

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, default names
CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id]),
CONSTRAINT [AK_Blogs_Slug] UNIQUE ([Slug])
CONSTRAINT [FK_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE
CONSTRAINT [FK_PostTag_Tags_TagsId] FOREIGN KEY ([TagsId]) REFERENCES [Tags] ([Id]) ON DELETE CASCADE
CREATE UNIQUE INDEX [IX_Authors_Email] ON [Authors] ([Email]);
CREATE INDEX [IX_Posts_BlogId_Title] ON [Posts] ([BlogId], [Title]);
```

つまりデフォルトは `PK_{table}`、`AK_{table}_{columns}`、`FK_{dependent table}_{principal table}_{columns}`、`IX_{table}_{columns}` で、一意インデックスも一意でないインデックスと同じ `IX_` プレフィックスになります。パターンに使われるのは CLR 型名ではなく *テーブル* 名 (`DbSet` 由来の `Blogs`) である点に注意してください。Microsoft Learn のドキュメントの一部では主キーのデフォルトを `PK_<type name>` と説明していますが、これは両者がたまたま一致する場合にしか当てはまりません。

チームがこれを変えたくなる理由はたいてい 3 つのどれかです。DBA の標準 (`pk_`、`fk_`、一意インデックスには `ux_`)、ほかがすべて小文字の PostgreSQL データベース、あるいは別のツールで作られた既存スキーマの名前に EF Core を逆らわせず合わせたい場合です。

## 個別の名前: HasName、HasConstraintName、HasDatabaseName

特定の名前が必要なオブジェクトがごく少数なら、Fluent API にはオブジェクトの種類ごとのメソッドがあります。

```csharp
// .NET 11, EF Core 11 - per-object names
mb.Entity<Blog>().HasKey(b => b.Id).HasName("pk_blog");
mb.Entity<Blog>().HasAlternateKey(b => b.Slug).HasName("ak_blog_slug");

mb.Entity<Post>()
    .HasOne(p => p.Blog).WithMany(b => b.Posts)
    .HasForeignKey(p => p.BlogId)
    .HasConstraintName("fk_post_blog");

mb.Entity<Author>().HasIndex(a => a.Email).IsUnique().HasDatabaseName("ux_author_email");
```

インデックスには属性形式 `[Index(nameof(Email), IsUnique = true, Name = "ux_author_email")]` もあります。属性の `Name` がデータベース上の名前になります。

この方法はスケールしません。新しいエンティティのたびに同じ 3 つの呼び出しが必要になり、スキップナビゲーションの結合テーブルは忘れやすく、誰かがこの呼び出しなしでインデックスを追加した日には `IX_` に逆戻りです。こういうときこそ規約の出番です。

## すべてに名前を付けるモデル最終化規約

[モデルの一括構成](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) に関する EF Core のドキュメントでは、カスタム規約を 2 種類に分けて説明しています。対話型の規約は、モデルの変更が起きるたびにそれぞれに反応します。*モデル最終化* 規約は `OnModelCreating` と組み込み規約がすべて終わった後に一度だけ実行され、ほぼ最終形のモデルを参照します。制約名はテーブル名と列名に依存し、それらはモデル構築の最後まで変わる可能性があるので、最終化規約が適切なフックです。もっと早く実行すると、後の `HasColumnName` で名前が変わる列にちなんでインデックスに名前を付けてしまいます。

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Metadata.Conventions;

public sealed class ConstraintNamingConvention : IModelFinalizingConvention
{
    public void ProcessModelFinalizing(
        IConventionModelBuilder modelBuilder,
        IConventionContext<IConventionModelBuilder> context)
    {
        var maxLength = modelBuilder.Metadata.GetMaxIdentifierLength();

        foreach (var entityType in modelBuilder.Metadata.GetEntityTypes())
        {
            var table = entityType.GetTableName();
            if (table is null) continue; // views, keyless query types, TPC abstract roots
            var store = StoreObjectIdentifier.Table(table, entityType.GetSchema());

            foreach (var key in entityType.GetDeclaredKeys())
            {
                var name = key.IsPrimaryKey()
                    ? $"pk_{table}"
                    : $"ak_{table}_{Columns(key.Properties, store)}";
                key.Builder.HasName(Truncate(name, maxLength));
            }

            foreach (var fk in entityType.GetDeclaredForeignKeys())
            {
                var principalTable = fk.PrincipalEntityType.GetTableName();
                if (principalTable is null) continue;
                var name = $"fk_{table}_{principalTable}_{Columns(fk.Properties, store)}";
                fk.Builder.HasConstraintName(Truncate(name, maxLength));
            }

            foreach (var index in entityType.GetDeclaredIndexes())
            {
                var prefix = index.IsUnique ? "ux" : "ix";
                var name = $"{prefix}_{table}_{Columns(index.Properties, store)}";
                index.Builder.HasDatabaseName(Truncate(name, maxLength));
            }
        }
    }

    static string Columns(IEnumerable<IConventionPropertyBase> props, StoreObjectIdentifier store)
        => string.Join("_", props.Select(p =>
            (p as IConventionProperty)?.GetColumnName(store) ?? p.Name));

    static string Truncate(string name, int maxLength)
    {
        if (name.Length <= maxLength) return name;
        // keep names unique after truncation: prefix + 8 hex chars of a stable hash
        var hash = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(name)))[..8].ToLowerInvariant();
        return $"{name[..(maxLength - 9)]}_{hash}";
    }
}
```

コンテキストに登録します。

```csharp
// .NET 11, EF Core 11
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    => configurationBuilder.Conventions.Add(_ => new ConstraintNamingConvention());
```

`Conventions.Add` がインスタンスではなくファクトリを受け取るのは、規約が EF Core の内部サービスプロバイダーからサービスを取得できるようにするためです。この規約には依存関係がないので、引数は破棄の `_` にしています。

同じモデルから次の出力が得られます。

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, with ConstraintNamingConvention
CONSTRAINT [pk_Blogs] PRIMARY KEY ([Id]),
CONSTRAINT [ak_Blogs_Slug] UNIQUE ([Slug])
CONSTRAINT [fk_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE
CONSTRAINT [pk_PostTag] PRIMARY KEY ([PostsId], [TagsId]),
CONSTRAINT [fk_PostTag_Tags_TagsId] FOREIGN KEY ([TagsId]) REFERENCES [Tags] ([Id]) ON DELETE CASCADE
CREATE INDEX [ix_Posts_BlogId_Title] ON [Posts] ([BlogId], [Title]);
CREATE INDEX [ix_PostTag_TagsId] ON [PostTag] ([TagsId]);
```

暗黙の `PostTag` 結合テーブルは、モデル内の実際の (共有型) エンティティ型であり `GetEntityTypes()` が返すので、追加のコードなしで対象になります。

このコードのいくつかの細部は意図的なものです。

**セッターではなく規約ビルダーを使います。** `key.Builder.HasName(...)` は `ConfigurationSource.Convention` で名前を設定します。EF Core は構成の各部分がどこから来たかを追跡しており、規約由来の値が `DataAnnotation` や `Explicit` の値を上書きすることはありません。再現環境では一意インデックスに `OnModelCreating` で `.HasDatabaseName("UX_Authors_Email_Legacy")` と明示的な名前を付けたままにしましたが、出力には `CREATE UNIQUE INDEX [UX_Authors_Email_Legacy]` が残り、ほかのインデックスはすべて `ix_`/`ux_` の扱いを受けました。代わりに `OnModelCreating` の最後のループで可変のセッター (`IMutableKey.SetName`) を呼ぶと、この優先順位が失われ、同僚が意図して設定した名前を黙って上書きしてしまいます。

**プロパティ名ではなく、ストアオブジェクトに対する列名を使います。** `GetColumnName(StoreObjectIdentifier)` は、`HasColumnName` による上書きや `Where_City` のような所有型のプレフィックスを含め、テーブルに実際にある名前を返します。CLR プロパティにちなんでインデックスに名前を付けると、対象の列と一致しない名前になります。

**EF Core 11 では `Properties` は `IConventionPropertyBase` です。** EF Core 11 RC 1 では `IConventionKey.Properties` の型が `IReadOnlyList<IConventionPropertyBase>` なので、`IEnumerable<IConventionProperty>` として宣言したヘルパーは CS1503 でコンパイルに失敗します。`Columns` 内のキャストがこれに対処し、単純なスカラープロパティでないものはメンバー名にフォールバックします。

## 展開の進め方: 新しいデータベースと既存のデータベース

命名規約はモデルを変えるので、`dotnet ef migrations add` は差分を検出します。問題になるのはその差分の中身です。

1. **新しいプロジェクト、またはまだデプロイ済みのデータベースがない場合。** 最初のマイグレーションの前に規約を追加します。`InitialCreate` に新しい名前が入り、ほかに何もする必要はありません。
2. **既存のデータベースで、テーブルが小さい場合。** マイグレーションを生成し、中身を読んでから適用します。EF Core はキーを再構築しますが、テーブルが小さければ問題ありません。
3. **既存のデータベースで、テーブルが大きい場合。** マイグレーションを生成し、誰かが適用する前に削除と追加のペアを名前の変更に置き換えます。

手順 3 が何のことかを正確に確かめるため、`migrations add` が使うのと同じコンポーネントである `IMigrationsModelDiffer` で、デフォルト名のモデルと規約で名前を付けたモデルの差分を取りました。インデックスは低コストな名前の変更として出てきます。

```sql
-- EF Core 11.0.0-rc.1: RenameIndexOperation on SQL Server
EXEC sp_rename N'[Posts].[IX_Posts_BlogId_Title]', N'ix_Posts_BlogId_Title', 'INDEX';
EXEC sp_rename N'[PostTag].[IX_PostTag_TagsId]', N'ix_PostTag_TagsId', 'INDEX';
```

主キー、代替キー、外部キーはそうなりません。`RenamePrimaryKey` や `RenameForeignKey` というマイグレーション操作は存在しないので、differ はそれぞれについて削除と追加を出力し、この 5 テーブルのモデルで 24 個の操作になります。

```sql
-- EF Core 11.0.0-rc.1: what the scaffolded migration does to keys
ALTER TABLE [Posts] DROP CONSTRAINT [FK_Posts_Blogs_BlogId];
ALTER TABLE [Posts] DROP CONSTRAINT [PK_Posts];
ALTER TABLE [Blogs] DROP CONSTRAINT [AK_Blogs_Slug];
ALTER TABLE [Blogs] DROP CONSTRAINT [PK_Blogs];
-- ...
ALTER TABLE [Posts] ADD CONSTRAINT [pk_Posts] PRIMARY KEY ([Id]);
ALTER TABLE [Blogs] ADD CONSTRAINT [ak_Blogs_Slug] UNIQUE ([Slug]);
ALTER TABLE [Blogs] ADD CONSTRAINT [pk_Blogs] PRIMARY KEY ([Id]);
ALTER TABLE [Posts] ADD CONSTRAINT [fk_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE;
```

SQL Server では、主キーはデフォルトでクラスター化インデックスです。これを削除するとテーブルはヒープに変換され、すべての非クラスター化インデックスが書き直されます。追加し直すとテーブルが再びソートされて書き直され、非クラスター化インデックスが 2 回目の書き直しを受けます。外部キーを追加し直すたびに既存の全行が検証されます。数千万行のテーブルでは、プレフィックスの大文字小文字を変えるためだけに、マイグレーションのトランザクション内で長時間かつログを大量に消費する操作になります。同じ削除と追加のパターンは [EF Core 11 のマイグレーションでテーブル名を変更する](/ja/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/) ときにも現れ、対処法も同じです。制約の名前をその場で変更します。

SQL Server では、`Up` 内で生成された `DropForeignKey`/`DropPrimaryKey`/`DropUniqueConstraint` と対応する `Add*` の呼び出しを `sp_rename` に置き換えます。`sp_rename` は制約の名前をメタデータの変更として変更します。主キーや一意制約の名前を `sp_rename` で変更すると、背後のインデックスの名前も変わります。

```csharp
// .NET 11, EF Core 11 - hand-edited Up() for SQL Server
protected override void Up(MigrationBuilder migrationBuilder)
{
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Blogs]', N'pk_Blogs', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[AK_Blogs_Slug]', N'ak_Blogs_Slug', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Posts]', N'pk_Posts', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[FK_Posts_Blogs_BlogId]', N'fk_Posts_Blogs_BlogId', 'OBJECT';");
    // ...one line per key and foreign key

    // the scaffolded index renames are already fine, keep them
    migrationBuilder.RenameIndex(
        name: "IX_Posts_BlogId_Title", table: "Posts", newName: "ix_Posts_BlogId_Title");
}
```

PostgreSQL での同等の操作は `ALTER TABLE "Posts" RENAME CONSTRAINT "PK_Posts" TO "pk_Posts";` で、これも主キーや一意制約の背後にあるインデックスの名前を変更します。通常のインデックスについては、Npgsql がすでに `ALTER INDEX ... RENAME TO` を生成します。

逆方向の `sp_rename` 呼び出しも `Down` に書いてください。生成された `Down` には削除と追加のペアが残っており、そのままにしておくと、ロールバック時にせっかく回避した再構築が実行されます。モデルスナップショットはこの手作業の編集の影響を受けません。どちらにしても新しい名前が記録されるので、次の `migrations add` は空の差分を生成します。そうならない場合は制約の変更漏れがあり、起動時のチェックが [保留中のモデル変更の例外](/ja/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) で知らせてくれます。編集したマイグレーションは、アプリ起動時の `Database.Migrate()` からではなく、レビュー済みのスクリプトか [マイグレーションバンドル](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) で適用してください。

## 注意点: 共有テーブル、長さの制限、snake_case パッケージ

**名前はエンティティ型からではなく、必ずテーブルから付けます。** 所有者のテーブルに格納される所有型、テーブル分割、TPH はいずれも 1 つのテーブルに複数のエンティティ型を置き、それぞれが独自の主キーのメタデータを持ちます。それらは制約名で一致していなければなりません。再現環境で、`Media` の中に所有型の `Address` を持つモデルに対して主キーのパターンを `pk_{entityType.ClrType.Name}` に切り替えたところ、モデルの検証がすぐに失敗しました。

```text
InvalidOperationException: The table 'Media' cannot be used for entity type 'Media' since it is being used
for entity type 'Address' and the name 'pk_Media' of the primary key {'Id'} does not match the name
'pk_Address' of the primary key {'MediaId'}.
```

名前を `GetTableName()` から導けば、共有テーブル内のすべてのエンティティ型が同じテーブルに解決されるので、この問題を回避できます。同じ再現環境で `pk_{table}` を使うと `pk_Media` 制約が 1 つだけ生成され、派生型の `Photo` と `Clip` で宣言された TPH の外部キーは、共有テーブル上の `fk_Media_Author_PhotographerId` と `fk_Media_Author_EditorId` になりました。派生型の列がそこで null 許容になる理由は [TPH マッピングのガイド](/ja/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) で説明しています。

**識別子の長さ制限を守り、切り詰めた名前を一意に保ちます。** `IConventionModel.GetMaxIdentifierLength()` はプロバイダーの制限を返します。再現環境では SQL Server で 128、SQLite で 32767 でした。PostgreSQL は識別子を 63 バイトで切り詰めます。長い列名の複合インデックスは簡単に 63 を超えますし、文字列を単に切り落とすだけだと、末尾だけが異なる 2 つのインデックスが同じ名前に潰れます。そうなると EF Core は、1 つのテーブルの 2 つのインデックスが異なる列で同じ名前にマップされているとして検証に失敗します。`Truncate` ヘルパーはプレフィックスを残し、完全な名前の SHA-256 から 16 進数 8 文字を付け加えます。制限を 40 文字にすると、`ix_customer_order_line_items_warehouse_location_id_created_at` と `..._updated_at` は `ix_customer_order_line_items_wa_0e2c7d55` と `ix_customer_order_line_items_wa_a5c1910c` になりました。安定したハッシュを使い、`string.GetHashCode()` は決して使わないでください。.NET ではプロセスごとにランダム化されるので、ビルドのたびに異なる名前と新しいマイグレーションが生まれます。

**最終化規約は追加した順に実行されます。** テーブルや列の名前を変える規約 (たとえば snake_case にするもの) も使っている場合は、`ConfigureConventions` で制約の命名規約より *前に* 追加してください。そうしないと、制約名が古いテーブル名から計算されます。

**`EFCore.NamingConventions` はまだ EF Core 11 対応のパッケージではありません。** キー名やインデックス名も含めすべてを snake_case にする人気のコミュニティパッケージは、現時点で 10.0.1 であり、その nuspec は `Microsoft.EntityFrameworkCore.Relational` を `[10.0.1, 11.0.0)` に固定しています。EF Core 11 と一緒に参照すると NuGet の NU1608 "outside of dependency constraint" 警告が出るうえ、11.0 のメタデータ API に対して一度もテストされていないパッケージを使うことになります。`IConventionPropertyBase` の変更が示すとおり、その API は実際に変わっています。自分で管理する 60 行の規約にはそうした問題はありません。

**スキャフォールドした (データベースファーストの) モデルはこれをすべて無視します。** `dotnet ef dbcontext scaffold` はデータベースから実際の名前を読み取り、明示的な `HasName`/`HasDatabaseName` の呼び出しを書き出すので、明示的な指定が規約に勝ちます。これは正しい動作ですが、リバースエンジニアリングしたモデルを規約が "修正" してくれるとは期待しないでください。

**コードではなく結果を確認します。** ダミーの接続文字列を持つコンテキストで `Database.GenerateCreateScript()` を呼べば、サーバーに触れずに完全な DDL が出力されます。`dotnet ef migrations script` は保留中のマイグレーションが実行する内容を表示します。どちらもモデルスナップショットを読むより速い方法です。実行時については、[EF Core 11 が生成する SQL のログ出力](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) で、制約名を参照する `DbUpdateException` に含まれる制約名を確認できます。

## 関連記事

- [EF Core 11 のマイグレーションでデータを失わずにテーブル名を変更する方法](/ja/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/)
- [修正: EF Core 11 で the model for context 'X' has pending changes が出る場合](/ja/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [マイグレーションバンドルで EF Core 11 のマイグレーションを本番環境に適用する方法](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [EF Core 11 で table-per-hierarchy (TPH) 継承マッピングを構成する方法](/ja/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/)
- [EF Core 11 の複合型と所有エンティティの比較](/ja/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)

## 参考資料

- Microsoft Learn の [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration): `ConfigureConventions`、`IModelFinalizingConvention`、構成ソースと規約ビルダー
- `HasName` と `HasDatabaseName` については Microsoft Learn の [Keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys) と [Indexes and constraints](https://learn.microsoft.com/en-us/ef/core/modeling/indexes)
- SQL Server で制約の名前をその場で変更するための [sys.sp_rename](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-rename-transact-sql)
- PostgreSQL ドキュメントの [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) (`RENAME CONSTRAINT`) と [識別子の長さ](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS)
- [NuGet の EFCore.NamingConventions](https://www.nuget.org/packages/EFCore.NamingConventions)、バージョン 10.0.1 の依存関係の範囲
