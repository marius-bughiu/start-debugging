---
title: "How to add a health check endpoint to a minimal API in ASP.NET Core 11"
description: "A complete, working guide to health checks in an ASP.NET Core 11 minimal API: AddHealthChecks and MapHealthChecks, custom IHealthCheck classes returning Healthy/Degraded/Unhealthy, the AddDbContextCheck EF Core probe, tag-based liveness and readiness endpoints for Kubernetes, a JSON ResponseWriter, ResultStatusCodes, securing the endpoint with RequireAuthorization and RequireHost, and pushing results with IHealthCheckPublisher."
pubDate: 2026-07-19
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "health-checks"
---

To add a health check endpoint to a minimal API in ASP.NET Core 11 you call `builder.Services.AddHealthChecks()` to register the service, optionally chain `.AddCheck(...)` calls to describe what "healthy" means for your app, and then call `app.MapHealthChecks("/healthz")` to expose an endpoint. Hit that URL and you get `200 OK` with the body `Healthy` when every check passes, or `503 Service Unavailable` when any check reports `Unhealthy`. That two-line setup is the whole minimum. This post takes it from that minimum to a production-grade setup: a custom `IHealthCheck` that actually probes a dependency, the built-in EF Core database probe, separate liveness and readiness endpoints wired for Kubernetes, a JSON response body, correct HTTP status codes, and how to lock the endpoint down. It targets .NET 11 (Preview 6 at the time of writing, GA in November 2026) with `Microsoft.NET.Sdk.Web` and C# 14, but the health-checks API has been stable since ASP.NET Core 2.2, so every example here runs unchanged on .NET 8, 9, and 10.

## What a health check endpoint is actually for

A health check endpoint is a URL an orchestrator, load balancer, or uptime monitor can poll to ask "should I be sending this instance traffic?" The answer is deliberately coarse: an aggregate status computed from a set of registered checks, surfaced as an HTTP status code so that anything speaking HTTP can consume it without parsing a body. Kubernetes uses it to decide whether to restart a pod or route requests to it. An Azure App Service or an AWS target group uses it to pull an unhealthy instance out of rotation. A tool like Uptime Kuma uses it to page you.

The key design point is that a health check is not a metrics endpoint and not a diagnostics dashboard. It answers one question fast, ideally in a few milliseconds, and its checks should test only the things that genuinely determine whether this process can serve requests: is the database reachable, is a critical downstream API responding, has the app finished its startup work. Piling slow or non-essential probes into it turns a liveness signal into a liability, because a slow health check under load causes the cascading restarts it was meant to prevent.

## Steps to add a health check endpoint

1. Register the service with `builder.Services.AddHealthChecks()`, which returns an `IHealthChecksBuilder`.
2. Chain `.AddCheck(...)` or `.AddCheck<T>(...)` calls onto that builder for each dependency you want to probe.
3. Build the app and call `app.MapHealthChecks("/healthz")` to map the endpoint.
4. Optionally pass a `HealthCheckOptions` to filter checks by tag, shape the response, or remap status codes.
5. Optionally chain `.RequireAuthorization()` or `.RequireHost(...)` to control who can reach it.

The rest of this article expands each of those into working code.

## The two-line starting point

Here is the smallest thing that works. `AddHealthChecks` with no checks registered is still useful: it gives you a liveness endpoint that returns `Healthy` as long as the process is up and the request pipeline is turning.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHealthChecks();

var app = builder.Build();

app.MapHealthChecks("/healthz");

