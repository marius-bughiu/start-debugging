---
title: "修正: EF Core で The property 'X' is part of a key and so cannot be modified or marked as modified が発生する"
description: "EF Core は追跡中のエンティティのキー値を更新しません。DTO からのキーのコピーをやめ、代替キーの代わりに一意インデックスを使い、本当にキーを変える場合は新しい行を挿入して古い行を削除します。EF Core 10.0.14 で検証しています。"
pubDate: 2026-10-27
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "dotnet"
  - "csharp"
  - "change-tracker"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/10/fix-the-property-is-part-of-a-key-and-so-cannot-be-modified-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-27
---

**結論:** EF Core は、エンティティが一度保存されると、すべてのキープロパティ (主キー、代替キー、主キーの一部でもある外部キー) を読み取り専用として扱い、新しい値を検出した時点で変更トラッカーが例外をスローします。キーを書き込んでいる箇所を探してください。多くの場合、`0` の `Id` をコピーしている DTO マッパーや `CurrentValues.SetValues`、`HasAlternateKey` で構成した自然キーの列、複合キーを持つ子行を別の親へ移動する処理のいずれかです。キーへの書き込みをやめるか、代替キーを一意インデックスに切り替えてください。キーを本当に変える必要がある場合は、同じ `SaveChanges` の中で新しいキーを持つエンティティを追加し、古いものを削除します。

以下はすべて、.NET 10 (SDK 10.0.302) と `Microsoft.EntityFrameworkCore.Sqlite` 10.0.14 を使い、インメモリの SQLite データベースに対して再現しています。例外をスローするチェックは `InternalEntryBase.SetPropertyModified` にあり、EF Core 11 として出荷される EF Core の `main` ブランチでも変わっていないため、.NET 11 のリリース候補にも同じルールが当てはまります。

## エラーの全体像

```
System.InvalidOperationException: The property 'Blog.Id' is part of a key and so cannot be modified or marked as modified. To change the principal of an existing entity with an identifying foreign key, first delete the dependent and invoke 'SaveChanges', and then associate the dependent with the new principal.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.InternalEntryBase.SetPropertyModified(IProperty property, Boolean changeState, Boolean isModified, Boolean isConceptualNull, Boolean acceptChanges)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.DetectValueChange(IInternalEntry entry, IProperty property)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.LocalDetectChanges(InternalEntryBase entry)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.LocalDetectChanges(InternalEntityEntry entry)
```

メッセージ中のプロパティ名から、EF がどのキーを保護しているかがわかります。`Blog.Id` は主キーです。`Blog.Slug` のような名前なら代替キーを意味します。`OrderLine.OrderId` は複合主キーの一部でもある外部キーで、メッセージの 2 文目が述べている"identifying foreign key"にあたります。

## EF Core がキーの変更を拒否する理由

