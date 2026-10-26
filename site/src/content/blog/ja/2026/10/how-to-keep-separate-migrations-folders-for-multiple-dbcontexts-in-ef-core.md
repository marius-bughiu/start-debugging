---
title: "1つの EF Core プロジェクトで複数の DbContext ごとにマイグレーションフォルダーを分ける方法"
description: "DbContext ごとに --output-dir を一度だけ指定すれば、以降のマイグレーションは同じフォルダーと名前空間に作成されます。既定のレイアウトが偏る理由、共有フォルダーで発生する CS0111 の衝突、既存マイグレーションの移動方法、履歴テーブルを分けるべきタイミングを解説します。"
pubDate: 2026-10-26
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "migrations"
  - "dotnet"
lang: "ja"
translationOf: "2026/10/how-to-keep-separate-migrations-folders-for-multiple-dbcontexts-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-26
---

**要点:** 各コンテキストの最初のマイグレーションを、それぞれ専用の `--output-dir` を付けて作成します。たとえば `dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Data/Migrations/Catalog` を実行し、`OrdersDbContext` にも `Data/Migrations/Orders` で同様に実行します。EF Core はそのフォルダーから名前空間 (`Shop.Data.Migrations.Catalog`) を導き出し、同じコンテキストに対する以降の `migrations add` は、直前のマイグレーションとスナップショットの隣に自動で作成されるため、`--output-dir` を再度指定する必要はありません。2 つのコンテキストを同じフォルダーに向けてはいけません。同名のマイグレーションが 1 つの partial クラスになり、ビルドが CS0111 で失敗します。以下はすべて、.NET 10 (SDK 10.0.302) 上の EF Core 10.0.14 と `dotnet-ef` 10.0.14 を使い、SQLite に対して実行したものです。`release/11.0` ブランチのスキャフォールディングコードも確認しましたが、フォルダーと名前空間のロジックは EF Core 11 でも変わっていません。

## 何も指定しない場合に EF Core が行うこと

多くの人はレイアウトを決めないまま進めます。プロジェクトに 2 つ目の `DbContext` を追加し、最初のエラーに遭遇して `--context` を付け、そのまま先へ進みます。その結果どうなるかを見ておく価値があります。実際のリポジトリで見かける分かりにくいフォルダー構成の多くが、これで説明できるからです。

この記事全体で使うセットアップは、`Shop` という名前のコンソールプロジェクト 1 つと、同じ SQLite ファイルを指す 2 つのコンテキストです。

```csharp
// .NET 10, EF Core 10.0.14
// Data/Contexts.cs
using Microsoft.EntityFrameworkCore;

namespace Shop.Data;

public class Product { public int Id { get; set; } public string Name { get; set; } = ""; }
public class Order { public int Id { get; set; } public int ProductId { get; set; } public int Quantity { get; set; } }

public class CatalogDbContext(DbContextOptions<CatalogDbContext> options) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();
}

public class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
}
```

```csharp
// .NET 10, EF Core 10.0.14
// Program.cs
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Shop.Data;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlite("Data Source=shop.db"));
builder.Services.AddDbContext<OrdersDbContext>(o => o.UseSqlite("Data Source=shop.db"));
using var host = builder.Build();
```

`--context` がない場合、ツールは推測を拒否します。

```text
$ dotnet ef migrations add InitialCreate
More than one DbContext was found. Specify which one to use. Use the '-Context' parameter for PowerShell commands and the '--context' parameter for dotnet commands.
```

それぞれに `--context` を付け、フォルダーは EF Core に任せます。

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext
dotnet ef migrations add InitialCreate --context OrdersDbContext
```

結果は偏ったものになります。

```text
Migrations/
  20261026120305_InitialCreate.cs              namespace Shop.Migrations        (Catalog)
  20261026120305_InitialCreate.Designer.cs
  CatalogDbContextModelSnapshot.cs
  OrdersDb/
    20261026120307_InitialCreate.cs            namespace Shop.Migrations.OrdersDb
    20261026120307_InitialCreate.Designer.cs
    OrdersDbContextModelSnapshot.cs
