---
title: "EF Core 11 のマイグレーションでデータを失わずにテーブル名を変更する方法"
description: "テーブル名を変更した場合、EF Core は RenameTable を生成しますが、エンティティクラスの名前を変更した場合は DropTable と CreateTable を生成します。この2つを見分ける方法、クラス名変更のコストをゼロにする ToTable のテクニック、そしてデータを黙って入れ替えてしまう列名変更のバグを解説します。"
pubDate: 2026-08-09
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "ja"
translationOf: "2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data"
translatedBy: "claude"
translationDate: 2026-08-09
---

短い答えです。`ToTable("Clients")` で *テーブル名* だけを変更し、エンティティクラスには手を触れなければ、EF Core は正しい `migrationBuilder.RenameTable(...)` を生成し、データは一切失われません。*エンティティクラス* を `Customer` から `Client` に変更すると、EF Core は `DropTable("Customers")` と `CreateTable("Clients")` を生成し、そのマイグレーションを適用すると全行が消えます。対策は、この2つを決して同時に行わないことです。クラス名を変更するのと同じコミットで `ToTable("Customers")` によって古いテーブル名を固定します。これでモデルの変更はゼロになります。そのうえで、別のマイグレーションでテーブル名を変更します。

この記事では、両方のケースで生成される正確な内容、それぞれが生成する T-SQL、EF Core がテーブル名変更にこっそり紛れ込ませる主キーの再構築、そしてマイグレーションが問題なく適用された後に牙をむく3つの落とし穴を扱います。

以下の内容はすべて EF Core 10.0.10 と .NET SDK 10.0.201 上で、SQL Server プロバイダーの DDL ジェネレーターに対して生成して計測しました。EF Core 11 は .NET 11 ランタイムを必要としますが、このマシンには入っていないため、そちらでは実行できていません。`MigrationsModelDiffer` の挙動と `RenameTable` API は EF Core 8、9、10、11 を通じて変わっていません。EF Core 11 に固有の項目である `dotnet ef database update --add` コマンドについては後述しますが、これは計測ではなくドキュメントに基づくものです。

## EF Core がまったく別物として扱う2種類の名前変更

`Customer` と、それを参照する `Order`、そして一意インデックスを持つモデルから始めます。

```csharp
// .NET 11, C# 14, EF Core 11
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
    public List<Order> Orders { get; set; } = new();
}

protected override void OnModelCreating(ModelBuilder b)
{
    b.Entity<Customer>().Property(c => c.Name).HasMaxLength(200);
    b.Entity<Customer>().HasIndex(c => c.Email).IsUnique();
}
```

ここでクラス名を `Client` に変更し、`DbSet<Customer> Customers` プロパティを `Clients` に変更し、`Order.CustomerId` を `Order.ClientId` に直すのは IDE に任せます。`dotnet ef migrations add RenameCustomerToClient` を実行すると、次の内容が得られます。

```csharp
// scaffolded by EF Core 10.0.10 after renaming the entity class
migrationBuilder.DropForeignKey(name: "FK_Orders_Customers_CustomerId", table: "Orders");

migrationBuilder.DropTable(name: "Customers");   // <- every row, gone

migrationBuilder.RenameColumn(name: "CustomerId", table: "Orders", newName: "ClientId");
migrationBuilder.RenameIndex(name: "IX_Orders_CustomerId", table: "Orders", newName: "IX_Orders_ClientId");

migrationBuilder.CreateTable(
    name: "Clients",
    columns: table => new
    {
        Id = table.Column<int>(type: "int", nullable: false)
            .Annotation("SqlServer:Identity", "1, 1"),
        Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
        Email = table.Column<string>(type: "nvarchar(450)", nullable: false)
    },
    constraints: table => { table.PrimaryKey("PK_Clients", x => x.Id); });
```

この非対称性に注目してください。ここにすべてが表れています。`Orders` テーブルは名前が変わらなかったため、差分エンジンは以前の自分自身と対応付けることができ、外部キー列に対して正しく `RenameColumn` を出力しました。`Customers` テーブルは名前が変わってしまったため、差分エンジンは1つのテーブルが消えて無関係なテーブルが現れたと判断し、drop に続けて create を出力しました。

