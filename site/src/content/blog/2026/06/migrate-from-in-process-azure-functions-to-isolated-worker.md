---
title: "Migrate from in-process Azure Functions to the isolated worker model (.NET 8 / .NET 11)"
description: "A step-by-step checklist to move a .NET in-process Azure Functions app to the isolated worker model before the November 10, 2026 retirement, with csproj diffs, signature rewrites, and a slot-swap rollout."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "azure-functions"
  - "dotnet"
  - "csharp"
  - "serverless"
---

A typical single .NET 8 in-process function app moves to the isolated worker model in about one focused day of code changes plus a staged release window. What breaks is mechanical and predictable: your `.csproj` SDK reference, your `Startup.cs`, every `[FunctionName]` attribute, every `Microsoft.Azure.WebJobs.Extensions.*` package, and any function that took an `ILogger` parameter. None of it is hard, but all of it is required, because the in-process model retires on **November 10, 2026**, and after that date Azure stops giving in-process apps security and feature updates. This guide is the full checklist: what to change, the exact diff for each change, how to verify each step, and how to roll the runtime swap out through a staging slot so production never sees the broken interim state.

This targets the Azure Functions host v4, migrating a `dotnet` (in-process) app on .NET 6 or .NET 8 LTS to the `dotnet-isolated` worker model on .NET 8 LTS (the recommended quick path) or .NET 11. Package versions referenced are the latest stable as of June 2026: `Microsoft.Azure.Functions.Worker` 2.0.x, `Microsoft.Azure.Functions.Worker.Sdk` 2.0.x, and the `Microsoft.Azure.Functions.Worker.Extensions.*` family. If your app is still on host v1, v2, or v3, do the [host version 3.x to 4.x upgrade](https://learn.microsoft.com/en-us/azure/azure-functions/migrate-version-3-version-4) first; that guide folds the isolated worker move into the same pass.

If you are still deciding whether to migrate at all, read [isolated worker vs in-process in .NET 11](/2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11/) first. This post assumes you have decided and want the mechanical recipe.

## Why this migration is not optional

- **The in-process model retires on November 10, 2026.** That is the same day .NET 8 LTS goes out of support. After that date, in-process apps keep running but receive no security patches and no feature updates from Microsoft, and you cannot deploy a new in-process app. Microsoft has published [the retirement notice](https://aka.ms/azure-functions-retirements/in-process-model) since early 2024.
- **Isolated worker unlocks .NET 9, 10, and 11.** The in-process host is pinned to .NET 8 and never goes further. The moment you want primary constructors, the `field` keyword, the `System.Threading.Lock` type, collection expressions, or Native AOT, you need the isolated worker, where you bring your own runtime.
- **You get a real middleware pipeline and full DI.** The isolated worker exposes `IFunctionsWorkerApplicationBuilder.UseMiddleware<T>()` and the standard `Microsoft.Extensions.DependencyInjection` container with no override-surface limits. Correlation IDs, auth shortcuts for warmup probes, and request validation become middleware instead of copy-pasted code at the top of every function.
- **Cold start can end up lower, not higher.** Plain JIT isolated worker is roughly 150 ms slower on cold start than in-process, but Native AOT on the isolated worker boots faster than in-process ever did. If cold start is the reason you stayed in-process, the modern answer is isolated plus AOT.

## What breaks

| Area                       | Change                                                                                                  | Severity |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| SDK reference              | `Microsoft.NET.Sdk.Functions` removed; replace with `Microsoft.Azure.Functions.Worker` + `.Worker.Sdk` | high     |
| Output type                | `.csproj` needs `<OutputType>Exe</OutputType>`; the worker is now a real console process                | high     |
| Startup                    | `FunctionsStartup` / `Startup.cs` replaced by `Program.cs` with a `HostBuilder`                          | high     |
| Function attribute         | `[FunctionName("X")]` becomes `[Function("X")]`                                                          | high     |
| Binding packages           | every `Microsoft.Azure.WebJobs.Extensions.*` swaps to `Microsoft.Azure.Functions.Worker.Extensions.*`   | high     |
| `ILogger` parameter        | method-injected `ILogger log` becomes constructor-injected `ILogger<T>`                                  | medium   |
| HTTP return type           | `IActionResult` keeps working only if you opt into ASP.NET Core integration; otherwise `HttpResponseData` | medium   |
| Input / output bindings    | input bindings gain `Input` suffix, output bindings gain `Output` suffix, outputs leave the parameter list | medium   |
| `IBinder` / `IAsyncCollector<T>` | `IBinder` removed; `IAsyncCollector<T>` becomes a `T[]` return or an injected client               | medium   |
| `FUNCTIONS_WORKER_RUNTIME` | value changes from `dotnet` to `dotnet-isolated` locally and in Azure app settings                       | high     |
| Log filtering              | host.json no longer filters your code's logs; filtering moves to `Program.cs`                            | low      |

## Pre-flight checklist

Before you touch a line of code:

- Confirm the app is on **host v4**. Run `func --version` (Core Tools 4.x) and check the portal's Function runtime version setting. If you are on v3 or earlier, upgrade the host first.
- Install the **.NET 8 SDK** (or .NET 11 SDK if you are targeting that) and **Azure Functions Core Tools v4** locally so you can run `func start` against the migrated project.
- Inventory your **trigger and binding packages**. Grep the `.csproj` for `Microsoft.Azure.WebJobs.Extensions` and write down each one; you will need the matching `Microsoft.Azure.Functions.Worker.Extensions.*` replacement.
- Inventory functions that take an **`ILogger` method parameter** and functions that use **`IBinder` or `IAsyncCollector<T>`**. These need hand edits the upgrade tooling cannot fully automate.
- Make sure you have a **staging deployment slot** available, or can create one. The runtime swap must not happen in-place on production.
- Take the usual safety net: a clean branch, a green build, and a passing test suite on the in-process version so you have a known-good baseline to diff against.
- Optional but recommended: install the **.NET Upgrade Assistant** (`dotnet tool install -g upgrade-assistant`). It automates the `.csproj`, `Program.cs`, attribute, and many signature changes; you then hand-fix the bindings it could not infer.

## Migration steps

Each step below is a discrete change with a verification line. Do them in order; the project will not build cleanly until the last one is done, which is expected.

1. **Convert the `.csproj` SDK and packages.** Remove the `Microsoft.NET.Sdk.Functions` reference, add the worker packages, and add `<OutputType>Exe</OutputType>`. The before and after:

   ```xml
   <!-- BEFORE: in-process, .NET 8, host v4 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFramework>net8.0</TargetFramework>
       <AzureFunctionsVersion>v4</AzureFunctionsVersion>
     </PropertyGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.NET.Sdk.Functions" Version="4.5.0" />
     </ItemGroup>
   </Project>
   ```

   ```xml
   <!-- AFTER: isolated worker, .NET 8, host v4 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFramework>net8.0</TargetFramework>
       <AzureFunctionsVersion>v4</AzureFunctionsVersion>
       <OutputType>Exe</OutputType>
       <ImplicitUsings>enable</ImplicitUsings>
       <Nullable>enable</Nullable>
     </PropertyGroup>
     <ItemGroup>
       <FrameworkReference Include="Microsoft.AspNetCore.App" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker" Version="2.0.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.Sdk" Version="2.0.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.Extensions.Http.AspNetCore" Version="2.0.0" />
       <PackageReference Include="Microsoft.ApplicationInsights.WorkerService" Version="2.23.0" />
       <PackageReference Include="Microsoft.Azure.Functions.Worker.ApplicationInsights" Version="2.0.0" />
     </ItemGroup>
   </Project>
   ```

   To target .NET 11 instead, set `<TargetFramework>net11.0</TargetFramework>`. The `FrameworkReference` to `Microsoft.AspNetCore.App` is what lets HTTP triggers keep returning `IActionResult`; keep it even if you have no HTTP triggers, because it improves worker startup. **Verify:** `dotnet restore` succeeds and pulls the worker packages. The build will still fail on code, which is fine.

2. **Replace every binding extension package.** For each `Microsoft.Azure.WebJobs.Extensions.*` you inventoried, swap to the worker equivalent. The common ones:

   ```text
   Microsoft.Azure.WebJobs.Extensions.Storage.Blobs
     -> Microsoft.Azure.Functions.Worker.Extensions.Storage.Blobs
   Microsoft.Azure.WebJobs.Extensions.ServiceBus
     -> Microsoft.Azure.Functions.Worker.Extensions.ServiceBus
   Microsoft.Azure.WebJobs.Extensions.CosmosDB
     -> Microsoft.Azure.Functions.Worker.Extensions.CosmosDB
   Microsoft.Azure.WebJobs.Extensions.EventHubs
     -> Microsoft.Azure.Functions.Worker.Extensions.EventHubs
   Microsoft.Azure.WebJobs.Extensions.DurableTask
     -> Microsoft.Azure.Functions.Worker.Extensions.DurableTask
   ```

   A timer trigger needs `Microsoft.Azure.Functions.Worker.Extensions.Timer` added explicitly. Remove `Microsoft.Azure.Functions.Extensions` entirely; the isolated worker provides DI startup natively. **Verify:** there are zero remaining references to any `Microsoft.Azure.WebJobs.*` package. `dotnet list package | Select-String WebJobs` (PowerShell) should print nothing.

3. **Add `Program.cs` and delete `Startup.cs`.** The isolated worker is a console app and needs an entry point. Move everything from your `FunctionsStartup.Configure` into `ConfigureServices`:

   ```csharp
   // Program.cs -- .NET 8 / .NET 11, Microsoft.Azure.Functions.Worker 2.0.x
   using Microsoft.Azure.Functions.Worker;
   using Microsoft.Extensions.DependencyInjection;
   using Microsoft.Extensions.Hosting;

   var builder = FunctionsApplication.CreateBuilder(args);

   // ConfigureFunctionsWebApplication() opts into ASP.NET Core integration so HTTP
   // triggers can keep using HttpRequest / IActionResult. Use
   // ConfigureFunctionsWorkerDefaults() instead if you have no HTTP triggers.
   builder.ConfigureFunctionsWebApplication();

   builder.Services
       .AddApplicationInsightsTelemetryWorkerService()
       .ConfigureFunctionsApplicationInsights();

   // Everything that used to be in Startup.Configure goes here:
   builder.Services.AddHttpClient();
   builder.Services.AddSingleton<IOrderStore, OrderStore>();

   builder.Build().Run();
   ```

   Then delete the class that carried the `[assembly: FunctionsStartup(typeof(Startup))]` attribute. **Verify:** the file compiles in isolation and there is no remaining `FunctionsStartup` attribute anywhere (`Select-String FunctionsStartup -Path **/*.cs`).

4. **Rename function attributes.** `[FunctionName("X")]` becomes `[Function("X")]`. The signature is identical, so this is a safe project-wide string replace. **Verify:** `Select-String "FunctionName" -Path **/*.cs` returns nothing.

5. **Move `ILogger` from parameter to constructor.** In-process let you take an `ILogger log` parameter on the function method. The isolated worker uses constructor injection. Convert each affected function class to a primary constructor:

   ```csharp
   // BEFORE (in-process)
   public static class HttpTriggerCSharp
   {
       [FunctionName("HttpTriggerCSharp")]
       public static IActionResult Run(
           [HttpTrigger(AuthorizationLevel.Function, "get")] HttpRequest req,
           ILogger log)
       {
           log.LogInformation("processed a request");
           return new OkObjectResult($"Hello, {req.Query["name"]}!");
       }
   }
   ```

   ```csharp
   // AFTER (isolated worker, .NET 8 / .NET 11, C# 12+ primary constructor)
   public class HttpTriggerCSharp(ILogger<HttpTriggerCSharp> logger)
   {
       [Function("HttpTriggerCSharp")]
       public IActionResult Run(
           [HttpTrigger(AuthorizationLevel.Function, "get")] HttpRequest req)
       {
           logger.LogInformation("processed a request");
           return new OkObjectResult($"Hello, {req.Query["name"]}!");
       }
   }
   ```

   Note the function is no longer `static`, the class is no longer `static`, and `ILogger` left the method signature. **Verify:** the function class builds and no function method still has an `ILogger` parameter.

6. **Fix trigger and binding usings and attribute names.** Remove `using Microsoft.Azure.WebJobs;`, add `using Microsoft.Azure.Functions.Worker;`. Triggers usually keep their name (`QueueTrigger` stays `QueueTrigger`), input bindings gain an `Input` suffix (`CosmosDB` becomes `CosmosDBInput`), and output bindings gain an `Output` suffix (`Queue` becomes `QueueOutput`, `Blob` becomes `BlobOutput`). Output bindings also leave the parameter list: a single output goes on the return type, and multiple outputs go on properties of a small result class. Replace `IAsyncCollector<T>` with a `T[]` return, and remove any `IBinder` parameter in favor of an injected client. **Verify:** `dotnet build` now succeeds with zero errors.

7. **Update `local.settings.json`.** Change the worker runtime value:

   ```json
   {
     "IsEncrypted": false,
     "Values": {
       "AzureWebJobsStorage": "UseDevelopmentStorage=true",
       "FUNCTIONS_WORKER_RUNTIME": "dotnet-isolated"
     }
   }
   ```

   No `host.json` change is required. **Verify:** `func start` boots the app locally and your functions appear in the startup banner with their routes.

## Verification

After the build is green, run this smoke test before you go near Azure:

- `dotnet build` returns zero errors and zero `Microsoft.Azure.WebJobs.*` references.
- `func start` launches and lists every function with the correct trigger and route.
- Hit each HTTP trigger locally (`curl` or your test client) and confirm the same status code and body the in-process version returned.
- Fire each non-HTTP trigger: drop a blob, enqueue a message, let the timer tick. Confirm the function runs and writes its outputs.
- `dotnet test` passes. Watch specifically for tests that asserted on log output or on serializer behavior, since both can shift (see gotchas).
- Compare a captured Application Insights trace from before and after. Confirm your log categories still appear at the levels you expect; if they vanished, your `Program.cs` log filtering is missing.

## Rolling it out in Azure, and rolling back

The Azure side is two changes that must happen together: set `FUNCTIONS_WORKER_RUNTIME` to `dotnet-isolated` and deploy the isolated payload. If only one lands, the app sits in an error state because the deployed code does not match the configured runtime. Never do this in-place on production. Instead:

1. Create or reuse a **staging deployment slot**.
2. On the staging slot, set the `FUNCTIONS_WORKER_RUNTIME` app setting to `dotnet-isolated`. Do **not** mark it as a slot setting. If you also changed .NET version, update the stack configuration on the slot too.
3. Publish the migrated project to the staging slot. You will see transient errors in the slot's logs during the interim; wait for them to stop.
4. Smoke-test the staging slot against real Azure dependencies. Confirm the errors have cleared and behavior matches production.
5. **Swap** the staging slot into production. The swap is a single atomic update, so production never sees the broken interim state.
6. Confirm production is healthy.

**Rollback:** this is fully reversible as long as you keep the in-process build. To revert, swap the slots back: the previous production payload (still in-process) returns to the production slot in one operation. Because the swap is atomic, rollback is the same one-click move as the rollout. Keep the in-process branch and its last good artifact until the new model has soaked under real traffic for at least a few days. The migration only becomes one-way the moment you delete that in-process artifact, so do not delete it on day one.

## Gotchas we hit

**Logs silently disappear from Application Insights.** In the in-process model, `host.json` controlled log filtering for everything, including your code. In the isolated worker, `host.json` only filters the Functions host runtime; your application's logs are filtered by the logging configuration in `Program.cs`. If you migrate and your `Information` logs vanish, add explicit filtering in `Program.cs` rather than expecting `host.json` to cover them.

**HTTP responses change shape if you relied on Newtonsoft.** In-process HTTP triggers returning `IActionResult` serialized through the host's MVC formatters, which many apps had configured with a Newtonsoft contract resolver. The isolated worker defaults to `System.Text.Json`. If your JSON suddenly uses different casing or drops a custom converter, register your serializer on the worker. If you are weighing whether to keep Newtonsoft at all, see [System.Text.Json vs Newtonsoft.Json in 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

**Durable Functions orchestrators that injected services start replaying nondeterministically.** The in-process host's DI was forgiving enough that calling an instance-scoped service inside an orchestrator sometimes worked by accident. On the isolated worker that same code can deadlock or replay nondeterministically. The fix is the standard Durable rule the in-process model let you bend: orchestrators call only activity functions, and side effects live in activities, not in injected services.

**The app sits red in Azure during deploy, and that is normal.** The first time you push the isolated payload to a slot whose `FUNCTIONS_WORKER_RUNTIME` is still `dotnet` (or vice versa), the slot reports an error state. That is the interim mismatch the docs warn about. It is exactly why the rollout goes through a staging slot, and it clears once both the setting and the payload agree.

**Output bindings on the parameter list will not compile.** The single most common build error after the package swap is an output binding still sitting as an `out` or `IAsyncCollector<T>` parameter. Move it to the return type (single output) or a result class (multiple outputs). The compiler error points at the parameter, but the fix is structural, not a type cast.

## Related

- [Azure Functions isolated worker vs in-process in .NET 11](/2026/05/azure-functions-isolated-worker-vs-in-process-in-dotnet-11/) is the decision-first companion to this checklist, with the full feature matrix and cold-start benchmark.
- [Migrate from .NET 8 to .NET 11: the full checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) is the natural next step once you are on the isolated worker and want to move the runtime forward.
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) covers the publish settings and trim warnings you will meet when you turn AOT on for the migrated worker.
- [Native AOT vs ReadyToRun vs plain JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) has the numbers behind the "isolated plus AOT beats in-process on cold start" claim.
- [How to reduce cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) shares most of the AOT cold-start advice if you also run functions outside Azure.

## Sources

- Microsoft Learn, [Migrate C# apps from the in-process model to the isolated worker model](https://learn.microsoft.com/en-us/azure/azure-functions/migrate-dotnet-to-isolated-model).
- Microsoft Learn, [Differences between the in-process model and the isolated worker model](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-in-process-differences).
- Microsoft Learn, [Guide for running C# Azure Functions in an isolated worker process](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide).
- Azure updates, [Support for the in-process model ends 10 November 2026](https://aka.ms/azure-functions-retirements/in-process-model).
- Microsoft Learn, [Migrate Durable Functions from in-process to the isolated worker model](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-migrate).
- `Microsoft.Azure.Functions.Worker` on [NuGet](https://www.nuget.org/packages/Microsoft.Azure.Functions.Worker).
