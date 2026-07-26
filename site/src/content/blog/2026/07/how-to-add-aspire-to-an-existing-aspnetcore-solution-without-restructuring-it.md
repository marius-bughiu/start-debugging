---
title: "How to add Aspire to an existing ASP.NET Core solution without restructuring it"
description: "Add Aspire 13.4 to a brownfield ASP.NET Core solution by adding two new projects and three lines per service: aspire init, AppHost wiring with AddProject and WithReference, keeping your existing launchSettings.json and connection strings, and the resilience, health-endpoint, and proxy gotchas that bite on day one."
pubDate: 2026-07-26
template: how-to
tags:
  - "aspire"
  - "dotnet"
  - "aspnetcore"
  - "dotnet-11"
  - "opentelemetry"
  - "devops"
---

You add Aspire to an existing ASP.NET Core solution by adding two new projects next to the ones you already have, not by moving anything. An `AppHost` project orchestrates your services at development time, a `ServiceDefaults` class library carries the shared telemetry and resilience wiring, and each existing service gains exactly one project reference plus two lines in `Program.cs`. Your folder layout, namespaces, `launchSettings.json`, connection strings, Dockerfiles, and CI pipeline all stay as they are. This post walks the whole thing on Aspire 13.4.6 (the current stable release, published 2026-06-20) against .NET 10 and .NET 11 Preview 6.

Two things changed since the guides you probably found first. Aspire dropped the ".NET" from its name with Aspire 13 in November 2025, and the `dotnet workload install aspire` step disappeared back in Aspire 9.0. Everything now arrives through NuGet and an MSBuild SDK, so if you still have the old workload on the machine, `dotnet workload uninstall aspire` is the first thing to run. If you want the conceptual tour before the mechanics, the older [overview of what Aspire is](/2023/11/what-is-net-aspire/) still holds up.

## What actually lands in your repo

The honest inventory, for a solution with an API and a worker:

```
MyApp.sln
  src/MyApp.Api/            <- unchanged except 1 ProjectReference + 2 lines
  src/MyApp.Worker/         <- unchanged except 1 ProjectReference + 2 lines
  src/MyApp.AppHost/        <- new
  src/MyApp.ServiceDefaults/<- new
  aspire.config.json        <- new, points the CLI at the AppHost
```

No project moves. No namespace changes. No change to how `dotnet publish` produces your container images, because the AppHost is a development-time orchestrator and is not part of what you deploy. That last point is the one people get wrong: the AppHost does not run in production. It launches your processes locally, injects configuration into them, and feeds the dashboard.

## Steps to add Aspire to an existing solution

1. Install the Aspire CLI as a global tool and confirm it sees your SDK.
2. Run `aspire init` from the solution root so it detects the `.sln` and scaffolds a project-based AppHost.
3. Add a project reference from the AppHost to each service you want it to launch, then declare them with `AddProject` in the AppHost's `Program.cs`.
4. Reference `ServiceDefaults` from each service and call `AddServiceDefaults()` and `MapDefaultEndpoints()`.
5. Model your existing infrastructure: containers for things you are happy to run locally, `AddConnectionString` for anything that must stay external.
6. Run `aspire run` and check that every service still starts with the endpoints it had before.

The rest of this post is those six steps with the code, then the parts that break.

## Installing the CLI

Since Aspire 13.3 the CLI ships as a NativeAOT .NET global tool, which means no workload and no Visual Studio dependency:

```bash
dotnet tool install -g Aspire.Cli
aspire doctor
```

`aspire doctor` arrived in 13.4 and is worth running before anything else. It prints the CLI version, the SDKs it can see, and, importantly, whether your CLI version and your `Aspire.AppHost.Sdk` version have drifted apart. Version mismatch between the two is the single most common source of "it worked on my machine" in an Aspire repo.

## Scaffolding the AppHost

From the directory containing your `.sln`:

```bash
aspire init
```

When `aspire init` finds a solution file it creates a project-based AppHost and adds it to the solution. When it does not find one (a polyglot repo, say) it creates a single-file `apphost.cs` using `#:sdk` and `#:package` directives instead. For an existing ASP.NET Core solution you want the project-based form, because that is what gives you the generated `Projects` namespace and IDE-integrated debugging across every service at once.

If you would rather not use the CLI, the templates do the same job:

```bash
dotnet new aspire-apphost -o src/MyApp.AppHost
dotnet new aspire-servicedefaults -o src/MyApp.ServiceDefaults
dotnet sln add src/MyApp.AppHost src/MyApp.ServiceDefaults
```

The AppHost project file is small and is the only place the Aspire SDK appears:

```xml
<!-- src/MyApp.AppHost/MyApp.AppHost.csproj -- Aspire 13.4.6 -->
<Project Sdk="Microsoft.NET.Sdk">
  <Sdk Name="Aspire.AppHost.Sdk" Version="13.4.6" />

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <IsAspireHost>true</IsAspireHost>
    <Nullable>enable</Nullable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Aspire.Hosting.AppHost" Version="13.4.6" />
  </ItemGroup>
</Project>
```

