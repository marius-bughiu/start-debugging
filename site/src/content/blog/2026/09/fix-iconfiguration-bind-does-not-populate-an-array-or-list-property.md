---
title: "Fix: IConfiguration.Bind does not populate an array or List<T> property from appsettings.json"
description: "The binder silently skips array properties without a public setter, get-only IReadOnlyList<T>, fields and init-only members under the source generator, and it appends to defaults instead of replacing them. Measured on .NET 10.0.12 and 11 RC 1."
pubDate: 2026-09-23
template: how-to
tags:
  - "dotnet-10"
  - "dotnet-11"
  - "configuration"
  - "options-pattern"
  - "aspnetcore"
---

**Short answer:** `ConfigurationBinder` never throws when it cannot bind a collection. It just leaves the property alone. The usual reasons are: the property is an array (or `IReadOnlyList<T>`, `IEnumerable<T>`) with no public setter, it is a public field instead of a property, the section name you passed to `GetSection` does not match the JSON, or you turned on Native AOT or trimming, which switches the binder to its source generator, and the generator ignores `init` accessors. Give the property a public `get; set;`, bind the right section, and turn on `ErrorOnUnknownConfiguration` so the next mismatch fails loudly. If the list binds but has *extra* items, that is the other half of this bug: the binder appends to whatever the property already contains, it never replaces it.

Everything below was measured with a file-based probe on SDK 10.0.302 against `Microsoft.Extensions.Configuration.Binder` 10.0.12, then repeated with 11.0.0-rc.1.26425.128 on the .NET 11 RC 1 SDK. Every row was identical across the two versions. The differences that matter are between the reflection binder and the source-generated binder, not between .NET 10 and 11.

## Why the binder silently skips a collection

The reflection binder in `ConfigurationBinder.cs` decides per property whether it can write to it. The check is short: it needs a public getter, and for anything it has to *replace* rather than *mutate* it also needs a public setter (or `BinderOptions.BindNonPublicProperties = true`). If the check fails, `BindProperty` returns without a word.

That split between "replace" and "mutate" explains most of the confusing cases:

- An **array** can never be mutated in place, because it has a fixed length. The binder builds a new array and needs a setter to store it. `string[] Hosts { get; } = [];` stays empty forever.
- A **`List<T>` or `IList<T>`** that already holds an instance can be mutated. The binder calls `Add` on it, so a get-only `List<string> Hosts { get; } = new();` binds fine.
- An **`IReadOnlyList<T>`** or **`IEnumerable<T>`** has no `Add`. With a setter, the binder creates a new array and assigns it. Without a setter, nothing happens.

Element conversion errors are also swallowed. In `BindArray` and `BindCollection`, each element is bound inside a `try`/`catch` that only rethrows when `ErrorOnUnknownConfiguration` is set. A value like `"abc"` in an `int[]` simply disappears from the result.

## The measured matrix

The probe binds `{ "App": { "Hosts": [ "a.example", "b.example" ] } }` into different shapes of options class, once with the default reflection binder and once with `EnableConfigurationBindingGenerator=true`:

```csharp
// .NET 10.0.12 / .NET 11 RC 1, Microsoft.Extensions.Configuration.Binder
class GetOnlyArray { public string[] Hosts { get; } = []; }
class GetOnlyList { public List<string> Hosts { get; } = new(); }
class GetOnlyRoList { public IReadOnlyList<string> Hosts { get; } = []; }
class FieldArray { public string[] Hosts = []; }
class PrivateSet { public string[] Hosts { get; private set; } = []; }
class InitOnly { public string[] Hosts { get; init; } = []; }
class Settable { public string[] Hosts { get; set; } = []; }
```

