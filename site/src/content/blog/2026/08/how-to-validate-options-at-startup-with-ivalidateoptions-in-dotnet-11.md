---
title: "How to validate options at startup with IValidateOptions<T> in .NET 11"
description: "Implement IValidateOptions<T>, register it in DI, and chain ValidateOnStart so a bad appsettings.json kills the process instead of the first request that touches it. Covers the .NET 11 Validate<TValidator>() overload, async validation through IAsyncValidateOptions<T>, and the three places ValidateOnStart silently does nothing."
pubDate: 2026-08-03
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "configuration"
  - "dependency-injection"
---

To fail an app at startup on bad configuration, write a class that implements `IValidateOptions<TOptions>`, register it in DI as a singleton, and chain `.ValidateOnStart()` onto the `OptionsBuilder<TOptions>` for that type. Without `ValidateOnStart`, validators run lazily on the first `.Value` access, which usually means the first request that touches the setting, in production, at 3am. With it, `Host.StartAsync` forces every registered options type to bind and validate before a single hosted service starts, and a failure throws `OptionsValidationException` out of `host.RunAsync()`. Everything below targets .NET 11 with `Microsoft.Extensions.Options` 11.0.0 and C# 14. The `IValidateOptions<T>` and `ValidateOnStart` core has behaved this way since the API moved from `Microsoft.Extensions.Hosting.dll` into `Microsoft.Extensions.Options.dll`, so it runs unchanged on .NET 8 through .NET 10; the `Validate<TValidator>()` overload and the async pipeline are new in .NET 11 and are called out explicitly.

## Lazy validation is validation you find out about from a customer

`ValidateDataAnnotations()` and `Validate(delegate)` both hang validators off the options pipeline, but the pipeline is lazy by design. `IOptions<T>` is a singleton whose `.Value` is computed the first time somebody reads it. Which means this registration:

```csharp
// .NET 11, C# 14
builder.Services
    .AddOptions<PaymentOptions>()
    .Bind(builder.Configuration.GetSection("Payments"))
    .ValidateDataAnnotations();
```

produces an app that boots cleanly with an empty `Payments` section, passes its health check, serves traffic, and then throws `OptionsValidationException` the first time a request reaches the checkout endpoint. Your deployment succeeded. Your canary was green. The failure surfaced as a 500 on a customer's card.

The whole point of startup validation is to convert that into a crash-on-boot, which orchestrators already know how to handle: the container exits non-zero, the rollout halts, the previous revision keeps serving. That is a much better failure than a partially broken process.

## Steps to make startup validation actually fire

1. **Define the options class with a section name.** Public read-write properties only, non-abstract, public parameterless constructor. Fields are not bound.
2. **Write the validator as a class implementing `IValidateOptions<TOptions>`**, returning `ValidateOptionsResult.Fail` with every failure rather than the first one.
3. **Register the validator in DI.** Use `TryAddEnumerable` with a singleton `ServiceDescriptor`, because the pipeline resolves `IEnumerable<IValidateOptions<TOptions>>` and a plain `AddSingleton` called twice gives you the validator twice.
4. **Chain `.ValidateOnStart()`** onto the builder, or start from `AddOptionsWithValidateOnStart<TOptions>()` so you cannot forget it.
5. **Run the host.** `ValidateOnStart` does nothing until `Host.StartAsync` executes. Building the host is not enough.

Here is the whole thing end to end.

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class PaymentOptions
{
    public const string SectionName = "Payments";

    [Required]
    public required string ApiKey { get; set; }

    [Required]
    [Url]
    public required string Endpoint { get; set; }

    [Range(1, 120)]
    public int TimeoutSeconds { get; set; } = 30;

    [Range(0, 10)]
    public int MaxRetries { get; set; } = 3;
}
```

The validator. Note that it collects failures instead of returning on the first one, so a developer fixing a broken `appsettings.json` gets the full list on one boot rather than one mistake per restart:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Options;

public sealed class ValidatePaymentOptions : IValidateOptions<PaymentOptions>
{
    public ValidateOptionsResult Validate(string? name, PaymentOptions options)
    {
        var builder = new ValidateOptionsResultBuilder();

        if (string.IsNullOrWhiteSpace(options.ApiKey))
        {
            builder.AddError("ApiKey is missing.", nameof(PaymentOptions.ApiKey));
        }
        else if (!options.ApiKey.StartsWith("pk_", StringComparison.Ordinal))
        {
            builder.AddError(
                "ApiKey must start with 'pk_'. A secret key was probably pasted by mistake.",
                nameof(PaymentOptions.ApiKey));
        }

        if (!Uri.TryCreate(options.Endpoint, UriKind.Absolute, out Uri? endpoint)
            || endpoint.Scheme != Uri.UriSchemeHttps)
        {
            builder.AddError(
                "Endpoint must be an absolute https URI.",
                nameof(PaymentOptions.Endpoint));
        }

        // Cross-property rule: nothing in DataAnnotations can express this.
        if (options.TimeoutSeconds * (options.MaxRetries + 1) > 300)
        {
            builder.AddError(
                $"TimeoutSeconds ({options.TimeoutSeconds}) times MaxRetries + 1 "
                + $"({options.MaxRetries + 1}) exceeds the 300s gateway budget.");
        }

        return builder.Build();
    }
}
```

