---
title: "EF Core 11 で所有エンティティの代わりに複合型をマッピングする方法"
description: "所有エンティティは値オブジェクトと相性の悪い隠れたキーと参照同一性を持ちます。EF Core 11 で値オブジェクトを複合型としてマッピングする方法、切り替えるべきタイミング、そして注意点を解説します。"
pubDate: 2026-07-12
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "complex-types"
  - "owned-entities"
  - "dotnet-11"
  - "how-to"
lang: "ja"
translationOf: "2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

手短に言うと、EF Core 11（.NET 11 と C# 14）では、`Address` や `Money` のような値オブジェクトを `OwnsOne` ではなく `ComplexProperty` でマッピングします。複合型はキーも同一性も持たないため、EF Core はそれを値のセマンティクスで扱います。代入するとフィールドがコピーされ、比較すると内容が比較され、`ExecuteUpdate` でそのプロパティを操作できます。所有エンティティは内部的には依然としてエンティティ型であり、シャドウキーと参照同一性を持ちます。これこそが人々が遭遇する驚きの原因そのものです（共有された参照を代入できない、LINQ の等価比較が壊れる、一括更新がブロックされる）。複合型は EF Core 8 で導入され、EF Core 10 でオプション（null 許容）マッピングと JSON 列に対応し、EF Core 11 では TPT/TPC の継承階層で利用できるようになり、構成 API もすっきりしました。切り替えはモデル構成の変更と 1 つのマイグレーションで済みます。

この記事では、2 つのマッピングの実際の違い、テーブル分割と JSON のための正確な `ComplexProperty` 構成、既存の `OwnsOne` マッピングをデータを失わずに移行する方法、そして依然として所有エンティティに頼らざるを得ないケースを取り上げます。

## 所有エンティティが値オブジェクトにふさわしい形ではなかった理由

EF Core が所有エンティティ型を追加したとき、それは値オブジェクトをモデル化する方法として売り込まれました。`Customer` の内部に存在し、同じテーブルにマッピングされる `Address` です。それは機能しますが、常に妥協でした。所有エンティティは**エンティティ型です**。EF Core はそれに主キー（通常は EF Core が管理するシャドウキー）を与え、変更トラッカー内で独自のノードとして追跡し、参照同一性で扱います。[所有エンティティのドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities)は、そこから生じる鋭い角について何年も前から警告してきました。

そのうち 3 つの角が絶えず牙を剥きます。

1 つ目に、インスタンスを共有できません。これは動作しそうに見えますが、動作しません。

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress;
await context.SaveChangesAsync(); // throws with owned entities
```

両方のプロパティが同じエンティティ型であるため、EF Core は 1 つのエンティティが 2 回参照されていると見なし、それを拒否します。2 つ目に、LINQ の等価比較は内容ではなく同一性で比較するため、`context.Customers.Where(c => c.BillingAddress == c.ShippingAddress)` はあなたが思う意味にはなりません。3 つ目に、`ExecuteUpdate` は所有エンティティのプロパティをまったくサポートしていません。

複合型は、まさにこの用途のために意図されたマッピングです。それ自身の同一性を持ちません。完全にそのデータによって定義され、それが値オブジェクトの定義です。代入するとフィールドがコピーされます。比較するとフィールドが比較されます。そして EF Core 11 は `ExecuteUpdate` でそれをサポートします。EF チーム自身の[EF Core 10 リリースノート](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types)のガイダンスは率直です。"users already using owned entity types for these are advised to switch to complex types."

## 最小限の複合型マッピング

値オブジェクトと、それを含むエンティティから始めます。値オブジェクトにはキーも `Id` も、同一性を匂わせるものは一切必要ありません。

```csharp
// .NET 11, C# 14, EF Core 11
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string PostalCode { get; set; }
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required Address ShippingAddress { get; set; }
    public Address? BillingAddress { get; set; }
}
```

これが複合型であることを EF Core に伝える方法は 2 つあります。1 つは `OnModelCreating` での Fluent API です。

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Customer>(b =>
    {
        b.ComplexProperty(c => c.ShippingAddress);
        b.ComplexProperty(c => c.BillingAddress);
    });
}
```

