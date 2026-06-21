---
title: "EF Core 11 で多対多リレーションシップにシードデータを投入する方法"
description: "EF Core 11 で多対多リレーションシップの結合テーブルにシードデータを投入する方法: 自分で名前を付ける必要がある暗黙のシャドウキー、UsingEntity と HasData のパターン、そしてスキップナビゲーションで動作する実行時の UseSeeding 代替手段。"
pubDate: 2026-06-21
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
lang: "ja"
translationOf: "2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-21
---

EF Core 11 で多対多リレーションシップにシードデータを投入するには、スキップナビゲーションにシードを投入するのではありません。結合テーブルに直接シードを投入します。なぜなら `HasData` はナビゲーションを設定できないからです。デフォルトの暗黙的な結合 (結合エンティティ用のクラスがない) では、`UsingEntity` でリレーションシップに踏み込んで、結合エンティティに対して `HasData` を呼び出し、プロパティ名が EF の生成するシャドウ外部キーと一致する匿名オブジェクトを渡します。`Post.Tags` / `Tag.Posts` のリレーションシップの場合、それらは `PostsId` と `TagsId` です。また、両端 (`Post` と `Tag`) にも固定の主キー値でシードを投入する必要があります。マイグレーション管理のシードでは、すべてのキーを手作業で明示する必要があるためです。ライブデータに対して実行時にシードを投入したい場合は、`UseSeeding`/`UseAsyncSeeding` を使い、エンティティを読み込んで通常どおりスキップナビゲーションに追加できるようにします。本記事では .NET 11、EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0)、C# 14 を使用します。

これが多くの人をつまずかせる理由は、多対多リレーションシップには一般的なモデルにおいて第三のクラスが存在しないからです。`Post` を `List<Tag>` 付きで書き、`Tag` を `List<Post>` 付きで書くと、EF が結合テーブルを自動的に作り出してくれます。その便利さは、シードデータを投入したくなった瞬間に消え去ります。なぜなら `HasData` はエンティティ型とそのキーに対して動作し、対象にしなければならない結合「エンティティ」がコード上では見えないからです。

## HasData がナビゲーションに直接シードを投入できない理由

誰もが実際に書くモデルから始めましょう:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public List<Tag> Tags { get; } = [];
}