追跡中のエンティティはキーで識別されます。`DbContext` はキー値からエンティティインスタンスへの ID マップを保持し、`UPDATE` の `WHERE` 句には元のキーを使い、外部キーとプリンシパルキーを突き合わせてナビゲーションを修復します。キーをその場で変更できるとすると、この 3 つすべてを途中で書き換える必要があり、さらにデータベース内のすべての依存行も書き換える必要があります。EF Core はそれをサポートしておらず、その追加を求める [dotnet/efcore#4073](https://github.com/dotnet/efcore/issues/4073) は現在も未解決です。

このガードはメタデータ駆動です。すべてのキープロパティには保存後の動作として `PropertySaveBehavior.Throw` が設定され、`Unchanged` または `Modified` のエンティティのプロパティが変更済みとしてフラグ付けされそうになるたびに、変更トラッカーがこれを確認します。

```csharp
// EF Core source, src/EFCore/ChangeTracking/Internal/InternalEntryBase.cs (simplified)
if (changeState
    && !isConceptualNull
    && isModified
    && !StateManager.SavingChanges
    && property.IsKey()
    && property.GetAfterSaveBehavior() == PropertySaveBehavior.Throw)
{
    throw new InvalidOperationException(CoreStrings.KeyReadOnly(property.Name, StructuralType.DisplayName()));
}
```

デバッグでは次の 2 点が重要です。1 つ目は、`Added` 状態のエンティティはこのチェックの前に return するため、まだ保存していないエンティティのキーを変更しても問題ないことです。2 つ目は、既定のスナップショット変更追跡では、キーを代入した行で例外はスローされないことです。例外は次の `DetectChanges` でスローされ、これは `SaveChanges`、`ChangeTracker.HasChanges()`、`ChangeTracker.Entries()` などの呼び出しの内部で実行されます。私の再現では、`blog.Id = 99;` は何事もなく完了し、直後の `db.ChangeTracker.HasChanges()` でスローされました。スタックトレースがリポジトリ内の `SaveChangesAsync` を指していても、本当の原因はリクエスト内のもっと前にあります。

また、これを無効にすることはできません。キープロパティの保存動作を切り替えようとすると、モデルの構築中に失敗します。

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().Property(b => b.Id).Metadata
    .SetAfterSaveBehavior(PropertySaveBehavior.Save);
// InvalidOperationException: The property 'Blog.Id' must be marked as read-only after it has been
// saved because it is part of a key. Key properties are always read-only once an entity has been
// saved for the first time.
```

## 最小限の再現コード

```csharp
// .NET 10, C# 14, EF Core 10.0.14, Microsoft.EntityFrameworkCore.Sqlite
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

using var conn = new SqliteConnection("Data Source=:memory:");
conn.Open();

using (var db = new AppDb(conn))
{
    db.Database.EnsureCreated();
    db.Blogs.Add(new Blog { Id = 1, Name = "Start Debugging" });
    db.SaveChanges();
}

using (var db = new AppDb(conn))
{
    var blog = db.Blogs.Single(b => b.Id == 1);
    blog.Id = 99;       // no exception here
    db.SaveChanges();   // InvalidOperationException: The property 'Blog.Id' is part of a key...
}

class AppDb(SqliteConnection c) : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite(c);
    protected override void OnModelCreating(ModelBuilder mb) =>
        mb.Entity<Blog>().Property(b => b.Id).ValueGeneratedNever();
}

class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}
```

わざわざ `blog.Id = 99` と書く人はいないため、この記事の残りでは、実際に書き込みが発生する 4 つの場所を、遭遇する頻度の高い順に説明します。

## 修正 1: DTO からキーをコピーしない

これが圧倒的に多い原因です。PUT エンドポイントがエンティティを読み込み、受信したモデルをその上にコピーします。

```csharp
// .NET 10, EF Core 10.0.14
public record BlogDto(int Id, string Name);