```

最初にマイグレーションを作成したコンテキストが `Migrations/` を占有します。2 番目のコンテキストには、`Context` サフィックスを取り除いたコンテキスト名のサブフォルダーが割り当てられ、`OrdersDbContext` は `OrdersDb` になります。これはバグではなく、`MigrationsScaffolder` に意図的に書かれたコードです。出力ディレクトリを指定せず、かつ既定の `Migrations` 名前空間に、`[DbContext]` 属性が別のコンテキストを指すマイグレーションがすでにある場合、EF Core は `<RootNamespace>.Migrations.<サフィックスなしのコンテキスト名>` に切り替えます。名前が `Context` で終わらないコンテキストの場合は、代わりに `<Name>Migrations` になります。このロジックは EF Core 3.1 から存在し、11 でも残っています。

動作はしますが、順序に依存します。リポジトリを新しくクローンし、マイグレーションを削除して、逆の順序でコマンドを実行すると、フォルダーが入れ替わります。さらに、非対称な構成 (一方がルート、もう一方がその内側) のため、`Migrations/` が両方のコンテキストのものであるかのように見えます。明示的に指定するコストは、フラグ 1 つを一度付けるだけです。

## --output-dir による明示的なレイアウト

まっさらな状態から始めて、各コンテキストの最初のマイグレーションでそれぞれ専用のフォルダーを指定します。

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Data/Migrations/Catalog
dotnet ef migrations add InitialCreate --context OrdersDbContext --output-dir Data/Migrations/Orders
```

```text
Data/
  Contexts.cs
  Migrations/
    Catalog/
      20261026120357_InitialCreate.cs           namespace Shop.Data.Migrations.Catalog
      20261026120357_InitialCreate.Designer.cs
      CatalogDbContextModelSnapshot.cs
    Orders/
      20261026120359_InitialCreate.cs           namespace Shop.Data.Migrations.Orders
      20261026120359_InitialCreate.Designer.cs
      OrdersDbContextModelSnapshot.cs
```

`--output-dir` の値はプロジェクトディレクトリからの相対パスで、EF Core はパスの各セグメントをサブ名前空間に変換します。そのため `Data/Migrations/Catalog` は `Shop.Data.Migrations.Catalog` になります (ルート名前空間はプロジェクトの `RootNamespace` から決まります)。フォルダーと一致しない名前空間にしたい場合は、`--namespace` を追加します。

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext \
  --output-dir Data/Migrations/Catalog \
  --namespace Shop.Catalog.Migrations
```

Visual Studio のパッケージ マネージャー コンソールでは、同じオプションは `-Context`、`-OutputDir`、`-Namespace` です。

```powershell
# EF Core 10.0.14 PMC tools
Add-Migration InitialCreate -Context CatalogDbContext -OutputDir Data\Migrations\Catalog
Add-Migration InitialCreate -Context OrdersDbContext -OutputDir Data\Migrations\Orders
```

## --output-dir を渡すのは一度だけ

これはネット上のほとんどの回答が触れていない部分で、`--output-dir` を永遠に繰り返すスクリプトができあがってしまう原因でもあります。最初のマイグレーションの後は、フォルダーが固定されます。`Product` エンティティを変更し、出力ディレクトリをまったく指定せずに 2 つ目のマイグレーションを追加しました。

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add AddPrice --context CatalogDbContext
```

```text
Data/Migrations/Catalog/20261026120401_AddPrice.cs
Data/Migrations/Catalog/20261026120401_AddPrice.Designer.cs
```

`MigrationsScaffolder` の 2 つのルールによって、これが実現されています。

1. **名前空間**: 出力ディレクトリが指定されない場合、新しいマイグレーションはそのコンテキストの最後のマイグレーション型の名前空間を再利用し、スナップショットは既存のスナップショットクラスの名前空間を再利用します。
2. **ディレクトリ**: `Save` は、プロジェクトディレクトリを再帰的に検索して直前のマイグレーションのファイル (`<PreviousMigrationId>.cs`) を探し、新しいファイルを同じフォルダーに書き込みます。スナップショットも同様に、ファイル名 `CatalogDbContextModelSnapshot.cs` で見つけます。

つまり、信頼できる情報源は、ファイルが現在置かれている場所です。これには実用上の帰結が 2 つあります。1 つ目は、スクリプトや EF Core 11 の `.config/dotnet-ef.json` に出力ディレクトリを書く必要がないことです (そもそもこのファイルに output-dir のキーはありません)。2 つ目は、あとからマイグレーションを移動しても EF Core が追従することで、これは次のセクションで扱います。

