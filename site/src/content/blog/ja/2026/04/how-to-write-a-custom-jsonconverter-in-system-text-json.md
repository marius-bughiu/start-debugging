---
title: "System.Text.Json でカスタム JsonConverter を書く方法"
description: ".NET 11 における System.Text.Json 用のカスタム JsonConverter<T> の完全ガイドです。本当に必要となる場面、Utf8JsonReader を正しく進める方法、JsonConverterFactory によるジェネリクスの扱い、そして AOT に優しい実装方法までを解説します。"
pubDate: 2026-04-25
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "serialization"
lang: "ja"
translationOf: "2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json"
translatedBy: "claude"
translationDate: 2026-04-25
---

`System.Text.Json` 用のカスタムコンバーターを書くには、`JsonConverter<T>` から派生し、`Read` と `Write` をオーバーライドして、対象の型を `[JsonConverter(typeof(MyConverter))]` で装飾するか、インスタンスを `JsonSerializerOptions.Converters` に追加します。`Read` の中では、値が占めるトークン数を過不足なく `Utf8JsonReader` 上で進める必要があります。そうしないと、次のデシリアライザー呼び出しが壊れたストリームを見ることになります。`Write` の中では `Utf8JsonWriter` のメソッドを直接呼び出し、必要がなければ中間文字列を割り当てません。ジェネリック型や多態性については、`JsonConverterFactory` を使えば、ひとつのクラスから多くのクローズドジェネリックの実体化に対するコンバーターを生成できます。本ガイドはすべて .NET 11 (preview 3) と C# 14 をターゲットとしますが、API は .NET Core 3.0 から安定しているので、同じコードがサポートされているすべてのランタイムで動作します。

## JsonConverter が正しい選択肢となる場面

ほとんどのチームはカスタムコンバーターに早く手を出しすぎます。書き始める前に、自分の問題が .NET 11 (および以前) に組み込まれている機能で解決できないかを確認してください。

- プロパティ名が一致しない場合: `JsonPropertyNameAttribute` または `JsonNamingPolicy` を使います。Preview 3 では `JsonNamingPolicy.PascalCase` とメンバーレベルの `[JsonNamingPolicy]` 属性が追加されたので、[System.Text.Json 11 の命名ポリシー](/ja/2026/04/system-text-json-11-pascalcase-per-member-naming/)で必要なものはおそらくカバーされます。
- 数値を文字列として扱いたい場合: `JsonSerializerOptions` 上の `JsonNumberHandling.AllowReadingFromString`。
- 列挙型を文字列として扱いたい場合: `JsonStringEnumConverter` が組み込まれています。[Native AOT 向けのトリム対応版](/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/)もあります。
- 読み取り専用プロパティやコンストラクター引数: ソースジェネレーター (`[JsonSerializable]` と `JsonSerializerContext`) が record とプライマリコンストラクターを直接扱います。
- 識別子による多態性: `[JsonDerivedType]` と `[JsonPolymorphic]` (.NET 7 で追加) があれば、古いコンバーターのトリックはほとんど不要になります。

カスタムコンバーターが正しい選択肢となるのは、JSON の形と .NET の形が本当に乖離しているときです。例:

- プリミティブとしてシリアライズされるべき値型 (`Money` を `"42.00 USD"` にする)。
- JSON 形式が文脈依存である型 (時には文字列、時にはオブジェクト)。
- 同じプロパティ名が兄弟フィールドに応じて異なる型を持つツリー。
- 自分が所有していないワイヤフォーマット (Stripe 風のセント単位金額、ISO 8601 の duration、RFC 5545 の繰り返しルールなど)。

これらに当てはまらないなら、組み込み機能を使い、この記事は読み飛ばしてください。

## JsonConverter<T> の契約

`System.Text.Json.Serialization.JsonConverter<T>` には、必ずオーバーライドする 2 つの抽象メソッドと、いくつかのオプションのフックがあります。

