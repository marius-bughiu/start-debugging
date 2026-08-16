---
title: "How to make System.Text.Json ignore a property that has the required modifier"
description: "[JsonIgnore] on a required member throws InvalidOperationException: marked required but does not specify a setter. Here is why the two features collide and the four ways to ignore the property anyway, measured on .NET 10."
pubDate: 2026-08-16
tags:
  - "system-text-json"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "serialization"
  - "json"
---

Short answer: you cannot put `[JsonIgnore]` on a member that has the C# `required` modifier. The moment System.Text.Json builds the contract for that type it throws `InvalidOperationException: JsonPropertyInfo 'InternalId' defined in type 'Ignored' is marked required but does not specify a setter`, on serialization as well as deserialization. There are four working alternatives, and which one you want depends on whether "ignore" means *stop writing it to JSON* or *stop demanding it from the JSON*. If you own the type, put `[SetsRequiredMembers]` on a constructor and keep the `[JsonIgnore]`. If you do not own the type, clear `JsonPropertyInfo.IsRequired` in a `DefaultJsonTypeInfoResolver` modifier.

Everything below was measured on the .NET 10.0.201 SDK against runtime 10.0.5 with C# 14. System.Text.Json has honoured the `required` modifier since .NET 7 and the contract-model APIs used here have been stable since .NET 7, so the behaviour applies to .NET 7 and later unless a section says otherwise. The one exception is `RespectRequiredConstructorParameters`, which arrived in .NET 9.

## Why required and JsonIgnore cannot coexist

The two features look orthogonal. `required` is a C# 11 language feature that forces callers to assign a member in an object initializer, and `[JsonIgnore]` is a serializer instruction. They collide because System.Text.Json reads the `required` modifier and turns it into a piece of serialization metadata.

Per the [required properties documentation](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties), the C# `required` modifier and `[JsonRequired]` "are equivalent, and both map to the same piece of metadata", namely `JsonPropertyInfo.IsRequired`. So `required` is not just a compiler contract, it is a deserialization contract: the property must appear in the payload.

`[JsonIgnore]` works differently. It does not remove the property from the contract. It keeps the `JsonPropertyInfo` and strips its accessors. You can watch this happen by hanging a modifier off the resolver and printing the contract:

```csharp
// .NET 10.0.5, C# 14
var probe = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                if (typeInfo.Type != typeof(Ignored)) return;
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                    Console.WriteLine($"{p.Name}: IsRequired={p.IsRequired} hasSet={p.Set is not null} hasGet={p.Get is not null}");
            }
        }
    }
};

JsonSerializer.Deserialize<Ignored>("""{"Name":"a"}""", probe);

public class Ignored
{
    public required string Name { get; set; }
    [JsonIgnore] public required string InternalId { get; set; }
}
```

The modifier runs before validation, so it prints before the exception:

```text
Name: IsRequired=True hasSet=True hasGet=True
InternalId: IsRequired=True hasSet=False hasGet=False
InvalidOperationException: JsonPropertyInfo 'InternalId' defined in type 'Ignored' is marked required but does not specify a setter.
```

There it is. `InternalId` is still in the contract, still flagged `IsRequired=True`, but `[JsonIgnore]` nulled out both accessors. The serializer is now holding a property it must populate from the payload and has no way to populate. It refuses to build the contract at all, which is why the exception message talks about a missing setter when your source code clearly has one.

Two consequences of that being a *contract validation* failure rather than a deserialization failure:

- It throws on serialization too. `JsonSerializer.Serialize(new Ignored { Name = "a", InternalId = "x" })` fails with the identical `InvalidOperationException`, even though writing JSON never needs a setter.
- It is a runtime failure, not a compile-time one. Nothing warns you. The code ships and then throws the first time that type is touched.

The same thing happens with `[JsonRequired]` in place of the `required` keyword, and with `required` fields once `IncludeFields` is on. It is the `IsRequired` flag that matters, not how you set it.

## The minimal repro

```csharp
// .NET 10.0.5, C# 14
using System.Text.Json;
using System.Text.Json.Serialization;

var order = new Order { Id = 7, InternalAuditToken = "tok_abc" };

// Throws InvalidOperationException, not a JsonException.
string json = JsonSerializer.Serialize(order);

public class Order
{
    public required int Id { get; set; }

    [JsonIgnore]
    public required string InternalAuditToken { get; set; }
}
```

The intent is obvious and reasonable: `InternalAuditToken` must always be set by your own code (that is what `required` is for), and must never cross the wire (that is what `[JsonIgnore]` is for). System.Text.Json just has no way to express both at once through attributes alone.

## Marking a constructor with SetsRequiredMembers

This is the fix to reach for when you own the type. `System.Diagnostics.CodeAnalysis.SetsRequiredMembersAttribute` tells the compiler that a given constructor assigns every required member, so callers no longer have to. System.Text.Json understands that attribute too, and when it is present it stops treating the members as required.

