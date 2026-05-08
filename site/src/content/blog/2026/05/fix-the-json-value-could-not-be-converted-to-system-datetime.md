---
title: "Fix: The JSON value could not be converted to System.DateTime"
description: "System.Text.Json only accepts ISO 8601 strings for DateTime. Send 2026-05-08T14:00:00Z or register a JsonConverter that parses your format. Empty strings and Unix timestamps both throw."
pubDate: 2026-05-08
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "json"
---

The fix: `System.Text.Json` only deserialises a `DateTime` from a JSON string in extended ISO 8601 format, like `"2026-05-08T14:00:00Z"` or `"2026-05-08T14:00:00+02:00"`. If your producer sends `"05/08/2026"`, an empty string `""`, a Unix timestamp number, or Newtonsoft's `"/Date(1746715200000)/"`, the deserialiser throws. Either change the wire format to ISO 8601, or register a `JsonConverter<DateTime>` that knows how to parse what you actually receive.

```text
System.Text.Json.JsonException: The JSON value could not be converted to System.DateTime. Path: $.startedAt | LineNumber: 0 | BytePositionInLine: 27.
   at System.Text.Json.ThrowHelper.ReThrowWithPath(ReadStack& state, JsonReaderException ex)
   at System.Text.Json.Serialization.JsonConverter`1.ReadCore(Utf8JsonReader& reader, JsonSerializerOptions options, ReadStack& state)
   at System.Text.Json.JsonSerializer.ReadFromSpan[TValue](ReadOnlySpan`1 utf8Json, JsonTypeInfo jsonTypeInfo)
   at System.Text.Json.JsonSerializer.Deserialize[TValue](String json, JsonSerializerOptions options)
 ---> System.FormatException: The JSON value is not in a supported DateTime format.
```

This guide is written against .NET 11 preview 4 and `System.Text.Json` 11.0.0-preview.4. The accepted format and the exception have not changed since `System.Text.Json` shipped in .NET Core 3.0; the inner `FormatException` text is what tightened up around .NET 8. The `Path` segment is the JSON path of the offending property and is the first thing to read, it tells you which field the converter choked on without you having to instrument anything.

## Why System.Text.Json is so picky

`System.Text.Json` deliberately implements only the [ISO 8601-1:2019 Extended profile](https://learn.microsoft.com/en-us/dotnet/standard/datetime/system-text-json-support) for `DateTime` and `DateTimeOffset`. The format must be `YYYY-MM-DDTHH:mm:ss[.fffffff][Z|+hh:mm]` with a literal `T` separator. Lower-case `t`, a space separator, US-style `MM/dd/yyyy`, two-digit years, missing seconds, and time-only or date-only values are all rejected. So is the JSON `null` token unless the property is a nullable `DateTime?`, and so is an empty string `""`.

This is by design: Newtonsoft.Json's permissive multi-format parser caused real-world bugs where a producer in one locale sent `01/05/2026` and a consumer in another silently parsed it as the wrong date. `System.Text.Json` treats DateTime parsing the same way it treats numbers in JSON, one canonical form, no guessing.

So the deserialiser is correct to throw. The job is either to make the wire conform, or to register a converter that maps your wire format to a `DateTime` exactly once.

## A minimal repro

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

record Event(DateTime StartedAt);

var bad = """{ "startedAt": "05/08/2026" }""";
var ev = JsonSerializer.Deserialize<Event>(bad); // throws
```

The producer sent a US-locale slash date and `System.Text.Json` does not know that format. The same error fires for any of these payloads:

```json
{ "startedAt": "" }
{ "startedAt": "2026-05-08" }
{ "startedAt": 1746715200 }
{ "startedAt": "/Date(1746715200000)/" }
{ "startedAt": "2026-05-08 14:00:00" }
{ "startedAt": "Friday, May 8, 2026" }
```

Each one fails for a different reason. The empty string is not parseable as a date. The bare date `"2026-05-08"` is missing the time component, ISO 8601 Extended requires the `T` and a time. The Unix timestamp number cannot bind to `DateTime` at all. The `/Date(...)` syntax is a Newtonsoft historical artifact. The space-separated format is ISO 8601 Basic, not Extended. The English long form is not a machine format.

## Fix, in detail

### 1. Make the producer send ISO 8601

The right answer is to fix it at the source. ISO 8601 Extended with a `T` and a UTC `Z` (or explicit offset) round-trips between every modern stack: JavaScript's `Date.prototype.toISOString()`, Python's `datetime.isoformat()`, Postgres `to_char(... 'YYYY-MM-DD"T"HH24:MI:SSOF')`, Java's `Instant.toString()`, and `DateTime.UtcNow.ToString("o")` in .NET all emit it.

```csharp
// .NET 11, C# 14
var iso = DateTime.UtcNow.ToString("o"); // 2026-05-08T14:00:00.0000000Z
```

If you control the producer, this is one line of work. Avoid `"u"` (uses a space separator, not a `T`) and avoid stringifying `DateTime.Now` without an offset, which creates `Unspecified` kind values that round-trip ambiguously.

### 2. Register a JsonConverter for non-ISO formats

When you cannot change the producer (third-party API, legacy payload), write a converter. The converter pattern is the same regardless of the source format, the only thing that changes is the parsing call.

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
using System.Buffers;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

public sealed class UsSlashDateConverter : JsonConverter<DateTime>
{
    private const string Format = "MM/dd/yyyy";

    public override DateTime Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var text = reader.GetString();
        return DateTime.ParseExact(
            text!, Format, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime value,
        JsonSerializerOptions options)
        => writer.WriteStringValue(value.ToUniversalTime().ToString(Format, CultureInfo.InvariantCulture));
}
```

Register it once on the options, do not new it up at every call site:

```csharp
// .NET 11
var options = new JsonSerializerOptions
{
    Converters = { new UsSlashDateConverter() }
};
var ev = JsonSerializer.Deserialize<Event>(bad, options);
```

Always pass `CultureInfo.InvariantCulture` and pin the exact format with `ParseExact`. `Parse` and `TryParse` lean on the current culture and re-introduce the same ambiguity that ISO 8601 was designed to remove. For converter scaffolding details, the [custom JsonConverter walkthrough](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) covers the hot-path tricks (`Utf8JsonReader.ValueSpan`, span parsing) that matter when the converter sits in a high-throughput pipeline.

### 3. Convert Unix timestamps with a number-aware reader

If the wire sends a number (`"startedAt": 1746715200`), `reader.GetString()` will throw because the token is `Number`, not `String`. Branch on `TokenType`:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
public sealed class UnixSecondsConverter : JsonConverter<DateTime>
{
    public override DateTime Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        return reader.TokenType switch
        {
            JsonTokenType.Number => DateTimeOffset.FromUnixTimeSeconds(reader.GetInt64()).UtcDateTime,
            JsonTokenType.String when long.TryParse(reader.GetString(), out var s)
                => DateTimeOffset.FromUnixTimeSeconds(s).UtcDateTime,
            JsonTokenType.String
                => DateTime.Parse(reader.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
            _ => throw new JsonException($"Unexpected token {reader.TokenType} for DateTime.")
        };
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime value,
        JsonSerializerOptions options)
        => writer.WriteNumberValue(new DateTimeOffset(value, TimeSpan.Zero).ToUnixTimeSeconds());
}
```

This is the converter you write for older REST APIs that mix string and number payloads (Twitter, Stripe, Slack legacy fields). `DateTimeOffset.FromUnixTimeSeconds` is the right helper, do not multiply by 10,000 to make a `Ticks` value, that path drops sub-second precision and ignores the epoch difference.

### 4. Treat empty strings as null

A common API quirk is sending `""` for "no date". The deserialiser cannot bind an empty string to either `DateTime` or `DateTime?`. Make the property nullable and add a converter that returns `null` on empty input:

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0-preview.4
public sealed class NullableEmptyDateTimeConverter : JsonConverter<DateTime?>
{
    public override DateTime? Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        var text = reader.GetString();
        if (string.IsNullOrEmpty(text)) return null;
        return DateTime.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
    }

    public override void Write(
        Utf8JsonWriter writer,
        DateTime? value,
        JsonSerializerOptions options)
    {
        if (value is null) writer.WriteNullValue();
        else writer.WriteStringValue(value.Value.ToString("o", CultureInfo.InvariantCulture));
    }
}
```

Apply it per-property if only one field misbehaves, with `[JsonConverter(typeof(NullableEmptyDateTimeConverter))]` on the property. The global registration above replaces the default converter for every `DateTime?` in the graph; the per-property attribute is narrower and safer.

### 5. Use DateOnly when there is no time

If the wire really is `"2026-05-08"` (a calendar date with no time-of-day), the type on the consumer should be `DateOnly`, not `DateTime`. `System.Text.Json` 8.0+ has built-in support and accepts the ISO 8601 date format directly:

```csharp
// .NET 11, C# 14
record Event(DateOnly StartedOn);

var json = """{ "startedOn": "2026-05-08" }""";
var ev = JsonSerializer.Deserialize<Event>(json); // works, no converter needed
```

`DateOnly` was added in .NET 6 specifically because date-without-time was the single most common DateTime-related modelling bug. If your domain truly is a calendar day (a birthday, a delivery date, a holiday), switch types and the JSON parsing problem evaporates.

## Common shapes that trigger this

### Property is a struct DateTime but the value can be missing

A non-nullable `DateTime` cannot hold "absent". The producer sends `null` or `""`, the deserialiser throws. Make the property `DateTime?`. If you do not control the schema, `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` cleans up the round-trip on the way out, but the read path still needs nullable.

### A configured Newtonsoft date format leaked into the contract

If you are migrating from Newtonsoft.Json, your old code probably had `IsoDateFormatString = "MM/dd/yyyy"` or a `DateTimeFormat` set on a `JsonSerializerSettings`. Newtonsoft accepted it, `System.Text.Json` does not honour the setting at all. Search your repo for `DateFormatHandling`, `DateTimeFormat`, and `IsoDateFormatString`, then either fix the producer or write the converter above. The vstest team [removed the Newtonsoft.Json transitive dependency](/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) in .NET 11 preview 4 for similar contract-tightening reasons.

### MVC model binding swallows the inner exception

In ASP.NET Core, an invalid date in a request body produces a `400 Bad Request` with `{"errors":{"$.startedAt":["The JSON value could not be converted to System.DateTime..."]}}`. The `Path: $.startedAt` from the inner exception ends up in the `errors` dictionary. If you only see "One or more validation errors occurred", check the response body, the offending path is in there.

### Source generators hide the converter registration

When you opt into `System.Text.Json` source generation with `[JsonSerializable]` and a `JsonSerializerContext`, you must register converters on the same context, not just on a runtime `JsonSerializerOptions`. The generator emits `TypeInfo` for each rooted type at compile time, and a converter that you forgot to wire on the context is invisible at runtime. The [interceptors and source generation post](/2026/02/csharp-14-interceptors-system-text-json-source-generation-ergonomics/) walks through the registration shape that survives trimming and AOT.

### Time zone embedded in the property name, not the value

A schema like `{"startedAtUtc": "2026-05-08T14:00:00"}` (no `Z`, but the property name claims UTC) parses to `DateTimeKind.Unspecified`. It does not throw, but it round-trips wrong: `ToUniversalTime` will treat it as local. Either fix the producer to emit the `Z`, or use `DateTimeOffset` so the offset is explicit. Better still, model the value as `DateTime` with a converter that asserts `Kind == Utc` and throws on anything else, the strict-converter pattern catches drift early.

## Variants that look like this error but are not

### "The JSON value could not be converted to System.DateTimeOffset"

Same root cause family, slightly different domain. `DateTimeOffset` requires an explicit offset (`Z` or `+hh:mm`) and rejects `Unspecified`-shaped strings that bare `DateTime` would accept. The fix is the same shape: send the offset, or write a converter. Avoid round-tripping `DateTimeOffset` through a `DateTime` if you have one in the domain, the offset information is data.

### "Cannot get the value of a token type 'Number' as a String"

Different exception, different stack. Means the converter or the default reader called `GetString()` on a JSON `Number` token. The fix is to branch on `reader.TokenType` before reading. The variant 3 converter above is the canonical shape.

### "A possible object cycle was detected"

Reference cycle, not date parsing. Set `ReferenceHandler = ReferenceHandler.IgnoreCycles` (or `Preserve` for full graph round-trip) on the options. Walks through the trade-offs in [the cycle handling guide](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) (the same converter post covers the cycle option in its gotchas section).

### "The JSON value could not be converted to System.Guid"

Identical exception class (`JsonException`), identical message shape, different target type. Cause is similar: the Guid string is not in any of the four formats `System.Text.Json` accepts (`D`, `N`, `B`, `P`). The fix is again either to fix the producer to send `D` (the dashed form) or to write a converter that calls `Guid.ParseExact`.

### "The JSON value could not be converted to System.Enum"

Same family. The fix is `JsonStringEnumConverter` (built-in) registered on the options; the converter accepts both numeric and string forms and is configurable for case sensitivity. Per-enum is also possible with `[JsonConverter(typeof(JsonStringEnumConverter<MyEnum>))]` from .NET 8 onwards, which is preferable under trimming because it does not reflect over every enum in the assembly.

## Related

For the converter scaffolding the fixes above lean on, the [custom JsonConverter walkthrough](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) covers the byte-span parsing tricks for hot paths. The [PascalCase per-member naming post](/2026/04/system-text-json-11-pascalcase-per-member-naming/) shows the `[JsonPropertyName]` and naming-policy escape hatches that solve the related "wrong property name" 400 errors. If your DateTime is being persisted as a JSON column in EF Core 11, the [SQL Server 2025 JSON contains walkthrough](/2026/04/efcore-11-json-contains-sql-server-2025/) explains how the database round-trips the same ISO 8601 string. For the parallel "wrong type" diagnostic with bigger graph implications, the [Newtonsoft to System.Text.Json migration trail](/2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4/) is the canonical case study from the .NET team itself.

## Sources

- [DateTime and DateTimeOffset support in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/datetime/system-text-json-support), Microsoft Learn.
- [How to write custom converters](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/converters-how-to), Microsoft Learn.
- [`DateTimeStyles` enumeration](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.datetimestyles), Microsoft Learn.
- [`DateTimeOffset.FromUnixTimeSeconds`](https://learn.microsoft.com/en-us/dotnet/api/system.datetimeoffset.fromunixtimeseconds), Microsoft Learn.
- [System.Text.Json source repository](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Text.Json), dotnet/runtime on GitHub.
- [`DateOnly` and `TimeOnly` types](https://learn.microsoft.com/en-us/dotnet/api/system.dateonly), Microsoft Learn.