EF Core はここできちんと警告します。ただし CLI が出すのは、読み飛ばしやすい1行です。

```
An operation was scaffolded that may result in the loss of data. Please review the migration for accuracy.
```

次に、もう一方の名前変更を試します。クラス名は `Customer` のままにして、テーブル名だけを変更します。

```csharp
// EF Core 11, OnModelCreating
b.Entity<Customer>().ToTable("Clients");
```

これを生成すると、全行を保持するマイグレーションが得られ、警告は一切表示されません。

```csharp
// scaffolded by EF Core 10.0.10 after ToTable("Clients")
migrationBuilder.DropForeignKey(name: "FK_Orders_Customers_CustomerId", table: "Orders");
migrationBuilder.DropPrimaryKey(name: "PK_Customers", table: "Customers");

migrationBuilder.RenameTable(name: "Customers", newName: "Clients");
migrationBuilder.RenameIndex(name: "IX_Customers_Email", table: "Clients", newName: "IX_Clients_Email");

migrationBuilder.AddPrimaryKey(name: "PK_Clients", table: "Clients", column: "Id");
migrationBuilder.AddForeignKey(
    name: "FK_Orders_Clients_CustomerId", table: "Orders", column: "CustomerId",
    principalTable: "Clients", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
```

これが欲しかったマイグレーションです。ここから分かるのは、EF Core はテーブルの名前変更について何も推測していないということです。差分全体をテーブル名を軸に判断しています。テーブル名を変えれば名前変更になり、エンティティ型のアイデンティティを変えれば drop になります。

## クラス名変更のコストをゼロにする手順

コツは、C# のリファクタリングとスキーマ変更を切り離し、どちらのステップも曖昧にならないようにすることです。

1. **クラスに触れる前に、現在のテーブル名を固定します。** データベースがすでに使っている名前で `ToTable` を追加し、何も生成しません。

   ```csharp
   // EF Core 11 - this is a no-op against the existing schema
   b.Entity<Customer>().ToTable("Customers");
   ```

2. **クラス、`DbSet`、ナビゲーションプロパティの名前を変更します。** ソリューション全体の書き換えは IDE に任せます。Fluent 構成は `b.Entity<Client>().ToTable("Customers")` になります。

3. **マイグレーションすべきものが何もないことを確認します。** このステップこそが、リファクタリングがスキーマに対して中立だったことを証明します。

   ```bash
   dotnet ef migrations has-pending-model-changes
   ```

   EF Core 10.0.10 では `No changes have been made to the model since the last migration.` と表示されます。クラス名は `Client` になり、`DbSet` は `Clients` になりましたが、データベースは何も気づいていません。このコミットは単独でリリースしてください。

4. **テーブル名は別のマイグレーションで変更します。** 固定を `b.Entity<Client>().ToTable("Clients")` に更新して生成します。今回はエンティティ型のアイデンティティが安定しているため、前述のきれいな `RenameTable` が得られます。

5. **適用する前に、生成されたマイグレーションを必ず読みます。** 毎回です。`Up` メソッドに `DropTable` と `DropColumn` がないこと、そして `Down` メソッドがテーブルを作り直すのではなく名前変更を元に戻していることを確認します。

名前変更が終わった後も固定を消さずに残しておく理由は、そうしないとテーブル名が規約によって `DbSet` プロパティ名から導出されるからです。暗黙のままにしておくと、次に読みやすさのためにプロパティ名を変更した人が、またあなたのテーブルを動かしてしまいます。

## SQL Server に対して実際に実行される内容

`RenameTable` のマイグレーションに対して `dotnet ef migrations script` を実行すると、次の SQL が得られます。

