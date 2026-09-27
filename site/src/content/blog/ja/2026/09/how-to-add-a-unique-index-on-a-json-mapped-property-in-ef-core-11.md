---
title: "EF Core 11 で JSON にマッピングされたプロパティに一意インデックスを追加する方法 (SQL Server と SQLite)"
description: "EF Core 11 RC 1 では、ToJson() メンバーに対する HasIndex(...).IsUnique() は一意性を強制しません。SQL Server は IsUnique を無視し、SQLite はドキュメント全体にインデックスを張ります。JSON の値を計算列として公開し、その列に一意インデックスを設定してください。"
pubDate: 2026-09-27
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "sqlite"
  - "json"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/09/how-to-add-a-unique-index-on-a-json-mapped-property-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-27
---

結論から言うと、EF Core 11 RC 1 では `ToJson()` の複合プロパティのメンバーに対するインデックスに `IsUnique()` を付けてはいけません。モデルの見た目どおりには動作しないからです。SQL Server では、EF は `CREATE JSON INDEX` を発行しますが、これには一意版が存在せず、`IsUnique()` は黙って無視されます。SQLite では、EF は `CREATE UNIQUE INDEX ... ("Contact")` を発行するため、JSON ドキュメント全体にインデックスが張られ、同じメールアドレスを持つ 2 行が受け入れられてしまいます。両方のプロバイダーで機能する修正方法は、JSON の値を計算列にマッピングされたシャドウプロパティとして公開し (SQL Server では `JSON_VALUE`、SQLite では `json_extract`)、その列に `HasIndex(...).IsUnique()` を設定し、インデックスが実際に使われるように `EF.Property` を通してクエリを実行することです。

以下の内容はすべて、.NET 11 RC 1 SDK (11.0.100-rc.1.26425.128) 上の C# 14 で、`Microsoft.EntityFrameworkCore.SqlServer` および `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128 を対象に確認しています。SQLite の結果は実際のインメモリデータベースに対して実行しました。SQL Server の DDL は `GenerateCreateScript()` とマイグレーションの SQL ジェネレーターで生成したものであり、実際に稼働している SQL Server 2025 に対しては実行していません。サーバーの挙動が重要になる箇所では、SQL Server のドキュメントを引用しています。

## 一見正しく見えるが実際にはそうではないモデル

EF Core 11 では、JSON 列にマッピングされた複合型を含め、複合型内部のプロパティに対するインデックスがサポートされるようになりました。[What's New ページ](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) では、`HasIndex("Contact.Address.City")` が SQL Server の JSON インデックスを生成する例が示されています。そこに `.IsUnique()` を追加して、制約が効くことを期待するのは自然な発想です。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128, C# 14
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public Contact Contact { get; set; } = new();
}

public class Contact
{
    public string Email { get; set; } = "";
    public Address Address { get; set; } = new();
}

public class Address { public string City { get; set; } = ""; }

protected override void OnModelCreating(ModelBuilder mb)
{
    mb.Entity<Customer>().ComplexProperty(c => c.Contact, b => b.ToJson());
    mb.Entity<Customer>().HasIndex("Contact.Email").IsUnique(); // looks fine, is not
}
```

互換性レベル 170 の SQL Server では、`GenerateCreateScript()` は次のように出力します。

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Contact] json NOT NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
CREATE JSON INDEX [IX_Customers_Contact_Email] ON [Customers]([Contact]) FOR (N'$.Email');
```

どこにも `UNIQUE` はありません。[CREATE JSON INDEX の構文](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) には、そもそも一意オプションが存在しません。JSON インデックスは `JSON_VALUE`、`JSON_PATH_EXISTS`、`JSON_CONTAINS` 述語のための検索構造であり、制約ではありません。レベル 160 でも `nvarchar(max)` 列に対して同じ `CREATE JSON INDEX` が生成されますが、これは適用時に失敗します。この罠については [EF Core 11 での native json と nvarchar(max) の比較](/ja/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/) で取り上げました。ログレベルを `Warning` にしていても、`IsUnique()` が無視されたことについて EF は何もログに出力しませんでした。

