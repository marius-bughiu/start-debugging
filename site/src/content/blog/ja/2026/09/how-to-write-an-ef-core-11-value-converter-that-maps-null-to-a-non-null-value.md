---
title: "データベースの null をコード上の非 null 値へ変換する EF Core 11 の value converter の書き方"
description: "EF Core はデフォルトでは value converter に null を渡しません。それを変える内部 API の convertsNulls コンストラクター、依存する IsRequired(false) の呼び出し、enum などの値型でどうしても機能しない理由、生まれてしまう WHERE col = NULL の罠、そして内部 API を使わずに目的を果たす 2 つのパターンを解説します。"
pubDate: 2026-09-06
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "value-converters"
  - "nullability"
  - "dotnet-11"
  - "how-to"
lang: "ja"
translationOf: "2026/09/how-to-write-an-ef-core-11-value-converter-that-maps-null-to-a-non-null-value"
translatedBy: "claude"
translationDate: 2026-09-06
---

短い答え: EF Core は意図的に value converter へ `null` を渡さないため、`HasConversion(v => ..., v => v ?? "Unknown")` は NULL の列に対して何も行いません。これを変える唯一の方法は、`convertsNulls: true` を取る `ValueConverter<TModel, TProvider>` の 4 引数コンストラクターです。これは `[EntityFrameworkInternal]` が付いており、警告 `EF1001` を発生させます。動作はしますが、CLR 型が参照型のプロパティに限られ、さらに `.IsRequired(false)` を呼ぶ必要があり、そしてセンチネル値で絞り込むすべての LINQ クエリが壊れるという代償を伴います。`enum`、`int`、`DateTime` などの null 非許容の値型では、そもそも動作させることができません。その場合は null 許容のプロパティをマッピングし、非 null のファサードを公開してください。

この記事では、EF が NULL の列に対して実際に何をするのか、`convertsNulls` を機能させる正確な設定、それによって壊れる 4 つのクエリの形 (それぞれについて EF が生成する SQL 付き)、値型でぶつかる壁、そして代わりに使うべきサポート済みの 2 つのパターンを扱います。