Note the `TargetFramework`. The AppHost can target a newer TFM than the services it launches, because it launches them as separate processes. A solution stuck on `net8.0` for its services can still have a `net10.0` AppHost.

## Wiring your existing projects

Add references from the AppHost to the services, then declare them:

```bash
dotnet add src/MyApp.AppHost reference src/MyApp.Api src/MyApp.Worker
```

```csharp
// src/MyApp.AppHost/Program.cs -- Aspire 13.4.6
var builder = DistributedApplication.CreateBuilder(args);

var api = builder.AddProject<Projects.MyApp_Api>("api")
    .WithExternalHttpEndpoints();

builder.AddProject<Projects.MyApp_Worker>("worker")
    .WithReference(api)
    .WaitFor(api);

builder.Build().Run();
```

The `Projects.MyApp_Api` type is generated by the Aspire SDK from the `ProjectReference` items, with dots replaced by underscores. You do not write it and it does not exist until the first build.

Here is the part that makes this non-invasive, and it is under-documented: Aspire reads your existing `Properties/launchSettings.json`. When it launches a project resource it picks a profile by precedence -- the `launchProfileName` argument if you passed one, then a profile whose name matches the AppHost's own `DOTNET_LAUNCH_PROFILE`, then the first profile in the file, then no profile at all. It parses `applicationUrl` from the selected profile and converts it into `ASPNETCORE_URLS`, and it applies that profile's `environmentVariables` unmodified. Your existing profiles keep working. If a service has an "IIS Express" profile first in the file and you want the Kestrel one, name it:

```csharp
builder.AddProject<Projects.MyApp_Api>("api", launchProfileName: "https");
```

Passing `launchProfileName: null` launches the project with no profile at all, which is the cleanest option for a worker that has no meaningful `launchSettings.json`.

## The two lines per service

`ServiceDefaults` is a plain class library marked `IsAspireSharedProject`. Reference it from each service and call into it:

```csharp
// src/MyApp.Api/Program.cs -- ASP.NET Core on .NET 10 / .NET 11 Preview 6
var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();   // <- added

builder.Services.AddControllers();
// ... everything you already had, untouched

var app = builder.Build();

app.MapDefaultEndpoints();      // <- added

app.MapControllers();
app.Run();
```

`AddServiceDefaults()` does four things: configures OpenTelemetry logging, metrics, and tracing (with health-check requests filtered out of traces); registers a liveness health check; registers service discovery; and applies `ConfigureHttpClientDefaults` so every `HttpClient` gets the standard resilience handler and service-discovery resolution. `MapDefaultEndpoints()` maps `/health` (all checks must pass) and `/alive` (only checks tagged `live`), and the template guards both behind a development-environment check.

Nothing here is Aspire-specific at runtime. A service that calls `AddServiceDefaults()` runs perfectly well outside the AppHost, under `dotnet run`, in a container, in your existing Kubernetes deployment. It just exports OTLP telemetry to whatever `OTEL_EXPORTER_OTLP_ENDPOINT` points at, which is the dashboard when the AppHost launched it and your real collector when it did not. If you have not got a collector yet, the [free OpenTelemetry backend walkthrough](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) covers the other end of that pipe.

## Modelling infrastructure you already have

This is where brownfield diverges hardest from the greenfield tutorials, which all start by containerizing everything. You usually cannot. The shared dev SQL Server is shared for a reason, and the queue has data in it.

For dependencies you are happy to run locally, add the integration and let Aspire own the container:

```bash
aspire add redis
```

```csharp
var cache = builder.AddRedis("cache");

var api = builder.AddProject<Projects.MyApp_Api>("api")
    .WithReference(cache)
    .WaitFor(cache);
```

`WithReference(cache)` injects `ConnectionStrings__cache` into the API process. Your existing `builder.Configuration.GetConnectionString("cache")` call reads it without modification, because environment variables outrank `appsettings.json` in the default configuration precedence. That is the whole trick: Aspire does not ask your code to change how it reads configuration, it just supplies the values at a higher precedence. Same story if you are wiring [HybridCache with Redis as the L2](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) -- the cache resource feeds the connection string and the rest of your setup is unchanged.

For dependencies that must stay external, `AddConnectionString` creates a resource backed by the AppHost's own configuration rather than a container:

```csharp
// Reads ConnectionStrings:orders from the AppHost's appsettings.json or user secrets
var orders = builder.AddConnectionString("orders");

builder.AddProject<Projects.MyApp_Api>("api")
    .WithReference(orders);
```

Put the real value in the AppHost's user secrets, not in `appsettings.json`:

```bash
dotnet user-secrets --project src/MyApp.AppHost set "ConnectionStrings:orders" "Server=dev-sql;Database=Orders;..."
```

The service sees `ConnectionStrings__orders` and nothing else changes. If a service goes looking for a name the AppHost never declared you will get the familiar startup failure covered in [no connection string named DefaultConnection](/2026/05/fix-no-connection-string-named-defaultconnection/); the resource name in `AddConnectionString` has to match the key your code asks for, exactly.

