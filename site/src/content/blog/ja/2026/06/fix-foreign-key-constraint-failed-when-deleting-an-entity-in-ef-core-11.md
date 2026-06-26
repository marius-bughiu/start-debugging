---
title: "解決方法: EF Core 11 でエンティティを削除すると FOREIGN KEY constraint failed が発生する"
description: "親にまだ依存行が残っており、データベースがそれらを孤立させることを拒否するため、EF Core は FOREIGN KEY constraint failed をスローします。子を読み込む、リレーションシップをオプションにする、または OnDelete を設定してください。"
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "ja"
translationOf: "2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-26
---

解決方法: あなたは、まだ依存する (子) 行から参照されているプリンシパル (親) 行を削除しようとしており、データベースはそれらを孤立させることを拒否しています。実際に取れる選択肢は 3 つあり、優先順位順に並べると次のとおりです。`SaveChanges` の前に依存行をコンテキストに読み込んで EF Core 自身にカスケード削除させる、リレーションシップをオプション (null 許容外部キー) にして子の FK を null に設定できるようにする、または `OnDelete(DeleteBehavior.Cascade)` を設定してスキーマを再作成し、データベースに子を削除させる、のいずれかです。子に対して何が起きるべきかに合った方法を選んでください。

```text
Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes. See the inner exception for details.
 ---> Microsoft.Data.Sqlite.SqliteException (0x80004005): SQLite Error 19: 'FOREIGN KEY constraint failed'.
   at Microsoft.Data.Sqlite.SqliteException.ThrowExceptionForRC(int rc, sqlite3 db)
   at Microsoft.EntityFrameworkCore.Update.ReaderModificationCommandBatch.ExecuteAsync(...)
```

これは実行時のデータベースエラーで、`SaveChanges`/`SaveChangesAsync` によって発生し、`DbUpdateException` でラップされます。正確な文言は SQLite プロバイダー固有のものです。SQL Server では同じ状況で `The DELETE statement conflicted with the REFERENCE constraint "FK_..."` が発生し、PostgreSQL では `23503: update or delete on table "..." violates foreign key constraint`、MySQL では `Cannot delete or update a parent row: a foreign key constraint fails` となります。テキストは異なりますが、原因は同一です。このガイドは .NET 11、C# 14、`Microsoft.EntityFrameworkCore` 11.0.0、`Microsoft.Data.Sqlite` 11.0.0 を対象に書かれています。この挙動は EF Core 7 から変わっていないため、そのリリースまでさかのぼって当てはまります。

## なぜデータベースは削除を拒否するのか

EF Core はリレーションシップを外部キーでモデル化します。依存行はそのプリンシパルの主キーを保持しています。プリンシパルを削除すると、それを参照していたすべての依存 FK は、もはや存在しない行を参照することになります。これは参照整合性違反であり、リレーショナルデータベースは制約のところでそれを阻止します。

合法的な解決策は 2 つしかなく、どちらを選ぶかを伝えない限りデータベースはどちらかを選べません。

1. 依存行も削除する (カスケード削除)。
2. 依存行の外部キーを null に設定する (列が null 許容の場合のみ可能)。

このどちらも手配せずにプリンシパルを削除すると、データベースはスローします。これが頻繁に表面化する理由は、EF Core の *デフォルト* の設定が、リレーションシップが必須かオプションか、そして `SaveChanges` を呼び出した時点で依存行がコンテキストに読み込まれているかどうかに依存しているからです。この 2 つのスイッチが、EF Core が SQL を送信する前にメモリ内で整合性を取るのか、それとも問題をそのままデータベースに渡してデータベースがそれを拒否するのかを決定します。

微妙に問題を悪化させる要因として、SQLite は `PRAGMA foreign_keys = ON` でない限り外部キーをまったく強制しません。`Microsoft.Data.Sqlite` はこれをデフォルトで設定します。古い構成で、あるいは EF Core のインメモリプロバイダー (制約を強制しません) でテストした開発者は、実際の SQLite や SQL Server データベースが初めて削除を拒否したときに驚くことがよくあります。

## 最小の再現

必須の一対多: `Blog` は多数の `Post` を持ち、`Post.BlogId` は null 非許容なので、このリレーションシップは必須です。

