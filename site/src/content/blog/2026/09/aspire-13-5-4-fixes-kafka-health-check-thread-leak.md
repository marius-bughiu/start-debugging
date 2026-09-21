---
title: "Aspire 13.5.4 Stops Kafka Health Checks From Leaking a Producer on Every Probe"
description: "Before Aspire 13.5.4, every AppHost health check on an AddKafka resource created a new Confluent producer that nobody disposed, so polling threads piled up and the AppHost burned CPU. The fix, and the HealthCheckRegistration.Factory trap behind it, applies to your own health checks too."
pubDate: 2026-09-21
tags:
  - "aspire"
  - "kafka"
  - "dotnet"
  - "health-checks"
  - "dependency-injection"
---

[Aspire 13.5.4](https://github.com/microsoft/aspire/releases/tag/v13.5.4) shipped on September 15, 2026, and it is a patch release worth taking if your AppHost calls `AddKafka`. Through 13.5.3, the Kafka health check that `Aspire.Hosting.Kafka` registers created a brand new Confluent.Kafka producer on every execution and never disposed it. Each producer starts its own polling thread, so a long-running AppHost slowly filled up with threads stuck in `SafeKafkaHandle.Poll`. The report in [issue #20091](https://github.com/microsoft/aspire/issues/20091) saw an AppHost on macOS sitting at 350-400% CPU, with a thread-sampling trace showing 1,901 of 1,934 sampled threads inside Kafka's poll loop.

If you ever left `dotnet run` on an AppHost open for an afternoon and wondered why the fans spun up, this is a likely candidate.

## Where the producers came from

The hosting integration built its check inside a `HealthCheckRegistration` factory:

```csharp
var healthCheckRegistration = new HealthCheckRegistration(
    healthCheckKey,
    sp =>
    {
        var options = new KafkaHealthCheckOptions();
        options.Configuration = new ProducerConfig();
        options.Configuration.BootstrapServers = connectionString
            ?? throw new InvalidOperationException("Connection string is unavailable");
        return new KafkaHealthCheck(options);
    },
    failureStatus: default,
    tags: default);
builder.Services.AddHealthChecks().Add(healthCheckRegistration);
```

`HealthCheckService` calls that factory for every run of the check. `KafkaHealthCheck` lazily creates a producer and releases it in `Dispose()`, but the object returned from the factory was constructed with `new`, not resolved from the container. The health-check runner does open and dispose a DI scope per run, yet a scope only disposes instances it created itself. Nothing ever called `Dispose()` on the check, so every probe left one more producer and one more polling thread behind.

The code avoided `AddKafka(...)` from the Xabaril health-checks package on purpose: that helper registers a singleton, and with two Kafka resources the factory would read the last resource's connection string ([Xabaril #2298](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks/issues/2298)). The workaround fixed the configuration bug and introduced the lifetime bug.

## The fix: let DI own the check

[PR #20092](https://github.com/microsoft/aspire/pull/20092), backported to 13.5.4 as #20094, registers one keyed singleton per Kafka resource and makes the factory resolve it:

```csharp
builder.Services.AddKeyedSingleton<KafkaHealthCheck>(healthCheckKey, (sp, _) =>
{
    var options = new KafkaHealthCheckOptions();
    options.Configuration = new ProducerConfig();
    options.Configuration.BootstrapServers = connectionString
        ?? throw new InvalidOperationException("Connection string is unavailable");
    return new KafkaHealthCheck(options);
});

var healthCheckRegistration = new HealthCheckRegistration(
    healthCheckKey,
    sp => sp.GetRequiredKeyedService<KafkaHealthCheck>(healthCheckKey),
    failureStatus: default,
    tags: default);
```

Keying by `"{name}_check"` keeps each resource's bootstrap servers separate, the producer is reused across probes, and the root container disposes it when the AppHost shuts down. The PR's measurement against two real Kafka 8.2.0 brokers: 84 health-check executions produced 84 check instances and 84 polling threads on 13.5.3, versus 2 instances and 2 threads with the fix, and 0 threads left after disposal.

## Upgrading

Bump the Aspire packages in the AppHost project:

```xml
<PackageReference Include="Aspire.Hosting.Kafka" Version="13.5.4" />
```

No AppHost code changes are needed and there is no public API change. The same release also fixes DevTunnel failures with auto-selected regions (a 13.3 regression), hides the unused `azure-environment` resource in emulator-only AppHosts, and marks `IAwsRadiusProviderBuilder` and `IAzureRadiusProviderBuilder` with the `ASPIRERADIUS003` experimental diagnostic, which can surface as a new warning-as-error if you reference those interfaces directly.

## Check your own health checks for the same pattern

The bug is not Kafka-specific. Any `HealthCheckRegistration` factory that returns `new SomethingDisposable(...)` leaks one instance per probe, and at the default 30-second period of the health-check publisher that is 2,880 leaked objects a day per check. Either register the check in DI and resolve it in the factory, as Aspire now does, or keep the expensive client (producer, connection, `HttpClient`) in a singleton and let the check stay a cheap, stateless object. If you are still on the 13.5 line, the [earlier post on `WithTerminal()`](/2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard/) covers the rest of what 13.5 changed in the dashboard.
