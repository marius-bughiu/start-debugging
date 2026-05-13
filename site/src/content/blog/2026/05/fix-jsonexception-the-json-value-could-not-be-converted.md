---
title: "Fix: System.Text.Json.JsonException: The JSON value could not be converted"
description: "System.Text.Json throws this when the incoming JSON token doesn't match the CLR target type. Match the JSON to the type, or register a JsonConverter or JsonSerializerOption that bridges them."
pubDate: 2026-05-13
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
---

The fix: `System.Text.Json` raised this exception because the JSON token at the path it names cannot be deserialised into the target CLR type. The message generally comes in two shapes. Either the JSON is the wrong **token kind** (a string where a number was expected, or vice versa, or a number where an enum value was expected), or the JSON is the right kind but the **content** does not match the type's parsing rules (a non-ISO date, a malformed `Guid`, a literal like `"NaN"`). Pick one of three fixes per call site: change the producer to emit the expected JSON shape, opt in to a converter that accepts the shape you actually receive (`JsonStringEnumConverter`, `JsonNumberHandling.AllowReadingFromString`), or write a `JsonConverter<T>` that does the parsing yourself.

```text
System.Text.Json.JsonException: The JSON value could not be converted to MyApp.OrderStatus. Path: $.status | LineNumber: 0 | BytePositionInLine: 21.
   at System.Text.Json.ThrowHelper.ThrowJsonException(String message)
   at System.Text.Json.Serialization.Converters.EnumConverter`1.Read(Utf8JsonReader& reader, Type typeToConvert, JsonSerializerOptions options)
   at System.Text.Json.Serialization.JsonConverter`1.ReadCore(Utf8JsonReader& reader, JsonSerializerOptions options, ReadStack& state)
   at System.Text.Json.JsonSerializer.ReadFromSpan[TValue](ReadOnlySpan`1 utf8Json, JsonTypeInfo jsonTypeInfo)
   at System.Text.Json.JsonSerializer.Deserialize[TValue](String json, JsonSerializerOptions options)
```

This guide is written against .NET 11 preview 4 and `System.Text.Json` 11.0.0-preview.4. The exception type and the `Path` / `LineNumber` / `BytePositionInLine` fields have been stable since `System.Text.Json` shipped in .NET Core 3.0, so every fix below applies to .NET 6, 8, 10, and 11 without changes. The only moving parts across versions are the converter knobs: `JsonNumberHandling` arrived in .NET 5, `JsonStringEnumConverter<TEnum>` (the generic, AOT-friendly version) shipped in .NET 8, and the `[JsonStringEnumMemberName]` attribute landed in .NET 9.

The first thing to read is the **`Path`** segment. It is a JSON Pointer-style path with `$` as the root, and it tells you exactly which property the reader choked on. Search engines tend to land you on a stack trace that names a generic converter ("the JSON value could not be converted to `Int32`") with no hint at which property, but `Path` is always there. If you do not see a `Path` segment, you are looking at a wrapped exception. Catch `JsonException` directly at the deserialisation call site and read `ex.Path` from the property, not from `ex.Message`.

## Why System.Text.Json refuses to coerce

Unlike `Newtonsoft.Json`, `System.Text.Json` is **strict by default**: it does not coerce between JSON token kinds and it does not run a lossy parser on string content. If your endpoint accepts `{ "amount": "12.50" }` and your DTO has `decimal Amount`, the reader sees `JsonTokenType.String`, finds no built-in conversion from `string` to `decimal`, and throws. The same logic rejects:

- A JSON string where the property expects a `bool`, `int`, `long`, `decimal`, `double`, `Guid`, `DateTime`, or `TimeSpan`. The opposite direction (a JSON number where the property expects a `string`) is also rejected.
- A JSON number that names an enum value when no `JsonStringEnumConverter` is registered, **or** a JSON string that names an enum value when the default integer-only converter is in effect.
- An empty string `""` where the property expects a value type. Empty strings are not the same as `null`, and value types are not nullable unless declared as `T?`.
- A polymorphic JSON object where the discriminator does not match any `[JsonDerivedType]` you registered.
- A floating-point literal like `"NaN"`, `"Infinity"`, or `"-Infinity"` when `JsonNumberHandling.AllowNamedFloatingPointLiterals` is not set.
- A Unix timestamp number (`1715600000`) for a `DateTime` property, because `System.Text.Json` only reads `DateTime` from an ISO 8601 string. The dedicated case is covered in [the canonical DateTime conversion fix](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).

Strictness is the design, not the bug. The team's rationale is that lossy conversion is the most common source of silent data corruption in line-of-business apps, and that explicit converter registration makes intent visible at the seam between the wire format and the type system. The trade-off is that every cross-cutting concern you used to get from `Newtonsoft.Json` defaults (string-to-number, string-to-enum, string-to-bool) now needs an explicit opt-in.

## Minimal repro

The smallest program that reproduces the most common variant, an enum coming in as a string:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

var json = """{ "status": "Pending" }""";

var order = JsonSerializer.Deserialize<Order>(json);

Console.WriteLine(order!.Status);

public record Order(OrderStatus Status);
public enum OrderStatus { Pending, Shipped, Delivered }
```

