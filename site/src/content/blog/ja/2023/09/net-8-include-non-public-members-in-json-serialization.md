---
title: ".NET 8 非公開メンバーを JSON シリアライズに含める"
description: ".NET 8 で JsonInclude 属性を使って、private、protected、internal なプロパティを JSON シリアライズに含める方法を解説します。"
pubDate: 2023-09-05
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/09/net-8-include-non-public-members-in-json-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 から、`System.Text.Json` を使ったシリアライズに非公開のプロパティを含められるようになりました。そのためには、対象の非公開プロパティに [JsonIncludeAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonincludeattribute?view=net-8.0) 属性を付けるだけです。

```cs
[System.AttributeUsage(System.AttributeTargets.Field | System.AttributeTargets.Property, AllowMultiple=false)]
public sealed class JsonIncludeAttribute : System.Text.Json.Serialization.JsonAttribute
```

この属性は、`private`、`protected`、`internal` といった、どの非公開修飾子に対しても機能します。例を見てみましょう。

```cs
string json = JsonSerializer.Serialize(new MyClass(1, 2, 3));

Console.WriteLine(json);

public class MyClass
{
    public MyClass(int privateProperty, int protectedProperty, int internalProperty)
    {
        PrivateProperty = privateProperty;
        ProtectedProperty = protectedProperty;
        InternalProperty = internalProperty;
    }

    [JsonInclude]
    private int PrivateProperty { get; }

    [JsonInclude]
    protected int ProtectedProperty { get; }

    [JsonInclude]
    internal int InternalProperty { get; }
}
```

期待どおり、出力は次のようになります。

```json
{"PrivateProperty":1,"ProtectedProperty":2,"InternalProperty":3}
```
