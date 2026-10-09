---
title: "EF Core 11 の shadow プロパティとは何か、なぜマイグレーションに現れたのか"
description: "shadow プロパティは、対応する CLR プロパティがないまま EF Core が追跡する列です。EF Core 11 がそれを作る理由 (FK プロパティの欠落、FK の命名ミス、型の不一致、リレーションシップの二重構成)、マイグレーションで BlogId1 のような列を見つける方法、原因ごとの修正方法、そして意図的に shadow プロパティを使う方法を解説します。"
pubDate: 2026-10-09
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "migrations"
  - "relationships"
lang: "ja"
translationOf: "2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration"
translatedBy: "claude"
translationDate: 2026-10-09
---

結論から言うと、shadow プロパティとは、EF Core のモデルに存在し、通常はデータベースの列としても存在するものの、エンティティクラスには対応するプロパティがないプロパティです。EF Core 11 は、リレーションシップに外部キーが必要なのに使える CLR プロパティが見つからない場合に、shadow プロパティを自動的に作成します。クラスにそもそも FK プロパティがないために作られた shadow 列であれば、害はありません。一方、FK プロパティを *持っている* のに EF Core が使えなかった場合 (名前が違う、型が違う、`[NotMapped]` が付いている、リレーションシップが二重に構成されている) には、意図した列の隣に `BlogId1` や `OwnerId` のような列が現れます。その場合は、`HasForeignKey` でどのプロパティが外部キーかを EF Core に伝えれば解決します。

以下の内容はすべて、.NET 11 RC1 SDK (11.0.100-rc.1.26425.128) と C# 14 上で `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128 を使って実行した結果です。モデルの出力と警告は、言い換えではなく実際の実行結果をそのまま掲載しています。

## EF Core でいう "shadow" とは

EF Core のモデルにあるすべてのプロパティにはメタデータがあります。名前、CLR 型、null 許容かどうか、キーか FK かといった情報です。ほとんどのプロパティには、クラス上のバッキングメンバー (C# のプロパティまたはフィールド) もあり、EF Core はエンティティを実体化するときや変更を保存するときにそれを読み書きします。shadow プロパティにはメタデータはありますが、メンバーがありません。値は変更トラッカーの中にだけ存在します。

[shadow プロパティとインデクサープロパティのドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties)では、これが定義のすべてです。EF Core は、そのプロパティがどのように作られたかを気にしません。意図的に宣言することもできますし、モデル構築中に規約が作成することもあります。後者が驚きの元になるのは、自分で書いた覚えのない列を追加するマイグレーションで、初めてその存在に気づくからです。

モデルをダンプすれば、どのプロパティが shadow プロパティかを確認できます。`Model.ToDebugString()` は、それらに `(no field, ...)` と `Shadow` の印を付けます。

```csharp
// .NET 11, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore.Infrastructure;

using var db = new AppDbContext();
Console.WriteLine(db.Model.ToDebugString(MetadataDebugStringOptions.ShortDefault));
```

この 1 行は覚えておいてください。マイグレーションのスナップショットを読まずに、"この列はどこから来たのか" に答える最も速い方法です。

## ケース 1: ナビゲーションに FK プロパティがない (想定どおりで無害)

最も一般的な shadow プロパティは、ナビゲーションだけでリレーションシップをモデル化したときに EF Core が作成するものです。

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public List<Post> Posts { get; set; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
}
```

ここには 1 対多のリレーションシップがあるので、`Post` テーブルには外部キー列が必要です。`Post` に `BlogId` がないため、EF Core が自動で作ります。デバッグビューには次のように表示されます。

```text
EntityType: Post
  Properties:
    Id (int) Required PK AfterSave:Throw ValueGenerated.OnAdd
    BlogId (no field, int?) Shadow FK Index
    Title (string) Required
  Foreign keys:
    Post {'BlogId'} -> Blog {'Id'} ClientSetNull ToDependent: Posts
```

生成されるテーブルは次のとおりです。

```sql
CREATE TABLE "Post" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Post" PRIMARY KEY AUTOINCREMENT,
    "Title" TEXT NOT NULL,
    "BlogId" INTEGER NULL,
    CONSTRAINT "FK_Post_Blogs_BlogId" FOREIGN KEY ("BlogId") REFERENCES "Blogs" ("Id")
);
```

名前は `<ナビゲーションまたはプリンシパル型の名前><プリンシパルキーの名前>` という規約に従い、ここでは `Blog` + `Id` です。重要な点が 2 つあります。1 つ目は、shadow FK が `int?` なので、リレーションシップは省略可能になり、削除動作は `Cascade` ではなく `ClientSetNull` になることです。必須のセマンティクスを期待していた場合は、実際の `int BlogId` プロパティを追加するか、リレーションシップに `.IsRequired()` を呼び出してください。2 つ目は、EF Core がこれを Debug レベルでのみ `CoreEventId.ShadowPropertyCreated` (イベント 10600) として記録することです。

```text
The property 'Post.BlogId' was created in shadow state because there are no eligible CLR members with a matching name.
```

既定のコンソールログには表示されません。これは意図的なものです。正当なモデリングの選択であり、ドメインクラスに FK の値を持たせないコードベースも数多くあります。

## ケース 2: FK プロパティの名前が規約に沿っていない (警告なし、しかも間違い)

マイグレーションに警告なしで "謎の列" が現れるのは、このケースです。

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class User
{
    public int Id { get; set; }
}

public class Post
{
    public int Id { get; set; }
    public int OwnerUserId { get; set; }
    public User Owner { get; set; } = null!;
}
```

