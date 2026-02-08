---
title: ".NET 8 – Deserialize into non-public properties"
description: "Learn how to deserialize JSON into non-public properties in .NET 8 using the JsonInclude attribute and parameterized constructors."
pubDate: 2023-09-21
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
---
Similar to [serializing into non-public members](/2023/09/net-8-include-non-public-members-in-json-serialization/), you can deserialize into non-public members by providing a constructor with parameters matching the non-public member names and by annotating the non-public members with the `JsonInclude` attribute.

Let’s jump straight to an example:

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

Note how we haven’t annotated `PublicProperty` in any way and we haven’t included it in the constructor either. That's not necessary, because the property is public and it has a public setter, so it can be assigned after the object instance is created.

To try out deserializing into the type defined above, we can do this:

```cs
string json = "{\"PrivateProperty\":1,\"ProtectedProperty\":2,\"InternalProperty\":3,\"PublicProperty\":4}";
var myObj = JsonSerializer.Deserialize<MyClass>(json);
```

## Dealing with multiple constructors during deserialization

In case your class has multiple constructors, you will have to guide the deserializer to the correct one using the [JsonConstructorAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonconstructorattribute.-ctor?view=net-8.0).

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
