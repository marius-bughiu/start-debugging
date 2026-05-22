---
title: "System.Text.Json vs Newtonsoft.Json in 2026: which should you pick?"
description: "Pick System.Text.Json for new .NET 11 code: it ships in-box, is roughly 2x faster, and is the only one that works with Native AOT. Reach for Newtonsoft.Json only for JSONPath, TypeNameHandling, or genuinely lenient JSON."
pubDate: 2026-05-22
template: vs
tags:
  - "comparison"
  - "system-text-json"
  - "newtonsoft-json"
  - "dotnet"
  - "dotnet-11"
---

If you are starting new code on .NET 11 in 2026, use **System.Text.Json**. It ships in-box with the runtime, serializes roughly twice as fast with a fraction of the allocations, and is the only one of the two that runs under Native AOT. Reach for **Newtonsoft.Json** only when you depend on a feature System.Text.Json still does not have: JSONPath queries, `TypeNameHandling`-style type embedding, or parsing genuinely malformed JSON (single quotes, unquoted keys). Both libraries are alive in 2026, but they are no longer equals for greenfield work.

Every example here targets `<TargetFramework>net11.0</TargetFramework>` with the .NET 11 SDK and C# 14. System.Text.Json is the in-box version that ships with .NET 11. Newtonsoft.Json refers to version 13.0.4, released 2025-12-30, the current stable on NuGet.

## The feature matrix at a glance

This is the table you came for. It is the practical version of the official [Microsoft migration guide](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft), reduced to the decisions that actually change which package you reference.

| Concern | System.Text.Json (.NET 11) | Newtonsoft.Json 13.0.4 |
| ------- | -------------------------- | ---------------------- |
| Ships in-box | Yes, part of the runtime | No, NuGet package |
| Throughput (serialize) | Baseline, fastest | ~2x slower |
| Allocations | Span-based, low | Higher |
| Native AOT / trimming | Yes, via source generator | No |
| Default leniency | Strict (RFC 8259) | Lenient |
| Comments / trailing commas | Opt-in | On by default |
| Case-insensitive matching | Opt-in (on in ASP.NET Core) | On by default |
| Polymorphic (de)serialization | Yes, since .NET 7 (`[JsonDerivedType]`) | Yes (`TypeNameHandling`) |
| `TypeNameHandling.All` (embed CLR type) | No, by design | Yes |
| JSONPath / `SelectToken` | No | Yes |
| LINQ-to-JSON DOM | `JsonNode` / `JsonDocument` | `JObject` / `JArray` |
| `DataTable`, `ExpandoObject`, `BigInteger` | Custom converter required | Built-in |
| Single quotes, unquoted keys | Rejected, by design | Accepted |
| Maintenance status | Active development | Maintenance mode |
| License | MIT | MIT |

The headline is that the rows where Newtonsoft.Json still wins are narrow and specific, while the rows where System.Text.Json wins (in-box, AOT, speed) apply to almost every new project.

## When to pick System.Text.Json

Pick it as the default for anything new on .NET 11. Concretely:

- **ASP.NET Core APIs.** The framework already uses System.Text.Json internally and configures the web-friendly defaults for you: camelCase property names, case-insensitive matching, and quoted-number support. Adding `Microsoft.AspNetCore.Mvc.NewtonsoftJson` to get the old behavior is a step backward unless a specific feature forces it.
- **Anything that will run under Native AOT or aggressive trimming.** This is not a preference, it is a hard requirement. System.Text.Json has a [source generator](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) that emits serialization metadata at compile time, so no reflection is needed at runtime. Newtonsoft.Json is built on runtime reflection and `Reflection.Emit`, which AOT does not allow. If you care about the trade-offs there, see the breakdown of [Native AOT versus ReadyToRun versus JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).
- **High-throughput or memory-sensitive paths.** Serializers, log shippers, message-bus consumers, anything that runs in a tight loop. System.Text.Json works over `ReadOnlySpan<byte>` and UTF-8 directly, avoiding the string-intermediate allocations Newtonsoft.Json makes.
- **You want spec-compliant, deterministic output.** System.Text.Json follows RFC 8259 strictly. It escapes HTML-sensitive characters by default as a defense-in-depth measure against XSS and information disclosure, which matters when the JSON is embedded in a page.