```csharp
// .NET 11, C# 14
public abstract class JsonConverter<T> : JsonConverter
{
    public abstract T? Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options);

    public abstract void Write(
        Utf8JsonWriter writer,
        T value,
        JsonSerializerOptions options);

    // Optional: opt in to dictionary-key handling.
    public virtual T ReadAsPropertyName(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options) => throw new NotSupportedException();

    public virtual void WriteAsPropertyName(
        Utf8JsonWriter writer,
        T value,
        JsonSerializerOptions options) => throw new NotSupportedException();

    public virtual bool HandleNull => false;
}
```

このシグネチャで間違いやすいポイントが 2 つあります。

1. `Read` は `Utf8JsonReader` を `ref` で受け取ります。リーダーはカーソルを保持するミュータブルな構造体です。ヘルパーメソッドに渡す場合も `ref` で渡してください。そうしないと呼び出し側のカーソルが進まず、同じトークンを永遠に読み続けることになります。
2. `HandleNull` は既定で `false` であり、これは JSON の `null` に対してシリアライザーが `default(T)` を返してコンバーターを呼び出さないことを意味します。`null` を非デフォルト値にマップしたい場合 (あるいは "存在しない" と "null" を区別したい場合)、`HandleNull => true` を設定して自分で `reader.TokenType == JsonTokenType.Null` をチェックしてください。

完全な契約は、[カスタムコンバーターの書き方](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to)に関する公式 MS Learn ページに記載されています。本記事の残りはその実践版です。

## 実例: Money 値型

強い型付けの `Money` 値を考えます。

```csharp
// .NET 11, C# 14
public readonly record struct Money(decimal Amount, string Currency)
{
    public override string ToString() =>
        $"{Amount.ToString("0.00", CultureInfo.InvariantCulture)} {Currency}";
}
```

`System.Text.Json` の既定動作ではこれを `{"Amount":42.00,"Currency":"USD"}` としてシリアライズします。代わりに、ひとつの文字列トークン `"42.00 USD"` にしたいわけです。これがまさにコンバーターの目的に合致する形状の不一致です。

```csharp
// .NET 11, C# 14
using System.Buffers;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class MoneyJsonConverter : JsonConverter<Money>
{
    public override Money Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String)
            throw new JsonException(
                $"Expected string for Money, got {reader.TokenType}.");

        string raw = reader.GetString()!; // "42.00 USD"
        int space = raw.LastIndexOf(' ');
        if (space <= 0 || space == raw.Length - 1)
            throw new JsonException($"Invalid Money literal: '{raw}'.");

        decimal amount = decimal.Parse(
            raw.AsSpan(0, space),
            NumberStyles.Number,
            CultureInfo.InvariantCulture);
        string currency = raw[(space + 1)..];

        return new Money(amount, currency);
    }

    public override void Write(
        Utf8JsonWriter writer,
        Money value,
        JsonSerializerOptions options)
    {
        // Formats directly into the writer's UTF-8 buffer.
        Span<char> buffer = stackalloc char[64];
        if (!value.Amount.TryFormat(
                buffer, out int written,
                "0.00", CultureInfo.InvariantCulture))
        {
            writer.WriteStringValue(value.ToString());
            return;
        }

        // "<number> <currency>" without intermediate string allocation.
        Span<char> output = stackalloc char[written + 1 + value.Currency.Length];
        buffer[..written].CopyTo(output);
        output[written] = ' ';
        value.Currency.AsSpan().CopyTo(output[(written + 1)..]);
        writer.WriteStringValue(output);
    }
}
```

注目すべき詳細をいくつか挙げます。

- `reader.GetString()` はマネージド `string` をマテリアライズします。何百万件ものレコードをデシリアライズしていて、解析後の値が短命であるなら、割り当てを避けるため `reader.ValueSpan` (UTF-8 バイト) と `Utf8Parser` の組み合わせを使ってください。
- `writer.WriteStringValue(ReadOnlySpan<char>)` は writer のプールされたバッファに直接 UTF-8 エンコードします。中間の `string` はありません。このオーバーロードと `WriteStringValue(ReadOnlySpan<byte> utf8)` が安価な経路です。
- `JsonException` は "データが間違っている" ことを表す標準的な例外です。シリアライザーは呼び出し元に届く前に行と位置の情報をラップしてくれるので、自分で追加する必要はありません。

## 正しく読む: カーソルの規律

カスタムコンバーターで最もよくあるバグは、リーダーを正しいトークンに残せないことです。契約は次のとおりです。