public class Tag
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; } = [];
}
```

EF Core はこれを規約によって 3 つのテーブルにマッピングします: `Posts`、`Tags`、そして `PostsId` と `TagsId` という 2 つの列を持つ `PostTag` という名前の結合テーブルです。これらの列名は恣意的なものではありません。`Posts` テーブルを指し示すシャドウ外部キーは、投稿を対象とするナビゲーション (`Tag.Posts`) にちなんで名付けられており、同様に `TagsId` は `Post.Tags` に由来します。これらのプロパティを宣言したことは一度もありません。EF が、自身の管理する共有型エンティティ型上にシャドウプロパティとして作成したのです。

`HasData` はマイグレーション時のシードメカニズムです。これは特定のエンティティ型に行をアタッチし、モデルのスナップショットとの差分を取ることで挿入を計算することで動作します。投稿とタグの間の関連付けに対応するエンティティ型はコード上に存在しないため、`HasData` がアタッチするものが何もありません。`OnModelCreating` の中で `post.Tags.Add(tag)` と書くこともできません。モデルの構築はモデルの形状を構成するものであり、`DbContext` に対して実行されるわけではなく、スキップナビゲーションもそこでは設定されません。関連付けは結合テーブルの中に存在し、その結合テーブルこそがシードを投入しなければならない対象です。

これは一般に `HasData` を扱いづらくしているのと同じ種類の制限です。`HasData` には決定論的で明示的にキー付けされたデータが必要であり、アプリケーションではなくマイグレーションによって所有されています。このトレードオフがあなたにとって新しいものであれば、より広い全体像が [EF Core 11 で UseSeeding と UseAsyncSeeding を使ってシードデータを投入する方法](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/) にあり、そこではマイグレーション管理の `HasData` がまったくの不適切なツールとなる場合を扱っています。

## UsingEntity と HasData で暗黙の結合にシードを投入する

マイグレーション時のアプローチには 3 つの部分があり、そのいずれか 1 つでも省略すると壊れたシードになります。完全な手順は次のとおりです。

1. **両方のプリンシパルエンティティ型に** `HasData` でシードを投入し、すべての行に固定の主キーを与えます。EF はシードデータのキーを生成しないので、自分で割り当てます。
2. **結合エンティティに踏み込み**、`UsingEntity` で結合テーブルに明示的に名前を付けて、構成が安定するようにします。
3. **結合エンティティに対して `HasData` を呼び出し**、プロパティ名がシャドウ外部キー (`PostsId`、`TagsId`) と一致する匿名オブジェクトを渡します。

まとめると、`OnModelCreating` の中の構成は次のようになります:

```csharp
// .NET 11, EF Core 11, C# 14 -- seeding an implicit (unmapped) join table
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>().HasData(
        new Post { Id = 1, Title = "Span<T> in depth" },
        new Post { Id = 2, Title = "EF Core 11 changes" });

    modelBuilder.Entity<Tag>().HasData(
        new Tag { Id = 1, Name = "dotnet" },
        new Tag { Id = 2, Name = "performance" },
        new Tag { Id = 3, Name = "efcore" });

    modelBuilder.Entity<Post>()
        .HasMany(p => p.Tags)
        .WithMany(t => t.Posts)
        .UsingEntity(
            "PostTag",
            r => r.HasOne(typeof(Tag)).WithMany().HasForeignKey("TagsId"),
            l => l.HasOne(typeof(Post)).WithMany().HasForeignKey("PostsId"),
            j => j.HasData(
                new { PostsId = 1, TagsId = 1 },   // "Span<T>" tagged "dotnet"
                new { PostsId = 1, TagsId = 2 },   // "Span<T>" tagged "performance"
                new { PostsId = 2, TagsId = 1 },   // "EF Core 11" tagged "dotnet"
                new { PostsId = 2, TagsId = 3 })); // "EF Core 11" tagged "efcore"
}
```

匿名オブジェクト内のプロパティ名がここでの契約です。それらは厳密に `PostsId` と `TagsId` でなければならず、EF が宣言したシャドウ外部キーと一致しなければなりません。いずれかをスペルミスしたり、複数形を別の形にしたり、単数形の `PostId` を使ったりすると、マイグレーションの生成が `The seed entity for entity type 'PostTag' cannot be added because the value 'PostId' is not present` をスローします。そのプロパティは結合エンティティ上に存在しないからです。

`dotnet ef migrations add SeedPostTags` を実行すると、生成されたマイグレーションが投稿、タグ、そして `PostTag` への 4 行を挿入します。それ以降、`dotnet ef database update` を実行するたびにそのデータが一度だけ適用され、EF はモデルのスナップショットでそれを追跡するので、再挿入しないことを把握します。

ラムダ構成だけを渡すことで、テーブルに名前を付けずに結合エンティティに名前を付けることもできますが、私は常に明示的な `"PostTag"` という名前文字列を渡すことをお勧めします。デフォルトの名前は型名から導出されるため、`Post` を `Article` にリネームすると、名前なしの結合は静かにテーブルをリネームし、既存のデータを孤立させてしまいます。名前を固定しておくことで、リネームを意図的でレビュー可能な変更にできます。

## ペイロードを持つ結合クラスがある場合

結合テーブルが追加の列を持つ場合 (`CreatedOn` のタイムスタンプ、並び順、「主要タグ」フラグなど)、そのための実際のクラスを持つことになり、外部キーは暗黙のケースの二重化された `PostsId` / `TagsId` ではなく、単数形の規約 `PostId` / `TagId` に従います。この違いは、暗黙の結合から明示的な結合へと移行する人々をつまずかせます。

```csharp
// .NET 11, EF Core 11, C# 14 -- join entity with payload
public class PostTag
{
    public int PostId { get; set; }
    public int TagId { get; set; }
    public DateTime TaggedOn { get; set; }
}
```

これで、結合エンティティは通常のエンティティ型なので、どんなエンティティにシードを投入するのと同じやり方でシードを投入します:

```csharp
modelBuilder.Entity<Post>()
    .HasMany(p => p.Tags)
    .WithMany(t => t.Posts)
    .UsingEntity<PostTag>();

