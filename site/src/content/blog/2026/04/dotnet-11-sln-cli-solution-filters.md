---
title: "dotnet sln finally edits solution filters from the CLI in .NET 11 Preview 3"
description: ".NET 11 Preview 3 teaches dotnet sln to create, add, remove, and list projects in .slnf solution filters, so large mono-repos can load a subset without opening Visual Studio."
pubDate: 2026-04-18
tags:
  - ".NET 11"
  - "SDK"
  - "dotnet CLI"
  - "MSBuild"
---

Solution filters (`.slnf`) have existed since Visual Studio 2019, but editing them outside the IDE meant hand-writing JSON. [.NET 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/sdk.md) fixes that: `dotnet sln` now creates, edits, and lists the contents of `.slnf` files directly, via [dotnet/sdk #51156](https://github.com/dotnet/sdk/pull/51156). For large repositories this is the difference between opening a twenty-project subset from the terminal and keeping a shell script that pokes at JSON by hand.

## What a solution filter actually is

An `.slnf` is a JSON pointer to a parent `.sln` plus a list of project paths. When a tool loads the filter it unloads every project in the parent solution that is not on the list. That keeps build graphs, analyzers, and IntelliSense focused on the subset you care about, which is the main lever large code bases have to keep IDE load times sane. Until Preview 3 the CLI could happily `build` a filter but not edit one.

## The new commands

The surface mirrors the existing `dotnet sln` verbs. You can create a filter, add and remove projects, and list what is currently included:

```bash
# Create a filter that points at the current .sln
dotnet new slnf --name MyApp.slnf

# Target a specific parent solution
dotnet new slnf --name MyApp.slnf --solution-file ./MyApp.sln

# Add and remove projects
dotnet sln MyApp.slnf add src/Lib/Lib.csproj
dotnet sln MyApp.slnf add src/Api/Api.csproj src/Web/Web.csproj
dotnet sln MyApp.slnf remove src/Lib/Lib.csproj

# Inspect what the filter currently loads
dotnet sln MyApp.slnf list
```

The commands accept the same glob and multi-argument forms that `dotnet sln` already supports for `.sln` files, and they write `.slnf` JSON that matches what Visual Studio emits, so a filter you edit from the CLI opens cleanly in the IDE.

## Why this matters for mono-repos

Two workflows become much cheaper. The first is CI: a pipeline can check out the full repo but build only the filter relevant to the changed paths. Before Preview 3 most teams did this with a custom script that wrote JSON or kept hand-maintained `.slnf` files next to the `.sln`. Now the same pipeline can regenerate filters on the fly:

```bash
dotnet new slnf --name ci-api.slnf --solution-file MonoRepo.sln
dotnet sln ci-api.slnf add \
  src/Api/**/*.csproj \
  src/Shared/**/*.csproj \
  test/Api/**/*.csproj

dotnet build ci-api.slnf -c Release
```

The second is local dev. Large repos often ship a handful of "starter" filters so a new engineer can open the backend without waiting for the mobile and docs projects to load. Keeping those filters accurate used to require opening each one in Visual Studio after a project move, because `.sln` renames did not update `.slnf` automatically. With the new commands the update is a one-liner:

```bash
dotnet sln backend.slnf remove src/Legacy/OldService.csproj
dotnet sln backend.slnf add src/Services/NewService.csproj
```

## A small note on paths

`dotnet sln` resolves project paths relative to the filter, not the caller, which matches how the IDE reads them. If the `.slnf` lives in `build/filters/` and points at projects under `src/`, the stored path will be `..\..\src\Foo\Foo.csproj`, and `dotnet sln list` shows it the same way. That is worth remembering when you script filter edits from a different working directory.

Combined with [`dotnet run -e` for inline environment variables](https://github.com/dotnet/sdk/pull/52664) and the earlier [single-step EF Core migrations](https://startdebugging.net/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/), Preview 3 keeps chipping away at the "I have to open Visual Studio to do this" set. The full list is in the [.NET 11 Preview 3 SDK notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/sdk.md).