> `Read` が戻るとき、リーダーは**値が消費した最後のトークン**の上に位置していなければならず、次のトークンの上ではいけません。

シリアライザーは値の間で `reader.Read()` を 1 回呼び出します。コンバーターがトークンを過剰に消費すると、次のプロパティが暗黙にスキップされます。逆に少なすぎると、次のデシリアライザー呼び出しが不正なストリームを見ることになり、想定外のトークンで例外を投げます。

ほぼあらゆる場合をカバーする 2 つのルールがあります。

1. 単一トークン値 (文字列、数値、真偽値) の場合、現在のトークンから読み取る以外には何もしません。`Read` が呼び出されたとき、カーソルはすでに正しいトークンの上にあります。
2. オブジェクトや配列の場合、対応する `EndObject` または `EndArray` トークンが見えるまでループし、ループの最終 `reader.Read()` がちょうどその閉じトークンに着地するようにします。

オブジェクト読み取りの定型スケルトンは次のとおりです。

```csharp
// .NET 11, C# 14
public override Foo Read(
    ref Utf8JsonReader reader,
    Type typeToConvert,
    JsonSerializerOptions options)
{
    if (reader.TokenType != JsonTokenType.StartObject)
        throw new JsonException();

    var result = new Foo();

    while (reader.Read())
    {
        if (reader.TokenType == JsonTokenType.EndObject)
            return result;

        if (reader.TokenType != JsonTokenType.PropertyName)
            throw new JsonException();

        string property = reader.GetString()!;
        reader.Read(); // advance to the value token

        switch (property)
        {
            case "id":
                result.Id = reader.GetInt32();
                break;
            case "name":
                result.Name = reader.GetString();
                break;
            case "child":
                // Recurse through the serializer so nested converters and
                // contracts apply.
                result.Child = JsonSerializer.Deserialize<Child>(
                    ref reader, options);
                break;
            default:
                reader.Skip(); // unknown field, advance past its value
                break;
        }
    }

    throw new JsonException(); // unexpected end of stream
}
```

`reader.Skip()` は過小評価されがちなヘルパーです。現在のトークンが導入するもの (ネストされたオブジェクトや配列を含む) を読み飛ばし、カーソルをその閉じトークンの上に残します。理解できないものについてはこれを使い、独自のスキップループを書かないでください。

## 効率よく書く: writer から離れない

`Utf8JsonWriter` はプールされた UTF-8 バッファに直接書き込むので、マネージド `string` を必要としないものはヒープから外しておくべきです。3 つのルールがあります。

1. 型付きオーバーロードを優先してください: `WriteNumber`、`WriteBoolean`、`WriteString(ReadOnlySpan<char>)`。これらはバッファに直接フォーマットします。
2. オブジェクト内のプロパティと値のペアには、`WriteString("name", value)` などを使ってください。割り当てなしに、プロパティ名と値を 1 回の呼び出しで出力します。
3. 文字列を組み立てる必要がある場合は、`string.Format` や文字列補間 (どちらも割り当てが発生する) ではなく、`string.Create` やスタック割り当ての `Span<char>` を使ってください。

上の `Money` の例では、UTF-8 を直接使えばさらに安価になります。

```csharp
// .NET 11, C# 14, micro-optimized hot path
public override void Write(
    Utf8JsonWriter writer,
    Money value,
    JsonSerializerOptions options)
{
    Span<byte> buffer = stackalloc byte[64];
    if (!value.Amount.TryFormat(
            buffer, out int written,
            "0.00", CultureInfo.InvariantCulture))
    {
        writer.WriteStringValue(value.ToString());
        return;
    }

    int currencyLen = Encoding.UTF8.GetByteCount(value.Currency);
    Span<byte> output = stackalloc byte[written + 1 + currencyLen];
    buffer[..written].CopyTo(output);
    output[written] = (byte)' ';
    Encoding.UTF8.GetBytes(value.Currency, output[(written + 1)..]);
    writer.WriteStringValue(output);
}
```

このバージョンは、フォーマット済み値に対するマネージド文字列を一切生成しません。毎秒数万件の `Money` インスタンスをシリアライズするサービスでは、これが割り当てレートにおける測定可能な差になります。

