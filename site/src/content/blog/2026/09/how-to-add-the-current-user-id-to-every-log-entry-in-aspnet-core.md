---
title: "How to add the current user id to every log entry in ASP.NET Core"
description: "A BeginScope middleware misses the exception handler's error log and the Request finished line. Register an ILogEnricher that reads the user from IHttpContextAccessor, open a scope only when work leaves the request, and watch out for Serilog's AddSerilog silently cancelling enrichment."
pubDate: 2026-09-21
template: how-to
tags:
  - "aspnet-core"
  - "dotnet-10"
  - "logging"
  - "observability"
  - "opentelemetry"
  - "serilog"
  - "how-to"
---

Short answer: do not pass the user id into every `LogInformation` call, and do not stop at a middleware that wraps the pipeline in `ILogger.BeginScope`. That scope only covers log calls made *inside* it, so it misses the two lines you most want when something breaks: the `ExceptionHandlerMiddleware` error and the hosting "Request finished" entry. Instead, add `Microsoft.Extensions.Telemetry`, call `builder.Logging.EnableEnrichment()`, and register an `ILogEnricher` with `builder.Services.AddLogEnricher<UserIdEnricher>()` that reads `ClaimTypes.NameIdentifier` from `IHttpContextAccessor`. It runs once per log record, for every category, including the framework's own. The one place it cannot help is work that outlives the request, so capture the id before you hand work to `Task.Run` or a queue and open a scope there.

Everything below was run on .NET 10 (SDK 10.0.302, ASP.NET Core runtime 10.0.10) with `Microsoft.Extensions.Telemetry` 10.10.0, `OpenTelemetry.Extensions.Hosting` and `OpenTelemetry.Exporter.Console` 1.19.1, and `Serilog.AspNetCore` 10.0.0. The results table comes from real requests against a small test app, not from reading docs.

## Why a BeginScope middleware looks right and is not

The answer you find first on StackOverflow is a middleware like this:

```csharp
// .NET 10, ASP.NET Core 10: the common approach, and its gap
app.UseExceptionHandler("/error");
app.UseAuthentication();

app.Use(async (ctx, next) =>
{
    var userId = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);
    if (userId is null) { await next(ctx); return; }

    var logger = ctx.RequestServices.GetRequiredService<ILoggerFactory>()
        .CreateLogger("UserScope");
    using (logger.BeginScope(new Dictionary<string, object?> { ["UserId"] = userId }))
    {
        await next(ctx);
    }
});

app.UseAuthorization();
```

It works for your own code. A `log.LogInformation("Loading orders")` inside an endpoint comes out with `"UserId":"u-42"` in its scopes. The trouble is structural. Logging scopes live in an `AsyncLocal`, so they attach to log calls made while the `using` block is on the stack. Two important log lines are written after that block has been disposed:

- `UseExceptionHandler` sits outside the scope middleware (it has to, or it cannot catch exceptions from authentication). By the time it logs "An unhandled exception has occurred while executing the request.", the exception has already unwound through your `using` and the scope is gone.
- "Request finished ... 500" is written by `Microsoft.AspNetCore.Hosting.Diagnostics`, which wraps the entire middleware pipeline. No middleware you write can put a scope around it.

So the error log, the one entry support will search by user id, is the entry without a user id. Moving the scope middleware above `UseExceptionHandler` does not fix it either, because the user is not known until authentication has run.

The same `AsyncLocal` behaviour has an upside the enricher lacks: a scope flows with the `ExecutionContext` into `Task.Run` and other continuations, so fire-and-forget work started inside the request keeps the id even after the response is sent.

## What each approach actually tags

I ran three requests with an authenticated user `u-42` against the same app in each configuration: an endpoint that logs, an endpoint that throws, and an endpoint that starts a `Task.Run` which logs 300 ms after the response has been sent. Output went through `AddJsonConsole` with `IncludeScopes = true`, and was then repeated with the OpenTelemetry console exporter.

