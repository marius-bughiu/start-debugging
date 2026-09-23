---
title: "System.Text.Json で Vector3 や Quaternion などの public フィールドをシリアル化する方法"
description: "Vector3 や Quaternion はデータを public フィールドに保持しているため、System.Text.Json は Vector3 を {}、Quaternion を {\"IsIdentity\":false} として書き出します。IncludeFields、カスタムコンバーター、リゾルバーの修飾子、ソース生成でこれを解決する方法を、.NET 10 と .NET 11 RC 1 で計測しながら解説します。"
pubDate: 2026-09-23
template: how-to
tags:
  - "system-text-json"
  - "csharp"
  - "dotnet-10"
  - "dotnet-11"
  - "serialization"
  - "json"
lang: "ja"
translationOf: "2026/09/how-to-serialize-vector3-and-quaternion-with-system-text-json"
translatedBy: "claude"
translationDate: 2026-09-23
---

**結論:** `System.Numerics.Vector3`、`Vector2`、`Vector4`、`Quaternion`、`Plane`、`Matrix4x4` はデータを public な *フィールド* に保持しており、System.Text.Json は既定でフィールドを無視します。そのため `JsonSerializer.Serialize(new Vector3(1, 2.5f, -3))` は `{}` を返し、`{"X":1,"Y":2,"Z":3}` を逆シリアル化すると何の警告もなく `<0, 0, 0>` が得られます。`JsonSerializerOptions` で `IncludeFields = true` を設定し (ソース生成コンテキストの場合は `[JsonSourceGenerationOptions(IncludeFields = true)]`)、さらに `IgnoreReadOnlyProperties = true` を加えて `Quaternion.IsIdentity` が出力に漏れないようにします。コンパクトな `[x, y, z]` 形式が欲しい場合や `Matrix4x4` をシリアル化する場合は、代わりに `JsonConverter<T>` を書きます。

この記事の出力はすべて、同じファイルベースの検証プログラムを .NET 10.0.10 (SDK 10.0.302) と .NET 11.0.0 RC 1 (SDK 11.0.100-rc.1.26425.128) で実行して取得したものです。2 つのランタイムはバイト単位で同一の出力を返したため、ここで扱う内容は .NET 11 でも変わりません。フィールドを扱う API (`IncludeFields`、`[JsonInclude]`) は .NET 5 から存在しています。行列の出力をより冗長にしている `Matrix4x4.X/Y/Z/W` の行プロパティは .NET 10 で追加されたものです。

## System.Text.Json が Vector3 を空のオブジェクトとして書き出す理由

System.Text.Json は、各型の public なインスタンス **プロパティ** からコントラクトを構築します。public フィールドはオプトインした場合にのみ対象になります。この既定の動作は [Include fields in serialization](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/fields) のページに記載されており、Newtonsoft.Json の挙動とは正反対です。そのため移行時にこの問題に引っかかる人が多くいます。

`System.Numerics` の型はシリアル化ではなく、SIMD と相互運用のために設計されています。各成分は単純な変更可能フィールドです。

```csharp
// Shape of the types in System.Numerics (.NET 10), simplified
public struct Vector3    { public float X; public float Y; public float Z; }
public struct Quaternion { public float X; public float Y; public float Z; public float W;
                           public bool IsIdentity { get; } }
public struct Plane      { public Vector3 Normal; public float D; }
```

`Vector3` にはシリアライザーが利用できる public なインスタンスプロパティがないため、コントラクトは空になります。`Quaternion` には public なインスタンスプロパティがちょうど 1 つ、計算される `IsIdentity` があるだけなので、書き出されるのはそれだけです。例外も警告も発生しません。

## 最小限の再現コード

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1, C# 14
using System.Numerics;
using System.Text.Json;

var v = new Vector3(1f, 2.5f, -3f);
var q = Quaternion.CreateFromYawPitchRoll(0.5f, 0f, 0f);

Console.WriteLine(JsonSerializer.Serialize(v));
// {}
Console.WriteLine(JsonSerializer.Serialize(q));
// {"IsIdentity":false}
Console.WriteLine(JsonSerializer.Serialize(new Transform { Position = v, Rotation = q }));
// {"Position":{},"Rotation":{"IsIdentity":false}}

Vector3 back = JsonSerializer.Deserialize<Vector3>("""{"X":1,"Y":2,"Z":3}""");
Console.WriteLine(back);
// <0. 0. 0>