## ジェネリック型と JsonConverterFactory

`JsonConverter<T>` はクローズドな型です。閉じたジェネリックすべてに対して動作する `Result<TValue, TError>` 用のコンバーターが欲しい場合は、必要に応じてクローズドコンバーターを生成する `JsonConverterFactory` を書きます。

```csharp
// .NET 11, C# 14
public sealed class ResultJsonConverterFactory : JsonConverterFactory
{
    public override bool CanConvert(Type typeToConvert) =>
        typeToConvert.IsGenericType
        && typeToConvert.GetGenericTypeDefinition() == typeof(Result<,>);

    public override JsonConverter CreateConverter(
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        Type[] args = typeToConvert.GetGenericArguments();
        Type closed = typeof(ResultConverter<,>).MakeGenericType(args);
        return (JsonConverter)Activator.CreateInstance(closed)!;
    }

    private sealed class ResultConverter<TValue, TError>
        : JsonConverter<Result<TValue, TError>>
    {
        public override Result<TValue, TError> Read(
            ref Utf8JsonReader reader,
            Type typeToConvert,
            JsonSerializerOptions options) =>
            throw new NotImplementedException(); // exercise for the reader

        public override void Write(
            Utf8JsonWriter writer,
            Result<TValue, TError> value,
            JsonSerializerOptions options) =>
            throw new NotImplementedException();
    }
}
```

ファクトリは通常のコンバーターと同じ方法で登録されます (属性または `Options.Converters.Add`)。シリアライザーは閉じたジェネリックごとに閉じたコンバーターをキャッシュするので、`CreateConverter` は `JsonSerializerOptions` インスタンスごと、`(TValue, TError)` ペアごとに 1 回だけ実行されます。

`Activator.CreateInstance` と `MakeGenericType` の組み合わせはリフレクションであり、Native AOT とトリムには敵対的です。AOT をターゲットにする場合は、下の AOT セクションを参照してください。

## コンバーターの登録

2 つの方法があり、優先順位が異なります。

```csharp
// .NET 11, C# 14
[JsonConverter(typeof(MoneyJsonConverter))]
public readonly record struct Money(decimal Amount, string Currency);
```

属性はコンバーターを型に固定し、オプション単位のセットアップなしにすべての `JsonSerializer` 呼び出しから尊重されます。自分が所有する値型にはこれを使ってください。

```csharp
// .NET 11, C# 14
var options = new JsonSerializerOptions
{
    Converters = { new MoneyJsonConverter() }
};

string json = JsonSerializer.Serialize(invoice, options);
```

オプション単位の登録は、対象の型を所有していない場合、コンバーターが環境固有 (テスト対本番) である場合、または単一の型が文脈ごとに異なる形を必要とする場合 (公開 API 対内部ログ) に正しい答えです。

優先順位の高いものから低いものへの探索順は次のとおりです。

1. `JsonSerializer` 呼び出しに直接渡されたコンバーター。
2. プロパティ上の `[JsonConverter]`。
3. `Options.Converters` (一致する型に対して、最後に追加されたものが優先)。
4. 型上の `[JsonConverter]`。
5. その型の組み込み既定。

2 つのコンバーターが異なる仕組みで同じ型を主張する場合、このリストで上位にあるものが勝ちます。"なぜコンバーターが動かないのか" をデバッグする前に、これを頭の中でスケッチしてください。ほぼ常に、プロパティ属性かオプションエントリが型属性を上書きしているはずです。

## ソースジェネレーターと Native AOT

`JsonConverter<T>` はソースジェネレーターと一緒に動作します。`JsonSerializerContext` で型を宣言すると、ジェネレーターは適切な箇所でコンバーターに委譲するメタデータプロバイダーを生成します。同じことが `JsonConverterFactory` に対して自動的に成り立つわけでは**ありません**。ファクトリが `MakeGenericType` や `Activator.CreateInstance` で行うことはリフレクションであり、トリムや AOT は静的に見ることができません。

AOT に優しいファクトリのためには、次のいずれかを行ってください。