`ValidateOptionsResultBuilder` lives in `Microsoft.Extensions.Options` and exists precisely so you do not hand-roll a `StringBuilder`. `Build()` returns `ValidateOptionsResult.Success` when nothing was added, so there is no null dance at the end. `AddError` takes an optional property name that gets prefixed into the message, and there is also `AddResult(ValidationResult)` and `AddResults(IEnumerable<ValidationResult>)` for bridging DataAnnotations output into the same bag.

Registration:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.DependencyInjection.Extensions;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptionsWithValidateOnStart<PaymentOptions>()
    .Bind(builder.Configuration.GetSection(PaymentOptions.SectionName))
    .ValidateDataAnnotations();

builder.Services.TryAddEnumerable(
    ServiceDescriptor.Singleton<IValidateOptions<PaymentOptions>, ValidatePaymentOptions>());

var app = builder.Build();
await app.RunAsync();
```

`AddOptionsWithValidateOnStart<TOptions>()` is just `AddOptions<TOptions>().ValidateOnStart()` with the ordering made unforgettable. There is also a two-generic overload, `AddOptionsWithValidateOnStart<TOptions, TValidateOptions>()`, which registers the validator for you and collapses the two registrations above into one call.

`ValidateDataAnnotations()` and a hand-written `IValidateOptions<T>` are not exclusive. The attributes handle the shape of individual properties; the class handles rules that span properties or need a service. All registered validators run, and all of their failures are collected.

## What ValidateOnStart actually registers

`ValidateOnStart` does not run anything at registration time. Read the .NET 11 [runtime source](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsBuilderExtensions.cs) and it is doing three things:

```csharp
optionsBuilder.Services.TryAddTransient<IStartupValidator, StartupValidator>();
optionsBuilder.Services.TryAddTransient<IAsyncStartupValidator, StartupValidator>();
optionsBuilder.Services.AddOptions<StartupValidatorOptions>()
    .Configure<IOptionsMonitor<TOptions>>((vo, options) =>
    {
        // This adds an action that resolves the options value to force evaluation
        // We don't care about the result as duplicates are not important
        vo._validators[(typeof(TOptions), optionsBuilder.Name)] = () => options.Get(optionsBuilder.Name);
    });
```

It appends a thunk into an internal dictionary on `StartupValidatorOptions`, keyed by `(Type, name)`. The thunk calls `IOptionsMonitor<TOptions>.Get(name)`, which is what forces `OptionsFactory<TOptions>.Create` to run the `IConfigureOptions<T>` chain, then the `IPostConfigureOptions<T>` chain, then every `IValidateOptions<T>`. Validation is a side effect of forcing the bind.

The `TryAdd` matters. In earlier releases this was `AddTransient`, so calling `ValidateOnStart` on ten options types put ten copies of `StartupValidator` in the container. The dictionary key also explains an old sharp edge: keying on `(Type, name)` is what makes named options each get their own entry instead of the last one overwriting the rest.

The trigger is in `Host.StartAsync`, after `IHostLifetime.WaitForStartAsync` and before any hosted service starts:

```csharp
IStartupValidator? validator = Services.GetService<IStartupValidator>();
validator?.Validate();

IAsyncStartupValidator? asyncValidator = Services.GetService<IAsyncStartupValidator>();
if (asyncValidator is not null)
{
    await asyncValidator.ValidateAsync(cancellationToken).ConfigureAwait(false);
}
```

Two consequences worth internalizing. First, validation runs before `IHostedLifecycleService.StartingAsync`, so a `BackgroundService` never observes a half-valid configuration. Second, if more than one options type fails, `StartupValidator` collects the exceptions and rethrows them as an `AggregateException`, so you see every broken section in one log line instead of playing whack-a-mole across restarts.

## The .NET 11 Validate<TValidator>() overload

Before .NET 11, wiring a validator meant two statements that had to agree with each other: an `AddSingleton` for the validator and a separate `AddOptions` chain. .NET 11 adds a generic [`OptionsBuilder<TOptions>.Validate<TValidator>()`](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries#options-builder-validation-improvements) overload that takes a type parameter instead of a delegate:

```csharp
// .NET 11 only
services.AddSingleton<IValidateOptions<MyOptions>, MyOptionsValidator>();
services.AddOptions<MyOptions>()
    .Bind(configuration.GetSection("MyOptions"))
    .Validate<MyOptionsValidator>();