A source-generated context is the pattern that unlocks AOT and the fastest startup:

```csharp
// .NET 11, C# 14 - compile-time metadata, no runtime reflection
using System.Text.Json;
using System.Text.Json.Serialization;

[JsonSerializable(typeof(WeatherForecast))]
public partial class AppJsonContext : JsonSerializerContext;

var forecast = new WeatherForecast(DateOnly.FromDateTime(DateTime.Now), 22, "Mild");

// Pass the generated TypeInfo, not the raw type, to stay reflection-free
string json = JsonSerializer.Serialize(forecast, AppJsonContext.Default.WeatherForecast);

public record WeatherForecast(DateOnly Date, int TemperatureC, string Summary);
```

System.Text.Json has also closed most of the historical gaps. Since .NET 7 it does polymorphic (de)serialization through `[JsonDerivedType]`, and .NET 9 added several long-requested options: `RespectNullableAnnotations` to honor non-nullable reference types, the `JsonStringEnumMemberName` attribute to rename enum values, and `JsonSchemaExporter` to produce a JSON schema from a .NET type. .NET 10 added direct deserialization from a `PipeReader` and a one-line strict preset:

```csharp
// .NET 10 and later - the strict, spec-compliant defaults in one preset
var options = JsonSerializerOptions.Strict;

// .NET 10 and later - deserialize straight from a PipeReader, no stream adapter
WeatherForecast? f = await JsonSerializer.DeserializeAsync<WeatherForecast>(pipeReader);
```

## When to pick Newtonsoft.Json

There are still real reasons to reach for it. Pick Newtonsoft.Json when you hit one of these:

- **You need JSONPath queries.** `SelectToken("$.store.book[0].title")` has no built-in equivalent in System.Text.Json. `JsonNode` lets you navigate by indexer, but there is no path-query engine. If you parse arbitrary documents and pull values by path, Newtonsoft.Json is far less code.
- **You depend on `TypeNameHandling`.** Newtonsoft.Json can embed the CLR type name in the payload (`$type`) and reconstruct the exact runtime type on the way back. System.Text.Json refuses to do this by design, because deserializing an attacker-controlled type name is a well-known remote-code-execution vector. If you have an existing internal protocol that relies on it, migration is not a config flag, it is a redesign.
- **You parse genuinely lenient or non-standard JSON.** Single-quoted strings, unquoted property names, and other non-RFC input are accepted by Newtonsoft.Json and rejected by System.Text.Json by design. Comments and trailing commas are opt-in on System.Text.Json (`ReadCommentHandling`, `AllowTrailingCommas`) but single quotes and bare keys cannot be enabled at all.
- **You serialize types without built-in support.** `DataTable`, `ExpandoObject`, `TimeZoneInfo`, `BigInteger`, `DBNull`, and `ValueTuple` all need a custom converter in System.Text.Json. Newtonsoft.Json handles them out of the box.

The default-leniency difference is the one that bites during a migration. The same payload behaves differently:

```csharp
// Newtonsoft.Json 13.0.4 - lenient by default, this parses fine
using Newtonsoft.Json;

var config = JsonConvert.DeserializeObject<Config>("""
{
    "Name": "api", // inline comment
    "Retries": 3,
}
""");

public record Config(string Name, int Retries);
```

```csharp
// .NET 11, System.Text.Json - strict by default, the same input throws JsonException
using System.Text.Json;

// You must opt in to match Newtonsoft.Json's leniency
var options = new JsonSerializerOptions
{
    ReadCommentHandling = JsonCommentHandling.Skip,
    AllowTrailingCommas = true,
    PropertyNameCaseInsensitive = true
};
var config = JsonSerializer.Deserialize<Config>(input, options);
```

That strictness is the most common source of the post-migration surprise where a payload that worked for years suddenly throws, which is also why errors like a [JSON value that could not be converted](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) or a [DateTime that fails to parse](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) show up right after a switch.

## What the benchmarks actually show

Performance is the easiest claim to hand-wave, so here are concrete numbers rather than the word "faster." Published BenchmarkDotNet runs on .NET 10 serializing a collection of 10,000 simple POCO objects show System.Text.Json finishing in about 3.7 ms while allocating 3.4 MB, versus Newtonsoft.Json at about 7.6 ms and 8.1 MB for the same workload.