```csharp
// .NET 10.0.5, C# 14
using System.Diagnostics.CodeAnalysis;

public class Order
{
    [SetsRequiredMembers]
    public Order()
    {
        Id = 0;
        InternalAuditToken = TokenFactory.NewToken();
    }

    public required int Id { get; set; }

    [JsonIgnore]
    public required string InternalAuditToken { get; set; }
}
```

Both directions now work. `JsonSerializer.Deserialize<Order>("""{"Id":7}""")` returns an instance whose `InternalAuditToken` holds whatever the constructor produced, and serialization emits `{"Id":7}` with no token in sight.

The mechanism is worth understanding, because it explains the blast radius. Printing the contract for a type with and without the attribute shows what changes:

```text
[without SetsRequiredMembers]
  Name: IsRequired=True  set=True
  InternalId: IsRequired=True  set=True

[with SetsRequiredMembers]
  Name: IsRequired=False set=True
  InternalId: IsRequired=False set=True
```

`[SetsRequiredMembers]` clears `IsRequired` for **every** member of the type, not just the ignored one. If you were relying on `required` to reject payloads that omit `Id`, that enforcement is now gone along with the error you were trying to fix. Put `[JsonRequired]` back on the members you still want enforced on the wire:

```csharp
// .NET 10.0.5, C# 14
public class Order
{
    [SetsRequiredMembers]
    public Order() { Id = 0; InternalAuditToken = TokenFactory.NewToken(); }

    [JsonRequired]                       // keeps the payload requirement
    public required int Id { get; set; }

    [JsonIgnore]                         // no longer required by the serializer
    public required string InternalAuditToken { get; set; }
}
```

That combination gives you exactly the original intent: the C# compiler still forces your own code to set both members, the JSON contract still rejects a payload without `Id`, and the token never appears in the JSON.

## Clearing IsRequired with a resolver modifier

When the type comes from a package you do not control, or you want the rule applied across many types at once, edit the contract instead of the type. A `DefaultJsonTypeInfoResolver` modifier runs after the default contract is built and before it is validated, so it can flip `IsRequired` off in time.

The general sledgehammer, straight out of the Microsoft Learn sample, strips the constraint everywhere:

```csharp
// .NET 10.0.5, C# 14
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                if (typeInfo.Kind != JsonTypeInfoKind.Object) return;
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                    p.IsRequired = false;
            }
        }
    }
};
```

That is usually too broad. A targeted version keys off your own marker attribute, so the policy lives next to the property it describes and applies to every type in the model:

```csharp
// .NET 10.0.5, C# 14
[AttributeUsage(AttributeTargets.Property)]
public sealed class ServerOwnedAttribute : Attribute;

public class Order
{
    public required int Id { get; set; }

    [ServerOwned]
    public required string? InternalAuditToken { get; set; }
}

var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            static typeInfo =>
            {
                foreach (JsonPropertyInfo p in typeInfo.Properties)
                {
                    if (p.AttributeProvider?.IsDefined(typeof(ServerOwnedAttribute), inherit: true) != true)
                        continue;

                    p.IsRequired = false;                        // stop demanding it on read
                    p.ShouldSerialize = static (_, _) => false;  // stop emitting it on write
                }
            }
        }
    }
};
```

Measured results with those options: `Deserialize<Order>("""{"Id":7}""")` succeeds with the token left null, and `Serialize(new Order { Id = 7, InternalAuditToken = "secret" })` emits `{"Id":7}`. Note that there is no `[JsonIgnore]` on the property here. `ShouldSerialize` is what suppresses the write, and unlike `[JsonIgnore]` it does not strip the accessors, so no validation error.

If you would rather the property vanish from the contract entirely, remove it instead of reconfiguring it. `typeInfo.Properties` is a mutable list:

```csharp
// .NET 10.0.5, C# 14
for (int i = typeInfo.Properties.Count - 1; i >= 0; i--)
    if (typeInfo.Properties[i].Name == "InternalAuditToken")
        typeInfo.Properties.RemoveAt(i);
```

That also works in both directions, and it is the closest thing to what people expect `[JsonIgnore]` to do. Remember that `Name` here is the JSON name, so it reflects any naming policy or `[JsonPropertyName]` already applied. If you are attaching this to options that already have a resolver, the mechanics of [modifying an existing type info resolver](/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/) are worth a read first, and the same modifier hook works for [source-generated contracts](/2026/08/how-to-customize-source-generated-system-text-json-serialization-with-a-modifier/).

## Ignoring on write only, which is what many people actually want

Half the time the requirement is asymmetric: the property must be present when reading a payload, but should not be echoed back when writing one. Password hashes, audit tokens, and internal identifiers usually fall here. That case has a first-class answer and no conflict with `required`, because conditional ignore does not strip the accessors:

