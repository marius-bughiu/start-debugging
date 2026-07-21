---
title: ".NET 11 Preview 6 で System.Text.Json が C# の union 型のシリアライズに対応"
description: ".NET 11 Preview 6 の System.Text.Json が、アクティブなケースを書き出すことで新しい C# の union 型をシリアライズする仕組みと、あいまいなケースを解決する JsonUnionAttribute 型分類子の API を解説します。"
pubDate: 2026-07-21
tags:
  - "csharp"
  - "dotnet-11"
  - "system-text-json"
  - "json"
lang: "ja"
translationOf: "2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-21
---

C# の union 型は .NET 11 のプレビューにおける目玉機能でしたが、これまではコンパイラーの境界で止まっていました。[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/)（2026 年 7 月 9 日）からは、`System.Text.Json` がそれをネイティブに理解します。カスタムの `JsonConverter` を書かなくても、union をシリアライズおよびデシリアライズできます。Preview 6 では他に 2 つのピースが揃い、これらすべてがようやくボイラープレートなしで動くようになりました。サポート型である `System.Runtime.CompilerServices.UnionAttribute` と `IUnion` がフレームワークに同梱されたため、素の `net11.0` プロジェクトで union がコンパイルできます。

## ラッパーではなくアクティブなケースを書き出す

union は、値が固定された一連のケース型のうち、ちょうど 1 つであることを宣言します。省略記法は、その時点でアクティブなケースを保持する構造体を生成します。

```csharp
public union Pet(Cat, Dog, Bird);

public record Cat(string Name);
public record Dog(string Name);
public record Bird(string Name);
```

`System.Text.Json` は、これを新しい契約の種類 `JsonTypeInfoKind.Union` を通じて認識します。union をシリアライズすると、シリアライザーはアクティブなケースを読み取り、その値を直接書き出します。周囲にラッパーは付きません。

```csharp
Pet pet = new Dog("Rex");
string json = JsonSerializer.Serialize(pet);
// {"Name":"Rex"}
```

プリミティブの union では、`int` と `string` の union が問題なく往復します。JSON のトークンが構造的に異なるからです。

```csharp
Pet-like union of (int, string):
"hello"   // the string case
42        // the int case
```

リフレクションベースのシリアライザーとソースジェネレーターの両方がこれをサポートするため、これを使うために AOT 互換の経路から外れる必要はありません。

## 判別子のギャップと、その埋め方

生の値を書き出すのはエレガントですが、`Pet` で何が起きるかに注目してください。`Dog("Rex")` も `Cat("Rex")` も `{"Name":"Rex"}` にシリアライズされます。戻す際、シリアライザーはそれがどのケースだったかを判別できません。これはタグ付き共用体の古典的な問題であり、Preview 6 は推測ではなくそれを解決するためのツールを提供します。

3 つの新しい API が、ケースの発見方法と命名方法を制御します。`JsonUnionAttribute`、`JsonUnionCaseInfo`、そして型分類子のペアである `JsonTypeClassifier` と `JsonSerializerOptions.TypeClassifiers` です。これらを組み合わせると、生成される JSON に型判別子を付与でき、あいまいなオブジェクト形状のケースを正しいケース型へデシリアライズできます。構造的に異なるケース（`int` 対 `string` など）にはこれらは不要で、ペイロードが衝突する場合にのみこの手続きが必要になります。

[Preview 2 以降の union 型に関する記事](/ja/2026/04/csharp-15-union-types-dotnet-11-preview-2/)を追ってきたなら、これは union 型を HTTP の境界を越えて使えるようにするピースです。union は常にシリアライズのサポート次第で活きるか死ぬかが決まる運命にあり、Preview 6 は union がコンパイラーの珍品であることをやめ、ネットワークに乗せられるものになる転換点です。

詳細は [Preview 6 のライブラリーのリリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/libraries.md)にあります。
