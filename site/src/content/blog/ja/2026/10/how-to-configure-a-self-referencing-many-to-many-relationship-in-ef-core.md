---
title: "EF Core で自己参照の多対多リレーションシップ (フォロワー/フォロー中) を構成する方法"
description: "EF Core 11 で単一の User エンティティにフォロワーとフォロー中をモデル化します。規約が何を生成するか、SQL Server が結合テーブルの外部キーの片方を黙って ClientCascade に変える理由、タイムスタンプ付きの明示的な Follow 結合エンティティのマッピング方法、そしてエラー 547 や 1785 を出さずにユーザーを削除する方法を解説します。"
pubDate: 2026-10-24
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "sql-server"
  - "relationships"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-configure-a-self-referencing-many-to-many-relationship-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-24
---

**結論:** エンティティに同じ型のコレクションナビゲーションを 2 つ、`List<User> Followers` と `List<User> Following` として用意し、`HasMany(u => u.Following).WithMany(u => u.Followers)` で対にします。EF Core はこれを、`Users` への外部キーを 2 つ持つ 1 つの結合テーブルにマッピングします。実用的なものにするなら、`UsingEntity<Follow>` を使って結合テーブル専用のクラス (`FollowerId`、`FolloweeId`、`CreatedAt` を持つ `Follow`) を用意し、削除時の動作は自分で決めてください。SQL Server は同じテーブルから同じ親への外部キーを 2 本とも cascade にすることを拒否する (エラー 1785) ため、片方を `Cascade` のままにし、もう片方を `ClientCascade` に設定します。そのうえで、ユーザーの削除は先に結合行へ `ExecuteDeleteAsync` を実行してから行います。以下の内容はすべて、.NET 11 SDK 11.0.100-rc.2、EF Core 11 (`Microsoft.EntityFrameworkCore.SqlServer` と `.Sqlite` 11.0.0-rc.2.26504.105)、C# 14 で検証しています。

フォロワーグラフは、自己参照の多対多の典型例です。どのユーザーも何人でもフォローでき、どのユーザーも何人からでもフォローされます。マッピングは 2 行で済みそうに見えますし、EF Core の規約のおかげで実際ほぼそのとおりです。問題が起きるのは、SQL Server 向けのマイグレーションを追加するとき、ユーザーを削除しようとするとき、あるいは誰がいつ誰をフォローしたかを知りたくなったときです。

## 規約が Followers と Following に対して生成するもの

まず、最小のモデルから始めます。

```csharp
// .NET 11, EF Core 11.0.0-rc.2, C# 14
public class User
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<User> Followers { get; } = [];
    public List<User> Following { get; } = [];
}

public class AppDb : DbContext
{
    public DbSet<User> Users => Set<User>();
}
```

ここには `OnModelCreating` がありませんが、EF Core は `Followers` と `Following` が 1 つの多対多リレーションシップの両端であると判断します。`User` 上で `User` を指すコレクションナビゲーションがこの 2 つしかないためです。これは公式ドキュメントが `Person.Parents` と `Person.Children` で示している仕組みと同じです。SQL Server プロバイダーで `Database.GenerateCreateScript()` を呼ぶと、次の結合テーブルが出力されます。

```sql
-- EF Core 11.0.0-rc.2, SQL Server provider, convention-only model
CREATE TABLE [UserUser] (
    [FollowersId] int NOT NULL,
    [FollowingId] int NOT NULL,
    CONSTRAINT [PK_UserUser] PRIMARY KEY ([FollowersId], [FollowingId]),
    CONSTRAINT [FK_UserUser_Users_FollowersId] FOREIGN KEY ([FollowersId]) REFERENCES [Users] ([Id]) ON DELETE CASCADE,
    CONSTRAINT [FK_UserUser_Users_FollowingId] FOREIGN KEY ([FollowingId]) REFERENCES [Users] ([Id])
);

CREATE INDEX [IX_UserUser_FollowingId] ON [UserUser] ([FollowingId]);
```