もう 1 つは値オブジェクトに付ける `[ComplexType]` 属性で、これにより EF Core は使われている場所ならどこでも規約でそれを拾い上げます。

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string PostalCode { get; set; }
}
```

デフォルトでは、これは**テーブル分割**にマッピングされます。住所の列はプレフィックス付きで `Customers` テーブルに直接存在します。

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ShippingAddress_Street] nvarchar(max) NOT NULL,
    [ShippingAddress_City] nvarchar(max) NOT NULL,
    [ShippingAddress_PostalCode] nvarchar(max) NOT NULL,
    [BillingAddress_Street] nvarchar(max) NULL,
    [BillingAddress_City] nvarchar(max) NULL,
    [BillingAddress_PostalCode] nvarchar(max) NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
```

別の `Addresses` テーブルも外部キーも存在しないことに注目してください。それがポイントです。値オブジェクトは所有者の行の一部であり、結合も管理すべき同一性もありません。

## オプション（null 許容）の複合型には必須プロパティが少なくとも 1 つ必要です

上記の `BillingAddress? BillingAddress` が機能するのは、EF Core 10 が**オプション**の複合型のサポートを追加したからです。オブジェクト全体が null になり得て、EF Core は列の値から存在の有無を判断します。人々を引っかける規則が 1 つあります。オプションの複合型には、少なくとも 1 つの必須（非 null 許容）プロパティが必要です。EF Core はその列を使って、"住所全体が null" と "住所は存在するがそのオプションフィールドが null" を区別します。`Address` のすべてのプロパティが null 許容であれば、EF Core はこの 2 つの状態を区別する手がかりを持てず、モデル構築が例外をスローします。

実際にはこれが制約になることはほとんどありません。現実の住所には少なくとも 1 つ、存在しなければならないフィールドがあるからです。もし本当にすべてのフィールドがオプションである値オブジェクトを持っているなら、判別子を追加するか、そもそもそれが null 許容であるべきかを再考してください。

## 複合型を単一の JSON 列にマッピングする

テーブル分割はフィールドを複数の列に散らばらせます。値オブジェクトを 1 つの不透明な JSON ドキュメントとして保持したい場合、EF Core 10 は複合プロパティに `ToJson()` を追加し、EF Core 11 はそれを安定した状態で維持しています。

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>(b =>
{
    b.ComplexProperty(c => c.ShippingAddress, c => c.ToJson());
    b.ComplexProperty(c => c.BillingAddress, c => c.ToJson());
});
```

SQL Server 2025（または Azure SQL）では、これはネイティブの `json` 列型を使用します。

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ShippingAddress] json NOT NULL,
    [BillingAddress] json NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
```

JSON マッピングは、テーブル分割にはできない 1 つのことをもたらします。**マッピングされた型の内部のコレクション**です。テーブル分割でマッピングされた複合型は単一の値でなければなりませんが、JSON にマッピングされた複合型は `List<string>` や値オブジェクトのネストされたリストを含められます。ドキュメントの中へクエリすることも依然として可能です。SQL Server 2025 では、`context.Customers.Where(c => c.ShippingAddress.City == "Cluj")` は `JSON_VALUE` の検索に変換され、EF Core 11 は `EF.Functions.JsonPathExists` と `EF.Functions.JsonContains` を追加します。どちらも JSON にマッピングされた複合型に対して機能します。JSON にマッピングされたデータのクエリに関するより広い全体像については、[EF Core 11 で JSON 列をマッピングしてクエリする方法](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)と[SQL Server 2025 で追加された JSON_CONTAINS の変換](/2026/04/efcore-11-json-contains-sql-server-2025/)を参照してください。

## 値のセマンティクスが実際にもたらすもの

マッピングが複合型になると、所有エンティティの 3 つの角は消えます。

インスタンスの共有が今や機能します。代入は追跡された参照をエイリアスするのではなくフィールドをコピーするからです。

```csharp
// .NET 11, EF Core 11 - complex type mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress; // copies the values
await context.SaveChangesAsync(); // succeeds
```

LINQ の等価比較は内容を比較するため、これは 2 つの住所が本当に等しい顧客を返します。

```csharp
// .NET 11, EF Core 11
var sameAddress = await context.Customers
    .Where(c => c.BillingAddress == c.ShippingAddress)
    .ToListAsync();
```

そして一括更新は複合型の内部に到達します。これは所有エンティティでは決して許されなかったことです。

```csharp
// .NET 11, EF Core 11
await context.Customers
    .Where(c => c.ShippingAddress.City == "Bucuresti")
    .ExecuteUpdateAsync(s =>
        s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"));
```

