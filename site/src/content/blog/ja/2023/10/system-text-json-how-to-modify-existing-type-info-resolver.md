---
title: "System.Text.Json 既存の type info resolver を変更する方法"
description: ".NET 8 で追加された WithAddedModifier 拡張メソッドを使えば、任意の IJsonTypeInfoResolver のシリアライズコントラクトを、新しい resolver をゼロから作らずに簡単に変更できます。"
pubDate: 2023-10-25
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/10/system-text-json-how-to-modify-existing-type-info-resolver"
translatedBy: "claude"
translationDate: 2026-05-01
---
ちょっとした 1 つか 2 つの修正だけで済むのに、新しい `IJsonTypeInfoResolver` をまるごと作るのはやりすぎに感じる場面があります。デフォルトの (あるいはすでに定義されている別の) type info resolver で十分こなせるはずだからです。

これまで、デフォルトの type info resolver については `DefaultJsonTypeInfoResolver.Modifiers` プロパティをいじることはできましたが、開発者が自分で定義した resolver や、パッケージ由来の resolver に対しては、用意された手段がありませんでした。

こうしたケース向けに、.NET 8 から、任意の `IJsonTypeInfoResolver` のシリアライズコントラクトに簡単に変更を加えられる新しい拡張メソッドが用意されました。もちろん、デフォルトの type info resolver と組み合わせて使うこともできます。

```cs
public static IJsonTypeInfoResolver WithAddedModifier(
    this IJsonTypeInfoResolver resolver, 
    Action<JsonTypeInfo> modifier)
```

これによって、スキーマの変更を扱える `JsonTypeInfoResolverWithAddedModifiers` (`IJsonTypeInfoResolver` の一種) のインスタンスが作成されます。

任意の `MyTypeInfoResolver` を例に、シンプルな使用例を見てみましょう。

```cs
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new MyTypeInfoResolver()
        .WithAddedModifier(typeInfo =>
        {
            foreach (JsonPropertyInfo prop in typeInfo.Properties)
                prop.Name = prop.Name.ToLower();
        })
};
```
