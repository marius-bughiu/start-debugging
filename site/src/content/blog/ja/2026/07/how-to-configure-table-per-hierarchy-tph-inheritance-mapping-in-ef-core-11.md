---
title: "EF Core 11 で Table-per-Hierarchy (TPH) の継承マッピングを構成する方法"
description: "TPH は EF Core の既定の継承戦略です。1 つのテーブルと 1 つの識別子列を使います。識別子の構成、列の共有、派生型の null 許容プロパティの扱い、そして EF Core 11 での注意点を解説します。"
pubDate: 2026-07-13
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "inheritance"
  - "tph"
  - "dotnet-11"
  - "how-to"
lang: "ja"
translationOf: "2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-13
---

手短に言うと、EF Core 11（.NET 11 と C# 14）では、Table-per-Hierarchy (TPH) を得るために何もする必要はありません。これが既定です。基底型と少なくとも 1 つの派生型をマッピングした時点で、EF Core は階層全体を 1 つのテーブルに格納し、行を区別するために文字列の `Discriminator` 列を追加します。構成とは、この既定を調整することです。`HasDiscriminator` で識別子列の名前を変更し、`HasValue` で格納される値を選び、識別子を実際のプロパティにマッピングし、`IsComplete(false)` で階層を不完全とマークし、兄弟型どうしで列を共有します。EF Core 11 は、継承階層で複雑型と JSON 列を使えるようにして長年の制約を取り除き、さらに JSON にマッピングされた複雑型に対する TPH 固有の null 許容バグを修正しています。

この記事では、正確な構成 API、EF Core が生成するスキーマ、TPH 階層に対するクエリが実際にどう動くか、誰もが一度は引っかかる null 許容列の落とし穴、そして TPH が正しい選択でなくなるのはいつかを扱います。

## なぜ TPH が既定であり、たいてい正しいのか

EF Core は 3 つのリレーショナル継承戦略をサポートします。Table-per-Hierarchy (TPH)、Table-per-Type (TPT)、Table-per-Concrete-Type (TPC) です。TPH が既定なのは、よくあるケースで最も高速だからです。すべてが 1 つのテーブルに収まるため、エンティティの読み込みは join のない単一行の読み取りで済み、基底型のクエリは `UNION` もテーブルへの分散もない素朴な `SELECT` になります。[EF Core の継承ドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)も[パフォーマンスガイダンス](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping)も同じ結論に至ります。ベンチマークや外部的な制約に迫られない限り、TPH を使いましょう。

支払う代償は、より幅が広く疎なテーブルです。各派生型のすべてのプロパティが共有テーブルの列になり、一部の行しか使わない列はすべて null 許容にする必要があります。ほとんどの階層ではこのトレードオフで問題ありません。問題になったときは TPT または TPC へ移ります。これは末尾で扱う別の判断です。

## 何も構成しない既定のマッピング

EF はアセンブリをスキャンして派生型を探すことはしません。各型はモデルに明示的に含めます。通常は `DbSet` を公開するか、`OnModelCreating` で参照します。次は 2 階層の例です。

```csharp
// .NET 11, C# 14, EF Core 11
public class Payment
{
    public int Id { get; set; }
    public decimal Amount { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class CardPayment : Payment
{
    public string Last4 { get; set; } = "";
    public string Network { get; set; } = "";
}

public class BankTransferPayment : Payment
{
    public string Iban { get; set; } = "";
}
```

```csharp
// .NET 11, EF Core 11
public class PaymentsContext : DbContext
{
    public DbSet<Payment> Payments { get; set; } = null!;
    public DbSet<CardPayment> CardPayments { get; set; } = null!;
    public DbSet<BankTransferPayment> BankTransferPayments { get; set; } = null!;
}
```

継承の構成をまったく行わない場合、EF Core 11 はすべての型のすべてのプロパティを含む 1 つのテーブルを生成し、そこに暗黙的に追加する `Discriminator` 列を加えます。

```sql
CREATE TABLE [Payments] (
    [Id] int NOT NULL IDENTITY,
    [Amount] decimal(18,2) NOT NULL,
    [CreatedAt] datetime2 NOT NULL,
    [Discriminator] nvarchar(max) NOT NULL,
    [Last4] nvarchar(max) NULL,
    [Network] nvarchar(max) NULL,
    [Iban] nvarchar(max) NULL,
    CONSTRAINT [PK_Payments] PRIMARY KEY ([Id])
);
```

