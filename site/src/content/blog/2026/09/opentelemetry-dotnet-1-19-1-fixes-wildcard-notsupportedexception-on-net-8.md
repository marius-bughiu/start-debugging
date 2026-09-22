---
title: "OpenTelemetry .NET 1.19.1 fixes the wildcard NotSupportedException on net8.0"
description: "OpenTelemetry 1.19.0 switched its wildcard source regex to RegexOptions.NonBacktracking, which throws on net8.0 once you register enough sources. 1.19.1, released on September 21, 2026, goes back to a compiled regex with a match timeout."
pubDate: 2026-09-22
tags:
  - "dotnet"
  - "opentelemetry"
  - "observability"
  - "dotnet-8"
---

[OpenTelemetry .NET 1.19.1](https://github.com/open-telemetry/opentelemetry-dotnet/releases/tag/core-1.19.1) shipped on September 21, 2026, three days after 1.19.0. It contains exactly one notable change, and if your app targets `net8.0` and registers a long list of activity sources or meters, it is the difference between a working `TracerProvider` and a startup crash.

## What 1.19.0 broke

The SDK turns your `AddSource("...")` and `AddMeter("...")` names into a single regex whenever at least one of them contains `*` or `?`. [PR #7760](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7760), merged for 1.19.0, hardened that regex by building it with `RegexOptions.NonBacktracking` on modern .NET. The intent was good: no catastrophic backtracking, no matter what pattern ends up in the list.

The problem is that the non-backtracking engine compiles the pattern into an automaton with a hard size cap, and that cap is 1,000 nodes on .NET 8 (10,000 on .NET 9 and later). One alternation branch per source adds up fast. The Grafana OpenTelemetry distro, which pre-registers dozens of sources, hit it immediately, as reported in [issue #7787](https://github.com/open-telemetry/opentelemetry-dotnet/issues/7787):

```text
System.NotSupportedException : The specified pattern with RegexOptions.NonBacktracking
could result in an automata as large as '1285' nodes, which is larger than the configured
limit of '1000'.
   at OpenTelemetry.WildcardHelper.GetWildcardRegex(IEnumerable`1 patterns)
   at OpenTelemetry.Trace.TracerProviderSdk..ctor(IServiceProvider serviceProvider, Boolean ownsServiceProvider)
```

Note the trigger: a single wildcard anywhere in the list pulls every source name into the regex. A configuration like this is enough on `net8.0` once the list is long enough:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing
        .AddSource("MyCompany.Orders", "MyCompany.Billing", "MyCompany.Shipping")
        .AddSource(internalSourceNames)   // a few hundred names from config
        .AddSource("AWSSDK.*")            // one wildcard switches on regex mode
        .AddOtlpExporter());
```

`net9.0`, `net10.0` and .NET Framework builds were unaffected by the exception. They were not unaffected by the cost, though: the PR notes that a non-backtracking `Regex` retains roughly 35x more memory than a backtracking one, so test suites and hosts that build many providers over the process lifetime could run into `OutOfMemoryException`.

## What 1.19.1 does instead

[PR #7788](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7788) drops `NonBacktracking` on every target framework and goes back to a compiled regex, keeping the protection through a match timeout:

```csharp
var pattern = "^(?:" + convertedPattern + ")$";

return new Regex(pattern, RegexOptions.Compiled | RegexOptions.IgnoreCase, RegexMatchTimeout);
// RegexMatchTimeout = TimeSpan.FromSeconds(1)
```

`WildcardHelper.IsMatch` catches `RegexMatchTimeoutException` and returns `false`, so a pathological pattern means one source is not listened to rather than a hung thread. The same change applies to wildcard instrument names in `AddView`, which also used `NonBacktracking` on modern .NET.

## Upgrading

Bump every OpenTelemetry core package together, since they version in lockstep:

```bash
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.19.1
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.19.1
```

If you are on 1.18.x, you can skip 1.19.0 entirely. If you already rolled out 1.19.0 on `net8.0` and it did not throw, you are under the node limit today, but adding a few more sources later would have tripped it at startup, so upgrade anyway. For a refresher on the wider setup, my walkthrough on [using OpenTelemetry with .NET 11 and a free backend](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) still applies unchanged.

The broader lesson is worth keeping: `RegexOptions.NonBacktracking` is not a free safety switch. It trades backtracking risk for an automaton size limit and a larger memory footprint, and on .NET 8 that limit is small enough to hit with ordinary configuration.