`OwnerUserId` を `Owner` の外部キーにするつもりだったとします。EF Core の FK 検出規約が照合するのは、`<ナビゲーション名><プリンシパルキー名>` (`OwnerId`)、`<プリンシパル型名><プリンシパルキー名>` (`UserId`)、`<プリンシパルエンティティ型名>Id` という形式の名前だけです。`OwnerUserId` はどれにも一致しないため、EF Core はこれを通常の `int` 列として扱い、shadow FK の `OwnerId` を作成します。

```text
EntityType: Post
  Properties:
    Id (int) Required PK AfterSave:Throw ValueGenerated.OnAdd
    OwnerId (no field, int) Shadow Required FK Index
    OwnerUserId (int) Required
```

```sql
CREATE TABLE "Posts" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Posts" PRIMARY KEY AUTOINCREMENT,
    "OwnerUserId" INTEGER NOT NULL,
    "OwnerId" INTEGER NOT NULL,
    CONSTRAINT "FK_Posts_User_OwnerId" FOREIGN KEY ("OwnerId") REFERENCES "User" ("Id") ON DELETE CASCADE
);
```

コードが `post.OwnerUserId = 42` を設定して保存しても、何も関連付けられません。リレーションシップは `OwnerId` にあり、コードはそこに一切触れないからです。ここでも EF Core が記録するのは Debug レベルの `ShadowPropertyCreated` イベントだけなので、最初の症状は、結合が何も返さないか、誰かがたまたま注意深く読んだマイグレーションの差分になることがほとんどです。

修正方法は、FK を明示的に指定することです。

```csharp
// .NET 11, EF Core 11.0.0-rc.1
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>()
        .HasOne(p => p.Owner)
        .WithMany()
        .HasForeignKey(p => p.OwnerUserId);
}
```

またはナビゲーションにデータ注釈を付けます: `[ForeignKey(nameof(OwnerUserId))] public User Owner { get; set; }`。これでモデルの FK は `OwnerUserId` だけになり、shadow 列は消えます。`OwnerId` を含むマイグレーションがすでにリリースされている場合、次のマイグレーションで `OwnerId` が削除され、`OwnerUserId` に FK 制約が追加されます。削除させる前に、古い列を通じて書き込まれた行がないか確認してください。

## ケース 3: FK プロパティの型が間違っている (BlogId1)

次は、有名な末尾の `1` です。

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public List<Post> Posts { get; set; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string BlogId { get; set; } = "";   // principal key is int
    public Blog Blog { get; set; } = null!;
}
```

`BlogId` は規約どおりの名前ですが `string` であり、`Blog.Id` は `int` です。EF Core は互換性のないプロパティを FK として使えません。かといって shadow プロパティに `BlogId` という名前も付けられません (その名前は使用済みです)。そのため一意になるよう `BlogId1` にします。このときは、EF Core が Warning として `CoreEventId.ShadowForeignKeyPropertyCreated` (イベント 10625) を記録します。

```text
warn: CoreEventId.ShadowForeignKeyPropertyCreated[10625]
      The foreign key property 'Post.BlogId1' was created in shadow state because a conflicting property
      with the simple name 'BlogId' exists in the entity type, but is either not mapped, is already used
      for another relationship, or is incompatible with the associated primary key type.
```

このメッセージには、番号付きの shadow FK につながる 3 つの原因が挙げられています。型の不一致はその 1 つです。残りの 2 つを以下に示します。

## ケース 4: リレーションシップが二重に構成された (BlogId と BlogId1)

これは、リレーションシップの片側だけを指定する Fluent API から生じます。

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Post
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne()                       // no navigation passed
        .HasForeignKey(p => p.BlogId);
}
```