```

The validator type must implement `IValidateOptions<TOptions>` and must already be registered in the container, which is the point: the validator is resolved from DI, so it can take constructor dependencies like `IHostEnvironment`, a `TimeProvider`, or an `HttpClient`. That was previously awkward because the delegate overloads of `Validate` only give you the options instance and up to five injected services on the `Configure` side.

Do not skip the `AddSingleton`. The overload resolves the type; it does not register it.

## Async validation with IAsyncValidateOptions<T>

The interesting .NET 11 addition is that startup validation can now do I/O. Some configuration is only wrong in ways you cannot see without asking something: a connection string that parses but points at a database that does not exist, an OIDC authority whose discovery document 404s, a blob container the managed identity cannot read. Before .NET 11 the only honest options were to block a thread inside `Validate` or to give up and check at first use.

`IAsyncValidateOptions<TOptions>` is the async twin of `IValidateOptions<TOptions>`:

```csharp
namespace Microsoft.Extensions.Options;

public interface IAsyncValidateOptions<in TOptions> where TOptions : class
{
    Task<ValidateOptionsResult> ValidateAsync(
        string? name, TOptions options, CancellationToken cancellationToken = default);
}
```

An implementation that proves the payment endpoint is actually reachable:

```csharp
// .NET 11 only
using Microsoft.Extensions.Options;

public sealed class ValidatePaymentEndpointAsync(IHttpClientFactory httpClientFactory)
    : IAsyncValidateOptions<PaymentOptions>
{
    public async Task<ValidateOptionsResult> ValidateAsync(
        string? name, PaymentOptions options, CancellationToken cancellationToken = default)
    {
        using HttpClient client = httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(5);

        try
        {
            using HttpResponseMessage response = await client.GetAsync(
                new Uri(new Uri(options.Endpoint), "/.well-known/health"), cancellationToken);

            return response.IsSuccessStatusCode
                ? ValidateOptionsResult.Success
                : ValidateOptionsResult.Fail(
                    $"Payment endpoint {options.Endpoint} returned {(int)response.StatusCode}.");
        }
        catch (HttpRequestException ex)
        {
            return ValidateOptionsResult.Fail(
                $"Payment endpoint {options.Endpoint} is unreachable: {ex.Message}");
        }
    }
}
```

Register it the same way as the sync one, with `TryAddEnumerable` against `IAsyncValidateOptions<PaymentOptions>`, and keep the `ValidateOnStart()` call. The registration in `OptionsBuilderExtensions` materializes any registered `IAsyncValidateOptions<TOptions>` into a second dictionary, `_asyncValidators`, and only installs the async delegate if at least one exists. If none are registered, nothing changes and there is no async cost.

Two behaviours to plan around. Async validators only run at startup: the async pipeline hangs off `IAsyncStartupValidator`, not off `IOptionsFactory`, so a lazy `.Value` access later never triggers them. And stage 2 only runs if stage 1 succeeded, which is deliberate. There is no reason to spend five seconds on network probes when the endpoint URL failed its `[Url]` attribute.

The matching DataAnnotations work landed at the same time: `AsyncValidationAttribute` with an overridable `IsValidAsync`, `IAsyncValidatableObject` on the model, and `Validator.ValidateObjectAsync` / `TryValidateObjectAsync` / `ValidatePropertyAsync` / `ValidateValueAsync`. Reach for those if you want the rule expressed as an attribute on the property instead of as a separate class.

## Skip the handwritten validator with [OptionsValidator]

If every rule you have is a DataAnnotations attribute, do not write the `Validate` method at all. The options validation source generator writes an `IValidateOptions<T>` implementation for you at compile time:

```csharp
// .NET 8 and later
using Microsoft.Extensions.Options;

