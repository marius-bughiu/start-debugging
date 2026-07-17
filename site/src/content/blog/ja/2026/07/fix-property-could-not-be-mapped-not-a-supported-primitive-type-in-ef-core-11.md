---
title: "解決: EF Core 11 で \"The property could not be mapped, because it is not a supported primitive type or a valid entity type\""
description: "EF Core が保存方法を知らないプロパティに遭遇しました。complex type としてマッピングするか、HasConversion で変換するか、キーを与えるか、[NotMapped] で無視しましょう。"
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "ja"
translationOf: "2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-17
---

EF Core は、モデルが列に変換できず、かつ関連として扱うこともできないプロパティを公開しているときに `The property 'X.Y' could not be mapped, because it is of type 'Z' which is not a supported primitive type or a valid entity type` をスローします。優先順に、次の4つのいずれかの方法で修正します。値オブジェクトなら `ComplexProperty` で complex type としてマッピングする、enum のリストや独自のラッパーなら `HasConversion` (値コンバーター) でスカラーに変換する、EF Core が関連エンティティとしてマッピングできるよう型にキーを与える、あるいは決して永続化すべきでないなら `[NotMapped]` / `EntityTypeBuilder.Ignore` で完全に除外する、です。これは .NET 11、C# 14 上の `Microsoft.EntityFrameworkCore` 11.0 に当てはまり、このメッセージは EF Core 3.0 以降変わっていません。

## エラーの文脈

実行時の完全な例外は、EF Core がモデルを構築している最中にスローされる `InvalidOperationException` です。つまり、コンパイル時ではなく、`DbContext` に最初に触れたとき (クエリ、`SaveChanges`、または `dotnet ef migrations add`) に発生します。

```
System.InvalidOperationException: The property 'Customer.Tags' could not be mapped, because it is of type 'HashSet<Tag>' which is not a supported primitive type or a valid entity type. Either explicitly map this property, or ignore it using the '[NotMapped]' attribute or by using 'EntityTypeBuilder.Ignore' in 'OnModelCreating'.
```

メッセージ内の2つの識別子だけを読めば十分です。プロパティ (`Customer.Tags`) とその型 (`HashSet<Tag>`) です。EF Core は、エンティティをたどってこのメンバーを見つけたが、それを保存するルールがなかったと伝えています。最後の文は逃げ道を列挙していますが、正しいものは示していません。だからこそ、このエラーはデータを保存するはずだった場合でも、非常に多くの人をまっすぐ `[NotMapped]` へ向かわせます。

## なぜ起きるのか

EF Core はプロパティをちょうど3通りのいずれかでマッピングします。スカラーは列になります (`int`、`string`、`decimal`、`DateTime`、`Guid`、`bool`、`enum`、そして EF Core 8 以降は `DateOnly` と `TimeOnly`、さらに `List<string>` のようなプリミティブコレクションも)。検出可能なキーを持つ型は、外部キーを通じて配線された関連エンティティになります。そしてキーを持たない値オブジェクトは complex type または owned エンティティになり、所有者のテーブルにインラインで格納されます。

このエラーは、プロパティが3通りすべてからこぼれ落ちたことを意味します。型は EF Core が知っているスカラーではなく、EF Core が見つけられるキーもなく (したがって関連にはなれない)、そして EF Core にそれを complex type または owned type として扱うよう指示したこともない、ということです。よくあるきっかけは次のとおりです。

- 値オブジェクトとして使われる**独自のクラスまたは構造体** (`Address`、`Money`、`GeoPoint`) で、設定したことがないもの。
- 要素の型がキーを持たない、**独自の型のコレクション** (`List<OrderLine>`、`HashSet<Tag>`)。
- **enum のコレクション** (`List<Status>`)。単一の enum は問題なくマッピングされますが、EF Core 8 より前ではそのコレクションはマッピングされず、独自の型のコレクションは設定なしでは今もマッピングされません。
- 自然な列表現を持たない、**ディクショナリまたは任意のオブジェクト** (`Dictionary<string, string>`、`IDictionary`、`object`、`dynamic`、`JsonElement`)。
- 組み込みのプロバイダーマッピングを持たない、**別のライブラリの型** (`NodaTime.Instant`、ドメインプリミティブ)。

