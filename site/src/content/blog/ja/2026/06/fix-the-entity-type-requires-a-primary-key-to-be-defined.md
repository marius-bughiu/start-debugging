---
title: "解決: EF Core 11 の The entity type 'X' requires a primary key to be defined"
description: "EF Core が型の主キーを見つけられません。プロパティを Id か {Type}Id と名付ける、[Key] を付ける、HasKey を呼ぶ、もしくはビューや生の SQL なら HasNoKey を呼びます。"
pubDate: 2026-06-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "ja"
translationOf: "2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined"
translatedBy: "claude"
translationDate: 2026-06-12
---

解決方法: EF Core はモデルを構築する際、エンティティだとみなした型を見つけたものの、その主キーを見つけられません。実用的な選択肢は次の3つで、順番どおりに検討します。型にキーを与える（プロパティを `Id` か `{Type}Id` と名付ける、`[Key]` を付ける、または `modelBuilder.Entity<T>().HasKey(...)` を呼ぶ）。型が意図的にキーを持たないことを `HasNoKey()` で EF Core に伝える（ビューや生の SQL の結果に対して正しい方法です）。あるいは余分な `DbSet<T>` を削除するか `modelBuilder.Ignore<T>()` を呼んで、EF Core にそれをエンティティとして扱わせない。型が実際に何であるかに一致するものを選んでください。

```text
System.InvalidOperationException: The entity type 'OrderSummary' requires a primary key to be defined.
If you intended to use a keyless entity type, call 'HasNoKey' in 'OnModelCreating'.
For more information on keyless entity types, see https://go.microsoft.com/fwlink/?linkid=2141943.
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.ValidateNonNullPrimaryKeys(IModel model)
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.Validate(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Metadata.Conventions.Infrastructure.ModelRuntimeInitializer.Initialize(...)
```

これはモデル検証のエラーであり、実行時のクエリエラーではありません。EF Core が初めてモデルを構築するときに発生します。最初のクエリ、最初の `SaveChanges`、最初の `dotnet ef` コマンド、または `context.Model` の呼び出しです。引用符内の型名が、EF Core がキーを決められなかった型です。本記事は .NET 11、C# 14、`Microsoft.EntityFrameworkCore` 11.0.0 を対象に書いています。動作とメッセージ文言は EF Core 7 から変わっていないため、ここで述べる内容はそのバージョンまで遡って当てはまります。

## "requires a primary key" が実際に意味すること

EF Core はモデルを構築するとき、一連の規約を実行します。そのうちの1つ `KeyDiscoveryConvention` は、大文字小文字を区別せずに `Id` または `{EntityTypeName}Id` という名前のプロパティを探して、各エンティティ型の主キーを選ぼうとします。そのようなプロパティがちょうど1つ見つかれば、それがキーになります。1つも見つからなければエンティティはキーなしのままになり、その後 `ModelValidator` が実行され、明示的にキーなしと指定されていないキーなしエンティティを拒否します。その拒否が、あなたが今読んでいる例外です。

つまりこのエラーは、常に次の2つのいずれかを意味します。

1. EF Core はこの型をエンティティだとみなしているが、規約がキーを発見できず、あなたも何も設定していない。
2. EF Core はこの型をそもそもエンティティとして扱うべきではないのに、何かがそれをモデルに引き込んでしまった。

修正のすべては、どちらが当てはまるかを見極めることです。2つの問いで決着します。この型は、私が読み書きする実在のテーブルまたはビューに対応していて、自然な一意の識別子を持っているか。両方が「はい」なら、その型はキーを必要としています。それが射影、レポート行、または生の SQL の結果なら、`HasNoKey` を必要とするか、モデルから完全に外すべきです。

## 最小の再現

キーとなるプロパティが、規約が認識する名前になっていない型の `DbSet` です。

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class AppDb : DbContext
{
    public DbSet<OrderSummary> OrderSummaries => Set<OrderSummary>();

    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}

