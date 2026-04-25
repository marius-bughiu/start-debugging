---
title: "How to write a custom JsonConverter in System.Text.Json"
description: "A complete guide to writing custom JsonConverter<T> for System.Text.Json in .NET 11: when you actually need one, how to navigate Utf8JsonReader correctly, how to handle generics with JsonConverterFactory, and how to stay AOT-friendly."
pubDate: 2026-04-25
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "serialization"
---

To write a custom converter for `System.Text.Json`, derive from `JsonConverter<T>`, override `Read` and `Write`, and either decorate the target type with `[JsonConverter(typeof(MyConverter))]` or add an instance to `JsonSerializerOptions.Converters`. Inside `Read` you must walk the `Utf8JsonReader` exactly the number of tokens your value spans, no more and no less, otherwise the next deserializer call sees a broken stream. Inside `Write` you call methods on `Utf8JsonWriter` directly and never allocate intermediate strings unless you have to. For generic types or polymorphism, use `JsonConverterFactory` so a single class can produce converters for many closed generic instantiations. Everything in this guide targets .NET 11 (preview 3) and C# 14, but the API has been stable since .NET Core 3.0, so the same code works on every supported runtime.

## When a JsonConverter is the right tool

Most teams reach for a custom converter too early. Before writing one, check whether your problem is solvable with built-in features that ship in .NET 11 (and earlier):

- Property names not matching: use `JsonPropertyNameAttribute` or a `JsonNamingPolicy`. Preview 3 added `JsonNamingPolicy.PascalCase` and a member-level `[JsonNamingPolicy]` attribute, so the [naming policies in System.Text.Json 11](/2026/04/system-text-json-11-pascalcase-per-member-naming/) probably cover what you need.
- Numbers as strings: `JsonNumberHandling.AllowReadingFromString` on `JsonSerializerOptions`.
- Enums as strings: `JsonStringEnumConverter` is built in. There is even a [trim-friendly variant for Native AOT](/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/).
- Read-only properties or constructor parameters: the source generator (`[JsonSerializable]` plus `JsonSerializerContext`) handles records and primary constructors directly.
- Polymorphism by discriminator: `[JsonDerivedType]` and `[JsonPolymorphic]` (added in .NET 7) avoid almost every old converter trick.

A custom converter is the right tool when the JSON shape and the .NET shape genuinely diverge. Examples:

- A value type that should serialize as a primitive (`Money` becomes `"42.00 USD"`).
- A type whose JSON form is context-dependent (sometimes a string, sometimes an object).
- A tree where the same property name carries different types depending on a sibling field.
- A wire format you do not own (Stripe-style amounts in cents, ISO 8601 durations, RFC 5545 recurrence rules).

If none of these match, use the built-ins and skip this article.

## The JsonConverter<T> contract

`System.Text.Json.Serialization.JsonConverter<T>` has two abstract methods you must override and a couple of optional hooks:

```csharp
// .NET 11, C# 14
public abstract class JsonConverter<T> : JsonConverter
{
    public abstract T? Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options);

    public abstract void Write(
        Utf8JsonWriter writer,
        T value,
        JsonSerializerOptions options);

    // Optional: opt in to dictionary-key handling.
    public virtual T ReadAsPropertyName(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options) => throw new NotSupportedException();

    public virtual void WriteAsPropertyName(
        Utf8JsonWriter writer,
        T value,
        JsonSerializerOptions options) => throw new NotSupportedException();

    public virtual bool HandleNull => false;
}
```

Two things in this signature are easy to get wrong:

1. `Read` receives `Utf8JsonReader` by `ref`. The reader is a mutable struct that owns the cursor. If you pass it to a helper method, pass it by `ref` too, otherwise the caller's cursor will not advance and you will read the same token forever.
2. `HandleNull` defaults to `false`, which means the serializer will return `default(T)` for JSON `null` and never call your converter. If you need to map `null` to a non-default value (or distinguish "absent" from "null"), set `HandleNull => true` and check `reader.TokenType == JsonTokenType.Null` yourself.

The full contract is documented in the official MS Learn page on [writing custom converters](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to). The rest of this post is the practical version.

## A worked example: a Money value type

Take a strongly-typed `Money` value:

```csharp
// .NET 11, C# 14
public readonly record struct Money(decimal Amount, string Currency)
{
    public override string ToString() =>
        $"{Amount.ToString("0.00", CultureInfo.InvariantCulture)} {Currency}";
}
```

The default `System.Text.Json` behaviour serializes it as `{"Amount":42.00,"Currency":"USD"}`. We want a single string token instead: `"42.00 USD"`. That is exactly the kind of shape mismatch a converter is for.

```csharp
// .NET 11, C# 14
using System.Buffers;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class MoneyJsonConverter : JsonConverter<Money>
{
    public override Money Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String)
            throw new JsonException(
                $"Expected string for Money, got {reader.TokenType}.");

        string raw = reader.GetString()!; // "42.00 USD"
        int space = raw.LastIndexOf(' ');
        if (space <= 0 || space == raw.Length - 1)
            throw new JsonException($"Invalid Money literal: '{raw}'.");

        decimal amount = decimal.Parse(
            raw.AsSpan(0, space),
            NumberStyles.Number,
            CultureInfo.InvariantCulture);
        string currency = raw[(space + 1)..];

        return new Money(amount, currency);
    }

    public override void Write(
        Utf8JsonWriter writer,
        Money value,
        JsonSerializerOptions options)
    {
        // Formats directly into the writer's UTF-8 buffer.
        Span<char> buffer = stackalloc char[64];
        if (!value.Amount.TryFormat(
                buffer, out int written,
                "0.00", CultureInfo.InvariantCulture))
        {
            writer.WriteStringValue(value.ToString());
            return;
        }

        // "<number> <currency>" without intermediate string allocation.
        Span<char> output = stackalloc char[written + 1 + value.Currency.Length];
        buffer[..written].CopyTo(output);
        output[written] = ' ';
        value.Currency.AsSpan().CopyTo(output[(written + 1)..]);
        writer.WriteStringValue(output);
    }
}
```

A few details worth calling out:

- `reader.GetString()` materializes a managed `string`. If you are deserializing millions of records and the parsed value is short-lived, prefer `reader.ValueSpan` (UTF-8 bytes) plus `Utf8Parser` to avoid the allocation.
- `writer.WriteStringValue(ReadOnlySpan<char>)` UTF-8 encodes directly into the writer's pooled buffer. There is no intermediate `string`. That overload, plus `WriteStringValue(ReadOnlySpan<byte> utf8)`, is the cheap path.
- `JsonException` is the canonical "the data is wrong" exception. The serializer wraps it with line and position info before it reaches the caller, so you do not need to add any.

## Reading correctly: cursor discipline

The single most common bug in custom converters is failing to leave the reader on the right token. The contract is:

> When `Read` returns, the reader must be positioned on the **last token consumed by your value**, not the next one.

The serializer calls `reader.Read()` once between values. If your converter consumes too many tokens, the next property is silently skipped. If it consumes too few, the next deserializer call sees a malformed stream and throws on a token it did not expect.

Two rules cover almost every case:

1. For a single-token value (string, number, boolean), do nothing besides reading from the current token. The cursor is already on the right token when `Read` is invoked.
2. For an object or array, loop until you see the matching `EndObject` or `EndArray` token, and let the loop's final `reader.Read()` land you exactly on that closing token.

Here is the canonical object-reading skeleton:

```csharp
// .NET 11, C# 14
public override Foo Read(
    ref Utf8JsonReader reader,
    Type typeToConvert,
    JsonSerializerOptions options)
{
    if (reader.TokenType != JsonTokenType.StartObject)
        throw new JsonException();

    var result = new Foo();

    while (reader.Read())
    {
        if (reader.TokenType == JsonTokenType.EndObject)
            return result;

        if (reader.TokenType != JsonTokenType.PropertyName)
            throw new JsonException();

        string property = reader.GetString()!;
        reader.Read(); // advance to the value token

        switch (property)
        {
            case "id":
                result.Id = reader.GetInt32();
                break;
            case "name":
                result.Name = reader.GetString();
                break;
            case "child":
                // Recurse through the serializer so nested converters and
                // contracts apply.
                result.Child = JsonSerializer.Deserialize<Child>(
                    ref reader, options);
                break;
            default:
                reader.Skip(); // unknown field, advance past its value
                break;
        }
    }

    throw new JsonException(); // unexpected end of stream
}
```

