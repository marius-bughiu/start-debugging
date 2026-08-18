---
title: "Fix: 'MapperConfiguration' does not contain a constructor that takes 1 arguments"
description: "AutoMapper 15 removed the single-argument MapperConfiguration constructor. Pass an ILoggerFactory as the second argument, and add a config action to every AddAutoMapper call."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "csharp"
  - "automapper"
  - "migration"
---

`new MapperConfiguration(cfg => ...)` no longer compiles because AutoMapper 15.0 deleted the one-argument constructor. Pass an `ILoggerFactory` as a second argument: `new MapperConfiguration(cfg => ..., loggerFactory)`, or `NullLoggerFactory.Instance` in tests. The same release also deleted every `AddAutoMapper` overload that did not take a configuration action, so `services.AddAutoMapper(typeof(Program))` breaks in the same build with a different error code.

Everything below is verified against AutoMapper 15.1.3 and 16.2.0 on .NET SDK 10.0.201, targeting `net10.0`. The change landed in [15.0.0 on 2 July 2025](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v15.0.0) and is still the shape of the API in 16.2.0.

## The error in context

```text
Repro.cs(11,26): error CS1729: 'MapperConfiguration' does not contain a constructor that takes 1 arguments
```

If you register AutoMapper through dependency injection, the same build usually produces two more errors that are the same breaking change wearing a different hat:

```text
Repro.cs(15,32): error CS1503: Argument 2: cannot convert from 'System.Type' to 'System.Action<AutoMapper.IMapperConfigurationExpression>'
Repro.cs(16,32): error CS1503: Argument 2: cannot convert from 'System.Reflection.Assembly' to 'System.Action<AutoMapper.IMapperConfigurationExpression>'
```

Three errors, one cause. Fixing only the constructor leaves the build red.

## Why the one-argument constructor is gone