| Metric (serialize 10,000 POCOs) | System.Text.Json | Newtonsoft.Json 13.x |
| ------------------------------- | ---------------- | -------------------- |
| Mean time | ~3.7 ms | ~7.6 ms |
| Allocated | ~3.4 MB | ~8.1 MB |
| Relative | 1.0x (baseline) | ~2.0x slower, ~2.4x memory |

Methodology and caveats matter, so read these numbers honestly:

- The figures above come from a public .NET 10 benchmark (BenchmarkDotNet, default release config) and are representative, not gospel. Run BenchmarkDotNet against your own object shapes before quoting a number in a design review.
- The gap is largest for simple POCOs and large collections, exactly the shape that dominates web APIs and message pipelines.
- For tiny payloads (a single small object per request) the absolute difference is microseconds and rarely the bottleneck. Choose on the other axes there.
- Source generation widens the gap further for System.Text.Json because it removes per-call reflection. Newtonsoft.Json has no equivalent.

The summary is consistent across every credible benchmark in 2025 and 2026: System.Text.Json is roughly twice as fast and allocates roughly half to a third as much for the common case. The margin has not narrowed in Newtonsoft.Json's favor.

## The gotchas that pick for you

Sometimes one constraint settles the decision before preferences enter the room.

**Native AOT is a hard gate.** If your deployment target requires AOT (a trimmed container, a scale-to-zero function, an iOS build), Newtonsoft.Json is simply not an option. It depends on runtime reflection that AOT does not provide. This single fact disqualifies it for an entire class of modern .NET workloads.

**Maintenance trajectory.** Newtonsoft.Json is not dead and not deprecated. James Newton-King, who now works at Microsoft on System.Text.Json itself, still ships security and bug-fix releases (13.0.4 landed 2025-12-30). But it is explicitly in maintenance mode: no major feature work, no AOT story coming. System.Text.Json gets new capabilities every .NET release. Betting new code on the library that is actively evolving is the lower-risk choice for a system you will maintain for years.

**Reference handling and object cycles differ.** Newtonsoft.Json has `ReferenceLoopHandling` and `PreserveReferencesHandling`. System.Text.Json maps these to `ReferenceHandler.IgnoreCycles` and `ReferenceHandler.Preserve`, but the behavior is not identical (`IgnoreCycles` writes `null` where Newtonsoft.Json drops the property). If you serialize EF Core entity graphs, this is the difference between a clean payload and a [possible-object-cycle exception](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/). Know which handler you need before you migrate.

**The licenses are identical.** Both ship under MIT, so unlike the MediatR or AutoMapper situation, licensing is not a factor here. Do not let "is Newtonsoft.Json still free" drive the decision: it is, and so is System.Text.Json.

## The call, in one line

For new .NET 11 code in 2026: default to System.Text.Json, and only add Newtonsoft.Json when you hit a concrete, named feature it cannot do (JSONPath, `TypeNameHandling`, lenient parsing, or an unsupported type with no converter). It is in-box, faster, AOT-ready, and the one Microsoft is still building. Keep Newtonsoft.Json on existing systems that depend on its flexibility; do not rush a migration that has no payoff, but do not start there either. The strategic default flipped years ago, and in 2026 the gap is wide enough that the burden of proof is on choosing Newtonsoft.Json, not on choosing the in-box library.

## Related

- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/)
- [Fix: a possible object cycle was detected with System.Text.Json](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/)
- [Fix: the JSON value could not be converted](/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/)
- [Fix: the JSON value could not be converted to System.DateTime](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)

## Sources

- [Migrate from Newtonsoft.Json to System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft) - the authoritative feature-difference table and default-behavior list.
- [What's new in System.Text.Json in .NET 9](https://devblogs.microsoft.com/dotnet/system-text-json-in-dotnet-9/) - nullable annotations, enum member names, schema exporter.
- [JsonSerializer.DeserializeAsync (PipeReader overload)](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.deserializeasync?view=net-10.0) - the .NET 10 streaming API.
- [Newtonsoft.Json releases](https://github.com/JamesNK/Newtonsoft.Json/releases) - version 13.0.4 and the current maintenance cadence.
