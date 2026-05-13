---
title: "修正: System.Text.Json.JsonException: The JSON value could not be converted"
description: "System.Text.Json は、受信した JSON トークンが対象の CLR 型と一致しない場合にこの例外をスローします。JSON を型に合わせるか、両者を橋渡しする JsonConverter または JsonSerializerOption を登録してください。"
pubDate: 2026-05-13
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "ja"
translationOf: "2026/05/fix-jsonexception-the-json-value-could-not-be-converted"
translatedBy: "claude"
translationDate: 2026-05-13
---

修正方法: `System.Text.Json` がこの例外をスローしたのは、メッセージが指すパスにある JSON トークンを対象の CLR 型にデシリアライズできないためです。メッセージは通常、2 つの形で現れます。JSON の**トークンの種類**が間違っているか (数値が期待される場所に文字列がある、またはその逆、enum 値が期待される場所に数値がある)、JSON の種類は正しいが**内容**が型の解析ルールに合わない (ISO 形式でない日付、不正な `Guid`、`"NaN"` のようなリテラル) のどちらかです。呼び出しサイトごとに 3 つの修正のうちひとつを選びます。プロデューサーを変更して期待される JSON 形式を出力させる、実際に受け取る形式を受け入れるコンバーター (`JsonStringEnumConverter`、`JsonNumberHandling.AllowReadingFromString`) を有効にする、または自分で解析する `JsonConverter<T>` を書く、のいずれかです。

```text
System.Text.Json.JsonException: The JSON value could not be converted to MyApp.OrderStatus. Path: $.status | LineNumber: 0 | BytePositionInLine: 21.
   at System.Text.Json.ThrowHelper.ThrowJsonException(String message)
   at System.Text.Json.Serialization.Converters.EnumConverter`1.Read(Utf8JsonReader& reader, Type typeToConvert, JsonSerializerOptions options)
   at System.Text.Json.Serialization.JsonConverter`1.ReadCore(Utf8JsonReader& reader, JsonSerializerOptions options, ReadStack& state)
   at System.Text.Json.JsonSerializer.ReadFromSpan[TValue](ReadOnlySpan`1 utf8Json, JsonTypeInfo jsonTypeInfo)
   at System.Text.Json.JsonSerializer.Deserialize[TValue](String json, JsonSerializerOptions options)
