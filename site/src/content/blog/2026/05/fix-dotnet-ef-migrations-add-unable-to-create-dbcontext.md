---
title: "Fix: dotnet ef migrations add fails with 'Unable to create an object of type DbContext'"
description: "EF Core's design-time tools could not instantiate your DbContext. Either expose a host via WebApplication.CreateBuilder, point to the right startup project, or implement IDesignTimeDbContextFactory."
pubDate: 2026-05-11
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "migrations"
---

The fix: `dotnet ef` runs your app at design time to discover the `DbContext`. It failed because the entry point did not return a host it could probe, or your `DbContext` has constructor parameters that cannot be resolved without one. In a web app, make sure `Program.cs` builds and uses (or returns) a `WebApplication`. In a class library or test project, add an `IDesignTimeDbContextFactory<TContext>` implementation. Then re-run with `--startup-project` pointing at the host project, not the data project.

```text
Unable to create an object of type 'AppDbContext'. For the different patterns supported at design time, see https://go.microsoft.com/fwlink/?linkid=851728
```

This guide is written against `Microsoft.EntityFrameworkCore.Design` 11.0.0-preview.4, `dotnet-ef` 11.0.0-preview.4, and .NET 11 SDK preview 4. The same behaviour applies all the way back to EF Core 3.1: the design-time discovery rules have not changed shape since the introduction of the generic host. If you are still on EF Core 6 or 8, every fix below works, only the namespaces shift slightly.

## How the design-time tools find your DbContext

When you run `dotnet ef migrations add Init`, the tool does not statically scan your code. It builds your project, loads the resulting assembly, and looks for one of four things, in this order:

1. An implementation of `IDesignTimeDbContextFactory<TContext>` in the startup project.
2. A host returned from `Program.Main` or exposed via the implicit `WebApplication` builder pattern. The tool calls `IHost.Services.GetRequiredService<TContext>()` against it.
3. A `DbContext` with a public parameterless constructor. The tool calls `new TContext()` directly.
4. A `DbContext` with `OnConfiguring` that does not depend on injected services.

If none of those produce an instance, you get the `Unable to create an object of type 'X'` error. The hyperlink in the message points at the design-time docs, which list the same four paths.

## Why this happens in a typical web app

Most projects fail at path 2. The tool can call your `Program.cs` but cannot find a host to probe. Three things commonly break path 2 in 2026:

1. `Program.cs` builds the `WebApplication` but exits before the tool can read `Services` because of top-level statement ordering.
2. The `DbContext` is registered in a different assembly than the one passed as `--startup-project`. The tool ran the wrong project.
3. The `DbContext` constructor takes a custom type (a tenant resolver, a clock, a feature flag service) that the DI container cannot resolve without `app.Run()` actually executing.

The first one is the silent killer. With top-level statements, the compiler synthesises a `Program.Main` whose return type and final statement matter to EF Core. If `app.Run()` is the last expression, the tool reads the host via reflection on the synthetic `Program` class. If you wrapped the run call in a conditional, or if you `return` early, the host never reaches the tool.

## A minimal repro

This is the smallest project that produces the error. One `WebApi` project, one `DbContext` with an injected dependency, no design-time factory.

```csharp
// AppDbContext.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;

public sealed class AppDbContext : DbContext
{
    private readonly ITenantResolver _tenant;

    public AppDbContext(DbContextOptions<AppDbContext> options, ITenantResolver tenant)
        : base(options)
    {
        _tenant = tenant;
    }

    public DbSet<Order> Orders => Set<Order>();
}

public interface ITenantResolver { string Current { get; } }
public sealed class Order { public int Id { get; set; } public string TenantId { get; set; } = ""; }
```

```csharp
// Program.cs - .NET 11
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddScoped<ITenantResolver, HttpHeaderTenantResolver>();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

var app = builder.Build();

if (args.Contains("--migrate-only"))
{
    return; // <-- design-time tool reads this path, never reaches app.Run()
}

app.Run();
```

Running `dotnet ef migrations add Init` against that project prints the error. The `ITenantResolver` registration only happens after `builder.Build()`, but the early `return` short-circuits the synthesized `Main` and the EF Core host probe sees a partially initialized state. The discovery code also tries `new AppDbContext()`, which fails because the constructor needs two arguments.

