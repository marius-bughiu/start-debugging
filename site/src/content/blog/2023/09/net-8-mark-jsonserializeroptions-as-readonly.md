---
title: ".NET 8 – Mark JsonSerializerOptions as readonly"
description: "Freeze JsonSerializerOptions with MakeReadOnly, fix the missing TypeInfoResolver error, and create a mutable copy in a runnable .NET 8 example."
pubDate: 2023-09-11
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
---
Starting with .NET 8, `JsonSerializerOptions.MakeReadOnly()` freezes an options instance. Configure its `TypeInfoResolver` first: a fresh options object has no resolver, so calling the parameterless method immediately throws `InvalidOperationException`.

> **Correction — November 2, 2026:** The previous example omitted its resolver and therefore failed at `MakeReadOnly()`. The example below uses generated metadata and also works with reflection defaults disabled.

## Freeze configured options

This complete `Program.cs` uses a source-generated resolver, serializes with the frozen options, rejects a later change, and creates an independently configurable copy:

```cs
using System.Text.Json;
using System.Text.Json.Serialization;

var options = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseUpper
};
options.MakeReadOnly();
Console.WriteLine(options.IsReadOnly);
Console.WriteLine(JsonSerializer.Serialize(new Widget(42, "Ada"), options));

try
{
    options.WriteIndented = true;
}
catch (InvalidOperationException)
{
    Console.WriteLine("Mutation rejected");
}

var copy = new JsonSerializerOptions(options);
Console.WriteLine(copy.IsReadOnly);
copy.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
Console.WriteLine(JsonSerializer.Serialize(new Widget(42, "Ada"), copy));

public sealed record Widget(int Id, string Name);

[JsonSerializable(typeof(Widget))]
internal partial class DemoJsonContext : JsonSerializerContext { }
```

The output is:

```text
True
{"ID":42,"NAME":"Ada"}
Mutation rejected
False
{"id":42,"name":"Ada"}
```

`IsReadOnly` becomes `true` after freezing. Repeating `MakeReadOnly()` is safe. Changing a setting afterwards throws `InvalidOperationException`. Serialization or deserialization also makes the options instance read-only.

The copy constructor retains the source settings, including the resolver, but creates a mutable options instance. Configure the copy before first use; serializing with it freezes that copy too.

## Why does MakeReadOnly throw without a resolver?

`new JsonSerializerOptions().MakeReadOnly()` does not select a resolver automatically. Supply one explicitly, as above, or use `MakeReadOnly(populateMissingResolver: true)` when reflection-based serialization is intended and enabled.

The latter overload fills a missing resolver with the reflection-based default. With reflection defaults disabled, it cannot fill that gap and throws `InvalidOperationException`. It is not a replacement for generated metadata in a trimmed or Native AOT application. See [disabling reflection defaults and configuring a context](/2023/10/system-text-json-disable-reflection-based-serialization/) and the [MakeReadOnly API contract](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializeroptions.makereadonly?view=net-8.0).

## Run the verified example

[Download the complete System.Text.Json options project](/examples/system-text-json-options.zip), extract it, and run:

```sh
dotnet run -c Release
```

The dependency-free .NET 8 project checks missing resolvers, repeated freezing, rejected mutation, source-generated serialization, and copy behavior. It separately exercises `populateMissingResolver` with reflection defaults disabled and enabled. All checks passed on actual .NET 8.0.33 and .NET 10.0.10 runtimes; commands and results are in the archive's verification record.
