---
title: "EF Core 11 でのデータシードにおける HasData vs UseSeeding: どちらを使うべきか?"
description: "HasData は固定的でモデルが所有する参照データにのみ使います。EF Core 11 のそれ以外すべてには UseSeeding と UseAsyncSeeding を使います。判断を決定づけるルールとともに並べて比較します。"
pubDate: 2026-06-30
template: vs
tags:
  - "comparison"
  - "efcore"
  - "dotnet"
lang: "ja"
translationOf: "2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-30
---

EF Core 11 でデータをシードするには、マイグレーション内でバージョン管理したい小さく固定的で決定論的な参照テーブル(国コード、通貨、enum のような検索行)にのみ `HasData` を使います。それ以外のすべてには `UseSeeding` と `UseAsyncSeeding` を使います。データベース生成キー、計算値や非決定論的な値、条件分岐、ナビゲーションプロパティ、あるいはデータベースに既にあるものに依存する行を伴うものはすべてです。EF チームは `HasData` を "model-managed data" に改名しましたが、これはまさに汎用のシードツールとして使うことを思いとどまらせるためです。この記事では .NET 11、EF Core 11(`Microsoft.EntityFrameworkCore` 11.0)、C# 14 を使用します。

1 行だけ覚えるなら、`HasData` はモデルとマイグレーションの diff に参加し、`UseSeeding` は生きた `DbContext` に対して通常のコードとして実行されます。痛みを伴うシードのバグのほとんどは、後者が必要なときに前者を選ぶことから生じます。

## 機能マトリックス

これがあなたが求めてきた表です。各行は感覚ではなく実際の制約です。

| 機能                             | `HasData`(model-managed data) | `UseSeeding` / `UseAsyncSeeding` |
| -------------------------------- | ------------------------------ | -------------------------------- |
| 設定場所                         | `OnModelCreating`(モデル)     | `DbContextOptionsBuilder`        |
| 実行タイミング                   | マイグレーション SQL 内(`InsertData`) | `Migrate`/`EnsureCreated` と `dotnet ef database update` 時 |
| 主キー                           | 手動で指定する必要がある       | データベース生成キーで問題ない   |
| 非決定論的な値                   | 禁止(ビルドごとに再 diff)    | 許可(`Guid.NewGuid()`、`DateTime.UtcNow`) |
| ナビゲーションプロパティ         | 不可、外部キーのみ             | 可、グラフ全体の挿入             |
| 条件分岐                         | 不可                           | 可、`if` は自分で書く            |
| 外部呼び出し / 変換              | 不可                           | 可(ハッシュ化、HTTP、ファイル読み取り) |
| 冪等性                           | 自動(EF が diff)             | 存在チェックを自分で書く         |
| バージョン管理に記録される       | はい、マイグレーションスナップショット内 | いいえ、起動時コードです         |
| 既存行の更新                     | はい、マイグレーション diff 経由 | 更新を書いた場合のみ             |
| 利用可能になったバージョン       | EF Core 1.0(`HasData` だった) | EF Core 9、EF Core 11 で現行     |

何より重要な行は「非決定論的な値」です。`HasData` はビルドごとにモデルのスナップショットと比較されるため、シード内の `DateTime.UtcNow` や `Guid.NewGuid()` はモデルが毎回変更されたように見せ、EF は `PendingModelChangesWarning` を投げるか、無意味なマイグレーションを延々と少しずつ生成します。これがほとんどの人がぶつかる壁で、たいてい [EF Core 6 から EF Core 11 へのマイグレーション](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)の最中に起こります。

## HasData を選ぶとき

`HasData` は、データが本当にスキーマの意味の一部であるときに正しいツールです。頭の中でのテスト: これらの行を定数にハードコードしても平気で、ほとんど変わらないでしょうか?