modelBuilder.Entity<PostTag>().HasData(
    new PostTag { PostId = 1, TagId = 1, TaggedOn = new DateTime(2026, 6, 1) },
    new PostTag { PostId = 1, TagId = 2, TaggedOn = new DateTime(2026, 6, 1) },
    new PostTag { PostId = 2, TagId = 3, TaggedOn = new DateTime(2026, 6, 2) });
```

`DateTime` が `DateTime.UtcNow` ではなくハードコードされた定数であることに注意してください。シードデータは決定論的でなければなりません。ビルドのたびに変化する値はモデルが変更されたように見せてしまい、EF は `PendingModelChangesWarning` を出力して、毎回新しいマイグレーションをスキャフォールドしようとします。これは [EF Core 6 から EF Core 11 への移行](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) の際につまずく粗削りな点の 1 つであり、そこではより厳格なモデル変更検出が、昨日まで静かな再シードだったものをビルド警告に変えてしまいます。挿入のタイムスタンプが必要な場合は、プロパティに `HasDefaultValueSql("GETUTCDATE()")` でデータベースのデフォルトを構成し、シードオブジェクトからは完全に省きます。

## 暗黙の結合型に関する注意点

EF チームはドキュメントでこの点を明確にしています: 暗黙の結合エンティティは現在 `Dictionary<string, object>` によって表現されていますが、それに依存してはいけません。将来の EF Core リリースでは、パフォーマンスのために実行時の型が変更される可能性があります。これはシードにおいて 1 つの実用的な意味で重要です。自分で `Dictionary<string, object>` を構築したり、その型を直接参照したりしてシードを投入しようとしてはいけません。`UsingEntity(...).HasData(...)` の中で匿名オブジェクトの形式を貫いてください。匿名オブジェクトは結合エンティティのプロパティに対してプロパティ名で照合されるので、EF が内部で使用する具体的な CLR 型が何であれ、それから絶縁されています。

結合型を参照したくなっている自分に気づいたら、それは前のセクションのように実際のクラスに昇格させるべきだという信号です。名前付きのクラスは、安定して参照可能な結合エンティティを得るためのサポートされた方法であり、シード、クエリ、ペイロード列の追加を簡単にしてくれます。

## 代わりに UseSeeding で実行時にシードを投入する

マイグレーション管理の `HasData` は、スキーマと一緒に出荷される小さくて固定的な参照用の関連付け (既知の投稿に紐付けられた既知のシステムタグのセットなど) に適したツールです。動的なもの、データベースによってキー付けされるもの、あるいは「このタグをこの投稿に追加する」とライブオブジェクトに対して表現したいものには不適切なツールです。そのような場合は、実際の `DbContext` があり、スキップナビゲーションを本来意図されたとおりに使える `UseSeeding` と `UseAsyncSeeding` で実行時にシードを投入します。

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedPostTags(context))
        .UseAsyncSeeding(async (context, _, ct) => await SeedPostTagsAsync(context, ct)));

static void SeedPostTags(DbContext context)
{
    var post = context.Set<Post>()
        .Include(p => p.Tags)
        .FirstOrDefault(p => p.Title == "EF Core 11 changes");
    if (post is null) return;

    var efcore = context.Set<Tag>().FirstOrDefault(t => t.Name == "efcore");
    if (efcore is not null && !post.Tags.Any(t => t.Id == efcore.Id))
    {
        post.Tags.Add(efcore);   // EF inserts the join row for you
        context.SaveChanges();
    }
}

static async Task SeedPostTagsAsync(DbContext context, CancellationToken ct)
{
    var post = await context.Set<Post>()
        .Include(p => p.Tags)
        .FirstOrDefaultAsync(p => p.Title == "EF Core 11 changes", ct);
    if (post is null) return;

    var efcore = await context.Set<Tag>().FirstOrDefaultAsync(t => t.Name == "efcore", ct);
    if (efcore is not null && !post.Tags.Any(t => t.Id == efcore.Id))
    {
        post.Tags.Add(efcore);
        await context.SaveChangesAsync(ct);
    }
}
```

