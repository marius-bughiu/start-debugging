---
title: "既存の JsonSerializerOptions に TypeInfoResolver を追加・削除する"
description: ".NET 8 で追加された TypeInfoResolverChain プロパティを使って、既存の JsonSerializerOptions に TypeInfoResolver を追加したり、そこから削除したりする方法を解説します。"
pubDate: 2023-10-19
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 から、`JsonSerializerOptions` クラスには既存の `TypeInfoResolver` プロパティに加えて、新しく `TypeInfoResolverChain` プロパティが追加されました。この新しいプロパティのおかげで、すべての resolver を同じ場所で指定する必要がなくなり、必要に応じてあとから追加できるようになりました。

例を見てみましょう。

```cs
var options = new JsonSerializerOptions
{
    TypeInfoResolver = JsonTypeInfoResolver.Combine(
        new ResolverA(), 
        new ResolverB()
    );
};

options.TypeInfoResolverChain.Add(new ResolverC());
```

既存の `JsonSerializerOptions` に新しい type resolver を追加するだけでなく、`TypeInfoResolverChain` を使えば、シリアライザーオプションから type info resolver を削除することもできます。

```cs
options.TypeInfoResolverChain.RemoveAt(0);
```

type info resolver のチェーンに対する変更を禁止したい場合は、[`JsonSerializerOptions` インスタンスを読み取り専用にする](/2023/09/net-8-mark-jsonserializeroptions-as-readonly/) という方法があります。これは、options インスタンスに対して `MakeReadOnly()` メソッドを呼び出すことで行え、その後に type info resolver のチェーンを変更しようとすると、次の `InvalidOperationException` が必ずスローされるようになります。

```plaintext
Unhandled exception. System.InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_SerializerOptionsReadOnly(JsonSerializerContext context)
   at System.Text.Json.JsonSerializerOptions.VerifyMutable()
   at System.Text.Json.JsonSerializerOptions.OptionsBoundJsonTypeInfoResolverChain.OnCollectionModifying()
   at System.Text.Json.Serialization.ConfigurationList`1.Add(TItem item)
```
