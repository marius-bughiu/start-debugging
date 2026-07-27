---
title: "System.Text.Json で JsonDerivedType を使ってポリモーフィックな型階層をシリアライズする方法"
description: ".NET 11 におけるポリモーフィック JSON の完全ガイドです。JsonDerivedType と JsonPolymorphic、宣言された型がすべてを決める理由、$type の順序ルール、この機能がスローするすべての例外、自分で所有していない型のためのコントラクトモデル、そして ASP.NET Core が OpenAPI に出力する内容を扱います。"
pubDate: 2026-07-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "serialization"
lang: "ja"
translationOf: "2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json"
translatedBy: "claude"
translationDate: 2026-07-27
---

クラス階層を `System.Text.Json` でラウンドトリップさせるには、サポートしたいサブタイプごとに `[JsonDerivedType(typeof(Derived), "discriminator")]` を基底型へ付け、**基底**型を通してシリアライズとデシリアライズを行います。シリアライザーはオブジェクトの最初のメンバーとして `$type` プロパティを書き込み、読み戻すときにそれを見て正しいサブタイプを選びます。判別子の文字列がない場合、シリアライズは派生プロパティを出力しますが、デシリアライズは常に基底型を生成します。この動作は .NET 7 以降変わっておらず、以下の内容はすべて .NET 11 (`net11.0`、C# 14) を対象としています。後から追加された 2 つの機能、`AllowOutOfOrderMetadataProperties` (.NET 9) と `JsonSerializerOptions.Strict` (.NET 10) については、関係する箇所で明示します。

## 素朴な書き方が黙ってデータを失う理由

この機能が探される理由は、いちばん自然に見えるコードが黙って誤った動作をするからです。決済の階層を例にします。

```csharp
// .NET 11, C# 14
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}

public class CardPayment : PaymentMethod
{
    public string Last4 { get; set; } = "";
}
```

属性を一切付けずに `PaymentMethod` として宣言した変数経由で `CardPayment` をシリアライズすると、結果は `{"Amount":10}` になります。`Last4` プロパティは消えます。`System.Text.Json` はランタイムの型ではなく**宣言された**型からコントラクトを解決するため、`PaymentMethod` のメンバーしか知りません。これは意図的な設計です。呼び出し側が公開に同意していないプロパティを派生型が漏らすことを防ぐためであり、API のレスポンスでは現実的なセキュリティ上の考慮事項です。

属性を 1 つ追加するとコントラクトが変わります。

```csharp
// .NET 11, C# 14
[JsonDerivedType(typeof(CardPayment))]
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}
```

これで `JsonSerializer.Serialize<PaymentMethod>(card)` は `{"Last4":"4242","Amount":10}` を生成します。シリアライズは直りましたが、デシリアライズは直っていません。そのペイロードを `PaymentMethod` として読み戻すと `NotSupportedException: Deserialization of interface or abstract types is not supported. Type 'PaymentMethod'.` がスローされます。どのサブタイプを構築すべきかを示すものが JSON に何もないからです。基底型が抽象ではなく具象の場合、失敗はより静かで、より厄介です。`PaymentMethod` のインスタンスが返り、`Last4` は捨てられます。この輪を閉じるのが判別子です。

## ラウンドトリップ可能な階層を作る 5 ステップ

1. **基底型をポリモーフィズム対応にします。** sealed でないクラス、抽象クラス、またはインターフェースである必要があります。構造体、sealed 型、ジェネリック型、`System.Object` は `InvalidOperationException: Specified type 'X' does not support polymorphism. Polymorphic types cannot be structs, sealed types, generic types or System.Object.` で拒否されます。

2. **各サブタイプを判別子付きで宣言します。** `[JsonDerivedType]` の 2 番目の引数が判別子の値であり、これがデシリアライズを成立させます。

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

[JsonDerivedType(typeof(CardPayment), "card")]
[JsonDerivedType(typeof(PaypalPayment), "paypal")]
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}

public class CardPayment : PaymentMethod
{
    public string Last4 { get; set; } = "";
}

public class PaypalPayment : PaymentMethod
{
    public string Email { get; set; } = "";
}
```

3. **基底型を通してシリアライズします。** 呼び出し箇所の宣言された型がポリモーフィックな基底である必要があります。ジェネリック引数、プロパティの型、コレクションの要素型のいずれでもかまいません。

```csharp
// .NET 11, C# 14
PaymentMethod payment = new CardPayment { Amount = 10, Last4 = "4242" };

