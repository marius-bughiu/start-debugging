---
title: "How to customize source-generated System.Text.Json serialization with a type-info resolver modifier"
description: "Attach a JsonTypeInfo modifier to a source-generated JsonSerializerContext in .NET 11: why new MyContext(options) silently drops it, the WithAddedModifier setup that works, the fast path you give up (measured), and the naming-policy trap that makes modifiers no-op."
pubDate: 2026-08-10
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "source-generators"
  - "serialization"
  - "how-to"
---

To customize a source-generated `System.Text.Json` contract, put your modifier on the `JsonSerializerOptions`, never on the context: `new JsonSerializerOptions { TypeInfoResolver = MyContext.Default.WithAddedModifier(MyModifier) }`. The obvious-looking alternative, `new MyContext(optionsWithModifier)`, compiles, runs, and silently ignores your modifier, because the `JsonSerializerContext` constructor overwrites `TypeInfoResolver` with the context itself. Modifiers work fine with source generation, including with reflection-based serialization disabled for Native AOT, but they do cost you the generated fast path. Everything below was verified against .NET 10.0.5 with SDK 10.0.201; the APIs are unchanged from .NET 8 through .NET 11.

## Why contract customization and source generation feel incompatible

Contract customization landed in .NET 7. You hand `System.Text.Json` an `Action<JsonTypeInfo>` and it calls you once per type, after the contract has been built but before it is used, so you can rename properties, drop them, add synthetic ones, or wrap the getter and setter delegates. The canonical entry point is `DefaultJsonTypeInfoResolver.Modifiers`, and .NET 8 added [the `WithAddedModifier` extension method](/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/) so you can layer a modifier onto any `IJsonTypeInfoResolver`, not just the reflection-based one.

That "any resolver" part is the important bit, because a source-generated `JsonSerializerContext` **is** an `IJsonTypeInfoResolver`. There is no technical reason a modifier cannot decorate `MyContext.Default`. The reason so many people conclude that contract modifiers do not work with source generation is that the natural-looking wiring throws the modifier away without a warning, an exception, or a compiler diagnostic.

Here is the model I will use for the rest of the post. An `Order` with a secret on it, plus a nested `Address` that has the same problem:

```csharp
// .NET 11, C# 14
public class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
    public string? ApiKey { get; set; }
    public Address? ShipTo { get; set; }
}

public class Address
{
    public string City { get; set; } = "";
    public string? ApiKey { get; set; }
}

[JsonSerializable(typeof(Order))]
public partial class OrderContext : JsonSerializerContext { }
```

And the modifier, which redacts every property called `ApiKey` anywhere in the object graph:

```csharp
// .NET 11, C# 14
static void RedactApiKey(JsonTypeInfo typeInfo)
{
    if (typeInfo.Kind != JsonTypeInfoKind.Object)
        return;

    foreach (JsonPropertyInfo property in typeInfo.Properties)
    {
        if (property.Name != "ApiKey")
            continue;

        Func<object, object?>? get = property.Get;
        if (get is not null)
            property.Get = obj => get(obj) is null ? null : "***";
    }
}
```

## The wiring that works, and the one that silently does nothing

Three steps, and the order matters:

1. Build the resolver first by calling `WithAddedModifier` on your generated context's `Default` property. This returns a `JsonTypeInfoResolverWithAddedModifiers` that delegates to the context and then runs your callback.
2. Assign that resolver to a `JsonSerializerOptions.TypeInfoResolver` and cache the options instance in a `static readonly` field. Never construct the `JsonSerializerContext` yourself.
3. Pass that options instance to `JsonSerializer.Serialize` or `JsonSerializer.Deserialize`. Do not pass the context, and do not pass a `JsonTypeInfo` you pulled off `MyContext.Default`.

```csharp
// .NET 11, C# 14 - works
static readonly JsonSerializerOptions RedactingOptions = new()
{
    TypeInfoResolver = OrderContext.Default.WithAddedModifier(RedactApiKey)
};

var order = new Order
{
    Id = 7,
    Customer = "acme",
    ApiKey = "sk-live-123",
    ShipTo = new Address { City = "Cluj", ApiKey = "sk-nested-999" }
};

Console.WriteLine(JsonSerializer.Serialize(order, typeof(Order), RedactingOptions));
// {"Id":7,"Customer":"acme","ApiKey":"***","ShipTo":{"City":"Cluj","ApiKey":"***"}}
```

Note that the nested `Address` is redacted too, even though it was never listed in a `[JsonSerializable]` attribute. The generator walks the object graph from every declared root, so `OrderContext.Default.GetTypeInfo(typeof(Address))` returns a contract, and the modifier runs for it like any other type.

Now the version that looks equally reasonable and quietly does nothing:

```csharp
// .NET 11, C# 14 - modifier is silently discarded
var context = new OrderContext(new JsonSerializerOptions
{
    TypeInfoResolver = OrderContext.Default.WithAddedModifier(RedactApiKey)
});

Console.WriteLine(JsonSerializer.Serialize(order, typeof(Order), context));
// {"Id":7,"Customer":"acme","ApiKey":"sk-live-123","ShipTo":{...,"ApiKey":"sk-nested-999"}}

Console.WriteLine(context.Options.TypeInfoResolver?.GetType().Name);
// OrderContext
```

