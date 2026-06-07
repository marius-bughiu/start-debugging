---
title: "EF Core 11 Preview 4: Stop Retyping --project and --startup-project with .config/dotnet-ef.json"
description: "EF Core 11 Preview 4 lets the dotnet ef tool read default option values from a .config/dotnet-ef.json file, so split solutions no longer force you to pass --project and --startup-project on every command."
pubDate: 2026-06-01
tags:
  - "ef-core"
  - "dotnet-11"
  - "dotnet-cli"
  - "csharp"
  - "dotnet"
---

Anyone who runs EF Core migrations in a layered solution knows the ritual: the `DbContext` lives in an infrastructure project, the connection string and DI wiring live in the API project, and so every `dotnet ef` command turns into a paragraph. `dotnet ef migrations add AddOrders --project src/App.Infrastructure --startup-project src/App.Api --context AppDbContext`. You either memorize it, alias it, or paste it from a notes file. [EF Core 11 Preview 4](/2026/05/ef-core-11-temporal-tables-clr-period-properties/), shipped May 12, 2026 as part of [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/), finally lets you write those defaults down once.

## A config file the tool walks up to find

The `dotnet ef` command-line tool now reads default option values from a `.config/dotnet-ef.json` file. Discovery works the same way as `.editorconfig` or `global.json`: the tool walks up the directory tree from your current working directory and uses the first file it finds. Drop one at the solution root and every command run from anywhere inside the tree inherits it.

```json
{
  "project": "src/App.Infrastructure",
  "startupProject": "src/App.Api",
  "framework": "net11.0",
  "configuration": "Debug",
  "context": "AppDbContext",
  "runtime": "win-x64",
  "verbose": true,
  "noColor": false,
  "prefixOutput": false
}
```

With that file in place, the paragraph collapses back to what it always should have been:

```console
dotnet ef migrations add AddOrders
dotnet ef database update
```

The supported keys map directly to the familiar flags: `project`, `startupProject`, `framework`, `configuration`, `context`, `runtime`, `verbose`, `noColor`, and `prefixOutput`. One thing worth getting right: the `project` and `startupProject` path values are resolved relative to the parent of the `.config` directory that holds the file, not relative to wherever you happen to be standing when you run the command. Put the file at the repo root in `.config/`, and the paths read like they were written from the root.

## Explicit flags still win

This is a defaults file, not a lock file. Any option you pass on the command line overrides the JSON value, so you can keep `AppDbContext` as your default and still run a one-off against a second context:

```console
dotnet ef migrations add AddAudit --context AuditDbContext
```

That precedence is the whole reason this is safe to commit. Check `.config/dotnet-ef.json` into source control and every developer, plus CI, gets the same defaults without anyone editing a shared script. The pattern mirrors how `dotnet tool` already uses `.config/dotnet-tools.json`, so the location will feel familiar to anyone using local tool manifests.

There is a smaller companion change in the same preview that pairs well with scripting: the EF tool now writes all logging and status messages to standard error, reserving standard output for the command's actual result. So `dotnet ef migrations script > schema.sql` gives you clean SQL with no banner noise mixed in.

This lands alongside the temporal-table ergonomics work covered in [EF Core 11 Preview 4: Temporal Table Period Columns Can Finally Be Real Properties](/2026/05/ef-core-11-temporal-tables-clr-period-properties/). For the full rundown, see the [Configuration file section in the dotnet ef docs](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#configuration-file) and the [EF Core 11 what's new page](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
