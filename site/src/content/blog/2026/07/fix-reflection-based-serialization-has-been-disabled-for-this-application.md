---
title: "Fix: Reflection-based serialization has been disabled for this application"
description: "This InvalidOperationException means PublishTrimmed or PublishAot flipped JsonSerializerIsReflectionEnabledByDefault to false. Fix it with a source-generated JsonSerializerContext."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "system-text-json"
  - "trimming"
  - "native-aot"
---

Your project has `PublishTrimmed` or `PublishAot` set to `true`, and the .NET SDK responded by setting `JsonSerializerIsReflectionEnabledByDefault` to `false`. That turns off the reflection-based contract resolver that `JsonSerializer.Serialize(obj)` silently relies on. The fix is to give the serializer a contract source: add a `partial class` deriving from `JsonSerializerContext`, annotate it with `[JsonSerializable(typeof(YourType))]`, and pass `MyContext.Default.YourType` (or set `options.TypeInfoResolver = MyContext.Default`) at every call site.

```text
System.InvalidOperationException: Reflection-based serialization has been disabled for this application. Either use the source generator APIs or explicitly configure the 'JsonSerializerOptions.TypeInfoResolver' property.
   at System.Text.Json.ThrowHelper.ThrowInvalidOperationException_JsonSerializerIsReflectionDisabled()
   at System.Text.Json.JsonSerializerOptions.ConfigureForJsonSerializer()
   at System.Text.Json.JsonSerializerOptions.GetTypeInfoForRootType(Type type, Boolean fallBackToNearestAncestorType)
   at System.Text.Json.JsonSerializer.Serialize[TValue](TValue value, JsonSerializerOptions options)
   at MyApp.Program.Main(String[] args)
```

The exact string comes from the `JsonSerializerIsReflectionDisabled` resource in `System.Text.Json`, and it has been worded the same way since .NET 8. Everything below targets the .NET 11 SDK (`11.0.100`) and C# 14, but the behaviour is identical on `net8.0` and later, because that is when the switch was introduced.

## Why a project you never configured has reflection turned off

`System.Text.Json` resolves the shape of a type in one of two ways: at runtime with reflection (`DefaultJsonTypeInfoResolver`), or at compile time with the source generator (`JsonSerializerContext`). When you call `JsonSerializer.Serialize(obj)` with no options, it falls back to the reflection resolver.

Reflection does not survive trimming. The trimmer removes members it cannot prove are reachable, and property getters that only ever get invoked through `PropertyInfo` are exactly that: unreachable to static analysis. Before .NET 8, a trimmed app would happily serialize and just quietly drop properties the trimmer had deleted. Silent data loss is worse than a crash, so .NET 8 changed the default: setting `PublishTrimmed` to `true` [automatically sets `JsonSerializerIsReflectionEnabledByDefault` to `false`](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed) unless you say otherwise. `PublishAot` implies `PublishTrimmed`, so Native AOT apps inherit the same default.

The MSBuild property is not the mechanism, only the switch. The SDK turns it into a runtime host configuration option:

```xml
<!-- Microsoft.NET.Sdk.targets, .NET 11 SDK -->
<RuntimeHostConfigurationOption Include="System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault"
                                Condition="'$(JsonSerializerIsReflectionEnabledByDefault)' != ''"
                                Value="$(JsonSerializerIsReflectionEnabledByDefault)"
                                Trim="true" />
```

That lands in your `.runtimeconfig.json` as an `AppContext` switch, and `Trim="true"` tells ILLink to treat it as a link-time constant so the reflection code paths can be removed entirely. `JsonSerializer.IsReflectionEnabledByDefault` reads that switch and [defaults to `true` when it is unset](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.isreflectionenabledbydefault).

Two things follow from this that explain most of the confused bug reports. First, the switch is per-app, not per-library: a NuGet package cannot turn it off for you, and you cannot turn it on for one assembly. Second, the throw happens on first use, not at startup. `JsonSerializerOptions.Default` is constructed with `JsonTypeInfoResolver.Empty` rather than the reflection resolver, and `ConfigureForJsonSerializer` only raises the exception when a serialize or deserialize call finds an empty resolver. So a code path that runs once a week is where you will find out.

## The minimal repro

Three lines of project file and one line of C#:

```xml
<!-- MyApp.csproj, .NET 11 SDK 11.0.100 -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <PublishTrimmed>true</PublishTrimmed>
</PropertyGroup>
```

```csharp
// .NET 11, C# 14
using System.Text.Json;

var json = JsonSerializer.Serialize(new { Value = 42 });
// System.InvalidOperationException: Reflection-based serialization has been disabled...
```

Note where `PublishTrimmed` lives. Because the property flows into `runtimeconfig.json` at **build** time, putting it in the project file means `dotnet run` in Debug throws too. If instead you only pass it on the publish command line (`dotnet publish -p:PublishTrimmed=true`), your local `dotnet run` keeps working and only the published artifact fails, which is the version of this bug that reaches production. The trimming docs recommend the project file [precisely so the setting applies during `dotnet build`](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options).