app.Run();
```

A `GET /healthz` now returns `200 OK` with the plain-text body `Healthy`. There are no checks registered, so there is nothing that can fail. This alone answers "is the process alive and serving HTTP", which is precisely what a Kubernetes liveness probe wants. Everything past this point is about registering checks that can report something other than healthy, and about shaping how the endpoint communicates.

## Writing a custom check with IHealthCheck

A real check probes a dependency and reports one of three states. Implement `IHealthCheck`, whose single method returns a `HealthCheckResult`:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Diagnostics.HealthChecks;

public sealed class QueueDepthHealthCheck : IHealthCheck
{
    private readonly IMessageQueue _queue;

    public QueueDepthHealthCheck(IMessageQueue queue) => _queue = queue;

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var depth = await _queue.GetApproximateDepthAsync(cancellationToken);

            if (depth > 10_000)
            {
                return HealthCheckResult.Unhealthy(
                    $"Queue backlog is {depth} messages.");
            }

            if (depth > 1_000)
            {
                // Still serving, but the backlog is a warning sign.
                return HealthCheckResult.Degraded(
                    $"Queue backlog is {depth} messages.",
                    data: new Dictionary<string, object> { ["depth"] = depth });
            }

            return HealthCheckResult.Healthy($"Queue depth {depth}.");
        }
        catch (Exception ex)
        {
            // Could not even reach the queue: that is unhealthy, not an unhandled 500.
            return HealthCheckResult.Unhealthy("Queue is unreachable.", ex);
        }
    }
}
```

The three factory methods map to the three members of the `HealthStatus` enum. `Healthy` means fully operational. `Unhealthy` means this instance cannot do its job and should be pulled from rotation or restarted. `Degraded` is the interesting middle: the app is still serving requests, but something is off (a slow dependency, a growing backlog), and by default a degraded result still returns `200 OK`. That is deliberate: you usually do not want an orchestrator to restart a pod just because a queue is filling up. The optional `data` dictionary rides along in the report and shows up in a JSON response body, which is handy for a dashboard without changing the pass/fail decision.

Register the class and give it a name and, optionally, a failure status and tags:

```csharp
// .NET 11, C# 14
builder.Services.AddHealthChecks()
    .AddCheck<QueueDepthHealthCheck>(
        "queue",
        failureStatus: HealthStatus.Unhealthy,
        tags: ["ready"]);
```

The constructor dependency (`IMessageQueue`) is resolved from DI, so your check can inject any registered service. If you need to pass literal constructor arguments that are not in the container, use `AddTypeActivatedCheck<T>(...)` and supply an `args` array instead.

For a throwaway inline check that does not deserve a class, the lambda form is enough:

```csharp
// .NET 11, C# 14
builder.Services.AddHealthChecks()
    .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"]);
```

## Probing the database with AddDbContextCheck

The single most common thing teams want in a readiness probe is "can I reach the database". You do not need to write an `IHealthCheck` for that. Add the `Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore` package and use the built-in `AddDbContextCheck<TContext>`:

```csharp
// .NET 11, C# 14
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(
        builder.Configuration.GetConnectionString("DefaultConnection")));

builder.Services.AddHealthChecks()
    .AddDbContextCheck<AppDbContext>("database", tags: ["ready"]);
```

Under the hood this calls `DbContext.Database.CanConnectAsync`, which opens a connection and closes it without running a query. That is the right default: it is cheap and it verifies exactly what a readiness probe cares about, that the connection string resolves and the server accepts connections. If you need something stronger, `AddDbContextCheck` has an overload that takes a custom test query, but for the common case `CanConnectAsync` is what you want. For deeper wiring on preparing EF Core before first use, see [how to warm up EF Core's model before the first query](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/); a health check that runs `CanConnectAsync` is a natural place for that warm-up to have already happened.

Community packages under `AspNetCore.Diagnostics.HealthChecks` (the Xabaril project) provide ready-made checks for Redis, RabbitMQ, PostgreSQL, blob storage, and dozens of other dependencies with the same `.Add...` pattern, so you rarely need to hand-write a probe for a well-known service.

## Separate liveness and readiness endpoints

Kubernetes distinguishes two probes, and conflating them is the most common health-check mistake. A liveness probe answers "is this process wedged and does it need a restart"; if it fails, Kubernetes kills the pod. A readiness probe answers "is this instance ready to receive traffic right now"; if it fails, Kubernetes stops routing to it but leaves it running. You do not want your database being briefly unreachable to trigger a pod restart, because a restart cannot fix the database and just removes capacity. So the database check belongs on readiness, not liveness.

The mechanism is tags plus the `Predicate` on `HealthCheckOptions`. Register checks with tags, then map two endpoints that each filter to the right set:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Diagnostics.HealthChecks;

app.MapHealthChecks("/health/live", new HealthCheckOptions
{
    // Liveness: run no dependency checks. If the pipeline responds, we are alive.
    Predicate = _ => false
});

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    // Readiness: only the checks tagged "ready" (database, queue, downstreams).
    Predicate = check => check.Tags.Contains("ready")
});
```

`Predicate = _ => false` means "include no checks", so `/health/live` short-circuits to `Healthy` the moment the request reaches the endpoint. `/health/ready` runs only the checks you tagged `ready`. Point your Kubernetes `livenessProbe` at `/health/live` and your `readinessProbe` at `/health/ready`, and the two concerns stay cleanly separated.

## Returning JSON instead of plain text

The default response body is the single word `Healthy`, `Degraded`, or `Unhealthy`. That is enough for a probe but useless for a human debugging why readiness is failing. Supply a `ResponseWriter` to emit JSON with per-check detail:

```csharp
// .NET 11, C# 14
using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Diagnostics.HealthChecks;