```sql
-- EF Core 10.0.10, SQL Server provider
ALTER TABLE [Orders] DROP CONSTRAINT [FK_Orders_Customers_CustomerId];
ALTER TABLE [Customers] DROP CONSTRAINT [PK_Customers];
EXEC sp_rename N'[Customers]', N'Clients', 'OBJECT';
EXEC sp_rename N'[Clients].[IX_Customers_Email]', N'IX_Clients_Email', 'INDEX';
ALTER TABLE [Clients] ADD CONSTRAINT [PK_Clients] PRIMARY KEY ([Id]);
ALTER TABLE [Orders] ADD CONSTRAINT [FK_Orders_Clients_CustomerId]
    FOREIGN KEY ([CustomerId]) REFERENCES [Clients] ([Id]) ON DELETE CASCADE;
```

テーブル名の変更自体はメタデータのみの操作で、行数にかかわらず実質的に一瞬で終わります。高くつくのは、その周辺で起きる制約の作り直しです。EF Core は制約の *名前* を `PK_Customers` から `PK_Clients` に変えるためだけに、主キーを削除して追加し直します。SQL Server では主キーは既定でクラスター化されるため、`ADD CONSTRAINT ... PRIMARY KEY` はクラスター化インデックス全体を再構築します。数千万行規模のテーブルでは、制約を見た目上リネームするためだけに、マイグレーションのトランザクション内で長時間かつログ負荷の高い操作が走ることになります。

`sp_rename` は制約を直接リネームできるので、マイグレーションを手で編集して再構築を回避できます。

```csharp
// EF Core 11 - replace DropPrimaryKey/AddPrimaryKey on a large SQL Server table
migrationBuilder.RenameTable(name: "Customers", newName: "Clients");
migrationBuilder.RenameIndex(name: "IX_Customers_Email", table: "Clients", newName: "IX_Clients_Email");
migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Customers]', N'PK_Clients', 'OBJECT';");
migrationBuilder.Sql("EXEC sp_rename N'[dbo].[FK_Orders_Customers_CustomerId]', N'FK_Orders_Clients_CustomerId', 'OBJECT';");
```

`sp_rename` は対象が制約の場合、スキーマで修飾した名前を必要とします。`[dbo].` を前置しているのはそのためです。これはプロバイダー固有であり、モデルスナップショットが EF Core に期待している内容から乖離します。したがって、再構築が本当に問題になる場合にだけ使ってください。この方法を採る場合は、アプリケーション起動時ではなくレビュー済みのスクリプトとして適用します。[migration bundle を使うワークフロー](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)がその形に適しています。

## EF Core が実際に推測しているのは列名の変更

Microsoft のドキュメントは今でも、プロパティ名を変更すると `DropColumn` と `AddColumn` が生成されると書いています。それはしばらく前から事実ではありません。EF Core 10.0.10 では、`Customer.Name` を `Customer.FullName` に変更すると、まさに望みどおりの内容が生成されます。

```csharp
migrationBuilder.RenameColumn(name: "Name", table: "Customers", newName: "FullName");
```

この改善は本物ですが、削除された列と追加された列を対応付けるヒューリスティックに依存しており、その対応付けは間違うことがあります。まったく同じ構成の文字列プロパティ `Alpha` と `Bravo` を持つエンティティを用意し、1つのマイグレーションでそれぞれ `Zulu` と `Yankee` に変更してみてください。EF Core 10.0.10 は次の内容を生成します。

```csharp
// WRONG: Alpha should become Zulu, Bravo should become Yankee
migrationBuilder.RenameColumn(name: "Bravo", table: "Customers", newName: "Zulu");
migrationBuilder.RenameColumn(name: "Alpha", table: "Customers", newName: "Yankee");
```

対応付けが交差しています。これを適用すると、テーブルの全行で2つの列のデータが黙って入れ替わります。何も削除されないためデータ損失の警告は出ず、マイグレーションは問題なく適用され、破損は人間が画面を見たときに初めて表面化します。私はモデルに他の変更を一切加えず、2列のテーブルでこれを再現しました。