The `JsonSerializerContext(JsonSerializerOptions)` constructor copies your options and then assigns itself to `TypeInfoResolver`, so the decorated resolver you carefully built is gone before the first serialization. The `System.Text.Json` maintainers' guidance on [dotnet/runtime discussion 121304](https://github.com/dotnet/runtime/discussions/121304) is exactly this: avoid `JsonSerializerContext` instances and pass options directly to `JsonSerializer`.

Two more ways to lose the modifier, both easy to write by accident:

```csharp
// .NET 11, C# 14 - both bypass the modifier
JsonSerializer.Serialize(order, OrderContext.Default.Order);
JsonSerializer.Serialize(order, typeof(Order), OrderContext.Default);
```

`OrderContext.Default` is the unmodified contract. That is a feature, not a bug: modifiers never mutate the shared `Default` instance, so a redacting resolver in one part of your app cannot leak into another. If you want a `JsonTypeInfo` overload for the hot path, pull the type info out of the modified options instead:

```csharp
// .NET 11, C# 14
var typeInfo = (JsonTypeInfo<Order>)RedactingOptions.GetTypeInfo(typeof(Order));
JsonSerializer.Serialize(order, typeInfo);   // redacted
```

## Matching on Name is the trap that bites in ASP.NET Core

`JsonPropertyInfo.Name` is the **JSON** name, after `PropertyNamingPolicy` has been applied. In a plain console app with default options the naming policy is null, so `property.Name` happens to equal the CLR property name and a `== "ApiKey"` check works. Wire the same modifier into ASP.NET Core, where the default policy is camelCase, and the check matches nothing:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.TypeInfoResolver = AppJsonContext.Default.WithAddedModifier(RedactApiKey);
});
```

With `property.Name != "ApiKey"` the endpoint happily returns `{"id":7,"customer":"acme","apiKey":"sk-live-1"}`. The modifier ran; it just never matched, because the contract already reported the property as `apiKey`.

Match on the CLR member instead. `JsonPropertyInfo.AttributeProvider` is a `PropertyInfo` even for source-generated contracts, so both the member name and any custom attributes are available:

```csharp
// .NET 11, C# 14
[AttributeUsage(AttributeTargets.Property)]
public sealed class RedactAttribute : Attribute { }