To confirm you are looking at this and not something else, check the build output:

```bash
cat bin/Debug/net11.0/MyApp.runtimeconfig.json
```

```json
{
  "runtimeOptions": {
    "tfm": "net11.0",
    "configProperties": {
      "System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault": false
    }
  }
}
```

Or assert it in code, which also works for Native AOT where there is no runtimeconfig file to read:

```csharp
// .NET 11, C# 14
Console.WriteLine(JsonSerializer.IsReflectionEnabledByDefault); // False
```

## Fix 1: ship a JsonSerializerContext and use it everywhere

This is the fix the error message is asking for and the only one that leaves you with a genuinely trim-safe app. Declare a partial context, list every root type you serialize, and route calls through it.

```csharp
// .NET 11, C# 14, System.Text.Json 11.0.0
using System.Text.Json;
using System.Text.Json.Serialization;

public record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WeatherForecast))]
[JsonSerializable(typeof(List<WeatherForecast>))]
internal partial class AppJsonContext : JsonSerializerContext;
```

Then pick one of the three supported call shapes:

```csharp
// .NET 11, C# 14
// 1. Strongly typed, zero options plumbing. Preferred.
string json = JsonSerializer.Serialize(forecast, AppJsonContext.Default.WeatherForecast);
WeatherForecast? back = JsonSerializer.Deserialize(json, AppJsonContext.Default.WeatherForecast);

// 2. Through options, when an API forces you to hand it a JsonSerializerOptions.
var options = new JsonSerializerOptions { TypeInfoResolver = AppJsonContext.Default };
json = JsonSerializer.Serialize(forecast, options);

// 3. Non-generic, when the type is only known at runtime.
json = JsonSerializer.Serialize(forecast, typeof(WeatherForecast), AppJsonContext.Default);
```

Set your options on `[JsonSourceGenerationOptions]` rather than on a `JsonSerializerOptions` instance where you can. The generated `Default` property is then preconfigured at compile time, so you cannot forget to apply naming policy on one of six call sites. Collections need their own `[JsonSerializable]` entry (`List<WeatherForecast>` above), and members declared as `object` need every possible runtime type registered, because the generator has nothing else to go on.

## Fix 2: wire the context into ASP.NET Core, HttpClient, and Blazor

Most apps do not call `JsonSerializer` directly. They hand a type to a framework method that calls it for them, and those need the resolver installed once at startup.

For minimal APIs, including the Native AOT template that uses `CreateSlimBuilder`:

```csharp
// .NET 11, ASP.NET Core 11
var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});
```

For MVC and Web API controllers:

```csharp
// .NET 11, ASP.NET Core 11
builder.Services.AddControllers().AddJsonOptions(static options =>
    options.JsonSerializerOptions.TypeInfoResolverChain.Add(AppJsonContext.Default));
```

For `HttpClient`, use the overloads that take a `JsonTypeInfo<T>` instead of the ones that infer it:

```csharp
// .NET 11, C# 14
var forecast = await client.GetFromJsonAsync("/weather", AppJsonContext.Default.WeatherForecast);
await client.PostAsJsonAsync("/weather", forecast, AppJsonContext.Default.WeatherForecast);
```

`TypeInfoResolverChain` is worth knowing about on its own: options query each resolver in order and take the first non-null result, so you can compose several contexts across projects with `JsonTypeInfoResolver.Combine(ContextA.Default, ContextB.Default)` or insert one ahead of the framework's own.

## Fix 3: opt back into reflection at the call site, without touching MSBuild

The error message offers a second escape: "explicitly configure the `JsonSerializerOptions.TypeInfoResolver` property". The reflection resolver is still a public type, and constructing it does not check the switch:

```csharp
// .NET 11, C# 14. Works in a trimmed app. Does NOT work under Native AOT.
var options = new JsonSerializerOptions
{
    TypeInfoResolver = new DefaultJsonTypeInfoResolver()
};
string json = JsonSerializer.Serialize(new { Value = 42 }, options);
```

Understand what you are buying. The exception goes away because you asked for reflection by name, but the trimmer already deleted the members it thought were unused. You get serialization that runs and quietly emits an incomplete object, which is the exact failure mode the .NET 8 change existed to prevent. Under Native AOT it is worse: `DefaultJsonTypeInfoResolver` is annotated `[RequiresDynamicCode]`, so you trade `InvalidOperationException` for a `PlatformNotSupportedException` or a missing-metadata failure at runtime. Treat this as a diagnostic step (does my payload survive trimming?) rather than a fix.

The pattern that is genuinely useful is the conditional resolver, which the docs recommend for libraries that must work in both worlds:

```csharp
// .NET 11, C# 14
static JsonSerializerOptions CreateDefaultOptions() => new()
{
    TypeInfoResolver = JsonSerializer.IsReflectionEnabledByDefault
        ? new DefaultJsonTypeInfoResolver()
        : AppJsonContext.Default
};
```