var blog = await db.Blogs.SingleAsync(b => b.Id == id);
db.Entry(blog).CurrentValues.SetValues(dto);   // dto.Id is 0 because the client never sent it
await db.SaveChangesAsync();                    // throws: 'Blog.Id' is part of a key
```

`PropertyValues.SetValues` は、キーを含め、名前が一致するすべてのプロパティをコピーします。DTO の `Id` が追跡中のものと一致していれば何も変わらず、保存は成功します。`Id = 1` の行に対して `Id = 1` で `SetValues` を呼んでも問題なく保存できることを確認しました。クライアントが本文で id を省略した場合や、ルートの id と本文の id が一致しない場合は、キーが変わるため EF がスローします。このケースではスタックトレースが異なる点に注意してください。`SetValues` は変更トラッカーを直接経由するため、例外は `SaveChanges` ではなく `SetValues` 自体の内部 (`ChangeDetector.PropertyChanged`) で発生します。

id の信頼できる情報源は 1 つに決め (通常はルート)、本文で上書きされないようにします。

```csharp
// .NET 10, EF Core 10.0.14
app.MapPut("/blogs/{id:int}", async (int id, BlogDto dto, AppDb db) =>
{
    if (dto.Id != 0 && dto.Id != id)
        return Results.BadRequest("Route id and body id differ.");

    var blog = await db.Blogs.SingleOrDefaultAsync(b => b.Id == id);
    if (blog is null) return Results.NotFound();

    db.Entry(blog).CurrentValues.SetValues(dto with { Id = id });
    await db.SaveChangesAsync();
    return Results.NoContent();
});
```

さらに良いのは、`Id` プロパティをまったく持たない更新用 DTO を使い、コピーするものを何も残さないことです。AutoMapper の場合、同等の対処は DTO からエンティティへのマップに `.ForMember(d => d.Id, o => o.Ignore())` を指定することで、複合キーの一部である外部キーを含め、すべてのキー列に `ForMember(...Ignore())` を追加しておく価値があります。

手書きの"全プロパティをコピーする"ヘルパーや、リフレクションベースのパッチ処理でも同じ間違いが起こります。自作する場合は、`entry.Metadata.FindPrimaryKey()!.Properties` と、`property.IsKey()` が true になるものを除外してください。

## 修正 2: 自然識別子には代替キーではなく一意インデックスを使う

2 つ目のパターンは、スラッグ、メールアドレス、SKU のように"一意"と考えている列を、代替キーとして構成している場合です。

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().HasAlternateKey(b => b.Slug);

var blog = db.Blogs.Single();
blog.Slug = "new-slug";
db.SaveChanges();   // InvalidOperationException: The property 'Blog.Slug' is part of a key...
```

代替キーは EF にとってあらゆる意味でキーであるため、保存後は読み取り専用になります。EF Core のドキュメントにもはっきり書かれています: "In EF, alternate keys are read-only"。データベースで一意性だけが必要なら、代わりに一意インデックスを構成します。

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().HasIndex(b => b.Slug).IsUnique();
```

この 1 行の変更で、同じコードが保存に成功し、行を読み戻すと `Slug = "new-slug"` になっていました。データベースは引き続き一意性を強制しますが、失うのは `Slug` を指す外部キーを張れなくなることだけです。

宣言していない代替キーにも注意してください。リレーションシップに `HasPrincipalKey(x => x.Slug)` を指定すると、外部キーはキーを対象にする必要があるため、EF が規約によって代替キーを作成します。`HasAlternateKey` を呼んだ覚えのないプロパティがメッセージに出た場合は、モデル構成から `HasPrincipalKey` を検索するか、実行時に `db.Model.FindEntityType(typeof(Blog))!.GetKeys()` を調べてください。そのリレーションシップが主キーを対象にするよう切り替えるのがきれいな解決策です。マイグレーションの観点では、代替キーから一意インデックスへの変更は、`AK_` の一意制約を `IX_` の一意インデックスに置き換えるため、適用前に生成されたマイグレーションを確認してください。

## 修正 3: 複合キーを持つ依存エンティティは削除して追加し直すことで移動する

メッセージの 2 文目はこのケースについてのものです。たとえば注文明細が `(OrderId, LineNumber)` をキーとし、`OrderId` が `Order` への外部キーでもあるとします。これは識別リレーションシップで、明細の ID に親が含まれています。別の注文へ移動することは主キーを変更することを意味し、それを表現するどの方法でもスローされます。

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<OrderLine>().HasKey(l => new { l.OrderId, l.LineNumber });

var line = db.OrderLines.Single();
line.OrderId = 2;                     // throws at SaveChanges
// line.Order = order2;               // throws during fix-up
// order2.Lines.Add(line);            // throws during fix-up
db.SaveChanges();
```

私の再現では、3 つのバリエーションすべてで `The property 'OrderLine.OrderId' is part of a key` が発生しました。ナビゲーション版とコレクション版は、外部キーを代わりに設定するリレーションシップの修復からスローされます。

解決策は、この移動を実態どおりに、つまり 1 行の削除と別の行の挿入として扱うことです。