| Property shape | Reflection binder | Source generator |
| --- | --- | --- |
| `string[] { get; }` | `[]` | `[]` |
| `List<string> { get; } = new()` | `[a, b]` | `[a, b]` |
| `IReadOnlyList<string> { get; } = []` | `[]` | `[]` |
| `IList<string> { get; } = new List<string>()` | `[a, b]` | `[a, b]` |
| `string[]` public field | `[]` | `[]` |
| `string[] { get; private set; }` | `[]` | `[]` |
| same, `BindNonPublicProperties = true` | `[a, b]` | `NotSupportedException` |
| `string[] { get; init; }` | `[a, b]` | `[]` |
| `string[] { get; set; }` | `[a, b]` | `[a, b]` |
| `record Opts(string[] Hosts)` via `Get<T>()` | `[a, b]` | `[a, b]` |
| `ImmutableArray<string> { get; set; }` | `[]` | `NullReferenceException` |

Three rows deserve a second look. `init` accessors work with reflection and are silently skipped by the generator. `ImmutableArray<T>` is never populated. And the generator build of this probe reported **zero** warnings, so nothing at compile time tells you about either of those.

## Fix it step by step

1. **Confirm the section path.** `builder.Configuration.GetSection("App")` must match the JSON exactly up to the property name (matching is case-insensitive, so casing is not your problem). Binding the root instead of the section, the most common typo, produced `[]` in the probe. Print what the configuration actually holds before you blame the binder:

   ```csharp
   // .NET 10 / 11
   foreach (var kv in builder.Configuration.GetSection("App").AsEnumerable())
       Console.WriteLine($"{kv.Key} = {kv.Value}");
   // Among the output you should see:
   // App:Hosts:0 = a.example
   // App:Hosts:1 = b.example
   ```

   Arrays are flattened into indexed keys (`App:Hosts:0`, `App:Hosts:1`). If those lines are missing, the problem is the file (not copied to output, wrong environment name, wrong nesting), not the class.

2. **Give the collection a public setter.** This is the fix for most reports:

   ```csharp
   // .NET 10 / 11
   public sealed class AppOptions
   {
       public string[] Hosts { get; set; } = [];
       public List<EndpointOptions> Endpoints { get; set; } = [];
   }

   public sealed class EndpointOptions
   {
       public string Url { get; set; } = "";
   }
   ```

   Use `get; set;`, not `init`, if there is any chance the project is published with `PublishAot` or `PublishTrimmed` (see below). Avoid `ImmutableArray<T>` in options classes. If you want read-only semantics for consumers, expose `IReadOnlyList<T> { get; set; }`: the reflection binder assigns a `string[]` to it and the generator assigns a `List<T>`, and both populated correctly in the probe.

3. **Make mismatches fail loudly.** `ErrorOnUnknownConfiguration` throws when the configuration has a key with no matching property, and it also stops the binder from swallowing element conversion errors:

   ```csharp
   // .NET 10 / 11
   builder.Services.AddOptions<AppOptions>()
       .Bind(builder.Configuration.GetSection("App"),
             o => o.ErrorOnUnknownConfiguration = true)
       .ValidateOnStart();
   ```

   With `"Host": ["a"]` in the JSON (singular) the probe threw `InvalidOperationException: 'ErrorOnUnknownConfiguration' was set on the provided BinderOptions, but the following properties were not found on the instance of Settable: 'Host'`. With `"Ports": [1, "abc", 3]` it threw `'ErrorOnUnknownConfiguration' was set and binding has failed`, with the inner exception `Failed to convert configuration value 'abc' at 'App:Ports:1' to type 'System.Int32'`. Without the option, the same binding returned `[1, 3]`.

   Pair it with validation so an empty list is a startup failure instead of a production mystery. [Validating options at startup with `IValidateOptions<T>`](/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) covers the `ValidateOnStart` side in detail.

4. **Stop initializing collections with default values.** See the next section: defaults are appended to, not replaced.

## The binder appends to defaults instead of replacing them

This is the bug people hit right after fixing the empty list. Give the property a default and bind a section that has values:

```csharp
// .NET 10 / 11
public sealed class AppOptions
{
    public List<string> Hosts { get; set; } = ["localhost"];
}
// appsettings.json: "App": { "Hosts": [ "a.example", "b.example" ] }
// Result: [ "localhost", "a.example", "b.example" ]
```

