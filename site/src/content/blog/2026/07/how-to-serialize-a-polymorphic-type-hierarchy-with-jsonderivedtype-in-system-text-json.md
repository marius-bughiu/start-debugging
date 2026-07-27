---
title: "How to serialize a polymorphic type hierarchy with JsonDerivedType in System.Text.Json"
description: "A complete guide to polymorphic JSON in .NET 11: JsonDerivedType and JsonPolymorphic, why the declared type decides everything, the $type ordering rule, every exception the feature throws, the contract model for types you do not own, and what ASP.NET Core emits in OpenAPI."
pubDate: 2026-07-27
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "serialization"
---

To round-trip a class hierarchy through `System.Text.Json`, put `[JsonDerivedType(typeof(Derived), "discriminator")]` on the base type for every subtype you want to support, then serialize and deserialize through the **base** type. The serializer writes a `$type` property as the first member of the object and reads it back to pick the right subtype. Without a discriminator string, serialization still emits derived properties but deserialization always materializes the base type. This has worked the same way since .NET 7 and everything below targets .NET 11 (`net11.0`, C# 14), with the two later additions called out where they matter: `AllowOutOfOrderMetadataProperties` (.NET 9) and `JsonSerializerOptions.Strict` (.NET 10).

## Why the naive version silently loses data

The reason people go looking for this feature is that the obvious code does the wrong thing quietly. Take a payment hierarchy:

```csharp
// .NET 11, C# 14
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}

public class CardPayment : PaymentMethod
{
    public string Last4 { get; set; } = "";
}
```

Serialize a `CardPayment` through a variable declared as `PaymentMethod` with no attributes at all and you get `{"Amount":10}`. The `Last4` property vanishes. `System.Text.Json` resolves the contract from the **declared** type, not the runtime type, so it only knows about members of `PaymentMethod`. This is deliberate: it prevents a derived type from leaking properties the caller never agreed to expose, which is a real security consideration for API responses.

Adding a single attribute changes the contract:

```csharp
// .NET 11, C# 14
[JsonDerivedType(typeof(CardPayment))]
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}
```

Now `JsonSerializer.Serialize<PaymentMethod>(card)` produces `{"Last4":"4242","Amount":10}`. Serialization is fixed, deserialization is not. Reading that payload back as `PaymentMethod` throws `NotSupportedException: Deserialization of interface or abstract types is not supported. Type 'PaymentMethod'.`, because there is nothing in the JSON that says which subtype to build. If the base type is concrete rather than abstract, the failure is quieter and worse: you get a `PaymentMethod` instance and `Last4` is dropped on the floor. The discriminator is what closes the loop.

## Five steps to a round-trippable hierarchy

1. **Make the base type polymorphic-capable.** It must be a non-sealed class, an abstract class, or an interface. Structs, sealed types, generic types, and `System.Object` are rejected with `InvalidOperationException: Specified type 'X' does not support polymorphism. Polymorphic types cannot be structs, sealed types, generic types or System.Object.`

2. **Declare every subtype with a discriminator.** The second argument to `[JsonDerivedType]` is the discriminator value, and it is what makes deserialization work.

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization;

[JsonDerivedType(typeof(CardPayment), "card")]
[JsonDerivedType(typeof(PaypalPayment), "paypal")]
public abstract class PaymentMethod
{
    public decimal Amount { get; set; }
}

public class CardPayment : PaymentMethod
{
    public string Last4 { get; set; } = "";
}

public class PaypalPayment : PaymentMethod
{
    public string Email { get; set; } = "";
}
```

3. **Serialize through the base type.** The declared type at the call site has to be the polymorphic base, either as the generic argument, the property type, or the collection element type.

```csharp
// .NET 11, C# 14
PaymentMethod payment = new CardPayment { Amount = 10, Last4 = "4242" };

string json = JsonSerializer.Serialize(payment);
// {"$type":"card","Last4":"4242","Amount":10}
```

Note the ordering. `$type` is always written first, ahead of the derived type's own properties, and the base type's properties come last. That is not cosmetic, as the next section explains.

4. **Deserialize through the base type.** The reader looks at `$type`, finds `CardPayment`, and builds it:

```csharp
// .NET 11, C# 14
PaymentMethod? back = JsonSerializer.Deserialize<PaymentMethod>(json);
Console.WriteLine(back is CardPayment); // True
```

5. **Rename the discriminator if `$type` collides with your wire format.** `[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]` on the base type changes the property name. Two things to know: `$id`, `$ref`, and `$values` are reserved and rejected, and the custom name is **not** run through the naming policy. Under `JsonSerializerOptions.Web`, a discriminator declared as `"Kind"` stays `"Kind"` while every other property is camel-cased. Pick the exact casing you want on the wire.

Discriminator values can also be integers: `[JsonDerivedType(typeof(ClickEvent), 1)]` emits `{"$type":1,...}`. Mixing `string` and `int` ids in one hierarchy compiles and runs, but it makes the payload harder to consume from non-.NET clients. Pick one form.

## The declared type decides, everywhere

Most bug reports about "the discriminator is missing" come down to a call site where the declared type is the derived class. The rule is mechanical, and it is worth internalizing as a table. All of these were run against the same hierarchy above:

| Call site | Output |
| --- | --- |
| `Serialize<PaymentMethod>(card)` | `{"$type":"card","Last4":"4242","Amount":10}` |
| `Serialize<CardPayment>(card)` | `{"Last4":"4242","Amount":10}` |
| `Serialize(card)` where `card` is typed `CardPayment` | `{"Last4":"4242","Amount":10}` |
| `Serialize<object>(card)` | `{"$type":"card","Last4":"4242","Amount":10}` |
| `List<PaymentMethod>` element | `[{"$type":"card",...}]` |
| Property declared as `PaymentMethod` | `{"Method":{"$type":"card",...}}` |
| Property declared as `CardPayment` | `{"Concrete":{"Last4":"9","Amount":3}}` |

The `object` row surprises people. `System.Object` cannot itself be a polymorphic base, but when the declared type is `object` the serializer resolves the runtime type and then applies the polymorphic configuration of that type's nearest configured ancestor. So `Serialize<object>(card)` does emit the discriminator, and `Serialize<object>(someUndeclaredSubtype)` throws exactly like the base-typed call would. Deserializing into `object` is not symmetric: you get a `JsonElement` back, not a `CardPayment`.

In ASP.NET Core the declared type is the endpoint's return type, which means the same table applies to minimal APIs:

```csharp
// .NET 11, C# 14
app.MapGet("/payments/latest", () => (PaymentMethod)card);      // {"$type":"card","last4":"4242","amount":10}
app.MapGet("/payments/card",   () => card);                     // {"last4":"4242","amount":10}
app.MapGet("/typed",  () => TypedResults.Ok((PaymentMethod)card)); // discriminator present
app.MapGet("/typed2", () => TypedResults.Ok(card));             // discriminator absent
```

`TypedResults.Ok(card)` infers `Ok<CardPayment>`, and that generic argument is the declared type all the way down to `WriteAsJsonAsync`. If an endpoint needs to return a hierarchy, type the lambda's return value as the base, or use an explicit `Results<T1, T2>` union so the shape is visible to both the serializer and the OpenAPI generator. Returning the base type is also what the [typed results union guide](/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) recommends for anything a client has to branch on.

## The `$type` property must come first

By default the discriminator has to be at the start of the JSON object, grouped with the other metadata properties `$id` and `$ref`. This payload deserializes:

```json
{"$type":"card","Amount":10,"Last4":"4242"}
```

This one throws `NotSupportedException: The JSON payload for polymorphic interface or abstract type 'PaymentMethod' must specify a type discriminator.`:

```json
{"Amount":10,"$type":"card","Last4":"4242"}
```

The reason is streaming. Reading in a single forward pass means the reader must know the target type before it starts binding members. The exception message is misleading if you skim it, because the discriminator *is* in the payload, just too late.

Since .NET 9 there is an opt-in:

```csharp
// .NET 11, C# 14, requires .NET 9 or later
var options = new JsonSerializerOptions { AllowOutOfOrderMetadataProperties = true };
var back = JsonSerializer.Deserialize<PaymentMethod>(json, options); // works
```

The cost is real, so do not turn it on globally without thinking. With the flag set, the deserializer can no longer process properties in one pass, so it buffers the entire JSON object in memory before binding. On a 200 byte event that is free. On a multi-megabyte document streamed from blob storage it is an out-of-memory risk. If the payload comes from a system you control, fix the writer instead. The common source of out-of-order discriminators is a database round-trip: PostgreSQL `jsonb` columns normalize key order, so a document written correctly can come back with `$type` in the middle.

## Every exception this feature throws

These are the exact runtime messages, which makes them searchable and makes triage fast.

| Message | Cause | Fix |
| --- | --- | --- |
| `Specified type 'X' does not support polymorphism. Polymorphic types cannot be structs, sealed types, generic types or System.Object.` | `[JsonDerivedType]` on a struct, a sealed class, or an open generic | Unseal the base, or introduce a non-generic base or interface |
| `Runtime type 'X' is not supported by polymorphic type 'Y'.` | Serializing a subtype that was never declared | Add `[JsonDerivedType(typeof(X), "...")]`, or set `UnknownDerivedTypeHandling` |
| `The JSON payload for polymorphic interface or abstract type 'X' must specify a type discriminator.` | Discriminator missing, or not the first property | Emit `$type` first, or set `AllowOutOfOrderMetadataProperties` |
| `Read unrecognized type discriminator id 'x'.` | Payload names a subtype you did not declare | Declare it, or set `IgnoreUnrecognizedTypeDiscriminators = true` |
| `The polymorphic type 'X' has already specified a type discriminator 'y'.` | Two `[JsonDerivedType]` attributes share an id | Make discriminator ids unique per hierarchy |
| `The type 'X' contains property '$type' that conflicts with an existing metadata property name.` | A real property serializes under the discriminator name | Rename the property, `[JsonIgnore]` it, or rename the discriminator |
| `Runtime type 'X' has a diamond ambiguity between derived types 'A' and 'B'.` | `FallBackToNearestAncestor` with two equally near ancestors | Declare `X` explicitly so no fallback is needed |
| `Deserialization of interface or abstract types is not supported. Type 'X'.` | Abstract base with no discriminators declared at all | Give every `[JsonDerivedType]` a discriminator id |

The unrecognized-discriminator case throws `JsonException`; the rest throw `NotSupportedException` or `InvalidOperationException`. That distinction matters if you catch serialization failures to return a 400: `JsonException` is the "bad input" bucket, `NotSupportedException` here almost always means a configuration bug on your side.

## Handling subtypes you did not declare

By default an undeclared subtype is a hard error on write, which is the right default: silently degrading to the base contract is how properties disappear from production payloads. When you do want a softer failure mode, `[JsonPolymorphic]` exposes the switch:

```csharp
// .NET 11, C# 14
[JsonPolymorphic(
    UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType,
    IgnoreUnrecognizedTypeDiscriminators = true)]
[JsonDerivedType(typeof(LeafNode), "leaf")]
public class Node
{
    public string Label { get; set; } = "";
}

public class DeepNode : Node { public int Depth { get; set; } }
```

With that configuration, serializing a `DeepNode` as `Node` writes `{"Label":"x"}` instead of throwing, and reading `{"$type":"unknown","Label":"x"}` produces a plain `Node`. Both settings only make sense when the base type is concrete and constructible. `IgnoreUnrecognizedTypeDiscriminators` on an abstract base just moves the failure one step later, since there is still nothing to instantiate.

The third option, `JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor`, walks up to the closest declared ancestor. It is useful for interface hierarchies where implementations are added by other teams, and it is the only setting that can produce the diamond ambiguity error: if a type implements two interfaces that are both declared derived types of the root, the serializer refuses to guess.

## Configuration is not inherited down the hierarchy

This one costs people an afternoon. Polymorphic configuration on a base type does not cascade through intermediate types:

```csharp
// .NET 11, C# 14
[JsonDerivedType(typeof(Middle), "middle")]
public abstract class Root { }

[JsonDerivedType(typeof(Leaf), "leaf")]
public class Middle : Root { }

public class Leaf : Middle { }

JsonSerializer.Serialize<Root>(new Leaf());
// NotSupportedException: Runtime type 'Leaf' is not supported by polymorphic type 'Root'.
```

`Middle` knows about `Leaf`, but `Root` does not, and the serializer does not compose the two configurations. Every polymorphic base has to enumerate every concrete type that can appear under it, including grandchildren. Declaring `Leaf` on both `Root` and `Middle` works, and each level can use its own discriminator id, since the id is resolved against whichever base type the call site declared.

## When you cannot annotate the base type

Attributes are out of reach for types in a NuGet package, a generated client, or a shared contracts assembly you are not allowed to touch. The contract model handles this: subclass `DefaultJsonTypeInfoResolver` and attach `PolymorphismOptions` to the base type's `JsonTypeInfo`.

```csharp
// .NET 11, C# 14
using System.Text.Json.Serialization.Metadata;

public class PaymentResolver : DefaultJsonTypeInfoResolver
{
    public override JsonTypeInfo GetTypeInfo(Type type, JsonSerializerOptions options)
    {
        JsonTypeInfo info = base.GetTypeInfo(type, options);

        if (info.Type == typeof(PaymentMethod))
        {
            info.PolymorphismOptions = new JsonPolymorphismOptions
            {
                TypeDiscriminatorPropertyName = "kind",
                IgnoreUnrecognizedTypeDiscriminators = true,
                UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FailSerialization,
                DerivedTypes =
                {
                    new JsonDerivedType(typeof(CardPayment), "card"),
                    new JsonDerivedType(typeof(PaypalPayment), "paypal")
                }
            };
        }

        return info;
    }
}

var options = new JsonSerializerOptions { TypeInfoResolver = new PaymentResolver() };
```

The resolver runs once per type and the result is cached on the options instance, so the reflection cost is paid at startup, not per call. This is also the escape hatch when the discriminator has to vary by endpoint or tenant: build two options instances with two resolvers rather than trying to mutate one. Options become read-only after the first serialize call, which is the same constraint described in the [custom JsonConverter guide](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

## Source generation and Native AOT

Polymorphism works under the source generator, but only in metadata mode. The fast path (`JsonSourceGenerationMode.Serialization`) emits hardcoded `Utf8JsonWriter` calls for a known shape and has nowhere to branch on a runtime type, so it fails with `InvalidOperationException: TypeInfoResolver 'MyContext' did not provide property metadata for type 'CardPayment'.`

```csharp
// .NET 11, C# 14
[JsonSerializable(typeof(PaymentMethod))]
[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Metadata)]
public partial class PaymentContext : JsonSerializerContext { }