- **固定的な検索テーブル。** ISO 国コード、通貨コード、米国の州、テーブルに裏付けられた注文ステータスの enum。キーは安定していて、自分で割り当て、値をスキーマとともに配布しバージョン管理したい。EF Core 11 では `OnModelCreating` で設定します:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderStatus>().HasData(
        new OrderStatus { Id = 1, Name = "Pending" },
        new OrderStatus { Id = 2, Name = "Shipped" },
        new OrderStatus { Id = 3, Name = "Delivered" });
}
```

- **自動的に diff されマイグレーションされてほしいデータ。** `"Shipped"` を `"Dispatched"` に変えると、次の `dotnet ef migrations add` が `UpdateData` 呼び出しを出力します。スキーマと同じ場所で、バージョン管理され、レビュー可能で、監査可能なシードへの変更が得られます。これは `UseSeeding` が無料では与えてくれない実際の利点です。

- **それがなければスキーマが無意味になるデータ。** 別のテーブルの外部キーが `OrderStatus.Id = 2` を指していて、その行が欠けていれば、アプリは壊れています。マイグレーションに焼き込むことで、同じトランザクション内で、スキーマと足並みをそろえて確実に配置されます。

キーは明示的に設定する必要があり、値は決定論的でなければなりません。`Guid.NewGuid()` も `DateTime.Now` もナビゲーションプロパティも不可です(外部キー列を直接設定します)。そのいずれかを破ると、`HasData` はビルドごとにあなたと戦います。

## UseSeeding と UseAsyncSeeding を選ぶとき

`UseSeeding` は EF Core 11 で推奨される汎用メカニズムです。生きた `DbContext` を持つ普通のアプリケーションコードなので、`HasData` の限界は単に存在しません。次のいずれかが当てはまるときは常にこれを使います:

- **データベースがキーを生成する。** identity 列、シーケンス、`newsequentialid()`: `HasData` ではキーを手で考案し、実際の挿入と決して衝突しないことを祈らなければなりません。`UseSeeding` ならデータベースに割り当てさせられます。

- **値が計算されるか非決定論的である。** デフォルト管理者パスワードのハッシュ化、`CreatedAt = DateTime.UtcNow` の刻印、`Guid` トークンの生成。これらはモデルの diff を生き延びないので、実行時に走る必要があります:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(connectionString)
        .UseAsyncSeeding(async (context, _, ct) =>
        {
            if (!await context.Set<User>().AnyAsync(u => u.Email == "admin@example.com", ct))
            {
                context.Set<User>().Add(new User
                {
                    Email = "admin@example.com",
                    PasswordHash = PasswordHasher.Hash("change-me"), // runtime transform
                    CreatedAt = DateTime.UtcNow                        // non-deterministic
                });
                await context.SaveChangesAsync(ct);
            }
        })
        .UseSeeding((context, _) =>
        {
            if (!context.Set<User>().Any(u => u.Email == "admin@example.com"))
            {
                context.Set<User>().Add(new User
                {
                    Email = "admin@example.com",
                    PasswordHash = PasswordHasher.Hash("change-me"),
                    CreatedAt = DateTime.UtcNow
                });
                context.SaveChanges();
            }
        }));
```

- **条件付きまたはデータ依存のロジックが必要。** 「デモテナントを `Development` のときだけシードする」、または「テーブルが空のときだけこれらの行を挿入する」。これは普通の `if` で、`HasData` ではまったく表現できません。

- **ナビゲーションプロパティを通じてオブジェクトグラフを挿入する。** 3 つの投稿を持つブログ、明細を持つ注文、または [多対多のリレーション](/ja/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/)。`UseSeeding` ではグラフを C# で組み立て、外部キーの解決を `SaveChanges` に任せます。`HasData` ではすべての結合行を手で配線しなければなりません。

落とし穴はほとんどの人が見落とすものです。**両方の**オーバーロードを実装する必要があり、存在チェックはあなたの責任です。EF Core のツール(`dotnet ef database update`)は同期版の `UseSeeding` のみを呼び出し、実行時の経路は `UseAsyncSeeding` を呼び出します。一方を実装してもう一方を実装しないと、忘れた経路からのシードは静かに何もしません。完全なメカニズムについては [UseSeeding と UseAsyncSeeding でデータをシードする方法](/ja/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/)を参照してください。

## ディスク上で実際に起こること

違いを見る最も明確な方法は、それぞれが何を生成するかを見ることです。

`HasData` はマイグレーションへと具現化します。`dotnet ef migrations add SeedStatuses` の後、生成された `Up` メソッドには SQL の形をした呼び出しが含まれます:

```csharp
// .NET 11, EF Core 11 generated migration
migrationBuilder.InsertData(
    table: "OrderStatuses",
    columns: new[] { "Id", "Name" },
    values: new object[,]
    {
        { 1, "Pending" },
        { 2, "Shipped" },
        { 3, "Delivered" }
    });
```