注目すべき点が 2 つあります。識別子は CLR の型名（`"CardPayment"`、`"BankTransferPayment"`、`"Payment"`）を格納する文字列の列で、EF が各行でどの型をマテリアライズすべきかを知るためのものです。そして `Last4`、`Network`、`Iban` はすべて null 許容です。`BankTransferPayment` の行にはカードのフィールドがなく、`CardPayment` の行には IBAN がないからです。この null 許容は自動であり、後で見るとおり、派生型のプロパティに対して上書きすることはできません。

## TPH のクエリが型でフィルタリングする仕組み

基底型をクエリすると、EF Core は各行を読み取り、識別子を使って行ごとに正しい具象オブジェクトを構築します。

```csharp
// .NET 11, EF Core 11
var all = await context.Payments.ToListAsync();
// SELECT [p].[Id], [p].[Amount], [p].[CreatedAt], [p].[Discriminator],
//        [p].[Last4], [p].[Network], [p].[Iban]
// FROM [Payments] AS [p]
```

派生型をクエリすると、EF は識別子に対する述語を追加し、一致する行だけが返るようにします。

```csharp
// .NET 11, EF Core 11
var cards = await context.CardPayments
    .Where(c => c.Network == "Visa")
    .ToListAsync();
// ... WHERE [p].[Discriminator] = N'CardPayment' AND [p].[Network] = N'Visa'
```

基底型のクエリ内で `OfType<T>()` や C# の型パターンを使って型でフィルタリングすることもでき、どちらも同じ識別子の述語に変換されます。

```csharp
// .NET 11, EF Core 11
var cardsOnly = await context.Payments.OfType<CardPayment>().ToListAsync();
```

知っておくべきマテリアライズの規則が 1 つあります。テーブルにモデル内のどの型にもマッピングされていない識別子値が含まれていると、その行に到達した時点で EF は例外をスローします。何を構築すべきか分からないからです。これは EF 以外の何かが未知の識別子を持つ行を書き込んだ場合にのみ起こります。もしそれが自分の状況であれば、マッピングを不完全とマークして（後述）、基底型のクエリでも EF が常に識別子のフィルタ述語を追加するようにします。

## 識別子列とその値を構成する

暗黙の `Discriminator` 列と、そこに格納される CLR の型名は、付き合っていかなければならないスキーマにおいて望むものであることはまれです。`HasDiscriminator` と `HasValue` で列名を変更し、型を固定し、安定した文字列値を選びましょう。

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Payment>()
        .HasDiscriminator<string>("payment_type")
        .HasValue<Payment>("base")
        .HasValue<CardPayment>("card")
        .HasValue<BankTransferPayment>("bank_transfer");
}
```

明示的な `HasValue` の文字列を固定することは、見た目以上に重要です。既定（CLR の型名）に頼ると、後のリファクタリングでクラス名を変更したときに、格納される識別子値が黙って変わり、本番の既存のすべての行が、新しいモデルの認識しない値を持つことになります。明示的な値は、データベースをクラス名から切り離します。

識別子は文字列である必要はありません。`int` や `enum` はより小さく、インデックスの効きも良くなります。

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator<int>("payment_type")
    .HasValue<Payment>(0)
    .HasValue<CardPayment>(1)
    .HasValue<BankTransferPayment>(2);
```

EF は識別子を[シャドウプロパティ](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties)として暗黙的に追加するため、他のプロパティと同じように構成できます。たとえば `nvarchar(max)` にならないように文字列長を制限できます。

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .Property("payment_type")
    .HasMaxLength(20);
```

## 識別子を実際の .NET プロパティにマッピングする

型のタグを、シャドウプロパティに隠すのではなく、エンティティ自体で読めるようにしたい場合があります。基底型にプロパティを追加し、`HasDiscriminator` をそれに向けます。

```csharp
// .NET 11, C# 14, EF Core 11
public class Payment
{
    public int Id { get; set; }
    public decimal Amount { get; set; }
    public DateTime CreatedAt { get; set; }
    public string PaymentType { get; set; } = "";
}
```

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator(p => p.PaymentType)
    .HasValue<CardPayment>("card")
    .HasValue<BankTransferPayment>("bank_transfer");
```

これで、読み込まれるすべてのエンティティで `payment.PaymentType` が設定されます。EF が値を管理します。insert 時に具象型に基づいて設定し、型と矛盾する値を書き込むことは許しません。コードからは読み取り専用として扱ってください。マッピングされた識別子は、レポート用のクエリや、クライアントがリフレクションなしで型名を必要とする API レスポンスに便利です。

