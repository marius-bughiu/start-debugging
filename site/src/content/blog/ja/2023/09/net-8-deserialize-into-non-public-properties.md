---
title: ".NET 8 非公開プロパティへのデシリアライズ"
description: ".NET 8 で、JsonInclude 属性とパラメーター付きコンストラクターを使って、JSON を非公開プロパティにデシリアライズする方法を解説します。"
pubDate: 2023-09-21
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/09/net-8-deserialize-into-non-public-properties"
translatedBy: "claude"
translationDate: 2026-05-01
---
[非公開メンバーへのシリアライズ](/2023/09/net-8-include-non-public-members-in-json-serialization/) と同じように、非公開メンバーの名前に一致するパラメーターを持つコンストラクターを用意し、対象の非公開メンバーに `JsonInclude` 属性を付けることで、非公開メンバーへのデシリアライズが可能になります。

さっそく例を見てみましょう。

```cs
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

    public int PublicProperty { get; set; }
}
```

`PublicProperty` には何の属性も付けておらず、コンストラクターにも含めていない点に注目してください。これは必要ありません。プロパティが public で公開された setter も持っているので、オブジェクトのインスタンス生成後に代入できるからです。

上で定義した型にデシリアライズしてみるには、次のようにします。

```cs
string json = "{\"PrivateProperty\":1,\"ProtectedProperty\":2,\"InternalProperty\":3,\"PublicProperty\":4}";
var myObj = JsonSerializer.Deserialize<MyClass>(json);
```

## デシリアライズ時に複数のコンストラクターがある場合

クラスに複数のコンストラクターがある場合は、[JsonConstructorAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonconstructorattribute.-ctor?view=net-8.0) を使ってデシリアライザーに正しいコンストラクターを示す必要があります。

```cs
public MyClass() { }

[JsonConstructor]
public MyClass(int privateProperty, int protectedProperty, int internalProperty)
{
    PrivateProperty = privateProperty;
    ProtectedProperty = protectedProperty;
    InternalProperty = internalProperty;
}
```