```csharp
// .NET 11, C# 14, EF Core 11.0.0, Microsoft.Data.Sqlite 11.0.0
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; } = new();
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }            // non-nullable => required relationship
    public Blog Blog { get; set; } = null!;
}

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();

    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}
```

ここで、投稿を持つブログを、それらの投稿を読み込まずに削除します。

```csharp
// .NET 11, EF Core 11.0.0 -- throws DbUpdateException -> "FOREIGN KEY constraint failed"
var blog = await db.Blogs.SingleAsync(b => b.Id == 1);   // no Include(b => b.Posts)
db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

EF Core はブログのことしか知りません。それは単一の `DELETE FROM Blogs WHERE Id = 1` を発行します。投稿はまだブログ 1 を参照しているため、データベースはステートメントを中止します。このエラーは正しいものです。あなたは他の行が依存している行を削除するように要求しておきながら、それらの行をどうするかを伝えなかったのです。

対比に注目してください。必須のリレーションシップでは、デフォルトの削除動作は `Cascade` ですが、"カスケード" は 2 つの方法で適用できます。EF Core によるもの (メモリ内、子を読み込む必要がある) か、データベースによるもの (制約に `ON DELETE CASCADE` が必要) です。スキーマが `ON DELETE CASCADE` なしで作成され、かつ子が読み込まれていない場合、どちらのメカニズムも発動せず、このエラーに行き着きます。

## 解決方法 1: 依存行を読み込んで EF Core にカスケードさせる

最も移植性の高い解決方法であり、データベース制約がどのように作成されたかに関係なく機能します。`Include` で子をコンテキストに引き込めば、EF Core は親を削除する前にそれらに対する `DELETE` ステートメントを発行します。

```csharp
// .NET 11, EF Core 11.0.0 -- EF Core deletes posts, then the blog
var blog = await db.Blogs
    .Include(b => b.Posts)
    .SingleAsync(b => b.Id == 1);

db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

投稿が追跡されていると、EF Core はブログの削除が必須のリレーションシップを断ち切ることを認識し、メモリ内でカスケードを適用し、SQL を正しく順序付けます。つまり、まず投稿を削除し、それからブログを削除します。これは EF Core が「設定されたカスケード動作を、データベーススキーマとは無関係に、常に追跡されているエンティティに適用する」ために機能します。

コストは明らかです。すべての依存行を削除するためだけにメモリに読み込むのです。10 件の投稿を持つブログなら問題ありません。しかし 10 万件の子を持つ親の場合、これはメモリとラウンドトリップの問題になり、解決方法 3 (データベースカスケード) かセットベースの一括削除を使いたくなります。EF Core 11 の [一括書き込み向けの `ExecuteDelete`](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) は、子をマテリアライズせずに単一の SQL ステートメントで削除します。これは子のセットが大きい場合に適したツールです。ただし `ExecuteDelete` は変更トラッカーをバイパスするため、カスケードに頼るのではなく、親より前に子を明示的に削除することを忘れないでください。

## 解決方法 2: リレーションシップをオプションにして FK を null にできるようにする

子が親なしでも正当に存在できる場合に使います。外部キーを null 許容にすると、オプションのリレーションシップのデフォルト動作は `ClientSetNull` になります。EF Core は依存行を削除するのではなく、その FK を null に設定します。

```csharp
// .NET 11, EF Core 11.0.0 -- optional relationship
public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int? BlogId { get; set; }           // nullable => optional relationship
    public Blog? Blog { get; set; }
}
```

`BlogId` 列を null 許容にするマイグレーションの後、投稿を読み込んだ状態でブログを削除すると、各投稿に対して `UPDATE Posts SET BlogId = NULL ...` が生成され、それから `DELETE FROM Blogs ...` が生成されます。投稿は残り、どのブログからも切り離されます。

