---
title: "EF Core 11 で value converter を使って enum を文字列として保存する方法"
description: "EF Core 11 で C# の enum を int ではなく読みやすい文字列として保存する方法です。HasConversion、すべての enum への一括設定、nvarchar(max) の罠、並び順の落とし穴、既存の int 列の移行手順を扱います。"
pubDate: 2026-08-03
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "value-converters"
  - "enums"
  - "dotnet-11"
  - "how-to"
lang: "ja"
translationOf: "2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter"
translatedBy: "claude"
translationDate: 2026-08-03
---

短い答えです。EF Core 11 (.NET 11 と C# 14 上で動作) では、プロパティに `.HasConversion<string>()` を付けるだけで、EF Core が組み込みの `EnumToStringConverter<TEnum>` を選んでくれます。同時に `.HasMaxLength(...)` も付けてください。付けないと SQL Server では `nvarchar(max)` 列になり、どのインデックスも効かなくなります。モデル内のすべての enum に対しては、`ConfigureConventions` で `configurationBuilder.Properties<Enum>().HaveConversion<string>()` を一度書けば済みます。等値比較と `Contains` は引き続き正しく SQL に変換されますが、`>` のような関係比較と `OrderBy` は黙ってアルファベット順に切り替わります。実際に壊れるのはここだけです。

この記事では、変換を設定する 3 つの方法、生成される DDL と SQL が実際にどう見えるか、本番で刺さる 5 つの落とし穴、そしてすでに int が入っている列の移行手順を扱います。

以下の SQL と挙動はすべて、SDK .NET 10.0.201 を使い、EF Core 10.0.10 で SQLite と SQL Server プロバイダーの DDL ジェネレーターに対して計測したものです。EF Core 11 は .NET 11 ランタイムを必要とするため、このマシンでは実行できませんでした。以下で挙げる EF Core 11 との差分は [EF Core 11 のリリースノート](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) に基づくもので、その旨を明記しています。値変換の API 自体は EF Core 8 から 11 まで変わっていません。

## int への既定マッピングが負債になる理由

既定では、EF Core は enum を基底の数値型にマッピングします。`OrderStatus.Shipped` は `2` になります。これはコンパクトで、enum の宣言どおりに並びますが、データベースを C# の型の *宣言順* に結び付けてしまいます。

```csharp
// .NET 11, C# 14
public enum OrderStatus { Pending, Paid, Shipped, Delivered, Cancelled }
```

半年後、読みやすいからという理由で誰かが `Paid` と `Shipped` の間に `Refunded` を挿入します。enum は問題なくコンパイルされ、テストもすべて通り、そしてデータベースで `Shipped` を意味していた行はすべて `Refunded` を意味するようになります。コンパイルエラーも実行時エラーも出ません。人間がレポートを読んで初めて表に出る、静かなデータ破壊のバグです。

文字列にはこの故障モードがありません。宣言順に何をしようと `"Shipped"` は `Shipped` のままですし、アドホックな SQL や BI ツール、サポート用のクエリを実行する人にとって列の中身が読めます。その代償はストレージ容量とインデックス幅、そして後述する並び順の注意点です。

## 変換を設定する 3 つの方法

いちばん短い書き方は `HasConversion` のジェネリックオーバーロードです。EF Core はモデル側の型 (enum) と要求されたプロバイダー型 (`string`) を見て、組み込みの converter を自動的に選びます。

```csharp
// EF Core 11, OnModelCreating
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.Status)
        .HasConversion<string>()
        .HasMaxLength(20);
}
```

2 つ目の書き方は 2 本のラムダを明示します。素の enum でこれが必要になることはほぼありませんが、[値変換のドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) が最初に示すのはこの形なので、見分けられるようにしておく価値はあります。

```csharp
// EF Core 11 - equivalent to HasConversion<string>(), just more typing
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion(
        v => v.ToString(),
        v => (OrderStatus)Enum.Parse(typeof(OrderStatus), v));
```

この 2 つは *同一ではありません* し、その違いは重要です。組み込みの `EnumToStringConverter<TEnum>` は大文字小文字を区別せずにパースしますが、上の手書きの `Enum.Parse` は区別するため、`"Pending"` ではなく `"pending"` が格納された行で例外を投げます。ジェネリックオーバーロードを優先してください。

3 つ目の書き方は fluent API を完全に省き、列の型だけを宣言します。EF Core は enum プロパティの下に文字列列があるのを見て、変換を推論します。

```csharp
// EF Core 11 - conversion inferred from the store type
public class Order
{
    public int Id { get; set; }

    [Column(TypeName = "varchar(20)")]
    public OrderStatus Status { get; set; }
}
```

### モデル内のすべての enum をまとめて設定する

40 個のプロパティに `HasConversion<string>()` を書き写していけば、いつか 1 つ書き忘れます。規約より前のモデル設定は CLR の型で照合され、ドキュメントには型が "基底型でもよい" と書かれています。つまり `System.Enum` はモデル内のすべての enum に一致します。

```csharp
// EF Core 11 - applies to every enum property in the model
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
{
    configurationBuilder
        .Properties<Enum>()
        .HaveConversion<string>()
        .HaveMaxLength(32);
}
```

これは EF Core 10.0.10 で確認しました。あとからモデルをダンプすると、null 許容でない enum プロパティにも null 許容の enum プロパティにも、最大長込みで変換が適用されているのが分かります。

```text
Id:         clr=Int32       provider=(none)  maxlen=
Perms:      clr=Perms       provider=String  maxlen=32
PrevStatus: clr=Nullable`1  provider=String  maxlen=32
Status:     clr=OrderStatus provider=String  maxlen=32
```

なお、変換が有効であるにもかかわらず `IProperty.GetValueConverter()` はここで `null` を返します。変換が明示的な converter インスタンスではなくプロバイダー型に由来する場合、それは type mapping 側に置かれるためです。デバッガーでモデルを調べるときは `property.GetTypeMapping().Converter` を見てください。`EnumToStringConverter<TEnum>` のインスタンスが返ります。

規約より前の設定は、規約 *と* data annotations の両方を上書きします。したがって 1 つの enum だけを int で保存したい場合は、そのあとに `OnModelCreating` で明示的に設定してください。

## nvarchar(max) の罠

これは群を抜いて多い間違いで、クエリが遅くなるまで表に出てきません。

長さを指定せずに変換を設定すると、SQL Server プロバイダーは文字列の長さを知りようがないため、手持ちで最も広いものを選びます。変換された enum プロパティ 3 つのうち 2 つだけが長さを設定しているモデルに対して、EF Core が生成した DDL は次のとおりです。

```sql
CREATE TABLE [Orders] (
    [Id] int NOT NULL IDENTITY,
    [Status] nvarchar(max) NOT NULL,
    [PrevStatus] varchar(20) NULL,
    [Perms] nvarchar(64) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

`Status` にはファセットがなかったので `nvarchar(max)` になりました。SQL Server では `nvarchar(max)` 列に通常のインデックスを張ることがそもそもできませんし、ステータス列はまさに常時フィルターに使う類の列です。`PrevStatus` は `.HasMaxLength(20).IsUnicode(false)` を使い、きれいな `varchar(20)` になりました。

知っておくと救いになる挙動が 1 つあります。そのプロパティにインデックスを宣言すると、EF Core の SQL Server プロバイダーは `max` ではなくキー列向けの既定値にフォールバックします。

```csharp
// EF Core 11
modelBuilder.Entity<Order>().Property(o => o.Status).HasConversion<string>();
modelBuilder.Entity<Order>().HasIndex(o => o.Status);
```

```sql
CREATE TABLE [Orders] (
    [Id] int NOT NULL IDENTITY,
    [Status] nvarchar(450) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
GO

CREATE INDEX [IX_Orders_Status] ON [Orders] ([Status]);
```

`nvarchar(450)` は 900 バイトで、SQL Server のインデックスキーサイズの上限です。動きはしますが、`"Pending"` を入れる列に 900 バイトのキーを使うのはインデックスページの無駄です。長さは自分で指定してください。enum の名前は短いので、Unicode なしの 32 文字か 64 文字でほぼ間違いありません。

長さをプロパティごとに繰り返すのではなく converter 側に持たせたい場合は、`ConverterMappingHints` を渡します。

```csharp
// EF Core 11 - the size travels with the converter
var converter = new ValueConverter<OrderStatus, string>(
    v => v.ToString(),
    v => Enum.Parse<OrderStatus>(v, ignoreCase: true),
    new ConverterMappingHints(size: 20, unicode: false));
```

プロパティ側で明示的に設定したファセットは、これらのヒントを上書きします。

## LINQ クエリが実際にコンパイルされる先

等値比較は期待どおりに変換されます。enum は列から出るときではなくパラメーターに入るときに変換されるので、列はインデックスを使える状態のままです。

```csharp
var pending = await context.Orders
    .Where(o => o.Status == OrderStatus.Pending)
    .ToListAsync();
```

```sql
SELECT "o"."Id", "o"."Perms", "o"."PrevStatus", "o"."Status"
FROM "Orders" AS "o"
WHERE "o"."Status" = 'Pending'
```

enum 値の配列に対する `Contains` は、各値が変換されたパラメーター化済みの `IN` になります。

```sql
-- Parameters: @wanted1='Pending', @wanted2='Paid'
WHERE "o"."Status" IN (@wanted1, @wanted2)
```

`ExecuteUpdate` も変換された enum を扱い、文字列をパラメーターとして送ります。

```csharp
await context.Orders
    .Where(o => o.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Paid));
```

ここまでが普通のケースです。次は行儀の悪いほうです。

### 関係比較と OrderBy はアルファベット順に切り替わる

これが文字列保存の本当のコストであり、EF Core は何も警告してくれません。enum に対する `>` 比較は完全に正当な C# であり、完全に正当な SQL の文字列比較に変換されますが、この 2 つは同じものではありません。

```csharp
// Intent: "everything after Paid in the workflow"
var later = await context.Orders
    .Where(o => o.Status > OrderStatus.Paid)
    .ToListAsync();
```

```sql
WHERE "o"."Status" > 'Paid'
```

`Pending`、`Delivered`、`Cancelled` を持つ 3 行があるとき、メモリ上の LINQ は `Delivered` と `Cancelled` の行を返します。データベースが返すのは `Pending` の行です。アルファベット順では `'Pending' > 'Paid'` が成り立ち、`'Cancelled'` と `'Delivered'` では成り立たないからです。`OrderBy(o => o.Status)` も同じ問題を抱えていて、宣言順ではなく `Cancelled, Delivered, Pending` の順で返ります。

これは converter の設定では直りません。並べ替えや範囲比較の対象になるものは int のままにするか、明示的な `int SortOrder` 列を足すか、範囲クエリを明示的な集合に置き換えてください。たとえば `Where(o => finished.Contains(o.Status))` です。enum を範囲比較しているコードをすでに出荷しているなら、マッピングを切り替える前に grep してください。

### クエリ内の ToString() は CAST を生み、EF Core 11 はそれを取り除く

列がすでに文字列になっていれば `Status.ToString()` への射影やフィルターは無害に見えますが、EF Core 10 は CLR の呼び出しが含意するキャストを依然として出力します。

```csharp
context.Orders.Where(o => o.Status.ToString()!.StartsWith("P"))
```

```sql
-- EF Core 10
WHERE CAST([o].[Status] AS nvarchar(max)) LIKE N'P%'
```

このキャストは意味的には何もしませんが、クエリプランナーにとっては災難です。列を関数で包むと、SQL Server はその列のインデックスを一切使えなくなります。EF Core 11 は SQL の後処理の段階で冗長なキャストを検出して取り除き、リリースノートは値変換されたプロパティをその典型的な発生源として挙げています。EF Core 11 では同じクエリが素の `WHERE [o].[Status] LIKE N'P%'` になります。EF Core 10 以前にいるなら `.ToString()` を外してプロパティに `EF.Functions.Like` を使うか、アップグレードを待ってください。これを確認できることは、[開発時に SQL のログ出力を有効にしておく](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) 十分な理由になります。

## 値を読み戻すとき: 未知の名前と大文字小文字

value converter はマテリアライズ時に動作し、文字列列は何でも受け入れます。enum に存在しない名前が入った行は、クエリ時ではなく読み取り時に失敗します。

```text
InvalidOperationException: Cannot convert string value 'Refunded' from the database
to any value in the mapped 'OrderStatus' enum.
```

例外は行がマテリアライズされるときに表面化するので、10,000 行を返すクエリはたまたま壊れていた行で落ちます。データベースを直接書き込む別のものと共有しているなら、`CHECK` 制約で列を守ってください。

一方、大文字小文字については組み込みの converter は寛容です。`"pending"` を格納した行は `OrderStatus.Pending` としてマテリアライズされます。これは `EnumToStringConverter<TEnum>` が大文字小文字を区別せずにパースしているからです。手書きの `Enum.Parse(typeof(OrderStatus), v)` に差し替えると、同じ行が例外を投げます。BCL の既定は大文字小文字を区別するからです。自分で書くなら `Enum.Parse<OrderStatus>(v, ignoreCase: true)` と書いてください。

### `[Flags]` の enum は往復できるがクエリできない

`[Flags]` の enum も他と同じく `ToString()` を通して変換されるので、カンマ区切りのリストになります。

```text
row 1 | Read
row 2 | Read, Write
row 3 | None
```

往復は動きます。クエリは動きません。`Where(o => o.Perms.HasFlag(Perms.Write))` は文字列の述語に変換できませんし、`LIKE '%Write%'` は役に立つものを何も見つけないまま全体をスキャンします。`[Flags]` の enum は int のままにするか、権限を行としてモデリングしてください。

### 生 SQL のパラメーターは converter を黙って無視する

値変換のドキュメントはこれを既知の制限として挙げています。例外を投げないので、どう見えるかを確認しておく価値があります。

```csharp
var rows = await context.Orders
    .FromSql($"SELECT Id, Status FROM Orders WHERE Status = {OrderStatus.Pending}")
    .ToListAsync();
```

パラメーターは値 `0` の `DbType = Int32` としてデータベースに渡ります。クエリは実行され、何にも一致せず、空のリストを返します。生 SQL では `OrderStatus.Pending.ToString()` を明示的に渡すか、LINQ の中にとどまってください。これは [LINQ 式を変換できませんでした](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) の背後にある失敗とは別物で、そもそも例外が出ません。

## 名前ではなく短いコードを保存する

`"Pending"` ではなく `"PND"` を保存したい場合 (固定幅のコードはデータウェアハウスと共有するスキーマでよく使われます)、`ValueConverter<TModel, TProvider>` を継承してマッピングを明示的かつレビュー可能にしてください。

```csharp
// EF Core 11
public class StatusCodeConverter : ValueConverter<OrderStatus, string>
{
    public StatusCodeConverter() : base(v => ToCode(v), v => FromCode(v)) { }

    private static string ToCode(OrderStatus s) => s switch
    {
        OrderStatus.Pending => "PND",
        OrderStatus.Paid => "PAI",
        OrderStatus.Shipped => "SHP",
        OrderStatus.Delivered => "DLV",
        OrderStatus.Cancelled => "CAN",
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, null)
    };

    private static OrderStatus FromCode(string c) => c switch
    {
        "PND" => OrderStatus.Pending,
        "PAI" => OrderStatus.Paid,
        "SHP" => OrderStatus.Shipped,
        "DLV" => OrderStatus.Delivered,
        "CAN" => OrderStatus.Cancelled,
        _ => throw new InvalidOperationException($"Unknown status code '{c}'.")
    };
}
```

```csharp
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion<StatusCodeConverter>()
    .HasMaxLength(3)
    .IsUnicode(false);
```

述語は converter を通して変換されるので、`Where(o => o.Status == OrderStatus.Pending)` は `WHERE "o"."Status" = 'PND'` になります。switch の各腕が既知のコードを網羅しているため、想定外の値が来たときには EF のメッセージではなく *自分の* メッセージが出て、原因の切り分けがはるかに楽になります。converter は状態を持たないので、それを使うすべてのプロパティで共有できます。

## すでに int が入っている列を移行する

これについては EF Core にスキャフォールドさせないでください。生成されるのは単一の `AlterColumn` で、SQL Server ではこれが `int` から `nvarchar` への暗黙変換を実行します。値 `2` は `"Shipped"` ではなく文字列 `"2"` になります。その結果どの行もパースできなくなり、次の読み取りで例外が出ます。

安全な手順は 4 ステップです。

1. モデルに converter を追加し、`dotnet ef migrations add StoreStatusAsString` でマイグレーションをスキャフォールドします。
2. 生成されたマイグレーションを開き、`AlterColumn` を一時列用の `AddColumn` に置き換えます。たとえば `StatusText nvarchar(20) NULL` です。
3. 追加と削除の間に `migrationBuilder.Sql(...)` によるバックフィルを挟み、各 int を明示的に名前へ対応付けます。`UPDATE Orders SET StatusText = CASE Status WHEN 0 THEN 'Pending' WHEN 1 THEN 'Paid' ... END;` のようにします。CASE は、後で enum がどうなるかではなく、このコミット時点の enum 宣言に対して手で書いてください。
4. 古い列を削除し、`StatusText` を `Status` にリネームして `NOT NULL` にします。マイグレーションを可逆にするため、`Down` には鏡像となるロジックを書いてください。

実環境で動かす前に SQL を検証してください。`dotnet ef migrations script` がそれを出力しますし、同じスクリプトを [マイグレーションバンドル](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) が対象マシンで実行します。その enum が外部キーやフィルター付きインデックスの中で使われている場合は、同じマイグレーション内でインデックスを削除して作り直してください。

最後にモデルそのものについて 1 つ。value converter は単一の列のためのものです。それを回避するために複数のフィールドを 1 本の文字列にシリアライズし始めたら、欲しいのは [JSON にマッピングされた複合型](/ja/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) のほうです。EF Core 11 ならインデックスを張ることも、その場で更新することもできます。そして EF Core がそもそもプロパティをマッピングしてくれない場合は、別の解決策を持つ別の問題であり、[プロパティをマッピングできないエラー](/ja/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/) で扱っています。

## 参考資料

- Microsoft Learn の [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions)。組み込み converter の一覧と文書化された制限を含みます。
- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration)。規約より前の設定と基底型による照合について。
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)。無意味な CAST の除去について。
- [EnumToStringConverter&lt;TEnum&gt;](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.enumtostringconverter-1) の API リファレンス。
- [dotnet/efcore#10434](https://github.com/dotnet/efcore/issues/10434)。値変換されたプロパティの内部へのクエリに関する追跡 issue です。
