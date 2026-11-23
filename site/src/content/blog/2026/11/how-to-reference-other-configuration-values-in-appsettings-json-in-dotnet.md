---
title: "How to reference other configuration values (placeholders) inside appsettings.json in .NET"
description: "Microsoft.Extensions.Configuration has no interpolation, so \"{SoapScheme}://{Host}\" stays literal. Here is a 70-line placeholder provider that resolves ${Section:Key} against every other source (env vars, user secrets, Aspire), survives reload-on-change, and how it compares to Steeltoe and PostConfigure, verified on .NET 11."
pubDate: 2026-11-23
tags:
  - "dotnet"
  - "aspnet-core"
  - "configuration"
  - "aspire"
  - "dotnet-11"
---

`Microsoft.Extensions.Configuration` does not interpolate. A value like `"{SoapScheme}://{SoapServiceHost}/CustomerAccountManager.asmx"` in `appsettings.json` reaches your options class exactly as written, on .NET 11 just as on .NET Core 1.0. To get placeholders you either compose the value in code with `PostConfigure` (best when the composition is one or two fields, or depends on runtime logic), or add a configuration provider at the end of the pipeline that rewrites `${Section:Key}` tokens using every source registered before it. The provider in this post is about 70 lines, resolves values from environment variables, user secrets and Aspire-injected endpoints, keeps working when `appsettings.json` reloads, and was tested against `Steeltoe.Configuration.Placeholder` 4.3.1. All output below comes from a `net11.0` web project built with SDK 11.0.100 (ASP.NET Core runtime 11.0.0) on macOS arm64.

## Why the braces stay literal