注目すべき点が 2 つあります。第一に、`Include(p => p.Tags)` を行って既存の関連付けが読み込まれるようにします。これがないと、`!post.Tags.Any(...)` のガードが空のコレクションを見てしまい、結合テーブルへの主キー重複の挿入のリスクが生じます。第二に、存在チェックは必須です。なぜなら、これらのコールバックは最初の 1 回だけでなく、すべての `Migrate`、`EnsureCreated`、`dotnet ef database update` で実行されるからです。無条件にタグを追加すると、シーダーが 2 回目に実行されるときに `PostTag` で主キー違反に直面します。これらのコールバックがいつ発火するか、そしてなぜ同期と非同期の両方のオーバーロードを実装しなければならないかについての完全なルールは、[UseSeeding 詳細解説](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/) にあります。

その見返りとして、`post.Tags.Add(efcore)` という自然な API が使えます。EF の変更トラッカーはスキップナビゲーションの新しいエントリを見て、結合テーブルの挿入を自ら出力します。`PostsId` や `TagsId` に名前を付けることも、匿名オブジェクトを構築することもなく、コードはアプリケーションの残りの部分と同じように読めます。コストは、これがマイグレーションに焼き込まれるのではなく、起動時にライブのデータベースに対して実行されることです。そのため、本番のスキーマバージョン管理されたデータよりも、開発、テスト、冪等な参照データに最適です。

## 紛らわしいエラーを引き起こすミス

いくつかの失敗パターンが繰り返し現れますが、エラーメッセージが必ずしも本当の原因を指し示すとは限りません。

結合行だけにシードを投入してプリンシパルへのシードを忘れると、`database update` の時点で外部キー違反になります。なぜなら `PostsId = 1` は存在しない `Posts` 行を参照するからです。結合で参照するのと同じ固定キーで、常に両端にシードを投入してください。

誤ったシャドウキー名 (暗黙の結合に対して `PostsId` ではなく `PostId`) を使うと、マイグレーションのスキャフォールディングで、結合エンティティ上に存在しないプロパティについてのメッセージとともに失敗します。二重化された形式 (`PostsId`、`TagsId`) は暗黙のマッピングされていない結合のためのものであり、単数形 (`PostId`、`TagId`) は明示的な結合クラスのためのものです。これらは互換性がありません。

シードオブジェクトの中でペイロード列が `DateTime.UtcNow` のような非決定論的な値にデフォルトすることを許すと、「モデルが変更された」というマイグレーションが際限なく生み出されます。値をハードコードするか、データベースのデフォルトに押し出してください。

最後に、プリンシパルエンティティにキーがまったく定義されていない場合 (キーレスまたは構成ミスの型) は、シードがそこまで到達しません。先に [the entity type requires a primary key to be defined](/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) が表示されます。シードデータを心配する前にモデルを修正してください。

2 つのアプローチのどちらを選ぶかは、所有権に行き着きます。関連付けがスキーマのアイデンティティの一部であり、マイグレーションの中を一緒に旅すべきものなら、`UsingEntity(...).HasData(...)` で結合エンティティにシードを投入し、手作業でのキー管理という記帳作業を受け入れます。それらがライブオブジェクトに対して表現したい実行時データなら、`UseSeeding` を使ってスキップナビゲーションに追加します。ほとんどの実際のアプリケーションは、一握りのシステム関連付けには `HasData` を、それ以外のすべてには `UseSeeding` を使うことに行き着きます。そしてその使い分けこそ、EF チームがこれら 2 つのメカニズムでカバーするように設計したものそのものです。

出典: Microsoft Learn の EF Core [多対多リレーションシップのドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/many-to-many) は、暗黙の結合、`PostsId`/`TagsId` のシャドウキー、`UsingEntity` のオーバーロード、そして `Dictionary<string, object>` に依存することへの警告を詳述しています。EF Core の [データシードのドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) は、`HasData` と `UseSeeding`/`UseAsyncSeeding` の比較と決定論性の要件を扱っています。[dotnet/efcore#23363](https://github.com/dotnet/efcore/issues/23363) の GitHub ディスカッションは、結合テーブルにシードを投入するためのコミュニティで確認された `UsingEntity(...).HasData(...)` パターンを示しています。