| Log entry | Middleware `BeginScope` | `ILogEnricher` | Enricher + scope on handoff |
| --- | --- | --- | --- |
| "Request starting" (hosting) | no | no | no |
| Endpoint's own `LogInformation` | yes | yes | yes |
| `ExceptionHandlerMiddleware` error | **no** | yes | yes |
| "Request finished" (hosting) | **no** | yes | yes |
| `Task.Run` log after the response | yes | **no** | yes |

"Request starting" is untaggable by design: it is written before authentication runs, so no user exists yet. Rely on the shared `TraceId` to join it to the rest of the request.

## Step 1: add the enricher

Log enrichment is part of the `dotnet/extensions` libraries. `ILogEnricher` and `AddLogEnricher` live in `Microsoft.Extensions.Telemetry.Abstractions`; `EnableEnrichment()` lives in `Microsoft.Extensions.Telemetry`, which references the abstractions, so one package is enough:

```bash
dotnet add package Microsoft.Extensions.Telemetry --version 10.10.0
```

The enricher itself is a few lines:

```csharp
// .NET 10, Microsoft.Extensions.Telemetry 10.10.0
using System.Security.Claims;
using Microsoft.Extensions.Diagnostics.Enrichment;

public sealed class UserIdEnricher(IHttpContextAccessor accessor) : ILogEnricher
{
    public void Enrich(IEnrichmentTagCollector collector)
    {
        var userId = accessor.HttpContext?.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId is not null)
        {
            collector.Add("user.id", userId);
        }
    }
}
```

Then wire it up in `Program.cs`:

```csharp
// .NET 10, ASP.NET Core 10, Microsoft.Extensions.Telemetry 10.10.0
var builder = WebApplication.CreateBuilder(args);

builder.Logging.EnableEnrichment();
builder.Services.AddHttpContextAccessor();
builder.Services.AddLogEnricher<UserIdEnricher>();

builder.Services.AddAuthentication(/* your scheme */);
builder.Services.AddAuthorization();

var app = builder.Build();
app.UseExceptionHandler("/error");
app.UseAuthentication();
app.UseAuthorization();
```

No middleware is needed. `EnableEnrichment()` swaps the default `LoggerFactory` for the extended one from `Microsoft.Extensions.Telemetry`, which calls every registered `ILogEnricher` once for each log record and appends the tags to the record's state. Because the enricher reads the user at the moment of the log call rather than at the moment a scope was opened, it still finds the user when the exception handler and the hosting diagnostics write their entries: `HttpContext` is alive until the request completes.

In the JSON console output the tag appears in `State`, next to the message template parameters, rather than under `Scopes`:

```json
{"EventId":1,"LogLevel":"Error","Category":"Microsoft.AspNetCore.Diagnostics.ExceptionHandlerMiddleware","Message":"An unhandled exception has occurred while executing the request.","State":{"user.id":"u-42","exception.type":"System.InvalidOperationException","{OriginalFormat}":"An unhandled exception has occurred while executing the request."}}
```

That was trimmed of the exception text and scopes. Note the free `exception.type` tag: the extended logger adds it to any record that carries an exception, which makes "all failures for this user, grouped by exception type" a single query.

A few details matter here:

- `AddLogEnricher<T>` registers the enricher as a **singleton** (`AddSingleton<ILogEnricher, T>()` in the source). Inject singletons only. `IHttpContextAccessor` is a singleton that reads an `AsyncLocal`, which is exactly why it works; a scoped service such as your `DbContext` or a per-request user service would be captured once from the root provider.
- Registering it twice runs it twice, because it uses `AddSingleton`, not `TryAddEnumerable`.
- The enricher runs for every log record in the process, including startup and background services. Keep it allocation-free and let it return quietly when `HttpContext` is null.

## Step 2: carry the id across the request boundary

`IHttpContextAccessor.HttpContext` becomes null once the request finishes, so the enricher cannot tag work that outlives the request. That is the last row of the table. Capture the id while you still have the request, and open a scope inside the background work:

```csharp
// .NET 10, ASP.NET Core 10
app.MapPost("/reports", (HttpContext ctx, ILogger<Program> log) =>
{
    var userId = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);

    _ = Task.Run(async () =>
    {
        using var scope = log.BeginScope("user.id:{user.id}", userId);
        await Task.Delay(300);
        log.LogInformation("Background work finished");
    });

    return Results.Accepted();
});
```

With that change the background line came out with a scope `{"Message":"user.id:u-42","user.id":"u-42"}`, so every row of the table is tagged except "Request starting". Use the same key as the enricher so your queries do not need an `OR`.

Two things about that snippet. First, use the message-template overload of `BeginScope`: a bare `Dictionary<string, object?>` scope works, but the console and OpenTelemetry exporters print its `ToString()`, which is ``System.Collections.Generic.Dictionary`2[System.String,System.Object]``, as the scope message. Second, `Task.Run` from an endpoint is only a stand-in for a handoff. For real fire-and-forget work, put the user id on the work item you enqueue to a `BackgroundService`, and open the scope when the worker dequeues it. The pattern and its pitfalls are covered in [running fire-and-forget work safely with BackgroundService](/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Step 3: make sure your sink actually shows it

Where the tag ends up depends on the provider.

**Console formatters.** Enriched tags are part of the state, so `AddJsonConsole` shows them even with `IncludeScopes = false`. The handoff scope from Step 2 needs `IncludeScopes = true`, which is off by default for every console formatter. The simple console formatter prints neither state properties nor, without `IncludeScopes`, scopes, so use the JSON formatter or a real sink.

**OpenTelemetry.** With `builder.Logging.AddOpenTelemetry(o => { o.IncludeScopes = true; o.AddConsoleExporter(); })` the enriched tag became a regular log record attribute (`LogRecord.Attributes: user.id: u-42`) on the endpoint log, the exception handler error, and "Request finished", while the handoff scope arrived as `[Scope.3]:UserId: u-42` in `ScopeValues`. Without `IncludeScopes = true` scope values are dropped, so the background line would lose its id. If you are moving to OpenTelemetry anyway, [the Serilog to OpenTelemetry logging migration](/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/) covers the exporter side.

**Serilog: the trap.** This is the one that cost me the most time. `Serilog.AspNetCore` recommends `builder.Services.AddSerilog(...)`, which registers Serilog's own `ILoggerFactory`. `EnableEnrichment()` also replaces `ILoggerFactory`. The last registration wins, and neither tells you:

| Registration | Result |
| --- | --- |
| `Services.AddSerilog(...)`, then `EnableEnrichment()` | **No log output at all**: the extended factory wins and has no providers |
| `EnableEnrichment()`, then `Services.AddSerilog(...)` | Logs work, but the enricher never runs; no `user.id` anywhere |
| `EnableEnrichment()` plus `builder.Logging.AddSerilog(logger)` | Works in either order; `user.id` on every row the enricher covers |

The first row is not a figure of speech. The app served requests and wrote zero bytes to stdout. The working combination registers Serilog as an `ILoggerProvider` under the Microsoft factory:

```csharp
// .NET 10, Serilog.AspNetCore 10.0.0, Microsoft.Extensions.Telemetry 10.10.0
using Serilog;
using Serilog.Formatting.Compact;

var serilog = new LoggerConfiguration()
    .MinimumLevel.Information()
    .Enrich.FromLogContext()
    .WriteTo.Console(new CompactJsonFormatter())
    .CreateLogger();