```csharp
// .NET 10, EF Core 10.0.14
var line = await db.OrderLines.SingleAsync(l => l.OrderId == 1 && l.LineNumber == 1);

db.OrderLines.Remove(line);
db.OrderLines.Add(new OrderLine
{
    OrderId = 2,
    LineNumber = 1,
    Sku = line.Sku,
});

await db.SaveChangesAsync();
```

メッセージでは、削除の後、挿入の前に `SaveChanges` を呼ぶよう勧めています。EF Core 10 では、試したどのケースでもその必要はありませんでした。古い明細の削除と新しい明細の追加を 1 回の `SaveChanges` で行うと、新しいキーが異なる場合 (`2/1`) も、同一の場合 (新しい `Sku` で `1/1`) も動作し、どちらも同じトランザクションで 2 つの文が実行されました。1 回の `SaveChanges` のほうが安全でもあります。2 回の保存の間にクラッシュすると、明細が削除されたまま再作成されない状態になるためです。

明細が頻繁に親の間を移動するなら、モデルが何かを伝えています。`OrderLine` に独自の代理キー (`int Id`) を持たせ、`OrderId` を通常の、キーではない外部キーにしてください。そうすれば `line.OrderId = 2` は普通の更新になります。その制約が必要なら、`(OrderId, LineNumber)` を一意インデックスで一意に保ちます。

## 修正 4: コピーを挿入して子を付け替え、プリンシパルのキーを振り直す

主キー自体を変更しなければならないことがあります。レガシーな自然キーが誤って入力されていた場合や、2 つのシステムを統合する場合です。変更トラッカーの内部では、パターンは修正 3 と同じで、子のための手順が 1 つ増えます。

```csharp
// .NET 10, EF Core 10.0.14
var old = await db.Blogs.Include(b => b.Posts).SingleAsync(b => b.Id == 1);

var replacement = new Blog { Id = 99, Name = old.Name, Slug = old.Slug + "-moved" };
db.Blogs.Add(replacement);

foreach (var post in old.Posts.ToList())
    post.Blog = replacement;          // Post.BlogId is a plain FK, not part of Post's key

db.Blogs.Remove(old);
await db.SaveChangesAsync();
```

EF Core がコマンドの順序 (新しいブログの挿入、投稿の更新、古いブログの削除) を判断し、1 つのトランザクションで実行します。再現では、`Id = 99` のブログが 1 件残り、投稿の `BlogId` は `99` に設定されました。コピー側ではスラッグを変更している点に注意してください。`Slug` に一意インデックスがある場合、まだ削除されていない古い行と同一の値を挿入すると衝突する可能性があります。コピーに一時的な値を与えて後で修正するか、以下のセットベースの方法を使います。

### セットベースの抜け道: ExecuteUpdate

`ExecuteUpdate` は直接 SQL に変換され、変更トラッカーには一切触れないため、キーのガードは適用されません。

```csharp
// .NET 10, EF Core 10.0.14
var rows = await db.Blogs
    .Where(b => b.Id == 1)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Id, 99));
```

投稿を持たないブログでは `1` が返り、行の id は `99` になりました。それを参照する投稿があるブログでは、SQLite は `SQLite Error 19: 'FOREIGN KEY constraint failed'` を返しました。外部キーが `ON UPDATE CASCADE` で宣言されていない限り、どのデータベースでもこうなります。EF Core の Fluent API には `OnDelete` はありますが、更新用の同等のものはないため、マイグレーションで `migrationBuilder.Sql(...)` を使ってカスケードを追加する必要があります。一度きりのデータ修正であれば、通常そこまでする価値はありません。挿入、付け替え、削除のほうが理解しやすいです。

キーに対して `ExecuteUpdate` を使う場合の注意点が 2 つあります。同じコンテキストですでに追跡されているエンティティは古いキーのままなので、新しいコンテキストで更新するか、先にデタッチしてください。また、`SaveChanges` のインターセプターや監査ロジックを迂回します。それが狙いでもあるでしょうが、意図的に選ぶべきです。