```

このガイドは .NET 11 preview 4 と `System.Text.Json` 11.0.0-preview.4 に対して書かれています。例外型と `Path` / `LineNumber` / `BytePositionInLine` の各フィールドは `System.Text.Json` が .NET Core 3.0 で出荷されて以来安定しているため、以下のすべての修正は .NET 6、8、10、11 にそのまま当てはまります。バージョン間で動いているのはコンバーターのつまみだけです。`JsonNumberHandling` は .NET 5 で登場、`JsonStringEnumConverter<TEnum>` (ジェネリックで AOT に優しいバージョン) は .NET 8 で出荷、`[JsonStringEnumMemberName]` 属性は .NET 9 で到着しました。

最初に読むべきは **`Path`** セグメントです。これは `$` をルートとする JSON Pointer 風のパスで、リーダーがどのプロパティで詰まったかを正確に教えてくれます。検索エンジンは、どのプロパティかのヒントなしに汎用コンバーターを示すスタックトレース ("the JSON value could not be converted to `Int32`") に誘導しがちですが、`Path` は常にそこにあります。`Path` セグメントが見えない場合、ラップされた例外を見ています。デシリアライズの呼び出しサイトで `JsonException` を直接キャッチし、`ex.Message` からではなくプロパティから `ex.Path` を読んでください。

## System.Text.Json が変換を拒む理由

`Newtonsoft.Json` と違い、`System.Text.Json` は**既定で厳格**です。JSON トークンの種類間の強制変換を行わず、文字列の内容に対して損失のあるパーサーを実行しません。エンドポイントが `{ "amount": "12.50" }` を受け取り、DTO に `decimal Amount` がある場合、リーダーは `JsonTokenType.String` を見て、`string` から `decimal` への組み込み変換が見つからず、スローします。同じロジックが以下を拒否します。

- プロパティが `bool`、`int`、`long`、`decimal`、`double`、`Guid`、`DateTime`、`TimeSpan` を期待する場所の JSON 文字列。逆方向 (プロパティが `string` を期待する場所の JSON 数値) も拒否されます。
- `JsonStringEnumConverter` が登録されていないときに enum 値を表す JSON 数値、**または**整数のみを受け付ける既定のコンバーターが有効なときに enum 値を表す JSON 文字列。
- プロパティが値型を期待する場所の空文字列 `""`。空文字列は `null` と同じではなく、値型は `T?` として宣言されていない限り null 許容ではありません。
- 登録した `[JsonDerivedType]` のいずれにも一致しないディスクリミネーターを持つポリモーフィックな JSON オブジェクト。
- `JsonNumberHandling.AllowNamedFloatingPointLiterals` が設定されていないときの `"NaN"`、`"Infinity"`、`"-Infinity"` のような浮動小数点リテラル。
- `DateTime` プロパティに対する Unix タイムスタンプ数値 (`1715600000`)。`System.Text.Json` は `DateTime` を ISO 8601 文字列からのみ読み取るためです。専用ケースは [DateTime 変換の正典的な修正](/ja/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/)で扱っています。

厳格さは設計であって、バグではありません。チームの根拠は、損失のある変換が業務アプリにおけるサイレントなデータ破損の最も一般的な源であり、明示的なコンバーター登録がワイヤフォーマットと型システムの境目で意図を可視化するというものです。トレードオフとして、`Newtonsoft.Json` の既定値から得ていたあらゆる横断的な処理 (文字列から数値、文字列から enum、文字列から bool) には、今や明示的なオプトインが必要になります。

## 最小再現

最も一般的なバリアント、文字列として届く enum を再現する最小プログラムです。

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

var json = """{ "status": "Pending" }""";

var order = JsonSerializer.Deserialize<Order>(json);

Console.WriteLine(order!.Status);

public record Order(OrderStatus Status);
public enum OrderStatus { Pending, Shipped, Delivered }
```

これを実行するとスローされます。

```text
Unhandled exception. System.Text.Json.JsonException:
The JSON value could not be converted to OrderStatus. Path: $.status | LineNumber: 0 | BytePositionInLine: 20.
```

既定の enum コンバーターは**整数**表現 (`{ "status": 0 }`) のみを受け付けます。それ以外はすべて例外を引き起こします。これが失敗モードだと理解すれば、本記事の他のバリアントもすべて同じパターンに従います。JSON 形式が型と一致せず、どちら側を曲げるかを選ぶ、というものです。

## 修正 1: 文字列として受け取る enum

`JsonStringEnumConverter<TEnum>` を `JsonSerializerOptions` に一度だけ登録します。

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
var options = new JsonSerializerOptions
{
    Converters = { new JsonStringEnumConverter<OrderStatus>() }
};

var order = JsonSerializer.Deserialize<Order>(json, options)!;
```

多数の enum がある場合は、代わりに非ジェネリックの `JsonStringEnumConverter()` を登録します。シリアライザーが遭遇するすべての enum 型に適用されますが、Native AOT のトリミングと互換性がなくなる代償があります。Native AOT では、enum ごとのジェネリックコンバーターを使うか、各 enum に直接 `[JsonConverter(typeof(JsonStringEnumConverter<OrderStatus>))]` を付け、グローバルコンバーター一覧は空のままにします。

プロデューサーが大文字小文字を区別する場合 (ワイヤー上は "PENDING"、C# では `Pending`)、命名ポリシーを渡します。

```csharp
var options = new JsonSerializerOptions
{
    Converters =
    {
        new JsonStringEnumConverter<OrderStatus>(JsonNamingPolicy.SnakeCaseUpper)
    }
};
```

C# 識別子として表せない値 ("in-progress"、"n/a") を送るプロデューサー向けに、.NET 9 では `[JsonStringEnumMemberName]` が導入されました。

```csharp
public enum OrderStatus
{
    Pending,

