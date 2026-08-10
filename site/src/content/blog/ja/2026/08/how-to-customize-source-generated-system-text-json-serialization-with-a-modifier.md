---
title: "ソース生成された System.Text.Json のシリアル化を type info resolver のモディファイアーでカスタマイズする方法"
description: ".NET 11 でソース生成された JsonSerializerContext に JsonTypeInfo のモディファイアーを付ける方法です。new MyContext(options) が黙って破棄する理由、動作する WithAddedModifier の構成、失う高速パス（実測値つき）、そしてモディファイアーを無効化する命名ポリシーの落とし穴を扱います。"
pubDate: 2026-08-10
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "source-generators"
  - "serialization"
  - "how-to"
lang: "ja"
translationOf: "2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier"
translatedBy: "claude"
translationDate: 2026-08-10
---

ソース生成された `System.Text.Json` のコントラクトをカスタマイズするには、モディファイアーを `JsonSerializerOptions` 側に置きます。コンテキスト側には決して置きません。つまり `new JsonSerializerOptions { TypeInfoResolver = MyContext.Default.WithAddedModifier(MyModifier) }` です。一見もっともらしい `new MyContext(optionsWithModifier)` はコンパイルも実行も通りますが、モディファイアーを黙って無視します。`JsonSerializerContext` のコンストラクターが `TypeInfoResolver` をコンテキスト自身で上書きするからです。モディファイアーはソース生成と問題なく併用でき、Native AOT 向けにリフレクションベースのシリアル化を無効にした状態でも動作しますが、生成される高速パスと引き換えになります。以下の内容はすべて SDK 10.0.201 の .NET 10.0.5 で検証しました。API は .NET 8 から .NET 11 まで変わっていません。

## コントラクトのカスタマイズとソース生成が両立しないように見える理由

コントラクトのカスタマイズは .NET 7 で導入されました。`System.Text.Json` に `Action<JsonTypeInfo>` を渡すと、コントラクトが構築された後、使用される前に型ごとに一度呼び出されます。そこでプロパティの名前を変えたり、削除したり、合成プロパティを追加したり、取得と設定のデリゲートをラップしたりできます。標準的な入口は `DefaultJsonTypeInfoResolver.Modifiers` で、.NET 8 では [`WithAddedModifier` 拡張メソッド](/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)が追加され、リフレクションベースのものに限らず任意の `IJsonTypeInfoResolver` にモディファイアーを重ねられるようになりました。

この「任意の resolver」という点が重要です。ソース生成された `JsonSerializerContext` は `IJsonTypeInfoResolver` **そのもの**だからです。モディファイアーが `MyContext.Default` を装飾できない技術的な理由はありません。コントラクトのモディファイアーはソース生成では使えないと多くの人が結論づけるのは、自然に見える配線がモディファイアーを警告も例外もコンパイラー診断もなしに捨ててしまうからです。

以降で使うモデルを示します。秘密情報を持つ `Order` と、同じ問題を抱えるネストされた `Address` です。

```csharp
// .NET 11, C# 14
public class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
    public string? ApiKey { get; set; }
    public Address? ShipTo { get; set; }
}

public class Address
{
    public string City { get; set; } = "";
    public string? ApiKey { get; set; }
}

[JsonSerializable(typeof(Order))]
public partial class OrderContext : JsonSerializerContext { }
```

そしてモディファイアーです。オブジェクトグラフのどこにあっても `ApiKey` という名前のプロパティをマスクします。

```csharp
// .NET 11, C# 14
static void RedactApiKey(JsonTypeInfo typeInfo)
{
    if (typeInfo.Kind != JsonTypeInfoKind.Object)
        return;

    foreach (JsonPropertyInfo property in typeInfo.Properties)
    {
        if (property.Name != "ApiKey")
            continue;

        Func<object, object?>? get = property.Get;
        if (get is not null)
            property.Get = obj => get(obj) is null ? null : "***";
    }
}
```

## 動作する配線と、黙って何もしない配線

手順は 3 つで、順序が重要です。

1. まず生成されたコンテキストの `Default` プロパティに対して `WithAddedModifier` を呼び、resolver を組み立てます。戻り値は `JsonTypeInfoResolverWithAddedModifiers` で、コンテキストに委譲してから callback を実行します。
2. その resolver を `JsonSerializerOptions.TypeInfoResolver` に代入し、options インスタンスを `static readonly` フィールドにキャッシュします。`JsonSerializerContext` を自分で生成してはいけません。
3. その options インスタンスを `JsonSerializer.Serialize` または `JsonSerializer.Deserialize` に渡します。コンテキストを渡してはいけませんし、`MyContext.Default` から取り出した `JsonTypeInfo` も渡してはいけません。