## 落とし穴と似たエラー

**キーに `IsModified` を設定すると、即座にスローされます。** `entry.Properties` をループしてすべてに `IsModified = true` を設定するコードは、最初のキープロパティで失敗します。再現では、`db.Entry(blog).Property(b => b.Id).IsModified = true` は `SaveChanges` を呼ばなくてもスローされました。`p.Metadata.IsKey()` が true のプロパティはスキップしてください。エントリ全体を `EntityState.Modified` に設定するのは問題ありません (再現では問題なく保存できました)。EF がキー以外のプロパティだけを変更済みとしてマークするためです。

**異なる id を持つデタッチ済みオブジェクトでの `Update()` は別のエラーです。** `db.Update(new Blog { Id = 2, ... })` はキーを変更しようとはしません。`UPDATE ... WHERE Id = 2` を送信し、その行が存在しない場合は `DbUpdateConcurrencyException: The database operation was expected to affect 1 row(s), but actually affected 0 row(s)` になります。根本的な間違い (クライアントからの誤った id) は同じですが、症状が異なります。

**同じキーを持つ 2 つのインスタンスも別のエラーです。** 古いオブジェクトがまだ追跡されている状態で、新しいキーを持つ 2 つ目のオブジェクトをアタッチしてこのエラーを回避しようとすると、代わりに["cannot be tracked because another instance with the same key value is already being tracked" エラー](/ja/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)に遭遇することがあります。アタッチする前に[エンティティがすでに追跡されているかを確認する](/ja/2026/10/how-to-check-whether-an-entity-is-already-tracked-by-the-dbcontext-in-ef-core/)と、どちらも避けられます。

**`Added` エンティティのキーの変更は問題ありません。** 最初の `SaveChanges` までは、キーはまだ"保存済み"ではないため、`var b = new Blog { Id = 5 }; db.Add(b); b.Id = 6;` は `Id = 6` の行を挿入します。これは、仮の id を割り当てて保存前に修正するコードで重要になります。

## 関連記事

セットベースのステートメントでキーを変更する場合は、[一括書き込みのための ExecuteUpdate と ExecuteDelete](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) の解説で API と追跡中のエンティティとの相互作用を扱っており、[ExecuteUpdate と、エンティティを読み込んで SaveChanges を呼ぶ方法の比較](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)では、それぞれがどの場面に適しているかを説明しています。キーの振り直しの削除側が、子がまだ古い行を指しているために失敗する場合は、[外部キー制約エラーの修正](/ja/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)を参照してください。例外が発生する前に、どのエントリが保存されようとしているかを正確に確認するには、[`ChangeTracker.GetEntriesForState`](/ja/2026/04/efcore-11-changetracker-getentriesforstate/) でダンプするのが最も手軽です。

## 参考資料

- [`KeyReadOnly` resource string](https://github.com/dotnet/efcore/blob/main/src/EFCore/Properties/CoreStrings.resx) と [`InternalEntryBase.SetPropertyModified`](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.cs)、dotnet/efcore のソースコード。
- [Support modifying the value of primary or alternate key properties, dotnet/efcore#4073](https://github.com/dotnet/efcore/issues/4073)、未解決の機能要望。
- [Keys: alternate keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys#alternate-keys)、EF Core ドキュメント。
- [Indexes: index uniqueness](https://learn.microsoft.com/en-us/ef/core/modeling/indexes#index-uniqueness)、EF Core ドキュメント。
- [Change detection and notifications](https://learn.microsoft.com/en-us/ef/core/change-tracking/change-detection)、EF Core ドキュメント。
- [`PropertyValues.SetValues`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.propertyvalues.setvalues)、Microsoft Learn。
- [ExecuteUpdate and ExecuteDelete](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete)、EF Core ドキュメント。