## Fix 1 - let the host be discoverable (recommended for web apps)

The cleanest fix is to let `Program.cs` finish initialising the host without conditional early returns. EF Core's design-time host factory uses `HostFactoryResolver` to walk the compiled `Program.Main` and grab the `IHost` reference. Anything that prevents that walk also prevents EF Core from finding the context.

```csharp
// Program.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddScoped<ITenantResolver, HttpHeaderTenantResolver>();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

var app = builder.Build();

app.MapGet("/", () => "ok");

app.Run();
```

That single change is usually enough. Confirm it with the `--verbose` flag:

```bash
dotnet ef migrations add Init --verbose
```

You should see lines like `Finding design-time services...`, `Using application service provider from Microsoft.Extensions.Hosting.IHostBuilder.`, and `Using DbContext factory 'AppDbContext'.` If `--verbose` reports `No host builder was found`, path 2 is still broken and you need fix 2 or fix 3.

If you genuinely need a `--migrate-only` switch (a console runner that exits before `app.Run()` in production), gate it after the host is built but **return the host** instead of the void, so the synthesized `Main` still ends with the host reference:

```csharp
// Program.cs - .NET 11
var app = builder.Build();
app.MapGet("/", () => "ok");

if (args.Contains("--migrate-only"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}

app.Run();
```

The design-time tool still sees `app.Run()` as the terminal statement and can probe `app.Services` before invoking it.

## Fix 2 - point at the right startup project

A solution with a `Web` project that references a `Data` class library is the second most common cause. People run `dotnet ef migrations add Init` from inside `Data/`, where the `DbContext` lives, expecting the tool to use the host registered in `Web`. It will not. The tool builds the **current** project (or whatever `--project` says) and looks for a host inside **that** assembly.

```bash
# Run from the solution root, EF Core 11.0.0-preview.4 / .NET 11
dotnet ef migrations add Init \
  --project src/Data/Data.csproj \
  --startup-project src/Web/Web.csproj
```

`--project` is where the migration files are written. `--startup-project` is where the host lives. Both flags are required when they are not the same project. Many teams alias this in `Directory.Build.props` or a `Makefile` so the long invocation never needs to be typed again.

You can verify what assembly the tool actually loaded with `dotnet ef dbcontext info --startup-project src/Web/Web.csproj`. It prints the resolved type name, provider, and connection string source. If `info` works but `migrations add` fails, you have a constructor problem, not a discovery problem - jump to fix 3.

## Fix 3 - implement IDesignTimeDbContextFactory

For class libraries with no host (the typical layout for a packaged data layer, a test project, or a Blazor WebAssembly hosted shared project), there is no `Program.Main` to probe. Add a factory in the same project as the `DbContext`:

```csharp
// DesignTimeDbContextFactory.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlServer("Server=(localdb)\\MSSQLLocalDB;Database=design-time;Trusted_Connection=True;TrustServerCertificate=True")
            .Options;

        return new AppDbContext(options, new DesignTimeTenantResolver());
    }

    private sealed class DesignTimeTenantResolver : ITenantResolver
    {
        public string Current => "design-time";
    }
}
```

EF Core's discovery checks for `IDesignTimeDbContextFactory<TContext>` **before** it walks the host, so this implementation also overrides anything else. That makes it the most reliable fix, but it has a cost: the connection string is duplicated. Read it from `appsettings.json` if you want to avoid that:

```csharp
// EF Core 11.0.0-preview.4 - read connection string from config
public AppDbContext CreateDbContext(string[] args)
{
    var config = new ConfigurationBuilder()
        .SetBasePath(Directory.GetCurrentDirectory())
        .AddJsonFile("appsettings.json", optional: false)
        .AddJsonFile($"appsettings.{Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? "Development"}.json", optional: true)
        .AddEnvironmentVariables()
        .Build();

    var options = new DbContextOptionsBuilder<AppDbContext>()
        .UseSqlServer(config.GetConnectionString("Default"))
        .Options;

    return new AppDbContext(options, new DesignTimeTenantResolver());
}
```

A reminder on file copy: `appsettings.json` must be set to `Copy if newer` in the project that runs the tool, or the working directory will not contain it. If you get past the discovery error and land on a `null` connection string instead, that is the same trap covered in the canonical write-up of [the No connection string named DefaultConnection error](/2026/05/fix-no-connection-string-named-defaultconnection/).

