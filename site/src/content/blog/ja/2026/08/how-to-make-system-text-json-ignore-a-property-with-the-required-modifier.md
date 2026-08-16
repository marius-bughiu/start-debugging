---
title: "System.Text.Json で required 修飾子付きのプロパティを無視させる方法"
description: "required なメンバーに [JsonIgnore] を付けると InvalidOperationException: marked required but does not specify a setter が発生します。2 つの機能が衝突する理由と、それでもプロパティを無視させる 4 つの方法を .NET 10 で計測しました。"
pubDate: 2026-08-16
tags:
  - "system-text-json"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "serialization"
  - "json"
lang: "ja"
translationOf: "2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier"
translatedBy: "claude"
translationDate: 2026-08-16
---

短い答えです。C# の `required` 修飾子が付いたメンバーに `[JsonIgnore]` を付けることはできません。System.Text.Json がその型のコントラクトを構築した瞬間に `InvalidOperationException: JsonPropertyInfo 'InternalId' defined in type 'Ignored' is marked required but does not specify a setter` がスローされます。しかもシリアル化でもデシリアル化でも同じです。動作する代替手段は 4 つあり、どれを選ぶかは「無視する」が *JSON に書き出すのをやめる* という意味なのか、*JSON から要求するのをやめる* という意味なのかで決まります。その型が自分のものなら、コンストラクターに `[SetsRequiredMembers]` を付けて `[JsonIgnore]` はそのまま残します。自分のものでないなら、`DefaultJsonTypeInfoResolver` の modifier で `JsonPropertyInfo.IsRequired` をクリアします。

以下の内容はすべて .NET 10.0.201 SDK、ランタイム 10.0.5、C# 14 で計測しました。System.Text.Json は .NET 7 以降 `required` 修飾子を尊重しており、ここで使うコントラクトモデルの API も .NET 7 以降安定しています。したがって、節で断らない限り、この挙動は .NET 7 以降に当てはまります。唯一の例外は .NET 9 で追加された `RespectRequiredConstructorParameters` です。

## required と JsonIgnore が共存できない理由

この 2 つの機能は直交しているように見えます。`required` は C# 11 の言語機能で、呼び出し側にオブジェクト初期化子でのメンバー代入を強制します。`[JsonIgnore]` はシリアライザーへの指示です。両者が衝突するのは、System.Text.Json が `required` 修飾子を読み取ってシリアル化メタデータに変換するからです。

[必須プロパティのドキュメント](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties)によれば、C# の `required` 修飾子と `[JsonRequired]` は「等価であり、どちらも同じメタデータ」、つまり `JsonPropertyInfo.IsRequired` にマップされます。つまり `required` はコンパイラーのコントラクトであるだけでなく、デシリアル化のコントラクトでもあります。そのプロパティはペイロードに現れなければなりません。

`[JsonIgnore]` の動きは違います。プロパティをコントラクトから取り除くわけではありません。`JsonPropertyInfo` は残したまま、そのアクセサーだけを剥がします。resolver に modifier をぶら下げてコントラクトを出力すると、その様子が見えます。

```csharp
// .NET 10.0.5, C# 14
var probe = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                if (typeInfo.Type != typeof(Ignored)) return;
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                    Console.WriteLine($"{p.Name}: IsRequired={p.IsRequired} hasSet={p.Set is not null} hasGet={p.Get is not null}");
            }
        }
    }
};

JsonSerializer.Deserialize<Ignored>("""{"Name":"a"}""", probe);

public class Ignored
{
    public required string Name { get; set; }
    [JsonIgnore] public required string InternalId { get; set; }
}
```

modifier は検証より先に実行されるので、例外より前に出力されます。

```text
Name: IsRequired=True hasSet=True hasGet=True
InternalId: IsRequired=True hasSet=False hasGet=False
InvalidOperationException: JsonPropertyInfo 'InternalId' defined in type 'Ignored' is marked required but does not specify a setter.
```

これで分かります。`InternalId` はコントラクトに残っていて `IsRequired=True` のままですが、`[JsonIgnore]` が両方のアクセサーを null にしました。シリアライザーは、ペイロードから埋めなければならないのに埋める手段がないプロパティを抱え込んでいます。そのためコントラクトの構築自体を拒否します。ソースコードには明らかにセッターがあるのに、例外メッセージがセッターの不在を訴えるのはこのためです。

これがデシリアル化ではなく *コントラクト検証* の失敗であることから、2 つの帰結が生まれます。