The question that prompted this, [Dynamic configuration from appsettings at runtime](https://stackoverflow.com/questions/80003549), has an Aspire launcher in front of an ASP.NET Core app and this section:

```json
{
  "SoapService": {
    "SoapScheme": "https",
    "SoapServiceHost": "SoapDevService",
    "CustomerAccountManager": {
      "Endpoint": "{SoapScheme}://{SoapServiceHost}/CustomerAccountManager.asmx",
      "TimeoutSeconds": 30
    }
  }
}
```

Every configuration provider (JSON, environment variables, user secrets, command line, Key Vault) produces a flat dictionary of `string` keys to `string?` values. `ConfigurationRoot` and `ConfigurationManager` answer `config["a:b"]` by asking each provider in reverse registration order and returning the first hit. No step in that chain looks inside the value. The [configuration overview on MS Learn](https://learn.microsoft.com/dotnet/core/extensions/configuration) describes providers, precedence and binding, and says nothing about substitution because there is none.

The asker's attempt, subclassing `ConfigurationSection` and casting `GetRequiredSection("SoapService")` to it, throws `InvalidCastException` because the manager hands out its own `ConfigurationSection` instances; it never constructs your type. Binding to a POCO and patching the string, which the accepted answer suggests, works but loses reload-on-change and only covers the one property you remember to patch.

Here is the baseline with no extra code, using `${Section:Key}` syntax (more on why that syntax below):

```text
[raw] config : ${SoapService:SoapScheme}://${SoapService:SoapServiceHost}/CustomerAccountManager.asmx
[raw] options: ${SoapService:SoapScheme}://${SoapService:SoapServiceHost}/CustomerAccountManager.asmx
```

## Option 1: compose the value with PostConfigure

If only one or two settings are derived, skip placeholders in the file entirely and build the value where the options are configured. `PostConfigure` runs after every `Configure` call, including the one that binds the section, and it reruns when `IOptionsMonitor` reloads:

```csharp
// .NET 11, C# 14
builder.Services.Configure<CustomerAccountManagerOptions>(
    builder.Configuration.GetSection("SoapService:CustomerAccountManager"));

builder.Services.AddOptions<CustomerAccountManagerOptions>()
    .PostConfigure<IConfiguration>((o, cfg) =>
    {
        var soap = cfg.GetSection("SoapService");
        var host = IsLocalSoapRunning() /* your own check */ ? "localhost:7123" : soap["SoapServiceHost"];
        o.Endpoint = $"{soap["SoapScheme"]}://{host}/CustomerAccountManager.asmx";
    });
```

This is also where the asker's "if a service is running" logic belongs. A configuration provider runs while the host is being built, before DI exists; options configuration runs lazily when something first asks for the options, with full access to services.

The limitation is visible in the test run: the options object is correct but the raw configuration is not, so anything that reads `IConfiguration` directly (a connection-string lookup, a third-party library that binds its own section) still sees the template:

```text
[postconfigure] config : ${SoapService:SoapScheme}://${SoapService:SoapServiceHost}/CustomerAccountManager.asmx
[postconfigure] options: https://soap-dev.internal/CustomerAccountManager.asmx
```

When the placeholders need to work for every consumer, resolve them in the configuration pipeline itself.

## Option 2: a placeholder provider at the end of the pipeline

The trick is that a provider added to `builder.Configuration` (a `ConfigurationManager`) receives the manager itself in `IConfigurationSource.Build`. `ConfigurationManager` implements `IConfigurationRoot`, so the provider can look at `Providers` and read every provider registered before it. Because the last provider wins, our provider answers first for any key whose raw value contains `${`, and returns `false` for everything else so the normal providers answer as usual.

```csharp
// .NET 11, C# 14. Expands ${Section:Key} and ${Section:Key?default} placeholders
// using every configuration provider that was added before this one.
using System.Text.RegularExpressions;

public sealed class PlaceholderConfigurationSource : IConfigurationSource
{
    public IConfigurationProvider Build(IConfigurationBuilder builder) =>
        builder is IConfigurationRoot root
            ? new PlaceholderConfigurationProvider(root)
            : throw new InvalidOperationException(
                "Add the placeholder source to a ConfigurationManager (builder.Configuration).");
}

public sealed partial class PlaceholderConfigurationProvider(IConfigurationRoot root) : ConfigurationProvider
{
    [GeneratedRegex(@"\$\{(?<key>[^}?]+)(\?(?<default>[^}]*))?\}")]
    private static partial Regex Placeholder();

    private const int MaxDepth = 10;

    // Nothing is cached: values are resolved on every read, so a reload of any
    // lower source is visible immediately and there is no change-token ordering to get wrong.
    public override void Load() { }

    public override bool TryGet(string key, out string? value)
    {
        var lower = LowerProviders();
        var raw = Get(lower, key);
        if (raw is null || !raw.Contains("${", StringComparison.Ordinal))
        {
            value = null;
            return false; // let the normal providers answer
        }
        value = Resolve(lower, raw, depth: 0, chain: [key]);
        return true;
    }

    public override void Set(string key, string? value) =>
        throw new NotSupportedException("Set the value on the underlying configuration instead.");

    // Providers added before this one, highest precedence first (last added wins).
    private IConfigurationProvider[] LowerProviders() =>
        root.Providers.TakeWhile(p => !ReferenceEquals(p, this)).Reverse().ToArray();

    private static string? Get(IConfigurationProvider[] lower, string key)
    {
        foreach (var p in lower)
            if (p.TryGet(key, out var v)) return v;
        return null;
    }

    private static string Resolve(IConfigurationProvider[] lower, string value, int depth, HashSet<string> chain)
    {
        if (depth > MaxDepth)
            throw new InvalidOperationException($"Placeholders nested deeper than {MaxDepth}: '{value}'.");

        return Placeholder().Replace(value, m =>
        {
            var key = m.Groups["key"].Value.Trim();
            if (!chain.Add(key))
                throw new InvalidOperationException(
                    $"Circular placeholder: {string.Join(" -> ", chain)} -> {key}");
            try
            {
                var found = Get(lower, key);
                if (found is null)
                    return m.Groups["default"].Success ? m.Groups["default"].Value : m.Value;
                return Resolve(lower, found, depth + 1, chain);
            }
            finally { chain.Remove(key); }
        });
    }
}

public static class PlaceholderConfigurationExtensions
{
    // Call this after every other source, so env vars, user secrets and Aspire values are visible.
    public static IConfigurationBuilder AddPlaceholders(this IConfigurationBuilder builder) =>
        builder.Add(new PlaceholderConfigurationSource());
}
```

A few design decisions in there are load-bearing:

- **`TakeWhile(p => !ReferenceEquals(p, this))`** gives the provider the raw values. If it read through `root[key]` instead, it would get its own already-resolved output back and could never re-resolve after a change. When the source is first added, `ConfigurationManager` builds and loads the provider before inserting it into `Providers`, so at that moment `TakeWhile` returns everything; afterwards it stops at our own instance.
- **Resolve on read, cache nothing.** A first version of this provider expanded everything into `Data` in `Load()` and subscribed to the root's reload token to re-expand. It worked, but on the first file change `IOptionsMonitor.OnChange` fired with the stale endpoint before the provider had re-expanded, then fired again with the right one, because both listeners hang off the same token and run in an order you do not control. Its own `OnReload()` also retriggers the root token, which loops forever unless you compare old and new data. Resolving inside `TryGet` removes the whole class of problem: when any lower provider reloads, the manager raises its change token as usual, and whoever reads next gets freshly resolved values.
- **Fully qualified keys** (`${SoapService:SoapScheme}`, not `{SoapScheme}`). Relative lookup sounds friendlier until two sections both have a `Host`. The `${key?default}` shape matches what Steeltoe and Spring use, so the files stay portable.
- **Unresolved placeholders are left in place** rather than replaced with an empty string, which makes a typo obvious in logs instead of producing `https:///CustomerAccountManager.asmx`.

Wire it up in `Program.cs`, after everything else that adds configuration:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Configuration.AddPlaceholders(); // must be the last source

builder.Services.Configure<CustomerAccountManagerOptions>(
    builder.Configuration.GetSection("SoapService:CustomerAccountManager"));
```

Output:

```text
[custom] config : https://soap-dev.internal/CustomerAccountManager.asmx
[custom] options: https://soap-dev.internal/CustomerAccountManager.asmx
```

Both raw `IConfiguration` and the bound options now see the resolved value.

## Overrides from environment variables and Aspire

Because resolution reads the lower providers with normal precedence, an environment variable that overrides a referenced key flows into every value built from it:

```bash
SoapService__SoapServiceHost=localhost:7123 dotnet CfgRepro.dll
```

```text
[custom] config : https://localhost:7123/CustomerAccountManager.asmx
```

That is the hook for the Aspire part of the question. When an AppHost passes a resource to a project with `WithReference`, the project receives its endpoints as environment variables named `services__<resource>__<endpoint>__<index>`, which become configuration keys like `services:soapdev:https:0` ([Aspire service discovery](https://learn.microsoft.com/dotnet/aspire/service-discovery/overview)). A placeholder with a default works both under the AppHost and when the project is started on its own:

```json
"AspireEndpoint": "${services:soapdev:https:0?https://soap-dev.internal}"
```

```text
[custom] aspire : https://soap-dev.internal          (no env var)
[custom] aspire : https://localhost:7123             (services__soapdev__https__0=https://localhost:7123)
```

If you control the AppHost, the simpler route is often to skip placeholders and set the final key directly with `.WithEnvironment("SoapService__CustomerAccountManager__Endpoint", ...)`. Placeholders earn their keep when the same file must also work without Aspire.

## Reload-on-change still works

The test program registered `IOptionsMonitor<CustomerAccountManagerOptions>.OnChange`, rewrote `appsettings.json` to point at `soap-staging.internal`, waited, and restored it:

```text
[custom] change #1: https://soap-staging.internal/CustomerAccountManager.asmx
[custom] change #2: https://soap-staging.internal/CustomerAccountManager.asmx
[custom] change #3: https://soap-dev.internal/CustomerAccountManager.asmx
```

Every callback carries the current value. The duplicate `#2` is not the provider: the Steeltoe and `PostConfigure` runs printed the same three callbacks, because the macOS file watcher reports one `File.WriteAllText` as two events. If you cache options per change, debounce.

## Order matters: add the provider last

Two ordering mistakes produce silent failures, both reproduced:

1. **Inserting the source early.** `builder.Configuration.Sources.Insert(0, new PlaceholderConfigurationSource())` makes the manager rebuild every provider with ours first. It now has no lower providers to read and the lowest precedence, so nothing resolves:

   ```text
   [custom-early] options: ${SoapService:SoapScheme}://${SoapService:SoapServiceHost}/CustomerAccountManager.asmx
   ```

2. **Adding sources after it.** A value from `AddInMemoryCollection`, `AddJsonFile` or `AddAzureKeyVault` called after `AddPlaceholders()` outranks the provider and is never expanded. In the test, `["Late"] = "${SoapService:SoapScheme}"` added afterwards read back verbatim. Steeltoe behaves the same way.

So the rule is: `AddPlaceholders()` is the last configuration call before `builder.Build()`. If a library adds sources in its own extension method (some secret-store integrations do), call it before `AddPlaceholders()`.

## Circular references fail fast

`"Loop": { "A": "${Loop:B}", "B": "${Loop:A}" }` would recurse forever without the `chain` set. With it, reading `Loop:A` throws on first access:

```text
System.InvalidOperationException: Circular placeholder: Loop:A -> Loop:B -> Loop:A
```

Because resolution is lazy, this throws when the key is read, not at startup. If you want the failure at boot, bind the affected options with `ValidateOnStart()`, the same pattern as [validating options at startup with `IValidateOptions`](/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/).

## Steeltoe, and when to pick which

You do not have to own this code. [`Steeltoe.Configuration.Placeholder`](https://docs.steeltoe.io/api/v4/configuration/placeholder-provider.html) 4.3.1 has the same `${key?default}` syntax and produced identical results in every scenario above, including the env var override, the Aspire default and reload (its circular-reference message reads `Found circular placeholder reference 'Loop:B' in configuration.`):

```csharp
// .NET 11, Steeltoe.Configuration.Placeholder 4.3.1
using Steeltoe.Configuration.Placeholder;

builder.Configuration.AddPlaceholderResolver();
```

The difference is structural. Steeltoe's docs say the resolver wraps and takes ownership of the sources already added, and the test confirms it: before the call, `builder.Configuration.Sources` listed ten sources (memory, env vars, four JSON files, the chained host configuration); after it, the list held a single `PlaceholderConfigurationSource`. Code that later inspects or edits `Sources`, for example to remove a JSON file in integration tests, no longer finds them. The provider in this post leaves the list alone and only appends.

Summary of the trade-offs:

- **`PostConfigure`**: no new infrastructure, can call services and run arbitrary logic, but only fixes the options type you write it for. Raw `IConfiguration` keeps the template.
- **Custom provider**: every consumer sees resolved values, reload-safe, about 70 lines you own, sources stay untouched.
- **Steeltoe**: same behavior from a maintained package, plus the `${key?default}` conventions from Spring Cloud Config, at the cost of an extra dependency and wrapped sources.

Two smaller packages, [ConfigurationPlaceholders](https://www.nuget.org/packages/ConfigurationPlaceholders) and [ConfigurationSubstitutor](https://github.com/erizzo/ConfigurationSubstitutor), cover similar ground; they were not tested for this post.

## Related reading

- Why `IOptionsMonitor` sees reloaded values and `IOptions` does not: [IOptions vs IOptionsSnapshot vs IOptionsMonitor](/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/).
- Binding pitfalls that look like missing values: [`IConfiguration.Bind` does not populate a list property](/2026/09/fix-iconfiguration-bind-does-not-populate-an-array-or-list-property/) and [records with null constructor parameters dropped by binding in .NET 10](/2026/11/fix-dotnet-10-configuration-binding-drops-records-with-null-constructor-parameters/).
- If the "is the service running" check is async, it belongs in startup code, not configuration: [initializing interdependent async singletons at startup](/2026/11/how-to-initialize-interdependent-async-singletons-at-startup-in-aspnetcore/).

## Sources

- [Configuration in .NET (MS Learn)](https://learn.microsoft.com/dotnet/core/extensions/configuration)
- [Implement a custom configuration provider (MS Learn)](https://learn.microsoft.com/dotnet/core/extensions/custom-configuration-provider)
- [Options pattern: `PostConfigure` (MS Learn)](https://learn.microsoft.com/dotnet/core/extensions/options)
- [Aspire service discovery](https://learn.microsoft.com/dotnet/aspire/service-discovery/overview)
- [Steeltoe 4 Placeholder Provider](https://docs.steeltoe.io/api/v4/configuration/placeholder-provider.html)
- [Stack Overflow: Dynamic configuration from appsettings at runtime](https://stackoverflow.com/questions/80003549)
