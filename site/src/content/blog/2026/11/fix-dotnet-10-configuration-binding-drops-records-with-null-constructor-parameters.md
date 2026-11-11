---
title: "Fix: .NET 10 configuration binding silently drops records whose nullable constructor parameters are null"
description: "A JSON null now reaches the binder as a real null, and binder 10.0.x treats it as missing config for a constructor parameter. Upgrade the binder package to 11.0.0, or give the parameter a default value."
pubDate: 2026-11-11
template: error-page
tags:
  - "errors"
  - "dotnet-10"
  - "dotnet-11"
  - "configuration"
  - "csharp"
---

**Short answer:** in .NET 10, the JSON configuration provider stores a JSON `null` as a real `null` instead of `""`. `Microsoft.Extensions.Configuration.Binder` 10.0.x then reads that `null` as "no config for this constructor parameter", throws inside the collection loop, and the loop swallows the exception, so the item just disappears. The fix is in binder 11.0.0 ([dotnet/runtime#131455](https://github.com/dotnet/runtime/pull/131455)). It was not backported to 10.0.x. To fix it on .NET 10, either reference the `Microsoft.Extensions.Configuration.Binder` 11.0.0 package (it targets `net10.0`), or give the nullable parameter a default value: `record User(int Id, string? Name = null)`.

Everything below was measured on macOS with SDK 10.0.302 and the .NET 10.0.10 runtime. The `Binder` and `Json` package versions were changed independently to separate the two causes: 9.0.0, 10.0.0, 10.0.14 (latest 10.0 servicing at the time of writing) and 11.0.0. The reflection binder and the source-generated binder were both tested.

## The error in context

By default you see no error. A list with two entries in `appsettings.json` binds to one item:

```text
// Binder 10.0.14, Json 10.0.14, .NET 10.0.10 runtime
ctor record      : 1 -> (1, "Noah")
```

Turn on `BinderOptions.ErrorOnUnknownConfiguration` and the swallowed exception comes back:

```text
System.InvalidOperationException: 'ErrorOnUnknownConfiguration' was set and binding has failed. The likely cause is an invalid configuration value.
 ---> System.InvalidOperationException: Cannot create instance of type 'User' because parameter 'Name' has no matching config. Each parameter in the constructor that does not have a default value must have a corresponding config entry.
```

If you use the configuration binding source generator (`EnableConfigurationBindingGenerator`, which Native AOT and trimmed apps turn on automatically), there is no `try`/`catch` around the item, so the same message ends `Get<T>()` as an unhandled exception thrown from `InitializeUser` in `BindingExtensions.g.cs`.

## Why this happens

Two separate changes combine to cause this.

1. **The JSON provider changed in .NET 10.** Before .NET 10, `JsonConfigurationFileParser` turned a JSON `null` into the string `""`. [dotnet/runtime#116677](https://github.com/dotnet/runtime/pull/116677) ("Support Null configuration") changed that, and Microsoft documents it as the [configuration null values preserved](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/configuration-null-values-preserved) breaking change. `config["CustomOptions:Users:1:Name"]` returns `""` on 9.0.0 and `null` on 10.0.0.
2. **The binder could not tell "bound to null" apart from "not bound".** In the 10.0 branch, `BindParameter` in `ConfigurationBinder.cs` ends like this:

```csharp
// Microsoft.Extensions.Configuration.Binder, release/10.0 (10.0.x)
if (propertyBindingPoint.Value is null)
{
    if (ParameterDefaultValue.TryGetDefaultValue(parameter, out object? defaultValue))
    {
        propertyBindingPoint.SetValue(defaultValue);
    }
    else
    {
        throw new InvalidOperationException(SR.Format(SR.Error_ParameterHasNoMatchingConfig, type, parameterName));
    }
}
```

A `string?` parameter bound to a real `null` hits that `throw`. Each element in `BindArray` and `BindCollection` is bound inside a `try`/`catch` that only rethrows when `ErrorOnUnknownConfiguration` is set, so the whole element is skipped and the collection gets shorter without any message. The [earlier post on the binder skipping array properties](/2026/09/fix-iconfiguration-bind-does-not-populate-an-array-or-list-property/) explains that same swallowing `catch`, which also hides element conversion errors.

The binder bug is not new. It only became visible for strings in .NET 10. A nullable value type parameter, `int? Max`, was already broken on .NET 9: `""` converts to a `null` `int?`, and that `null` hits the same `throw`. The measurements below show it.

## Minimal repro

A console app that keeps the runtime fixed at .NET 10 and changes the package versions:

```xml
<!-- .NET 10.0.10 runtime, SDK 10.0.302 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Extensions.Configuration.Binder" Version="10.0.14" />
    <PackageReference Include="Microsoft.Extensions.Configuration.Json" Version="10.0.14" />
  </ItemGroup>
  <ItemGroup>
    <None Update="appsettings.json" CopyToOutputDirectory="PreserveNewest" />
  </ItemGroup>
</Project>
```

```json
{
  "CustomOptions": {
    "EnableFeatureX": null,
    "Users": [
      { "Id": 1, "Name": "Noah" },
      { "Id": 2, "Name": null }
    ],
    "Limits": [
      { "Id": 1, "Max": 10 },
      { "Id": 2, "Max": null }
    ]
  }
}
```

```csharp
// .NET 10.0.10, C# 14, Microsoft.Extensions.Configuration.Binder 10.0.14
using Microsoft.Extensions.Configuration;

var config = new ConfigurationBuilder()
    .SetBasePath(AppContext.BaseDirectory)
    .AddJsonFile("appsettings.json")
    .Build();

static string Q(string? s) => s is null ? "null" : $"\"{s}\"";

var options = config.GetSection("CustomOptions").Get<Options>()!;
Console.WriteLine($"ctor record     : {options.Users.Count()} -> " +
    string.Join(", ", options.Users.Select(u => $"({u.Id}, {Q(u.Name)})")));
Console.WriteLine($"ctor int? param : {options.Limits.Count()} -> " +
    string.Join(", ", options.Limits.Select(l => $"({l.Id}, {l.Max?.ToString() ?? "null"})")));

public record Options
{
    public string? EnableFeatureX { get; init; }
    public IEnumerable<User> Users { get; set; } = [];
    public IEnumerable<Limit> Limits { get; set; } = [];
}

public record User(int Id, string? Name);
public record Limit(int Id, int? Max);
```

The same program also bound two variants of `User`, one with `init` properties and no constructor, and one with `string? Name = null`. Reflection binder results:

| Binder | Json | `Users:1:Name` raw | `record User(int, string?)` | `record Limit(int, int?)` | `init` properties | `string? Name = null` |
|---|---|---|---|---|---|---|
| 9.0.0 | 9.0.0 | `""` | 2 items, `Name = ""` | **1 item** | 2 items | 2 items |
| 9.0.0 | 10.0.0 | `null` | **1 item** | **1 item** | 2 items | 2 items |
| 10.0.0 | 10.0.0 | `null` | **1 item** | **1 item** | 2 items | 2 items |
| 10.0.14 | 9.0.0 | `""` | 2 items, `Name = ""` | **1 item** | 2 items | 2 items |
| 10.0.14 | 10.0.14 | `null` | **1 item** | **1 item** | 2 items | 2 items |
| 11.0.0 | 10.0.14 | `null` | 2 items, `Name = null` | 2 items | 2 items | 2 items |
| 11.0.0 | 11.0.0 | `null` | 2 items, `Name = null` | 2 items | 2 items | 2 items |

The table answers three questions:

- **The JSON package triggers it.** Binder 9.0.0 with Json 10.0.0 drops the item. Binder 10.0.14 with Json 9.0.0 does not. Pinning only the binder to 9.x does not help.
- **No 10.0.x servicing release fixes it.** 10.0.14 behaves exactly like 10.0.0.
- **Binder 11.0.0 fixes it on its own**, even with the 10.0.14 JSON provider and on the .NET 10 runtime.

## Fix, in detail

Pick one of these, in order of preference.

### 1. Reference the 11.0.0 binder package from your .NET 10 app

`Microsoft.Extensions.Configuration.Binder` 11.0.0 ships a `net10.0` asset, so you do not need to retarget:

```xml
<!-- .NET 10 app, ASP.NET Core 10 shared framework -->
<ItemGroup>
  <PackageReference Include="Microsoft.Extensions.Configuration.Binder" Version="11.0.0" />
</ItemGroup>
```

This also works in an ASP.NET Core app, where the binder normally comes from the `Microsoft.AspNetCore.App` shared framework. The SDK's conflict resolution picks the higher assembly version from the package. Tested with `Microsoft.NET.Sdk.Web` on `net10.0`:

```text
// without the PackageReference
Binder 10.0.10 from 10.0.10      <- shared framework folder
Users: 1

// with Microsoft.Extensions.Configuration.Binder 11.0.0
Binder 11.0.0 from net10.0       <- package lib/net10.0 folder
Users: 2
```

The trade-off: it brings `Microsoft.Extensions.Configuration.Abstractions` 11.0.0 and `Microsoft.Extensions.Primitives` 11.0.0 into an app that otherwise runs 10.0 libraries. Those packages support `net10.0`, but you now ship app-local copies of them, and the 10.0.x shared framework servicing updates no longer patch them. You have to update the package yourself. If that is not acceptable, use fix 2. If you can move to .NET 11, this goes away without anything extra.

### 2. Give nullable constructor parameters a default value

On every binder version, the `throw` above is only reached when the parameter has no default value. A default changes nothing for code that calls the constructor with all arguments:

```csharp
// .NET 10.0.10, C# 14, Binder 10.0.14: binds both items, Name = null
public record User(int Id, string? Name = null);
public record Limit(int Id, int? Max = null);
```

This is the smallest change that also fixes the `int?` case, which was already failing on .NET 9. It also works with the source generator, because the generated code checks for a default value as well.

### 3. Switch the element type to settable or `init` properties

The accepted answer on [Stack Overflow 79873251](https://stackoverflow.com/questions/79873251) suggests this, and it works with the reflection binder. A type with a parameterless constructor never goes through `BindParameter`:

```csharp
// .NET 10.0.10, C# 14, Binder 10.0.14 reflection binder: binds both items
public record User
{
    public int Id { get; init; }
    public string? Name { get; init; }
}
```

Do not use this if you use the source generator: it ignores `init` accessors. With 11.0.0 and `EnableConfigurationBindingGenerator=true`, this type produced two items with `(0, null)`, `(0, null)`. Nothing failed, but no values were bound either. Use `{ get; set; }` there.

The other suggested workaround, adding `public User() : this(0, "") { }`, also works for the same reason, but it hides the positional constructor from the binder entirely. Prefer the default-value version.

## Gotchas and variants

**The source generator fails loudly, not silently.** With `EnableConfigurationBindingGenerator=true` and binder 10.0.14, `Get<Options>()` throws the "has no matching config" exception from the generated `InitializeUser`. The 10.0.14 generator emits this for a `string?` parameter:

```csharp
// generated by Binder 10.0.14 (excerpt)
if (configuration["Name"] is not string Name)
{
    throw new InvalidOperationException("Cannot create instance of type 'User' because parameter 'Name' has no matching config. ...");
}
```

and 11.0.0 emits `string Name = configuration["Name"];` instead. If your app crashes at startup after you enable Native AOT on .NET 10, this is a likely cause. The [source generator overview](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) explains how to read `BindingExtensions.g.cs` (`EmitCompilerGeneratedFiles=true` writes it under `obj/.../generated`).

**".NET 9 behaviour" meant `Name == ""`, not `Name == null`.** On 9.0.0 the second user bound as `(2, "")`. Code that checks `Name is null` was never true for JSON nulls before .NET 10. After the fix you get a real `null`, so review any `string.IsNullOrEmpty` vs `is null` checks that relied on the old empty string.

**`int?` parameters were always affected.** If you assumed nullable value types worked on .NET 9, check again: `record Limit(int Id, int? Max)` with `"Max": null` dropped the item on every version before 11.0.0.

**A missing key behaves the same way as a `null` key.** If you delete `"Name"` from an element entirely, binder 10.0.14 drops that element too (reflection) or throws (generator), and binder 11.0.0 binds `Name` as `null`, because 11.0.0 accepts `null` for any parameter whose type can hold it. A missing non-nullable value type such as `int Id` is still rejected on every version: the reflection binder silently drops the element and the generator throws "parameter 'Id' has no matching config". That is the intended contract, so give such parameters a default value if the key is optional.

**Turn on `ErrorOnUnknownConfiguration` in development.** Most of the confusing binder bugs come from that silent `catch`. Combined with [startup options validation](/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/), a dropped element becomes a startup failure instead of a missing user in production:

```csharp
// .NET 10, ASP.NET Core 10
builder.Services.AddOptions<Options>()
    .Bind(builder.Configuration.GetSection("CustomOptions"),
          o => o.ErrorOnUnknownConfiguration = true)
    .ValidateOnStart();
```

`ErrorOnUnknownConfiguration` also fails on configuration keys that have no matching property, so turn it on in a development environment first and fix the noise before you ship it.

## Related

- [Fix: IConfiguration.Bind does not populate an array or List<T> property](/2026/09/fix-iconfiguration-bind-does-not-populate-an-array-or-list-property/) covers the other ways a collection can silently stay empty.
- [How to validate options at startup with IValidateOptions](/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) turns binding gaps into startup failures.
- [IOptions vs IOptionsSnapshot vs IOptionsMonitor](/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) explains when the binder runs again after a reload.
- [Record vs class vs struct in C#](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) helps you decide when a positional record is the right shape for an options element.

## Sources

- [Breaking change: Null values preserved in configuration](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/configuration-null-values-preserved), Microsoft Learn.
- [dotnet/runtime#116677: Support Null configuration](https://github.com/dotnet/runtime/pull/116677), the .NET 10 JSON provider change.
- [dotnet/runtime#131269: .NET 10 binding an IEnumerable record entries missing when nullable parameters are null](https://github.com/dotnet/runtime/issues/131269), milestone 11.0.0.
- [dotnet/runtime#131455: Fix configuration binder dropping collection items with null constructor parameters](https://github.com/dotnet/runtime/pull/131455), merged 2026-08-03 for 11.0 RC 1. Covers both the reflection binder and the source generator.
- [`ConfigurationBinder.cs` on release/10.0](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.Configuration.Binder/src/ConfigurationBinder.cs), still without the fix at the time of writing.
- [Stack Overflow 79873251](https://stackoverflow.com/questions/79873251), the original report and the `init` property workaround.