static Task WriteJsonResponse(HttpContext context, HealthReport report)
{
    context.Response.ContentType = "application/json; charset=utf-8";

    var payload = new
    {
        status = report.Status.ToString(),
        totalDurationMs = report.TotalDuration.TotalMilliseconds,
        checks = report.Entries.Select(e => new
        {
            name = e.Key,
            status = e.Value.Status.ToString(),
            description = e.Value.Description,
            durationMs = e.Value.Duration.TotalMilliseconds
        })
    };

    return context.Response.WriteAsync(JsonSerializer.Serialize(payload));
}

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResponseWriter = WriteJsonResponse
});
```

Now a failing readiness check returns a body that names the check, its status, its description, and how long it took, so you can see at a glance that "database" is the entry that went `Unhealthy`. The `HealthReport` object exposes `Status` (the aggregate), `TotalDuration`, and an `Entries` dictionary keyed by the check names you registered. Note that the status code is still driven separately from the body: a `503` can carry this JSON just fine.

## Controlling the status code

By default the framework maps `Healthy` and `Degraded` to `200 OK` and `Unhealthy` to `503 Service Unavailable`. That mapping is what load balancers expect, so change it only when you have a specific reason. When you do, `ResultStatusCodes` is the dial:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResultStatusCodes =
    {
        [HealthStatus.Healthy] = StatusCodes.Status200OK,
        [HealthStatus.Degraded] = StatusCodes.Status200OK,
        [HealthStatus.Unhealthy] = StatusCodes.Status503ServiceUnavailable
    }
});
```

One subtlety worth internalizing: because `Degraded` returns `200` by default, a load balancer treats a degraded instance as healthy and keeps sending it traffic. That is usually correct, but if your definition of "degraded" is severe enough that you want it out of rotation, either map `Degraded` to `503` here or return `Unhealthy` from the check instead of `Degraded`. Do not leave the intent ambiguous.

Another default worth knowing: health check responses set no-cache headers so an intermediary cannot serve a stale `Healthy` while the instance is actually failing. If you ever need caching, `AllowCachingResponses = true` on the options turns it off, but you almost never want that on a probe.

## Locking the endpoint down

A health endpoint that returns detailed JSON is a small information-disclosure surface: it names your dependencies and can leak failure details. There are two clean ways to restrict it. `RequireHost` limits the endpoint to a specific host or port, which is the standard trick for exposing health only on an internal management port that is not routed publicly:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready")
})
.RequireHost("*:8081");
```

`RequireAuthorization` puts the endpoint behind your auth policies, which composes with any authentication you have configured. If you are already running JWT bearer auth, layering it onto the health endpoint is one call:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready")
    .RequireAuthorization();
```