- シリアル化でもスローします。`JsonSerializer.Serialize(new Ignored { Name = "a", InternalId = "x" })` は同じ `InvalidOperationException` で失敗します。JSON の書き出しにセッターは一切必要ないのにです。
- コンパイル時ではなく実行時の失敗です。何も警告してくれません。コードはそのまま出荷され、その型に初めて触れたときにスローします。

`required` キーワードの代わりに `[JsonRequired]` を使った場合も、`IncludeFields` を有効にしたうえで `required` フィールドを使った場合も同じです。重要なのは `IsRequired` フラグであって、それをどう設定したかではありません。

## 最小限の再現コード

```csharp
// .NET 10.0.5, C# 14
using System.Text.Json;
using System.Text.Json.Serialization;

var order = new Order { Id = 7, InternalAuditToken = "tok_abc" };

// Throws InvalidOperationException, not a JsonException.
string json = JsonSerializer.Serialize(order);

public class Order
{
    public required int Id { get; set; }

    [JsonIgnore]
    public required string InternalAuditToken { get; set; }
}
```

意図は明白で、しかも妥当です。`InternalAuditToken` は必ず自分のコードで設定されなければならず (そのための `required` です)、決してネットワークに出てはいけません (そのための `[JsonIgnore]` です)。System.Text.Json には、属性だけでこの両方を同時に表現する手段がないというだけの話です。

## コンストラクターに SetsRequiredMembers を付ける

型が自分のものであれば、これが第一の選択肢です。`System.Diagnostics.CodeAnalysis.SetsRequiredMembersAttribute` は、そのコンストラクターがすべての必須メンバーを代入することをコンパイラーに伝えるので、呼び出し側は代入しなくてよくなります。System.Text.Json もこの属性を理解しており、付いている場合はメンバーを必須として扱うのをやめます。

```csharp
// .NET 10.0.5, C# 14
using System.Diagnostics.CodeAnalysis;

public class Order
{
    [SetsRequiredMembers]
    public Order()
    {
        Id = 0;
        InternalAuditToken = TokenFactory.NewToken();
    }

    public required int Id { get; set; }

    [JsonIgnore]
    public required string InternalAuditToken { get; set; }
}
```

これで双方向とも動きます。`JsonSerializer.Deserialize<Order>("""{"Id":7}""")` はコンストラクターが生成した値を `InternalAuditToken` に持つインスタンスを返し、シリアル化はトークンをまったく含まない `{"Id":7}` を出力します。

この仕組みは理解しておく価値があります。影響範囲が分かるからです。属性の有無でコントラクトを出力すると、何が変わるかが見えます。

```text
[without SetsRequiredMembers]
  Name: IsRequired=True  set=True
  InternalId: IsRequired=True  set=True

[with SetsRequiredMembers]
  Name: IsRequired=False set=True
  InternalId: IsRequired=False set=True
```

`[SetsRequiredMembers]` は、無視したメンバーだけでなく、その型の **すべての** メンバーについて `IsRequired` をクリアします。`Id` を省いたペイロードを拒否するために `required` を当てにしていたなら、その検査は、直そうとしていたエラーもろとも消えています。まだ強制したいメンバーには `[JsonRequired]` を付け直してください。

```csharp
// .NET 10.0.5, C# 14
public class Order
{
    [SetsRequiredMembers]
    public Order() { Id = 0; InternalAuditToken = TokenFactory.NewToken(); }

    [JsonRequired]                       // keeps the payload requirement
    public required int Id { get; set; }

    [JsonIgnore]                         // no longer required by the serializer
    public required string InternalAuditToken { get; set; }
}
```

この組み合わせで、元の意図がそのまま得られます。C# コンパイラーは引き続き自分のコードに両方のメンバーの設定を強制し、JSON コントラクトは引き続き `Id` のないペイロードを拒否し、トークンは JSON に一度も現れません。

## resolver の modifier で IsRequired をクリアする

型が自分の管理下にないパッケージから来ている場合や、多くの型にまとめてルールを適用したい場合は、型ではなくコントラクトを編集します。`DefaultJsonTypeInfoResolver` の modifier は既定のコントラクトが構築された後、検証される前に実行されるので、間に合ううちに `IsRequired` をオフにできます。

Microsoft Learn のサンプルそのままの大雑把な方法は、制約をあらゆる場所から取り除きます。