データは今やバージョン管理されたアーティファクトです。マイグレーションのトランザクション内で一度だけ実行され、EF はそれをモデルスナップショットで追跡するので、後の編集は `UpdateData` を生成します。非決定論的な値がここで毒になるのはまさにこのためです。スナップショットは決して一致せず、EF はモデルがビルドごとに変わったと信じてしまうのです。

`UseSeeding` はディスク上に何も生成しません。スキーマが最新になった後、`Migrate`、`EnsureCreated`、または `dotnet ef database update` のたびに発火するコールバックで、マイグレーションが適用されなかった実行も含みます。無条件で実行されるため、存在チェックは任意の片付け作業ではなく、あなたと重複行の間に立つ唯一のものです。EF Core 11 はマイグレーションに使うのと同じマイグレーションロック機構でコールバックを保護するので、同時に起動する 2 つのアプリインスタンスが両方ともシードを並行実行することはありませんが、ロックは欠けている `if` を冪等にはしません。

## あなたの代わりに決める落とし穴

いくつかの制約は好みを完全に上書きします。次のいずれかが当てはまれば、判断はあなたの代わりに決まっています:

- **データベース生成キーは `UseSeeding` を強制する。** 主キーを手でハードコードできない、またはしたくないなら、`HasData` は選択肢から外れます。キーをデータベースが割り当てる行をシードする手段がないのです。

- **非決定論的または計算された値は `UseSeeding` を強制する。** ハッシュ化されたパスワード、タイムスタンプ、ランダムトークン: 1 つでも現れた瞬間、`HasData` はすべてのビルドをファントムマイグレーションに変えます。これがチームが `HasData` を引き剥がす最も一般的な理由です。

- **他の行が指す固定的な enum テーブルは `HasData` に有利。** 参照整合性が、実データより前にシードが存在することに依存するとき、それを起動時コールバックではなくマイグレーショントランザクション内に置きたいものです。コールバックは例外を投げてスキーマを半分シードされた状態で残しかねません。

- **データベース生成の必須キーを持つ `HasData` 行はエラーを引き起こす。** キーを与えずに `HasData` を通じてエンティティをシードしようとすると、EF は `The seed entity for entity type 'X' cannot be added because a non-zero value is required for property 'Id'` を投げます。このエラーは、間違ったメカニズムを選んだと EF が告げているのです。[そのメッセージそのものの解決法](/ja/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/)を参照してください。

1 つのアプリで両方を使うのはまったく問題ありません。よくある健全な分割: スキーマが機能できない 3 つの検索テーブルには `HasData`、デモデータ、デフォルト管理者、テナント固有のものには `UseSeeding`。これらは異なる段階で実行されるので衝突しません。

## 推奨、再び

EF Core 11 ではデフォルトで `UseSeeding` と `UseAsyncSeeding` を使います。これらは推奨メカニズムで、実際のアプリケーションが本当にシードする動的でキー生成され条件付きのデータを扱い、マイグレーション履歴を静かに破壊するのではなく大きな音を立てて失敗します。`HasData` は、それが改名されて担うことになった狭いケースのために取っておきます。手で割り当てたキーを持ち、スキーマとともに本当にバージョン管理し diff したい、小さく固定的で決定論的な参照データです。

避けるべき罠は歴史的なデフォルトです。長年 `HasData` は唯一の組み込み選択肢だったので、コードベースは反射的にそれに手を伸ばし、その後ファントムマイグレーションと `PendingModelChangesWarning` に溺れました。EF Core 11 でゼロから始めるなら、その本能を逆にしてください。まず `UseSeeding`、`HasData` はデータがモデルに属する理由を言葉にできるときだけです。`records` ベースのエンティティを保守しているなら、同じ分割がきれいに当てはまります。[records は EF Core 11 で問題なく機能する](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/)ので、どちらのメカニズムでも同様です。

## 関連

- [EF Core 11 で UseSeeding と UseAsyncSeeding でデータをシードする方法](/ja/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/)
- [EF Core 11 で多対多のリレーションをシードする方法](/ja/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/)
- [解決: the seed entity cannot be added because a non-zero value is required for property Id](/ja/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/)
- [EF Core 6 から EF Core 11 へのマイグレーション: 実際に噛みつく breaking changes](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [EF Core 11 で records を正しく使う方法](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/)

## 出典

- [Data Seeding - EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding)
- [What's New in EF Core 9: UseSeeding and UseAsyncSeeding, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [DbContextOptionsBuilder.UseSeeding, API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding)