string json = JsonSerializer.Serialize(payment);
// {"$type":"card","Last4":"4242","Amount":10}
```

順序に注目してください。`$type` は常に最初に書かれ、派生型自身のプロパティがその後に続き、基底型のプロパティが最後に来ます。これは見た目の問題ではありません。次のセクションで説明します。

4. **基底型を通してデシリアライズします。** リーダーは `$type` を見て `CardPayment` を見つけ、それを構築します。

```csharp
// .NET 11, C# 14
PaymentMethod? back = JsonSerializer.Deserialize<PaymentMethod>(json);
Console.WriteLine(back is CardPayment); // True
```

5. **`$type` が転送フォーマットと衝突する場合は判別子の名前を変えます。** 基底型に `[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]` を付けるとプロパティ名が変わります。知っておくべき点が 2 つあります。`$id`、`$ref`、`$values` は予約されており拒否されること、そしてカスタム名は命名ポリシーを**通りません**。`JsonSerializerOptions.Web` では、`"Kind"` と宣言した判別子は `"Kind"` のまま残り、他のプロパティだけが camelCase になります。転送時に使いたい大文字小文字をそのまま指定してください。

判別子の値は整数でもかまいません。`[JsonDerivedType(typeof(ClickEvent), 1)]` は `{"$type":1,...}` を出力します。1 つの階層で `string` と `int` の ID を混在させてもコンパイルも実行もできますが、.NET 以外のクライアントからペイロードを扱いにくくなります。どちらか一方に統一してください。

## 宣言された型がどこでも決定権を持つ

「判別子が出力されない」という報告のほとんどは、宣言された型が派生クラスになっている呼び出し箇所に行き着きます。ルールは機械的なので、表として頭に入れておく価値があります。以下はすべて上と同じ階層で実行した結果です。

| 呼び出し箇所 | 出力 |
| --- | --- |
| `Serialize<PaymentMethod>(card)` | `{"$type":"card","Last4":"4242","Amount":10}` |
| `Serialize<CardPayment>(card)` | `{"Last4":"4242","Amount":10}` |
| `card` が `CardPayment` 型のときの `Serialize(card)` | `{"Last4":"4242","Amount":10}` |
| `Serialize<object>(card)` | `{"$type":"card","Last4":"4242","Amount":10}` |
| `List<PaymentMethod>` の要素 | `[{"$type":"card",...}]` |
| `PaymentMethod` として宣言されたプロパティ | `{"Method":{"$type":"card",...}}` |
| `CardPayment` として宣言されたプロパティ | `{"Concrete":{"Last4":"9","Amount":3}}` |

`object` の行は意外に思われます。`System.Object` 自体はポリモーフィックな基底になれませんが、宣言された型が `object` の場合、シリアライザーはランタイムの型を解決し、その型にとって最も近い設定済みの祖先のポリモーフィック構成を適用します。したがって `Serialize<object>(card)` は判別子を出力しますし、`Serialize<object>(someUndeclaredSubtype)` は基底型で呼んだときとまったく同じようにスローします。`object` へのデシリアライズは対称ではありません。返るのは `CardPayment` ではなく `JsonElement` です。

ASP.NET Core では宣言された型がエンドポイントの戻り値の型なので、同じ表がそのまま minimal API に当てはまります。

```csharp
// .NET 11, C# 14
app.MapGet("/payments/latest", () => (PaymentMethod)card);      // {"$type":"card","last4":"4242","amount":10}
app.MapGet("/payments/card",   () => card);                     // {"last4":"4242","amount":10}
app.MapGet("/typed",  () => TypedResults.Ok((PaymentMethod)card)); // discriminator present
app.MapGet("/typed2", () => TypedResults.Ok(card));             // discriminator absent
```

`TypedResults.Ok(card)` は `Ok<CardPayment>` と推論され、そのジェネリック引数が `WriteAsJsonAsync` に届くまで宣言された型として使われます。エンドポイントが階層を返す必要があるなら、ラムダの戻り値を基底型として型付けするか、明示的な `Results<T1, T2>` のユニオンを使い、シリアライザーと OpenAPI ジェネレーターの両方から形が見えるようにしてください。クライアントが分岐する必要があるものについては、基底型を返すことを [typed results のユニオンのガイド](/ja/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/)も推奨しています。

## `$type` プロパティは先頭に来る必要があります

既定では、判別子は JSON オブジェクトの先頭になければならず、他のメタデータプロパティである `$id` や `$ref` とまとめて置かれます。次のペイロードはデシリアライズできます。

```json
{"$type":"card","Amount":10,"Last4":"4242"}
```

次のペイロードは `NotSupportedException: The JSON payload for polymorphic interface or abstract type 'PaymentMethod' must specify a type discriminator.` をスローします。

```json
{"Amount":10,"$type":"card","Last4":"4242"}
```

理由はストリーミングです。前方への 1 パスで読むということは、メンバーのバインドを始める前にリーダーが対象の型を知っている必要がある、ということです。この例外メッセージはざっと読むと誤解を招きます。判別子はペイロードに*存在している*からです。ただ遅すぎるだけです。

.NET 9 以降はオプトインが用意されています。

```csharp
// .NET 11, C# 14, requires .NET 9 or later
var options = new JsonSerializerOptions { AllowOutOfOrderMetadataProperties = true };
var back = JsonSerializer.Deserialize<PaymentMethod>(json, options); // works
```

コストは実在するので、何も考えずにグローバルで有効化しないでください。このフラグを立てると、デシリアライザーはプロパティを 1 パスで処理できなくなり、バインド前に JSON オブジェクト全体をメモリにバッファリングします。200 バイトのイベントなら無視できます。blob storage からストリーミングする数メガバイトの文書では、メモリ不足のリスクになります。ペイロードが自分の管理下のシステムから来るなら、書き込み側を直してください。順序が崩れた判別子のよくある発生源はデータベース往復です。PostgreSQL の `jsonb` 列はキーの順序を正規化するため、正しく書いた文書が `$type` を途中に持って返ってくることがあります。

## この機能がスローするすべての例外

以下はランタイムの正確なメッセージです。検索しやすく、トリアージが速くなります。

| メッセージ | 原因 | 対処 |
| --- | --- | --- |
| `Specified type 'X' does not support polymorphism. Polymorphic types cannot be structs, sealed types, generic types or System.Object.` | 構造体、sealed クラス、オープンジェネリックに `[JsonDerivedType]` を付けた | 基底の sealed を外すか、非ジェネリックな基底またはインターフェースを導入します |
| `Runtime type 'X' is not supported by polymorphic type 'Y'.` | 宣言していないサブタイプをシリアライズした | `[JsonDerivedType(typeof(X), "...")]` を追加するか、`UnknownDerivedTypeHandling` を設定します |
| `The JSON payload for polymorphic interface or abstract type 'X' must specify a type discriminator.` | 判別子がない、または先頭のプロパティでない | `$type` を先頭に出力するか、`AllowOutOfOrderMetadataProperties` を設定します |
| `Read unrecognized type discriminator id 'x'.` | ペイロードが宣言していないサブタイプを指している | 宣言するか、`IgnoreUnrecognizedTypeDiscriminators = true` を設定します |
| `The polymorphic type 'X' has already specified a type discriminator 'y'.` | 2 つの `[JsonDerivedType]` 属性が同じ ID を共有している | 判別子の ID を階層内で一意にします |
| `The type 'X' contains property '$type' that conflicts with an existing metadata property name.` | 実プロパティが判別子と同じ名前でシリアライズされる | プロパティ名を変える、`[JsonIgnore]` を付ける、または判別子の名前を変えます |
| `Runtime type 'X' has a diamond ambiguity between derived types 'A' and 'B'.` | 同じ距離の祖先が 2 つある状態での `FallBackToNearestAncestor` | フォールバックが不要になるよう `X` を明示的に宣言します |
| `Deserialization of interface or abstract types is not supported. Type 'X'.` | 判別子をまったく宣言していない抽象基底 | すべての `[JsonDerivedType]` に判別子 ID を与えます |

判別子が認識できないケースは `JsonException` をスローし、それ以外は `NotSupportedException` または `InvalidOperationException` をスローします。この区別は、シリアライズ失敗を捕捉して 400 を返す場合に効いてきます。`JsonException` は「不正な入力」の箱であり、ここでの `NotSupportedException` はほぼ常に自分側の設定ミスを意味します。

## 宣言していないサブタイプの扱い

既定では、宣言していないサブタイプは書き込み時のハードエラーです。これは正しい既定値です。基底のコントラクトへ黙って劣化することこそ、本番のペイロードからプロパティが消える経路だからです。より穏やかな失敗モードが欲しい場合は、`[JsonPolymorphic]` がスイッチを公開しています。

```csharp
// .NET 11, C# 14
[JsonPolymorphic(
    UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType,
    IgnoreUnrecognizedTypeDiscriminators = true)]