引数なしの `WithOne()` は、EF Core に "このリレーションシップには `Post` 側のナビゲーションがない" と伝えます。しかし `Post.Blog` は存在するため、規約がそれから *2 つ目の* リレーションシップを構築します。`BlogId` はすでに 1 つ目のリレーションシップで使われているので、2 つ目には `BlogId1` が割り当てられます。

```text
Foreign keys:
  Post {'BlogId'} -> Blog {'Id'} Required Cascade ToDependent: Posts
  Post {'BlogId1'} -> Blog {'Id'} Required Cascade ToPrincipal: Blog
```

```sql
CREATE TABLE "Post" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Post" PRIMARY KEY AUTOINCREMENT,
    "BlogId" INTEGER NOT NULL,
    "BlogId1" INTEGER NOT NULL,
    CONSTRAINT "FK_Post_Blogs_BlogId" FOREIGN KEY ("BlogId") REFERENCES "Blogs" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_Post_Blogs_BlogId1" FOREIGN KEY ("BlogId1") REFERENCES "Blogs" ("Id") ON DELETE CASCADE
);
```

同じテーブルへの必須 FK が 2 つでき、`blog.Posts` と `post.Blog` は同じリンクを表さなくなります。修正方法は、両端が 1 つのリレーションシップに属するようにナビゲーションを渡すことです: `.WithOne(p => p.Blog)`。この変更で、モデルは `Inverse: Posts` を持つ単一の `BlogId` FK に戻ります。

知っておくと便利な違いがあります。この壊れた構成から `HasForeignKey(p => p.BlogId)` の呼び出しを外すと、EF Core 11 は黙って `BlogId1` を作成することはありません。代わりに、モデルの確定時に例外をスローします。

```text
System.InvalidOperationException: Both relationships between 'Post' and 'Blog.Posts' and between 'Post.Blog'
and 'Blog' could use {'BlogId'} as the foreign key. To resolve this, configure the foreign key properties
explicitly in 'OnModelCreating' on at least one of the relationships.
```

この例外が出たときの正しい対応は、なくなるまで `HasForeignKey` を追加することではありません。そうすると、例外が上記の `BlogId1` スキーマに変わってしまいます。ナビゲーションが欠けているリレーションシップを見つけて、そちらを修正してください。

## ケース 5: FK プロパティがマップされていない

警告に挙げられている 3 つ目の原因は、EF Core が使うことを許されていないプロパティです。

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Post
{
    public int Id { get; set; }
    [NotMapped] public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
}
```

結果は `BlogId1` 列だけを持つテーブルになり、同じ 10625 の警告も出ます。`modelBuilder.Entity<Post>().Ignore(p => p.BlogId)` でも同じことが起きます。CLR プロパティを FK にしたいなら、除外を取り除いてください。マップしないヘルパーにしたいなら、規約上の FK 名と衝突しないように名前を変更してください。

## 意図しない shadow FK をリリース前に見つける方法

マイグレーションの差分をすべて読む方法は、いずれ限界が来ます。より手軽な防御策が 2 つあります。

警告を例外に変える。ケース 3、4、5 はいずれも `ShadowForeignKeyPropertyCreated` を発生させ、EF Core にはこれでスローさせることができます。

```csharp
// .NET 11, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore.Diagnostics;

protected override void OnConfiguring(DbContextOptionsBuilder options) => options
    .UseSqlite("Data Source=app.db")
    .ConfigureWarnings(w => w.Throw(CoreEventId.ShadowForeignKeyPropertyCreated));
```

これで `db.Model` にアクセスすると `An error was generated for warning 'Microsoft.EntityFrameworkCore.Model.Validation.ShadowForeignKeyPropertyCreated'` で失敗し、`dotnet ef migrations add` もモデルを構築するため、不正なマイグレーションが作成されることはなくなります。意図的な shadow プロパティが 1 つもない場合を除き、`ShadowPropertyCreated` に対して同じことをしないでください。無害なケース 1 でも発生するからです。

モデルをテストでアサートする。ケース 2 は警告を一切発生させないため、モデルを走査する単体テストが唯一の自動的な防御網です。

```csharp
// .NET 11, EF Core 11.0.0-rc.1, xUnit
[Fact]
public void No_unexpected_shadow_foreign_keys()
{
    using var db = new AppDbContext();
    var allowed = new HashSet<string> { "Post.BlogId" };   // the ones you chose on purpose

    var shadowFks = db.Model.GetEntityTypes()
        .SelectMany(e => e.GetProperties())
        .Where(p => p.IsShadowProperty() && p.IsForeignKey())
        .Select(p => $"{p.DeclaringType.ClrType.Name}.{p.Name}")
        .Where(name => !allowed.Contains(name))
        .ToList();

    Assert.Empty(shadowFks);
}
```

`IsShadowProperty()` と `IsForeignKey()` は `IReadOnlyProperty` の公開メタデータ API の一部なので、内部へのアクセスもデータベースも不要です。

## shadow プロパティを意図的に使う

shadow プロパティが何かを理解すれば、テーブルには属するがドメインオブジェクトには属さないデータのための、すっきりした手段になります。監査用のタイムスタンプが典型例です。

```csharp
// .NET 11, EF Core 11.0.0-rc.1
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>().Property<DateTime>("LastUpdated");
}

