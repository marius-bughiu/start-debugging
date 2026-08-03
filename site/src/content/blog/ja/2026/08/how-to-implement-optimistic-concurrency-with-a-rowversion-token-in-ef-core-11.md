---
title: "EF Core 11 で rowversion トークンを使って楽観的同時実行制御を実装する方法"
description: "EF Core 11 に rowversion の同時実行トークンを追加します。[Timestamp] と IsRowVersion による設定、EF が実際に発行する SQL、DbUpdateConcurrencyException の捕捉、データベース優先 vs クライアント優先 vs マージ、ETag を使った切断された API、そして保護を無言で無効化する 5 つの落とし穴。"
pubDate: 2026-08-03
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "rowversion"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "ja"
translationOf: "2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-03
---

短い答えです。エンティティに `byte[]` のプロパティを追加し、`[Timestamp]` を付ける（または `OnModelCreating` で `.IsRowVersion()` を呼ぶ）と、EF Core 11 はそれを SQL Server の `rowversion` 列にマッピングし、そのエンティティに対して生成するすべての UPDATE と DELETE に `AND [RowVersion] = @original` を追加します。その間に他の誰かが行を変更していた場合、そのステートメントは 0 行にしか影響せず、`SaveChangesAsync` が `DbUpdateConcurrencyException` をスローするので、それを捕捉して解決します。機能全体としては設定が 6 行ほどです。難しいのは、エラーも出さずにうっかりこれを無効化してしまう 5 つの方法のほうです。

この記事では、設定手順、正確な SQL と例外メッセージ、3 つの解決戦略、多くのチュートリアルが飛ばす切断された Web API の往復、そして何も保護しないトークンだけが残る落とし穴を扱います。

以下の内容をどう検証したかについての注記です。EF Core 11 は .NET 11 ランタイムを必要としますが、このマシンにある SDK は .NET 10.0.201 のみなので、実行可能な実験は `Microsoft.EntityFrameworkCore` 10.0.10 と SQLite、加えて SQL Server プロバイダーの DDL ジェネレーター（サーバーなしでオフラインで動作します）で行いました。同時実行トークンの API と生成される SQL の形は EF Core 8 から 11 まで変わっていません。[EF Core 11 のリリースノート](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) には、同時実行トークン、`SaveChanges` の競合検出、`DbUpdateConcurrencyException` に関する変更は挙げられていません。EF Core 11 固有の点はその都度明記します。

## rowversion 列とは実際には何なのか

`rowversion` は SQL Server のデータ型であり、EF Core の概念ではありません。[rowversion のドキュメント](https://learn.microsoft.com/en-us/sql/t-sql/data-types/rowversion-transact-sql) によれば、これは自動生成される一意なバイナリ値 8 バイトです。同時実行制御の作業では 3 つの性質が重要です。

- **これはカウンターであって時計ではありません。** 日付も時刻も保持しません。各データベースは 1 つのカウンターを持ち、`rowversion` 列を含むいずれかのテーブルへの挿入または更新のたびに増加します。異なるテーブルの 2 行が同じ値を共有することはありませんが、2 つの値を引き算して経過時間を得ることはできません。
- **1 つのテーブルに 1 列だけです。** だからこそ rowversion トークンは行全体を守るのであって、列の一部だけを守ることはありません。
- **どんな UPDATE でも増加します。何も変えない UPDATE でもです。** ドキュメントは明確です。すでに入っている値を列に代入することも更新として数えられ、バージョンが増加します。何も変更しない「保存」でも、他のすべての読み手のトークンは無効になります。

`timestamp` は同じ型の非推奨の別名です。DDL では `rowversion` を使ってください。紛らわしいことに、EF Core の属性は名称変更より前からあるため、いまだに `[Timestamp]` という名前です。

## 4 ステップの設定

1. **エンティティに `byte[]` のプロパティを追加します。** SQL Server プロバイダーが `rowversion` にマッピングするには、CLR 型が `byte[]` である必要があります。名前は自由ですが、`RowVersion` や `Version` が一般的です。
2. **行バージョンとしてマークします。** データ注釈の `[Timestamp]` か、`OnModelCreating` での `.Property(p => p.RowVersion).IsRowVersion()` のどちらかです。両者は等価です。
3. **マイグレーションを追加して適用します。** EF は `[RowVersion] rowversion NOT NULL` を生成し、SQL Server は既存の各行を次回の更新時に埋めます。
4. **そのエンティティを保存するすべての呼び出し箇所で `DbUpdateConcurrencyException` を捕捉します。** このステップがなければ、無言の更新消失を 500 応答に置き換えただけです。ましではありますが、大差はありません。

エンティティを両方の書き方で示します。

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
public class Product
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public decimal Price { get; set; }

    [Timestamp]
    public byte[] RowVersion { get; set; } = default!;
}
```

```csharp
// Fluent equivalent, no attribute needed on the entity
protected override void OnModelCreating(ModelBuilder modelBuilder)
    => modelBuilder.Entity<Product>()
        .Property(p => p.RowVersion)
        .IsRowVersion();
