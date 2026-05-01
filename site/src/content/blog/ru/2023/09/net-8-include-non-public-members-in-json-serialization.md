---
title: ".NET 8 включаем непубличные члены в JSON-сериализацию"
description: "Узнайте, как в .NET 8 включить private, protected и internal свойства в JSON-сериализацию с помощью атрибута JsonInclude."
pubDate: 2023-09-05
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/09/net-8-include-non-public-members-in-json-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
Начиная с .NET 8 можно включать непубличные свойства в сериализацию при использовании `System.Text.Json`. Для этого достаточно пометить непубличное свойство атрибутом [JsonIncludeAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonincludeattribute?view=net-8.0).

```cs
[System.AttributeUsage(System.AttributeTargets.Field | System.AttributeTargets.Property, AllowMultiple=false)]
public sealed class JsonIncludeAttribute : System.Text.Json.Serialization.JsonAttribute
```

Атрибут работает с любыми непубличными модификаторами: `private`, `protected` или `internal`. Рассмотрим пример:

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

Как и ожидается, в выводе получим:

```json
{"PrivateProperty":1,"ProtectedProperty":2,"InternalProperty":3}
```