後続のマイグレーションで `--output-dir` を明示的に渡した場合、マイグレーションファイルについてはそれが優先されますが、スナップショットは既存のスナップショットファイルがある場所に書き込まれます。そのため、後続のマイグレーションを別の場所に向けると、1 つのコンテキストが 2 つのフォルダーに分かれてしまいます。避けてください。

## 1 つのフォルダーを複数のコンテキストで共有しない

両方のコンテキストに同じ `--output-dir` を渡すとどうなるでしょうか。EF Core は警告付きで許可します。

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Migrations
dotnet ef migrations add InitialCreate --context OrdersDbContext --output-dir Migrations
```

```text
The namespace 'Shop.Migrations' contains migrations for a different DbContext. This can result in conflicting migration names. It's recommend to put migrations for different DbContext classes into different namespaces.
Done. To undo this action, use 'ef migrations remove'
```

この警告は事態を過小評価しています。両方のコンテキストが `Shop.Migrations` に `partial class InitialCreate` を持つことになります。タイムスタンプが異なるためファイル名は違いますが、C# は partial 宣言を 1 つのクラスにマージするため、次のビルドは失敗します。

```text
error CS0111: Type 'InitialCreate' already defines a member called 'Up' with the same parameter types
error CS0111: Type 'InitialCreate' already defines a member called 'Down' with the same parameter types
error CS0111: Type 'InitialCreate' already defines a member called 'BuildTargetModel' with the same parameter types
error CS0579: Duplicate 'Migration' attribute
```

EF Core 自身の重複名チェック (`The name 'InitialCreate' is used by an existing migration.`) は同じコンテキストのマイグレーションしか見ないため、これは検出できません。両方のチームがたまたま選んだ名前、たとえば `InitialCreate`、`AddIndexes`、`Cleanup` なら何でも発生します。コンテキストごとに 1 つのフォルダーと 1 つの名前空間にすれば、衝突は起こり得ません。

## 既存のマイグレーションを移動する

プロジェクトがすでに偏った既定のレイアウトや、すべてを 1 つのフォルダーに入れた構成になっている場合でも、データベースに触れずに再編成できます。EF Core はリフレクションでマイグレーションを見つけます。`Migration` を継承し、`[DbContext(typeof(X))]` 属性と `[Migration("<id>")]` 属性を持つ型は、コンテキスト `X` のものです。フォルダーと名前空間は実行時には無関係で、履歴テーブル内のマイグレーション ID も変わりません。

各コンテキストの手順は次のとおりです。

1. そのコンテキストのマイグレーションファイル (`<id>_<Name>.cs` と `<id>_<Name>.Designer.cs`) と `<Context>ModelSnapshot.cs` を新しいフォルダーに移動します。通常の `.cs` ファイルには `[DbContext]` 属性がないため、コンテキスト名で grep するのではなくマイグレーション ID で照合してください。そうしないと、各マイグレーションの半分を取り残すことになります。
2. 移動したすべてのファイル (スナップショットを含む) の `namespace` 行を、新しい名前空間に変更します。
3. ビルドしたあと、`dotnet ef migrations list --context <Context>` を実行して、同じ ID が表示されることを確認します。
4. `--output-dir` なしで次のマイグレーションを追加し、新しいフォルダーに作成されることを確認します。

上記の共有フォルダーで壊れたプロジェクトに対して、まさにこれを行いました。`OrdersDbContext` の 3 つのファイルを `Migrations/Orders` に移動し、`namespace Shop.Migrations` を `namespace Shop.Migrations.Orders` に変更すると、ビルドは成功しました。`migrations list --context OrdersDbContext` は引き続き `20261026120430_InitialCreate` を表示し、新しい `AddPlacedAt` マイグレーションは追加のフラグなしで `Migrations/Orders` に `Shop.Migrations.Orders` 名前空間で作成されました。

移動は他の変更を含めず、1 つのコミットで行ってください。差分は純粋なリネームと 1 行の名前空間の編集だけになります。コードレビューは簡単で、`git log --follow` も引き続き機能します。

## 共有される __EFMigrationsHistory テーブル

フォルダーはソースコード上の関心事です。データベースでは、既定では両方のコンテキストが同じ履歴テーブルに書き込みます。テーブル名はコンテキストに依存しないためです。両方を適用した後は次のようになります。

```bash
# dotnet-ef 10.0.14
dotnet ef database update --context CatalogDbContext
dotnet ef database update --context OrdersDbContext
```

```text
sqlite> select * from __EFMigrationsHistory;
20261026120357_InitialCreate|10.0.14
20261026120401_AddPrice|10.0.14
20261026120359_InitialCreate|10.0.14
```

コンテキストを示す列はありません。各コンテキストはすべての行を読み取り、自分のマイグレーションに一致する ID だけを気にします。そのため、たいていの場合は問題なく動作します。ID の形式は 1 秒単位の `yyyyMMddHHmmss_Name` なので、2 つのコンテキストが衝突するのは、誰かが同じ秒に両方に同じ名前のマイグレーションをスキャフォールドした場合だけです。コンテキストをループするスクリプトならそれが起こり得ます。

たとえば 2 つのコンテキストが異なるスキーマにマップされている、あるいは別々のチームが所有しているといった理由で履歴を分けたい場合は、コンテキストごとのテーブルを設定します。

```csharp
// .NET 10, EF Core 10.0.14
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlite("Data Source=shop.db",
    sql => sql.MigrationsHistoryTable("__CatalogMigrationsHistory")));
