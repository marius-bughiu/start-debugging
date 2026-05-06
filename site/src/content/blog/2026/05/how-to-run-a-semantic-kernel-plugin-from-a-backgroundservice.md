---
title: "How to Run a Semantic Kernel Plugin From a BackgroundService"
description: "Wire a Microsoft.SemanticKernel 1.75.0 plugin into a hosted BackgroundService on .NET 11 and invoke its KernelFunctions on a PeriodicTimer schedule. Covers DI scopes, [KernelFunction] resolution, prompt-cache-friendly invocation, cancellation, and the lifetime gotchas that bite when you move a plugin off the request path."
pubDate: 2026-05-06
tags:
  - "ai-agents"
  - "semantic-kernel"
  - "llm"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
---

Most Semantic Kernel samples live inside an HTTP endpoint or a console `Main`. That covers the demo cases and almost none of the real ones. The work that actually pays for an LLM bill is recurring: a nightly summarizer that condenses the day's support tickets, a five-minute loop that triages new GitHub issues, a per-hour cost rollup that asks the model to flag anomalies. All of those want to live in an `IHostedService` next to your other workers, not in a controller.

This post is a working recipe for hosting **Microsoft.SemanticKernel 1.75.0** (released April 29, 2026, on **.NET 11**, **C# 14**) inside a `BackgroundService`, invoking a `[KernelFunction]`-decorated plugin on a schedule with `PeriodicTimer`, and avoiding the lifetime traps that hit the moment the plugin stops being request-scoped. The same shape works on .NET 10 LTS without changes; the only line that moves is the `TargetFramework` element.

## Why a BackgroundService is the right host for a recurring agent

Semantic Kernel is sometimes presented as a request-time concern: a user asks something, the kernel composes prompts, picks plugins, calls the model, returns text. That works because the kernel is cheap to construct and the connectors (Azure OpenAI, OpenAI, Bedrock) are HTTP clients underneath. The minute the trigger is **the clock** rather than **a user request**, the request-scoped framing breaks. There is no `HttpContext` to ride. There is no incoming controller to inject `Kernel` into. And the work has to keep running across deployments, with graceful shutdown, structured logs, and a real cancellation story.

`BackgroundService` is the .NET-native answer to all of that. It is a base class for `IHostedService` that the generic host starts on `app.Run()` and stops on a SIGTERM, with a `CancellationToken` plumbed through. Combined with `PeriodicTimer` (the async-first, drift-free timer added in .NET 6), it is the cleanest way to schedule recurring work in-process. If you already use Hangfire or Quartz for scheduling and just want a comparison of the trade-offs against `IHostedService`, the [Hangfire vs Quartz vs IHostedService write-up for scheduled LLM jobs](/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/) frames it. For most recurring agent loops that live in the same process as the rest of the app, `BackgroundService` is the default and you should reach past it only when you need persistence or distributed scheduling.

## A representative plugin to host

The shape every Semantic Kernel codebase eventually has is a class that wraps a service, decorated with `[KernelFunction]` and `[Description]` so the planner or function-calling loop can pick it up. The plugin in the rest of this post is a thin wrapper over a hypothetical `IIssueService` that returns recent GitHub issues, plus an LLM-driven summarizer.

```csharp
// Microsoft.SemanticKernel 1.75.0
using System.ComponentModel;
using Microsoft.SemanticKernel;

public sealed class IssueTriagePlugin
{
    private readonly IIssueService _issues;
    private readonly ILogger<IssueTriagePlugin> _logger;

    public IssueTriagePlugin(IIssueService issues, ILogger<IssueTriagePlugin> logger)
    {
        _issues = issues;
        _logger = logger;
    }

    [KernelFunction("get_recent_issues")]
    [Description("Returns issues opened in the last N hours, newest first.")]
    public async Task<IReadOnlyList<IssueDto>> GetRecentIssuesAsync(
        [Description("How many hours back to look. Defaults to 24.")] int hours = 24,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Fetching issues from the last {Hours}h", hours);
        return await _issues.GetSinceAsync(DateTimeOffset.UtcNow.AddHours(-hours), cancellationToken);
    }
}
```

Three things matter about this shape and they all show up later:

1. The plugin is a normal class with normal constructor injection. It does not care that the kernel will host it.
2. Every `[KernelFunction]` accepts a `CancellationToken`. The kernel forwards the token from `InvokeAsync` to the method, and you want that wired through to the database call so a host shutdown does not strand a 30-second EF Core query.
3. The return type is a plain DTO. The kernel serializes complex returns to JSON for the model and for downstream tools. Keep these types simple.

If your plugin currently wraps an `EF Core` `DbContext`, the patterns in [exposing an EF Core database to an AI agent via MCP](/2026/05/how-to-expose-an-ef-core-database-to-an-ai-agent-via-mcp/) carry over almost directly. The lifetime rules below are the same.

## Wiring Semantic Kernel into the generic host

The kernel itself is cheap. The connector underneath it (Azure OpenAI, OpenAI, etc.) holds an `HttpClient` that benefits from being long-lived, so register the kernel as a singleton when the consumer is a hosted service. The plugin, on the other hand, depends on `IIssueService`, which probably wraps a scoped `DbContext`. That tension is the whole game.

```csharp
// Program.cs, .NET 11, C# 14
var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddDbContext<IssueDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Issues")));

builder.Services.AddScoped<IIssueService, IssueService>();
builder.Services.AddScoped<IssueTriagePlugin>();

builder.Services.AddKernel()
    .AddAzureOpenAIChatCompletion(
        deploymentName: builder.Configuration["AzureOpenAI:Deployment"]!,
        endpoint: builder.Configuration["AzureOpenAI:Endpoint"]!,
        apiKey: builder.Configuration["AzureOpenAI:ApiKey"]!);

builder.Services.AddHostedService<IssueTriageWorker>();

await builder.Build().RunAsync();
```

`AddKernel()` is the helper from `Microsoft.SemanticKernel` 1.75.0. It registers `Kernel` as transient, which is exactly right: a `Kernel` is a lightweight projection over the underlying services, and you want a fresh one per logical operation so plugin sets and execution settings do not leak across runs. The chat completion connector behind it is registered as a singleton.

Notice what is **not** in there: there is no `ImportPluginFromType<IssueTriagePlugin>()` at startup. That call would resolve the plugin from the **root** service provider, which means the plugin's scoped `IIssueService` would be constructed once and never disposed. That is the lifetime trap. We resolve the plugin per tick instead.

## The BackgroundService

The worker creates a DI scope per tick, resolves a fresh `Kernel` and a fresh `IssueTriagePlugin`, registers the plugin into the kernel, invokes the function, and lets the scope dispose at the end of the loop body. That is the only safe shape when the plugin pulls in scoped dependencies like a `DbContext`.

```csharp
// IssueTriageWorker.cs
public sealed class IssueTriageWorker : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly ILogger<IssueTriageWorker> _logger;
    private readonly TimeSpan _interval = TimeSpan.FromMinutes(15);

    public IssueTriageWorker(IServiceProvider services, ILogger<IssueTriageWorker> logger)
    {
        _services = services;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(_interval);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await TriageOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Triage tick failed; will retry on next interval");
            }

            try
            {
                if (!await timer.WaitForNextTickAsync(stoppingToken))
                    break;
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private async Task TriageOnceAsync(CancellationToken ct)
    {
        await using var scope = _services.CreateAsyncScope();

        var kernel = scope.ServiceProvider.GetRequiredService<Kernel>();
        var plugin = scope.ServiceProvider.GetRequiredService<IssueTriagePlugin>();

        kernel.Plugins.AddFromObject(plugin, "issues");

        var args = new KernelArguments { ["hours"] = 1 };
        var result = await kernel.InvokeAsync(
            pluginName: "issues",
            functionName: "get_recent_issues",
            arguments: args,
            cancellationToken: ct);

        var issues = result.GetValue<IReadOnlyList<IssueDto>>() ?? [];
        _logger.LogInformation("Fetched {Count} issues for triage", issues.Count);

        if (issues.Count == 0) return;

        var summary = await SummarizeAsync(kernel, issues, ct);
        _logger.LogInformation("Triage summary: {Summary}", summary);
    }

    private static async Task<string> SummarizeAsync(
        Kernel kernel, IReadOnlyList<IssueDto> issues, CancellationToken ct)
    {
        var prompt = """
            Summarize the following GitHub issues in three bullet points.
            Flag anything that looks like a regression.
            Issues:
            {{$issues_json}}
            """;

        var args = new KernelArguments
        {
            ["issues_json"] = System.Text.Json.JsonSerializer.Serialize(issues),
        };

        var fn = kernel.CreateFunctionFromPrompt(prompt);
        var result = await kernel.InvokeAsync(fn, args, ct);
        return result.GetValue<string>() ?? string.Empty;
    }
}
```

A few details earn their keep:

- `CreateAsyncScope()` over `CreateScope()`. The scope's underlying provider may hold async-disposable services. `await using` lets them flush properly. This matters more than it looks; `DbContext` is `IAsyncDisposable` and synchronous disposal blocks a thread-pool thread on the close.
- `kernel.Plugins.AddFromObject(plugin, "issues")` rather than `ImportPluginFromType<IssueTriagePlugin>(kernel)`. We already have a fully-constructed plugin from DI; `AddFromObject` skips the kernel's own activator and avoids the "scoped service from root provider" footgun.
- The two `try` blocks are not equivalent. The outer one catches business logic failures so a transient model timeout does not kill the loop. The inner one catches the cancellation that comes from `WaitForNextTickAsync` during shutdown. Folding them into one `try` swallows shutdown.

## Why PeriodicTimer instead of Task.Delay

Old samples loop with `await Task.Delay(interval, stoppingToken)`. That works but it drifts. If a tick takes 2 minutes and the interval is 15 minutes, the next tick fires 17 minutes after the previous one started, not 15. `PeriodicTimer.WaitForNextTickAsync` schedules against the original cadence, so a late tick still fires on the next 15-minute boundary. For LLM workloads that drift compounds quickly because a model call can take 30+ seconds when the API is under load.

`PeriodicTimer` is also async-first and cancellation-correct. `WaitForNextTickAsync(stoppingToken)` returns `false` instead of throwing when the host stops, so the loop exits cleanly without a stack of `OperationCanceledException` in your logs.

## Lifetime rules that catch people

The single hardest part of this pattern is the lifetime rules around the plugin and its dependencies. Three concrete rules:

**1. Never inject a scoped service into the BackgroundService constructor.** A `BackgroundService` is registered as a singleton. The DI container will throw at startup with a "Cannot consume scoped service from singleton" exception if it sees a scoped dependency in the constructor. Always inject `IServiceProvider` (or `IServiceScopeFactory`) and create a scope inside `ExecuteAsync`.

**2. Resolve `Kernel` inside the scope.** `AddKernel()` registers it as transient, but transient services resolved from the root provider live for the lifetime of the root provider. Resolving from the scope keeps things clean and lets you set per-scope state (logger context, activity tags) without leaking across ticks.

**3. Do not cache a constructed plugin.** The plugin is scoped because its dependencies are scoped. Caching it on the worker means caching a stale `DbContext`. By the second tick you are reusing a disposed object. The fix is what the worker above already does: resolve the plugin inside the per-tick scope.

If you have ever debugged "EF Core threw `ObjectDisposedException` from a hosted service after the first tick", this is what bit you.

## Cancellation, all the way down

Cancellation in this pattern is an end-to-end concern. The host's `stoppingToken` flows into `ExecuteAsync`, into `WaitForNextTickAsync`, into `kernel.InvokeAsync`, into the plugin method's `CancellationToken` parameter, into `IIssueService.GetSinceAsync`, into the EF Core query. Every link must forward the same token. Skipping a link works fine until the host is asked to stop during a slow database query and the shutdown timer expires.

The kernel forwards the token automatically from `InvokeAsync` to the resolved `[KernelFunction]` method via the conventional `CancellationToken` parameter. The connector forwards it to the underlying `HttpClient`, so a shutdown mid-completion cancels the streaming response too.

The default shutdown grace period is **30 seconds**. If your tick can exceed that, configure it explicitly:

```csharp
builder.Services.Configure<HostOptions>(o =>
    o.ShutdownTimeout = TimeSpan.FromSeconds(60));
```

A common mistake is to swallow `OperationCanceledException` indiscriminately in the catch block. Doing that turns "the host is shutting down" into "the loop continues running until the process is killed". The pattern above only treats the exception as fatal when `stoppingToken.IsCancellationRequested` is true; everything else is logged and retried.

## Prompt caching, cost, and what to set on the connector

Recurring agent loops are the workload prompt caching was designed for. The system prompt and the plugin's tool schema are identical from tick to tick; only the variable input changes. Configuring the connector to send a `cache_control` breakpoint on the static section turns those repeated tokens into cache reads at roughly **10% of the input price** on Anthropic, with similar economics on Azure OpenAI's caching tiers. The mechanics of measuring the hit rate are covered in [adding prompt caching to an Anthropic SDK app and measuring the hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/); the same shape applies when the kernel is the one composing the messages.

For non-cached workloads, set `MaxTokens` and a sensible `Temperature` per call so a regression in the model's output length does not silently double your bill. `KernelArguments` accepts a `PromptExecutionSettings` you can pass through `InvokeAsync`.

## Two variants worth knowing

**Cron-style schedules.** `PeriodicTimer` only does fixed intervals. If you need "every weekday at 9am UTC", combine `BackgroundService` with NCrontab or use Quartz. The shape of the worker stays identical; only the timer changes.

**Multiple plugins per tick.** `kernel.Plugins.AddFromObject` accepts a name. Register a few plugins in the same scope, then either invoke them by name or let the model choose with `FunctionChoiceBehavior.Auto()`. For loops that want full agent autonomy on each tick, the [Microsoft Agent Framework patterns for human-in-the-loop tool approval](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/) and [the migration from SK plugins to MCP servers](/2026/05/migrate-a-semantic-kernel-plugin-to-an-mcp-server/) are the next step up; both pair well with the same BackgroundService host.

**Distributed locking.** A `BackgroundService` runs on every replica. If you scale to 3 instances, a 15-minute tick fires three times. The fix is a distributed lock around `TriageOnceAsync` (Redis, SQL, or whatever your stack already provides). Without it, you will pay for the work three times and surface duplicate notifications.

## Closing thread

The pieces that make this pattern work are unglamorous: a singleton worker, a per-tick scope, a transient kernel, a scoped plugin, and a `CancellationToken` that is forwarded honestly from the host all the way to the database. None of them are unique to Semantic Kernel; the same shape hosts a Microsoft.Extensions.AI client, a raw Anthropic SDK call, or an MCP client. What matters is that the LLM is not special. It is a slow, expensive, cancellable I/O dependency, and the generic host already knows how to schedule those.

Source links:

- [Microsoft.SemanticKernel 1.75.0 on NuGet](https://www.nuget.org/packages/Microsoft.SemanticKernel/1.75.0)
- [Plugins in Semantic Kernel (Microsoft Learn)](https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/)
- [Kernel.InvokeAsync API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.semantickernel.kernel.invokeasync?view=semantic-kernel-dotnet)
- [Using Semantic Kernel with Dependency Injection (DevBlogs)](https://devblogs.microsoft.com/semantic-kernel/using-semantic-kernel-with-dependency-injection/)
- [PeriodicTimer.WaitForNextTickAsync (.NET API)](https://learn.microsoft.com/en-us/dotnet/api/system.threading.periodictimer.waitfornexttickasync)
- [BackgroundService base class (.NET API)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.backgroundservice)