builder.Logging.ClearProviders();
builder.Logging.AddSerilog(serilog, dispose: true);
builder.Logging.EnableEnrichment();
builder.Services.AddHttpContextAccessor();
builder.Services.AddLogEnricher<UserIdEnricher>();
```

Serilog turns the enriched tag into a first-class `user.id` property, and it also picks up `BeginScope` values, so the Step 2 scope works unchanged. The cost is that `Services.AddSerilog` is also what registers Serilog's `IDiagnosticContext`, which `UseSerilogRequestLogging` needs. If you depend on that middleware, keep `Services.AddSerilog`, skip `EnableEnrichment`, and do it the Serilog way: push the id with `LogContext.PushProperty("UserId", userId)` in a middleware after `UseAuthentication`, and add it to the completion event with `options.EnrichDiagnosticContext = (dc, http) => dc.Set("UserId", http.User.FindFirstValue(ClaimTypes.NameIdentifier))`. I measured the `PushProperty` middleware alone and it has exactly the same gaps as `BeginScope` (no id on the exception handler error or "Request finished"), which is why the diagnostic-context callback matters. The base Serilog setup is in [structured logging with Serilog and Seq](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).

## Gotchas that bite in production

**The user id is personal data.** Under GDPR a stable account identifier attached to every log line makes those logs personal data, which affects retention and who can read them. Log an opaque internal id, never an email address or a `name` claim, and if your compliance team requires it, hash or redact it at the logging layer. The .NET redaction support can do that per property; see [redacting sensitive values with LogProperties](/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/).

**Pick the right claim.** `ClaimTypes.NameIdentifier` is what ASP.NET Core Identity and cookie auth populate. JWT bearer maps the token's `sub` claim to `NameIdentifier` only while `JwtBearerOptions.MapInboundClaims` is `true`, which is the default. Many APIs turn it off to keep the raw JWT claim names, and from then on the subject arrives as `sub` and the enricher above silently logs nothing. Read `User.FindFirstValue("sub") ?? User.FindFirstValue(ClaimTypes.NameIdentifier)` if you are not sure which you get.

**Authentication must run before the log call, not before registration.** The enricher reads `HttpContext.User` lazily, so it tags everything logged after the authentication middleware has run, wherever that middleware sits. If you rely on the automatic authentication middleware that `WebApplication` adds when authentication services are registered and you do not call `UseAuthentication` yourself, it runs early in the pipeline and you are covered.

**Interactive Blazor and SignalR.** `IHttpContextAccessor` is not a reliable source of the current user in interactive Blazor Server components; the ASP.NET Core docs tell you to avoid it with interactive rendering. For circuits and hub invocations, get the user from `AuthenticationStateProvider` or `HubCallerContext.User` and open a scope around the work instead.

**Enrichers are per record, so keep them cheap.** A claims lookup over a handful of claims is trivial, but do not resolve services, query a database, or allocate strings in `Enrich`. If a value is constant for the process (version, region), use `IStaticLogEnricher`, which runs once.

**Do not also put the id in your message templates.** `LogInformation("User {UserId} loaded orders", userId)` duplicates the property and, if the keys differ, splits your queries. Keep templates about the event; see [moving from string interpolation to message templates](/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/) for the rest of that discipline.

### Read next

- [How to set up structured logging with Serilog and Seq in .NET 11](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/)
- [Migrate from Serilog to OpenTelemetry logging in .NET 11](/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/)
- [How to redact sensitive values from logs with LogProperties in .NET](/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/)
- [How to run fire-and-forget work safely in ASP.NET Core with BackgroundService](/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/)

### Sources

- [Log enrichment overview](https://learn.microsoft.com/dotnet/core/enrichment/overview) and [Custom log enricher](https://learn.microsoft.com/dotnet/core/enrichment/custom-enricher) on Microsoft Learn
- [`EnrichmentServiceCollectionExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry.Abstractions/Enrichment/EnrichmentServiceCollectionExtensions.cs) in dotnet/extensions (singleton registration)
- [Logging in .NET: log scopes](https://learn.microsoft.com/dotnet/core/extensions/logging#log-scopes)
- [Access HttpContext in ASP.NET Core](https://learn.microsoft.com/aspnet/core/fundamentals/http-context) (including the interactive Blazor guidance)
- [Serilog.AspNetCore README](https://github.com/serilog/serilog-aspnetcore)
- [OpenTelemetry .NET logs: IncludeScopes](https://github.com/open-telemetry/opentelemetry-dotnet/tree/main/docs/logs)