public class Transform
{
    public Vector3 Position { get; set; }
    public Quaternion Rotation { get; set; }
}
```

危険なのは逆シリアル化の行です。JSON には明らかに `X`、`Y`、`Z` が含まれていますが、コントラクトにその名前のメンバーが存在しないため、シリアライザーはそれらをマップされていないメンバーとして扱い、読み飛ばします。結果は `Vector3.Zero` になり、逆シリアル化が例外を投げないことだけを確認するテストであれば、テストは成功してしまいます。

この種のバグを明確に失敗させたい場合は、`UnmappedMemberHandling` を有効にします。

```csharp
// .NET 10.0.10
var strict = new JsonSerializerOptions
{
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
};
JsonSerializer.Deserialize<Vector3>("""{"X":1,"Y":2,"Z":3}""", strict);
// JsonException: The JSON property 'X' could not be mapped to any .NET member
// contained in type 'System.Numerics.Vector3'.
```

この設定は .NET 8 から利用でき、[逆シリアル化時の欠落メンバーとマップされていないメンバーの処理](/ja/2023/09/net-8-handle-missing-members-during-json-deserialization/) で詳しく解説しています。

## 修正 1: JsonSerializerOptions の IncludeFields

1 行で済む修正であり、ほとんどのアプリにとってはこれが正解です。

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1
var options = new JsonSerializerOptions
{
    IncludeFields = true,
    IgnoreReadOnlyProperties = true
};

JsonSerializer.Serialize(new Vector3(1f, 2.5f, -3f), options);
// {"X":1,"Y":2.5,"Z":-3}
JsonSerializer.Serialize(Quaternion.Identity, options);
// {"X":0,"Y":0,"Z":0,"W":1}
JsonSerializer.Serialize(new Plane(new Vector3(0, 1, 0), 5), options);
// {"Normal":{"X":0,"Y":1,"Z":0},"D":5}

JsonSerializer.Deserialize<Vector3>("""{"X":1,"Y":2,"Z":3}""", options);
// <1. 2. 3>
```

なぜ `IgnoreReadOnlyProperties` も必要なのでしょうか。`IncludeFields = true` だけの場合、`Quaternion` は次のようにシリアル化されます。

```json
{"IsIdentity":false,"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}
```

`IsIdentity` は派生データです。回転を書き出すたびにバイト数が増えますし、JSON を読むクライアントからは書き込み可能に見えるのに、読み戻す際には無視されるフィールドが見えることになります。`IgnoreReadOnlyProperties` は get 専用プロパティを出力から除外するため、`IsIdentity` が消え、4 つの成分はすべて残ります。フィールドには影響しないので、安全に組み合わせられます。

逆シリアル化が機能するのは、これらが構造体だからです。System.Text.Json は既定のインスタンスを作成してフィールドに値を代入するので、`Vector3(float, float, float)` コンストラクターは必要ありません。欠けている成分は `0` のままなので、`{"X":1}` は `<1, 0, 0>` になります。

`IncludeFields` について知っておくべき点が 2 つあります。

- **グローバルに作用します。** オブジェクトグラフ内のすべての型で public フィールドがシリアル化されるようになります。自分の DTO に公開するつもりのない public フィールドがあれば、それも出力に現れます。共有のオプションインスタンスで有効にする前に、シリアル化対象の型にある `public` フィールドを grep で確認してください。
- **`required` の挙動が変わります。** `required` な public フィールドは、フィールドを含めるまで System.Text.Json からは見えません。含めた後は、そのフィールドを省略したペイロードで例外が発生するようになります。この点は [`required` 修飾子を持つプロパティを無視する方法](/ja/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/) の記事で計測しています。

### [JsonInclude] がここで役に立たない理由

`IncludeFields` のメンバー単位の代替手段は `[JsonInclude]` ですが、これは *フィールド* 自体に付ける必要があり、`System.Numerics.Vector3` はあなたのコードではありません。`Vector3` 型を持つ自分のメンバーに付けても、その内部のフィールドには何の効果もありません。

```csharp
// .NET 10.0.10
public class Holder
{
    [JsonInclude] public Vector3 Pos = new(1, 2, 3);
}

JsonSerializer.Serialize(new Holder());
// {"Pos":{}}
```

`[JsonInclude]` によって `Pos` 自体は `Holder` のコントラクトに含まれました。しかし `Vector3` のコントラクトは空のままです。

## 修正 2: コンパクトな配列形式のための JsonConverter

