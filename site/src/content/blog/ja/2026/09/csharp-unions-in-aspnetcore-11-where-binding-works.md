---
title: "ASP.NET Core 11 の C# ユニオン: ボディ、SignalR、OpenAPI は動き、クエリ文字列は動かない"
description: "ASP.NET Core チームが、.NET 11 で C# 15 の union 型がどこで使えるかを整理しました。Minimal API と MVC のボディ、SignalR の JsonHubProtocol、Blazor、OpenAPI の anyOf スキーマです。ルート、クエリ、ヘッダー、フォームからのバインドはまだサポートされていません。"
pubDate: 2026-09-11
tags:
  - "csharp"
  - "csharp-15"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "signalr"
lang: "ja"
translationOf: "2026/09/csharp-unions-in-aspnetcore-11-where-binding-works"
translatedBy: "claude"
translationDate: 2026-09-11
---

.NET 11 RC 1 のリリース翌日の 9 月 10 日、ASP.NET Core チームが [Use C# unions and closed hierarchies in ASP.NET Core](https://devblogs.microsoft.com/dotnet/unions-and-closed-hierarchies-in-aspnetcore/) を公開しました。C# 15 の `union` 型が Web スタック全体のどこで実際に動くのかを示した初めての完全なマップで、答えはシンプルです。System.Text.Json を通るものはすべて動き、それ以外は動きません。

## リクエストボディと戻り値の型としてのユニオン

ユニオンはラッパーや判別子なしでアクティブなケースとしてシリアル化されるため ([.NET 11 Preview 6 の System.Text.Json](/ja/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/) で入った動作です)、Minimal API はユニオンを直接受け取り、直接返せます。

```csharp
public record Cat(string Name, string Coat);
public record Dog(string Name, string Breed);

[JsonUnion(TypeClassifier = typeof(JsonUnionTypeStructuralClassifier))]
public union UnionPet(Cat, Dog);

public union UnionIntString(int, string);

app.MapPost("/pet", ([FromBody] UnionPet pet) => TypedResults.Ok(pet));
app.MapGet("/value", () => new UnionIntString(42));
```

`UnionPet` には構造的な分類器が必要です。どちらのケースも JSON オブジェクトなので、STJ はデシリアライズの前にプロパティ名 (`coat` か `breed` か) を見てケースを選ばなければなりません。このスキャンはリクエストごとに追加の処理コストがかかり、プロパティ名を変更するとどのケースが選ばれるかが黙って変わる可能性があります。そのため、これらのプロパティ名はコントラクトの一部として扱ってください。

MVC コントローラーも STJ の入力・出力フォーマッターを通じて同じ動作になるため、`[FromBody] UnionBoolString` のアクションパラメーターやユニオンの戻り値の型は追加設定なしで動きます。

## OpenAPI は anyOf を出力する

.NET 11 に組み込まれた OpenAPI ジェネレーターは、ユニオンをケースごとに 1 エントリを持つ `anyOf` として記述します。

```json
"UnionIntString": {
  "anyOf": [
    { "type": "integer", "format": "int32" },
    { "type": "string" }
  ]
}
```

これは、`2` と `"25%"` の両方を受け付ける Kubernetes の `maxUnavailable` のようなコントラクトに対して、クライアントジェネレーターが必要とする形です。ユニオン以前は、カスタムの `JsonConverter` と手書きのスキーマトランスフォーマーでこれを表現していました。

## SignalR と Blazor

SignalR の `JsonHubProtocol` は、ハブメソッドのパラメーター、戻り値、`IAsyncEnumerable<T>` のストリーム要素としてユニオンをサポートします。MessagePack と Newtonsoft.Json のハブプロトコルはサポートしていません。Blazor は、コンポーネントパラメーター (プロセス内、シリアル化なし)、JS 相互運用、`PersistAsJson` / `TryTakeFromJson` による永続化されたコンポーネント状態でユニオンを扱えます。

## バインドが止まる場所

ルート値、クエリ文字列、ヘッダー、フォームフィールドは STJ を通らないため、そこではユニオンはサポートされません。ブログの説明では、プレーンな文字列トークンからはケースを確実に選ぶ方法がないためです。Blazor の `[SupplyParameterFromQuery]` も同じ理由で対象外です。設計の議論は [dotnet/aspnetcore#66648](https://github.com/dotnet/aspnetcore/issues/66648) で行われています。

それが入るまでは、生の文字列をバインドして自分でユニオンを組み立ててください。

```csharp
app.MapGet("/rollout", (string maxUnavailable) =>
    int.TryParse(maxUnavailable, out var count)
        ? new UnionIntString(count)
        : new UnionIntString(maxUnavailable));
```

ボディ側にももう 1 つ落とし穴があります。`JsonSerializerOptions.Web` は文字列から数値を読み取ることを許可するため、`UnionIntString` がリクエストボディの場合、JSON トークン `"42"` は `int` と `string` の両方に一致します。このユニオンを返すのは問題ありませんが、入力として受け取るにはカスタム分類器が必要です。SignalR では `JsonHubProtocol` が文字列トークンを数値の候補として扱わないため、この問題は起きません。

## ユニオンか、閉じた階層か

この記事では、`[JsonPolymorphic(InferClosedTypePolymorphism = true)]` を付けた `closed` クラス階層も取り上げています。これは `[JsonDerivedType]` をすべて列挙しなくても `$type` 判別子を生成します。指針は実用的です。JSON コントラクトに判別子を含められない場合や、ケースがプリミティブや自分で所有していない型の場合はユニオンを選び、ケースが共通の基底型を持つ新しい API を設計する場合は閉じた階層を選びます。すでに .NET 11 RC 1 を使っているなら、どちらもボディとレスポンスで試せます。ただし、当面はルートテンプレートにユニオンを入れないでください。
