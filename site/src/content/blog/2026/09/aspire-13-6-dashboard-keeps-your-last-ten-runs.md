---
title: "Aspire 13.6 Dashboard Keeps Your Last Ten Runs in SQLite"
description: "Aspire 13.6.0 makes the dashboard persistent: resource snapshots and telemetry go into a SQLite database, the AppHost keeps up to ten runs per application, and completed runs stay browsable read-only. Here is how the Run, Resume, and None modes work and how to configure the standalone dashboard."
pubDate: 2026-09-30
tags:
  - "aspire"
  - "dotnet"
  - "opentelemetry"
  - "observability"
---

[Aspire 13.6.0](https://github.com/microsoft/aspire/releases/tag/v13.6.0) shipped on September 29, 2026, and the change you will notice first is that the dashboard no longer forgets everything when you stop the AppHost. Until 13.5, the dashboard kept telemetry in memory: hit Ctrl+C after reproducing a bug, and the trace you wanted was gone. In 13.6 the dashboard stores resource snapshots and telemetry in a versioned SQLite database, and a selector in the header lets you switch between the live run and earlier ones.

## What the AppHost does by default

When the dashboard is launched by an AppHost, it uses **Run** persistence without any opt-in. Each `aspire run` becomes a separate entry, and up to ten runs per application are kept. Completed runs are read-only, so you can open the run from before your fix and compare its resources, structured logs, traces, and metrics against the live one side by side.

Nothing changes in your AppHost code. This is still the same file you had yesterday:

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedis("cache");

builder.AddProject<Projects.Api>("api")
       .WithReference(cache);

builder.Build().Run();
```

The data lands under `<ASPIRE_HOME>/dashboard` by default, partitioned by the application name.

## Bigger buffers, still bounded

The same release raises the default limits for console log messages, structured logs, and traces to 100,000 each. These are still ring buffers, not an archive: once a limit is exceeded, the oldest entries are dropped. If you need more or less, the existing settings apply, for example `Dashboard:TelemetryLimits:MaxLogCount`, `Dashboard:TelemetryLimits:MaxTraceCount`, and `Dashboard:Frontend:MaxConsoleLogCount`, or the `DASHBOARD__TELEMETRYLIMITS__MAXLOGCOUNT` style environment variables.

## Standalone dashboard: None, Run, Resume

The standalone dashboard keeps its old behaviour by default: **None** persistence, a temporary database deleted when the dashboard stops. To keep data across restarts, use **Resume** with a stable application name:

```bash
aspire dashboard run --application-name my-app --persistence Resume
```

In a container, mount the data directory on a volume and pass the same three values every time:

```bash
docker run --rm -it -p 18888:18888 -p 4317:18889 \
  -v aspire-dashboard-data:/data \
  -e ASPIRE_DASHBOARD_DATA_DIRECTORY=/data \
  -e ASPIRE_DASHBOARD_APPLICATION_NAME=my-app \
  -e ASPIRE_DASHBOARD_PERSISTENCE_MODE=Resume \
  mcr.microsoft.com/dotnet/aspire-dashboard:latest
```

If the application name, directory, or mode changes between restarts, you get a fresh database instead of your history. The application name also scopes the dashboard's authentication and antiforgery cookie names, so pick one per app and keep it.

## Treat the database like a secret

The release notes are blunt about this: the SQLite file can contain sensitive resource and telemetry values, and it has no encryption or authorization layer of its own. On Unix the file permissions are restricted to the owner; on Windows, ACLs are not set for you. Environment variables you inject into resources, connection strings in resource snapshots, and whatever your app logs are now sitting on disk after the run ends. Do not mount that volume anywhere shared, and do not commit `ASPIRE_HOME` into a dev container image.

The dashboard itself also changed under the hood: it now ships as Native AOT and moved to Fluent UI v5 with a collapsible navigation rail. AppHost-owned terminals now open in a dashboard dock, extending the [`WithTerminal` work from 13.5](/2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard/), and 13.6 adds opt-in `WithRepl()` database clients on top. The full list, including breaking changes, is in [What's new in Aspire 13.6](https://aspire.dev/whats-new/aspire-13-6/).