public class OrderSummary
{
    public Guid Reference { get; set; }   // not "Id", not "OrderSummaryId"
    public decimal Total { get; set; }
}
```

`Reference` は申し分のない識別子ですが、規約はそれを知りません。規約は `Id` か `OrderSummaryId` を探し、どちらも見つからず、型をキーなしのままにし、検証が失敗しました。SQL ビューをクラスにマッピングしたとき、`FromSql` の行をマッピングされていない型に返したとき、または誤って DTO を `DbSet` として公開したときにも、同じエラーが出ます。

## 解決1: 型にキーを与える

型が、あなたがクエリして永続化する実在のエンティティであるときに使います。明示性が高くなる順に3つの方法があります。

規約が見つけられるようプロパティ名を変更します。

```csharp
// .NET 11, EF Core 11.0.0 -- convention discovers this automatically
public class OrderSummary
{
    public Guid Id { get; set; }          // discovered by KeyDiscoveryConvention
    public decimal Total { get; set; }
}
```

あるいは独自の名前を保ったまま注釈を付けます。

```csharp
// .NET 11, EF Core 11.0.0
public class OrderSummary
{
    [Key]
    public Guid Reference { get; set; }
    public decimal Total { get; set; }
}
```

あるいは `OnModelCreating` で設定します。型に属性を付けられない、または付けたくない場合（たとえばクラスが EF Core を参照してはならないドメインプロジェクトにある場合）には、ここが正しい場所です。

```csharp
// .NET 11, EF Core 11.0.0
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderSummary>().HasKey(o => o.Reference);
}
```

複合キーには匿名オブジェクトを渡します。列の順序を確実に定義する `[Key]` 属性の同等物は存在しないため、Fluent な形式を選んでください。

```csharp
// .NET 11, EF Core 11.0.0 -- composite key, order matters for the index
modelBuilder.Entity<OrderLine>().HasKey(l => new { l.OrderId, l.LineNumber });
```

この解決の中の落とし穴が1つあります。キーとなるプロパティは、読み取り可能でマッピングされた CLR プロパティでなければなりません。public な**フィールド**、`[NotMapped]` が付いたプロパティ、または EF Core がマッピングできない型のプロパティは発見されず、「そこに明らかに Id があるのに」エラーが出続けます。マッピング可能な型（`int`、`long`、`Guid`、`string` など）の自動プロパティにしてください。

## 解決2: HasNoKey で型をキーなしと宣言する

型に本当に主キーがないときに使います。データベースのビュー、ストアドプロシージャの結果の形、または読み取り専用のレポート行などです。キーなしエンティティ型は読み取り専用で、変更追跡機能によって追跡されることはなく、`SaveChanges` に参加できません。

```csharp
// .NET 11, EF Core 11.0.0 -- a view with no natural key
modelBuilder.Entity<OrderSummary>()
    .HasNoKey()
    .ToView("vw_OrderSummary");
```

属性の形式はクラスに付ける `[Keyless]` で、`HasNoKey()` の呼び出しと同等です。

```csharp
// .NET 11, EF Core 11.0.0
[Keyless]
public class OrderSummary
{
    public Guid Reference { get; set; }
    public decimal Total { get; set; }
}
```

キーなしの型がビューではなく生の SQL から供給される場合は、テーブルではなくクエリにマッピングします。

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Entity<OrderSummary>()
    .HasNoKey()
    .ToSqlQuery("SELECT Reference, SUM(Total) AS Total FROM Orders GROUP BY Reference");
```

実際に同一性を持つ型に対して、エラーを消すためだけに `HasNoKey` に頼ってはいけません。キーなしエンティティはコンテキスト経由で更新も削除もできず、EF Core は同じ値を共有する行を重複排除しないため、メモリ上で気付かないうちに重複が生じることがあります。`HasNoKey` はデータについての宣言であって、回避策ではありません。

## 解決3: EF Core にその型を一切マッピングさせない

多くの場合、その型はエンティティではなく、そもそもエンティティであるべきではありませんでした。次の3つのいずれかでモデルに引き込まれています。

- 射影や view-model のために `DbSet<SomeDto>` を追加した。それを削除し、代わりに `Select` で DTO に射影します。
- マッピングされたエンティティがその型を指すナビゲーションプロパティを持っているため、EF Core が推移的にマッピングした。そのナビゲーションがリレーションシップであるべきでないなら、`[NotMapped]` を付けます。
- どこかで `modelBuilder.Entity<SomeDto>()` を呼んだ（多くは単一のプロパティを設定するため）ため、それがエンティティとして登録された。

型を明示的に除外するには、無視します。

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Ignore<OrderSummary>();
```

または、推移的マッピングを引き起こしているプロパティに対して指定します。

```csharp
// .NET 11, EF Core 11.0.0
public class Order
{
    public int Id { get; set; }

    [NotMapped]
    public OrderSummary? Computed { get; set; }   // a view model, not a relationship
}
```

1回限りの射影では、そもそもマッピングされた型は必要ないことがほとんどです。欲しい形に直接射影すれば、EF Core はそれにキーを付けようとしません。

```csharp
// .NET 11, EF Core 11.0.0 -- no DbSet, no HasNoKey, nothing to key
var summaries = await db.Orders
    .GroupBy(o => o.CustomerId)
    .Select(g => new OrderSummary { Reference = g.Key, Total = g.Sum(o => o.Total) })
    .ToListAsync();
