---
title: "Migrate from Newtonsoft.Json 13 to System.Text.Json in a large .NET 11 codebase"
description: "A version-pinned playbook for swapping Newtonsoft.Json 13.0.4 for the in-box System.Text.Json on .NET 11: the attribute and settings mappings, the defaults that silently change your wire format, a staged rollout strategy, verification, and the gotchas that bite large codebases."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "newtonsoft-json"
  - "system-text-json"
  - "dotnet-11"
---

Swapping `Newtonsoft.Json` for `System.Text.Json` across a large codebase is rarely a find-and-replace job. The two libraries disagree on defaults in ways that change your serialized output and silently break deserialization, so a naive swap ships a contract change to every consumer of your JSON. Budget a few days for a small service and two to four weeks for a sprawling codebase with custom converters, polymorphic payloads, and `dynamic`/`JObject` parsing. The win is real: `System.Text.Json` ships in-box with the runtime, serializes roughly twice as fast with a fraction of the allocations, and is the only one of the two that runs under Native AOT. This post pins `Newtonsoft.Json` 13.0.4 (the current stable, released 2025-12-30) as the source and the in-box `System.Text.Json` on the .NET 11 SDK with C# 14 as the target. If you are still deciding whether to move at all, read [System.Text.Json vs Newtonsoft.Json in 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/) first; this post assumes you have decided to migrate.

## Why migrate now

- `System.Text.Json` is part of the shared framework on .NET 11. Dropping the `Newtonsoft.Json` `PackageReference` removes a transitive dependency that the runtime, ASP.NET Core, and the test platform have all been actively shedding.
- Throughput. On typical POCO payloads `System.Text.Json` serializes around 2x faster than `Newtonsoft.Json` with markedly lower allocations, because it works directly over UTF-8 bytes with `Utf8JsonReader` and `Utf8JsonWriter` rather than going through `string` and `TextReader`.
- Native AOT and trimming. `Newtonsoft.Json` relies on reflection and does not work under Native AOT. `System.Text.Json` has a source-generator mode (`JsonSerializerContext`) that emits trim-safe, AOT-compatible serialization metadata at compile time. If [Native AOT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) is on your roadmap, this migration is a prerequisite, not an optimization.
- Security posture. `System.Text.Json` is strict by default (RFC 8259), escapes HTML-sensitive and non-ASCII characters on output, and does not interpret malformed JSON. That removes a class of injection and parsing surprises that `Newtonsoft.Json`'s permissive defaults allow.

## What breaks

The danger in this migration is not the code that fails to compile. It is the code that compiles fine and changes your wire format. This table is the one to read twice.

| Area                              | Change                                                                                         | Severity |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | -------- |
| Property name matching            | `Newtonsoft.Json` is case-insensitive on read by default; `System.Text.Json` is case-sensitive  | high     |
| Comments and trailing commas      | Accepted by default in `Newtonsoft.Json`, throw `JsonException` in `System.Text.Json`           | high     |
| Single-quoted / unquoted JSON     | Accepted by `Newtonsoft.Json`, rejected by design in `System.Text.Json`                         | high     |
| Non-string into `string` property | `Newtonsoft.Json` coerces `1` or `true`; `System.Text.Json` throws                              | high     |
| Numbers in quotes                 | `Newtonsoft.Json` reads `"23"` into an `int`; `System.Text.Json` needs `NumberHandling`         | medium   |
| Character escaping                | `System.Text.Json` escapes more aggressively, so output bytes differ for non-ASCII and HTML     | medium   |
| `[JsonProperty("name")]`          | Becomes `[JsonPropertyName("name")]`; no combined ignore/required options on one attribute       | medium   |
| `TypeNameHandling.All`            | No equivalent, by design. Polymorphism uses `[JsonDerivedType]` instead                          | high     |
| `JObject` / `JToken` / `dynamic`  | Replaced by `JsonNode` / `JsonDocument` / `JsonElement` with a different API                     | medium   |
| `JsonConvert.PopulateObject`      | No built-in equivalent; needs a custom converter or manual merge                                 | medium   |
| `ReferenceLoopHandling.Ignore`    | No "silently drop the loop" mode; you get `ReferenceHandler.Preserve` or you redesign the graph  | medium   |
| `DateFormatString`, `DateTimeZoneHandling` | No global date format knob; needs a custom `JsonConverter<DateTime>`                    | medium   |
| Converter registration precedence | `Converters` collection now overrides a type-level attribute (reversed from `Newtonsoft.Json`)   | low      |

