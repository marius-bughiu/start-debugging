---
title: "Add/Remove TypeInfoResolver to existing JsonSerializerOptions"
description: "Starting with .NET 8, the JsonSerializerOptions class features a new TypeInfoResolverChain property in addition to the existing TypeInfoResolver property. With this new property, you are no longer required to specify all the resolvers in the same place, instead, you can add them later as needed. Let’s look at an example: Besides adding new type resolvers…"
pubDate: 2023-10-19
updatedDate: 2023-11-05
tags:
  - "net"
  - "net-8"
---
Starting with .NET 8, the `JsonSerializerOptions` class features a new `TypeInfoResolverChain` property in addition to the existing `TypeInfoResolver` property. With this new property, you are no longer required to specify all the resolvers in the same place, instead, you can add them later as needed.

Let’s look at an example:

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

Besides adding new type resolvers to an existing `JsonSerializerOptions`, `TypeInfoResolverChain` also allows you to remove type info resolvers from the serializer options.

```cs
options.TypeInfoResolverChain.RemoveAt(0);
```

If you want to prevent changes to the type info resolver chain, you can do it by [making the `JsonSerializerOptions` instance read-only](/2023/09/net-8-mark-jsonserializeroptions-as-readonly/). That is done by calling the `MakeReadOnly()` method on the options instance and will force the following `InvalidOperationException` in case anyone attempts to modify the type info resolver chain after the fact.

```plaintext
Unhandled exception. System.InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_SerializerOptionsReadOnly(JsonSerializerContext context)
   at System.Text.Json.JsonSerializerOptions.VerifyMutable()
   at System.Text.Json.JsonSerializerOptions.OptionsBoundJsonTypeInfoResolverChain.OnCollectionModifying()
   at System.Text.Json.Serialization.ConfigurationList`1.Add(TItem item)
```