修正は決して推測ではありません。そのデータが何で*ある*かを決め、それに合ったマッピングを選びましょう。

## 最小限の再現

これを再現する最小のプログラムは、無害に見える値オブジェクトを使います。`Address` は `Id` を持たないため EF Core は関連エンティティにできず、スカラーでもないため EF Core はスローします。

```csharp
// .NET 11, C# 14, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();
await db.Database.EnsureCreatedAsync(); // throws here while building the model

public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required Address ShippingAddress { get; set; } // unmapped: not scalar, no key
}

public class ShopContext : DbContext
{
    public DbSet<Customer> Customers => Set<Customer>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Shop;Trusted_Connection=True;Encrypt=False");
}
```

EF Core は `The property 'Customer.ShippingAddress' could not be mapped, because it is of type 'Address'...` と報告します。プロパティは実在し、型も実在しますが、モデルには `Address` がどうストレージになるかを EF Core に伝えるものが何もありません。

## 解決策の詳細

上から下へ進めます。あなたの意図に合致する最初のマッピングが正しいものです。

### 1. 値オブジェクトの場合: complex type としてマッピングする

プロパティが所有者の行に属する値オブジェクト (住所、金額、座標) なら、`ComplexProperty` でマッピングします。complex type は独自の識別子を持たずインラインで格納され、まさに値オブジェクトが求めるものです。

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Customer>()
        .ComplexProperty(c => c.ShippingAddress);
}
```

または型に `[ComplexType]` を付けて、それが現れる場所すべてで EF Core が規約に従って拾い上げるようにします。

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
}
```

これはテーブル分割としてマッピングされ、`Customers` 上に `ShippingAddress_Street` と `ShippingAddress_City` の列ができ、join も外部キーもありません。complex type は値オブジェクトにとって owned エンティティの現代的な代替であり、owned エンティティが持たなかった値セマンティクスをもたらします。まだ不足する場合を含む全体像は、[EF Core 11 で owned エンティティの代わりに complex type をマッピングする方法](/ja/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/)にあります。型が `record` の場合は、まず[EF Core 11 で records を正しく使う方法](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/)を読んでください。record の等価性は変更追跡と相互作用し、出荷前に理解しておく価値があるためです。

### 2. 実は1つのスカラーの場合: HasConversion で変換する

プロパティが概念的には EF Core に組み込みマッピングのない単一の値であれば、値コンバーターがデータベースへの往路でスカラーに変換し、取り出す復路で元に戻します。これは `NodaTime` 型、ドメインプリミティブ、あるいは名前のテキストとして格納したい enum をカバーします。

```csharp
// .NET 11, EF Core 11 - store the enum as its name, not its int
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion<string>();
```

独自のラッパー型では、両方向を明示的に指定します。

```csharp
// .NET 11, EF Core 11 - EmailAddress is a struct wrapping a string
modelBuilder.Entity<Customer>()
    .Property(c => c.Email)
    .HasConversion(
        email => email.Value,          // to the database column (nvarchar)
        value => new EmailAddress(value)); // back from the column
```

値コンバーターは、1つの列へのクリーンで損失のないマッピングがある場合に適したツールです。マッピングが損失を伴う、または型が本当に複合的 (複数のフィールド) であるなら、代わりに complex type を使います。オブジェクトグラフ全体を1つの文字列にシリアライズするためだけにコンバーターに手を伸ばさないでください。その道は次に来ますが、より鋭い角を持っています。

### 3. コレクションまたはディクショナリの場合: プリミティブコレクションまたは JSON 列