That is what the probe returned for `List<T>`, `string[]`, `IEnumerable<T>`, `IReadOnlyList<T>` and `HashSet<T>` alike, and for both `Bind` and `Get<T>()`. `BindArray` literally starts by copying the existing elements into a new list before adding the configured ones. Calling `Bind` twice on the same instance, for example from a change-token callback, produced `[a, b, a, b]`.

This is long-standing, deliberate behaviour. An option to overwrite existing collections was proposed in [dotnet/runtime#62112](https://github.com/dotnet/runtime/issues/62112) in 2021 and is still open on the Future milestone, as is [dotnet/runtime#118204](https://github.com/dotnet/runtime/issues/118204), so do not wait for a flag. Apply defaults *after* binding, and only when configuration supplied nothing:

```csharp
// .NET 10 / 11
public sealed class AppOptions
{
    public string[]? Hosts { get; set; }
}

builder.Services.Configure<AppOptions>(builder.Configuration.GetSection("App"));
builder.Services.PostConfigure<AppOptions>(o => o.Hosts ??= ["localhost"]);
```

In the probe this gave `[a, b]` when the section existed and `[localhost]` when it did not. The `IOptionsMonitor<T>` factory builds a fresh instance on every reload, so the post-configure step runs against clean state each time. [IOptions vs IOptionsSnapshot vs IOptionsMonitor](/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) explains when each of those instances is created.

## Layered files merge arrays by index

`appsettings.Development.json` does not replace an array from `appsettings.json`. Configuration providers only ever contribute keys, and the last provider to set a given key wins. An array is just keys `0`, `1`, `2`. The probe layered these two files:

```json
// appsettings.json
{ "App": { "Hosts": [ "a", "b", "c" ] } }
```

```json
// appsettings.Development.json
{ "App": { "Hosts": [ "dev1", "dev2" ] } }
```

The bound result was `[dev1, dev2, c]`. Index 2 still comes from the base file. The same thing happens with environment variables (`App__Hosts__0=env.example` replaced only the first element) and command-line arguments (`--App:Hosts:2=cli.example` appended a third). The ASP.NET Core configuration docs call this out and suggest keeping indexes aligned across sources.

Two things you might try to clear the base array do not work:

- An empty array `"Hosts": []` in the override file: the result was still `[a, b]`.
- `"Hosts": null` in the override file: also `[a, b]`.

What does work is not defining that array in the base file at all, defining the complete array in every environment file, or storing the value as a single delimited string and splitting it in `PostConfigure`. A plain `"Hosts": "a.example,b.example"` bound straight into `string[]` gives `[]`, the binder does not split strings for you.

## Native AOT and trimming change the binder under you

The .NET SDK turns the configuration binding source generator on automatically for trimmed apps. From `Microsoft.NET.Sdk.FrameworkReferenceResolution.targets` in SDK 10.0.302:

```xml
<PropertyGroup Condition="'$(PublishTrimmed)' == 'true' Or '$(PublishAot)' == 'true'">
  <EnableRequestDelegateGenerator Condition="'$(EnableRequestDelegateGenerator)' == ''">true</EnableRequestDelegateGenerator>
  <EnableConfigurationBindingGenerator Condition="'$(EnableConfigurationBindingGenerator)' == ''">true</EnableConfigurationBindingGenerator>
</PropertyGroup>
```

The generator intercepts your `Bind`, `Get<T>` and `Configure<T>` calls at compile time. That is how Native AOT gets binding without reflection, but it is a different implementation, and the probe found four behavioural differences:

| Case | Reflection | Source generator |
| --- | --- | --- |
| `string[] { get; init; }` | binds | silently skipped |
| `BindNonPublicProperties = true` | binds private setters | `NotSupportedException` |
| `"Ports": [1, "abc", 3]` into `int[]` | `[1, 3]` | `InvalidOperationException: Failed to convert configuration value 'abc'` |
| `"Ports": [1, null, 3]` into `int[]` | `InvalidCastException` | `[1, 3]` |
| `ImmutableArray<string>` | `[]` | `NullReferenceException` |

So an app that binds happily under `dotnet run` can bind differently after someone adds `<PublishAot>true</PublishAot>` to the project. If you are moving to AOT, set `<EnableConfigurationBindingGenerator>true</EnableConfigurationBindingGenerator>` explicitly in Debug too, so your tests exercise the same binder as production. [Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) covers the other generators that flip on at the same time. File-based apps (`dotnet run app.cs`) default to `PublishAot=true`, so a quick probe written that way is already running the generator unless you add `#:property PublishAot=false`.

## Other cases worth knowing

- **Sparse indexes are compacted.** Keys `App:Hosts:0` and `App:Hosts:5` bound to `[a, f]`, a two-element array, not six elements with gaps. The docs example for missing index 3 shows the same thing.
- **Object keys work like indexes.** `"Hosts": { "x": "a", "y": "b" }` bound to `[a, b]`. That is why a JSON object where you meant an array does not fail.
- **Null string elements survive.** `["a", null, "c"]` into `string[]` gave `[a, null, c]` on both binders, even though the ASP.NET Core docs say the binder cannot create `null` entries. Do not rely on either behaviour; filter nulls in `PostConfigure` or validation.
- **Constructor binding works for collections.** `record AppOptions(string[] Hosts)` and element types with only a parameterized constructor (`class Endpoint(string url)`) bound correctly with `Get<T>()` in both modes.
- **`Get<string[]>()` on the array section itself** (`GetSection("App:Hosts").Get<string[]>()`) is a quick way to check the data independent of your options class.

## How to test your own options class

Keep a unit test that binds your real `appsettings.json` into your real options type, with the same generator setting as production:

```csharp
// .NET 10 / 11, xUnit
[Fact]
public void AppOptions_binds_hosts()
{
    var config = new ConfigurationBuilder()
        .AddJsonFile("appsettings.json")
        .Build();

    var options = config.GetSection("App")
        .Get<AppOptions>(o => o.ErrorOnUnknownConfiguration = true);

    Assert.NotNull(options);
    Assert.Equal(new[] { "a.example", "b.example" }, options.Hosts);
}
```

For end-to-end coverage including environment-specific files and environment variables, [integration tests with WebApplicationFactory](/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) let you resolve `IOptions<AppOptions>` from the real host.

## Related

- [How to validate options at startup with IValidateOptions<T> in .NET 11](/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) turns an empty list into a startup error.
- [IOptions<T> vs IOptionsSnapshot<T> vs IOptionsMonitor<T> in .NET 11](/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) for when bound instances are created and rebuilt.
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) for the other source generators that AOT enables.
- [How to write integration tests with WebApplicationFactory<T> in ASP.NET Core 11](/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) to test configuration against the real host.

## Sources

- [Configuration in ASP.NET Core: bind an array](https://learn.microsoft.com/aspnet/core/fundamentals/configuration/#bind-an-array), Microsoft Learn
- [Configuration binding source generator](https://learn.microsoft.com/dotnet/core/extensions/configuration-generator), Microsoft Learn
- [`ConfigurationBinder.cs` at v10.0.12](https://github.com/dotnet/runtime/blob/v10.0.12/src/libraries/Microsoft.Extensions.Configuration.Binder/src/ConfigurationBinder.cs), dotnet/runtime
- [dotnet/runtime#62112: allow optional overwriting of existing mutable collection instances](https://github.com/dotnet/runtime/issues/62112)
- [dotnet/runtime#118204: default configuration array merging is confusing and error-prone](https://github.com/dotnet/runtime/issues/118204)
- [`Microsoft.Extensions.Configuration.Binder` on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Configuration.Binder), versions 10.0.12 and 11.0.0-rc.1.26425.128 tested