```

## この同じエラーに行き着くバリエーション

### Id のない record をマッピングする

位置指定の `record` はエンティティとして問題なく機能しますが、そのパラメータの1つが発見可能なキーになる場合に限られます。`public record OrderSummary(Guid Reference, decimal Total);` は、クラスと同じ理由でこのエラーになります。`Reference` は `Id` ではありません。最初のパラメータを `Id` と名付けるか、位置指定パラメータに `[property: Key]` を付けるか、`OnModelCreating` で `HasKey` を設定します。init-only プロパティや値の等価性を含む record のマッピングの仕組みは、[EF Core 11 で record を正しく使う](/2026/04/how-to-use-records-with-ef-core-11-correctly/)のガイドで扱っています。

### Database.SqlQuery<T> と FromSql の結果型

`db.Database.SqlQuery<OrderSummary>($"...")` は、クエリ時に `OrderSummary` を暗黙のキーなし型としてマッピングし、その経路には設定は不要です。しかし、同じ型に対して別の場所で `modelBuilder.Entity<OrderSummary>()` も呼んでいると、それを通常のエンティティとして登録したことになり、規約がキーを要求します。その型を `OnModelCreating` から完全に外す（`SqlQuery` に任せる）か、`HasNoKey()` で明示的に登録するかのどちらかにします。これは [dotnet/efcore#35575](https://github.com/dotnet/efcore/issues/35575) の根本原因で、そこではクエリ型が同名の設定済みエンティティと衝突しました。

### エラーが、あなたが書いていない型を挙げている

引用符内の型がフレームワークやライブラリの型なら、ナビゲーションがそれを引き込んでいます。それを参照しているエンティティを見つけて判断します。本物のリレーションシップ（参照先の型でキーを設定する）か、そうでないか（ナビゲーションに `[NotMapped]` を付けるか、型を `Ignore<T>()` する）。これは強く型付けされた JSON 列やスキーマをまたぐ外部キーでよく現れます。[dotnet/efcore#36614](https://github.com/dotnet/efcore/issues/36614) を参照してください。

### 実行時ではなく dotnet ef でのみ失敗する

`dotnet ef migrations add` と `dotnet ef database update` は完全なモデルを構築するため、狭い実行時のコードパスではまだ発火していなかったモデルエラーを表面化させます。エラーは本物で、ツールが先に見つけただけです。デザイン時のビルドがコンテキストを構築すらできない場合は、先に別のメッセージが出ます。それは [なぜ dotnet ef migrations add が DbContext を作成できないのか](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) で扱っています。

### null 許容、またはシャドウされたキー

キーとなるプロパティが null 許容（`int?`）の場合、EF Core はそれを発見しますが、`ModelValidator` は null の主キーを、よく似たメッセージで拒否します。キーを null 非許容にしてください。同様に、基底クラスと派生クラスの両方が `Id` を宣言していると、シャドウされたメンバーが発見を混乱させることがあります。キーは EF Core がマッピングする型で一度だけ宣言してください。

## 修正の確認

3つの解決のいずれかを適用したら、アプリを実行せずにモデルのビルドを強制して、フィードバックループを速くします。

```bash
# .NET 11 SDK, EF Core tools 11.0.0
dotnet ef dbcontext info --startup-project ./Api
```

モデルが有効なら、これはプロバイダーとコンテキストの詳細を出力します。型がまだキーなしで未指定なら、同じ例外をスローし、メッセージがどの型が未解決のままかを正確に伝えます。1つずつ対処してください。複数のビュー型や DTO 型を持つモデルは、それぞれが処理されるまで型ごとに1回ずつスローすることがあります。

覚えておく価値のあるメンタルモデル: このエラーは、EF Core があなたに型を分類するよう求めているものです。同一性を持つエンティティ、キーなしの読み取り専用の形、または非エンティティ。それに答えれば、修正は機械的です。これらの型をテストに組み込み、変更追跡を正しく振る舞わせたいときは、[変更追跡を壊さずに DbContext をモックする](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)と[最初のクエリの前に EF Core のモデルをウォームアップする](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)のパターンが、キーを正しく設定することとよく噛み合います。

## 出典

- [Keyless entity types](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)、EF Core ドキュメント。`HasNoKey`、`[Keyless]`、読み取り専用の制約について。
- [Keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys)、EF Core ドキュメント。規約による発見、`[Key]`、複合キーについて。
- [Model validation and conventions](https://learn.microsoft.com/en-us/ef/core/modeling/)、EF Core ドキュメント。
- [dotnet/efcore#29198](https://github.com/dotnet/efcore/issues/29198) と [dotnet/efcore#35575](https://github.com/dotnet/efcore/issues/35575)、このメッセージの背後にある正典的な issue。
