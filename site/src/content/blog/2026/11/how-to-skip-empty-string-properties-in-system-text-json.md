---
title: "How to skip empty string properties when serializing with System.Text.Json"
description: "System.Text.Json has no WhenWritingEmpty option, WhenWritingDefault still writes \"\", and a JsonConverter<string> that writes nothing produces invalid JSON. The fix is a type-info resolver modifier that sets JsonPropertyInfo.ShouldSerialize, for reflection and source-generated contexts, checked on .NET 10.0.10 and .NET 11 RC3."
pubDate: 2026-11-09
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "serialization"
---

**Short answer:** System.Text.Json in .NET 10 and .NET 11 has no built-in way to drop a string property when its value is `""`. `JsonIgnoreCondition` only knows `Never`, `Always`, `WhenWritingDefault`, `WhenWritingNull`, `WhenWriting` and `WhenReading`, and the default of `string` is `null`, not `""`. Add a contract modifier instead: walk `JsonTypeInfo.Properties`, and for every property whose `PropertyType` is `string`, set `ShouldSerialize = (_, value) => !string.IsNullOrEmpty((string?)value)`. Wire it up with `new DefaultJsonTypeInfoResolver().WithAddedModifier(...)` for reflection, or `MyContext.Default.WithAddedModifier(...)` for source generation. No wrapper property, no duplicate backing field, and the JSON stays valid.

Everything below was run as a console app on .NET 10.0.10 (SDK 10.0.302) and on .NET 11 RC3 (SDK 11.0.100-rc.3.26522.148), macOS arm64. Every line of output was identical on both runtimes, so the code applies to either.

## Why WhenWritingDefault and a custom converter both fail

