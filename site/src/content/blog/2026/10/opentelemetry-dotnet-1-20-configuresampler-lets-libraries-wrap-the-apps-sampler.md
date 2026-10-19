---
title: "OpenTelemetry .NET 1.20: ConfigureSampler lets libraries wrap the app's sampler"
description: "OpenTelemetry .NET 1.20.0, released on October 15, 2026, adds TracerProviderBuilder.ConfigureSampler. A library can now wrap the sampler the SDK resolved from SetSampler, OTEL_TRACES_SAMPLER, or the default, instead of silently overwriting it."
pubDate: 2026-10-19
tags:
  - "dotnet"
  - "opentelemetry"
  - "observability"
  - "tracing"
---

[OpenTelemetry .NET 1.20.0](https://github.com/open-telemetry/opentelemetry-dotnet/releases/tag/core-1.20.0) shipped on October 15, 2026. Most of the changelog is fixes (a `SuppressInstrumentationScope` refcount leak, `ResourceBuilder.CreateDefault` ignoring `OTEL_SERVICE_NAME`, two metric races), but one new API changes how libraries and distros should touch sampling: `TracerProviderBuilder.ConfigureSampler`.

## SetSampler was always last-writer-wins

Until 1.19.x, the only way to influence the trace sampler was `SetSampler`. A programmatic sampler beats the `OTEL_TRACES_SAMPLER` environment variable, which beats the default `ParentBased(AlwaysOnSampler)`. That precedence is fine for application code, but it is hostile to libraries. A package that wanted to drop its own noisy spans had to call `SetSampler`, and the moment it did, the operator's `OTEL_TRACES_SAMPLER=traceidratio` was logged as ignored and thrown away. Two libraries doing the same thing conflicted silently: whichever registered last won.

## What ConfigureSampler does

[PR #7780](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7780) adds a callback that receives the sampler the SDK already resolved and returns the one to use:

```csharp
public static TracerProviderBuilder ConfigureSampler(
    this TracerProviderBuilder tracerProviderBuilder,
    Func<IServiceProvider, Sampler, Sampler> configureSampler);
```

The rules, from the XML docs:

- Callbacks run after the SDK picks a sampler from `SetSampler`, `OTEL_TRACES_SAMPLER`, or the default, regardless of whether they are registered before or after `SetSampler`.
- Each callback runs once, during `Build()`. The provider's sampler stays immutable afterwards.
- Multiple callbacks chain in registration order, each receiving the previous result.
- Returning `null` or throwing fails the provider build.

So a library can decorate whatever the app configured instead of replacing it:

```csharp
public sealed class DropPollingSpansSampler(Sampler inner) : Sampler
{
    public override SamplingResult ShouldSample(in SamplingParameters parameters)
    {
        // The library's background poll loop creates a span every second.
        if (parameters.Name == "MyLibrary.Poll")
        {
            return new SamplingResult(SamplingDecision.Drop);
        }

        return inner.ShouldSample(parameters);
    }
}

public static class MyLibraryTracingExtensions
{
    public static TracerProviderBuilder AddMyLibrary(this TracerProviderBuilder builder) =>
        builder
            .AddSource("MyLibrary")
            .ConfigureSampler((_, resolved) => new DropPollingSpansSampler(resolved));
}
```

With `OTEL_TRACES_SAMPLER=traceidratio` and `OTEL_TRACES_SAMPLER_ARG=0.1` set, the app still samples 10% of traces, and the library only drops its poll spans in front of that decision. Swap the env var for an explicit `SetSampler(new AlwaysOnSampler())` in `Program.cs` and the wrapper picks that up too, with no ordering games.

## The disposal caveat

The provider only disposes the final sampler. If your callback discards the sampler it receives, or wraps it, you own the inner sampler's lifetime. For stateless samplers like `TraceIdRatioBasedSampler` this does not matter. For anything holding a timer or a remote config connection, forward `Dispose` from your wrapper.

## Who should switch

If you maintain a library or an internal distro that calls `SetSampler` today, move to `ConfigureSampler` so you stop overriding the operator's configuration. Application code can keep using `SetSampler`, it still has the top precedence slot. The PR also positions this as groundwork for remotely controlled sampling and declarative configuration, where the sampler choice moves out of code entirely.

Upgrade the core packages together, since they version in lockstep:

```bash
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.20.0
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.20.0
```

If you skipped the previous patch, the [1.19.1 wildcard regex fix](/2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8/) is included as well.