名前付きの成分は読みやすいものの、数千の位置を含むシーンファイルやテレメトリーストリームでは、1 件ごとに `"X":`、`"Y":`、`"Z":` の分のコストがかかります。glTF と GeoJSON はどちらもベクトルに配列を使います。コンバーターを使えばその形式にでき、グローバルなオプションに依存せずに形式を選べます。

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1, C# 14
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class Vector3ArrayConverter : JsonConverter<Vector3>
{
    public override Vector3 Read(ref Utf8JsonReader reader, Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartArray)
            throw new JsonException("Expected [x, y, z].");

        Span<float> c = stackalloc float[3];
        for (int i = 0; i < 3; i++)
        {
            if (!reader.Read() || reader.TokenType != JsonTokenType.Number)
                throw new JsonException("Expected [x, y, z].");
            c[i] = reader.GetSingle();
        }

        if (!reader.Read() || reader.TokenType != JsonTokenType.EndArray)
            throw new JsonException("Expected [x, y, z].");

        return new Vector3(c);
    }

    public override void Write(Utf8JsonWriter writer, Vector3 value,
        JsonSerializerOptions options)
    {
        writer.WriteStartArray();
        writer.WriteNumberValue(value.X);
        writer.WriteNumberValue(value.Y);
        writer.WriteNumberValue(value.Z);
        writer.WriteEndArray();
    }
}
```

オプションに登録するか、プロパティに `[JsonConverter(typeof(Vector3ArrayConverter))]` を付けて登録します。

```csharp
// .NET 10.0.10
var options = new JsonSerializerOptions { Converters = { new Vector3ArrayConverter() } };

JsonSerializer.Serialize(new Vector3(1f, 2.5f, -3f), options);  // [1,2.5,-3]
JsonSerializer.Deserialize<Vector3>("[1,2,3]", options);         // <1. 2. 3>
JsonSerializer.Deserialize<Vector3>("[1,2]", options);           // JsonException: Expected [x, y, z].
```

コンバーターは登録した型にしか効きません。上の `Transform` の再現コードでは、このオプションインスタンスは `{"Position":[1,2.5,-3],"Rotation":{"IsIdentity":false}}` を書き出します。位置は直りましたが、回転は壊れたままです。使う型ごとにコンバーターを 1 つずつ書くか (`Quaternion` 版は成分が 4 つになるだけで同じコードです)、残りについてはコンバーターと `IncludeFields = true` を組み合わせてください。リーダーとライターの仕組み、特にリーダーを最後に消費したトークンの位置に置いておかなければならない理由については、[System.Text.Json でカスタム JsonConverter を書く方法](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) を参照してください。

## 修正 3: Matrix4x4 には IncludeFields ではなくコンバーターが必要

.NET 10 以降では、`Matrix4x4` で `IncludeFields` が破綻します。この構造体には `M11` から `M44` までの 16 個の public フィールドがあり、.NET 10 では既存の読み書き可能な `Translation` プロパティに加えて、読み書き可能な行プロパティ `X`、`Y`、`Z`、`W` (それぞれ `Vector4`) が追加されました。これらには setter があるため、`IgnoreReadOnlyProperties` では除外されません。`IncludeFields = true` で `Matrix4x4.CreateTranslation(1, 2, 3)` をシリアル化した結果は次のとおりです。

```json
{"IsIdentity":false,"Translation":{"X":1,"Y":2,"Z":3},
 "X":{"X":1,"Y":0,"Z":0,"W":0},"Y":{"X":0,"Y":1,"Z":0,"W":0},
 "Z":{"X":0,"Y":0,"Z":1,"W":0},"W":{"X":1,"Y":2,"Z":3,"W":1},
 "M11":1,"M12":0,"M13":0,"M14":0,"M21":0,"M22":1,"M23":0,"M24":0,
 "M31":0,"M32":0,"M33":1,"M34":0,"M41":1,"M42":2,"M43":3,"M44":1}