```csharp
// .NET 11, C# 14 - works
static readonly JsonSerializerOptions RedactingOptions = new()
{
    TypeInfoResolver = OrderContext.Default.WithAddedModifier(RedactApiKey)
};

var order = new Order
{
    Id = 7,
    Customer = "acme",
    ApiKey = "sk-live-123",
    ShipTo = new Address { City = "Cluj", ApiKey = "sk-nested-999" }
};

Console.WriteLine(JsonSerializer.Serialize(order, typeof(Order), RedactingOptions));
// {"Id":7,"Customer":"acme","ApiKey":"***","ShipTo":{"City":"Cluj","ApiKey":"***"}}
```

ネストされた `Address` も、`[JsonSerializable]` 属性に一度も登場していないのにマスクされている点に注目してください。ジェネレーターは宣言されたルートごとにオブジェクトグラフをたどるため、`OrderContext.Default.GetTypeInfo(typeof(Address))` はコントラクトを返し、モディファイアーは他の型と同じように実行されます。

次は同じくらい妥当に見えて、何もしないバージョンです。

```csharp
// .NET 11, C# 14 - modifier is silently discarded
var context = new OrderContext(new JsonSerializerOptions
{
    TypeInfoResolver = OrderContext.Default.WithAddedModifier(RedactApiKey)
});

Console.WriteLine(JsonSerializer.Serialize(order, typeof(Order), context));
// {"Id":7,"Customer":"acme","ApiKey":"sk-live-123","ShipTo":{...,"ApiKey":"sk-nested-999"}}

Console.WriteLine(context.Options.TypeInfoResolver?.GetType().Name);
// OrderContext
```

`JsonSerializerContext(JsonSerializerOptions)` コンストラクターは渡された options をコピーしたうえで、自分自身を `TypeInfoResolver` に代入します。そのため丁寧に組み立てた装飾済み resolver は、最初のシリアル化の前に消えています。[dotnet/runtime のディスカッション 121304](https://github.com/dotnet/runtime/discussions/121304) における `System.Text.Json` メンテナーの案内もまさにこれで、`JsonSerializerContext` のインスタンスは避け、options を直接 `JsonSerializer` に渡すよう勧めています。

モディファイアーを失う経路はあと 2 つあり、どちらもうっかり書きがちです。

```csharp
// .NET 11, C# 14 - both bypass the modifier
JsonSerializer.Serialize(order, OrderContext.Default.Order);
JsonSerializer.Serialize(order, typeof(Order), OrderContext.Default);
```

`OrderContext.Default` は変更されていないコントラクトです。これはバグではなく仕様上の利点です。モディファイアーは共有された `Default` インスタンスを変更しないので、アプリのある部分のマスク用 resolver が別の部分に漏れ出すことはありません。ホットパス向けに `JsonTypeInfo` のオーバーロードを使いたい場合は、変更済みの options から type info を取り出してください。

```csharp
// .NET 11, C# 14
var typeInfo = (JsonTypeInfo<Order>)RedactingOptions.GetTypeInfo(typeof(Order));
JsonSerializer.Serialize(order, typeInfo);   // redacted
```

## Name での一致判定は ASP.NET Core で刺さる落とし穴

`JsonPropertyInfo.Name` は `PropertyNamingPolicy` 適用後の **JSON** 上の名前です。既定の options を使う素のコンソールアプリでは命名ポリシーが null なので、`property.Name` はたまたま CLR のプロパティ名と一致し、`== "ApiKey"` の判定が通ります。同じモディファイアーを、既定のポリシーが camelCase である ASP.NET Core に組み込むと、判定は何にも一致しなくなります。

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.TypeInfoResolver = AppJsonContext.Default.WithAddedModifier(RedactApiKey);
});
```

`property.Name != "ApiKey"` のままだと、エンドポイントは平然と `{"id":7,"customer":"acme","apiKey":"sk-live-1"}` を返します。モディファイアー自体は実行されており、コントラクトがすでにプロパティを `apiKey` として報告していたため、一致しなかっただけです。

代わりに CLR のメンバーで判定します。`JsonPropertyInfo.AttributeProvider` はソース生成されたコントラクトでも `PropertyInfo` なので、メンバー名も任意のカスタム属性も参照できます。

```csharp
// .NET 11, C# 14
[AttributeUsage(AttributeTargets.Property)]
public sealed class RedactAttribute : Attribute { }