```csharp
// .NET 10.0.5, C# 14
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                if (typeInfo.Kind != JsonTypeInfoKind.Object) return;
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                    p.IsRequired = false;
            }
        }
    }
};
```

たいていの場合これは広すぎます。的を絞った版は自前のマーカー属性を手掛かりにするので、ポリシーが説明対象のプロパティのすぐ隣に置かれ、モデル内のすべての型に適用されます。

```csharp
// .NET 10.0.5, C# 14
[AttributeUsage(AttributeTargets.Property)]
public sealed class ServerOwnedAttribute : Attribute;

public class Order
{
    public required int Id { get; set; }

    [ServerOwned]
    public required string? InternalAuditToken { get; set; }
}

var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                {
                    if (p.AttributeProvider?.IsDefined(typeof(ServerOwnedAttribute), inherit: true) != true)
                        continue;

                    p.IsRequired = false;                        // stop demanding it on read
                    p.ShouldSerialize = static (_, _) => false;  // stop emitting it on write
                }
            }
        }
    }
};
```

このオプションでの計測結果です。`Deserialize<Order>("""{"Id":7}""")` は成功してトークンを null のまま残し、`Serialize(new Order { Id = 7, InternalAuditToken = "secret" })` は `{"Id":7}` を出力します。ここではプロパティに `[JsonIgnore]` が付いていない点に注意してください。書き出しを抑止しているのは `ShouldSerialize` であり、`[JsonIgnore]` と違ってアクセサーを剥がさないため、検証エラーは起きません。

プロパティをコントラクトから完全に消したい場合は、設定し直すのではなく削除します。`typeInfo.Properties` は変更可能なリストです。

```csharp
// .NET 10.0.5, C# 14
for (int i = typeInfo.Properties.Count - 1; i >= 0; i--)
    if (typeInfo.Properties[i].Name == "InternalAuditToken")
        typeInfo.Properties.RemoveAt(i);
```

これも双方向で動作し、多くの人が `[JsonIgnore]` に期待する動作にもっとも近いものです。ここでの `Name` は JSON 上の名前なので、すでに適用済みの命名ポリシーや `[JsonPropertyName]` が反映される点に注意してください。すでに resolver を持つオプションに追加する場合は、先に[既存の type info resolver を変更する](/ja/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)仕組みを読んでおくとよいでしょう。同じ拡張ポイントは[ソース生成されたコントラクト](/ja/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/)にも使えます。

## 書き出しのときだけ無視する、多くの人が本当に求めているもの

半分くらいのケースでは、要件は非対称です。ペイロードを読むときには存在しなければならないが、書き出すときには返したくない、というものです。パスワードハッシュ、監査トークン、内部識別子はたいていここに当てはまります。このケースには第一級の答えがあり、`required` とも衝突しません。条件付きの無視はアクセサーを剥がさないからです。

```csharp
// .NET 10.0.5, C# 14
public class Order
{
    public required int Id { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public required string? InternalAuditToken { get; set; }
}
```

計測結果です。`Serialize(new Order { Id = 7, InternalAuditToken = null })` は `{"Id":7}` を出力し、`Deserialize<Order>("""{"Id":7}""")` は引き続き `JsonException: JSON deserialization for type 'Order' was missing required properties including: 'InternalAuditToken'` をスローします。両方の性質が保たれています。値型については `JsonIgnoreCondition.WhenWritingDefault` が同じ振る舞いをします。壊れるのは `JsonIgnoreCondition.Always` を意味する裸の `[JsonIgnore]` だけです。

4 つ目の選択肢は、公開 API では正解であることも多いのですが、1 つの型に 2 つの役割を負わせるのをやめることです。`required` メンバーを持たない専用の転送用 DTO を用意し、ドメイン型との間でマッピングすれば、この問題を丸ごと回避でき、後からバージョニングの都合を置く場所も手に入ります。コストはマッピングメソッド 1 つ、見返りはドメインモデルに触れずに変更できるコントラクトです。

## 選ぶ前に知っておきたい落とし穴

**明示的な `null` は `required` を満たします。** `Deserialize<Order>("""{"Id":7,"InternalAuditToken":null}""")` は成功します。`required` はキーが存在することを意味するのであって、値が意味を持つことを意味しません。null 以外が必要なら、それはシリアル化ではなく検証の問題です。

**プロパティ初期化子でも満たされません。** `public required string InternalId { get; set; } = "fallback";` としても、キーがペイロードにないときは `JsonException` がスローされます。既定値は適用されますが、シリアライザーはそれでもペイロードを拒否します。