[JsonDerivedType(typeof(LeafNode), "leaf")]
public class Node
{
    public string Label { get; set; } = "";
}

public class DeepNode : Node { public int Depth { get; set; } }
```

この構成では、`DeepNode` を `Node` としてシリアライズするとスローせずに `{"Label":"x"}` を書き、`{"$type":"unknown","Label":"x"}` を読むと素の `Node` が得られます。どちらの設定も、基底型が具象で構築可能な場合にのみ意味を持ちます。抽象基底に `IgnoreUnrecognizedTypeDiscriminators` を付けても、インスタンス化できるものがない以上、失敗が 1 段先に移るだけです。

3 つ目の選択肢である `JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor` は、最も近い宣言済みの祖先まで遡ります。他チームが実装を追加していくインターフェース階層で有用ですが、ダイヤモンドのあいまいさエラーを起こしうる唯一の設定でもあります。ある型がルートの派生型として宣言された 2 つのインターフェースを実装している場合、シリアライザーは推測を拒否します。

## 構成は階層の下へ継承されません

これは半日を溶かす類の落とし穴です。基底型のポリモーフィック構成は、中間の型を貫通しません。

```csharp
// .NET 11, C# 14
[JsonDerivedType(typeof(Middle), "middle")]
public abstract class Root { }