```csharp
// .NET 11, EF Core 11.0.0 -- posts kept, FK set to null
var blog = await db.Blogs.Include(b => b.Posts).SingleAsync(b => b.Id == 1);
db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

注意点が 2 つあります。第一に、これはエラーを黙らせるための小細工ではなく、意味的な判断です。孤立した子が自分のドメインで本当に有効である場合にのみ、リレーションシップをオプションにしてください。`Blog` のない `Post` は無意味かもしれません。第二に、`ClientSetNull` (デフォルト) では、EF Core は FK を null にするために依然として依存行が読み込まれている必要があります。読み込まれていない場合は、再び `DbUpdateException` が発生します。読み込みなしで機能するように null 化をデータベース側に押し込むには、`OnDelete(DeleteBehavior.SetNull)` を設定します。これは制約に `ON DELETE SET NULL` を生成します。

```csharp
// .NET 11, EF Core 11.0.0 -- database nulls the FK on delete, no need to load children
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne(p => p.Blog)
        .HasForeignKey(p => p.BlogId)
        .OnDelete(DeleteBehavior.SetNull);
}
```

## 解決方法 3: データベースが削除をカスケードするように設定する

子が親と一緒に消えるべきで、かつ事前に子を読み込みたくない場合に使います。`DeleteBehavior.Cascade` を設定し、制約が `ON DELETE CASCADE` を持つようにスキーマを作成またはマイグレーションします。すると、プリンシパルを削除したときにデータベース自身が依存行を削除します。

```csharp
// .NET 11, EF Core 11.0.0 -- ON DELETE CASCADE in the database
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne(p => p.Blog)
        .HasForeignKey(p => p.BlogId)
        .OnDelete(DeleteBehavior.Cascade);
}
```

必須のリレーションシップでは、これはすでに規約上のデフォルトですが、制約が `ON DELETE CASCADE` を持つのは、データベースが *その設定が有効な状態で作成またはマイグレーションされた場合* に限られます。これがほとんどの人を捕まえる罠です。`OnDelete(Cascade)` を追加 (またはデフォルトに依存) し、ビルドは成功するのに、削除は依然として失敗します。なぜなら、稼働中のデータベースはカスケードが設定される前に作成されており、既存の制約にカスケード句がないからです。`OnModelCreating` の設定はモデルを変更するのであって、稼働中のデータベースを変更するわけではありません。マイグレーションを生成して適用しなければなりません。

```bash
# .NET 11 SDK, EF Core tools 11.0.0
dotnet ef migrations add ConfigurePostCascade
dotnet ef database update
```

制約が実際にカスケードを持っているか確認してください。SQLite では、外部キーリストを検査します。

```sql
-- run against the SQLite database file
SELECT * FROM pragma_foreign_key_list('Posts');
-- the "on_delete" column should read CASCADE, not NO ACTION
```

その後は、`db.Blogs.Remove(blog); await db.SaveChangesAsync();` が `Include` なしでブログを削除し、データベースが同じ操作で投稿を削除します。

カスケードをあらゆる場所で使う前に知っておくべきプラットフォームの制限が 1 つあります。SQL Server は、同じテーブルへの複数のカスケードパスを拒否します。2 つの必須リレーションシップがどちらも 1 つのテーブルへカスケード削除する場合、スキーマの作成は `Introducing FOREIGN KEY constraint '...' on table '...' may cause cycles or multiple cascade paths` で失敗します。そこでの解決方法は、一方のリレーションシップをオプションにするか、一方を `ClientCascade` に設定して、そのカスケードの一辺を (SQL Server ではなく) EF Core が子を読み込んだ状態で処理するようにすることです。SQLite と PostgreSQL にはこの制限はありません。

## 同じエラーに行き着く別パターン

### 自己参照階層 (ツリーテーブル)

`Category` を指し返す null 許容の `ParentId` を持つ `Category` は、これに絶えず遭遇します。子が読み込まれていない親カテゴリを削除すると FK チェックに失敗します。SQL Server はサイクルを生じうる自己参照カスケードを禁止しているため、ここでは `ON DELETE CASCADE` にまったく頼れないのが普通です。サブツリーを読み込んで EF Core に削除させるか、`ExecuteDelete` でボトムアップに削除してください。

### 多対多の結合行

スキップナビゲーション (`Blog` は暗黙の結合テーブルを介して多数の `Tag` を持つ) では、`Blog` を削除するには結合行が先に消える必要があります。ブログが `Tags` と一緒に読み込まれている場合、EF Core はこれを自動的に処理しますが、ナビゲーションを読み込まずに単に `Remove` すると、結合行が孤立して削除が失敗します。スキップナビゲーションを読み込むか、結合行を `ExecuteDelete` してください。結合エンティティの仕組みは [EF Core 11 で多対多リレーションシップをシードする](/ja/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) で扱っています。

### 「インメモリプロバイダーでは動いた」

EF Core のインメモリデータベースは外部キーやカスケード削除を強制しないため、単体テストで「合格」する削除が、実際の SQLite や SQL Server データベースに対しては失敗することがあります。これは、インメモリプロバイダーがリレーショナル動作の代用として不適切であるいくつかの理由のうちの 1 つです。削除パスのテストには SQLite インメモリか実際のデータベースを使ってください。トラッキングを意識したテストパターンについては [変更トラッキングを壊さずに DbContext をモックする](/ja/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) を参照してください。また、ここでのリレーションシップフィックスアップのルールは [EF Core 11 における AsNoTracking と AsNoTrackingWithIdentityResolution](/ja/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) と相互作用することに注意してください。トラッキングなしのクエリは EF Core にメモリ内でカスケードさせません。カスケードする対象が何も追跡されていないからです。

### エラーがアップグレード後にだけ発生する

以前は動いていた削除が、ランタイムやプロバイダーのバージョンを変更した後にスローし始めた場合、モデルスナップショットでデフォルトの `DeleteBehavior` や FK の null 許容性が変わっていないか確認してください。破壊的変更の範囲は [EF Core 6 から EF Core 11 への移行](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) でカタログ化されています。生成されたマイグレーションを diff して、カスケード句が移動していないか確認してください。

### 削除が再試行実行戦略の内側にある

`EnableRetryOnFailure` を使いながら削除を手動のトランザクションでラップすると、このエラーを覆い隠す *別の* 例外が発生することがあります。その相互作用はそれ自体が独立したエラーであり、[the execution strategy does not support user-initiated transactions](/ja/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/) で扱っています。

## 修正を確認する

インメモリではなく実際のプロバイダーに対して削除を再現し、生成された SQL を観察してください。開発環境で機密ログを有効にして、パラメーター値とステートメントの順序が見えるようにします。

```csharp
// .NET 11, EF Core 11.0.0 -- dev only; never enable sensitive logging in production
var options = new DbContextOptionsBuilder<AppDb>()
    .UseSqlite("Data Source=app.db")
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging()
    .Options;