## 階層が不完全であることを EF に伝える

別のシステムが、あなたが意図的にマッピングしない識別子値を持つ行を同じテーブルに書き込む場合、識別子を不完全とマークして、基底型のクエリを含め EF が常にフィルタリングするようにします。

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator()
    .IsComplete(false);
```

`IsComplete(false)` を指定すると、`context.Payments.ToListAsync()` は `WHERE [payment_type] IN (N'card', N'bank_transfer', ...)` を追加し、識別子がマッピングされていない行に対して例外をスローする代わりにそれらをスキップします。これはまさに、EF が型の一部だけを所有する共有テーブルのための逃げ道です。

## 兄弟型どうしで列を共有する

既定では、同じ名前のプロパティをそれぞれ宣言する 2 つの兄弟型は、2 つの別々の列を得ます。プロパティが同じ型であり、本当に同じ格納を表すのであれば、`HasColumnName` で 1 つの列にマッピングします。

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<CardPayment>()
    .Property(c => c.Reference)
    .HasColumnName("Reference");

modelBuilder.Entity<BankTransferPayment>()
    .Property(b => b.Reference)
    .HasColumnName("Reference");
```

これでテーブルは狭く保たれますが、ドキュメントが明示的に指摘しているクエリの罠があります。リレーショナルプロバイダーは、キャストを介して共有列を読むとき、識別子の述語を追加しません。`(payment as CardPayment).Reference` のようなクエリは、列が物理的に共有されているため、兄弟の行についても `Reference` の値を返します。1 つの型に限定するには、自分で型による分岐を行う必要があります。

```csharp
// .NET 11, EF Core 11 - guard the cast so siblings return null
var refs = await context.Payments
    .Select(p => p is CardPayment ? ((CardPayment)p).Reference : null)
    .ToListAsync();
```

値が本当に同じ概念であるときにのみ列を共有してください。迷ったら、EF に各兄弟へ独自の null 許容列を与えさせましょう。

## 誰も予想しない null 許容列の落とし穴

これが人々を驚かせるものです。派生型で必須のプロパティは、TPH では `NOT NULL` 列にできません。すべての型が 1 つのテーブルを共有するため、`CardPayment` に属する列は、`BankTransferPayment` の行が空のままにできるよう null 許容でなければなりません。`Last4` が C# で `required` であっても、EF Core はそれを null 許容列としてマッピングせざるを得ません。

```sql
[Last4] nvarchar(max) NULL   -- required on CardPayment, still NULL in the DB
```

データベースは「すべてのカード支払いに Last4 がある」ことを代わりに強制しません。アプリケーション層と EF Core 自身の検証が書き込み時に強制しますが、生の `INSERT` や不適切なマイグレーションは `Last4` が null のカード行を生み出す可能性があり、スキーマはそれを止めません。派生プロパティに対するデータベース強制の非 null が譲れない要件であれば、それは TPT を選ぶ本物の理由になります（各型が独自のテーブルを得るため、そこでは列を `NOT NULL` にできます）。あるいはマイグレーションで手作業で `CHECK` 制約を追加します。これはチームが階層を TPH から移す最も一般的な理由なので、決める前に検討してください。

## EF Core 11 が継承のために変えたこと