The question comes up every few months on Stack Overflow, most recently as [How to suppress writing empty string value to JSON](https://stackoverflow.com/questions/79811736). The two things people try first both look reasonable and both fail, for different reasons.

Start with a plain DTO where the string properties are initialized to `""`, which is what most codebases do once nullable reference types are enabled:

```csharp
// .NET 10 / .NET 11, C# 14
public class Customer
{
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
    public string? Phone { get; set; }
    public string Notes { get; set; } = "";
    public int Count { get; set; }
}

var dto = new Customer { Name = "Ada", Email = "", Phone = null, Notes = "  ", Count = 0 };
```

The default serializer writes everything:

```text
{"Name":"Ada","Email":"","Phone":null,"Notes":"  ","Count":0}
```

### WhenWritingDefault compares against default(string), which is null

`DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingDefault` skips a property when its value equals `default(T)`. For `int` that is `0`, so `Count` disappears. For `string` it is `null`, so `Phone` disappears and `Email` stays:

```text
{"Name":"Ada","Email":"","Notes":"  "}
```

There is no `WhenWritingEmpty` member. Enumerating the enum on .NET 11 RC3 returns `Never, Always, WhenWritingDefault, WhenWritingNull, WhenWriting, WhenReading`, so nothing new landed for this in .NET 11 either.

### A JsonConverter runs after the property name is already written

The second instinct is a `JsonConverter<string>` that simply returns without writing when the value is empty:

```csharp
// .NET 10 / .NET 11 -- do NOT use this
public sealed class EmptyStringConverter : JsonConverter<string>
{
    public override string? Read(ref Utf8JsonReader reader, Type t, JsonSerializerOptions o)
        => reader.GetString();

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions o)
    {
        if (string.IsNullOrEmpty(value)) return; // name is already on the wire
        writer.WriteStringValue(value);
    }
}

public class WithConverter
{
    [JsonConverter(typeof(EmptyStringConverter))]
    public string A { get; set; } = "";
    public int B { get; set; }
}
```

Serializing `new WithConverter { A = "", B = 1 }` does not throw. It returns this:

```text
{"A":"B":1}
```

That is not JSON. The object converter writes the property name `"A"` before it calls your converter, and a value converter has no way to take that back. A converter decides *how* a value is written, never *whether* the property exists. The decision about whether a property is written lives one level up, in the property's contract, and that is where the fix goes. (If you want the full picture of what a converter can and cannot do, see [how to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).)

## Setting ShouldSerialize from a contract modifier

Since .NET 7, System.Text.Json exposes its serialization contract as `JsonTypeInfo` and `JsonPropertyInfo` objects that you can edit before the first serialization. `JsonPropertyInfo.ShouldSerialize` is a `Func<object, object?, bool>` that receives the declaring object and the property value and returns whether the property is written at all. Returning `false` skips both the name and the value.

1. Write a modifier, an `Action<JsonTypeInfo>`, that targets string properties and chains any condition already present:

```csharp
// .NET 10 / .NET 11, C# 14
using System.Text.Json.Serialization.Metadata;

public static class Modifiers
{
    public static void SkipEmptyStrings(JsonTypeInfo typeInfo)
    {
        if (typeInfo.Kind != JsonTypeInfoKind.Object) return;

        foreach (JsonPropertyInfo property in typeInfo.Properties)
        {
            if (property.PropertyType != typeof(string)) continue;

            Func<object, object?, bool>? existing = property.ShouldSerialize;
            property.ShouldSerialize = existing is null
                ? static (_, value) => !string.IsNullOrEmpty((string?)value)
                : (obj, value) => existing(obj, value) && !string.IsNullOrEmpty((string?)value);
        }
    }
}
```

2. Attach it to a resolver and put that resolver on the options:

```csharp
// .NET 10 / .NET 11
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver()
        .WithAddedModifier(Modifiers.SkipEmptyStrings)
};

Console.WriteLine(JsonSerializer.Serialize(dto, options));
```

3. Check the output. `Email` (empty) and `Phone` (null) are gone, `Notes` (whitespace) and `Count` (zero) are kept:

```text
{"Name":"Ada","Notes":"  ","Count":0}
```

`IsNullOrEmpty` drops nulls too, so you do not need `WhenWritingNull` on top. If you want `null` written but `""` skipped, test `value is not ""` instead.

`WithAddedModifier` is an extension method on `IJsonTypeInfoResolver` (added in .NET 8) that returns a new resolver wrapping the old one. The older collection-initializer form, `new DefaultJsonTypeInfoResolver { Modifiers = { ... } }`, does the same thing for the reflection resolver, but it does not exist on a source-generated context, so the extension method is the one to standardize on.

### Why the modifier chains instead of overwriting

The highest-voted answer on the Stack Overflow question sets `ShouldSerialize` unconditionally. That works in a toy program and leaks data in a real one, because `ShouldSerialize` is not only yours. Two things already populate it:

- `[JsonIgnore(Condition = ...)]` attributes. Inspecting the contract for a property marked `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` shows `ShouldSerialize` already set before any modifier runs; plain properties show `null`.
- Earlier modifiers in the chain.

Here is the second case, with a modifier that hides a `Secret` property and then the naive "skip empty" modifier added after it:

```csharp
// .NET 10 / .NET 11
public static void HideSecret(JsonTypeInfo typeInfo)
{
    foreach (var p in typeInfo.Properties)
        if (p.Name == "Secret") p.ShouldSerialize = static (_, _) => false;
}

public static void NaiveSkipEmpty(JsonTypeInfo typeInfo)
{
    foreach (var p in typeInfo.Properties)
        if (p.PropertyType == typeof(string))
            p.ShouldSerialize = (_, v) => v is string { Length: > 0 }; // overwrites
}

var resolver = new DefaultJsonTypeInfoResolver()
    .WithAddedModifier(HideSecret)
    .WithAddedModifier(NaiveSkipEmpty);
```

Serializing `new Flags { Tag = "", Secret = "hunter2" }`:

```text
naive:   {"Secret":"hunter2"}
chained: {}
```

The naive version replaced the "never write" rule with "write if non-empty", and the secret went out. The chained version from step 1 keeps the earlier predicate and only adds its own condition. Always read `ShouldSerialize` before you assign it.

## Doing the same with a source-generated JsonSerializerContext

With source generation you do not create a `DefaultJsonTypeInfoResolver`. You wrap the context instead:

```csharp
// .NET 10 / .NET 11
[JsonSerializable(typeof(Customer))]
public partial class AppJsonContext : JsonSerializerContext;

var options = new JsonSerializerOptions
{
    TypeInfoResolver = AppJsonContext.Default.WithAddedModifier(Modifiers.SkipEmptyStrings)
};

JsonSerializer.Serialize(dto, options);
// {"Name":"Ada","Notes":"  ","Count":0}
```

Same output as the reflection path. The trap is the overload you call. `JsonSerializer.Serialize(dto, AppJsonContext.Default.Customer)` uses the context's own `JsonTypeInfo`, which knows nothing about your modifier, and writes `"Email":""` again. You must pass the `options` (or `options.GetTypeInfo(typeof(Customer))`) so the wrapped resolver is the one producing the contract. A modifier also turns off the source generator's fast-path serializer for affected types, since the generated `Utf8JsonWriter` code cannot evaluate your delegate; the details and measurements are in [customizing source-generated System.Text.Json with a modifier](/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/).

## Opting in per property with an attribute

Skipping every empty string globally is sometimes too much. An API contract might require `"Label":""` to mean "explicitly cleared". A marker attribute plus `JsonPropertyInfo.AttributeProvider` makes it opt-in:

```csharp
// .NET 10 / .NET 11, C# 14
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Field)]
public sealed class JsonIgnoreWhenEmptyAttribute : Attribute;

public class Marked
{
    [JsonIgnoreWhenEmpty]
    public string Code { get; set; } = "";
    public string Label { get; set; } = "";
}

public static void SkipEmptyWhereMarked(JsonTypeInfo typeInfo)
{
    if (typeInfo.Kind != JsonTypeInfoKind.Object) return;

    foreach (var p in typeInfo.Properties)
    {
        bool marked = p.AttributeProvider?.IsDefined(typeof(JsonIgnoreWhenEmptyAttribute), inherit: true) == true;
        if (!marked || p.PropertyType != typeof(string)) continue;

        var existing = p.ShouldSerialize;
        p.ShouldSerialize = existing is null
            ? static (_, v) => !string.IsNullOrEmpty((string?)v)
            : (o, v) => existing(o, v) && !string.IsNullOrEmpty((string?)v);
    }
}
```

`new Marked { Code = "", Label = "" }` serializes to `{"Label":""}`. The same output came back when the modifier wrapped `AppJsonContext.Default` instead of the reflection resolver, so `AttributeProvider` is populated for source-generated properties on .NET 10 and .NET 11. On the reflection path it is the `PropertyInfo` or `FieldInfo` itself, which is why `IsDefined` works directly.

## Wiring it into ASP.NET Core minimal APIs and controllers

ASP.NET Core already sets a resolver on its `JsonSerializerOptions`, so wrap that one rather than replacing it, or you lose any context the framework or another library added:

```csharp
// .NET 10, ASP.NET Core 10 minimal API
using System.Text.Json.Serialization.Metadata;

builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.TypeInfoResolver =
        (o.SerializerOptions.TypeInfoResolver ?? new DefaultJsonTypeInfoResolver())
        .WithAddedModifier(Modifiers.SkipEmptyStrings);
});

app.MapGet("/c", () => new Customer { Name = "Ada", Email = "" });
```

Logging the incoming resolver inside that callback on ASP.NET Core 10 printed `DefaultJsonTypeInfoResolver`, and `curl http://127.0.0.1:5187/c` returned `{"name":"Ada"}` (camelCase from the web defaults, `email` omitted). For MVC controllers, the same assignment goes in `AddControllers().AddJsonOptions(o => ...)` on `o.JsonSerializerOptions` (only the minimal API path was run for this post). If you prefer a single place to compose resolvers, `TypeInfoResolverChain` works too; [modifying an existing type-info resolver](/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/) covers the options.

## Gotchas found while testing

### Missing on the wire means "use the initializer" on the way back

Skipping a property on write does not make deserialization produce `""` by magic; it makes the deserializer not touch that property at all. For `Customer`, the round trip gives `Email == ""` only because the property initializer says `= ""`. Without the initializer, the value comes back as `null`. If a consumer in another language reads your JSON, it sees a missing key, not an empty string. Make sure the contract you publish says the two are equivalent.

### Required properties break the round trip

A `required string Sku` that is empty gets skipped like any other string, and deserializing that same JSON fails:

```text
JsonException: JSON deserialization for type 'Req' was missing required properties including: 'Sku'.
```

Exclude required properties from the modifier with `if (property.IsRequired) continue;`, or decide that an empty required value is a bug and validate it before serializing. The interaction between `required` and the contract API is covered in depth in [making System.Text.Json ignore a required property](/2026/08/how-to-make-system-text-json-ignore-a-property-with-the-required-modifier/).

### ShouldSerialize only applies to declared properties

`ShouldSerialize` is per `JsonPropertyInfo`, so a few things fall outside it:

- **Dictionary entries.** `new Dictionary<string, string> { ["a"] = "", ["b"] = "x" }` still serializes as `{"a":"","b":"x"}`. Dictionaries are `JsonTypeInfoKind.Dictionary`, they have no properties, and the `Kind` check in the modifier skips them on purpose. Filter the dictionary before serializing.
- **`object`-typed properties.** `public object? Value { get; set; }` holding `""` is written as `{"Value":""}`, because `PropertyType` is `object`. Loosen the check to `property.PropertyType == typeof(object)` and test `value is ""` if you need it.
- **Public fields** work as long as `IncludeFields = true`; a `public string F = ""` field was skipped the same way as a property.

### Whitespace and empty collections are separate decisions

`IsNullOrEmpty` treats `"  "` as content. Swap in `IsNullOrWhiteSpace` if blank strings should go too, which produced `{"Name":"Ada","Count":0}` for the sample. The same modifier shape handles empty collections:

```csharp
// .NET 10 / .NET 11
else if (typeof(System.Collections.ICollection).IsAssignableFrom(property.PropertyType))
    property.ShouldSerialize = static (_, v) => v is System.Collections.ICollection { Count: > 0 };
```

A `List<int>` and a `string[]`, both empty, plus an empty `Name`, serialized to `{}`. If you do this, remember that a property typed as a lazily evaluated `IEnumerable<T>` is not an `ICollection`, so it is never matched; checking it would mean enumerating it, which you do not want inside a serializer callback.

### Options are frozen after first use

Assigning `TypeInfoResolver` on an options instance that has already serialized something throws:

```text
InvalidOperationException: This JsonSerializerOptions instance is read-only or has already been used in serialization or deserialization.
```

Build the resolver chain once, at startup, and cache the options. Creating a new `JsonSerializerOptions` per call also throws away the contract cache, which is the expensive part of System.Text.Json.

### Coming from Newtonsoft.Json

Newtonsoft supports a `public bool ShouldSerializeEmail()` method convention and `DefaultValueHandling.Ignore` combined with `[DefaultValue("")]`. System.Text.Json honors neither: the method is ignored and `[DefaultValue]` is not consulted by `WhenWritingDefault`. The modifier above is the replacement for both. If you are porting a codebase that relied on those conventions, add this modifier to the list of behaviors to restore, alongside the others in [migrating from Newtonsoft.Json to System.Text.Json in a large codebase](/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/).

## The duplicate backing property is no longer necessary

The accepted Stack Overflow answer gives up and adds a private `string?` field marked `[JsonInclude]`, `[JsonPropertyName("StringProp")]` and `[JsonIgnore(Condition = WhenWritingNull)]`, with the public property `[JsonIgnore]`d and normalizing `""` to `null`. It works, but it has to be repeated for every property, it changes the getter semantics, and it hides the rule in the model instead of the serializer configuration. A ten-line modifier applied once to the options covers every type, works with source generation, and composes with whatever ignore conditions are already in place, as long as it chains rather than overwrites.

## Sources

- [Customize a JSON contract](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts) on Microsoft Learn, including the conditional serialization example.
- [`JsonPropertyInfo.ShouldSerialize`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.shouldserialize) and [`JsonPropertyInfo.AttributeProvider`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.attributeprovider) API reference.
- [`JsonTypeInfoResolver.WithAddedModifier`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsontypeinforesolver.withaddedmodifier) API reference.
- [`JsonIgnoreCondition`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonignorecondition) enum reference.
- Stack Overflow: [How to suppress writing empty string value to JSON](https://stackoverflow.com/questions/79811736) and the related [DefaultValue question](https://stackoverflow.com/questions/79816966).