A word of caution: do not require authorization on the endpoint your orchestrator polls, because the orchestrator will not present a token and the probe will fail. Keep the plain liveness/readiness endpoints open (restrict by host or network instead) and put the detailed, JSON-emitting endpoint behind auth if you expose one at all. The mechanics of setting up the token side are covered in [how to set up JWT bearer authentication in a minimal API in ASP.NET Core 11](/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

## Pushing results instead of waiting to be polled

Everything above is pull-based: something calls your endpoint. The framework also supports push-based reporting through `IHealthCheckPublisher`, which runs the registered checks on a timer and hands the aggregate `HealthReport` to your code so you can forward it to a monitoring system, emit a metric, or log an alert:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Diagnostics.HealthChecks;

public sealed class LoggingHealthCheckPublisher : IHealthCheckPublisher
{
    private readonly ILogger<LoggingHealthCheckPublisher> _logger;

    public LoggingHealthCheckPublisher(ILogger<LoggingHealthCheckPublisher> logger)
        => _logger = logger;

    public Task PublishAsync(HealthReport report, CancellationToken cancellationToken)
    {
        if (report.Status != HealthStatus.Healthy)
        {
            _logger.LogWarning(
                "Health degraded: {Status} across {Count} checks.",
                report.Status, report.Entries.Count);
        }
        return Task.CompletedTask;
    }
}

builder.Services.AddSingleton<IHealthCheckPublisher, LoggingHealthCheckPublisher>();
builder.Services.Configure<HealthCheckPublisherOptions>(options =>
{
    options.Delay = TimeSpan.FromSeconds(5);   // Wait before the first run.
    options.Period = TimeSpan.FromSeconds(30); // Then run every 30 seconds.
    options.Predicate = check => check.Tags.Contains("ready");
});
```

The publisher runs on a hosted background service the framework registers as soon as any `IHealthCheckPublisher` is in the container, so you get periodic execution without wiring up your own timer. This is the idiomatic place to feed health into a metrics pipeline; if you are already exporting telemetry, pair it with [OpenTelemetry in .NET 11](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) so degraded status shows up alongside your traces. It also plays nicely with any [background job monitoring](/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) you already run, since a publisher is just another consumer of the same report.

## MapHealthChecks versus UseHealthChecks, and where checks run

Older tutorials use `app.UseHealthChecks("/healthz")`, which is middleware that short-circuits the pipeline when the path matches. `MapHealthChecks` is the routing-aware equivalent and the one to prefer on any modern minimal API, because it participates in endpoint routing, which is what makes `RequireAuthorization`, `RequireHost`, and `RequireCors` work at all. Those endpoint conventions have no meaning on the middleware form. On .NET 8 and later you can also chain `.ShortCircuit()` onto a mapped health endpoint to skip the rest of the middleware pipeline for that request, shaving a little overhead off a high-frequency probe.

One operational reminder: the checks execute inside the request that hit the endpoint, using scoped services resolved for that request. If a check needs a scoped dependency like a `DbContext`, that resolution just works because the endpoint runs in a request scope. This is the same scoping concern that bites people reaching for scoped services from long-lived singletons, exactly the trap that [using scoped services inside a BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) exists to solve; a health check never hits it, because it already has a request scope.

## The shape to remember

A health check endpoint is `AddHealthChecks()` to register the service, `.AddCheck<T>(...)` (or `.AddDbContextCheck<T>()`, or a lambda) for each dependency worth probing, and `MapHealthChecks("/path")` to expose it. Return `Healthy`, `Degraded`, or `Unhealthy` from each check, and remember that `Unhealthy` is a `503` while both others are `200` by default. Split liveness from readiness with tags and a `Predicate` so a flaky database never restarts a healthy pod, add a `ResponseWriter` when a human needs to read the result, guard the endpoint with `RequireHost` rather than auth on the probe path, and reach for `IHealthCheckPublisher` when you want push instead of pull. That is the complete surface, and every line above runs on .NET 8 through .NET 11 unchanged.

## Related

- [How to use scoped services inside a BackgroundService in ASP.NET Core 11](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [How to set up JWT bearer authentication in a minimal API in ASP.NET Core 11](/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)
- [How to use OpenTelemetry with .NET 11 and a free backend](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [How to warm up EF Core's model before the first query](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)

## Sources

- [Health checks in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/health-checks)
- [IHealthCheck interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.diagnostics.healthchecks.ihealthcheck)
- [HealthCheckOptions (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.diagnostics.healthchecks.healthcheckoptions)
- [AddDbContextCheck extension (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkcorehealthchecksbuilderextensions.adddbcontextcheck)
- [AspNetCore.Diagnostics.HealthChecks (Xabaril, GitHub)](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks)