```csharp
// .NET 10.0.5, C# 14
public class Order
{
    public required int Id { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public required string? InternalAuditToken { get; set; }
}
```

Measured: `Serialize(new Order { Id = 7, InternalAuditToken = null })` emits `{"Id":7}`, while `Deserialize<Order>("""{"Id":7}""")` still throws `JsonException: JSON deserialization for type 'Order' was missing required properties including: 'InternalAuditToken'`. Both halves are intact. `JsonIgnoreCondition.WhenWritingDefault` behaves the same way for value types. Only the bare `[JsonIgnore]`, which means `JsonIgnoreCondition.Always`, breaks.

The fourth option, and often the right one on a public API surface, is to stop making one type do two jobs. A separate wire DTO with no `required` members, mapped to and from your domain type, sidesteps the whole problem and gives you somewhere to put versioning concerns later. It costs a mapping method and buys you a contract you can change without touching your domain model.

## Gotchas worth knowing before you pick

**An explicit `null` satisfies `required`.** `Deserialize<Order>("""{"Id":7,"InternalAuditToken":null}""")` succeeds. `required` means the key is present, not that the value is meaningful. If you need non-null, that is a validation concern, not a serialization one.

**A property initializer does not satisfy it either.** `public required string InternalId { get; set; } = "fallback";` still throws `JsonException` when the key is missing from the payload. The default is applied and then the serializer rejects the payload anyway.

**The error message uses the JSON name.** With `[JsonPropertyName("internal_id")]` on a required property, the missing-property exception reads `missing required properties including: 'internal_id'`, not the CLR member name. Handy when a naming policy is involved and you are grepping for the wrong string.

**Required fields are only enforced when `IncludeFields` is on.** A `public required string InternalId;` field is invisible to System.Text.Json by default, so a payload that omits it deserializes cleanly. Flip `IncludeFields = true` and the same type starts throwing. If you turn that option on across an existing codebase, expect this to surface.

**You cannot hide the member behind a private setter.** `public required string InternalId { get; private set; }` does not compile: the C# compiler rejects it with `CS9032: Required member 'X' cannot be less visible or have a setter less visible than the containing type`. That closes an escape hatch people reach for, and it is a cousin of the [CS9035 error you get when an object initializer misses a required member](/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/).

**Source generation behaves identically.** Deserializing through a `JsonSerializerContext` produces the exact same `InvalidOperationException` for `[JsonIgnore]` plus `required`, and the same `JsonException` for a missing required property. Inspecting the generated code with `EmitCompilerGeneratedFiles` shows why: it emits `properties[0].IsRequired = true;` directly. Worth flagging because the Microsoft Learn page still advises using `[JsonRequired]` instead of `required` in source-generation mode on the grounds that "your code won't compile" with the keyword. On .NET 10 it compiles and works; `[SetsRequiredMembers]` also works through a generated context. If you are on an older SDK, verify before relying on it.

**`RespectRequiredConstructorParameters` is a different knob.** Introduced in .NET 9, it makes non-optional *constructor parameters* required in the payload. It has nothing to do with the `required` modifier on members, and turning it off will not rescue you here. Verified: with a `Order(string name, string internalId)` constructor and no options, `Deserialize<Order>("""{"Name":"a"}""")` succeeds and leaves the parameter at its default; with `RespectRequiredConstructorParameters = true` the same call throws `JsonException`. If your problem is a missing constructor argument rather than a missing member, that is the flag to look at.

If the real goal is to reject payloads carrying fields you did not model, that is the mirror-image problem and it has its own switch: see [handling missing and unmapped members during deserialization](/2023/09/net-8-handle-missing-members-during-json-deserialization/). And when the property needs to be ignored only in some shapes of a hierarchy, a [custom JsonConverter](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) gives you full control over what gets written, at the cost of maintaining the read and write paths by hand.

My default recommendation: if you own the type, `[SetsRequiredMembers]` on a constructor plus `[JsonRequired]` on the members you still want enforced. It is three lines, it keeps the compiler-level guarantee that made you write `required` in the first place, and it needs no custom options object threaded through your application.

## Sources

- [Require properties for deserialization](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties) on Microsoft Learn, for the equivalence of `required`, `[JsonRequired]`, and `JsonPropertyInfo.IsRequired`, and for the `RespectRequiredConstructorParameters` feature switch.
- [How to ignore properties with System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/ignore-properties) for the full `JsonIgnoreCondition` list and the `DefaultIgnoreCondition` global setting.
- [JsonPropertyInfo.IsRequired](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.isrequired) and [JsonPropertyInfo.ShouldSerialize](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.metadata.jsonpropertyinfo.shouldserialize) API reference.
- [SetsRequiredMembersAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.setsrequiredmembersattribute) API reference.
- [The required modifier](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/required) in the C# language reference, including the CS9032 visibility rule.
