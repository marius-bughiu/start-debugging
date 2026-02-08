---
title: ".NET 8 – Include non-public members in JSON serialization"
description: "Learn how to include private, protected, and internal properties in JSON serialization in .NET 8 using the JsonInclude attribute."
pubDate: 2023-09-05
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
---
Starting with .NET 8 you can include non-public properties in the serialization when using `System.Text.Json`. To do so, simply decorate the non-public property with the [JsonIncludeAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonincludeattribute?view=net-8.0) attribute.

```cs
[System.AttributeUsage(System.AttributeTargets.Field | System.AttributeTargets.Property, AllowMultiple=false)]
public sealed class JsonIncludeAttribute : System.Text.Json.Serialization.JsonAttribute
```

The attribute works with any non-public modifier, such as `private`, `protected` or `internal`. Let’s look at an example:

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

As expected, this will output the following:

```json
{"PrivateProperty":1,"ProtectedProperty":2,"InternalProperty":3}
```