Running this throws:

```text
Unhandled exception. System.Text.Json.JsonException:
The JSON value could not be converted to OrderStatus. Path: $.status | LineNumber: 0 | BytePositionInLine: 20.
```

The default enum converter accepts only the **integer** representation (`{ "status": 0 }`). Anything else triggers the exception. Once you understand this is the failure mode, every other variant in this post follows the same pattern: the JSON shape does not match the type, and you choose which side to bend.

## Fix 1: enums received as strings

Register `JsonStringEnumConverter<TEnum>` once on your `JsonSerializerOptions`:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
var options = new JsonSerializerOptions
{
    Converters = { new JsonStringEnumConverter<OrderStatus>() }
};

var order = JsonSerializer.Deserialize<Order>(json, options)!;
```

If you have many enums, register the non-generic `JsonStringEnumConverter()` instead. It applies to every enum type the serialiser encounters, at the cost of being incompatible with Native AOT trimming. For Native AOT, prefer the per-enum generic converter or annotate each enum with `[JsonConverter(typeof(JsonStringEnumConverter<OrderStatus>))]` directly, then keep the global converters list empty.

If the producer is case-sensitive ("PENDING" on the wire, `Pending` in C#), pass a naming policy:

```csharp
var options = new JsonSerializerOptions
{
    Converters =
    {
        new JsonStringEnumConverter<OrderStatus>(JsonNamingPolicy.SnakeCaseUpper)
    }
};
```

For producers that send values not representable as C# identifiers ("in-progress", "n/a"), .NET 9 introduced `[JsonStringEnumMemberName]`:

```csharp
public enum OrderStatus
{
    Pending,

    [JsonStringEnumMemberName("in-progress")]
    InProgress,

    Delivered
}
```

In ASP.NET Core minimal APIs, configure the converter on the application's `JsonSerializerOptions` so every endpoint picks it up:

```csharp
// .NET 11 preview 4, ASP.NET Core 11.0.0-preview.4
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter<OrderStatus>());
});
```

For controllers, the equivalent call is `builder.Services.AddControllers().AddJsonOptions(o => o.JsonSerializerOptions.Converters.Add(...))`. Configuring it once at the composition root is preferable to opening up `JsonConverter` on every `[JsonConverter(...)]` attribute.

## Fix 2: numbers received as strings (and vice versa)

When the producer JSON-encodes a numeric field as a string, `{ "amount": "12.50" }`, opt in to `JsonNumberHandling.AllowReadingFromString`:

```csharp
// .NET 11 preview 4, System.Text.Json 11.0.0-preview.4
var options = new JsonSerializerOptions
{
    NumberHandling = JsonNumberHandling.AllowReadingFromString
};

var dto = JsonSerializer.Deserialize<Invoice>(json, options);