The authoritative reference for every row here is the [Microsoft migration guide](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft), which also lists the handful of features (`JsonPath` queries, `TypeNameHandling.All`, single-quote parsing) that have no workaround.

## Pre-flight checklist

Do all of this before you delete a single `using Newtonsoft.Json`.

1. Pin the contract. If your JSON crosses a process boundary (a public API, a message queue, a persisted column), capture golden samples of the current output. Serialize a representative set of objects with `Newtonsoft.Json` 13.0.4 and store the strings as test fixtures. These are your regression oracle.
2. Inventory the surface. Grep for everything that touches the old library so you know the size of the job:
   ```bash
   # run from the repo root; counts the call sites you have to touch
   grep -rEl "Newtonsoft\.Json|JsonConvert|JObject|JArray|JToken|JsonProperty|JsonSerializerSettings" --include="*.cs" .
   ```
   Verify: the file list matches your mental model of where serialization lives. Surprises here (a converter buried in a logging helper) are exactly what you want to find now.
3. Flag the no-workaround features. Search specifically for `TypeNameHandling`, `SelectToken`, `SelectTokens`, and single-quote test fixtures. If you find `TypeNameHandling.All` or `.Auto`, stop and design the polymorphism replacement before continuing, because there is no drop-in for it.
4. Confirm the target. Run `dotnet --version` and confirm `11.0.x`. `System.Text.Json` is in-box, so there is no package to add for the core scenarios; you only add `System.Text.Json` as an explicit `PackageReference` if you need a newer out-of-band version than the SDK ships.

## Migration steps

1. **Map the global settings.**

   `Newtonsoft.Json` centralizes behavior in `JsonSerializerSettings`. `System.Text.Json` uses `JsonSerializerOptions`. Translate your existing settings object field by field; do not accept the `System.Text.Json` defaults blindly, because they differ from what your code has been emitting for years.

   ```csharp
   // .NET 11, C# 14
   // BEFORE: Newtonsoft.Json 13.0.4
   var settings = new JsonSerializerSettings
   {
       ContractResolver = new CamelCasePropertyNamesContractResolver(),
       NullValueHandling = NullValueHandling.Ignore,
       ReferenceLoopHandling = ReferenceLoopHandling.Ignore,
   };

   // AFTER: System.Text.Json (in-box on .NET 11)
   var options = new JsonSerializerOptions
   {
       PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
       PropertyNameCaseInsensitive = true,                       // restore Newtonsoft read behavior
       DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
       ReferenceHandler = ReferenceHandler.IgnoreCycles,         // closest match to ReferenceLoopHandling.Ignore
       // AllowTrailingCommas = true,                            // uncomment only if your inputs have them
       // ReadCommentHandling = JsonCommentHandling.Skip,        // uncomment only if your inputs have comments
   };
   ```

   Verify: serialize your golden-sample objects with these `options` and diff against the fixtures from pre-flight step 1. The diff should be empty or explained. `PropertyNameCaseInsensitive = true` is the single most important line for large codebases, because countless deserialization paths quietly depend on `Newtonsoft.Json`'s case-insensitive matching.

