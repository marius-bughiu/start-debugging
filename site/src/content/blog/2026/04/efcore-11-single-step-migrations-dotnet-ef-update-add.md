---
title: "EF Core 11 Lets You Create and Apply a Migration in One Command"
description: "The dotnet ef database update command now accepts --add to scaffold and apply a migration in a single step. Here is how it works, why it matters for containers and .NET Aspire, and what to watch for."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "ef-core"
  - "csharp"
  - "dotnet"
---

If you have ever toggled between `dotnet ef migrations add` and `dotnet ef database update` dozens of times during a prototyping session, EF Core 11 Preview 2 has a small quality-of-life win: the `--add` flag on `database update`.

## One command instead of two

The new workflow collapses the two-step dance into a single invocation:

```bash
dotnet ef database update InitialCreate --add
```

That command scaffolds a migration named `InitialCreate`, compiles it with Roslyn at runtime, and applies it to the database. The migration files still land on disk, so they end up in source control like any other migration.

If you need to customize the output directory or namespace, the same options from `migrations add` carry over:

```bash
dotnet ef database update AddProducts --add \
  --output-dir Migrations/Products \
  --namespace MyApp.Migrations
```

PowerShell users get the equivalent `-Add` switch on `Update-Database`:

```powershell
Update-Database -Migration InitialCreate -Add
```

## Why runtime compilation matters

The real payoff is not saving a few keystrokes in local dev. It is enabling migration workflows in environments where recompilation is not an option.

Think .NET Aspire orchestration or containerized CI pipelines: the compiled project is already baked into the image. Without `--add`, you would need a separate build step just to scaffold a migration, rebuild the project, then apply it. With runtime Roslyn compilation, the `database update` command handles the entire lifecycle in place.

## Offline migration removal

EF Core 11 also adds an `--offline` flag to `migrations remove`. If the database is unreachable, or you know for certain the migration was never applied, you can skip the connection check entirely:

```bash
dotnet ef migrations remove --offline
```

Note that `--offline` and `--force` are mutually exclusive: `--force` needs a live connection to verify whether the migration was applied before reverting it.

Both commands also accept a `--connection` parameter now, so you can target a specific database without touching your `DbContext` configuration:

```bash
dotnet ef migrations remove --connection "Server=staging;Database=App;..."
```

## When to reach for it

For prototyping and inner-loop development, `--add` removes friction. For container-based deployment pipelines, it removes an entire build stage. Just keep in mind that runtime-compiled migrations bypass your normal build warnings, so treat the generated files as artifacts that still deserve a review before they hit `main`.

Full details are in the [EF Core 11 what's new docs](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