バージョンについて。EF Core 11 は 2026 年 9 月時点でプレビューであり、[EF Core のリリースと計画のページ](https://learn.microsoft.com/en-us/ef/core/what-is-new/)によれば 2026 年 11 月に .NET 11 とともに出荷されます。EF11 は .NET 11 のランタイムを必要としますが、この環境にある SDK は .NET 10.0.302 のみです。そのため以下の内容はすべて、インメモリの SQLite データベース上で `Microsoft.EntityFrameworkCore.Sqlite` 10.0.10 を使って計測しました。この領域は EF11 でも変わっていません。[What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) のページは value conversions や null の扱いに関する変更を挙げておらず、`convertsNulls` は EF Core 6.0 以来ずっと内部 API のままです。

## NULL の列で converter が呼ばれない理由

[value conversions のドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions)はルールを明確に述べています。null 値が value converter に渡されることは決してなく、データベース列の null は常にエンティティインスタンス上の null になります。これは見落としではありません。null 非許容の主キーと、それを指す null 許容の外部キーとで同じ converter を共有し、null の扱いを二度書かずに済ませるための仕様です。

その結果、いかにも正しそうなコードが何もしません。

```csharp
// .NET 11, C# 14 - this ?? is dead code
modelBuilder.Entity<Order>()
    .Property(o => o.Notes)
    .HasConversion(v => v, v => v ?? "");
```

`v ?? ""` の分岐には決して到達しません。EF がその手前で変換を打ち切るからです。

その先で何が起きるかは CLR 型によって変わります。列が null 許容で、NULL が意味を持つレガシーなテーブルを考えます。

```sql
CREATE TABLE Orders (
    Id     INTEGER PRIMARY KEY AUTOINCREMENT,
    Notes  TEXT NULL,   -- NULL means "no notes"
    Status TEXT NULL    -- NULL means "status unknown"
);
INSERT INTO Orders (Notes, Status) VALUES (NULL, NULL);
INSERT INTO Orders (Notes, Status) VALUES ('hi', 'Shipped');
```

これを非 null を約束するエンティティにマッピングします。

```csharp
// .NET 11, C# 14
public enum ShippingStatus { Unknown, Pending, Shipped }

public class Order
{
    public int Id { get; set; }
    public string Notes { get; set; } = "";      // never null, we hope
    public ShippingStatus Status { get; set; }   // Unknown, we hope
}
```

1 行目を読み戻すと、初期化子があり null 非許容で宣言しているにもかかわらず `Notes` は `null` になります。EF が列の値をそのままプロパティへ代入するからです。`Status` はさらに深刻で、EF が手を出す前にプロバイダーのデータリーダーが例外を投げます。SQLite では次のように出ます。

```
System.InvalidOperationException: The data is NULL at ordinal 2. This method can't be
called on NULL values. Check using IsDBNull before calling.
```

この例外こそ、この問題が発覚する最も一般的な経路です。正確な型はプロバイダーによって異なりますが、原因は常に同じで、EF は null 許容だと判断した列に対してのみ `IsDBNull` のチェックを生成し、ここではまったくそう判断していません。これは[サポートされているプリミティブ型ではないためプロパティをマッピングできない](/ja/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/)とは別の失敗で、あちらはマテリアライズ時ではなくモデル構築時に発生します。

## null を実際に変換する converter

`ValueConverter<TModel, TProvider>` には EF Core 6.0 で追加された 2 つ目のコンストラクターがあり、`convertsNulls` フラグを取ります。

```csharp
[Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkInternal]
public ValueConverter(
    Expression<Func<TModel, TProvider>> convertToProviderExpression,
    Expression<Func<TProvider, TModel>> convertFromProviderExpression,
    bool convertsNulls,
    ConverterMappingHints? mappingHints = default);
```

これに対応する `HasConversion` のオーバーロードは存在しないため、サブクラス化が必要です。手順は 3 ステップです。

1. プロバイダー型を明示的に null 許容にした converter クラスを書き、基底コンストラクターへ `convertsNulls: true` を渡します。
2. コンストラクターが内部 API なので、クラスの周囲で `EF1001` を抑制します。
3. プロパティに対して `.IsRequired(false)` を呼び、EF が列を null 許容として扱い、読み取り経路に必要な `IsDBNull` のチェックを生成するようにします。

```csharp
// .NET 11, C# 14, EF Core 11
#pragma warning disable EF1001
public class NullToEmptyString : ValueConverter<string, string?>
{
    public NullToEmptyString()
        : base(
            v => v.Length == 0 ? null : v,   // model -> provider
            v => v ?? "",                    // provider -> model
            convertsNulls: true)
    {
    }
}
#pragma warning restore EF1001

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.Notes)
        .HasConversion(new NullToEmptyString())
        .IsRequired(false);
}
```

`#pragma` がないと、ビルドは次を出力します。

```
warning EF1001: Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<string, string?>
is an internal API that supports the Entity Framework Core infrastructure and not subject to the same
compatibility standards as public APIs. It may be changed or removed without notice in any release.
```

これはエラーではなく警告ですが、`TreatWarningsAsErrors` の下ではエラーになります。多くの人がこの API に行き着くのは、たいていそれが理由です。

この設定であれば双方向とも機能します。1 行目は `Notes` が `null` ではなく `""` としてマテリアライズされ、`Notes` が `""` の新しいエンティティを保存すると列には本物の `NULL` が書き込まれます。これは後から生のテーブルを読んで確認しました。

ステップ 3 は省略できず、そしてほぼ全員が飛ばす手順でもあります。`.IsRequired(false)` を外すと `Notes` はモデル上で null 非許容のまま (`IsNullable = False`) となり、EF は null チェックを省略し、読み取りは先ほどと同じ `The data is NULL at ordinal 1` を投げます。converter の設定は正しいのに、一度も呼ばれません。今どちらの状態にいるか分からない場合は、`context.Model.FindEntityType(typeof(Order))!.FindProperty("Notes")!.IsNullable` が 1 行で教えてくれます。

## クエリの罠: WHERE col = NULL

ここからが、[EF Core のドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions)が実例を示さずに警告している部分であり、この API が内部扱いである理由そのものです。EF は converter のモデルからプロバイダーへの変換を、クエリ内の定数にも適用します。あなたのセンチネルは `null` へ変換され、EF はその `null` を普通の比較オペランドとして SQL に埋め込みます。

「メモのない注文はどれか」を尋ねる 4 通りの書き方と、EF Core 10.0.10 がそれぞれに生成する SQL、そして NULL の行 1 件と `'hi'` の行 1 件を持つテーブルに対して返る行数です。

| LINQ | 生成される SQL の述語 | 行数 |
| --- | --- | --- |
| `o.Notes == ""` | `"o"."Notes" = NULL` | 0 |
| `o.Notes == null!` | `"o"."Notes" IS NULL` | 1 |
| `string.IsNullOrEmpty(o.Notes)` | `"o"."Notes" IS NULL OR "o"."Notes" = NULL` | 1 |
| `o.Notes.Length == 0` | `length("o"."Notes") = 0` | 0 |

自分で決めたセンチネルと比較する自然なクエリは、何も返しません。SQL の三値論理では `= NULL` が真になることはなく、その行は黙って除外されます。例外も警告もなく、本番環境で 0 件しかマッチしないフィルターが静かに残るだけです。

機能するのは `o.Notes == null` の方です。これは null 許容参照型のアナライザーが常に偽だと指摘する比較であり、しかもマテリアライズ後に実際には決して null にならないプロパティに対する比較です。必要な SQL を得るために、コンパイラーがデッドコードだと考えるコードを書いていることになります。`string.IsNullOrEmpty` が通るのは偶然で、EF がこれを 2 つの述語へ展開し、`IS NULL` の側が結果を支えているだけです。`Length == 0` は、NULL が `length()` を通って伝播するという通常の理由で失敗します。

これは後段で直せるバグではありません。[issue #26230](https://github.com/dotnet/efcore/issues/26230) が "value conversion to null in the store generates bad queries" と言っているのはこのことであり、EF チームが 6.0 でこのコンストラクターを公開せず内部扱いにしたのもこのためです。失敗が目に見えず、検出も容易ではないからです。この道を選ぶなら、述語を信用せずに検証することが対策になります。テスト内で `ToQueryString()` を使うか、[EF Core 11 が生成する SQL をログ出力する](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)かのいずれかです。

## enum、int、DateTime で機能しない理由

null 非許容の値型では、`convertsNulls` は途中まで進んでそこで止まります。converter を書いてみます。

```csharp
// .NET 11, C# 14, EF Core 11
#pragma warning disable EF1001
public class NullToUnknown : ValueConverter<ShippingStatus, string?>
{
    public NullToUnknown()
        : base(
            v => v == ShippingStatus.Unknown ? null : v.ToString(),
            v => v == null ? ShippingStatus.Unknown : Enum.Parse<ShippingStatus>(v),
            convertsNulls: true)
    {
    }
}
#pragma warning restore EF1001
```

書き込み側は機能し、`ShippingStatus.Unknown` を保存すると `NULL` が書かれます。読み取り側は機能せず、その理由は上のステップ 3 にあります。`.IsRequired(false)` はモデル構築時に例外を投げます。

```
System.InvalidOperationException: The property 'Order.Status' cannot be marked as
nullable/optional because the type of the property is 'ShippingStatus' which is not a
nullable type. Any property can be marked as non-nullable/required, but only properties
of nullable types can be marked as nullable/optional.
```

EF の null 許容性のチェックは converter ではなく CLR 型を見るため、設定をどう組み合わせても到達できません。この呼び出しを省けばモデルは `IsNullable = False` のままとなり、EF は `IsDBNull` のチェックを飛ばし、NULL の行を読むたびに例外が飛びます。第 3 の選択肢はありません。null 非許容の値型に対する `convertsNulls` は書き込み専用の機能であり、それは役に立たないより悪い状態です。同じモデルでは読み戻せない NULL を、平然と永続化してしまうからです。

## 実際に機能する 2 つのパターン

### null 許容プロパティをマッピングし、非 null のファサードを公開する

マッピングされたプロパティがデータベースの null 許容性をそのまま正直に表します。ドメイン側のプロパティは素の C# で既定値への置き換えを行い、クエリの変換器は一切関与しません。

```csharp
// .NET 11, C# 14, EF Core 11
public class Order
{
    public int Id { get; set; }

    public ShippingStatus? StatusRaw { get; set; }

    [NotMapped]
    public ShippingStatus Status
    {
        get => StatusRaw ?? ShippingStatus.Unknown;
        set => StatusRaw = value == ShippingStatus.Unknown ? null : value;
    }
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.StatusRaw)
        .HasColumnName("Status")
        .HasConversion<string>()
        .HasMaxLength(20);
}
```

内部 API も `EF1001` も不要で、クエリは構造上正しくなります。`Where(o => o.StatusRaw == null)` は `WHERE "o"."Status" IS NULL` を生成して NULL の行にマッチし、`Where(o => o.StatusRaw == ShippingStatus.Shipped)` は `WHERE "o"."Status" = 'Shipped'` を生成します。enum を文字列にする側は通常の組み込み変換で、[value converter を使って enum を文字列として保存する方法](/ja/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)で扱っています。SQL Server がインデックスの効かない `nvarchar(max)` を割り当てるのを防ぐ `HasMaxLength` もそこに含まれます。

代償は、LINQ が `Status` ではなく `StatusRaw` を指す必要があることです。`Where` の中で `Status` を参照すると[LINQ 式を変換できませんでした](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)になります。`[NotMapped]` のメンバーには SQL 上の対応物がないためです。これは妥当な取引です。変換器が黙って `= NULL` を出す代わりに、その場で拒否してくれます。

### private なバッキングフィールドをマッピングする

`StatusRaw` で公開面を広げたくない場合は、フィールドをマッピングして公開プロパティを 1 つに保ちます。

```csharp
// .NET 11, C# 14, EF Core 11
public class Order
{
    public int Id { get; set; }

    private string? _notes;

    public string Notes
    {
        get => _notes ?? "";
        set => _notes = value.Length == 0 ? null : value;
    }
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>(e =>
    {
        e.Ignore(o => o.Notes);
        e.Property<string?>("_notes")
            .HasColumnName("Notes")
            .UsePropertyAccessMode(PropertyAccessMode.Field);
    });
}
```

読み書きの挙動はファサード版と同一で、`Where(o => EF.Property<string>(o, "_notes") == null)` は `WHERE "o"."Notes" IS NULL` に変換されます。欠点は、この列に触れるすべてのクエリが文字列指定の `EF.Property<T>` を経由することです。名前変更のリファクタリングは追随してくれません。追加の公開プロパティがどうしても受け入れられない場合を除き、ファサードを選んでください。

### あるいはデータを変える

はっきり書いておく価値があります。多くの場合、これが正解だからです。NULL とあなたのセンチネルがまったく同じ意味なら、スキーマはドメインに存在しない区別を抱え込んでいることになります。`UPDATE Orders SET Status = 'Unknown' WHERE Status IS NULL` を 1 回、`ALTER COLUMN ... NOT NULL` を 1 回、そして `HasDefaultValue("Unknown")` を入れれば、回避ではなく問題そのものが消えます。これはマッピングの小細工ではなくデータのマイグレーションであり、[マイグレーションでデータを失わずにテーブル名を変更する方法](/ja/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/)が、スキーマ変更とデータ変更を並走させるためにマイグレーションを手で編集する一般的な形を扱っています。

## この機能の現状

[issue #13850](https://github.com/dotnet/efcore/issues/13850)「Allow HasConversion/ValueConverters to convert nulls」は今も open で、期限のない Backlog マイルストーンに置かれています。`convertsNulls` を受け取る公開の `HasConversion` オーバーロードを求めた 2026 年の要望 [issue #36365](https://github.com/dotnet/efcore/issues/36365) は、その重複として close されました。したがって EF Core 11 においても、警告込みの 4 引数コンストラクターが到達点ということになります。

モデルのプロパティが参照型であり、センチネルをフィルターに使うことが決してなく、その列に触れるすべてのクエリについて `ToQueryString()` を検証するテストがある場合に限って使ってください。それ以外の場面、そして値型では常に、null 許容のプロパティをマッピングして C# 側で既定値へ置き換えてください。

### 次に読む

- [EF Core 11 で value converter を使って enum を文字列として保存する方法](/ja/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)
- [解決: EF Core 11 で "The LINQ expression could not be translated"](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [解決: EF Core 11 で "The property could not be mapped, because it is not a supported primitive type or a valid entity type"](/ja/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/)
- [EF Core 11 が生成する SQL をログ出力する方法](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [解決: C# の CS8618「Non-nullable property must contain a non-null value when exiting constructor」](/ja/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/)

### 参考資料

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions), EF Core ドキュメント
- [ValueConverter&lt;TModel,TProvider&gt; のコンストラクター](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.valueconverter-2.-ctor), .NET API リファレンス
- [Issue #26230: Problems with value converters that convert nulls](https://github.com/dotnet/efcore/issues/26230), dotnet/efcore
- [Issue #13850: Allow HasConversion/ValueConverters to convert nulls](https://github.com/dotnet/efcore/issues/13850), dotnet/efcore
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), EF Core ドキュメント