SQLite はさらに厄介です。一見うまくいったように見えるからです。

```sql
CREATE TABLE "Customers" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Customers" PRIMARY KEY AUTOINCREMENT,
    "Name" TEXT NOT NULL,
    "Contact" TEXT NOT NULL
);
CREATE UNIQUE INDEX "IX_Customers_Contact_Email" ON "Customers" ("Contact");
```

インデックス名は `Contact_Email` にちなんでいますが、キーは `"Contact"` 列全体です。同じメールアドレスで異なる都市を持つ 2 件の顧客を挿入したところ、どちらの `SaveChanges` 呼び出しも成功しました。次に、`Contact` ドキュメントがまったく同一の顧客を 2 件挿入したところ、2 件目は `SQLite Error 19: 'UNIQUE constraint failed: Customers.Contact'` で失敗しました。つまり実際に得られる制約は「2 人の顧客がバイト単位で同一の contact ドキュメントを持ってはならない」というもので、誰も望んでいないルールです。

どちらの挙動もアップストリームに報告済みです。SQL Server については [dotnet/efcore#39065](https://github.com/dotnet/efcore/issues/39065)、SQLite については [dotnet/efcore#39064](https://github.com/dotnet/efcore/issues/39064) です。Npgsql でも `jsonb` に対して同じ列全体の問題があり、[npgsql/efcore.pg#3918](https://github.com/npgsql/efcore.pg/issues/3918) で報告されています。

## JSON パスを直接一意キーにできない理由

一意インデックスには、行ごとにスカラーキーが必要です。JSON ドキュメントは 1 つの列に入った 1 つの値にすぎません。データベースが `$.Email` をスカラーとして認識できるのは、何かがそれを抽出した場合だけです。

- SQL Server では、インデックスキーを式にすることはできません。[Index JSON data](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data) に文書化されているパターンは、`JSON_VALUE` を使った計算列と、それに対する通常の B-tree インデックスの組み合わせです。`JSON_VALUE` は決定的 (deterministic) であり、[CREATE INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) では、決定的かつ精密 (precise) な計算列に対して `UNIQUE` インデックスを作成できます。
- SQLite は式に対するインデックスをサポートしており、生成列 (generated column) もサポートしています。EF Core には式インデックス用の API はありませんが、`HasComputedColumnSql` があり、SQLite ではこれが生成列に変換されます。

計算列は、両方のプロバイダーがサポートし、かつ EF Core がモデル化・マイグレーション・読み戻しできる唯一の形です。これが修正方法になります。

## 修正方法: 一意インデックス付きの計算列

1. 一意にしたい値のためのシャドウプロパティを追加し、JSON 列からその値を抽出する計算列にマッピングします。
2. JSON パスではなく、そのシャドウプロパティに `HasIndex(...).IsUnique()` を設定します。
3. SQL Server では、EF がデフォルトの `IS NOT NULL` フィルターをインデックスに追加しないようにします (詳細は後述)。
4. マイグレーションを追加し、適用前に既存の重複を確認したうえで、ルックアップがインデックスを使うように `EF.Property` を通してクエリを実行します。

両方のプロバイダーに共通するモデル構成は次のとおりです。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128, C# 14
protected override void OnModelCreating(ModelBuilder mb)
{
    var customer = mb.Entity<Customer>();
    customer.ComplexProperty(c => c.Contact, b => b.ToJson());

    var emailSql = Database.IsSqlServer()
        ? "CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320))"
        : "json_extract(\"Contact\", '$.Email')";

    customer.Property<string>("ContactEmail")
        .HasMaxLength(320)
        .HasComputedColumnSql(emailSql, stored: false)
        .IsRequired();

    customer.HasIndex("ContactEmail").IsUnique();
}
```

SQL Server、レベル 170 の場合 (レベル 160 も、`[Contact]` が `nvarchar(max)` になる点を除けば同一です)。

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ContactEmail] AS CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320)),
    [Contact] json NOT NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]);
```

SQLite の場合。

```sql
CREATE TABLE "Customers" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Customers" PRIMARY KEY AUTOINCREMENT,
    "Name" TEXT NOT NULL,
    "ContactEmail" AS (json_extract("Contact", '$.Email')),
    "Contact" TEXT NOT NULL
);
CREATE UNIQUE INDEX "IX_Customers_ContactEmail" ON "Customers" ("ContactEmail");
```

SQLite でこのモデルを使うと、2 件目の `a@x.com` を持つ顧客の `SaveChanges` は、`SQLite Error 19: 'UNIQUE constraint failed: Customers.ContactEmail'` をラップした `DbUpdateException` で失敗します。`ExecuteUpdate` も同様です。別の行に対する `SetProperty(x => x.Contact.Email, "a@x.com")` も同じエラーで失敗しました。生成列が更新後のドキュメントから再計算されるためです。`SaveChanges` の後、EF は計算された値をシャドウプロパティにも読み戻します (`Entry(e).Property("ContactEmail").CurrentValue` は `a@x.com` を返しました)。計算列は `ValueGenerated.OnAddOrUpdate` であるためです。

SQL Server では、重複はエラー番号 2601 の `SqlException` ("Cannot insert duplicate key row") として現れます。これを検証エラーとして扱いたい場合は、`DbUpdateException` を捕捉して内部例外を調べてください。

このコードでのいくつかの選択には意味があります。

- **`nvarchar(320)` への `CAST`。** `JSON_VALUE` は `nvarchar(4000)` を返しますが、[Index JSON data のページ](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data) は、インデックスキーが 1700 バイトを超えると挿入が失敗すると警告しています。320 文字はメールアドレスの実用上の最大長であり、`nvarchar` としては 640 バイトです。値に収まる最も狭い型にキャストしてください。数値の場合は `int` や `bigint` にキャストします。
- **`stored: false`。** どちらのプロバイダーでも、インデックスを張るために値を永続化する必要はありません。SQL Server では、決定的かつ精密であれば、永続化されていない計算列にもインデックスを張れます。SQLite では仮想 (virtual) の生成列にインデックスを張れ、後から `ALTER TABLE` で追加できるのも仮想列だけです。
- **`IsRequired()`。** これは列そのものについてではありません。EF がインデックスにフィルターを追加するのを防ぐためのもので、これは次のセクションで説明します。

## SQL Server のフィルターの罠

シャドウプロパティを省略可能 (optional) のままにしておくと、EF の SQL Server プロバイダーは null 許容列上のすべての一意インデックスに対して行っているのと同じことを行い、フィルターを追加します。

```sql
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]) WHERE [ContactEmail] IS NOT NULL;
```

この文は実行できません。[CREATE INDEX のリファレンス](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) には、フィルター述語は「計算列を参照できない」と明記されています。EF は何の警告もなくこれを生成するため、`dotnet ef database update` が失敗して初めて気づくことになります。

回避策は 2 つあり、どちらも生成される SQL から `WHERE` 句が消えることを確認済みです。

```csharp
// .NET 11 RC 1, EF Core 11 - either mark the value required...
customer.Property<string>("ContactEmail").IsRequired();

// ...or keep it optional and remove the filter explicitly
customer.HasIndex("ContactEmail").IsUnique().HasFilter(null);
```

フィルターがないと、SQL Server は一意インデックス内で NULL を等しいものとして扱うため、メールアドレスを持たない行は 1 件しか許されません。JSON プロパティが本当に省略可能である場合は、行ごとの値を式に組み込んで、メールアドレスが欠けている行同士が衝突しないようにしてください。例えば `ISNULL(CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320)), N'#' + CAST([Id] AS nvarchar(11)))` のようにします。これは決定的かつ精密なので、引き続きインデックス可能です。これは実サーバーに対しては実行していません。SQLite にはこの問題はありません。SQLite の一意インデックスでは NULL は常に別個のものとして扱われ、EF もそこにはフィルターを追加しません。

## 列を通してクエリしないとインデックスは使われない

一意インデックスは、クエリの書き方に関係なくルールを強制します。しかし、それをルックアップに使えるかどうかは別問題です。JSON パスに対する素朴な LINQ フィルターは、計算列を参照しません。

```csharp
// .NET 11 RC 1, EF Core 11
db.Customers.Where(c => c.Contact.Email == email);
// SQL Server 170: WHERE JSON_VALUE([c].[Contact], '$.Email' RETURNING nvarchar(max)) = N'a@x.com'
// SQLite:         WHERE "c"."Contact" ->> 'Email' = 'a@x.com'
```

SQL Server は、クエリ式が計算列と完全に同じ場合に限り、それらを一致させることができます。`JSON_VALUE(... RETURNING nvarchar(max))` は `CAST(JSON_VALUE(...) AS nvarchar(320))` とは同じではありません。SQLite に至っては、生成列の式をまったく一致させません。sqlite3 3.50.6 の CLI では、`Contact ->> 'Email'` と手書きの `json_extract(Contact, '$.Email')` のどちらでも `EXPLAIN QUERY PLAN` は `SCAN c` を返し、列参照を使った場合のみ `SEARCH c USING INDEX IX_Customers_ContactEmail (ContactEmail=?)` が返されました。

そのため、シャドウプロパティに対してフィルターしてください。

```csharp
// .NET 11 RC 1, EF Core 11 - produces WHERE [c].[ContactEmail] = @email on both providers
var existing = await db.Customers
    .Where(c => EF.Property<string>(c, "ContactEmail") == email)
    .FirstOrDefaultAsync();
```

`EF.Property` の文字列指定が気になる場合は、代わりに同じ `HasComputedColumnSql` を使って実際の読み取り専用プロパティ (`public string ContactEmail { get; private set; } = "";`) をマッピングしてください。EF が保存のたびにこれを設定してくれるので、クエリは通常のラムダで書けます。

## 既存データを持つテーブルに追加する

EF がスキャフォールドするマイグレーションは、各プロバイダーで 2 つの文になります。

```sql
-- SQL Server
ALTER TABLE [Customers] ADD [ContactEmail] AS CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320));
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]);

-- SQLite
ALTER TABLE "Customers" ADD "ContactEmail" AS (json_extract("Contact", '$.Email'));
CREATE UNIQUE INDEX "IX_Customers_ContactEmail" ON "Customers" ("ContactEmail");
```

`ALTER TABLE` は重複があっても成功します。しかし `CREATE UNIQUE INDEX` はそうではありません。既存の `a@x.com` の行が 2 件ある SQLite では、`UNIQUE constraint failed: Customers.ContactEmail (19)` で失敗しました。まず問題の行を見つけてください。EF は、新しい列を使わなくても JSON パスでのグループ化を変換できます。

```csharp
// .NET 11 RC 1, EF Core 11 - run before applying the migration
var duplicates = await db.Customers
    .GroupBy(c => c.Contact.Email)
    .Where(g => g.Count() > 1)
    .Select(g => new { Email = g.Key, Count = g.Count() })
    .ToListAsync();
```

それらの行を整理してから、マイグレーションを適用してください。本番環境へのロールアウトでは、アプリ自身にマイグレーションさせるのではなく、SQL を生成してレビューすることをお勧めします。これについては [マイグレーションバンドルのワークフロー](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) で解説しています。チームでインデックスの命名規則を強制している場合、計算列も他のプロパティと同様に命名されるため、[EF Core 11 でのキーとインデックスのカスタム命名規則](/ja/2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11/) のルールが、特別扱いなしで `IX_Customers_ContactEmail` にも適用されます。

## 出荷前に知っておくべき注意点

**大文字小文字の区別はプロバイダーによって異なります。** SQLite では `a@x.com` と `A@X.com` の両方を挿入でき、どちらも受け入れられました。SQLite はデフォルトで `BINARY` 照合順序を使って比較するためです。SQL Server では、一意性は元の列の照合順序に従い、ほとんどのデータベースでは大文字小文字を区別しないため、同じペアは衝突します。「1 つのメールアドレスにつき 1 アカウント」というルールなら、正規化してください。メールアドレスを小文字で保存するか、SQLite では `lower(json_extract("Contact", '$.Email'))` を使って両プロバイダーの挙動を揃えます。テストと本番でプロバイダーが異なると、まさにここで問題が起きます。これは、データルールのテストにおいて [WebApplicationFactory と Testcontainers の比較](/ja/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) が重要になる理由の一つです。

**JSON プロパティ名は SQL の一部です。** `$.Email` は、EF がドキュメントに書き込む内容と一致していなければなりません。CLR プロパティ名を変更したり、`HasJsonPropertyName("email")` を設定したりした場合は、同じマイグレーションで計算列の SQL も更新してください。パスは不透明な文字列であるため、EF が自動的に更新することはありません。不一致があってもエラーにはなりません。すべての行が NULL になり、「一意」のルールは何も強制しなくなります。

**複合コレクションは対象外です。** 一意インデックスには行ごとに 1 つの値が必要です。「`Items[]` 全体で SKU が一意でなければならない」という要件には、JSON 列ではなく子テーブルが必要です。EF Core 11 は SQL Server 上でルックアップ用に `Items[].Sku` にインデックスを張れますが、それは JSON インデックスであって制約ではありません。

**将来の `IsUnique()` に期待しないでください。** SQL Server 向けの修正 [dotnet/efcore#39090](https://github.com/dotnet/efcore/pull/39090) は、RC 1 のリリース後、2026-09-26 に `release/11.0` にマージされました。しかし、これは JSON インデックスを一意にするものではありません。モデルの検証を `JSON index '{index}' on entity type '{entityType}' was configured with the '{option}' option, which is not supported on JSON indexes.` というエラーで失敗させるようにするものです。黙って無視されていたものが大きなエラーになるという点では改善ですが、答えは依然として計算列です。この記事を書いた時点で、SQLite 側の issue はまだオープンでした。

**計算列には通常の SQL Server の SET オプションが必要です。** 計算列に対するインデックスは、テーブルを変更するセッションに対して `QUOTED_IDENTIFIER ON` や `ANSI_NULLS ON` のような設定を要求します。SqlClient のデフォルト設定はこれらを満たしていますが、これらをオフにするレガシーなスクリプトやツールは、`Customers` への書き込み時にエラーになります。

まだ JSON マッピングを決めていない場合は、[EF Core 11 で JSON 列をマッピングしてクエリする方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) で `ComplexProperty(...).ToJson()` を一通り解説しています。この記事の内容は、そのマッピングを前提としています。

## 参考資料

- [EF Core 11 の新機能: 複合型プロパティのキーとインデックス、JSON インデックス](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [CREATE JSON INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql)
- [JSON データへのインデックス作成 (JSON_VALUE を使った計算列)](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data)
- [CREATE INDEX (Transact-SQL): フィルター選択されたインデックスと計算列のルール](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql)
- [SQLite の生成列](https://www.sqlite.org/gencol.html)
- [dotnet/efcore#39065: IsUnique() on an index over a JSON-mapped member is silently dropped](https://github.com/dotnet/efcore/issues/39065)
- [dotnet/efcore#39064: SQLite index on a JSON-mapped member indexes the whole column](https://github.com/dotnet/efcore/issues/39064)
- [dotnet/efcore#39090: Validate unsupported SQL Server JSON index options](https://github.com/dotnet/efcore/pull/39090)
- [npgsql/efcore.pg#3918: index on a JSON-mapped member indexes the whole jsonb column](https://github.com/npgsql/efcore.pg/issues/3918)
</content>