public override int SaveChanges()
{
    foreach (var entry in ChangeTracker.Entries<Post>()
                 .Where(e => e.State is EntityState.Added or EntityState.Modified))
    {
        entry.Property("LastUpdated").CurrentValue = DateTime.UtcNow;
    }
    return base.SaveChanges();
}
```

`Post` クラスから永続化に関する関心事を排除でき、テーブルには `"LastUpdated" TEXT NOT NULL` 列 (SQLite の場合) が追加されます。読み書きは変更トラッカー経由で `db.Entry(post).Property<DateTime>("LastUpdated").CurrentValue` のように行い、クエリは `EF.Property` を通します。

```csharp
// .NET 11, EF Core 11.0.0-rc.1
var recent = await db.Posts
    .Where(p => EF.Property<DateTime>(p, "LastUpdated") > DateTime.UtcNow.AddDays(-1))
    .OrderBy(p => EF.Property<DateTime>(p, "LastUpdated"))
    .ToListAsync();
```

これは単純な列参照に変換されます。

```sql
SELECT "p"."Id", "p"."LastUpdated", "p"."Title"
FROM "Posts" AS "p"
WHERE "p"."LastUpdated" > rtrim(rtrim(strftime('%Y-%m-%d %H:%M:%f', 'now', CAST(-1.0 AS TEXT) || ' days'), '0'), '.')
```

エンティティが 1 つだけでなければ、すべてのコンテキストで `SaveChanges` をオーバーライドするのではなく、スタンプ処理を `SaveChangesInterceptor` に置いてください。

## 知っておきたい注意点

- **shadow の値はデタッチすると失われます。** 値は変更トラッカーの中にしか存在しません。`AsNoTracking()` を付けたクエリでも SQL には shadow 列が含まれますが、実体化されたオブジェクトからそれを読む方法はありません。必要なら `Select` の中で `EF.Property` を使って明示的に射影してください。
- **shadow FK と切断されたグラフ。** ナビゲーションだけを設定した `Post` をアタッチすると、EF Core は `SaveChanges` の際にナビゲーションから shadow FK を埋めます。ナビゲーションも FK プロパティもない `Post` をアタッチした場合は、埋める元がないため、`Entry(...).Property("BlogId").CurrentValue` で設定する必要があります。
- **名前の修正はコードだけでなくマイグレーションです。** ケース 2、3、4 の修正はスキーマを変更します。EF Core は shadow 列の削除を生成します。本番データがその列を通じて書き込まれていた場合は、削除の前に、マイグレーション内で実際の FK 列へコピーしてください。
- **インデクサープロパティは親戚であり、同じものではありません。** プロパティバッグ (`Dictionary<string, object>` のエンティティ型) はインデクサープロパティを使います。これには CLR のアクセサー (インデクサー) があります。名前付きの C# プロパティがなくても、shadow プロパティではありません。

## 関連記事

- shadow 列が原因不明のマイグレーションとして最初に現れた場合は、[EF Core 11 の "the model for context has pending changes" の修正](/ja/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)でスナップショットの差分の仕組みを解説しています。
- 監査パターンをきちんと実装するには、[EF Core 11 のインターセプターによる監査](/ja/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)を参照してください。
- EF Core が実際に出力する SQL で `BlogId1` 列を確認するには、[EF Core 11 が生成する SQL のログ出力](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)にすべての方法があります。
- `Cascade` の必須 shadow FK は削除動作を変えます。EF Core がどう選ぶかは、[削除時の FOREIGN KEY constraint failed の修正](/ja/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)で説明しています。
- FK の名前を変更するなら、[EF Core 11 でキー、外部キー、インデックスにカスタム命名規則を適用する方法](/ja/2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11/)で、モデル全体に適用する方法を紹介しています。

## 参考資料

- [Shadow and Indexer Properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties), EF Core ドキュメント。
- [Foreign and principal keys in relationships](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/foreign-and-principal-keys), EF Core ドキュメント。FK 検出の命名規則について。
- [CoreEventId.ShadowForeignKeyPropertyCreated](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.coreeventid.shadowforeignkeypropertycreated), API リファレンス。
- [Microsoft.EntityFrameworkCore 11.0.0-rc.1.26425.128](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore/11.0.0-rc.1.26425.128) (NuGet)。この記事のすべての実行に使用したバージョンです。