```

修正が機能していれば、`DELETE FROM Blogs ...` の前に `DELETE FROM Posts ...` が見えるか (解決方法 1 または 3)、ブログ削除の前に `UPDATE Posts SET BlogId = NULL ...` が見える (解決方法 2) はずです。それでも単独の `DELETE FROM Blogs ...` の後に例外が続く場合は、依存行が読み込まれてもおらず、データベースによっても処理されておらず、設定をモデルには適用したものの稼働中のスキーマには適用していないということです。`dotnet ef database update` を再実行し、`pragma_foreign_key_list` を再確認してください。

持っておく価値のあるメンタルモデル: このエラーは、親を削除する前に子の運命を決めるようデータベースがあなたに求めているものです。親と一緒に削除する (カスケード)、残してリンクを切る (null 設定)、あるいはコンテキストに引き込んで EF Core が行ごとに判断できるようにする、のいずれかです。このエラーは EF Core が意地悪をしているのではなく、参照整合性がまさにその仕事をしているだけなのです。

## 出典

- [Cascade Delete](https://learn.microsoft.com/en-us/ef/core/saving/cascade-delete)、EF Core ドキュメント、`DeleteBehavior`、必須とオプションのデフォルト、読み込み済みと未読み込みの動作テーブルについて。
- [Relationships](https://learn.microsoft.com/en-us/ef/core/modeling/relationships)、EF Core ドキュメント、必須およびオプションのリレーションシップが FK の null 許容性からどのように推論されるかについて。
- [Microsoft.Data.Sqlite foreign keys](https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/foreign-keys)、`PRAGMA foreign_keys` の強制について。
- [SQLite result and error codes](https://www.sqlite.org/rescode.html)、`SQLITE_CONSTRAINT_FOREIGNKEY` (拡張コード 787) について。