[OptionsValidator]
public sealed partial class ValidatePaymentOptions : IValidateOptions<PaymentOptions>
{
}
```

An empty partial class plus the attribute, and the generator emits a `Validate(string?, PaymentOptions)` that calls `Validator.TryValidateValue` per property with pre-allocated static attribute instances, collecting into a `ValidateOptionsResultBuilder`. No reflection over the options type at runtime, which is why this is the right shape for Native AOT. The generator is on by default whenever the project references `Microsoft.Extensions.Options` 8.0 or later, and `ValidateDataAnnotations()` becomes redundant once you use it. It also replaces `RangeAttribute`, `MinLengthAttribute`, `MaxLengthAttribute`, and `LengthAttribute` with non-reflective equivalents in generated code. If you want more background on what a generator is doing to your build, see the walkthrough on [what a source generator is and when you need one](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/), and the [trim-safe code](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) notes for why reflection-free validation matters under trimming.

By default DataAnnotations validation is not recursive. A nested options object or a `List<T>` of sub-options is not validated unless you say so, with `[ValidateObjectMembers]` and `[ValidateEnumeratedItems]` respectively. Both work with the generator.

## Where ValidateOnStart silently does nothing

The failure mode nobody catches in review is `ValidateOnStart` being registered but never running. Three cases:

**You never start the host.** A test or tool that calls `builder.Build()` and resolves services out of `host.Services` without `StartAsync` skips validation entirely. If you want a build-time check in an integration test, resolve the options explicitly with `GetRequiredService<IOptions<T>>().Value` inside a `try`, or call `host.Services.GetService<IStartupValidator>()?.Validate()` directly.

**The host is not `Microsoft.Extensions.Hosting`'s.** The call site quoted above lives in `Host.StartAsync`. Runtimes that build their own host, most famously the Azure Functions in-process model, never reach it, which is exactly [dotnet/runtime#96034](https://github.com/dotnet/runtime/issues/96034). The isolated worker model is a normal generic host and works. On anything unusual, verify with a deliberately broken section rather than assuming.

**You registered the validator but not the builder.** `services.Configure<T>(section)` plus a validator registration gives you lazy validation only. `Configure<T>` does not create an `OptionsBuilder<T>`, so there is nothing to chain `ValidateOnStart` onto. You need `AddOptions<T>().Bind(section)` or `AddOptionsWithValidateOnStart<T>().Bind(section)`.

One more that is not silent but is easy to misread: validators run per named instance. If you have three named `PaymentOptions` and only call `AddOptions<PaymentOptions>("primary").ValidateOnStart()`, the other two are validated lazily. Each name needs its own chain. When you are wiring several variants of the same settings class, this pairs naturally with [keyed services in .NET 11 DI](/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) for the consumers.

## What to do with the exception

`OptionsValidationException` carries `OptionsType`, `OptionsName`, and `Failures` as an `IEnumerable<string>`. Its `Message` is the failures joined with `;`, which is fine in a container log and unreadable in a terminal. If the app is a CLI or a developer-facing service, catching it at the top of `Main` and writing one failure per line is a small kindness:

```csharp
// .NET 11, C# 14
try
{
    await app.RunAsync();
}
catch (OptionsValidationException ex)
{
    Console.Error.WriteLine($"Invalid configuration for {ex.OptionsType.Name}:");
    foreach (string failure in ex.Failures)
    {
        Console.Error.WriteLine($"  - {failure}");
    }
    return 78; // EX_CONFIG
}
```

Wrap that in a `catch (AggregateException agg)` too if you validate more than one options type, since that is how `StartupValidator` surfaces multiple failures.

Startup validation is the cheapest reliability work available in a .NET app. It is one method call on a builder you already have, and it converts an entire category of production incident, the misconfigured deployment, into a boot failure that your rollout process already knows how to handle.

## Related

- [IOptions&lt;T&gt; vs IOptionsSnapshot&lt;T&gt; vs IOptionsMonitor&lt;T&gt; in .NET 11](/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) picks the right accessor before you validate it.
- [Fix: Cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) covers the captive-dependency error you will hit if a validator takes a scoped dependency.
- [Fix: No connection string named 'DefaultConnection' could be found](/2026/05/fix-no-connection-string-named-defaultconnection/) is the classic lazy-configuration failure that startup validation prevents.
- [What is a source generator and when do I need one?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) explains what `[OptionsValidator]` is doing at compile time.
- [What is the IHostedService contract and when do I use it?](/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) shows what runs immediately after validation passes.

## Sources

- [Options pattern in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/options) on MS Learn, for `ValidateOnStart`, `AddOptionsWithValidateOnStart`, and recursive validation attributes.
- [Compile-time options validation source generation](https://learn.microsoft.com/en-us/dotnet/core/extensions/options-validation-generator) for `[OptionsValidator]` and the generated output.
- [What's new in .NET libraries for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries) for the `Validate<TValidator>()` overload and async DataAnnotations validation.
- [`OptionsBuilderExtensions.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsBuilderExtensions.cs) and [`IAsyncValidateOptions.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/IAsyncValidateOptions.cs) in dotnet/runtime.
- [dotnet/runtime#96034](https://github.com/dotnet/runtime/issues/96034), `ValidateOnStart()` does not work in Azure Functions.