public record Invoice(decimal Amount);
```

`AllowReadingFromString` works for every integral and floating-point type, plus `decimal`. It is symmetrical with `WriteAsString`, which you can combine if you want the serialiser to emit and read the value as a string:

```csharp
NumberHandling = JsonNumberHandling.AllowReadingFromString | JsonNumberHandling.WriteAsString
```

For per-property scope rather than globally, attribute the property directly:

```csharp
public record Invoice(
    [property: JsonNumberHandling(JsonNumberHandling.AllowReadingFromString)] decimal Amount
);
```

The inverse case, a JSON number sent where a `string` is expected (a tracking ID encoded as `42` instead of `"42"`), is **not** covered by `JsonNumberHandling`. You need a small custom converter:

```csharp
// .NET 11 preview 4
public sealed class NumberOrStringConverter : JsonConverter<string>
{
    public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.TokenType switch
        {
            JsonTokenType.String => reader.GetString(),
            JsonTokenType.Number => reader.GetInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
            JsonTokenType.Null => null,
            _ => throw new JsonException()
        };

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

I cover the converter contract in more depth in [the guide to writing a custom JsonConverter](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), including how to compose converters and how to short-circuit polymorphic dispatch.

## Fix 3: booleans received as 0 / 1 or as "true" / "false" strings

`System.Text.Json` accepts only the JSON `true` / `false` tokens for `bool`. Numeric `0` / `1` and string `"true"` / `"false"` are both rejected. There is no built-in option for either form; write a converter:

```csharp
// .NET 11 preview 4
public sealed class LooseBooleanConverter : JsonConverter<bool>
{
    public override bool Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => reader.TokenType switch
        {
            JsonTokenType.True => true,
            JsonTokenType.False => false,
            JsonTokenType.Number => reader.GetInt32() != 0,
            JsonTokenType.String => bool.Parse(reader.GetString()!),
            _ => throw new JsonException()
        };

    public override void Write(Utf8JsonWriter writer, bool value, JsonSerializerOptions options)
        => writer.WriteBooleanValue(value);
}
```

Register it per property with `[JsonConverter(typeof(LooseBooleanConverter))]` rather than globally, because most fields in a well-behaved API are not loose, and bending every `bool` to accept three shapes obscures the contract.

## Fix 4: empty strings for value types

If the producer emits `{ "shippedAt": "" }` for a missing date, `System.Text.Json` reads `JsonTokenType.String` and fails to parse the empty content as `DateTime`. There are two clean fixes. The first is to make the C# property nullable and write a converter that maps `""` to `null`:

```csharp
public sealed class NullableDateTimeConverter : JsonConverter<DateTime?>
{
    public override DateTime? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        if (reader.TokenType == JsonTokenType.String)
        {
            var s = reader.GetString();
            return string.IsNullOrEmpty(s) ? null : DateTime.Parse(s, System.Globalization.CultureInfo.InvariantCulture);
        }
        throw new JsonException();
    }

    public override void Write(Utf8JsonWriter writer, DateTime? value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

The second is to set `JsonSerializerOptions.RespectNullableAnnotations = true` (default in .NET 9+) and have the producer send `null` instead of `""`. The producer-side fix is preferable when you control both sides, because every `""`-as-null special case eventually leaks into a non-nullable column or a NullReferenceException downstream.

## Fix 5: Guid in the wrong format

`System.Text.Json` uses `Guid.TryParseExact` with format `D` (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). Bracketed (`{...}`), parenthesised (`(...)`), and no-dash (`N`) representations all throw. The shortest fix is a per-property converter:

```csharp
public sealed class FlexibleGuidConverter : JsonConverter<Guid>
{
    public override Guid Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var s = reader.GetString();
        return Guid.Parse(s!);
    }

    public override void Write(Utf8JsonWriter writer, Guid value, JsonSerializerOptions options)
        => writer.WriteStringValue(value);
}
```

`Guid.Parse` accepts every standard format string, so this is enough.

## Fix 6: polymorphic objects with an unknown discriminator

When you declare a base type with `[JsonPolymorphic]` and `[JsonDerivedType]`, the reader inspects the discriminator property and walks to the matching subtype. If the discriminator value is missing or unknown, the reader throws "the JSON value could not be converted to BaseType". Two production-grade fixes:

- Set `UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType` so the reader materialises the base type when no derived type matches.
- Set `UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToNearestAncestor` if you have a class hierarchy deeper than one level and want the nearest registered ancestor.

```csharp
// .NET 11 preview 4
[JsonPolymorphic(
    TypeDiscriminatorPropertyName = "$kind",
    UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FallBackToBaseType)]