2. **Replace the attributes.**

   The attribute rename is mechanical, but `[JsonProperty]` packed several concerns into one attribute that `System.Text.Json` splits apart.

   ```csharp
   // .NET 11, C# 14
   // BEFORE
   public class Order
   {
       [JsonProperty("order_id")]
       public int Id { get; set; }

       [JsonProperty("notes", NullValueHandling = NullValueHandling.Ignore)]
       public string? Notes { get; set; }

       [JsonProperty(Required = Required.Always)]
       public string Customer { get; set; } = "";

       [JsonIgnore]
       public string Internal { get; set; } = "";
   }

   // AFTER
   public class Order
   {
       [JsonPropertyName("order_id")]
       public int Id { get; set; }

       [JsonPropertyName("notes")]
       [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
       public string? Notes { get; set; }

       [JsonRequired]                       // or the C# `required` modifier
       public string Customer { get; set; } = "";

       [JsonIgnore]
       public string Internal { get; set; } = "";
   }
   ```

   Verify: the project compiles with zero `Newtonsoft.Json` `using` directives in the model assembly, and a round-trip test (`Deserialize(Serialize(order))`) preserves every field.

3. **Port the custom converters.**

   This is where the hours go. The shapes are similar but the contracts differ: `System.Text.Json` converters work over `Utf8JsonReader` (a `ref struct`) and `Utf8JsonWriter`, and `Read` is called positioned on the first token.

   ```csharp
   // .NET 11, C# 14 -- a converter that reads/writes DateTime in a fixed format,
   // replacing Newtonsoft's DateFormatString / DateTimeZoneHandling settings.
   public sealed class Iso8601DateTimeConverter : JsonConverter<DateTime>
   {
       public override DateTime Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions o)
           => DateTime.ParseExact(reader.GetString()!, "yyyy-MM-dd'T'HH:mm:ss'Z'",
                                  CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);

       public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions o)
           => writer.WriteStringValue(value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'",
                                      CultureInfo.InvariantCulture));
   }
   ```

   Register it on `options.Converters`, not just as a type attribute, and note the precedence change: in `System.Text.Json` a converter in the `Converters` collection overrides a type-level `[JsonConverter]` attribute, the reverse of `Newtonsoft.Json`. The detailed mechanics are in [how to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/). Verify each ported converter against its own fixture, not just the end-to-end payload, so a precedence surprise does not hide behind a passing integration test.

