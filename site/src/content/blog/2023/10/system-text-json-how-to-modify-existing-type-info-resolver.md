---
title: "System.Text.Json – How to modify existing type info resolver"
description: "Use the new WithAddedModifier extension method in .NET 8 to easily modify any IJsonTypeInfoResolver serialization contract without creating a new resolver from scratch."
pubDate: 2023-10-25
updatedDate: 2023-11-01
tags:
  - "dotnet"
  - "dotnet-8"
---
There are some situations in which creating a whole new `IJsonTypeInfoResolver` will seem overkill, when the default (or any other already defined) type info serializer could do the job with only one or two small modifications.

Until now, you could play with the `DefaultJsonTypeInfoResolver.Modifiers` property for the default type info resolver, but you didn’t have anything built-in for any developer-defined type info resolvers or resolvers coming from packages.

For these cases in particular, starting with .NET 8, we have a new extension method which allows us to easily introduce modifications to arbitrary `IJsonTypeInfoResolver` serialization contracts. The extension method can of course be used in combination with the default type info resolver as well.

```cs
public static IJsonTypeInfoResolver WithAddedModifier(
    this IJsonTypeInfoResolver resolver, 
    Action<JsonTypeInfo> modifier)
```

This will create for you an instance of `JsonTypeInfoResolverWithAddedModifiers` (an `IJsonTypeInfoResolver`) capable of handling your schema modifications.

Let’s look at a simple usage example, assuming an arbitrary `MyTypeInfoResolver`:

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