string json = JsonSerializer.Serialize(payment, PaymentContext.Default.PaymentMethod);
// {"$type":"card","Last4":"4242","Amount":10}
```

Registering the base type is enough; the generator follows `[JsonDerivedType]` and emits metadata for each declared subtype. That is what makes the pattern trim-safe and AOT-safe, and it is why polymorphism is one of the few reflection-shaped features that survives publishing with [Native AOT and minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). What does not survive is any subtype that only exists at runtime, for example one built by a mocking library or emitted dynamically.

## What ASP.NET Core puts in the OpenAPI document

The built-in `Microsoft.AspNetCore.OpenApi` generator reads the same attributes, so a polymorphic response type documents itself. For the payment hierarchy above, the generated schema is:

```json
{
  "PaymentMethod": {
    "required": [ "$type" ],
    "type": "object",
    "anyOf": [
      { "$ref": "#/components/schemas/PaymentMethodCardPayment" },
      { "$ref": "#/components/schemas/PaymentMethodPaypalPayment" }
    ],
    "discriminator": {
      "propertyName": "$type",
      "mapping": {
        "card": "#/components/schemas/PaymentMethodCardPayment",
        "paypal": "#/components/schemas/PaymentMethodPaypalPayment"
      }
    }
  }
}
```

Each derived schema gets a `$type` property typed as a single-value enum, which is what lets client generators produce a tagged union. One caveat from the docs is worth repeating: the `discriminator` keyword only appears when the base type is **abstract**. A concrete base cannot mark `$type` as required in OpenAPI terms, because instances of the base itself have no discriminator, so the generator drops the discriminator object. If the document is a deliverable, make the base abstract. If you need to reshape any of this, that happens in a schema transformer, covered in the [OpenAPI transformers guide](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Smaller things that bite

- **Records work, including positional ones.** `[JsonDerivedType(typeof(TextMessage), "text")]` on an abstract record round-trips `TextMessage(string Body)` without extra ceremony, because the discriminator is read before the constructor arguments are bound.
- **Closed generic subtypes are legal.** The base cannot be generic, but `[JsonDerivedType(typeof(Envelope<int>), "int-envelope")]` is fine. Each closed instantiation needs its own attribute and its own id.
- **Custom converters and polymorphism do not mix.** Discriminators are only supported for the default object, collection, and dictionary converters. A `JsonConverter<T>` on the base type replaces the machinery entirely and has to write the discriminator itself.
- **`JsonSerializerOptions.Strict` (.NET 10) is compatible.** The `$type` property is treated as metadata, not an unmapped member, so `UnmappedMemberHandling.Disallow` does not reject it. Unknown *data* properties still throw, which is the point of the preset.
- **Newtonsoft.Json's `TypeNameHandling` has no equivalent, by design.** Embedding a CLR type name in the payload is a well-known deserialization gadget vector. `[JsonDerivedType]` requires an explicit allowlist, which is why the migration path from `TypeNameHandling.All` is the sharpest edge in [moving a large codebase to System.Text.Json](/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/).
- **A wrong discriminator surfaces as a conversion failure to callers.** If you are debugging one from the outside, the symptoms overlap with the general [JSON value could not be converted](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) family of errors.

The mental model that keeps all of this straight: the declared type selects the contract, the contract carries the derived-type allowlist, and the discriminator is metadata that has to arrive before the data it describes. Every failure mode above is one of those three sentences being violated.

## Related reading

- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Fix: System.Text.Json.JsonException: The JSON value could not be converted](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/)
- [Migrate from Newtonsoft.Json to System.Text.Json in a large codebase](/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [record vs class vs struct in C#: a decision matrix](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/)

## Sources

- [How to serialize properties of derived classes, MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/polymorphism)
- [`JsonDerivedTypeAttribute` reference](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonderivedtypeattribute)
- [`JsonPolymorphicAttribute` reference](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonpolymorphicattribute)
- [`JsonSerializerOptions.AllowOutOfOrderMetadataProperties`, .NET 9+](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.allowoutofordermetadataproperties)
- [Customize a JSON contract with the contract model](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/custom-contracts)
- [Include OpenAPI metadata in an ASP.NET Core app](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/include-metadata)
- [`System.Text.Json` resource strings, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/Resources/Strings.resx)