```

`MigrationsHistoryTable` は、SQL Server など、スキーマをサポートするプロバイダーではスキーマも受け取れます: `sql.MigrationsHistoryTable("__EFMigrationsHistory", "catalog")`。

ここに落とし穴があります。すでにマイグレーションが適用されているデータベースでこれを行うと、新しいテーブルは空なので、EF Core は何も実行されていないと判断して `InitialCreate` を再実行してしまいます。

```text
$ dotnet ef database update --context CatalogDbContext
SQLite Error 1: 'table "Products" already exists'.
```

更新する前に、そのコンテキストの行を新しいテーブルにコピーしてください。SQLite の場合は次のとおりです。

```sql
-- SQLite, run once per database before deploying the history table change
CREATE TABLE "__CatalogMigrationsHistory" (
    "MigrationId" TEXT NOT NULL CONSTRAINT "PK___CatalogMigrationsHistory" PRIMARY KEY,
    "ProductVersion" TEXT NOT NULL);

INSERT INTO "__CatalogMigrationsHistory"
SELECT "MigrationId", "ProductVersion" FROM "__EFMigrationsHistory"
WHERE "MigrationId" IN ('20261026120357_InitialCreate', '20261026120401_AddPrice');

DELETE FROM "__EFMigrationsHistory"
WHERE "MigrationId" IN ('20261026120357_InitialCreate', '20261026120401_AddPrice');
```

その後、`database update --context CatalogDbContext` は何もしなくなり、`migrations list` は両方のマイグレーションを適用済みとして表示します。新しいデータベースでは特別な対応は不要です。生成されるスクリプトは `CREATE TABLE IF NOT EXISTS "__CatalogMigrationsHistory"` から始まります。べき等スクリプトやマイグレーションバンドルでデプロイする場合は、すべての環境で、その前にコピーを実行してください。

## 両方のコンテキストが同じテーブルをマップする場合

フォルダーを分けても、2 つのコンテキストが同じテーブルの DDL を生成することは防げません。`OrdersDbContext` が商品への読み取りアクセスを必要とし、`public DbSet<Product> Products => Set<Product>();` を追加したとします。`OrdersDbContext` の次のマイグレーションには `CreateTable(name: "Products", ...)` が含まれ、`CatalogDbContext` がすでに作成しているため、デプロイ時に失敗します。

所有者を 1 つ決め、もう一方のコンテキストのマイグレーションからそのテーブルを除外します。

```csharp
// .NET 10, EF Core 10.0.14
public class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Product> Products => Set<Product>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
        => modelBuilder.Entity<Product>()
            .ToTable("Products", t => t.ExcludeFromMigrations());
}
```

これを設定した状態で同じ `migrations add` を実行すると、空の `Up` メソッドが生成されました。エンティティは引き続きモデルの一部なので、クエリと変更追跡は動作します。マイグレーションだけがそのテーブルを無視します。`Product` のスキーマ変更は今後 `CatalogDbContext` 経由でマイグレーションする必要があり、`OrdersDbContext` は共有のエンティティクラスを通じてそれを取り込むことを忘れないでください。

## 他のコマンドにも --context が必要

マイグレーションコマンドはすべて 1 つのコンテキストを対象に動作します。そのためコンテキストが 2 つになったら、`add` だけでなくすべてのコマンドで `--context` が必須になります。

```bash
# dotnet-ef 10.0.14
dotnet ef migrations list   --context OrdersDbContext
dotnet ef migrations remove --context OrdersDbContext
dotnet ef migrations script --context OrdersDbContext --idempotent -o orders.sql
dotnet ef migrations bundle --context OrdersDbContext -o efbundle-orders
dotnet ef database update   --context OrdersDbContext
```

`migrations remove` は、最後のマイグレーションのファイルを (ファイル名でプロジェクトを検索して) どこにあっても削除し、スナップショットも既存のフォルダー内で書き直すため、こちらもレイアウトを尊重します。実行時には、スキーマが必要とする順序 (共有テーブルの所有者を先に) で、コンテキストごとに一度ずつ `Database.MigrateAsync()` を呼び出します。

`--context` を毎回入力するのが面倒なら、EF Core 11 は `.config/dotnet-ef.json` から既定の `context` を読み取れます。フラグはそれを上書きするので、最もよくマイグレーションするコンテキストを設定し、もう一方には `--context` を渡す形にできます。

## コンテキストごとに別のマイグレーションプロジェクトにする

ほとんどのアプリでは、1 つのプロジェクト内のフォルダーで十分です。コンテキストを別々にデプロイする場合や、一方のチームが他方のマイグレーションに触れてはならない場合は、各コンテキストのマイグレーションをそれぞれ専用のクラスライブラリに移し、EF Core にその場所を伝えます。

```csharp
// .NET 10, EF Core 10.0.14
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlServer(catalogConnection,
    sql => sql.MigrationsAssembly("Shop.Migrations.Catalog")));
