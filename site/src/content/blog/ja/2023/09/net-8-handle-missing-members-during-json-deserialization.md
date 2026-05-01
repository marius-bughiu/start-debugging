---
title: ".NET 8 JSON デシリアライズ時の未知のメンバーへの対応"
description: ".NET 8 で JsonUnmappedMemberHandling を使い、デシリアライズ時にマップできない JSON プロパティに対して例外をスローさせる方法を解説します。"
pubDate: 2023-09-02
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/09/net-8-handle-missing-members-during-json-deserialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
デフォルトでは、デシリアライズしようとしている JSON ペイロードに余分なプロパティがあっても、単に無視されます。では、JSON に余分なプロパティがあるときにデシリアライズを失敗させて例外をスローしたい場合はどうすればよいでしょうか? .NET 8 から、それが可能になりました。

`System.Text.Json` シリアライザーで、この挙動を有効化する方法はいくつかあります。

## 1\. JsonUnmappedMemberHandling 属性を使う

型に `[System.Text.Json.Serialization.JsonUnmappedMemberHandlingAttribute]` を付け、オプションをパラメーターとして渡します。

```cs
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public class Foo
{
     public int Bar { get; set; }
}
```

## 2\. JsonSerializerOptions を使う

`JsonSerializerOptions.UnmappedMemberHandling` プロパティを `Disallow` に設定し、それを `Deserialize` メソッドに渡します。

```cs
new JsonSerializerOptions 
{ 
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow 
};
```

## 例外がスローされる

例外をキャッチする準備をしておきましょう。`JsonUnmappedMemberHandling` を `Disallow` にした状態で、追加のメンバーを含む JSON ペイロードをデシリアライズしようとすると、次の例外がスローされます。

> **System.Text.Json.JsonException**: 'The JSON property '<property name>' could not be mapped to any .NET member contained in type '<namespace>+<type name>'.'