static void RedactByAttribute(JsonTypeInfo typeInfo)
{
    if (typeInfo.Kind != JsonTypeInfoKind.Object)
        return;

    foreach (JsonPropertyInfo property in typeInfo.Properties)
    {
        object[]? attributes = property.AttributeProvider
            ?.GetCustomAttributes(typeof(RedactAttribute), inherit: true);

        if (attributes is not { Length: > 0 })
            continue;

        Func<object, object?>? get = property.Get;
        if (get is not null)
            property.Get = obj => get(obj) is null ? null : "***";
    }
}
```

That version survives any naming policy and, in my test, produced `{"id":7,"customer":"acme","apiKey":"***"}` from the same minimal API endpoint.

## What you can actually change on a source-generated contract

Everything the [custom contracts documentation](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts) describes for the reflection resolver also works over a generated one. I verified each of these against `OrderContext.Default`:

- **Remove a property.** `typeInfo.Properties.RemoveAt(i)` drops it from both serialization and deserialization. Output becomes `{"Id":7,"Customer":"acme","ShipTo":{"City":"Cluj"}}`.
- **Add a synthetic property.** `typeInfo.CreateJsonPropertyInfo(typeof(string), "kind")` plus a `Get` delegate, then `typeInfo.Properties.Add(...)`, appends `"kind":"order"` to the payload. No CLR member has to exist.
- **Wrap the setter.** Reassigning `property.Set` runs on deserialization. Uppercasing `Customer` through a wrapped setter turned `{"Customer":"acme"}` into `Customer == "ACME"`.
- **Conditional writes.** `property.ShouldSerialize = (_, value) => !string.IsNullOrEmpty((string?)value)` suppressed the empty `Customer` string while leaving the rest of the contract alone.
- **Number handling per type.** `typeInfo.NumberHandling` is the one knob that applies to `JsonTypeInfoKind.None` contracts such as `int`.

Modifiers compose in the order you add them. Chaining two `WithAddedModifier` calls, the first lowercasing every name and the second inserting a `"v"` property at index 0, produced `{"v":"2","id":7,"customer":"acme",...}`: the lowercase pass ran first, so the later-inserted property kept its casing.

## Native AOT: modifiers are not the thing that breaks

The whole reason to use [a source generator](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) here is trimming and Native AOT, so the obvious worry is whether attaching a modifier drags reflection back in. It does not. I re-ran the same code with `<JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>`, which is what `PublishAot` and `PublishTrimmed` set for you:

```text
IsReflectionEnabledByDefault = False
attribute-driven modifier over source-gen: {"Id":7,"Customer":"acme","ApiKey":"***","ShipTo":{"City":"Cluj","ApiKey":"***"}}
synthetic property with reflection off:    {"Id":7,...,"kind":"order"}
```

Both the attribute lookup through `AttributeProvider` and the runtime-created property worked. What still breaks in that configuration is the ordinary source-generation rule: any root type missing from the context throws, and the modifier is irrelevant to it.

```text
NotSupportedException: JsonTypeInfo metadata for type '<>f__AnonymousType0`1[System.Int32]'
was not provided by TypeInfoResolver of type
'System.Text.Json.Serialization.Metadata.JsonTypeInfoResolverWithAddedModifiers'.
```

If you hit the sibling error about [reflection-based serialization being disabled](/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/), that is a missing resolver, not a broken modifier.

## The real cost: you give up the generated fast path

Source generation has two modes. Metadata mode moves contract construction to compile time. Serialization-optimization mode additionally emits a hand-rolled writer that calls `Utf8JsonWriter` directly. Per the [source-generation modes documentation](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation-modes), the serializer falls back from that fast path whenever the options ask for something the generated writer cannot express, and a modified contract is exactly that.

Measured with BenchmarkDotNet 0.15.8 on .NET 10.0.5 (Intel Core Ultra 7 265KF, 20 cores), serializing the four-property `Order` above:

| Method | Mean | Ratio | Allocated | Alloc Ratio |
| --- | ---: | ---: | ---: | ---: |
| Source-gen, no modifier | 88.76 ns | 1.00 | 200 B | 1.00 |
| Source-gen + modifier | 136.83 ns | 1.54 | 496 B | 2.48 |
| Reflection resolver, no modifier | 136.23 ns | 1.53 | 512 B | 2.56 |
| Reflection resolver + modifier | 138.97 ns | 1.57 | 496 B | 2.48 |

Adding a modifier costs about 54% throughput and 2.5x allocations on this payload, landing source generation exactly where the reflection resolver already was. You keep the startup-time and trimming benefits of source generation, because contract construction still happens at compile time; you lose only the optimized writer. For most APIs that is a fine trade, but it is worth knowing before you attach a modifier to a hot serialization path and wonder why the numbers did not move.

## GenerationMode = Serialization makes your modifier a silent no-op

This is the failure mode that looks most like "modifiers do not work with source generation". If you pin a context to fast-path-only generation, there is no property metadata for the modifier to walk:

```csharp
// .NET 11, C# 14 - do not do this if you want a modifier
[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Serialization)]
[JsonSerializable(typeof(Order))]
public partial class FastPathOnlyContext : JsonSerializerContext { }
```

I printed the contract shape for all three generation modes:

```text
Default mode         Kind=Object Properties=4
Serialization only   Kind=Object Properties=0
Metadata only        Kind=Object Properties=4
```

With `Properties=0` the modifier is invoked once, iterates nothing, and returns. Serialization succeeds with the original, unredacted payload. Deserialization does not, and the message is at least explicit:

```text
InvalidOperationException: TypeInfoResolver
'System.Text.Json.Serialization.Metadata.JsonTypeInfoResolverWithAddedModifiers'
did not provide property metadata for type 'Order'.
```

The default generation mode emits both metadata and the fast path, which is what you want: the fast path is used when no modifier is attached, and the metadata path takes over when one is.

## Cache the options, and stop mutating after first use

Contracts are cached per `JsonSerializerOptions` instance, not globally. Serializing three times through one cached options object invoked my modifier 4 times total, once per type in the graph. Building a fresh `JsonSerializerOptions` inside the loop invoked it 12 times and rebuilt every contract:

```text
modifierCalls after 3 serializations (cached options)  = 4
modifierCalls after 3 serializations (fresh options)   = 12
```

Once an options instance has been used, both it and the contracts it produced are frozen. Assigning `WriteIndented` after the first serialize throws `InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization`, and reaching into `options.GetTypeInfo(...)` to edit `Properties` after the fact throws the `JsonTypeInfo` equivalent. All contract changes have to happen inside the modifier.

If you need to layer several resolvers rather than one decorated context, [`TypeInfoResolverChain`](/2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions/) accepts the decorated resolver just as well as the plain one, and the chain is queried in order until a contract comes back non-null. The same pattern covers a hierarchy that already uses [`JsonDerivedType` for polymorphism](/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), since the derived contracts go through the modifier like any other type.

The short version to keep in your head: decorate the resolver, never the context, match on `AttributeProvider` rather than `Name`, keep the generation mode at its default, and cache the options.

## Sources

- [Custom serialization and deserialization contracts](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts) on MS Learn
- [Source-generation modes in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation-modes) on MS Learn
- [dotnet/runtime discussion 121304: JSON contract modifiers and source generation](https://github.com/dotnet/runtime/discussions/121304)
- [`JsonTypeInfoResolver.WithAddedModifier` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsontypeinforesolver.withaddedmodifier), available from .NET 8 through .NET 11