**エラーメッセージには JSON 上の名前が使われます。** 必須プロパティに `[JsonPropertyName("internal_id")]` を付けると、プロパティ欠落の例外は CLR のメンバー名ではなく `missing required properties including: 'internal_id'` と表示されます。命名ポリシーが絡んでいて、違う文字列を grep してしまっているときに役立ちます。

**必須フィールドが強制されるのは `IncludeFields` が有効なときだけです。** `public required string InternalId;` というフィールドは既定では System.Text.Json から見えないので、それを省いたペイロードは問題なくデシリアル化されます。`IncludeFields = true` にすると、同じ型がスローし始めます。既存のコードベースでこのオプションを有効にするなら、これが表面化することを見込んでおいてください。

**private セッターでメンバーを隠すことはできません。** `public required string InternalId { get; private set; }` はコンパイルできず、C# コンパイラーが `CS9032: Required member 'X' cannot be less visible or have a setter less visible than the containing type` で拒否します。よく試みられる抜け道がこれで塞がれます。これは[オブジェクト初期化子で必須メンバーを設定し忘れたときの CS9035 エラー](/ja/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/)と親戚の関係にあります。

**ソース生成でも挙動は同一です。** `JsonSerializerContext` 経由のデシリアル化でも、`[JsonIgnore]` と `required` の組み合わせではまったく同じ `InvalidOperationException` が、必須プロパティの欠落ではまったく同じ `JsonException` が発生します。`EmitCompilerGeneratedFiles` で生成コードを覗くと理由が分かります。`properties[0].IsRequired = true;` を直接出力しているのです。これを指摘しておく価値があるのは、Microsoft Learn のページが今でも、ソース生成モードではキーワードを使うと「コードがコンパイルされない」という理由で `required` ではなく `[JsonRequired]` を使うよう勧めているからです。.NET 10 ではコンパイルもできますし動作もします。`[SetsRequiredMembers]` も生成されたコンテキスト経由で機能します。より古い SDK を使っている場合は、頼る前に確認してください。

**`RespectRequiredConstructorParameters` は別のつまみです。** .NET 9 で導入され、省略可能でない *コンストラクターパラメーター* をペイロード上で必須にします。メンバーに付ける `required` 修飾子とは無関係で、これをオフにしてもここでは救われません。検証済みです。`Order(string name, string internalId)` というコンストラクターでオプションを指定しない場合、`Deserialize<Order>("""{"Name":"a"}""")` は成功してパラメーターを既定値のままにします。`RespectRequiredConstructorParameters = true` にすると、同じ呼び出しが `JsonException` をスローします。問題がメンバーの欠落ではなくコンストラクター引数の欠落なら、見るべきはこのフラグです。

本当の目的が、モデル化していないフィールドを含むペイロードを拒否することであれば、それは鏡写しの問題で、専用のスイッチがあります。[デシリアル化時に欠落メンバーや未マップメンバーを扱う方法](/ja/2023/09/net-8-handle-missing-members-during-json-deserialization/)を参照してください。また、階層のうち一部の形状でだけプロパティを無視したい場合は、[カスタム JsonConverter](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) が書き出す内容を完全に制御できます。ただし読み取りと書き出しの両方を手で保守する代償が伴います。

私の既定の推奨はこうです。型が自分のものなら、コンストラクターに `[SetsRequiredMembers]` を付け、まだ強制したいメンバーに `[JsonRequired]` を付ける。3 行で済み、そもそも `required` を書いた理由であるコンパイラーレベルの保証を保ったまま、アプリケーション全体に独自のオプションオブジェクトを引き回す必要もありません。

## 参考資料

- Microsoft Learn の [Require properties for deserialization](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties)。`required`、`[JsonRequired]`、`JsonPropertyInfo.IsRequired` の等価性と、`RespectRequiredConstructorParameters` の機能スイッチについて。
- [How to ignore properties with System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/ignore-properties)。`JsonIgnoreCondition` の全一覧とグローバル設定 `DefaultIgnoreCondition` について。
- [JsonPropertyInfo.IsRequired](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.isrequired) と [JsonPropertyInfo.ShouldSerialize](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.shouldserialize) の API リファレンス。
- [SetsRequiredMembersAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.setsrequiredmembersattribute) の API リファレンス。
- C# 言語リファレンスの [required 修飾子](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required)。CS9032 の可視性ルールを含みます。