[JsonDerivedType(typeof(Leaf), "leaf")]
public class Middle : Root { }

public class Leaf : Middle { }

JsonSerializer.Serialize<Root>(new Leaf());
// NotSupportedException: Runtime type 'Leaf' is not supported by polymorphic type 'Root'.
```

`Middle` は `Leaf` を知っていますが `Root` は知らず、シリアライザーは 2 つの構成を合成しません。ポリモーフィックな基底はすべて、その下に現れうる具象型を孫まで含めて列挙する必要があります。`Root` と `Middle` の両方で `Leaf` を宣言すれば動作し、ID は呼び出し箇所が宣言した基底型に対して解決されるため、各レベルで別々の判別子 ID を使えます。

## 基底型に属性を付けられない場合

NuGet パッケージの型、生成されたクライアント、触ることを許されていない共有コントラクトアセンブリでは、属性は手が届きません。これはコントラクトモデルで解決します。`DefaultJsonTypeInfoResolver` を派生させ、基底型の `JsonTypeInfo` に `PolymorphismOptions` を設定します。

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization.Metadata;

public class PaymentResolver : DefaultJsonTypeInfoResolver
{
    public override JsonTypeInfo GetTypeInfo(Type type, JsonSerializerOptions options)
    {
        JsonTypeInfo info = base.GetTypeInfo(type, options);

        if (info.Type == typeof(PaymentMethod))
        {
            info.PolymorphismOptions = new JsonPolymorphismOptions
            {
                TypeDiscriminatorPropertyName = "kind",
                IgnoreUnrecognizedTypeDiscriminators = true,
                UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FailSerialization,
                DerivedTypes =
                {
                    new JsonDerivedType(typeof(CardPayment), "card"),
                    new JsonDerivedType(typeof(PaypalPayment), "paypal")
                }
            };
        }

        return info;
    }
}

var options = new JsonSerializerOptions { TypeInfoResolver = new PaymentResolver() };
```

リゾルバーは型ごとに 1 回だけ実行され、結果は options インスタンスにキャッシュされるため、リフレクションのコストは呼び出しごとではなく起動時に支払われます。判別子をエンドポイントやテナントごとに変える必要がある場合の逃げ道にもなります。1 つの options を変更しようとせず、2 つのリゾルバーで 2 つの options インスタンスを作ってください。options は最初のシリアライズ呼び出しの後に読み取り専用になります。これは[カスタム JsonConverter のガイド](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)で説明されている制約と同じです。

## ソースジェネレーターと Native AOT

ポリモーフィズムはソースジェネレーターでも動作しますが、metadata モードに限られます。高速パス (`JsonSourceGenerationMode.Serialization`) は既知の形に対して固定の `Utf8JsonWriter` 呼び出しを出力し、ランタイムの型で分岐する場所がないため、`InvalidOperationException: TypeInfoResolver 'MyContext' did not provide property metadata for type 'CardPayment'.` で失敗します。

```csharp
// .NET 11, C# 14
[JsonSerializable(typeof(PaymentMethod))]
[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Metadata)]
public partial class PaymentContext : JsonSerializerContext { }

string json = JsonSerializer.Serialize(payment, PaymentContext.Default.PaymentMethod);
// {"$type":"card","Last4":"4242","Amount":10}
```

基底型を登録するだけで十分です。ジェネレーターは `[JsonDerivedType]` をたどり、宣言された各サブタイプのメタデータを出力します。これがこのパターンをトリミング安全かつ AOT 安全にしており、[Native AOT と minimal API](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) での発行に耐える数少ないリフレクション的な機能である理由です。耐えられないのは、モックライブラリが作る型や動的に生成される型のように、実行時にしか存在しないサブタイプです。

## ASP.NET Core が OpenAPI ドキュメントに出力する内容