Because `IsReflectionEnabledByDefault` is substituted as a link-time constant, ILLink folds the branch away and never roots the reflection resolver in an AOT build.

## Fix 4: turn the switch back on, and when that is defensible

You can restore .NET 7 behaviour with one property:

```xml
<!-- MyApp.csproj, .NET 11 SDK -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
  <JsonSerializerIsReflectionEnabledByDefault>true</JsonSerializerIsReflectionEnabledByDefault>
</PropertyGroup>
```

Do this when a third-party dependency calls `JsonSerializer.Serialize` on its own types deep inside its own code and ships no `JsonSerializerContext`. You cannot rewrite its call sites, and a source generator in your assembly does not help, because the resolver has to be attached to the options instance the library creates. Several widely used packages have hit this: it produced bug reports against the Azure App Configuration provider and the ASP.NET Core Swagger UI endpoint, among others.

Two caveats. First, this reintroduces silent data loss: the reflection resolver will run, but only over the members that survived trimming, so test the actual published artifact against real payloads rather than trusting a passing `dotnet run`. Second, if you are on Native AOT, flipping this property does not make reflection work; it only removes the guard rail that was telling you the truth early.

## Gotchas that send people to the wrong fix

**The next error is `NoMetadataForType`.** After you add a context, a type you forgot to annotate throws `JsonTypeInfo metadata for type 'X' was not provided by TypeInfoResolver of type 'Y'`. That is progress, not a regression: it names the missing type. Add a `[JsonSerializable(typeof(X))]` for it, including for collection types and for every subtype you serialize polymorphically. If you use `[JsonDerivedType]`, every derived type needs its own entry, which the guide to [polymorphic serialization with `JsonDerivedType`](/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/) covers in detail.

**There is no build-time warning.** The obvious ask, an analyzer that flags `JsonSerializer.Serialize(x)` when the switch is off, was filed as [dotnet/runtime#107440](https://github.com/dotnet/runtime/issues/107440) and closed as not planned. Trim analysis warnings (`IL2026`, `IL3050`) will point at reflection-based serialization in your own code, so treat a clean trim-analysis build as the closest thing to a compile-time check. Getting there is the subject of [writing trim-safe code](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/).

**In .NET MAUI it only reproduces in Release, or only on device.** MAUI sets the trimming properties for you: Android and Mac Catalyst use partial trimming for Release builds, and iOS uses it for any device build regardless of configuration, while simulator builds are not trimmed at all. So "works in the simulator, throws on a real iPhone" and "works in Debug, throws in Release" are the same bug. Do not set `PublishTrimmed` yourself in a MAUI project; the SDK owns it.

**A `PlatformNotSupportedException` is a different error.** If your stack trace mentions `Reflection.Emit` or expression-tree compilation rather than `ConfigureForJsonSerializer`, you are looking at AOT's missing JIT, not the JSON switch. That one is covered in the post on [`PlatformNotSupportedException` in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/).

**The non-generic `JsonStringEnumConverter` is not AOT-supported.** Once you are on source generation, replace it with `JsonStringEnumConverter<TEnum>` on the enum, or set `UseStringEnumConverter = true` on `[JsonSourceGenerationOptions]`. The same constraint applies to hand-written converters, which is worth checking against the rules for [writing a custom `JsonConverter`](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

**Deliberately opting in is a valid choice.** If you want this error in a non-trimmed app so that AOT incompatibilities surface on CoreCLR during development, set `JsonSerializerIsReflectionEnabledByDefault` to `false` yourself. Its behaviour is consistent across CoreCLR and Native AOT, which is exactly why it makes a good early-warning system. That standalone use of the property is covered in the older note on [disabling reflection-based serialization](/2023/10/system-text-json-disable-reflection-based-serialization/).

## Related

- [What is trim-safe code and how do I write it?](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/)
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Fix: PlatformNotSupportedException in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/)
- [How to serialize a polymorphic type hierarchy with JsonDerivedType](/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)

## Sources

- [Breaking change: PublishTrimmed projects fail reflection-based serialization](https://learn.microsoft.com/en-us/dotnet/core/compatibility/serialization/8.0/publishtrimmed) - MS Learn
- [How to use source generation in System.Text.Json](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/source-generation), including the "Disable reflection defaults" section - MS Learn
- [JsonSerializer.IsReflectionEnabledByDefault property](https://learn.microsoft.com/en-us/dotnet/api/system.text.json.jsonserializer.isreflectionenabledbydefault) - MS Learn
- [Trimming options](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trimming-options) - MS Learn
- [Trim a .NET MAUI app](https://learn.microsoft.com/en-us/dotnet/maui/deployment/trimming), for the per-platform trimming defaults - MS Learn
- [System.Text.Json analyzers should warn about using reflection when reflection is disabled](https://github.com/dotnet/runtime/issues/107440) - dotnet/runtime
- [`JsonSerializerOptions.ConfigureForJsonSerializer`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Text.Json/src/System/Text/Json/Serialization/JsonSerializerOptions.cs) and the `JsonSerializerIsReflectionDisabled` string resource - dotnet/runtime
