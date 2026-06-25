---
title: "修正: The seed entity for entity type 'X' cannot be added because a non-zero value is required for property 'Id'"
description: "HasData がストア生成キーのエンティティを明示的な値なしでシードしています。各行に安定したゼロ以外の Id を与えるか、生成キーには UseSeeding を使ってください。"
pubDate: 2026-06-25
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "ja"
translationOf: "2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property"
translatedBy: "claude"
translationDate: 2026-06-25
---

修正方法: 主キーがストア生成（`IDENTITY` 列）であるエンティティを `HasData` でシードしようとしたものの、キーを CLR の既定値（`int` なら `0`、`Guid` なら `Guid.Empty`）のままにしています。`HasData` はデータベースに触れずにマイグレーション時に挿入スクリプトを構築するため、データベースがキーを払い出すことには頼れません。各シード行に、明示的で安定したゼロ以外のキー値を与えてください（`new Country { Id = 1, ... }`）。本当にデータベースにキーを生成させたいなら、`HasData` はまったく使わないでください。代わりに `UseSeeding`／`UseAsyncSeeding` を使います。このガイドは .NET 11、C# 14、`Microsoft.EntityFrameworkCore` 11.0.0 を対象に書かれていますが、メッセージのテキストと挙動は EF Core 2.1 から変わっていません。

```text
System.InvalidOperationException: The seed entity for entity type 'Country' cannot be added
because a non-zero value is required for property 'Id'. Consider providing a negative value
to avoid collisions with non-seed data.
   at Microsoft.EntityFrameworkCore.Metadata.Internal.EntityType.<>c__DisplayClass...
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.ValidateData(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.Validate(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Metadata.Conventions.Infrastructure.ModelRuntimeInitializer.Initialize(...)
```

これはモデル検証エラーであり、実行時のクエリエラーではありません。EF Core が初めてモデルを構築するときに発生します。最初のクエリ、最初の `SaveChanges`、最初の `context.Model` へのアクセス、または最も多いのは `dotnet ef migrations add` を実行したときです。引用符内の型名はシードしたエンティティで、引用符内のプロパティはその主キーです。末尾の "consider providing a negative value" というヒントは穴埋めではなく本物の助言であり、下のコリジョンに関するセクションでその理由を説明します。

## なぜ HasData はキーを明示的に書く必要があるのか

`HasData`（ドキュメントでは現在 [model managed data](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) と呼ばれています。"seeding" という名前は実態以上のものを期待させたためです）はマイグレーションに属します。マイグレーションを追加すると、EF Core は現在のモデルのシード行を、最後のモデルスナップショットに記録した行と比較し、それらを調整するために `InsertData`、`UpdateData`、`DeleteData` の呼び出しを生成します。この比較はデザイン時に、あなたのマシン上で、データベース接続なしに行われます。

その比較を可能にしているのが主キーです。EF Core はこれを使って「これは前のマイグレーションで挿入したのと同じ行だが Name が変わった」と「これはまったく新しい行だ」を区別します。安定したキー値がなければ、マイグレーション間で突き合わせる手がかりがありません。そのためモデルバリデーターは厳格なルールを課します。すべての `HasData` 行は、そのキーがストア生成として構成されている場合でも、主キーの明示的な値を持たなければなりません。

キーがストア生成で、それを CLR の既定値のままにすると、EF Core は「開発者がキーの設定を忘れた」のか「開発者がキー 0 を望んでいる」のかを区別できません。`Id = 0` の行を黙って挿入する（これは identity 列とひどく衝突します）のではなく、例外をスローします。[model managed data の制限事項リスト](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) はこれを最初に挙げています。「主キーの値は、通常はデータベースが生成する場合でも指定する必要があります。マイグレーション間のデータ変更を検出するために使われます。」

## 最小の再現

従来どおりの `Id` を持つ単一のエンティティと、それを省略した一つの `HasData` 呼び出しです。

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore 11.0.0
public class Country
{
    public int Id { get; set; }      // conventional PK -> store-generated IDENTITY
    public string Name { get; set; } = "";
}

public class AppDbContext : DbContext
{
    public DbSet<Country> Countries => Set<Country>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=SeedRepro;Trusted_Connection=True");

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Country>().HasData(
            new Country { Name = "USA" },      // no Id -> Id stays 0 -> throws
            new Country { Name = "Canada" });
    }
}
```

これに対して `dotnet ef migrations add Seed` を実行すると、例外が発生します。`Id` プロパティは `0` で、EF Core はストア生成の `int` キーにとって `0` を「値なし」として扱い、マイグレーションコードが書き出される前に検証が失敗します。

## 修正 1: 各シード行に明示的で安定したキーを与える

これは本物の参照データに対する正しい修正です。マイグレーションを通じてのみ変わる、小さく固定的なルックアップテーブル（国、通貨、ロール、ステータス）です。各行にキー値を手で割り当て、決して再利用したり番号を振り直したりしないでください。

```csharp
// .NET 11, C# 14, EF Core 11.0.0
modelBuilder.Entity<Country>().HasData(
    new Country { Id = 1, Name = "USA" },
    new Country { Id = 2, Name = "Canada" },
    new Country { Id = 3, Name = "Mexico" });
