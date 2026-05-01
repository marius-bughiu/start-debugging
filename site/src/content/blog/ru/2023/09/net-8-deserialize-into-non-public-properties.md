---
title: ".NET 8 десериализация в непубличные свойства"
description: "Узнайте, как в .NET 8 десериализовать JSON в непубличные свойства с помощью атрибута JsonInclude и параметризованных конструкторов."
pubDate: 2023-09-21
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/09/net-8-deserialize-into-non-public-properties"
translatedBy: "claude"
translationDate: 2026-05-01
---
По аналогии с [сериализацией в непубличные члены](/2023/09/net-8-include-non-public-members-in-json-serialization/) можно десериализовать в непубличные члены, предоставив конструктор с параметрами, совпадающими по именам с непубличными членами, и пометив эти члены атрибутом `JsonInclude`.

Перейдём сразу к примеру:

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

Обратите внимание, что мы никак не пометили `PublicProperty` и не включили её в конструктор. Это не нужно: свойство публичное и имеет публичный сеттер, поэтому ему можно присвоить значение уже после создания экземпляра объекта.

Чтобы попробовать десериализовать в описанный выше тип, можно сделать так:

```cs
string json = "{\"PrivateProperty\":1,\"ProtectedProperty\":2,\"InternalProperty\":3,\"PublicProperty\":4}";
var myObj = JsonSerializer.Deserialize<MyClass>(json);
```

## Что делать с несколькими конструкторами при десериализации

Если в вашем классе несколько конструкторов, нужно указать десериализатору правильный с помощью [JsonConstructorAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonconstructorattribute.-ctor?view=net-8.0).

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