[JsonDerivedType(typeof(EmailEvent), "email")]
[JsonDerivedType(typeof(SmsEvent), "sms")]
public abstract record Event;

public record EmailEvent(string To, string Subject) : Event;
public record SmsEvent(string To, string Body) : Event;
```

The default behaviour (`JsonUnknownDerivedTypeHandling.FailSerialization`) is correct for closed schemas where every variant is known. Use the fallback options when you ingest events from a producer that adds new variants without coordinating a deployment.

## Fix 7: floating-point NaN and Infinity

If a serialiser on the producer side emits `"NaN"`, `"Infinity"`, or `"-Infinity"` for `double` / `float`, opt in:

```csharp
var options = new JsonSerializerOptions
{
    NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals
};
```

This is symmetrical: the same option also lets your serialiser emit those literals on the write path. Without it, both reading and writing throw.

## Gotchas and lookalikes

- **The exception message names a base type, not the concrete one.** Polymorphic deserialisation reports the failure against the polymorphic root, not the type the discriminator pointed at. Read the discriminator value in your raw JSON before assuming the converter is wrong.
- **Source-generated contexts hide options.** If you declared `[JsonSerializable(typeof(Order))]` on a `JsonSerializerContext`, the converters list on the runtime `JsonSerializerOptions` you pass in **is** respected, but the source-generated metadata also encodes `[JsonConverter]` attributes at compile time. Mixing both is fine, but a property-level `[JsonConverter(...)]` always wins over a runtime-registered global. See the [C# 14 interceptor support for System.Text.Json source generation](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) for the ergonomics work in this area.
- **Case sensitivity is independent from the converter.** `PropertyNameCaseInsensitive = true` and the casing-aware naming policies (`JsonNamingPolicy.CamelCase`, `JsonNamingPolicy.SnakeCaseLower`, the [.NET 11 PascalCase per-member naming](/2026/04/system-text-json-11-pascalcase-per-member-naming/) attribute) affect which CLR property the reader binds to, not how it converts the value. If your error mentions `Path: $.OrderStatus` but your JSON has `"orderStatus"`, you are looking at a binding miss, not a conversion failure.
- **The DateTime branch has its own conventions.** ISO 8601 only, `T` separator only, no Unix timestamps. The full table of accepted and rejected formats is in [the dedicated DateTime conversion fix](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/).
- **Reading a number that does not fit.** A JSON `9999999999` cannot be read into `int` and throws with the same exception text. Check the magnitude before assuming it is a format problem.
- **Newtonsoft.Json silently coerced.** The most common path to this bug is a migration from `Newtonsoft.Json` where the old code accepted `{ "amount": "12.50" }` because Newtonsoft tries string-to-decimal under the hood. There is no global "be lenient" switch in `System.Text.Json`. Either set `NumberHandling` and register `JsonStringEnumConverter`, or stay on Newtonsoft for that boundary.

## Related

- [Fix: The JSON value could not be converted to System.DateTime](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) covers the DateTime-specific variant, including the ISO 8601 format requirement and Unix timestamp parsing.
- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) shows the converter contract, factory converters, and how to fall through to the default converter.
- [System.Text.Json 11 per-member PascalCase naming](/2026/04/system-text-json-11-pascalcase-per-member-naming/) is the right tool when the failure is property binding rather than value conversion.
- [C# 14 interceptors for System.Text.Json source generation](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) explains how source-generated converters interact with runtime `JsonSerializerOptions`.
- [Fix: InvalidOperationException: Synchronous operations are disallowed](/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/) is unrelated but commonly hit alongside JSON conversion errors when migrating from buffered to streaming JSON in ASP.NET Core.

## Sources

- [System.Text.Json overview, .NET docs](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/overview)
- [How to serialize and deserialize enum values, MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/customize-properties)
- [`JsonNumberHandling` reference](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonnumberhandling)
- [`JsonPolymorphicAttribute` and `JsonDerivedTypeAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonpolymorphicattribute)
- [`JsonStringEnumMemberNameAttribute`, .NET 9+](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.serialization.jsonstringenummembernameattribute)
- [`dotnet/runtime` source for `EnumConverter<T>`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/System/Text/Json/Serialization/Converters/Value/EnumConverter.cs)