## Fix 4 - the args contract trap

If you already have a design-time factory and you still see the error in CI, check the `args` parameter. The EF Core tool passes its own argument list into `CreateDbContext(string[] args)`. Code that mistakes those for the application's `args` and rejects unknown flags will throw before the context is returned. The tool then reports the throw as the discovery failure:

```csharp
// Wrong - throws on EF Core's own args
public AppDbContext CreateDbContext(string[] args)
{
    if (args.Length != 2) throw new ArgumentException("expected env and db");
    ...
}
```

Either remove the validation, or accept that design-time `args` is opaque and key off `Environment.GetEnvironmentVariable` instead.

## Gotchas that look like this error but are not

- **`Could not load file or assembly 'Microsoft.EntityFrameworkCore.Design'`**. You forgot to add the `Microsoft.EntityFrameworkCore.Design` package to the startup project. It must be referenced there even if the `DbContext` lives elsewhere, because the tool loads it from the startup assembly's bin folder.
- **`No project was found`**. You ran `dotnet ef` from a folder with no `.csproj`. Run from the project root, or pass `--project`.
- **`The command 'dotnet-ef' could not be found`**. The local tool manifest is missing. Run `dotnet new tool-manifest` and `dotnet tool install dotnet-ef --version 11.0.0-preview.4`. Pinning the version matters: a global `dotnet-ef` installed years ago will silently mismatch the runtime.
- **`Cannot consume scoped service from singleton`**. The discovery worked, but DI registration is wrong. That is a different error and the [scoped vs singleton lifetime fix](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) covers it.
- **`A second operation was started on this context instance`**. Also a different error, but EF Core users find it through the same search rabbit hole. The [DbContext concurrency post](/2026/05/fix-second-operation-was-started-on-this-context-instance/) walks through it.

## A debugging checklist when none of the fixes land

If you tried all four and the tool still cannot find your context, walk this checklist in order. It is the same list the EF Core team's triage label "design-time" recommends on GitHub.

1. `dotnet build` succeeds with no warnings about missing assemblies. The tool runs against your build output, so a green build is a precondition.
2. `dotnet ef dbcontext list --startup-project src/Web/Web.csproj` prints your context name. If this fails too, the assembly never loaded a context. Likely missing `AddDbContext`.
3. `dotnet ef dbcontext info` prints the provider and connection string. If this succeeds but `migrations add` fails, your `DbContext` constructor throws when actually invoked. Add logging to it.
4. The startup project's `TargetFramework` matches the `dotnet-ef` tool's runtime. EF Core 11 tools target .NET 11. They cannot probe a project targeting `netstandard2.0` only.
5. The startup project has both `Microsoft.EntityFrameworkCore.Design` and the provider package (`Microsoft.EntityFrameworkCore.SqlServer`, `Npgsql.EntityFrameworkCore.PostgreSQL`, etc.) referenced.
6. `Program.cs` is the entry point. If you have multiple `Main` methods or use `OutputType` settings that hide it, the discovery fails.

Once `dotnet ef dbcontext info` works end to end, every other command will work. That is the single best smoke test, and it is faster than running a real migration.

## Related

- The [single-step migration workflow in EF Core 11](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) covers `dotnet ef migrations update --add`, the new combined command introduced for routine schema bumps.
- For DI scope errors at runtime, see [the scoped service from singleton fix](/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- If `GetConnectionString` returns null at design time, see [the missing connection string post](/2026/05/fix-no-connection-string-named-defaultconnection/).
- For testing the data layer without hitting design-time discovery at all, [integration tests with Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) keeps the test project independent of the migration toolchain.
- For warming model creation before the first request, [warming up the EF Core model](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) covers the related cold-path problem.

## Sources

- [Design-time DbContext Creation - EF Core docs](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation)
- [EF Core Tools Reference - dotnet ef](https://learn.microsoft.com/en-us/ef/core/cli/dotnet)
- [HostFactoryResolver source on dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting/src/Internal/HostFactoryResolver.cs)
- [EF Core issue 21025: design-time discovery on top-level statements](https://github.com/dotnet/efcore/issues/21025)
- [WebApplication and the generic host - ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis)
