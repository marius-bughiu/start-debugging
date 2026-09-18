---
title: "Polly 8.8 Reloads a Resilience Pipeline From Your Own IOptionsMonitor"
description: "Polly 8.8.0 adds EnableReloadsWithMonitor, so a resilience pipeline can hot-reload from a feature flag or remote config monitor that is not registered in DI. A probe shows the rebuild, and one trap: context.GetOptions still reads the DI monitor and returns defaults."
pubDate: 2026-09-18
tags:
  - "polly"
  - "resilience"
  - "dotnet"
  - "csharp"
  - "configuration"
---

[Polly 8.8.0](https://github.com/App-vNext/Polly/releases/tag/8.8.0) went out on 2026-09-14, and its headline change is small but fills a real gap in `Polly.Extensions`. Until now, the only way to hot-reload a DI-registered resilience pipeline was `context.EnableReloads<TOptions>()`, which resolves `IOptionsMonitor<TOptions>` from the container. If your retry counts or timeouts come from a feature flag SDK, a remote config client, or a monitor you build yourself, you had to register it in DI first or give up on reloads.

## The new overload

[PR #3140](https://github.com/App-vNext/Polly/pull/3140) adds `EnableReloadsWithMonitor<TOptions>(IOptionsMonitor<TOptions> monitor, string? name = null)` on `AddResiliencePipelineContext<TKey>`. The old `EnableReloads<TOptions>()` is now a one-liner that resolves the monitor from DI and calls the new method. Both end up in the same place: the registry subscribes to `monitor.OnChange` and rebuilds the pipeline when it fires.

Here is a minimal version with a hand-rolled monitor standing in for a flag service:

```csharp
var flags = new FlagMonitor<RetryFlags>(new RetryFlags { MaxRetries = 1 });

services.AddResiliencePipeline("orders", (builder, context) =>
{
    context.EnableReloadsWithMonitor(flags);

    var opts = flags.CurrentValue;
    builder.AddRetry(new() { MaxRetryAttempts = opts.MaxRetries, Delay = TimeSpan.Zero });
});

public sealed class FlagMonitor<T>(T initial) : IOptionsMonitor<T>
{
    private readonly List<Action<T, string?>> _listeners = [];
    public T CurrentValue { get; private set; } = initial;
    public T Get(string? name) => CurrentValue;

    public IDisposable OnChange(Action<T, string?> listener)
    {
        _listeners.Add(listener);
        return new Unsub(() => _listeners.Remove(listener));
    }

    public void Set(T value)
    {
        CurrentValue = value;
        foreach (var l in _listeners.ToArray()) l(value, Options.DefaultName);
    }

    private sealed class Unsub(Action a) : IDisposable { public void Dispose() => a(); }
}
```

I ran this as a file-based app on SDK 10.0.302 against `Polly.Extensions` 8.8.0. The pipeline always throws, so the attempt count shows the retry setting that is active:

```text
building pipeline with MaxRetries=1
attempts: 2
building pipeline with MaxRetries=4
attempts after change: 5
same instance: True
```

After `flags.Set(...)`, the configure callback ran again and the next call made five attempts. The `ResiliencePipeline` you got from `GetPipeline("orders")` is still the same object. Polly swaps the inner pipeline behind it, so code that cached the pipeline in a field picks up the change without asking for it again. On 8.7.0 the same file fails with CS1061, because the method does not exist there.

## The GetOptions trap

The configure callback also has `context.GetOptions<TOptions>()`, and it is tempting to use it next to the new method. Don't. `GetOptions` still resolves `IOptionsMonitor<TOptions>` from the container, and `AddResiliencePipeline` registers the options infrastructure, so it does not throw. It hands you a default-constructed instance. In the probe, `context.GetOptions<RetryFlags>().MaxRetries` returned `0` on both builds, while the custom monitor said `1` and then `4`. A pipeline built from that value would have silently stopped retrying.

When you pass your own monitor, read the values from that same monitor (`flags.CurrentValue` or `flags.Get(name)`) inside the callback.

## Also in 8.8.0

[PR #3220](https://github.com/App-vNext/Polly/pull/3220) fixes a Simmy bug: an empty `FaultGenerator`, or one whose weights add up to zero, threw `InvalidOperationException: Nullable object must have a value` instead of injecting nothing. The generator now returns `null` and the chaos strategy lets the call through. The release also includes ".NET 11 preparation" work and a move to xunit v3 in the test suite.

If you still need to decide whether you want Polly pipelines or `Microsoft.Extensions.Http.Resilience` handlers at all, [Polly vs resilience handlers in .NET 11](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) walks through the trade-off.
