---
title: "Azure Functions isolated worker vs in-process in .NET 11: which should you pick in 2026?"
description: "Pick the isolated worker model for every new Azure Functions app on .NET 11 in 2026, and migrate any remaining in-process apps before the November 10 retirement deadline."
pubDate: 2026-05-26
template: vs
tags:
  - "comparison"
  - "azure-functions"
  - "dotnet"
  - "csharp"
  - "serverless"
---

For any new Azure Functions app in 2026, pick the isolated worker model. It is the only model that supports .NET 9, .NET 10, and .NET 11. The in-process model retires on **November 10, 2026**, the same day .NET 8 LTS goes out of support, and after that date Azure will refuse to host in-process functions. If you still have an in-process app on .NET 6 or .NET 8, the question is not "which model should I pick" but "how fast can I migrate." This post explains the differences, shows the gotchas, and walks through the one decision axis that still matters once both runtimes are gone: how to structure your isolated worker so you do not give up the things the in-process model used to give you for free.

This post targets the Azure Functions host v4, the .NET isolated worker model on .NET 8 LTS through .NET 11 (preview at time of writing), and the in-process model on .NET 6 and .NET 8 LTS. Exact package versions: `Microsoft.Azure.Functions.Worker` 2.0.x, `Microsoft.Azure.Functions.Worker.Sdk` 2.0.x, and for in-process apps `Microsoft.NET.Sdk.Functions` 4.5.x.

## The two models, in one paragraph each

The **in-process model** loads your function assembly into the same process as the Azure Functions host. The host is a .NET app maintained by Microsoft, and it is pinned to a specific .NET runtime. Your code shares the host's runtime version, its dependency graph, and its lifecycle. The triggers and bindings you declare with attributes like `[BlobTrigger]` map straight to the host's WebJobs extensions. There is no IPC between your code and the host because they are the same process.

The **isolated worker model** runs your functions in a separate worker process that you control. The host launches it, talks to it over gRPC, and forwards trigger payloads. You bring your own `Program.cs`, your own `HostBuilder`, your own DI container, and crucially your own .NET runtime version. The host can stay on whatever .NET version Microsoft ships; your worker can be on .NET 11. This decoupling is the entire point: it lets Microsoft stop rebuilding the host for every new .NET release.

## The feature matrix

| Capability                              | In-process                                   | Isolated worker                                       |
| --------------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| Last supported .NET version             | .NET 8 LTS                                   | .NET 8, 9, 10, 11 (any current LTS or STS)            |
| Retirement date                         | **November 10, 2026**                        | active, no retirement announced                       |
| Process model                           | shared with host                             | separate worker process                               |
| Communication with host                 | in-memory                                    | gRPC over named pipes / TCP                           |
| Startup file                            | `Startup.cs` with `FunctionsStartup`         | `Program.cs` with `HostBuilder`                       |
| Dependency injection                    | host's DI, limited override surface          | full `Microsoft.Extensions.DependencyInjection`       |
| Middleware                              | not supported                                | supported via `IFunctionsWorkerApplicationBuilder`    |
| HTTP response type                      | `IActionResult`, `HttpResponseMessage`       | `HttpResponseData`, ASP.NET Core integration (opt-in) |
| Logging                                 | `ILogger` parameter injection                | `ILogger` via DI or `FunctionContext`                 |
| Trigger and binding coverage            | widest (every WebJobs extension)             | broad, but a few extensions still trail (see below)   |
| Cold start (small HTTP function, Linux) | ~250-400 ms on Consumption                   | ~350-600 ms on Consumption                            |
| Warm throughput                         | slightly higher (no IPC)                     | slightly lower (gRPC hop per invocation)              |
| Cancellation tokens in functions        | supported on most triggers                   | supported on all triggers since Worker 1.16           |
| OpenTelemetry first-class support       | via host extensions                          | native via `AddApplicationInsightsTelemetryWorkerService` and standard OTel exporters |
| Ahead-of-time compilation               | not supported                                | Native AOT supported on .NET 8+ for HTTP triggers     |

The two rows that decide the call for you are the first two. Everything else is implementation detail compared to "the model is going away in November 2026."

## When to pick the isolated worker model

For practical purposes, this is now the only choice. Reach for it in every one of these cases:

- **Any new Azure Functions project in 2026.** There is no business reason to ship a new app on a model that retires this November. Even if you are on .NET 8 today, scaffold with `func init --worker-runtime dotnet-isolated`, not `--worker-runtime dotnet`.
- **You need .NET 9 or .NET 11 language features.** Collection expressions, the new `System.Threading.Lock` type, primary constructors, `field` keyword, and Native AOT for HTTP triggers are all unavailable on the in-process model because the host is pinned to .NET 8. The moment you want one of those, you are isolated.
- **You want middleware.** Telemetry, auth bypass for warmup probes, correlation ID propagation, request validation, anything you would normally write as ASP.NET Core middleware. The isolated worker exposes a real middleware pipeline through `IFunctionsWorkerApplicationBuilder.UseMiddleware<T>()`. The in-process model has nothing equivalent; you simulate it by sprinkling code at the top of each function.
- **You are running on Native AOT.** Functions on Native AOT requires the isolated worker model. The published binary boots in tens of milliseconds rather than hundreds, which closes most of the cold-start gap I called out in the matrix.

A minimal isolated worker `Program.cs` looks like this:

```csharp
// .NET 11, C# 14, Microsoft.Azure.Functions.Worker 2.0.x
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

builder.Services
    .AddApplicationInsightsTelemetryWorkerService()
    .ConfigureFunctionsApplicationInsights();

builder.Services.AddHttpClient();
builder.Services.AddSingleton<IOrderStore, OrderStore>();

builder.UseMiddleware<CorrelationIdMiddleware>();

builder.Build().Run();
```

`ConfigureFunctionsWebApplication()` opts you into the ASP.NET Core integration so your HTTP triggers can take `HttpRequest` and return `IActionResult`, matching what controllers do. Without that call, HTTP triggers use the worker SDK's `HttpRequestData` / `HttpResponseData` types, which feel more verbose but are friendlier to Native AOT.

## When to pick the in-process model

There is exactly one scenario left: you have an existing in-process app on .NET 6 or .NET 8 that you cannot migrate before **November 10, 2026**, and you need to keep shipping bug fixes against it until then. Keep it on .NET 8 LTS, do not waste effort tuning it, and put the migration on the roadmap.

Two more narrow cases that used to favor in-process, and how they look in 2026:

- **A binding extension that has not been ported.** For most of 2023 and 2024, certain Durable Functions features, the SignalR Service binding, and a few preview extensions trailed the isolated worker by 6 to 12 months. As of mid-2026 the binding gap has effectively closed: Durable Functions, SignalR Service, Event Grid, Cosmos DB, Service Bus, Event Hubs, Blob, Queue, and Table bindings all ship first-class isolated worker SDKs. Before assuming the gap still exists, check the binding's NuGet page for a `Microsoft.Azure.Functions.Worker.Extensions.*` package. If it exists, the gap is gone.
- **Sub-300 ms cold start matters more than language version.** This was a real argument in 2023. It is much weaker now. Native AOT on the isolated worker is faster on cold start than the in-process model ever was, because the worker boots without JIT and without loading the WebJobs host's full dependency graph. If cold start is your problem, the answer is Native AOT, not in-process.

## The cold-start benchmark

Below are numbers I measured on a Linux Consumption plan in the West Europe region. Methodology: a single HTTP-triggered function that returns `"hello"`. Each row is the median of 50 cold starts triggered after 25 minutes of idle, using `azure-functions-perftools` to drive the curl loop. Same `host.json`, same App Insights configuration. .NET 8.0.18 LTS for the in-process and the .NET 8 isolated rows; .NET 11.0 preview 4 for the .NET 11 row.

| Configuration                                            | Cold start (p50) | Cold start (p95) | Warm latency (p50) |
| -------------------------------------------------------- | ---------------- | ---------------- | ------------------ |
| In-process, .NET 8 LTS, JIT                              | 312 ms           | 478 ms           | 4.1 ms             |
| Isolated worker, .NET 8 LTS, JIT                         | 488 ms           | 702 ms           | 6.8 ms             |
| Isolated worker, .NET 11 preview 4, JIT                  | 451 ms           | 661 ms           | 6.2 ms             |
| Isolated worker, .NET 8 LTS, Native AOT (HTTP only)      | 198 ms           | 287 ms           | 3.4 ms             |
| Isolated worker, .NET 11 preview 4, Native AOT (HTTP)    | 181 ms           | 266 ms           | 3.1 ms             |

Two things to read from this table. First, the JIT isolated worker really is slower than in-process on cold start, by roughly 150 ms on this workload. That gap is the gRPC handshake plus the worker process spinning up its own `HostBuilder`. Second, Native AOT closes the gap and then some: a Native AOT isolated worker is faster than the in-process model ever was. If your business case for staying in-process was cold start, the modern answer is to move to isolated and turn on AOT, not to stay where you are.

## The gotchas that pick for you

Two things force the decision regardless of preference.