EF Core 8 は**プリミティブコレクション**のネイティブマッピングを追加したため、EF Core 11 では `List<string>`、`int[]`、`List<DateOnly>` は設定なしで自動的に JSON 列へマッピングされます。プリミティブコレクションでまだこのエラーが出るなら、あなたは EF Core 7 以前を使っています。アップグレードすればそのまま解決します。

**独自の型**のコレクションや**ディクショナリ**では、EF Core は形状を推論できないため、プロパティ全体を JSON 列へシリアライズします。EF Core 11 では、値オブジェクトのコレクションに対する最もクリーンな経路は、JSON にマッピングされた complex type です。

```csharp
// .NET 11, EF Core 11 - store the whole collection as one json document
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.Tags, b => b.ToJson());
```

`Dictionary<string, string>` などの自由形式のバッグには、`System.Text.Json` を実行する値コンバーターが同じ単一列ストレージを与えます。

```csharp
// .NET 11, EF Core 11 - dictionary stored as a json string
modelBuilder.Entity<Customer>()
    .Property(c => c.Metadata)
    .HasConversion(
        dict => JsonSerializer.Serialize(dict, (JsonSerializerOptions?)null),
        json => JsonSerializer.Deserialize<Dictionary<string, string>>(json, (JsonSerializerOptions?)null)
                ?? new());
```

JSON 列は現代的なプロバイダーでクエリ可能なので、単一列ストレージを得るためにフィルタリングを諦めることはありません。JSON ドキュメントの内部に踏み込む SQL 関数を含むクエリ側は、[EF Core 11 で JSON 列をマッピングしてクエリする方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)で扱っています。既定ではなく独自のシリアライズ形状が必要なら、[System.Text.Json でカスタム JsonConverter を書く方法](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)が、列に何が入るかを正確に制御する方法を示します。

### 4. 実は関連エンティティの場合: キーを与える

プロパティが独自の行を持つ独自のテーブルであるべきなら (インラインの値オブジェクトではなく、実際の `OrderLine` レコードを参照する `Order`)、それはエンティティであり、このエラーは EF Core が関連を確立するためのキーを見つけられなかったことを意味します。キーを追加すれば、EF Core は外部キーを自動的に配線します。

```csharp
// .NET 11, C# 14, EF Core 11
public class OrderLine
{
    public int Id { get; set; }     // now discoverable as a key
    public string Sku { get; set; } = "";
    public int Quantity { get; set; }
}

public class Order
{
    public int Id { get; set; }
    public List<OrderLine> Lines { get; set; } = []; // maps as a one-to-many
}
```

型が `Id` でも `OrderLineId` でもない識別子を持つなら、`OnModelCreating` の `HasKey` で EF Core に伝えます。自然なキーを持たないがそれでも独自の行を必要とするキーレスな型は、`OwnsMany` で owned コレクションとしてマッピングすべきです。そして実際に目の前にあるエラーが[エンティティ型 'X' には主キーの定義が必要](/ja/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/)なら、それは近い兄弟です。EF Core は型をエンティティとして扱うところまで進んだものの、その後キーを見つけられなかったのです。

### 5. 決して永続化すべきでない場合: 無視する

プロパティが計算による便宜、キャッシュ、あるいはデータベースに置く必要のないサービス参照なら、除外します。属性が最も手早い方法です。

```csharp
// .NET 11, C# 14, EF Core 11
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    [NotMapped]
    public string DisplayName => $"{Name} (#{Id})";
}
```

あるいはモデル設定で行えば、永続化を意識しない POCO を EF Core の属性から解放できます。

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>()
    .Ignore(c => c.DisplayName);
