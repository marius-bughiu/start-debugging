---
title: "System.Text.Json – Disable reflection-based serialization"
description: "Disable System.Text.Json reflection defaults, diagnose InvalidOperationException, and serialize with a source-generated context in a runnable .NET 8 example."
pubDate: 2023-10-21
updatedDate: 2026-11-02
tags:
  - "dotnet"
  - "dotnet-8"
---
Starting with .NET 8, set `JsonSerializerIsReflectionEnabledByDefault` to `false` to disable the default reflection fallback in `System.Text.Json`. Then supply serialization metadata through a source-generated context.

> **Correction — November 2, 2026:** The previous version named the wrong exception and implied that passing options alone was sufficient. With reflection defaults disabled, an ordinary serialization call throws `InvalidOperationException`; empty options do not fix it.

## Disable reflection defaults

Add this property inside your `.csproj`:

```xml
<PropertyGroup>
  <JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>
</PropertyGroup>
```

With that setting, both `JsonSerializer.Serialize(widget)` and `JsonSerializer.Serialize(widget, new JsonSerializerOptions())` fail. Creating an options object does not provide the missing type metadata. `JsonSerializer.IsReflectionEnabledByDefault` reports the switch's effective value.

This switch controls the serializer's default reflection path; it does not disable all reflection in the application. Since .NET 8, enabling `PublishTrimmed` also disables these defaults unless you explicitly override the setting. See [Microsoft's trimming compatibility note](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed).

## Serialize and deserialize with generated metadata

Use this complete `Program.cs` in a .NET 8 console project with the property above:

```cs
using System.Text.Json;
using System.Text.Json.Serialization;

Console.WriteLine(JsonSerializer.IsReflectionEnabledByDefault);
var widget = new Widget(42, "Ada");
string json = JsonSerializer.Serialize(widget, DemoJsonContext.Default.Widget);
Widget restored = JsonSerializer.Deserialize(json, DemoJsonContext.Default.Widget)!;
Console.WriteLine(json);
Console.WriteLine($"Round trip: {restored.Id} {restored.Name}");

public sealed record Widget(int Id, string Name);

[JsonSerializable(typeof(Widget))]
internal partial class DemoJsonContext : JsonSerializerContext { }
```

The output is:

```text
False
{"Id":42,"Name":"Ada"}
Round trip: 42 Ada
```

The `[JsonSerializable]` attribute registers `Widget`, and the context supplies its generated `JsonTypeInfo<Widget>` directly. A separate options instance is unnecessary for these overloads.

If an API accepts `JsonSerializerOptions` instead, configure its resolver explicitly:

```cs
var options = new JsonSerializerOptions
{
    TypeInfoResolver = DemoJsonContext.Default
};
string json = JsonSerializer.Serialize(widget, options);
```

Register the actual root types you serialize, including collections where needed. If your models contain enums, see [using JsonStringEnumConverter with Native AOT](/2023/09/net-8-how-to-use-jsonstringenumconverter-with-native-aot/). To freeze configured options for reuse, see [MakeReadOnly and its resolver requirement](/2023/09/net-8-mark-jsonserializeroptions-as-readonly/).

## Run the verified example

[Download the complete System.Text.Json options project](/examples/system-text-json-options.zip), extract it, and run:

```sh
dotnet run -c Release
```

The dependency-free project targets .NET 8 and checks the failing default calls, the generated round trip, and the options-resolver path. It also tests the read-only options scenarios. All checks ran on actual .NET 8.0.33 and .NET 10.0.10 runtimes; the archive records the separate commands. The same project also published and ran as .NET 8 Native AOT on macOS arm64. Its intentional failure checks and reflection-sensitive overloads produce analysis warnings; the verification record lists them.

See [Microsoft's source-generation guide](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation) for supported types and application integration.