```

時間が経ってもこれを機能させ続ける二つのルールがあります。

1. **キー値はいまやスキーマ履歴の一部です。** 不変として扱ってください。行 2 を `Id = 2` から `Id = 22` に変えると、次のマイグレーションは `2` への `DeleteData` と `22` への `InsertData` を生成し、古い行と、それを外部キーで参照していたものをすべて捨ててしまいます。
2. **値は明示的に選び、勝手に変動させないでください。** ハードコードされた定数で構いません。やってはいけないのは、非決定的なもの（コレクションの順序に依存するループカウンター、`DateTime.Now`、`Guid.NewGuid()` の呼び出し）からそれらを計算することです。マイグレーションの比較は、どのマシンでも同じ値を生成しなければならないからです。

キーが `Guid` の場合も同じルールが当てはまります。`Guid.NewGuid()` ではなく、固定のハードコードされた `Guid` を与えてください。ビルドのたびに新しく生成される GUID は、すべてのマイグレーションに行が変わったと思わせます。

```csharp
// .NET 11, C# 14, EF Core 11.0.0 - fixed GUIDs, not Guid.NewGuid()
modelBuilder.Entity<Role>().HasData(
    new Role { Id = new Guid("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), Name = "Admin" },
    new Role { Id = new Guid("3f2504e0-4f89-41d3-9a0c-0305e82c3302"), Name = "User" });
```

## 修正 2: identity の衝突を避けるために負のキーを使う

例外自身のヒント "consider providing a negative value to avoid collisions with non-seed data" は、目の前の問題ではなく、後で遭遇する問題を解決します。SQL Server の `IDENTITY` 列に `Id = 1, 2, 3` をシードすると、identity カウンターはあなたのシード行を知りません。シード後の最初の本物の `INSERT` はカウンターを `1` から開始し、シードがすでに取得したキーを使おうとして主キー違反で失敗するか、`IDENTITY_INSERT` の仕組みが絡んで事態が厄介になります。

シードデータに負のキーを使うとこれを回避できます。ユーザーが生成する本物の行は `1` から上に数え、シードした参照行は `0` より下に存在し、決して重なりません。

```csharp
// .NET 11, C# 14, EF Core 11.0.0
modelBuilder.Entity<Country>().HasData(
    new Country { Id = -1, Name = "USA" },
    new Country { Id = -2, Name = "Canada" },
    new Country { Id = -3, Name = "Mexico" });
```

これは、実行時の挿入も受ける `IDENTITY` 由来のルックアップテーブルに対する EF Core チームの長年の推奨です。*シードのみ*が行われるテーブル（アプリが決して挿入しない純粋なルックアップテーブル）には過剰であり、そこでは正のキーのほうが自然に読めます。

## 修正 3: このデータには HasData を使うのをやめる

`HasData` に手を伸ばした理由が「データベースに初期行が少し欲しいだけ」なら、おそらく model managed data はまったく必要ありません。`HasData` は静的で決定的な、マイグレーションが所有するデータのために作られており、それ以外には向きません。データベース生成キーを使うべきデータ、他の行に依存するデータ、あるいは単に便利な起動時データには、EF Core チームは現在 [UseSeeding と UseAsyncSeeding](/ja/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/)（EF Core 9 で導入）を推奨しています。これらは稼働中のデータベースに対して本物の `SaveChanges` を実行するため、データベースがキーを生成し、ゼロ以外のルールは決して適用されません。

```csharp
// .NET 11, C# 14, EF Core 11.0.0
protected override void OnConfiguring(DbContextOptionsBuilder options)
    => options
        .UseSqlServer(connectionString)
        .UseSeeding((context, _) =>
        {
            if (!context.Set<Country>().Any())
            {
                // No Id set: the database generates it on SaveChanges. No error.
                context.Set<Country>().AddRange(
                    new Country { Name = "USA" },
                    new Country { Name = "Canada" });
                context.SaveChanges();
            }
        })
        .UseAsyncSeeding(async (context, _, ct) =>
        {
            if (!await context.Set<Country>().AnyAsync(ct))
            {
                context.Set<Country>().AddRange(
                    new Country { Name = "USA" },
                    new Country { Name = "Canada" });
                await context.SaveChangesAsync(ct);
            }
        });
```

`UseSeeding` は、保留中のマイグレーションがない場合でも、`EnsureCreated` と `Migrate`、そして `dotnet ef database update` から呼び出されます。同期版と非同期版の両方のオーバーロードを実装してください。EF Core のツールは同期版を呼び出し、非同期版しか存在しないとシードを黙ってスキップします。シードの本体はデザイン時のキー要件なしにアプリケーションコードとして実行されるため、ここで `Id` を省略するのはまさに正しく、データベースがそれを割り当てます。

## 同じエラーを生む変種

メッセージの文言はこれらすべてで同一なので、検索トラフィックはそのすべてでここに着地します。原因は常に同じ（`HasData` 行にストア生成キーの明示的な値が欠けている）ですが、現れ方が異なります。

- **所有（owned）エンティティと複合型。** `OwnsOne(...).HasData(...)` は各シード行に*所有者*のキーを必要とし、匿名オブジェクトで与えます: `new { CountryId = 1, ... }`。これを省くと、所有者のキープロパティに対してゼロ以外のエラーが出ます。
- **多対多の結合行。** `UsingEntity(...).HasData(...)` で結合テーブルをシードするには、各行に両方の外部キーが必要です。片方が欠けていたりゼロだったりすると同じエラーをスローします。結合エンティティの完全なセットアップは [EF Core 11 で多対多リレーションシップをシードする方法](/ja/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) を参照してください。
- **複合キー。** 複合キーの各列は各シード行で設定されていなければなりません。いずれかの部分のゼロが、そのプロパティに対してエラーを引き起こします。
- **値変換されたキー。** 値コンバーターに支えられた厳密に型付けされた ID（`record struct CountryId(int Value)`）でも、既定値以外の値が必要です。既定のインスタンスはストアの既定値に変換され、それが「値なし」として数えられます。

異なるものの混同しやすいエラーが `The seed entity for entity type 'X' cannot be added because there was no value provided for the required property 'Y'` で、ここで `Y` は `Name` のようなキーでない必須プロパティです。これはシード行で `[Required]` または `IsRequired()` の列が null のままになっていることを意味し、キーが欠けていることではありません。そこでの修正は、欠けているキーでないプロパティを埋めることです。

EF Core がそもそも型のキーを見つけられないために、モデルがシードデータを検証するところまで構築されない場合は、別の問題を見ています。[the entity type requires a primary key to be defined](/ja/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) の修正を参照してください。

## なぜ「Id = 0 を明示的に設定すればよい」は機能しないのか

魅力的だが間違った対処は、`new Country { Id = 0, Name = "USA" }` と書いて、明示すればバリデーターを満たせると考えることです。満たせません。ストア生成キーに対して、EF Core は値を CLR の既定値と比較し、`int` にとって `0` は*まさに*既定値です。バリデーターはあなたの意図的な `0` を未設定のフィールドと区別できないため、依然として例外をスローします。通るのは既定値以外の値だけです。ゼロ以外の任意の `int`、空でない任意の `Guid`、既定値でない任意の複合キーです。本当にキー `0` の行が必要なら、それはそのキーがストア生成であるべきでない兆候です。`ValueGeneratedNever()` を付ければ、キーは完全にあなたの責任になるため、バリデーターはゼロ以外のルールの適用をやめます。

```csharp
// .NET 11, C# 14, EF Core 11.0.0 - opt out of store generation, then 0 is allowed
modelBuilder.Entity<Country>(b =>
{
    b.Property(c => c.Id).ValueGeneratedNever();
    b.HasData(new Country { Id = 0, Name = "Unknown" });   // now valid
});
```

これは「不明」を表すセンチネル行のための本物のパターンですが、意図的に行ってください。いったんキーが `ValueGeneratedNever` になると、そのテーブルへの今後のすべての挿入は、アプリからの実行時の挿入も含め、自前のキーを与えなければなりません。

## 関連

- [EF Core 11 で UseSeeding と UseAsyncSeeding を使ってデータをシードする方法](/ja/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/) は、このエラーを完全に避ける現代的な実行時シードの道筋を扱っています。
- [EF Core 11 で多対多リレーションシップをシードする方法](/ja/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/) は、このエラーがよく現れる結合エンティティの `HasData` を順を追って説明します。
- [修正: The entity type 'X' requires a primary key to be defined](/ja/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) は、EF Core がそもそもキーを発見できないときの上流のエラーです。
- [EF Core 6 から EF Core 11 への移行: 本当に効く破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) は、古いシード設定をアップグレードする場合に他に何が動いたかを扱っています。

## ソース

- Microsoft Learn の EF Core [data seeding ドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding): 「model managed data」セクション、その制限事項リスト（「主キーの値は、通常はデータベースが生成する場合でも指定する必要があります」）、および `UseSeeding`／`UseAsyncSeeding` という代替手段。
- [dotnet/efcore #27871, "Warn when seeding with a 0 key"](https://github.com/dotnet/efcore/issues/27871): この例外の背後にあるゼロキーのケースについてのチームの議論。
- [dotnet/EntityFramework.Docs #1528](https://github.com/dotnet/EntityFramework.Docs/issues/1528): `IDENTITY` 由来のテーブルで負のシードキーを使う根拠。