書き込みのパスをエンティティのロードと変更と比較検討しているなら、そのトレードオフは[ExecuteUpdate とエンティティのロードおよび SaveChanges の比較](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)で扱ったものと同じです。複合型は単純に、値オブジェクトのケースを高速パスの対象にします。

構造体も機能し、これは "同一性なし" という考えにきれいに合致します。

```csharp
// .NET 11, C# 14, EF Core 11
public struct Money
{
    public required decimal Amount { get; set; }
    public required string Currency { get; set; }
}
```

レコード型もよく適合します。レコード型、複合型、変更追跡の相互作用については、[EF Core 11 でレコード型を正しく使う方法](/2026/04/how-to-use-records-with-ef-core-11-correctly/)を全文読む価値があります。

## 既存の OwnsOne マッピングを複合型に移行する

すでに `OwnsOne` を出荷している場合、切り替えは機械的で、テーブル分割の場合は列の名前と型が同じであるため通常はスキーマに影響しません。手順は次のとおりです。

1. **現在のストレージ形状を確認する。** `OwnsOne` が所有者のテーブル（デフォルト）にマッピングされている場合、列はすでに `Owner_Property` です。`OwnsOne(...).ToTable("Addresses")`（別テーブル）や `OwnsOne(...).ToJson()` を使用している場合は、移行がデータを移動するかどうかにターゲットのストレージが関わるため、それを書き留めてください。
2. **値オブジェクトから同一性の漏れを取り除く。** `Id` プロパティ、明示的なキー構成、所有者への逆ナビゲーションをすべて削除します。複合型はキーも逆参照も持てません。
3. **`OwnsOne` を `ComplexProperty` に置き換える。** `b.OwnsOne(c => c.ShippingAddress)` を `b.ComplexProperty(c => c.ShippingAddress)` に、`b.OwnsOne(c => c.ShippingAddress, a => a.ToJson())` を `b.ComplexProperty(c => c.ShippingAddress, a => a.ToJson())` に変更します。`HasMaxLength` や `HasColumnName` のようなプロパティ単位の構成は引き継ぎます。
4. **オプションの値オブジェクトを CLR 型で null 許容にする。** 所有された参照が存在しない可能性がある場合、プロパティを `Address?` として宣言し、EF Core が null を検出できるように型に少なくとも 1 つの必須プロパティがあることを確認します。
5. **マイグレーションを追加して確認する。** `dotnet ef migrations add SwitchAddressToComplexType` を実行します。同じテーブル上のテーブル分割された `OwnsOne` の場合、列は移動しないためマイグレーションは空またはほぼ空のはずです。列を削除して再作成しようとする場合、列名が食い違っています。データを失わないように、差分がきれいになるまで `HasColumnName` で列名を固定してください。
6. **データが保持されることを先にコピーで検証する。** 本番から復元したスクラッチデータベースにマイグレーションを適用してから本番で実行します。特に別テーブルからの移動や、`nvarchar` の JSON からネイティブの `json` 型への移動の場合はそうしてください。

本当にデータを移動する唯一のマイグレーションは、`OwnsOne(...).ToTable("Addresses")`（別テーブル）からテーブル分割された複合型への移行です。行を子テーブルから親テーブルへ移動しなければならないため、クリーンな自動生成のパスはありません。そのマイグレーションは手で書いてください。新しい列を追加し、`UPDATE ... FROM` で値をコピーし、それから古いテーブルを削除します。すでに EF Core のアップグレードの真っ最中なら、同じ注意がモデルの残りの部分にも当てはまります。[EF Core 6 から EF Core 11 への移行ガイド](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)は、この切り替えと並んで表面化しがちな破壊的変更を扱っています。

## EF Core 11 は継承と構成の摩擦を取り除きます

EF Core 11 で具体的に改善された 2 つのことが、切り替えを容易にします。

複合型（および JSON 列）が、**TPT（テーブル分離、table-per-type）と TPC（具象型テーブル、table-per-concrete-type）継承**を使用するエンティティで機能するようになりました。EF Core 11 より前は、TPT/TPC 階層の基底型の複合プロパティはサポートされておらず、継承された値オブジェクトのためには所有エンティティに戻らざるを得ませんでした。今やこれは正しくマッピングされます。