    [JsonStringEnumMemberName("in-progress")]
    InProgress,

    Delivered
}
```

ASP.NET Core のミニマル API では、すべてのエンドポイントが拾うように、アプリケーションの `JsonSerializerOptions` にコンバーターを構成します。

```csharp
// .NET 11 preview 4, ASP.NET Core 11.0.0-preview.4
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter<OrderStatus>());
});
```

コントローラーの場合、等価な呼び出しは `builder.Services.AddControllers().AddJsonOptions(o => o.JsonSerializerOptions.Converters.Add(...))` です。すべての `[JsonConverter(...)]` 属性で `JsonConverter` を開くより、コンポジションルートで一度構成する方が望ましいです。

## 修正 2: 文字列として受け取る数値 (およびその逆)

プロデューサーが数値フィールドを JSON で文字列としてエンコードする場合 (`{ "amount": "12.50" }`)、`JsonNumberHandling.AllowReadingFromString` をオプトインします。

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
var options = new JsonSerializerOptions
{
    NumberHandling = JsonNumberHandling.AllowReadingFromString
};

var dto = JsonSerializer.Deserialize<Invoice>(json, options);

public record Invoice(decimal Amount);
```

`AllowReadingFromString` は、すべての整数型・浮動小数点型と `decimal` で機能します。`WriteAsString` と対称的で、シリアライザーに値を文字列として出力かつ読み取らせたい場合は組み合わせられます。

```csharp
NumberHandling = JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString
```

グローバルではなくプロパティ単位のスコープにするには、プロパティに直接属性を付けます。

```csharp
public record Invoice(
    [property: JsonNumberHandling(JsonNumberHandling.AllowReadingFromString)] decimal Amount
);
```

逆のケース、`string` が期待される場所に送られた JSON 数値 (`"42"` の代わりに `42` としてエンコードされた追跡 ID) は、`JsonNumberHandling` の対象**ではありません**。小さなカスタムコンバーターが必要です。

```csharp
// .NET 11 preview 4
public sealed class NumberOrStringConverter : JsonConverter<string>
{
    public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.TokenType switch
        {
            JsonTokenType.String => reader.GetString(),
            JsonTokenType.Number => reader.GetInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
            JsonTokenType.Null => null,
            _ => throw new JsonException()
        };

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

コンバーターの契約は [カスタム JsonConverter を書くガイド](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)でさらに深く取り上げており、コンバーターの合成や、ポリモーフィックなディスパッチを短絡する方法も扱っています。

## 修正 3: 0 / 1 や "true" / "false" 文字列として受け取るブール値

`System.Text.Json` は `bool` に対して JSON の `true` / `false` トークンのみを受け付けます。数値の `0` / `1` も文字列の `"true"` / `"false"` も拒否されます。どちらの形式に対しても組み込みのオプションはありません。コンバーターを書きましょう。

```csharp
// .NET 11 preview 4
public sealed class LooseBooleanConverter : JsonConverter<bool>
{
    public override bool Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.TokenType switch
        {
            JsonTokenType.True => true,
            JsonTokenType.False => false,
            JsonTokenType.Number => reader.GetInt32() != 0,
            JsonTokenType.String => bool.Parse(reader.GetString()!),
            _ => throw new JsonException()
        };