```

その後、`dotnet ef migrations add` を `--project Shop.Migrations.Catalog --startup-project Shop --context CatalogDbContext` 付きで実行します。トレードオフは、コンテキストごとにプロジェクトが 1 つ増えることと、スタートアッププロジェクトから各マイグレーションプロジェクトへの参照が必要になり、実行時にそれらが読み込まれることです。配線については [別のマイグレーションプロジェクトに関する公式ガイド](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/projects) が詳しく説明しています。

## 関連記事

- [Fix: The model for context has pending changes in EF Core 11](/ja/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/): 間違ったコンテキストにマイグレーションを追加したときにも発生します。
- [Stop retyping --project and --startup-project with .config/dotnet-ef.json](/ja/2026/06/efcore-11-dotnet-ef-json-config-file/): EF Core 11 の機能です。
- [How to apply EF Core 11 migrations in production with migration bundles](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/): コンテキストごとに 1 つのバンドルにします。
- [Fix: There is already an object named 'X' in the database after resetting migrations](/ja/2026/10/fix-there-is-already-an-object-named-in-the-database-after-resetting-ef-core-migrations/): 同じ履歴テーブルの仕組みを別の角度から扱っています。
- [Fix: dotnet ef migrations add "Unable to create an object of type DbContext"](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/): デザインタイムツールがどちらのコンテキストも構築できない場合の記事です。

## 参考資料

- [EF Core tools reference (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet), Microsoft Learn: `--context`、`--output-dir`、`--namespace`。
- [Using a Separate Migrations Project](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/projects), Microsoft Learn。
- [Custom Migrations History Table](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/history-table), Microsoft Learn。
- [Entity types: excluding from migrations](https://learn.microsoft.com/en-us/ef/core/modeling/entity-types#excluding-from-migrations), Microsoft Learn。
- [`MigrationsScaffolder.cs` on release/10.0](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Design/Migrations/Design/MigrationsScaffolder.cs): 上記で説明した名前空間の既定値、他コンテキストのマイグレーションの検査、ディレクトリの再利用を実装しています。