TPH 自体は何年も安定しています。EF Core 11 の変更は、階層の中に何を入れられるかに関するものです。複雑型と JSON 列が、TPT および TPC 継承を使うエンティティ型で使えるようになりました。これは以前はサポートされておらず、継承された値オブジェクトのために所有エンティティ（owned）へ戻ることを強いていました。TPH は既に複雑型をサポートしていましたが、EF Core 11 は、[JSON として格納された複雑型プロパティが TPH クラス階層で誤って非 null とマークされる](https://github.com/dotnet/efcore/issues/37404) TPH 固有のバグを修正しました。これで、TPH テーブルにマッピングされた値オブジェクトは、あるべき形で null 許容として振る舞います。

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class CardMetadata
{
    public required string Bin { get; set; }
    public string? IssuerCountry { get; set; }
}

public class CardPayment : Payment
{
    public string Last4 { get; set; } = "";
    public CardMetadata? Metadata { get; set; }
}
```

構成も全体的に短くなりました。EF Core 11 では、`Property` に渡すラムダの中でメンバーアクセスをそのまま連鎖できるため、複雑型や識別子に隣接するプロパティへ掘り下げる際に、中間のビルダーが不要になります。

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<CardPayment>()
    .Property(c => c.Metadata!.Bin)
    .HasMaxLength(8);
```

継承された値オブジェクトをテーブル分割や JSON のマッピングと組み合わせる場合、そのマッピングの仕組みは[EF Core 11 で所有エンティティの代わりに複雑型をマッピングする方法](/ja/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/)と同じで、JSON のクエリ側は[EF Core 11 で JSON 列をマッピングしてクエリする方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)で扱っています。

## 一括更新とクエリフィルターは TPH とうまく調和する

TPH 階層は 1 つのテーブルなので、`ExecuteUpdate` と `ExecuteDelete` は派生型をきれいに対象にでき、識別子の述語を自動で適用します。

```csharp
// .NET 11, EF Core 11
await context.CardPayments
    .Where(c => c.Network == "Amex")
    .ExecuteUpdateAsync(s => s.SetProperty(c => c.Amount, c => c.Amount * 1.03m));
// UPDATE [p] SET [p].[Amount] = ... WHERE [p].[payment_type] = N'card' AND ...
```

この経路とエンティティの読み込みとのトレードオフは、[EF Core 11 で一括書き込みに ExecuteUpdate と ExecuteDelete を使う方法](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)と同じです。クエリフィルターも識別子と組み合わさるため、基底型に対する論理削除やマルチテナントのフィルターは階層全体に適用されます。詳しくは[EF Core 11 で論理削除とマルチテナンシーに名前付きクエリフィルターを使う方法](/ja/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)を参照してください。

## いつ TPH を離れるべきか

次のいずれかに当てはまらない限り、TPH に留まってください。

- **派生プロパティにデータベース強制の非 null が必要である。** TPH ではできません。共有列は null 許容でなければなりません。TPT は各型に独自のテーブルを与えるので、そこでは列を `NOT NULL` にできます。
- **テーブルが本当に疎で幅広になってきている。** 多くの派生型を持ち、それぞれがコード上で必須の列を複数追加する階層は、ほとんどが null のテーブルを生みます。それがストレージに悪影響を与えたり DBA が拒否したりする場合、TPT は join と引き換えにこれを正規化します。
- **主に単一のリーフ型をクエリし、ベンチマークが TPC の勝ちを示す。** TPC は各具象型をすべての列をインラインにして独自のテーブルに保持し、単一リーフ型のクエリで TPH を上回ることがあります。切り替える前に計測してください。TPC は独自のキー生成と外部キー制約を伴います。

なお、実行時にエンティティの型を変える（`CardPayment` を `BankTransferPayment` にする）ことは、どの戦略でもサポートされていません。削除して挿入し直します。これはモデリング上の現実であり、TPH の制限ではありません。

実践的な規則としては、TPH が既定なのは、それが正しい既定だからです。スキーマがクラス名に依存しないように識別子を構成し、派生型の列は常に null 許容であることを覚えておき、具体的な制約や実際のベンチマークが示したときにのみ TPT や TPC に手を伸ばしてください。この判断がより大きなバージョンアップの一部であれば、[EF Core 6 から EF Core 11 へのマイグレーションガイド](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)が、これと並んで表面化しがちな継承とマッピングの変更を扱っています。

## 関連記事

- [EF Core 11 で所有エンティティの代わりに複雑型をマッピングする方法](/ja/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/)は、継承階層の中でも動くようになった値オブジェクトのマッピングを解説します。
- [EF Core 11 で JSON 列をマッピングしてクエリする方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)は、TPH テーブルにおける複雑型プロパティの JSON 側を扱います。
- [EF Core 11 で一括書き込みに ExecuteUpdate と ExecuteDelete を使う方法](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)は、識別子の述語がきれいに保つ一括書き込みの経路を示します。
- [EF Core 11 で論理削除とマルチテナンシーに名前付きクエリフィルターを使う方法](/ja/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)は、グローバルフィルターを TPH 階層と組み合わせます。
- [Fix: The entity type requires a primary key to be defined（EF Core 11）](/ja/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined)は、基底型や派生型にキーが欠けているときの補足です。

## 参照

- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [What's New in EF Core 11: complex types and JSON on TPT/TPC](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Modeling for performance: inheritance mapping](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping)
- [EF Core shadow properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties)
- [Complex property stored as JSON marked non-nullable in TPH class hierarchy (efcore#37404)](https://github.com/dotnet/efcore/issues/37404)