```

このモデルに対して SQL Server プロバイダーの作成スクリプトジェネレーターを実行すると、次が得られます。

```sql
CREATE TABLE [Products] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Price] decimal(18,2) NOT NULL,
    [RowVersion] rowversion NOT NULL,
    CONSTRAINT [PK_Products] PRIMARY KEY ([Id])
);
```

興味深いのは DDL ではなく、EF がそこから導出するモデルのメタデータです。この列の `IProperty` をダンプすると `colType=rowversion`、`IsConcurrencyToken=True`、`ValueGenerated=OnAddOrUpdate` が得られます。覚えておくべきは最後のフラグです。EF Core はこの列に値を書き込むことは決してありません。INSERT と UPDATE から除外し、あとで新しい値を読み戻します。この列は完全にデータベースの所有物です。

## EF Core が発行する SQL と、失敗時の例外

プロパティが同時実行トークンになると、EF がそのエンティティのために生成するすべての UPDATE は、キーと並べて元の値を `WHERE` 句に持ちます。アプリケーション管理のトークンを使った SQLite では、形はまさに次のとおりです（`RelationalEventId.CommandExecuted` でフィルターした `LogTo` で取得）。

```sql
UPDATE "Products" SET "Price" = @p0, "Version" = @p1
WHERE "Id" = @p2 AND "Version" = @p3
RETURNING 1;
```

SQL Server では、列が `ValueGenerated.OnAddOrUpdate` であるため、ステートメントは再生成された `rowversion` を読み戻す必要もあります。[Razor Pages の同時実行チュートリアル](https://learn.microsoft.com/en-us/aspnet/core/data/ef-rp/concurrency) に記載されている形は、ガードされた UPDATE と `@@ROWCOUNT` を条件にした SELECT を組み合わせます。

```sql
SET NOCOUNT ON;
UPDATE [Products] SET [Price] = @p0
WHERE [Id] = @p1 AND [RowVersion] = @p2;
SELECT [RowVersion]
FROM [Products]
WHERE @@ROWCOUNT = 1 AND [Id] = @p1;
```

ステートメントの正確な形は EF Core のバージョンやプロバイダーによって変わってきましたし、今後も変わります。安定しているのは、そしてテストで検証すべきなのは、セマンティクスです。つまりトークンが `WHERE` に現れること、そして 0 行という結果が例外に変換されることです。

読み込んだあとに他の誰かが行を変更していれば、述語は何にも一致せず、0 行が返り、EF は例外をスローします。このメッセージはログで探すことになるので、覚えておく価値があります。

```text
The database operation was expected to affect 1 row(s), but actually affected
0 row(s); data may have been modified or deleted since entities were loaded.
```

発生条件について誤解されがちな点が 2 つあります。1 つ目は、更新*と*削除ではスローされますが、挿入ではまず発生しないという点です。重複挿入では代わりにプロバイダー固有の一意制約違反例外が出ます。2 つ目は、「0 行に影響」は「誰かが変更した」と「誰かが削除した」を区別しないという点です。それは解決処理の中で判別する必要があります。

上記の SQL がアプリケーションの送っているものと違って見えるなら、実際に何を送っているかを知る最短の方法は、[EF Core 11 が生成する SQL をログに出す](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) ことと、`WHERE` 句を直接読むことです。`AND [RowVersion] = ...` が欠けていれば、想定しているパスにトークンが設定されていないということです。

## 競合の解決：3 つの戦略と 1 つのループ

`DbUpdateConcurrencyException` は `Entries` を公開します。これはコマンドが想定と異なる行数を返した `EntityEntry` オブジェクトのリストです。各エントリからは 3 種類の値セットが得られます。

- `CurrentValues`：書き込もうとした値。
- `OriginalValues`：編集前に読み込んだ値。古いトークンはここにあります。
- `GetDatabaseValuesAsync()`：いまデータベースにある値。新しくクエリされます。

どの解決戦略も、この 3 つを組み合わせる規則であり、その後で `OriginalValues` を更新して、再試行の `WHERE` 句が現在のトークンを使うようにします。

**データベース優先** は最も単純で、人間が見ている画面に対する既定として正しい選択です。試行を破棄し、再読み込みし、ユーザーに知らせます。`entry.ReloadAsync()` が 1 回の呼び出しで行います。

**クライアント優先** は、その間に入った変更を上書きします。自分の書き込みが権威を持つ場合（管理者による上書き、正規イベントの再適用）にのみ正しく、それ以外の場所では本物の誤りです。

```csharp
// .NET 11, C# 14, EF Core 11
catch (DbUpdateConcurrencyException ex)
{
    foreach (var entry in ex.Entries)
    {
        var databaseValues = await entry.GetDatabaseValuesAsync();
        if (databaseValues is null)
        {
            // The row is gone. There is nothing to overwrite.
            throw new InvalidOperationException("Product was deleted by another user.");
        }

        // Keep CurrentValues as-is, but adopt the database's token so the
        // retried UPDATE targets the row as it exists now.
        entry.OriginalValues.SetValues(databaseValues);
    }

    await context.SaveChangesAsync();
}
```

**マージ** は、エンティティが独立したフィールドを持つ場合に書く価値のある版です。自分が触っていないプロパティにはデータベースの値を採り、触ったものには自分の値を残し、本当に重なった場合にのみエスカレートします。

```csharp
// .NET 11, C# 14, EF Core 11
var saved = false;
while (!saved)
{
    try
    {
        await context.SaveChangesAsync();
        saved = true;
    }
    catch (DbUpdateConcurrencyException ex)
    {
        foreach (var entry in ex.Entries)
        {
            if (entry.Entity is not Product)
            {
                throw new NotSupportedException(
                    $"No conflict policy for {entry.Metadata.Name}.");
            }

            var proposed = entry.CurrentValues;
            var database = await entry.GetDatabaseValuesAsync()
                ?? throw new InvalidOperationException("Row was deleted.");
            var original = entry.OriginalValues;

            foreach (var property in proposed.Properties)
            {
                // Skip the token itself: it is byte[], so Equals compares
                // references, and it is refreshed wholesale below anyway.
                if (property.IsConcurrencyToken) continue;

                var mine = proposed[property];
                var theirs = database[property];
                var wasLoaded = original[property];

                // I did not touch this column: take theirs.
                if (Equals(mine, wasLoaded))
                {
                    proposed[property] = theirs;
                }
                // Both of us changed it to different values: real conflict.
                else if (!Equals(theirs, wasLoaded) && !Equals(mine, theirs))
                {
                    throw new InvalidOperationException(
                        $"Conflicting edits to {property.Name}.");
                }
            }

            entry.OriginalValues.SetValues(database);
        }
    }
}
```

この `while (!saved)` ループは [EF Core の同時実行ドキュメント](https://learn.microsoft.com/en-us/ef/core/saving/concurrency) が推奨する形であり、本当にループです。再試行が 2 度目の競争にも負けることがあります。本番では試行回数の上限を設けてください。競合の激しい行に対する無制限の再試行はライブロックになります。

注意すべき相互作用が 1 つあります。`EnableRetryOnFailure` を有効にしている場合、再試行は `SqlServerRetryingExecutionStrategy` の内側で起こるため、このループを手動の `BeginTransaction` で包むと、[実行戦略はユーザー開始のトランザクションをサポートしません](/ja/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/) で説明したエラーで失敗します。代わりに作業単位全体を `strategy.ExecuteAsync(...)` で囲んでください。

## 切断された往復。ここでたいてい失敗します

上記の単一コンテキストの例は、あなたの API がやっていることではありません。API はあるリクエストで商品を読み込み、ブラウザーに渡し、10 分後にまったく別の `DbContext` で編集を受け取ります。トークンはこの旅を生き延びなければなりません。

`byte[]` は `System.Text.Json` で base64 にシリアライズされるので、DTO 経由で渡すのに特別な扱いは要りません。慣用的な HTTP の形は ETag です。GET では base64 のトークンを `ETag` レスポンスヘッダーとして返し、PUT では `If-Match` として要求し、一致しなければ `412 Precondition Failed` を返します。

書き込み側で決定的に重要な行は、`OriginalValue` を明示的に設定することです。クライアントが読んだ時点で行がどうだったかを EF は知りようがないので、こちらから教える必要があります。

```csharp
// .NET 11, C# 14, EF Core 11
app.MapPut("/products/{id:int}", async (
    int id, ProductDto dto, [FromHeader(Name = "If-Match")] string? ifMatch,
    AppDbContext db) =>
{
    if (string.IsNullOrEmpty(ifMatch)) return Results.BadRequest("If-Match required.");

    var product = await db.Products.FindAsync(id);
    if (product is null) return Results.NotFound();

    product.Name = dto.Name;
    product.Price = dto.Price;

    // Overwrite the token EF loaded with the one the client actually saw.
    db.Entry(product).Property(p => p.RowVersion).OriginalValue =
        Convert.FromBase64String(ifMatch.Trim('"'));

    try
    {
        await db.SaveChangesAsync();
        return Results.Ok(new { eTag = Convert.ToBase64String(product.RowVersion) });
    }
    catch (DbUpdateConcurrencyException)
    {
        return Results.StatusCode(StatusCodes.Status412PreconditionFailed);
    }
});
```

ここでは意図的に先に行をクエリしています。`Attach` と `EntityState.Modified` を使えばクエリを省いて往復を 1 回減らせますが、その場合は変更の有無にかかわらずすべての列が書き込まれます。トークンに関して両方のパスが同一に振る舞うことは検証済みです。SQLite での再現では、アタッチしただけでクエリしていないエンティティに `OriginalValue` を設定しても、先にクエリするパスと同じトークンでガードされた `WHERE` 句が生成され、問題なく保存されました。

## 同時実行トークンを無言で無効化する 5 つの方法

**元のトークンを持ち回るのを忘れる。** 既定値または空のトークンを持つ切断されたエンティティが届き、`context.Update(entity)` を呼ぶと、EF は*オブジェクト上の*値を元の値として扱います。発行される SQL は `WHERE "Id" = @p3 AND "Version" = @p4` となり、`@p4` はすべてゼロで何にも一致せず、あらゆる保存が `DbUpdateConcurrencyException` をスローします。これはまさに EF Core 10.0.10 で再現しました。この失敗の仕方はうるさく、それは幸運です。逆の間違いは無言だからです。

**rowversion を持たないプロバイダーを使う。** こちらはエラーがまったく出ません。SQLite では `byte[]` への `[Timestamp]` は `BLOB NULL` 列を生成し、`IsConcurrencyToken=True`、`ValueGenerated=OnAddOrUpdate` とマークされます。したがって EF は決して書き込まず、SQLite も決して生成せず、値は永遠に `null` のままです。生成される UPDATE は次のように退化します。

```sql
UPDATE "Products" SET "Price" = @p0
WHERE "Id" = @p1 AND "RowVersion" IS NULL
RETURNING "RowVersion";
```

`IS NULL` は毎回一致します。トークンの形をした列と、ゼロの保護と、警告なしが手に入ります。`Microsoft.EntityFrameworkCore.Sqlite` を使い EF Core 10.0.10 で検証しました。統合テストが SQLite で走り、本番が SQL Server で走っているなら、あなたの同時実行テストは誤った理由で通っています。

ネイティブの自動更新列がないプロバイダー向けの対処は、アプリケーション管理のトークンです。`[ConcurrencyCheck]`（または `.IsConcurrencyToken()`）を付けた `Guid` を、保存のたびに自分で代入します。PostgreSQL はどちらも不要な例外です。Npgsql は `[Timestamp]` を付けた、あるいは `.IsRowVersion()` で構成した `uint` プロパティをシステム列 `xmin` にマッピングし、エンジンがそれを自動更新します。

**`[Timestamp]` を誤った CLR 型に付ける。** EF Core はモデル構築時にこれを検証しません。`[Timestamp]` を `long` に付けたところ、SQL Server プロバイダーは平然と `[RowVersion] bigint NOT NULL` を、`IsConcurrencyToken=True` と `ValueGenerated=OnAddOrUpdate` 付きで生成しました。SQL Server はただの `bigint` 列を維持しませんし、EF は書き込まないよう指示されているので、この値は何によっても動きません。本物の `rowversion` 型にマッピングされるのは `byte[]` だけです。

**`ExecuteUpdate` や `ExecuteDelete` で書き込む。** これらは変更追跡を完全にバイパスし、それとともに同時実行チェックもバイパスします。発行される SQL にはあなたの述語しか含まれません。

```sql
UPDATE "Products" AS "p"
SET "Price" = ef_add("p"."Price", '1.0')
WHERE "p"."Name" = 'B'
```

トークンなし、例外なし、影響 1 行です。一括処理のパスで楽観的同時実行制御が必要なら、自分で組む必要があります。トークンを `Where` に入れ、返された影響行数を期待値と比較します。このトレードオフと、どの書き込みパスがいつ正しいかは [ExecuteUpdate vs エンティティを読み込んで SaveChanges](/ja/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) の主題です。

**C# で `==` によりトークンを比較する。** `byte[]` は参照等価性を使います。同じバイト列を持つ 2 つの配列は等しくありません。アプリケーションコードでトークンを確認する必要があるときは `SequenceEqual` を使うか、base64 文字列を比較してください。EF 自身は SQL 側で比較するので、これが問題になるのは自分の検証ロジックの中だけです。

## 行単位のトークンが粗すぎるとき

`rowversion` は行全体を保護します。同じレコードの本当に独立したフィールドを編集する 2 人のユーザー（一方は説明文の誤字を直し、もう一方は在庫数を調整する）は、実際には何も競合していないのに衝突します。アクセスの集中するレコードでは、これは偽の 412 の連続になります。

出口は 2 つあります。上記のマージ戦略を使い、偽の競合を自動的に解決して本当の重なりだけを表面化させること。あるいは、自分が気にするプロパティが変わったときにだけ再生成するアプリケーション管理のトークンに降りることです。後者は [監査のための EF Core 11 インターセプター](/ja/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) で説明した種類の `SaveChanges` インターセプターに集約できます。2 つ目の選択肢の代償は、「この変更は意味があるのか」という判断を、追加するすべてのプロパティについて永久に自分で背負うことです。

より上位の代替はトランザクション分離レベルです。SQL Server のスナップショット分離、あるいは PostgreSQL の repeatable read は、あなたのトランザクションの書き込みがコミット済みのものと衝突したときに、モデルにトークンを置かずともシリアライズエラーを発生させます。こちらのほうが単純ですが、人間がループに入った瞬間に誤った道具になります。ユーザーが考えている間じゅうトランザクションを開いたままにしなければならないからです。同時実行トークンは、まさに「トランザクション」が HTTP の往復とコーヒーブレイクをまたげるように存在しています。

## 関連記事

- [ExecuteUpdate vs エンティティを読み込んで SaveChanges（EF Core）](/ja/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [EF Core 11 が生成する SQL をログに出す方法](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [監査のために EF Core 11 のインターセプターを使う方法](/ja/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [Fix: 実行戦略はユーザー開始のトランザクションをサポートしません](/ja/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Fix: 同じキー値を持つ別のインスタンスが既に追跡されているため、このエンティティ型のインスタンスは追跡できません](/ja/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## 参考資料

- [Handling concurrency conflicts](https://learn.microsoft.com/en-us/ef/core/saving/concurrency)（Microsoft Learn）：トークンのセマンティクス、3 つの値セット、再試行ループについて。
- [rowversion (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/rowversion-transact-sql)：8 バイトのカウンター、テーブルにつき 1 つの規則、何も変えない UPDATE の挙動、`timestamp` の非推奨化について。
- [Disconnected entities](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities)：`Update` と `Attach` の違い、`CurrentValues.SetValues` について。
- [What's new in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)：EF11 が .NET 11 ランタイムを必要とすること、同時実行トークンの変更が挙げられていないことの確認。
- [Npgsql concurrency tokens](https://www.npgsql.org/efcore/modeling/concurrency.html)：PostgreSQL での `xmin` マッピングについて。