```csharp
// .NET 11, C# 14, EF Core 11
public abstract class Animal
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required AnimalDetails Details { get; set; }
}

public class Dog : Animal { public string Breed { get; set; } = ""; }
public class Cat : Animal { public bool IsIndoor { get; set; } }

[ComplexType]
public class AnimalDetails
{
    public DateTime BirthDate { get; set; }
    public string? Veterinarian { get; set; }
}

// OnModelCreating
modelBuilder.Entity<Animal>().UseTptMappingStrategy();
```

EF Core 11 は期待どおり `Animal` テーブルに `Details_BirthDate` と `Details_Veterinarian` の列を作成します。

構成も短くなりました。以前は、複合型のプロパティに踏み込むには、まず複合ビルダーを取得する必要がありました。

```csharp
// Pre-EF Core 11
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.ShippingAddress)
    .Property(a => a.Street)
    .HasMaxLength(200);
```

EF Core 11 では `Property` の中でメンバーアクセスをそのまま連鎖できます。

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>()
    .Property(c => c.ShippingAddress.Street)
    .HasMaxLength(200);
```

EF Core 11 は複合型のための安定化修正もまとめて投入しました。ネストされた複合型の正しい比較、ネストされたプロパティへの正しい `ExecuteUpdate` の代入、そして 2 つの型が同じ列にマッピングされた null 許容の複合プロパティを共有する際の `NullReferenceException` の修正などです。EF Core 9 で複合型を試して粗い角に当たったなら、EF Core 11 はそれらが所有エンティティの完全な代替となることが意図されたリリースです。

## それでも所有エンティティを使わなければならないとき

複合型はすべてのケースをカバーするわけではありません。次の場合は `OwnsOne` または `OwnsMany` に頼ってください。

- **値オブジェクトを別テーブルに置く必要がある。** 複合型は常にインラインで、分割された列か単一の JSON 列のいずれかです。`ComplexProperty(...).ToTable("Addresses")` は存在しません。スキーマがデータを外部キー付きの独自のテーブルに要求するなら、それは所有（または完全）エンティティです。
- **別の行にマッピングされたコレクションが必要。** テーブル分割された複合型は単一の値でなければならず、構造体のコレクションはまったくサポートされていません。JSON にマッピングされた複合型はドキュメントの内部にコレクションを保持できますが、各要素を子テーブルの独自の行にしたい場合は、`OwnsMany` が依然としてそのツールです。
- **何かが本当に同一性を必要とする。** 同じ内容を持つ 2 つの "値オブジェクト" が区別できなければならない場合や、それらを独立して追跡・更新する必要がある場合、それらは値オブジェクトではありません。本物の関連エンティティとしてモデル化してください。

経験則は `class` と `record` を分けるものと同じです。あるものがそのデータによって定義されるなら、それを複合型としてマッピングし、そのデータより長く生き残る同一性を持つなら、それはエンティティです。.NET 11 のコードベースにおけるほとんどの `Address`、`Money`、`GeoPoint`、`DateRange` 型では、複合型が今や正しいデフォルトであり、所有エンティティは、ストレージ形状が手を強いる場合にのみ落とし込む例外です。

## 関連する読み物

- [EF Core 11 でレコード型を正しく使う方法](/2026/04/how-to-use-records-with-ef-core-11-correctly/)は、複合型としてのレコード型とエンティティ、そしてその分割の背後にある変更追跡の規則をより深く掘り下げています。
- [EF Core 11 で JSON 列をマッピングしてクエリする方法](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)は、JSON にマッピングされた複合型のクエリ側を扱っています。
- [EF Core 11 は SQL Server 2025 で Contains を JSON_CONTAINS に変換する](/2026/04/efcore-11-json-contains-sql-server-2025/)は、複合型に対して機能するようになった JSON 関数を説明しています。
- [ExecuteUpdate とエンティティのロードおよび SaveChanges の比較](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)は、複合型が値オブジェクトのために解き放つ一括更新のパスを位置づけています。
- [EF Core 6 から EF Core 11 への移行：実際に効いてくる破壊的変更](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)は、この切り替えがより大きなアップグレードの一部である場合の相棒です。

## 出典

- [What's New in EF Core 10: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types)
- [What's New in EF Core 11: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [EF Core owned entity types](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities)
- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Allow mapping optional complex properties (efcore#31376)](https://github.com/dotnet/efcore/issues/31376)