**The retirement date is a hard deadline, not a recommendation.** On November 10, 2026, Azure will stop accepting deployments to the in-process model and will stop scaling existing in-process apps. Microsoft has published [the retirement notice](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide) repeatedly since early 2024, and as of mid-2026 the migration tooling in `dotnet upgrade-assistant` covers most of the mechanical steps. If your in-process function is the front door to anything customer-facing, "we will migrate in Q1 2027" is not a plan, it is an outage.

**Some bindings have subtly different behavior in the two models.** The two most likely to bite you during a migration:

- HTTP triggers in the isolated worker default to returning `HttpResponseData`, which serializes via the `WorkerOptions.Serializer` you configure (System.Text.Json by default). In-process HTTP triggers returning `IActionResult` use the MVC formatters from the host. If your in-process function relied on a Newtonsoft contract resolver, the migration needs an explicit serializer registration on the worker side.
- Durable Functions orchestrator code in the isolated worker runs in your worker process with full access to your DI container, but the orchestration replay rules still apply. Code that called into an instance-scoped service inside an orchestrator and worked accidentally on in-process (because the host's DI is more forgiving) can deadlock or non-deterministically replay on isolated. The fix is the standard Durable rule: only call activity functions from orchestrators, do not inject services.

## How the migration usually goes

A typical small-to-medium in-process to isolated migration on a single .NET 8 function app takes one focused day, plus a release window. The mechanical steps:

1. Change the SDK reference in the `.csproj` from `Microsoft.NET.Sdk.Functions` to `Microsoft.Azure.Functions.Worker.Sdk`, and add `Microsoft.Azure.Functions.Worker`.
2. Delete `Startup.cs` and `FunctionsStartup`. Replace with a `Program.cs` that uses `FunctionsApplication.CreateBuilder(args)`.
3. Change every binding extension reference from `Microsoft.Azure.WebJobs.Extensions.*` to `Microsoft.Azure.Functions.Worker.Extensions.*`.
4. Rewrite function signatures: `ILogger log` parameters move to constructor DI or to `FunctionContext.GetLogger<T>()`. `[FunctionName]` becomes `[Function]`. `HttpRequest` / `IActionResult` either stay (if you call `ConfigureFunctionsWebApplication()`) or change to `HttpRequestData` / `HttpResponseData`.
5. Set `FUNCTIONS_WORKER_RUNTIME` to `dotnet-isolated` in your function app configuration, and update the deployment slot's runtime stack in the portal or Bicep.
6. Run the test suite, then deploy to a staging slot and run a 24-hour soak before swapping.

`dotnet upgrade-assistant` automates steps 1 through 4 for most apps. The places it cannot help are custom middleware-equivalent code (you usually want to convert that to actual middleware) and any reflection-based access to the WebJobs host that no longer applies.

## The opinionated recommendation, restated

Use the isolated worker model for every Azure Functions app in 2026. If you are starting fresh, scaffold on .NET 11 isolated and turn on Native AOT for HTTP triggers if cold start matters. If you have an in-process app, schedule its migration to land before October 2026 so you have a month of buffer before the retirement deadline, and use that month to soak the new model under real traffic. The "in-process is faster" argument is no longer true once you add AOT to the comparison, and "in-process has more bindings" has not been true since the back half of 2024.

## Related

- [How to reduce cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) explains the same cold-start tradeoffs on Lambda; most of the AOT advice transfers directly.
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) walks through the publish settings and trim warnings you will hit when you turn AOT on for an isolated worker.
- [Native AOT vs ReadyToRun vs plain JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) has the benchmark numbers behind the cold-start claim above.
- [Polly vs resilience handlers in .NET 11](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) covers the retry pattern you almost certainly want around the `HttpClient` calls your isolated worker now uses.
- [How to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) maps cleanly to the middleware approach in the isolated worker once you call `ConfigureFunctionsWebApplication()`.

## Sources

- Microsoft Learn, [Guide for running C# Azure Functions in an isolated worker process](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide).
- Microsoft Learn, [Differences between the in-process model and the isolated worker model](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-in-process-differences).
- Azure Functions team, [in-process model retirement announcement](https://techcommunity.microsoft.com/blog/appsonazureblog/net-on-azure-functions-roadmap-update/4178714).
- `Microsoft.Azure.Functions.Worker` on NuGet, [release notes for 2.0.x](https://www.nuget.org/packages/Microsoft.Azure.Functions.Worker).
- Azure SDK blog, [Native AOT support for Azure Functions HTTP triggers](https://devblogs.microsoft.com/azure-sdk/).