Service-to-service calls get the same treatment. `WithReference(api)` injects `services__api__https__0` and `services__api__http__0`, and service discovery resolves the logical name:

```csharp
builder.Services.AddHttpClient<OrdersClient>(
    c => c.BaseAddress = new("https+http://api"));
```

`https+http://` means prefer HTTPS, fall back to HTTP. It only resolves in a project that registered service discovery, which `AddServiceDefaults()` does for you. Use that scheme in a project that skipped `AddServiceDefaults()` and you get a `UriFormatException` at the first request, not at startup.

## Run it

```bash
aspire run
```

The CLI finds the AppHost through `aspire.config.json`, starts every resource, and prints the dashboard URL. In Visual Studio or Rider, set the AppHost as the startup project and press F5; multi-project startup configurations are no longer needed.

One thing that surprises people migrating from the 2023-era guides: you do not need Docker running unless you actually declared a container resource. An AppHost that is nothing but `AddProject` calls launches fine with no container runtime installed at all. That makes the first commit safe -- you can land the AppHost with zero container resources, get the dashboard and distributed tracing, and containerize dependencies later or never.

## What breaks on day one

**The standard resilience handler changes your HTTP behaviour.** `AddServiceDefaults()` applies it to every `HttpClient` in the process, which means retries, a circuit breaker, and a total request timeout. If you have a client that legitimately takes two minutes, or you already have hand-rolled Polly pipelines, you now have two layers. Strip your own, or scope the defaults, but do not leave both in place.

**Duplicate health endpoints.** If you already map `/health` yourself, `MapDefaultEndpoints()` gives you a second registration on the same route. Pick one. The [minimal API health check walkthrough](/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/) covers what to keep if you want richer output than the default.

**Double OpenTelemetry registration.** `ConfigureOpenTelemetry` in `ServiceDefaults` is additive over anything you already registered. If your `Program.cs` has its own `AddOpenTelemetry().WithTracing(...)`, you will get duplicated instrumentation and, with Serilog in the mix, duplicated log records. Delete yours and customize the `ServiceDefaults` version instead, which is the point of the shared project.

**Endpoints are proxied by default.** Aspire puts a reverse proxy in front of each endpoint, so the port your browser hits is not the port Kestrel bound. That is invisible until something external pins a port: an OIDC redirect URI registered with your identity provider, a webhook from a payment sandbox, a hardcoded URL in a mobile client. Opt out per endpoint:

```csharp
builder.AddProject<Projects.MyApp_Api>("api")
    .WithEndpoint("https", e => e.IsProxied = false);
```

**Your CI now builds the AppHost.** `dotnet build MyApp.sln` picks up the new project, which needs to restore `Aspire.AppHost.Sdk` from NuGet. On a locked-down feed with an explicit package allowlist, that fails, and the error is an SDK resolution error rather than a missing-package error, which makes it slower to diagnose than it should be. Either allowlist the SDK and the hosting packages, or exclude the AppHost from the CI build with a solution filter. Nothing in your deployment pipeline needs to change beyond that, because you are still publishing the same service projects the same way.

**Postgres users on 13.4:** the default image moved from 17.6 to 18.3, which will not attach to an existing 17.x data volume. Pin the tag with `WithImageTag` if you have local data you care about.

## Related

- [What is .NET Aspire?](/2023/11/what-is-net-aspire/) for the conceptual model behind the AppHost and integrations.
- [How to add a health check endpoint to a minimal API in ASP.NET Core 11](/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/) if `MapDefaultEndpoints` collides with what you already have.
- [How to use OpenTelemetry with .NET 11 and a free backend](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) for where the traces go once you leave the dashboard behind.
- [Fix: No connection string named 'DefaultConnection' could be found](/2026/05/fix-no-connection-string-named-defaultconnection/) for the resource-name mismatch failure mode.
- [Aspire 13.2 isolated mode and parallel AppHost instances](/2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances/) if two developers, or two branches, need to run the same AppHost at once.

## Sources

- [Add Aspire to an existing app](https://aspire.dev/get-started/add-aspire-existing-app/), Aspire documentation.
- [C# service defaults](https://aspire.dev/get-started/csharp-service-defaults/), Aspire documentation.
- [C# launch profiles in the Aspire AppHost](https://aspire.dev/integrations/dotnet/launch-profiles/), Aspire documentation.
- [External parameters and secrets in the AppHost](https://aspire.dev/fundamentals/external-parameters/), Aspire documentation.
- [Service discovery](https://aspire.dev/fundamentals/service-discovery/), Aspire documentation.
- [What's new in Aspire 13.3](https://aspire.dev/whats-new/aspire-13-3/) and [What's new in Aspire 13.4](https://aspire.dev/whats-new/aspire-13-4/), Aspire documentation.
- [Aspire releases](https://github.com/microsoft/aspire/releases) on GitHub, for the 13.4.6 version and date.