```

`Ignore` が正しい修正なのは、「この列は存在すべきか?」への答えが本当に「いいえ」のときだけです。保存するつもりだったデータに対してエラーを黙らせるためにこれに手を伸ばすことは、このエラーが静かなデータ損失バグに変わる最も一般的な道です。

## 注意点とバリエーション

**読み取り専用の計算プロパティが引き金だった。** EF Core は式本体のものを含め、読み取り可能なあらゆるプロパティをマッピングしようとします。`DisplayName => ...` が他の列から導出されるなら、ストレージは不要です。無視してください。それが高コストでデータベースに持ちたいなら、代わりに `HasComputedColumnSql` で計算列をマッピングします。

**`required` を追加したり型を変更したりした後に壊れた。** マッピングされない型のプロパティを追加したり、`string` を独自の構造体に置き換えたりすると、マッピングされないメンバーが導入されます。エラーは正確なプロパティを名指しします。その型で何が変わったかを確認してください。

**enum のコレクション。** `List<Status>` は EF Core 7 以前ではスローします。enum のコレクションがまだプリミティブコレクションではなかったためです。EF Core 8 以降は自動的に JSON 列へマッピングされます。アップグレードの真っ最中なら、enum コレクションの挙動は[EF Core 6 から EF Core 11 への移行ガイド](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)にある複数のマッピング変更の1つです。

**型が別のアセンブリにあり、注釈を付けられない。** 自分の所有でない型に `[ComplexType]` や `[NotMapped]` を付けることはできませんが、どの属性にも `OnModelCreating` の fluent な同等物があります (`ComplexProperty`、`Property(...).HasConversion(...)`、`Ignore`)。自分の `DbContext` から設定すれば、他人の型に触れることはありません。

**抽象型やインターフェース型へのナビゲーション。** EF Core は、インターフェース (`IAddress`) として、または判別子なしのマッピングされない基底として型付けされたプロパティをマッピングできません。具象型をマッピングするか、継承を明示的に設定してください。

**それは `DbSet` のフィルターであり、永続化されるプロパティではない。** その「プロパティ」が実際には他のデータをクエリするヘルパーなら、それはそもそもエンティティに属しません。EF Core がモデル構築中に決して見ないよう、リポジトリやサービスへ移してください。

このエラーから永久に抜け出す判断は、プロパティを追加する前に投げかける1つの問いです。ストレージの観点で、これは何なのか? 値オブジェクトは complex type としてインラインになります。変換可能な単一の値は `HasConversion` を得ます。データのバッグは JSON 列になります。識別子を持つものはキーを備えた関連エンティティになります。そして純粋にメモリ内のヘルパーは無視されます。EF Core がエラーをスローするのは、まさにそのどれをあなたが意図したのかを推測することを拒むからです。

## 関連記事

- [EF Core 11 で owned エンティティの代わりに complex type をマッピングする方法](/ja/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/)は、このエラーが最も頻繁に指し示す値オブジェクトマッピングの詳しい解説です。
- [EF Core 11 で JSON 列をマッピングしてクエリする方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)は、シリアライズされたコレクションやドキュメントの格納とフィルタリングを扱います。
- [解決: エンティティ型 'X' には主キーの定義が必要](/ja/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/)は、EF Core が型をエンティティとして扱うがキーを見つけられないときの兄弟エラーです。
- [EF Core 11 で records を正しく使う方法](/ja/2026/04/how-to-use-records-with-ef-core-11-correctly/)は、値オブジェクトが record で変更追跡が関わるときに重要です。
- [System.Text.Json でカスタム JsonConverter を書く方法](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)は、コンバーターで JSON に変換するプロパティが何を格納するかを正確に形づくります。

## 出典

- [値変換、EF Core ドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions)
- [Complex types、EF Core 11 の新機能](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [プリミティブコレクション、EF Core 8 の新機能](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#primitive-collections)
- [モデルから型やプロパティを除外する、EF Core ドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/#excluding-types-from-the-model)
- [dotnet/efcore issue #15987: property could not be mapped, not a supported primitive type](https://github.com/dotnet/efcore/issues/15987)
