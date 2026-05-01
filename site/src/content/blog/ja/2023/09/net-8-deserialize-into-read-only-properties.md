---
title: ".NET 8 読み取り専用プロパティへのデシリアライズ"
description: ".NET 8 で setter のない読み取り専用プロパティに対して、JsonObjectCreationHandling や JsonSerializerOptions を使って JSON をデシリアライズする方法を解説します。"
pubDate: 2023-09-03
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/09/net-8-deserialize-into-read-only-properties"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 から、`set` アクセサーを持たないプロパティに対してもデシリアライズできるようになりました。この挙動は `JsonSerializerOptions` で有効化することもできますし、`JsonObjectCreationHandling` 属性を使って型ごとに有効化することもできます。

## JsonObjectCreationHandling 属性を使う

型に `System.Text.Json.Serialization.JsonObjectCreationHandling` 属性を付け、オプションをパラメーターとして渡します。

```cs
[JsonObjectCreationHandling(JsonObjectCreationHandling.Populate)]
public class Foo
{
     public int Bar { get; }
}
```

## JsonSerializerOptions を使う

`JsonSerializerOptions.PreferredObjectCreationHandling` プロパティを `Populate` に設定し、それを `Deserialize` メソッドに渡します。

```cs
new JsonSerializerOptions 
{ 
    PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate
};
```