この出力には、注意して見るべき点が 3 つあります。

1 つ目は名前です。テーブル名は `UserUser` で、列名はナビゲーションにちなんで付けられるため、読むと向きが逆に感じられます。Alice (Id 1) が Bob (Id 2) を `alice.Following` に追加すると、テーブルに入る行は `FollowersId = 1, FollowingId = 2` です。つまり `FollowersId` にはフォローする側が、`FollowingId` にはフォローされる側が入ります。正しい動作ですが、半年後に SSMS でこのテーブルを見た人はまず推測できません。

2 つ目は、`ON DELETE CASCADE` が付いている外部キーが片方だけであることです。同じモデルを SQLite で生成すると、両方に cascade が付きます。この違いは `SqlServerOnDeleteConvention` によるもので、SQL Server プロバイダーは EF Core 5 からこれを備えています ([dotnet/efcore#21959](https://github.com/dotnet/efcore/pull/21959))。結合テーブルの 2 つの外部キーが同じテーブルを指している場合、片方は `Cascade` を維持し、もう片方を `DeleteBehavior.ClientCascade` に格下げします。どちらが残るかは 2 つのナビゲーション名の序数による文字列比較で決まり、意図して選べるものではありません。モデルで確認できます。

```csharp
// .NET 11, EF Core 11.0.0-rc.2
foreach (var fk in db.Model.FindEntityType("UserUser")!.GetForeignKeys())
    Console.WriteLine($"{fk.Properties[0].Name}: {fk.DeleteBehavior}");

// SQL Server provider:  FollowersId: Cascade, FollowingId: ClientCascade
// SQLite provider:      FollowersId: Cascade, FollowingId: Cascade
```

3 つ目は、この結合エンティティが `Dictionary<string, object>` を基にした共有型エンティティであることです。`CreatedAt` 列を置く場所がなく、ドキュメントでもこの辞書型に依存しないよう明記されています。他の規約でも同じように列名で引っかかった経験があるなら、EF がこうしたプロパティを自動で作る仕組みを [マイグレーションにシャドウプロパティが現れた理由](/ja/2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration/) の記事で解説しています。

## SQL Server で片側の cascade を止める必要がある理由

両方の外部キーが cascade だと、`Users` の 1 行を削除したときに、同じ `UserUser` の行へ 2 つの経路 (フォロワーとして、フォロー対象として) で到達できてしまいます。SQL Server はこれを許可せず、`CREATE TABLE` をエラー 1785 で拒否します。*Introducing FOREIGN KEY constraint ... may cause cycles or multiple cascade paths. Specify ON DELETE NO ACTION or ON UPDATE NO ACTION, or modify other FOREIGN KEY constraints.*

規約だけのモデルでは、プロバイダーが事前に回避しているためこのエラーは見えません。結合エンティティを自分で制御し、"当然そう書く" 構成を書いた時点で表面化します。

```csharp
// .NET 11, EF Core 11.0.0-rc.2 -- DON'T: explicit Cascade beats the convention
.UsingEntity<Follow>(
    r => r.HasOne<User>().WithMany().HasForeignKey(f => f.FolloweeId).OnDelete(DeleteBehavior.Cascade),
    l => l.HasOne<User>().WithMany().HasForeignKey(f => f.FollowerId).OnDelete(DeleteBehavior.Cascade));
```

明示的な構成は常に規約より優先されるため、`SqlServerOnDeleteConvention` は手を引き、生成される DDL では両方の制約に `ON DELETE CASCADE` が付きます。SQL Server では `dotnet ef database update` が 1785 で失敗しますが、同じマイグレーションが SQLite や PostgreSQL では問題なく動きます。このプロバイダー間の差のせいで、バグが CI やステージング環境でしか見つからないことがよくあります。

トレードオフのもう半分は、`ClientCascade` が実行時に何を意味するかです。データベース制約は `NO ACTION` になり、EF Core は依存する行を *追跡している場合に限って* 削除すると約束します。`ClientCascade` 側の結合行を読み込んでいないユーザーを削除すると、SQL Server はエラー 547 (*The DELETE statement conflicted with the REFERENCE constraint*) を返します。SQLite では同じ状況が `SQLite Error 19: 'FOREIGN KEY constraint failed'` として現れます。詳しくは後述の削除のセクションで扱います。この問題の一般的な説明は [エンティティ削除時の FOREIGN KEY constraint failed の修正](/ja/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/) にあります。

## 明示的な Follow 結合エンティティをマッピングする

フォロワーグラフでは、ほぼ必ず明示的な結合クラスが欲しくなります。読みやすい列名が得られ、`CreatedAt` (あるいは `Muted`、`NotificationsEnabled` など) を置く場所ができ、ユーザーを読み込まずにクエリや一括削除ができる `DbSet` も手に入ります。マッピング全体を手順に沿って示します。

1. `FollowerId`、`FolloweeId`、追加の列、そして両ユーザーへの参照ナビゲーションを持つ `Follow` クラスを追加します。
2. 日常のコードを自然に保つため、スキップナビゲーション (`Followers`、`Following`) は `User` に残します。ペイロードが必要なときのために、結合ナビゲーション (`FollowerLinks`、`FollowingLinks`) も追加します。
3. スキップナビゲーションを `HasMany(...).WithMany(...)` で対にし、`Follow` を `UsingEntity<Follow>` に渡します。各側の外部キーを明示的に構成し、名前も向きも規約に任せないようにします。
4. 片方の外部キーを `Cascade`、もう片方を `ClientCascade` に、意図して設定します。
5. 複合キー、2 つ目のキー列のインデックス、`CreatedAt` の既定値、そして自分自身のフォローを禁止する check 制約を追加します。

```csharp
// .NET 11, EF Core 11.0.0-rc.2, C# 14
public class User
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    // skip navigations
    public List<User> Followers { get; } = [];
    public List<User> Following { get; } = [];

    // navigations to the join entity
    public List<Follow> FollowerLinks { get; } = [];   // rows where I am the followee
    public List<Follow> FollowingLinks { get; } = [];  // rows where I am the follower
}

public class Follow
{
    public int FollowerId { get; set; }
    public int FolloweeId { get; set; }
    public DateTime CreatedAt { get; set; }
    public User Follower { get; set; } = null!;
    public User Followee { get; set; } = null!;
}

public class AppDb(DbContextOptions<AppDb> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Follow> Follows => Set<Follow>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<User>()
            .HasMany(u => u.Following)
            .WithMany(u => u.Followers)
            .UsingEntity<Follow>(
                r => r.HasOne(f => f.Followee).WithMany(u => u.FollowerLinks)
                      .HasForeignKey(f => f.FolloweeId)
                      .OnDelete(DeleteBehavior.Cascade),
                l => l.HasOne(f => f.Follower).WithMany(u => u.FollowingLinks)
                      .HasForeignKey(f => f.FollowerId)
                      .OnDelete(DeleteBehavior.ClientCascade),
                j =>
                {
                    j.ToTable("Follows", t => t.HasCheckConstraint(
                        "CK_Follows_NoSelfFollow", "FollowerId <> FolloweeId"));
                    j.HasKey(f => new { f.FollowerId, f.FolloweeId });
                    j.HasIndex(f => f.FolloweeId);
                    j.Property(f => f.CreatedAt).HasDefaultValueSql("SYSUTCDATETIME()");
                });
    }
}
```

`r` ラムダは `HasMany(...).WithMany(...)` の *右* 側、つまり `Following` 経由で到達するエンティティ (フォロー対象) のリレーションシップを構成します。`l` ラムダは *左* 側、つまり `Following` を持つユーザー (フォローする側) です。これを取り違えてもコンパイルは通り、グラフ全体が黙って逆転します。そのため、向きは一度テストで必ず検証しています (後述)。

これによって生成される SQL Server の DDL は次のとおりです。

```sql
-- EF Core 11.0.0-rc.2, SQL Server provider, explicit Follow join entity
CREATE TABLE [Follows] (
    [FollowerId] int NOT NULL,
    [FolloweeId] int NOT NULL,
    [CreatedAt] datetime2 NOT NULL DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT [PK_Follows] PRIMARY KEY ([FollowerId], [FolloweeId]),
    CONSTRAINT [CK_Follows_NoSelfFollow] CHECK (FollowerId <> FolloweeId),
    CONSTRAINT [FK_Follows_Users_FolloweeId] FOREIGN KEY ([FolloweeId]) REFERENCES [Users] ([Id]) ON DELETE CASCADE,
    CONSTRAINT [FK_Follows_Users_FollowerId] FOREIGN KEY ([FollowerId]) REFERENCES [Users] ([Id])
);

CREATE INDEX [IX_Follows_FolloweeId] ON [Follows] ([FolloweeId]);
```

複合主キー `(FollowerId, FolloweeId)` は、すでに "X は誰をフォローしているか" の検索に使えます。`FolloweeId` の追加インデックスは "誰が X をフォローしているか" に使われます。これはフォロワー数を数えるあらゆるクエリの基になるため、削除しないでください。SQLite では `SYSUTCDATETIME()` を `CURRENT_TIMESTAMP` に置き換えます。

## フォロー、フォロー解除、向きの確認

書き込みはスキップナビゲーションでも結合エンティティでも行えます。スキップナビゲーションを使うと、EF が `Follow` 行を作成し、`CreatedAt` はデータベースが埋めます。

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var dave = await db.Users.Include(u => u.Followers).SingleAsync(u => u.Name == "dave");
var alice = await db.Users.SingleAsync(u => u.Name == "alice");

dave.Followers.Add(alice);   // alice follows dave
await db.SaveChangesAsync();

var row = await db.Follows.SingleAsync(f => f.FollowerId == alice.Id && f.FolloweeId == dave.Id);
// row.FollowerId == alice.Id, row.FolloweeId == dave.Id, row.CreatedAt populated
```

このラウンドトリップが、向きのテストです。`FollowerId` が Dave の id で返ってきたら、`r` と `l` のラムダが入れ替わっています。

ただし、リクエストハンドラーでは、1 行を挿入するためにユーザーとフォロワーコレクション全体を読み込むのは無駄です。代わりに結合エンティティを使えば、何も読み込まずに済みます。

```csharp
// .NET 11, EF Core 11.0.0-rc.2
db.Follows.Add(new Follow { FollowerId = currentUserId, FolloweeId = targetId });
await db.SaveChangesAsync();

// unfollow, one DELETE statement, no tracking
await db.Follows
    .Where(f => f.FollowerId == currentUserId && f.FolloweeId == targetId)
    .ExecuteDeleteAsync();
```

マッピングに入れた 2 つのガードレールは、どちらも実際のデータベースエラーとして発動します。SQLite では、自分自身のフォローは `CHECK constraint failed: CK_Follows_NoSelfFollow` で、同じ相手の二重フォローは `UNIQUE constraint failed: Follows.FollowerId, Follows.FolloweeId` で失敗します。SQL Server では後者は主キー違反 (エラー 2627) です。同時にダブルクリックされると実際に発生するため、500 ではなく "すでにフォロー済み" として扱ってください。PostgreSQL での同じパターンは [同時実行される EF Core の INSERT での重複キーの処理](/ja/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/) で解説しています。

## 件数、相互フォロー、おすすめのクエリ

スキップナビゲーションは `Follows` を経由する結合に変換されるため、件数の取得でコレクションを読み込むことはありません。

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var profile = await db.Users
    .Where(u => u.Id == userId)
    .Select(u => new { u.Name, Followers = u.Followers.Count, Following = u.Following.Count })
    .SingleAsync();
```

```sql
-- SQL Server, from ToQueryString()
SELECT [u].[Name], (
    SELECT COUNT(*)
    FROM [Follows] AS [f]
    WHERE [u].[Id] = [f].[FolloweeId]) AS [Followers], (
    SELECT COUNT(*)
    FROM [Follows] AS [f0]
    WHERE [u].[Id] = [f0].[FollowerId]) AS [Following]
FROM [Users] AS [u]
WHERE [u].[Id] = @userId
```

"相互フォロー" (自分がフォローしていて、自分をフォローし返している人) は、スキップナビゲーションを使うと自然に書けます。

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var mutual = await db.Users
    .Where(u => u.Id == userId)
    .SelectMany(u => u.Following.Where(f => f.Following.Any(x => x.Id == userId)))
    .Select(f => f.Name)
    .ToListAsync();
```

これで動きますが、スキップナビゲーションを 1 回たどるごとにユーザーテーブルを経由するため、生成される SQL は `Users` を 3 回結合します。負荷の高いグラフクエリでは、`Follows` に対して直接書いてください。次は "自分がフォローしている人がフォローしている人のうち、自分がまだフォローしていない人" を、自分のフォローのうち何件がその人に繋がっているかで順位付けしたものです。

```csharp
// .NET 11, EF Core 11.0.0-rc.2
var suggestions = await db.Follows
    .Where(f => db.Follows.Any(a => a.FollowerId == userId && a.FolloweeId == f.FollowerId)
             && f.FolloweeId != userId
             && !db.Follows.Any(a => a.FollowerId == userId && a.FolloweeId == f.FolloweeId))
    .GroupBy(f => f.Followee.Name)
    .Select(g => new { Name = g.Key, Via = g.Count() })
    .OrderByDescending(x => x.Via)
    .ToListAsync();
```

サンプルグラフ alice -> bob、alice -> carol、bob -> alice、carol -> dave、bob -> dave では、件数のクエリは `{ Name = alice, Followers = 1, Following = 2 }` を返し、Alice の相互フォローは `bob` を返し、おすすめは `dave via 2` を返します。このクエリは、余分なユーザー結合のない 2 つの `EXISTS` サブクエリを持つ 1 本の `SELECT ... GROUP BY` にコンパイルされます。ページングが必要なフォロワー一覧では、`Skip` の代わりに `(FolloweeId, CreatedAt)` の組を使った [キーセットページネーション](/ja/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/) を使ってください。

## エラー 547 を出さずにユーザーを削除する

ここで `ClientCascade` 側が問題になります。上のマッピングでは、削除されるユーザーが *フォロー対象* である行はデータベースの cascade で消えます。削除されるユーザーが *フォローする側* である行は EF Core に依存し、EF は追跡しているものしか削除しません。同じ制約を持つ SQLite で、3 つのパターンを測定しました。

```csharp
// .NET 11, EF Core 11.0.0-rc.2

// 1. Join rows on the ClientCascade side NOT loaded -> fails
var bob = await db.Users.SingleAsync(u => u.Name == "bob");
db.Remove(bob);
await db.SaveChangesAsync();
// SQLite: SQLite Error 19: 'FOREIGN KEY constraint failed'
// SQL Server: error 547, DELETE conflicted with the REFERENCE constraint

// 2. Load the ClientCascade side first -> works
var carol = await db.Users.Include(u => u.FollowingLinks).SingleAsync(u => u.Name == "carol");
db.Remove(carol);
await db.SaveChangesAsync();
// EF deletes carol -> dave itself, the database cascade deletes alice -> carol
```

方法 2 は管理画面なら問題ありませんが、フォロー数が 20 万件あるユーザーの全フォロー行を変更トラッカーに読み込んで削除するのは現実的ではありません。本番で使っているのは、追跡を完全に省略し、1 つのトランザクションで実行する方法です。

```csharp
// .NET 11, EF Core 11.0.0-rc.2
// 3. Bulk-delete the join rows, then the user
await using var tx = await db.Database.BeginTransactionAsync();

await db.Follows
    .Where(f => f.FollowerId == userId || f.FolloweeId == userId)
    .ExecuteDeleteAsync();

await db.Users
    .Where(u => u.Id == userId)
    .ExecuteDeleteAsync();

await tx.CommitAsync();
```

サンプルグラフの Bob では、フォロー行 3 件とユーザー 1 件が削除され、Bob に関係しなかったフォローだけが残りました。`ExecuteDeleteAsync` は変更トラッカーを経由しないため、このコンテキストですでに追跡されている `Follow` や `User` のインスタンスは、実行後に古い状態になることに注意してください。トレードオフは [ExecuteUpdate と ExecuteDelete による一括書き込み](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) でさらに詳しく扱っています。

アプリがユーザーを論理削除する場合、削除そのものについては何も当てはまりません。ユーザー行は残り、結合行も残るため、無効化されたアカウントをフォロワーとして数えるかどうかはクエリ側で決めます。

## 最初のマイグレーション前に知っておくべき注意点

- **規約から明示的な結合エンティティに切り替えると、テーブル名が変わります。** `FollowersId`/`FollowingId` を持つ `UserUser` が、`FollowerId`/`FolloweeId` を持つ `Follows` になります。生成されるマイグレーションはテーブルを削除して作り直すため、すべてのフォローが失われます。マイグレーションを編集して `RenameTable` と `RenameColumn` を使ってください。[データを失わずにテーブル名を変更する](/ja/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/) ときと同じ方法です。
- **対称的な "友達" リレーションシップは別の形になります。** `List<User> Friends` というナビゲーション 1 つでは、対にする逆側がありません。ドキュメントでは単方向 (`HasMany(u => u.Friends).WithMany()`) でマッピングし、お互いのコレクションに自分で追加するか、両方向を 2 行として保存することを推奨しています。
- **3 つ目の `List<User>` ナビゲーションを追加すると、すべてが黙って消えます。** `Followers` と `Following` の隣に `Blocked` を追加すると、EF はどの 2 つが対なのか判断できなくなります。EF Core 11 RC 2 では例外を投げません。`Model.ToDebugString()` は `User` が `Id` だけでリレーションシップを持たないことを示し、コレクションは単に読み込まれません。自己型のコレクションが 3 つ目になった時点で、各ペアを `HasMany(...).WithMany(...)` で明示的に構成してください。
- **フォローのシードには結合エンティティが必要です。** `HasData` ではスキップナビゲーションを埋められません。固定キーを使って `Follow` 行をシードしてください。詳しくは [EF Core 11 での多対多リレーションシップのシード](/ja/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) を参照してください。
- **人気アカウントに対する `Include(u => u.Followers)` は罠です。** すべてのフォロワーをマテリアライズしてしまいます。代わりに件数を射影するか、`Follows` に対してページングしてください。

## 次に読む

- [EF Core 11 で多対多リレーションシップをシードする方法](/ja/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/)
- [EF Core 11 でエンティティ削除時の FOREIGN KEY constraint failed を修正する](/ja/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [EF Core 11 で ExecuteUpdate と ExecuteDelete を使って一括書き込みを行う方法](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [EF Core 11 のシャドウプロパティとは何か、なぜマイグレーションに現れたのか](/ja/2026/10/what-is-a-shadow-property-in-ef-core-11-and-why-did-one-show-up-in-my-migration/)

出典: EF Core の [多対多リレーションシップのドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/many-to-many) (自己参照と対称のセクション、`UsingEntity` のオーバーロード)、`ClientCascade` の動作についての [cascade delete のドキュメント](https://learn.microsoft.com/en-us/ef/core/saving/cascade-delete)、[`SqlServerOnDeleteConvention` のソース](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Metadata/Conventions/SqlServerOnDeleteConvention.cs) とそれを導入した PR [dotnet/efcore#21959](https://github.com/dotnet/efcore/pull/21959)、そして SQL Server ドキュメントの [cascading referential integrity](https://learn.microsoft.com/en-us/sql/relational-databases/tables/primary-and-foreign-key-constraints)。