```

すべての値が 2 回、`M41` から `M43` は 3 回書き出されています。ラウンドトリップは可能ですが、逆シリアル化ではメンバーが JSON に現れる順に適用され、最後に書いたものが勝ちます。実際に確認しました。`{"M41":9,"W":{"X":1,"Y":2,"Z":3,"W":1}}` では `M41 == 1` となり、同じメンバーを逆の順序にすると `M41 == 9` になります。一方の表現だけを編集したクライアントは、キーの順序に依存した行列を受け取ることになります。また、`{"M11":1}` のような部分的なペイロードは、`Matrix4x4.Identity` ではなく、それ以外がすべてゼロの行列になる点にも注意してください。開始値が `default` だからです。

行列については、16 個の `M` フィールドを行優先順のフラットな配列として出力するコンバーターを書いてください。`Vector3ArrayConverter` と同じパターンで、ループを 16 要素にするだけです。重複した形式に対処するよりもコードは少なくて済みます。

## 修正 4: リゾルバーの修飾子でメンバーを取り除く

名前付きの成分 (修正 1 の形式) を使いたいが、細かく制御する必要がある場合、たとえば自分の DTO が get 専用プロパティの書き出しに依存しているため `IgnoreReadOnlyProperties` を使えない場合は、numerics の型だけのコントラクトをカスタマイズします。

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

var options = new JsonSerializerOptions
{
    IncludeFields = true,
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            ti =>
            {
                if (ti.Type != typeof(Quaternion) && ti.Type != typeof(Matrix4x4))
                    return;

                for (int i = ti.Properties.Count - 1; i >= 0; i--)
                {
                    if (ti.Properties[i].Name is "IsIdentity" or "Translation")
                        ti.Properties.RemoveAt(i);
                }
            }
        }
    }
};

JsonSerializer.Serialize(Quaternion.CreateFromYawPitchRoll(0.5f, 0f, 0f), options);
// {"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}
```

これは [既存の型情報リゾルバーを変更する](/ja/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/) のと同じ手法です。型単位で適用範囲を絞れる点が利点で、自分の型は既定のコントラクトのままです。ただし .NET 10 以降では、これでも `Matrix4x4` の `X/Y/Z/W` 行が残ることに注意してください。これも行列用コンバーターを使うべき理由の 1 つです。

## ソース生成と Native AOT

`JsonSerializerContext` を使う場合 (Native AOT やトリミングされたアプリでは必須です)、設定はオプションではなくコンテキスト側に置きます。

```csharp
// .NET 10.0.10 and .NET 11.0.0 RC 1
[JsonSourceGenerationOptions(IncludeFields = true, IgnoreReadOnlyProperties = true)]
[JsonSerializable(typeof(Transform))]
internal partial class SceneContext : JsonSerializerContext;

JsonSerializer.Serialize(new Transform { Position = v, Rotation = q },
    SceneContext.Default.Transform);
// {"Position":{"X":1,"Y":2.5,"Z":-3},"Rotation":{"X":0,"Y":0.24740396,"Z":0,"W":0.9689124}}
```

`IncludeFields = true` のないコンテキストは、再現コードで見たのと同じ空のコントラクトを生成します。`Vector3` では `{}` になることを計測で確認しました。カスタムコンバーターもソース生成で動作します。`[JsonSourceGenerationOptions(Converters = [typeof(Vector3ArrayConverter)])]` で追加してください。

検証プログラムを作成中に引っかかった罠が 1 つあります。.NET 10 のファイルベースアプリ (`dotnet run probe.cs`) は既定で `PublishAot=true` になり、リフレクションベースのシリアル化が無効になります。その状態でコンテキストなしに `JsonSerializer.Serialize(v)` を呼ぶと、`InvalidOperationException: Reflection-based serialization has been disabled for this application` が発生します。コンテキストを使うか、ちょっとした実験であれば `#:property JsonSerializerIsReflectionEnabledByDefault=true` を追加してください。背景については [System.Text.Json でリフレクションベースのシリアル化を無効にする](/ja/2023/10/system-text-json-disable-reflection-based-serialization/) で解説しています。

## 注意点: NaN、精度、大文字小文字、Unity 風のベクトル

**NaN と無限大は例外になります。** ゼロ除算を行う物理演算のステップは `NaN` の成分を生み出し、`Utf8JsonWriter` はそれを拒否します。

```csharp
// .NET 10.0.10
JsonSerializer.Serialize(new Vector3(float.NaN, 0, 0), new JsonSerializerOptions { IncludeFields = true });
// ArgumentException: .NET number values such as positive and negative infinity
// cannot be written as valid JSON.
```

`NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals` を指定すると、これらは文字列として `{"X":"NaN","Y":"Infinity","Z":0}` のように書き出されます。失敗させるよりそのほうが良いかどうかは、誰が JSON を読むかによります。JavaScript の `JSON.parse` では、数値ではなく文字列の `"NaN"` が得られます。

**float は最短表現でラウンドトリップします。** `new Vector3(0.1f, 1f/3f, 1e-8f)` は `{"X":0.1,"Y":0.33333334,"Z":1E-08}` としてシリアル化されます。System.Text.Json は同じ `float` に戻る最短の文字列を書き出すため精度は失われませんが、`double` として解析する側には `1/3` ではなく `0.33333334` が見えます。