実務上のルールとしては、列の型が同じ場合は1つのマイグレーションにつき1列だけ名前を変更するか、生成された `RenameColumn` の組み合わせを読んで手で修正します。これは[enum を整数値として保存する](/ja/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)場合と同じ種類の、静かなデータ破損です。スキーマは正しいまま、その下でデータの意味だけがずれていきます。

## マイグレーションが成功した後もなお壊れる3つのこと

**ビュー、ストアドプロシージャ、トリガーは古い名前のまま残ります。** SQL Server の `sp_rename` は参照までは追いかけません。ドキュメントははっきりこう書いています。"Changing any part of an object name can break scripts and stored procedures." `Customers` から選択しているビューは、名前変更の時点では失敗しません。次に誰かがクエリしたときに失敗します。生成する前に、そのテーブルに依存しているものを洗い出してください。

```sql
SELECT OBJECT_NAME(referencing_id) AS referencing_object
FROM sys.sql_expression_dependencies
WHERE referenced_entity_name = 'Customers';
```

そのうえで、名前変更と依存オブジェクトが一緒に移動するように、同じマイグレーションに `migrationBuilder.Sql("ALTER VIEW ...")` の操作を追加します。

**`dotnet ef database update --add` は、読む前にマイグレーションを適用してしまいます。** EF Core 11 では、マイグレーションを生成し、Roslyn でコンパイルし、そのまま即座に適用する単一ステップのコマンドが追加されました。これはコンテナ化された環境や Aspire のワークフローでは本当に便利ですが、名前変更にはまったく向きません。前述の安全手順は、生成されたファイルを先に読むことに全面的に依存しているからです。既存テーブルのアイデンティティに触れるマイグレーションでは、生成と適用を2つのコマンドに分けてください。[単一ステップのマイグレーション機能](/ja/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)は、それ以外の場面では使う価値があります。

**名前変更は後方互換ではないため、ローリングデプロイを壊します。** ローリングデプロイの最中、古いビルドはまだ動いていて `SELECT ... FROM Customers` を発行し続けますが、新しいビルドは `Clients` を期待しています。テーブル名を変更する単一のマイグレーションは、古いインスタンスを落とします。ダウンタイムをゼロにしたい場合、名前変更は複数回のデプロイにまたがる手順になります。名前変更と同じマイグレーションで `Clients` の上に `Customers` という名前のビューを作り、新しいビルドをデプロイし、どのインスタンスも古い名前を参照しなくなった時点で、後続のマイグレーションでそのビューを削除します。

コミット前に確認しておきたい最後の点は `Down` メソッドです。EF Core は `RenameTable` に対して正しい逆操作を生成しますが、制約に `sp_rename` を使うよう `Up` を手で編集した場合、`Down` には生成された `DropPrimaryKey` と `AddPrimaryKey` が残ったままになり、ロールバックが対称になりません。この後にモデルスナップショットとデータベースが食い違うと、次回の起動時に[モデルに保留中の変更があるという例外](/ja/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)に出会うことになります。そのとき、ランタイムが実際にどの名前を使ってクエリしているかを知る最短の方法が[EF Core が生成する SQL をログに出すこと](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)です。

## 関連記事

- [dotnet ef migrations bundle で EF Core 11 のマイグレーションを本番環境に適用する方法](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [EF Core 11 では1つのコマンドでマイグレーションの作成と適用ができます](/ja/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Fix: EF Core 11 でコンテキスト 'X' のモデルに保留中の変更があります](/ja/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [EF Core 6 から EF Core 11 への移行：本当に効いてくる破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [EF Core 11 が生成する SQL をログに出す方法](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)

## 参考資料

- Microsoft Learn の [Managing migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing)。EF Core 11 で追加された `dotnet ef database update --add` コマンドを含みます
- `schema` と `newSchema` パラメーターについては [MigrationBuilder.RenameTable](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.migrations.migrationbuilder.renametable) の API リファレンス
- 制約のリネームと依存関係に関する注意点については [sys.sp_rename](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-rename-transact-sql)
- 名前変更の前にテーブルを参照しているオブジェクトを探すには [sys.sql_expression_dependencies](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-sql-expression-dependencies-transact-sql)