    public override void Write(Utf8JsonWriter writer, bool value, JsonSerializerOptions options)
        => writer.WriteBooleanValue(value);
}
```

グローバルではなく `[JsonConverter(typeof(LooseBooleanConverter))]` でプロパティ単位に登録してください。行儀の良い API のほとんどのフィールドは緩くないため、すべての `bool` を 3 つの形式を受け入れるように曲げると契約が曖昧になります。

## 修正 4: 値型に対する空文字列

プロデューサーが欠落した日付に対して `{ "shippedAt": "" }` を出力すると、`System.Text.Json` は `JsonTokenType.String` を読み取り、空の内容を `DateTime` として解析できずに失敗します。きれいな修正は 2 つあります。1 つ目は、C# プロパティを null 許容にし、`""` を `null` にマップするコンバーターを書く方法です。

```csharp
public sealed class NullableDateTimeConverter : JsonConverter<DateTime?>
{
    public override DateTime? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        if (reader.TokenType == JsonTokenType.String)
        {
            var s = reader.GetString();
            return string.IsNullOrEmpty(s) ? null : DateTime.Parse(s, System.Globalization.CultureInfo.InvariantCulture);
        }
        throw new JsonException();
    }

    public override void Write(Utf8JsonWriter writer, DateTime? value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

2 つ目は、`JsonSerializerOptions.RespectNullableAnnotations = true` (.NET 9+ では既定) を設定し、プロデューサーに `""` ではなく `null` を送らせる方法です。両側を制御している場合は、プロデューサー側の修正が望ましいです。`""` を null として扱う特例はやがて null 許容でない列や下流の NullReferenceException に漏れていくからです。

## 修正 5: 不正な形式の Guid

`System.Text.Json` は `D` 形式 (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) で `Guid.TryParseExact` を使います。波括弧付き (`{...}`)、丸括弧付き (`(...)`)、ダッシュなし (`N`) のいずれの表現もスローします。最短の修正はプロパティ単位のコンバーターです。

```csharp
public sealed class FlexibleGuidConverter : JsonConverter<Guid>
{
    public override Guid Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var s = reader.GetString();
        return Guid.Parse(s!);
    }

    public override void Write(Utf8JsonWriter writer, Guid value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

`Guid.Parse` はすべての標準フォーマット文字列を受け付けるので、これで十分です。

## 修正 6: 不明なディスクリミネーターを持つポリモーフィックなオブジェクト

`[JsonPolymorphic]` と `[JsonDerivedType]` で基底型を宣言すると、リーダーはディスクリミネータープロパティを検査し、一致するサブタイプへ進みます。ディスクリミネーターの値が欠落しているか不明な場合、リーダーは "the JSON value could not be converted to BaseType" をスローします。本番品質の修正は 2 つです。

- `UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType` を設定し、一致する派生型がない場合にリーダーが基底型を実体化するようにします。
- 1 段より深いクラス階層を持ち、最も近い登録済みの祖先を使いたい場合は、`UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor` を設定します。

```csharp
// .NET 11 preview 4
[JsonPolymorphic(
    TypeDiscriminatorPropertyName = "$kind",
    UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType)]
[JsonDerivedType(typeof(EmailEvent), "email")]
[JsonDerivedType(typeof(SmsEvent), "sms")]
public abstract record Event;

public record EmailEvent(string To, string Subject) : Event;
public record SmsEvent(string To, string Body) : Event;
```

既定の動作 (`JsonUnknownDerivedTypeHandling.FailSerialization`) は、すべてのバリアントが既知である閉じたスキーマでは正しいです。配置を調整せずに新しいバリアントを追加するプロデューサーからイベントを取り込む場合は、フォールバックオプションを使います。

## 修正 7: 浮動小数点の NaN と Infinity

プロデューサー側のシリアライザーが `double` / `float` に対して `"NaN"`、`"Infinity"`、`"-Infinity"` を出す場合、オプトインします。

```csharp
var options = new JsonSerializerOptions
{
    NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals
};
```

これは対称的で、同じオプションは書き込みパスでシリアライザーにこれらのリテラルを出力させもします。これがないと、読み取りも書き込みも両方スローします。

## 落とし穴と紛らわしいケース

- **例外メッセージは具体型ではなく基底型を示します。** ポリモーフィックなデシリアライズは、ディスクリミネーターが指していた型ではなく、ポリモーフィックなルートに対して失敗を報告します。コンバーターが悪いと決めつける前に、生の JSON でディスクリミネーターの値を確認してください。
- **ソース生成されたコンテキストはオプションを隠します。** `JsonSerializerContext` に `[JsonSerializable(typeof(Order))]` を宣言した場合、渡す実行時 `JsonSerializerOptions` のコンバーター一覧は**尊重**されますが、ソース生成されたメタデータもコンパイル時に `[JsonConverter]` 属性をエンコードします。両方を混在させても問題ありませんが、プロパティレベルの `[JsonConverter(...)]` は常に実行時登録のグローバルに勝ちます。この領域のエルゴノミクスの作業については [System.Text.Json ソース生成のための C# 14 インターセプターサポート](/ja/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/)を参照してください。
- **大文字小文字の感度はコンバーターから独立しています。** `PropertyNameCaseInsensitive = true` と大文字小文字を意識した命名ポリシー (`JsonNamingPolicy.CamelCase`、`JsonNamingPolicy.SnakeCaseLower`、[.NET 11 のメンバー単位の PascalCase 命名](/ja/2026/04/system-text-json-11-pascalcase-per-member-naming/)属性) は、リーダーがどの CLR プロパティにバインドするかに影響し、値の変換方法には影響しません。エラーが `Path: $.OrderStatus` を示しているのに JSON が `"orderStatus"` の場合、変換失敗ではなくバインドの取りこぼしを見ています。
- **DateTime のブランチは独自の慣習を持ちます。** ISO 8601 のみ、`T` 区切りのみ、Unix タイムスタンプはなしです。受け入れ・拒否される形式の完全な表は [DateTime 変換専用の修正](/ja/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/)にあります。
- **収まらない数値を読む。** JSON の `9999999999` は `int` に読み込めず、同じ例外テキストでスローします。形式の問題と決めつける前に、大きさを確認してください。
- **Newtonsoft.Json はサイレントに強制変換していました。** このバグへの最も一般的な経路は、`Newtonsoft.Json` からの移行で、Newtonsoft が裏で文字列から decimal への変換を試みていたために古いコードが `{ "amount": "12.50" }` を受け入れていた、というケースです。`System.Text.Json` にはグローバルな "寛容にせよ" スイッチはありません。`NumberHandling` を設定して `JsonStringEnumConverter` を登録するか、その境界では Newtonsoft にとどまるか、です。

## 関連

- [修正: The JSON value could not be converted to System.DateTime](/ja/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) では、ISO 8601 形式の要件と Unix タイムスタンプの解析を含む、DateTime 固有のバリアントを扱います。
- [System.Text.Json でカスタム JsonConverter を書く方法](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) では、コンバーターの契約、ファクトリーコンバーター、既定のコンバーターへのフォールスルー方法を示します。
- [System.Text.Json 11 のメンバー単位 PascalCase 命名](/ja/2026/04/system-text-json-11-pascalcase-per-member-naming/) は、失敗が値の変換ではなくプロパティのバインディングである場合の正しい道具です。
- [System.Text.Json ソース生成のための C# 14 インターセプター](/ja/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) では、ソース生成されたコンバーターが実行時の `JsonSerializerOptions` とどのように相互作用するかを説明します。
- [修正: InvalidOperationException: Synchronous operations are disallowed](/ja/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/) は無関係ですが、ASP.NET Core でバッファリングされた JSON からストリーミング JSON へ移行する際に JSON 変換エラーと一緒に当たることがよくあります。

## 出典

- [System.Text.Json の概要、.NET docs](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/overview)
- [enum 値のシリアライズとデシリアライズの方法、MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/customize-properties)
- [`JsonNumberHandling` リファレンス](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonnumberhandling)
- [`JsonPolymorphicAttribute` と `JsonDerivedTypeAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonpolymorphicattribute)
- [`JsonStringEnumMemberNameAttribute`, .NET 9+](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenummembernameattribute)
- [`dotnet/runtime` の `EnumConverter<T>` ソース](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/System/Text/Json/Serialization/Converters/Value/EnumConverter.cs)