AutoMapper 15 added a license key and license-state logging, and the logging needs somewhere to write. Rather than reach for a static logger or an ambient sink, the maintainers made the dependency explicit: `MapperConfiguration` now takes the `ILoggerFactory` it will log through. Jimmy Bogard [confirmed on issue #4542](https://github.com/LuckyPennySoftware/AutoMapper/issues/4542) that this is an intentional breaking change and that it was missing from the original release notes, which is why so many people hit it with no idea what to search for.

Reflection over the shipped assemblies makes the diff concrete. AutoMapper 14.0.0 exposes:

```text
// AutoMapper 14.0.0
MapperConfiguration.ctor(MapperConfigurationExpression)
MapperConfiguration.ctor(Action`1)
```

AutoMapper 15.1.3 and 16.2.0 both expose:

```text
// AutoMapper 15.1.3 and 16.2.0
MapperConfiguration.ctor(MapperConfigurationExpression, ILoggerFactory)
MapperConfiguration.ctor(Action`1, ILoggerFactory)
```

There is no overload with a defaulted `ILoggerFactory` parameter, so there is no way to keep the old call site compiling. Every direct construction has to be touched.

## Minimal repro

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
using AutoMapper;

public record Source(int Id, string Name);
public record Dest(int Id, string Name);

public class Repro
{
    public void OldStyle()
    {
        // error CS1729
        var config = new MapperConfiguration(cfg => cfg.CreateMap<Source, Dest>());
        var mapper = config.CreateMapper();
    }
}
```

A `csproj` with nothing but `<PackageReference Include="AutoMapper" Version="15.1.3" />` reproduces it. Note that this is a compile-time break only. Nothing about the mapping engine changed, so once the call sites compile, your maps behave exactly as they did on 14.

## What do I pass for ILoggerFactory outside dependency injection?

For static mapper configurations, test fixtures, and console tools where you have no host, `NullLoggerFactory.Instance` from `Microsoft.Extensions.Logging.Abstractions` is the right answer. AutoMapper already depends on `Microsoft.Extensions.Logging.Abstractions`, so there is no new package to add.

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
using AutoMapper;
using Microsoft.Extensions.Logging.Abstractions;

public static class Maps
{
    public static readonly MapperConfiguration Config = new(
        cfg =>
        {
            cfg.LicenseKey = "<your key>";
            cfg.AddProfile<MyProfile>();
        },
        NullLoggerFactory.Instance);

    public static readonly IMapper Mapper = Config.CreateMapper();
}
```

A static `MapperConfiguration` is still a supported pattern. That was the other worry on issue #4542, and Bogard answered it directly: a static instance is fine, and the license key can come from `IConfiguration` or a secret store rather than being baked into a literal.

`AssertConfigurationIsValid()` still hangs off the configuration object exactly as before, so validation tests need no changes beyond the constructor:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
[Fact]
public void Mapping_configuration_is_valid()
{
    var config = new MapperConfiguration(
        cfg => cfg.AddProfile<MyProfile>(),
        NullLoggerFactory.Instance);

    config.AssertConfigurationIsValid();
}
```

If you want the license diagnostics visible in a test run, swap `NullLoggerFactory.Instance` for a real factory. That is the only thing the parameter is used for.

## How do I fix the AddAutoMapper calls that broke at the same time?

Every `AddAutoMapper` overload without a configuration action was deleted in 15.0. Comparing the public statics on `Microsoft.Extensions.DependencyInjection.ServiceCollectionExtensions` across versions, these three disappeared:

```text
// Present in AutoMapper 14.0.0, gone in 15.0.0 and later
AddAutoMapper(IServiceCollection, Assembly[])
AddAutoMapper(IServiceCollection, Type[])
AddAutoMapper(IServiceCollection, IEnumerable<Assembly>, ServiceLifetime)
```

Which means the config action is now mandatory and always comes second:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3, ASP.NET Core minimal host
var builder = WebApplication.CreateBuilder(args);

// Before (AutoMapper 14):
// builder.Services.AddAutoMapper(typeof(Program));

// After:
builder.Services.AddAutoMapper(
    cfg => cfg.LicenseKey = builder.Configuration["AutoMapper:LicenseKey"],
    typeof(Program));
```

If the action has nothing to say, an empty lambda is legal: `services.AddAutoMapper(_ => { }, typeof(Program))`. It is still required positionally.

The DI path supplies the `ILoggerFactory` for you, so there is no `MapperConfiguration` to construct by hand. It is worth knowing what gets registered, because the lifetimes are asymmetric:

```text
// Registered by AddAutoMapper, AutoMapper 15.1.3
AutoMapper.IConfigurationProvider -> Singleton
AutoMapper.IMapper               -> Transient
```

The expensive object, the compiled configuration, is the singleton. `IMapper` is a cheap transient wrapper over it, which is why injecting `IMapper` into scoped and transient services costs nothing and does not run into the [scoped-service-from-singleton captive dependency problem](/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

There is also an overload that hands you the `IServiceProvider`, useful when the key lives behind a service rather than raw configuration:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3
services.AddAutoMapper(
    (sp, cfg) => cfg.LicenseKey = sp.GetRequiredService<ILicenseStore>().AutoMapperKey,
    typeof(MyProfile));
```

## What if 'No service for type ILoggerFactory has been registered' appears right after?

You fix the constructor, the build goes green, and a test blows up at runtime:

```text
System.InvalidOperationException: No service for type 'Microsoft.Extensions.Logging.ILoggerFactory' has been registered.
```

This is the DI registration reaching for the logger factory that AutoMapper now needs. In an ASP.NET Core app you will never see it, because `WebApplicationBuilder` wires up logging before you get a chance to call `AddAutoMapper`. You see it in unit tests and small console apps that build a bare `ServiceCollection`:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3 - throws on resolve
var services = new ServiceCollection();
services.AddAutoMapper(cfg => cfg.CreateMap<Source, Dest>());
var mapper = services.BuildServiceProvider().GetRequiredService<IMapper>();
```

One line fixes it:

```csharp
// .NET 10, C# 14, AutoMapper 15.1.3 - resolves
var services = new ServiceCollection();
services.AddLogging();                       // this is the missing piece
services.AddAutoMapper(cfg => cfg.CreateMap<Source, Dest>());
var mapper = services.BuildServiceProvider().GetRequiredService<IMapper>();
```

The error message is generic enough that people chase it as a separate bug, the same way [a missing DbContextOptions registration](/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/) sends people hunting in the wrong file. If it appeared in the same commit that moved you to AutoMapper 15, it is this.

## What actually happens if you never set a license key

Nothing breaks. AutoMapper 15.1.3 maps objects perfectly happily with no key at all, with an invalid key, or with an empty string. What you get is a log message, on the `LuckyPennySoftware.AutoMapper.License` category:

```text
warn: LuckyPennySoftware.AutoMapper.License[0]
      You do not have a valid license key for the Lucky Penny software AutoMapper. This is allowed for
      development and testing scenarios. If you are running in production you are required to have a
      licensed version. Please visit https://luckypennysoftware.com to obtain a valid license.
```

That is the entire enforcement mechanism, and it is why the `ILoggerFactory` parameter had to exist. The docs are explicit that there is no other license enforcement besides log messages. This is a legal obligation, not a technical gate, so treat the warning as a compliance item, not a runtime problem to silence.

One detail that costs people an afternoon: a malformed key logs at critical level before the warning, with a JWT parse failure, because the key is a signed JWT:

```text
crit: LuckyPennySoftware.AutoMapper.License[0]
      Error validating the Lucky Penny software license key
      Microsoft.IdentityModel.Tokens.SecurityTokenMalformedException: IDX14100: JWT is not well formed,
      there are no dots (.).
```

If your log pipeline pages on `Critical`, a truncated or whitespace-mangled key in an environment variable will wake somebody up while the application keeps working correctly. Check for that string before assuming AutoMapper is broken.

Two more practical notes on the key. First, `cfg.LicenseKey` is not the only documented route: the docs list `AUTOMAPPER_LICENSE_KEY` and `LUCKYPENNY_LICENSE_KEY` environment variables, resolved in that order after the explicit code value. In my testing on 15.1.3 neither environment variable was picked up, since a deliberately malformed value in each produced only the generic unlicensed warning and never the JWT parse error that an explicit `cfg.LicenseKey` triggers. On the 15.x line, set the key in code and read it from configuration. Second, AutoMapper 16.2.0 logged no license message at all in the same test, so do not read the absence of a warning as evidence that a key was accepted.

## Should you pin to AutoMapper 14 instead?

This is the most common workaround suggested in the issue threads, and as of March 2026 it is a bad one. AutoMapper 14.0.0 and everything below 15.1.1 carry [GHSA-rvv3-g6hj-g44x](https://github.com/advisories/GHSA-rvv3-g6hj-g44x), a High severity (CVSS 7.5) uncontrolled recursion issue: mapping a deeply nested or self-referential object graph exhausts the stack and takes the process down with a `StackOverflowException` that cannot be caught. If untrusted input reaches a mapped type, that is a denial of service. Restoring 14.0.0 today produces this on every build:

```text
warning NU1903: Package 'AutoMapper' 14.0.0 has a known high severity vulnerability,
https://github.com/advisories/GHSA-rvv3-g6hj-g44x
```

The fix shipped in 15.1.1 and 16.1.1, both released in March 2026. So the real choice is between 15.1.3 and 16.2.0, not between 15 and 14. Both take the same constructor, so the migration work described above is identical either way.

If you would rather not pay for a mapper at all, that decision is separate from this compile error and worth making deliberately rather than under build pressure. The tradeoffs are laid out in the walkthrough of [moving from AutoMapper to source-generated mapping with Mapperly](/2026/05/migrate-from-automapper-to-source-generated-mapping/), and the same commercial-license question played out for another Bogard library in [MediatR vs plain service classes](/2026/05/mediatr-vs-plain-service-classes-in-2026/).

## What changes again in AutoMapper 16

Nothing you have to touch. The constructor shape and the `AddAutoMapper` signatures are identical between 15.1.3 and 16.2.0, so code fixed for 15 compiles on 16 unchanged. The differences are in packaging:

- 15.x targets `net8.0`, `net9.0`, and `netstandard2.0`.
- 16.x adds `net10.0` and `net471`, and moves its `Microsoft.Extensions.*` dependencies from 8.0.0 up to 10.0.0.

If you are already on .NET 10, 16.2.0 avoids pulling the 8.0.0 extension packages into your graph. If you are stuck on .NET 8 with a locked-down transitive dependency set, 15.1.3 is a supported, patched place to sit. Both are past the security fix, and the upgrade itself is the same three-line edit either way: add the logger factory, add the config action, decide where the key lives.

## Related

- [Migrate from AutoMapper to source-generated mapping with Mapperly](/2026/05/migrate-from-automapper-to-source-generated-mapping/)
- [MediatR vs plain service classes in 2026: should the license change move you?](/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [Fix: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered](/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/)
- [Fix: Cannot consume scoped service 'X' from singleton 'Y'](/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [Migrate EF Core 6 to EF Core 11: breaking changes that actually bite](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)

## Sources

- [AutoMapper 15.0 Upgrade Guide](https://docs.automapper.io/en/stable/15.0-Upgrade-Guide.html)
- [AutoMapper v15.0.0 release notes](https://github.com/LuckyPennySoftware/AutoMapper/releases/tag/v15.0.0)
- [Issue #4542: MapperConfiguration single argument constructor](https://github.com/LuckyPennySoftware/AutoMapper/issues/4542)
- [AutoMapper license configuration docs](https://docs.automapper.io/en/stable/License-configuration.html)
- [AutoMapper dependency injection docs](https://docs.automapper.io/en/stable/Dependency-injection.html)
- [GHSA-rvv3-g6hj-g44x: AutoMapper uncontrolled recursion](https://github.com/advisories/GHSA-rvv3-g6hj-g44x)