組み込みの `Microsoft.AspNetCore.OpenApi` ジェネレーターは同じ属性を読むため、ポリモーフィックなレスポンス型は自分自身を文書化します。上の決済階層に対して生成されるスキーマは次のとおりです。

```json
{
  "PaymentMethod": {
    "required": [ "$type" ],
    "type": "object",
    "anyOf": [
      { "$ref": "#/components/schemas/PaymentMethodCardPayment" },
      { "$ref": "#/components/schemas/PaymentMethodPaypalPayment" }
    ],
    "discriminator": {
      "propertyName": "$type",
      "mapping": {
        "card": "#/components/schemas/PaymentMethodCardPayment",
        "paypal": "#/components/schemas/PaymentMethodPaypalPayment"
      }
    }
  }
}
```

各派生スキーマには単一値の列挙として型付けされた `$type` プロパティが付き、これによりクライアントジェネレーターはタグ付きユニオンを生成できます。ドキュメントにある注意点を繰り返す価値があります。`discriminator` キーワードが現れるのは基底型が**抽象**の場合だけです。具象の基底は OpenAPI の意味で `$type` を必須にできません。基底自身のインスタンスには判別子がないためで、その場合ジェネレーターは discriminator オブジェクトを省きます。ドキュメントが成果物なら、基底を抽象にしてください。この内容を作り変える必要がある場合は、スキーマトランスフォーマーで行います。[OpenAPI トランスフォーマーのガイド](/ja/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)で扱っています。

## 細かいながら刺さる点

- **record も動作します。位置指定の record も含みます。** 抽象 record に `[JsonDerivedType(typeof(TextMessage), "text")]` を付ければ、余計な儀式なしで `TextMessage(string Body)` をラウンドトリップできます。判別子はコンストラクター引数がバインドされる前に読まれるからです。
- **閉じたジェネリックのサブタイプは有効です。** 基底はジェネリックにできませんが、`[JsonDerivedType(typeof(Envelope<int>), "int-envelope")]` は問題ありません。閉じた具体化ごとに専用の属性と専用の ID が必要です。
- **カスタムコンバーターとポリモーフィズムは併用できません。** 判別子は、オブジェクト、コレクション、ディクショナリの既定コンバーターでのみサポートされます。基底型に付けた `JsonConverter<T>` は仕組み全体を置き換えるため、判別子を自分で書く必要があります。
- **`JsonSerializerOptions.Strict` (.NET 10) は互換です。** `$type` プロパティはマップされないメンバーではなくメタデータとして扱われるため、`UnmappedMemberHandling.Disallow` でも拒否されません。未知の*データ*プロパティは従来どおりスローします。それがこのプリセットの目的です。
- **Newtonsoft.Json の `TypeNameHandling` に相当するものは、設計上ありません。** CLR の型名をペイロードに埋め込むのは、よく知られたデシリアライズガジェットの経路です。`[JsonDerivedType]` は明示的な許可リストを要求します。だからこそ `TypeNameHandling.All` からの移行は[大規模コードベースを System.Text.Json へ移す](/ja/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)際にもっとも鋭い角になります。
- **判別子の誤りは、呼び出し側には変換の失敗として現れます。** 外側からデバッグしている場合、症状は一般的な [JSON value could not be converted](/ja/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) のエラー群と重なります。

全体を整理するメンタルモデルはこうです。宣言された型がコントラクトを選び、コントラクトが派生型の許可リストを持ち、判別子はそれが説明するデータより先に到着しなければならないメタデータである。上に挙げた失敗モードはすべて、この 3 つの文のいずれかに違反しているだけです。

## 関連記事

- [System.Text.Json でカスタム JsonConverter を書く方法](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Fix: System.Text.Json.JsonException: The JSON value could not be converted](/ja/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/)
- [大規模コードベースで Newtonsoft.Json から System.Text.Json へ移行する](/ja/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)
- [ASP.NET Core の minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [C# の record と class と struct: 判断のための比較表](/ja/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)

## 参考資料

- [How to serialize properties of derived classes, MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/polymorphism)
- [`JsonDerivedTypeAttribute` リファレンス](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonderivedtypeattribute)
- [`JsonPolymorphicAttribute` リファレンス](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonpolymorphicattribute)
- [`JsonSerializerOptions.AllowOutOfOrderMetadataProperties`, .NET 9+](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.allowoutofordermetadataproperties)
- [コントラクトモデルで JSON コントラクトをカスタマイズする](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts)
- [ASP.NET Core アプリに OpenAPI メタデータを含める](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/include-metadata)
- [`System.Text.Json` のリソース文字列, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/Resources/Strings.resx)