4. **Replace polymorphism and TypeNameHandling.**

   If you used `TypeNameHandling` to round-trip a class hierarchy, there is no equivalent, and that is deliberate: `TypeNameHandling.All` is a well-known remote-code-execution vector. `System.Text.Json` does discriminated polymorphism with attributes on the base type.

   ```csharp
   // .NET 11, C# 14
   [JsonDerivedType(typeof(Dog), typeDiscriminator: "dog")]
   [JsonDerivedType(typeof(Cat), typeDiscriminator: "cat")]
   public abstract class Animal { public string Name { get; set; } = ""; }

   public sealed class Dog : Animal { public bool GoodBoy { get; set; } }
   public sealed class Cat : Animal { public int Lives { get; set; } }
   ```

   This emits a `"$type": "dog"` discriminator and reads it back to the right subtype. Verify: serialize a `List<Animal>` of mixed subtypes, deserialize it, and assert the runtime types survive. Note the wire format changed (an explicit discriminator string instead of `Newtonsoft.Json`'s assembly-qualified `$type`), so any external consumer must be updated in lockstep.

5. **Convert dynamic and JObject parsing.**

   Code that pokes at untyped JSON via `JObject`/`JToken`/`dynamic` moves to `JsonNode` (mutable) or `JsonDocument`/`JsonElement` (read-only, pooled).

   ```csharp
   // .NET 11, C# 14
   // BEFORE: JObject o = JObject.Parse(json); var name = (string)o["user"]!["name"]!;
   JsonNode root = JsonNode.Parse(json)!;
   string name = root["user"]!["name"]!.GetValue<string>();
   ```

   The one trap: `JsonDocument` owns a pooled buffer and is `IDisposable`, unlike `JObject`. Wrap it in `using` or you leak the rented buffer. Prefer `JsonNode` when you need a `JObject`-like mutable tree. Verify: every former `JObject` access path has a unit test that exercises the same key lookups.

6. **Switch the ASP.NET Core integration.**

   If the codebase calls `AddNewtonsoftJson()` in `Program.cs`, removing it flips the whole pipeline to `System.Text.Json`. ASP.NET Core's web defaults already enable camelCase, case-insensitive matching, and quoted-number reading, so a lot of your manual options become redundant in the MVC path.

   ```csharp
   // .NET 11, C# 14
   // BEFORE: builder.Services.AddControllers().AddNewtonsoftJson();
   builder.Services.AddControllers().AddJsonOptions(o =>
   {
       o.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
       // camelCase + case-insensitive are already on by ASP.NET Core web defaults
   });
   ```

   Watch the depth limit: ASP.NET Core caps `System.Text.Json` `MaxDepth` at 32, not the library default of 64. Deeply nested payloads that worked under `AddNewtonsoftJson()` can start throwing. Verify: run the controller integration tests and confirm no payload trips the depth limit.

## Verification

Run this smoke-test list after each PR, not just at the end:

- The solution builds with zero `Newtonsoft.Json` references in the migrated projects (`grep -r "Newtonsoft" --include="*.csproj"` returns nothing for those projects).
- The golden-sample diff from pre-flight step 1 is empty or every difference is documented and intended.
- The full test suite passes: `dotnet test` reports zero failures.
- A round-trip test (`Deserialize(Serialize(x))`) holds for every model with a custom converter or polymorphic hierarchy.
- For hot paths, run a quick `BenchmarkDotNet` comparison and confirm the throughput and allocation numbers moved the right way rather than regressing because of an accidental per-call `new JsonSerializerOptions()` (always cache and reuse the options instance; constructing it per call is the single most common performance regression in this migration).

## Rollback plan

This migration is reversible per project but not trivially so, because step 1 changes your wire format. The clean strategy is a strangler approach: migrate one assembly or one endpoint at a time, keep `Newtonsoft.Json` referenced until the last consumer is moved, and gate risky endpoints behind a feature flag that can route back to the `Newtonsoft.Json` formatter. Once you have deleted the `PackageReference` and shipped the new wire format to external consumers, rolling back means re-adding the package and reverting the format change everywhere at once, which is a coordinated release, not a `git revert`. Do not delete the package reference until the golden-sample diffs have been green in production telemetry for at least one release cycle.

## Gotchas we hit

- **Silent case-sensitivity data loss.** A config object deserialized from a file with `PascalCase` keys came back with every property at its default because `System.Text.Json` matched case-sensitively against camelCased members. Nothing threw. The fix was `PropertyNameCaseInsensitive = true`, and the lesson was to assert on values, not just on "did it parse".
- **`DateTime` round-trips drifted.** `Newtonsoft.Json`'s `DateTimeZoneHandling` had been quietly normalizing timestamps. `System.Text.Json` reads ISO 8601 round-trip format and preserves the offset, so stored timestamps came back with a different kind. The custom converter in step 3 plus the [JSON value could not be converted to System.DateTime](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) fix resolved it.
- **Object cycles threw instead of being dropped.** `ReferenceLoopHandling.Ignore` had been masking a genuine circular reference in an EF Core navigation property. `System.Text.Json` surfaced it as [a possible object cycle was detected](/2026/05/fix-possible-object-cycle-was-detected-system-text-json/). `ReferenceHandler.IgnoreCycles` is the bridge, but the better fix was a projection DTO that did not have the loop at all.
- **A per-request `new JsonSerializerOptions()` tanked throughput.** Constructing the options object inside a hot handler defeats the internal metadata cache and was slower than the `Newtonsoft.Json` code it replaced. Cache one `static readonly JsonSerializerOptions` and reuse it.

## Sources

- [Microsoft Learn: Migrate from Newtonsoft.Json to System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/migrate-from-newtonsoft)
- [Microsoft Learn: How to customize property names and values](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/customize-properties)
- [Microsoft Learn: Polymorphic serialization with System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/polymorphism)
- [Microsoft Learn: Preserve references and handle circular references](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/preserve-references)
- [Newtonsoft.Json 13.0.4 on NuGet](https://www.nuget.org/packages/newtonsoft.json/)