**命名ポリシーはフィールドにも適用されます。** `JsonSerializerDefaults.Web` と `IncludeFields = true` を組み合わせると `{"x":1,"y":2.5,"z":-3}` が書き出され、Web の既定値は大文字小文字を区別しないため、どちらの表記でも読み込めます。JavaScript クライアントが大文字の `X` を期待している場合は、このペイロードに Web の既定値を使わないでください。

**Unity 風のベクトルは循環エラーで失敗します。** `UnityEngine.Vector3` も `x`、`y`、`z` をフィールドに保持していますが、別の `Vector3` を返す `normalized` のような計算プロパティも持っています。このような形の構造体は、`IncludeFields` の有無にかかわらずシリアル化に失敗します。`normalized` が自分自身の `normalized` を持ち、それが永遠に続くからです。

```text
JsonException: A possible object cycle was detected. This can either be due to a cycle
or if the object depth is larger than the maximum allowed depth of 64.
Path: $.normalized.normalized.no...
```

構造体には追跡すべき参照がないため、`ReferenceHandler.IgnoreCycles` は役に立ちません。`normalized` はそれぞれ新しい値です。私のテストでは `IgnoreReadOnlyProperties = true` と `IncludeFields = true` の組み合わせで解決し、`{"x":3,"y":0,"z":4}` が得られ、ラウンドトリップも成功しました。テストには Unity のものと同じ形の構造体 (フィールドに加えて get 専用の `magnitude`、`sqrMagnitude`、`normalized` を持つもの) を使っており、独自のシリアライザーを備えた Unity エディター内ではテストしていません。この例外については [「A possible object cycle was detected」の修正方法](/ja/2026/05/fix-possible-object-cycle-was-detected-system-text-json/) で詳しく解説しています。

## どの修正を選ぶべきか

1. `Vector2`、`Vector3`、`Vector4`、`Quaternion`、`Plane` をシリアル化していて `{"X":..,"Y":..}` 形式のオブジェクトで問題がなければ、オプション (または `JsonSourceGenerationOptions`) に `IncludeFields = true` と `IgnoreReadOnlyProperties = true` を追加します。
2. テストでは `UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow` を有効にします。将来、同じフィールドの問題を持つ型が現れても、ゼロとして逆シリアル化されるのではなく失敗するようになります。
3. `Matrix4x4` には `JsonConverter<T>` を書きます。ペイロードのサイズが重要な場合や、仕様 (glTF、GeoJSON) で配列が指定されている場合は、ベクトルにも書きます。
4. `IncludeFields` を有効にしたまま特定のプロパティだけを除外したい場合は、自分の型のシリアル化方法を変えずに済む `DefaultJsonTypeInfoResolver` の修飾子を使います。

これらの構造体を確認なしにフィールド単位でシリアル化していた `BinaryFormatter` から移行する場合も、[BinaryFormatter 移行ガイド](/ja/2026/09/migrate-off-binaryformatter-after-its-removal-in-modern-dotnet/) で同じ `IncludeFields` の判断が必要になります。

## 関連記事

- [System.Text.Json でカスタム JsonConverter を書く方法](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [System.Text.Json で required 修飾子を持つプロパティを無視する方法](/ja/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/)
- [System.Text.Json の「A possible object cycle was detected」を修正する](/ja/2026/05/fix-possible-object-cycle-was-detected-system-text-json/)
- [.NET 8: JSON シリアル化に非 public メンバーを含める](/ja/2023/09/net-8-include-non-public-members-in-json-serialization/)
- [System.Text.Json: 既存の型情報リゾルバーを変更する](/ja/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)

## 参考資料

- [Include fields in serialization](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/fields)、Microsoft Learn
- [`JsonSerializerOptions.IncludeFields`](https://learn.microsoft.com/dotnet/api/system.text.json.jsonserializeroptions.includefields) と [`IgnoreReadOnlyProperties`](https://learn.microsoft.com/dotnet/api/system.text.json.jsonserializeroptions.ignorereadonlyproperties)
- [`Matrix4x4.X` プロパティ](https://learn.microsoft.com/dotnet/api/system.numerics.matrix4x4.x)、.NET 10 と .NET 11 に適用
- [Customize a JSON contract](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/custom-contracts)、Microsoft Learn
- [`JsonNumberHandling`](https://learn.microsoft.com/dotnet/api/system.text.json.serialization.jsonnumberhandling)
