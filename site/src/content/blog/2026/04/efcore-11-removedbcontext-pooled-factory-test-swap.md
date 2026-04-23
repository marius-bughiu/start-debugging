---
title: "EF Core 11 Preview 3 Adds RemoveDbContext for Clean Test Provider Swaps"
description: "EF Core 11 Preview 3 introduces RemoveDbContext, RemoveExtension, and a parameterless AddPooledDbContextFactory overload, removing the boilerplate around swapping providers in tests and centralizing pooled factory configuration."
pubDate: 2026-04-23
tags:
  - ".NET 11"
  - "EF Core 11"
  - "testing"
  - "dependency injection"
---

EF Core 11 Preview 3 quietly fixes one of the longest-standing annoyances in integration testing with EF Core: the need to undo a parent project's `AddDbContext` call before registering a different provider. The release introduces `RemoveDbContext<TContext>()` and `RemoveExtension<TExtension>()` helpers, plus a parameterless overload for `AddPooledDbContextFactory<TContext>()` that reuses configuration declared inside the context itself.

## The old test-swap dance

If your composition root in `Startup` or `Program.cs` registers a SQL Server context, the integration test project usually needs to override that. Until now, doing it cleanly required either restructuring the production registration into an extension method that took a configuration delegate, or manually walking `IServiceCollection` and removing each `ServiceDescriptor` that EF Core had registered. That second route is brittle, because it depends on the exact set of internal services EF Core wires up for a given provider.

```csharp
// EF Core 10 and earlier: manual cleanup before swapping providers
services.RemoveAll<DbContextOptions<AppDbContext>>();
services.RemoveAll(typeof(AppDbContext));
services.RemoveAll(typeof(IDbContextOptionsConfiguration<AppDbContext>));
services.AddDbContext<AppDbContext>(o => o.UseSqlite("DataSource=:memory:"));
```

You had to know which descriptor types to scrub, and any change in how EF Core wires its options pipeline could break the test setup silently.

## What `RemoveDbContext` actually does

In Preview 3 the same swap collapses to two lines:

```csharp
services.RemoveDbContext<AppDbContext>();
services.AddDbContext<AppDbContext>(o => o.UseSqlite("DataSource=:memory:"));
```

`RemoveDbContext<TContext>()` strips the context registration, the bound `DbContextOptions<TContext>`, and the configuration callbacks EF Core has accumulated for that context. There is also a more surgical `RemoveExtension<TExtension>()` for the case where you want to keep most of the configuration intact but drop a single options extension, for example removing the SQL Server retry strategy without rebuilding the whole pipeline.

## Pooled factories without duplicating configuration

The second change targets `AddPooledDbContextFactory<TContext>()`. Previously the call required an options delegate, even when the context already overrode `OnConfiguring` or had registered its configuration through `ConfigureDbContext<TContext>()`. Preview 3 adds a parameterless overload, so a context that already knows how to configure itself can be exposed as a pooled factory in one line:

```csharp
services.ConfigureDbContext<AppDbContext>(o =>
    o.UseSqlServer(connectionString));

services.AddPooledDbContextFactory<AppDbContext>();
```

Combined, the two changes make it trivial to take a production registration, strip the provider, and re-add the same context as a pooled factory pointing at a different store, which is exactly the shape most multi-tenant test fixtures already wanted.

## Where to read more

The full notes live in the [EF Core 11 Preview 3 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md), and the announcement is in the [.NET 11 Preview 3 post](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/). If you maintain a test fixture base class that does the manual `RemoveAll` dance, this is the moment to delete it.