static void RedactByAttribute(JsonTypeInfo typeInfo)
{
    if (typeInfo.Kind != JsonTypeInfoKind.Object)
        return;

    foreach (JsonPropertyInfo property in typeInfo.Properties)
    {
        object[]? attributes = property.AttributeProvider
            ?.GetCustomAttributes(typeof(RedactAttribute), inherit: true);

        if (attributes is not { Length: > 0 })
            continue;

        Func<object, object?>? get = property.Get;
        if (get is not null)
            property.Get = obj => get(obj) is null ? null : "***";
    }
}
```

このバージョンはどの命名ポリシーでも耐えられ、私のテストでは同じ minimal API エンドポイントから `{"id":7,"customer":"acme","apiKey":"***"}` を返しました。

## ソース生成されたコントラクトで実際に変更できること

[カスタムコントラクトのドキュメント](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts)がリフレクション resolver 向けに説明している内容は、生成されたコントラクトの上でも同じように動きます。以下はいずれも `OrderContext.Default` に対して検証しました。

- **プロパティの削除。** `typeInfo.Properties.RemoveAt(i)` により、シリアル化からも逆シリアル化からも外れます。出力は `{"Id":7,"Customer":"acme","ShipTo":{"City":"Cluj"}}` になります。
- **合成プロパティの追加。** `typeInfo.CreateJsonPropertyInfo(typeof(string), "kind")` と `Get` デリゲートを用意し、`typeInfo.Properties.Add(...)` すると、ペイロードに `"kind":"order"` が追加されます。対応する CLR メンバーは存在しなくても構いません。
- **setter のラップ。** `property.Set` を再代入すると逆シリアル化時に実行されます。ラップした setter で `Customer` を大文字化すると、`{"Customer":"acme"}` が `Customer == "ACME"` になりました。
- **条件付きの書き込み。** `property.ShouldSerialize = (_, value) => !string.IsNullOrEmpty((string?)value)` により、空文字列の `Customer` だけが抑制され、コントラクトの他の部分はそのままでした。
- **型ごとの数値処理。** `typeInfo.NumberHandling` は `int` のような `JsonTypeInfoKind.None` のコントラクトに適用できる唯一のつまみです。

モディファイアーは追加した順に合成されます。`WithAddedModifier` を 2 回連結し、1 つ目ですべての名前を小文字にし、2 つ目でインデックス 0 に `"v"` プロパティを挿入したところ、`{"v":"2","id":7,"customer":"acme",...}` になりました。小文字化のパスが先に走ったため、後から挿入されたプロパティは大文字小文字がそのまま残っています。

## Native AOT: 壊れるのはモディファイアーではない

ここで[ソースジェネレーター](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)を使う理由はトリミングと Native AOT なので、モディファイアーを付けるとリフレクションが戻ってくるのではないかという懸念が当然生じます。戻ってきません。`PublishAot` と `PublishTrimmed` が自動で設定する `<JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>` を指定して、同じコードを再実行しました。

```text
IsReflectionEnabledByDefault = False
attribute-driven modifier over source-gen: {"Id":7,"Customer":"acme","ApiKey":"***","ShipTo":{"City":"Cluj","ApiKey":"***"}}
synthetic property with reflection off:    {"Id":7,...,"kind":"order"}
```

`AttributeProvider` 経由の属性参照も、実行時に作成したプロパティも動作しました。この構成でなお壊れるのはソース生成の通常の規則のほうです。コンテキストに登録されていないルート型は例外になり、モディファイアーは無関係です。

```text
NotSupportedException: JsonTypeInfo metadata for type '<>f__AnonymousType0`1[System.Int32]'
was not provided by TypeInfoResolver of type
'System.Text.Json.Serialization.Metadata.JsonTypeInfoResolverWithAddedModifiers'.
```

[リフレクションベースのシリアル化が無効化されている](/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/)という兄弟エラーに遭遇した場合も、原因は resolver の欠落であって、モディファイアーの不具合ではありません。

## 実際のコスト: 生成された高速パスを手放すこと

ソース生成には 2 つのモードがあります。メタデータモードはコントラクトの構築をコンパイル時に移します。シリアル化最適化モードはさらに、`Utf8JsonWriter` を直接呼ぶ手書き相当の writer を出力します。[ソース生成モードのドキュメント](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation-modes)によれば、生成された writer では表現できないことを options が要求するたびにシリアライザーは高速パスから外れます。変更されたコントラクトはまさにその要求にあたります。

BenchmarkDotNet 0.15.8、.NET 10.0.5（Intel Core Ultra 7 265KF、20 コア）で、上記の 4 プロパティの `Order` をシリアル化した結果です。

| メソッド | 平均 | Ratio | 割り当て | Alloc Ratio |
| --- | ---: | ---: | ---: | ---: |
| Source-gen、モディファイアーなし | 88.76 ns | 1.00 | 200 B | 1.00 |
| Source-gen + モディファイアー | 136.83 ns | 1.54 | 496 B | 2.48 |
| リフレクション resolver、モディファイアーなし | 136.23 ns | 1.53 | 512 B | 2.56 |
| リフレクション resolver + モディファイアー | 138.97 ns | 1.57 | 496 B | 2.48 |

このペイロードではモディファイアーの追加によりスループットが約 54% 落ち、割り当ては 2.5 倍になり、ソース生成はリフレクション resolver とちょうど同じ位置に着地します。コントラクトの構築は依然コンパイル時に行われるため、起動時間とトリミングの利点は保たれ、失われるのは最適化された writer だけです。多くの API にとっては妥当な取引ですが、ホットなシリアル化パスにモディファイアーを付けてから数値が動かない理由に悩む前に知っておく価値があります。

## GenerationMode = Serialization はモディファイアーを静かな no-op にする

これは「モディファイアーはソース生成では動かない」に最も近く見える失敗パターンです。コンテキストを高速パスのみの生成に固定すると、モディファイアーがたどるプロパティのメタデータが存在しません。

```csharp
// .NET 11, C# 14 - do not do this if you want a modifier
[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Serialization)]
[JsonSerializable(typeof(Order))]
public partial class FastPathOnlyContext : JsonSerializerContext { }
```

3 つの生成モードそれぞれについてコントラクトの形を出力しました。

```text
Default mode         Kind=Object Properties=4
Serialization only   Kind=Object Properties=0
Metadata only        Kind=Object Properties=4
```

`Properties=0` では、モディファイアーは一度呼ばれ、何も反復せずに戻ります。シリアル化はマスクされない元のペイロードのまま成功します。逆シリアル化は失敗し、メッセージは少なくとも明示的です。

```text
InvalidOperationException: TypeInfoResolver
'System.Text.Json.Serialization.Metadata.JsonTypeInfoResolverWithAddedModifiers'
did not provide property metadata for type 'Order'.
```

既定の生成モードはメタデータと高速パスの両方を出力します。これが望ましい状態で、モディファイアーが付いていないときは高速パスが使われ、付いているときはメタデータのパスが引き継ぎます。

## options はキャッシュし、初回使用後は変更しない

コントラクトはグローバルではなく `JsonSerializerOptions` のインスタンスごとにキャッシュされます。キャッシュした 1 つの options オブジェクトで 3 回シリアル化したところ、モディファイアーの呼び出しは合計 4 回で、グラフ内の型ごとに 1 回でした。ループの中で毎回新しい `JsonSerializerOptions` を作ると、呼び出しは 12 回になり、すべてのコントラクトが作り直されました。

```text
modifierCalls after 3 serializations (cached options)  = 4
modifierCalls after 3 serializations (fresh options)   = 12
```

options インスタンスが一度使われると、そのインスタンスも、そこから生成されたコントラクトも凍結されます。最初のシリアル化の後に `WriteIndented` を代入すると `InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization` が発生し、`options.GetTypeInfo(...)` に踏み込んで後から `Properties` を編集しようとすると `JsonTypeInfo` 版の同等の例外が発生します。コントラクトの変更はすべてモディファイアーの内側で行う必要があります。

装飾された 1 つのコンテキストではなく複数の resolver を重ねたい場合、[`TypeInfoResolverChain`](/2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions/) は素の resolver と同じように装飾済み resolver も受け付け、チェーンは null 以外のコントラクトが返るまで順に問い合わせられます。同じパターンは、すでに[`JsonDerivedType` による多態性](/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)を使っている階層にも適用できます。派生側のコントラクトも他の型と同様にモディファイアーを通るからです。

覚えておくべき要点は次のとおりです。装飾するのはコンテキストではなく resolver、判定は `Name` ではなく `AttributeProvider`、生成モードは既定のまま、そして options はキャッシュすること。

## 参照元

- MS Learn の[シリアル化と逆シリアル化のカスタムコントラクト](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts)
- MS Learn の [System.Text.Json のソース生成モード](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation-modes)
- [dotnet/runtime ディスカッション 121304: JSON コントラクトのモディファイアーとソース生成](https://github.com/dotnet/runtime/discussions/121304)
- [`JsonTypeInfoResolver.WithAddedModifier` の API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsontypeinforesolver.withaddedmodifier)（.NET 8 から .NET 11 で利用可能）