`reader.Skip()` is the underrated helper: it walks past whatever the current token introduces, including a nested object or array, leaving the cursor on its closing token. Use it for anything you do not understand, never write a custom skip loop.

## Writing efficiently: stay on the writer

`Utf8JsonWriter` writes directly to a pooled UTF-8 buffer, so anything that does not require a managed `string` should stay off the heap. Three rules:

1. Prefer the typed overloads: `WriteNumber`, `WriteBoolean`, `WriteString(ReadOnlySpan<char>)`. They format into the buffer.
2. For property+value pairs inside an object, use `WriteString("name", value)` and friends. They emit the property name and value in one call without allocating.
3. If you must build a string, use `string.Create` or a stack-allocated `Span<char>` rather than `string.Format` or interpolation, both of which allocate.

For the `Money` example above, an even cheaper version uses UTF-8 directly:

```csharp
// .NET 11, C# 14, micro-optimized hot path
public override void Write(
    Utf8JsonWriter writer,
    Money value,
    JsonSerializerOptions options)
{
    Span<byte> buffer = stackalloc byte[64];
    if (!value.Amount.TryFormat(
            buffer, out int written,
            "0.00", CultureInfo.InvariantCulture))
    {
        writer.WriteStringValue(value.ToString());
        return;
    }

    int currencyLen = Encoding.UTF8.GetByteCount(value.Currency);
    Span<byte> output = stackalloc byte[written + 1 + currencyLen];
    buffer[..written].CopyTo(output);
    output[written] = (byte)' ';
    Encoding.UTF8.GetBytes(value.Currency, output[(written + 1)..]);
    writer.WriteStringValue(output);
}
```

This version never produces a managed string for the formatted value. For a service serializing tens of thousands of `Money` instances per second, that is a measurable difference in allocation rate.

## Generic types and JsonConverterFactory

`JsonConverter<T>` is a closed type. If you want a converter for `Result<TValue, TError>` that works for every closed generic, you write a `JsonConverterFactory` that produces the closed converters on demand:

```csharp
// .NET 11, C# 14
public sealed class ResultJsonConverterFactory : JsonConverterFactory
{
    public override bool CanConvert(Type typeToConvert) =>
        typeToConvert.IsGenericType
        && typeToConvert.GetGenericTypeDefinition() == typeof(Result<,>);

    public override JsonConverter CreateConverter(
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        Type[] args = typeToConvert.GetGenericArguments();
        Type closed = typeof(ResultConverter<,>).MakeGenericType(args);
        return (JsonConverter)Activator.CreateInstance(closed)!;
    }

    private sealed class ResultConverter<TValue, TError>
        : JsonConverter<Result<TValue, TError>>
    {
        public override Result<TValue, TError> Read(
            ref Utf8JsonReader reader,
            Type typeToConvert,
            JsonSerializerOptions options) =>
            throw new NotImplementedException(); // exercise for the reader

        public override void Write(
            Utf8JsonWriter writer,
            Result<TValue, TError> value,
            JsonSerializerOptions options) =>
            throw new NotImplementedException();
    }
}
```

The factory is registered the same way as a regular converter (attribute or `Options.Converters.Add`). The serializer caches the closed converter per closed generic, so `CreateConverter` runs once per `(TValue, TError)` pair per `JsonSerializerOptions` instance.

`Activator.CreateInstance` plus `MakeGenericType` is reflection, which is hostile to Native AOT and trim. If you target AOT, see the AOT section below.

## Registering a converter

Two ways, and they have different precedence:

```csharp
// .NET 11, C# 14
[JsonConverter(typeof(MoneyJsonConverter))]
public readonly record struct Money(decimal Amount, string Currency);
```

The attribute pins the converter to the type and is honoured by every `JsonSerializer` call without per-options setup. Use it for value types you own.

```csharp
// .NET 11, C# 14
var options = new JsonSerializerOptions
{
    Converters = { new MoneyJsonConverter() }
};

string json = JsonSerializer.Serialize(invoice, options);
```

Options-level registration is the right answer when you do not own the target type, when the converter is environment-specific (test vs prod), or when a single type needs different shapes in different contexts (a public API vs an internal log).

The lookup order, from highest to lowest priority:

1. The converter passed directly to a `JsonSerializer` call.
2. `[JsonConverter]` on the property.
3. `Options.Converters` (last-added wins for matching types).
4. `[JsonConverter]` on the type.
5. The built-in default for that type.

If two converters claim the same type via different mechanisms, the one higher in this list wins. Sketch this in your head before you debug "why is my converter not running": almost always, a property attribute or an options entry is overriding the type attribute.

## Source generation and Native AOT

`JsonConverter<T>` works with the source generator: declare the type in your `JsonSerializerContext` and the generator emits a metadata provider that delegates to your converter where appropriate. The same is **not** automatically true for `JsonConverterFactory`. Anything the factory does with `MakeGenericType` or `Activator.CreateInstance` is reflection, which trim and AOT cannot statically see.

For AOT-friendly factories, do one of:

- Restrict the factory to a known, finite set of closed generics and instantiate them directly with `new ResultConverter<MyValue, MyError>()` per pair.
- Annotate the factory with `[RequiresDynamicCode]` and `[RequiresUnreferencedCode]`, accept the trim warnings, and document that AOT consumers must register the closed converter manually.

The pattern of using interceptors to make `JsonSerializer.Serialize` calls automatically pick up a generated context, discussed in [the C# 14 interceptor proposal for source-generated JSON](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/), is independent of converters: even with that, you still write your custom `JsonConverter<T>` the same way.

## Gotchas, in order of how often they bite

- **Forgetting to advance the reader past `EndObject`/`EndArray`.** Symptom: the next property in the parent object is silently skipped or the parser throws a confusing error two layers up. Audit by writing a converter test that deserializes `{ "wrapped": <yourThing>, "next": 1 }` and asserts that `next` is read.
- **Calling `JsonSerializer.Deserialize<T>(ref reader, options)` on the same `T` your converter handles.** This recurses infinitely. Recursion through the serializer is for *other* types (children, nested values).
- **Holding the `Utf8JsonReader` across an `await`.** The reader is a `ref struct`, the compiler will not let you, but you might be tempted to copy values out into local variables and re-attach later. Don't. Read the entire value synchronously inside `Read`. If your data source is async, buffer first into a `ReadOnlySequence<byte>` and pass that to the reader.
- **Throwing anything other than `JsonException` for malformed data.** Other exceptions cross the serializer boundary unwrapped and lose the line/position context.
- **Mutating `JsonSerializerOptions` after the first serialize call.** The serializer caches resolved converters per options instance; subsequent mutations throw `InvalidOperationException`. Build a fresh options instance instead, or call `MakeReadOnly()` explicitly when you finish configuration.
- **Using `JsonConverterAttribute` on an interface or abstract type and expecting polymorphism for free.** It does not work that way. Use `[JsonPolymorphic]` and `[JsonDerivedType]` for hierarchy serialization, or write a custom converter that does the discriminator dispatch yourself.
- **Allocating in `Write`.** Easy to write `JsonSerializer.Serialize(value)` recursively and forget that it produces a `string` you then write back to the writer. Use the `ref Utf8JsonWriter` overload of `Serialize` instead.

If you keep these in mind, a converter rarely takes more than 30 lines of code and runs in the same allocation budget as the built-in serializer.

## Related

- [How to use Channels instead of BlockingCollection in C#](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) -- async-first patterns, same era of API design.
- [System.Text.Json in .NET 11 Preview 3 adds PascalCase and per-member naming](/2026/04/system-text-json-11-pascalcase-per-member-naming/) -- when a naming policy is enough and a converter is not.
- [How to use JsonStringEnumConverter with Native AOT](/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/) -- the trim/AOT story for built-in converters.
- [Interceptors for System.Text.Json source generation](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) -- a parallel ergonomics direction worth tracking.
- [How to return multiple values from a method in C# 14](/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) -- the value-tuple and record patterns that often end up needing a converter.

## Sources

- MS Learn: [Write custom converters for JSON serialization](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to)
- MS Learn: [How to use the source generator in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation)
- API reference: [`Utf8JsonReader`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.utf8jsonreader), [`Utf8JsonWriter`](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.utf8jsonwriter)
- dotnet/runtime issue tracker for the System.Text.Json area: [area-System.Text.Json](https://github.com/dotnet/runtime/labels/area-System.Text.Json)