- ファクトリを既知で有限な閉じたジェネリックの集合に制限し、ペアごとに直接 `new ResultConverter<MyValue, MyError>()` でインスタンス化する。
- ファクトリに `[RequiresDynamicCode]` と `[RequiresUnreferencedCode]` を付与し、トリム警告を受け入れ、AOT 利用者は閉じたコンバーターを手動で登録する必要があることをドキュメント化する。

[ソース生成された JSON 向けの C# 14 インターセプター提案](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/)で論じられている、インターセプターを使って `JsonSerializer.Serialize` 呼び出しが生成されたコンテキストを自動的に拾うパターンは、コンバーターとは独立しています。それを使っても、カスタム `JsonConverter<T>` の書き方は同じです。

## はまりやすい順に並べた落とし穴

- **`EndObject`/`EndArray` を超えてリーダーを進めるのを忘れる。** 症状: 親オブジェクトの次のプロパティが暗黙にスキップされる、あるいはパーサーが 2 階層上で紛らわしいエラーを投げる。`{ "wrapped": <yourThing>, "next": 1 }` をデシリアライズして `next` が読まれることをアサートするコンバーターのテストを書いて監査してください。
- **コンバーターが扱うのと同じ `T` で `JsonSerializer.Deserialize<T>(ref reader, options)` を呼び出す。** これは無限再帰します。シリアライザーを通した再帰は、*他の*型 (子要素、ネストされた値) のためのものです。
- **`await` をまたいで `Utf8JsonReader` を保持する。** リーダーは `ref struct` なのでコンパイラーは許可しませんが、値をローカル変数にコピーアウトし後で再付着しようと誘惑されるかもしれません。やめてください。`Read` の中で値全体を同期的に読み取ってください。データソースが非同期なら、まず `ReadOnlySequence<byte>` にバッファリングし、それをリーダーに渡してください。
- **不正なデータに対して `JsonException` 以外を投げる。** 他の例外はラップされずにシリアライザーの境界を越え、行と位置の文脈を失います。
- **最初のシリアライズ呼び出しの後で `JsonSerializerOptions` を変更する。** シリアライザーはオプションインスタンスごとに解決済みコンバーターをキャッシュします。後続の変更は `InvalidOperationException` を投げます。代わりに新しいオプションインスタンスを構築するか、設定が完了したら明示的に `MakeReadOnly()` を呼び出してください。
- **インターフェースや抽象型に `JsonConverterAttribute` を使い、自動的に多態性が得られると期待する。** そういう仕組みではありません。階層シリアライズには `[JsonPolymorphic]` と `[JsonDerivedType]` を使うか、識別子ディスパッチを自分で行うカスタムコンバーターを書いてください。
- **`Write` の中で割り当てる。** `JsonSerializer.Serialize(value)` を再帰的に書いて、それが `string` を生成しその後 writer に書き戻していることを忘れるのはよくあることです。代わりに `Serialize` の `ref Utf8JsonWriter` オーバーロードを使ってください。

これらを念頭に置いていれば、コンバーターは 30 行を超えるコードを必要とすることはほとんどなく、組み込みシリアライザーと同じ割り当て予算で動作します。

## 関連記事

- [How to use Channels instead of BlockingCollection in C#](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) -- 非同期ファーストのパターン、同じ時代の API 設計。
- [System.Text.Json in .NET 11 Preview 3 adds PascalCase and per-member naming](/ja/2026/04/system-text-json-11-pascalcase-per-member-naming/) -- 命名ポリシーで十分でコンバーターが不要な場合。
- [How to use JsonStringEnumConverter with Native AOT](/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/) -- 組み込みコンバーターのトリム/AOT 事情。
- [Interceptors for System.Text.Json source generation](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) -- 並行する人間工学方向の話、追跡の価値あり。
- [How to return multiple values from a method in C# 14](/ja/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) -- 値タプルと record のパターン。コンバーターが必要になりがち。

## 出典

- MS Learn: [Write custom converters for JSON serialization](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to)
- MS Learn: [How to use the source generator in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- API リファレンス: [`Utf8JsonReader`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.utf8jsonreader)、[`Utf8JsonWriter`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.utf8jsonwriter)
- System.Text.Json エリアの dotnet/runtime 課題トラッカー: [area-System.Text.Json](https://github.com/dotnet/runtime/labels/area-System.Text.Json)
