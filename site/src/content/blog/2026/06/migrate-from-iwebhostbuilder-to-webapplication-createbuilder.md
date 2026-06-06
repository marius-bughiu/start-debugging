---
title: "Migrate from IWebHostBuilder to WebApplication.CreateBuilder in .NET 11"
description: "A step-by-step migration from the old Startup.cs plus WebHostBuilder hosting model to the minimal hosting model with WebApplication.CreateBuilder, including the ASPDEPR008 deprecation, middleware ordering, IStartupFilter, and how to keep your tests working."
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "aspnetcore-11"
  - "dotnet-11"
  - "minimal-hosting"
---

If your `Program.cs` still calls `Host.CreateDefaultBuilder(args).ConfigureWebHostDefaults(web => web.UseStartup<Startup>())`, you are running the legacy hosting model and the compiler has started warning you about it. As of .NET 10, `WebHost`, `WebHostBuilder`, and `IWebHost` are marked obsolete with diagnostic `ASPDEPR008`, and that deprecation carries into .NET 11. The replacement is the minimal hosting model built around `WebApplication.CreateBuilder(args)`, which has been the default in every project template since ASP.NET Core 6.0. This post migrates a `Startup`-based app to minimal hosting using `net11.0` as the target, covering the bits that actually trip people up: middleware ordering, the lost DI scope at startup, `IStartupFilter`, and keeping `WebApplicationFactory` tests green.

The migration is mechanical for a small service (an hour or two) and a half-day for a monolith with custom middleware, `IStartupFilter` implementations, and a large `ConfigureServices`. Nothing about your application's behavior has to change. You are moving the same registrations and the same middleware pipeline into a flatter file. The one real semantic difference is the startup DI scope, covered below.

## Why migrate now

- `WebHost` / `WebHostBuilder` / `IWebHost` emit `ASPDEPR008` build warnings as of .NET 10. If you build with `TreatWarningsAsErrors`, your .NET 11 upgrade will fail to compile until you move off them.
- The minimal hosting model is where all new ASP.NET Core investment lands. Features like Native AOT for minimal APIs, the slimmed-down `WebApplication.CreateSlimBuilder`, and `CreateEmptyBuilder` only exist on the new path.
- Two bootstrap files collapse into one. `Startup.cs` plus a `CreateHostBuilder` plumbing method becomes a single readable `Program.cs`, and configuration, services, and the pipeline read top to bottom.
- It unblocks minimal APIs. You cannot cleanly call `app.MapGet(...)` in a codebase whose pipeline lives inside a `Startup.Configure(IApplicationBuilder, IWebHostEnvironment)` signature.

## What breaks

| Area                       | Change                                                                                       | Severity |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| `WebHost` / `IWebHost`     | Obsolete as of .NET 10 (`ASPDEPR008`). Warnings, or errors under `TreatWarningsAsErrors`     | high     |
| `Startup` via `builder.Host`| `WebApplicationBuilder.Host.ConfigureWebHostDefaults(...UseStartup<T>())` throws at runtime  | high     |
| Startup DI scope           | No scope around the service provider during startup; resolving scoped services now throws    | medium   |
| Middleware ordering        | `Configure` body must be re-expressed after `builder.Build()`, in the same order             | medium   |
| `IStartupFilter`           | Still runs, but now executes around the minimal-hosting pipeline; verify ordering            | low      |
| `IHostingStartup`          | Still supported, but reads `WebApplicationBuilder` differently for some assemblies           | low      |
| `IWebHostBuilder` (interface)| Survives via `builder.WebHost` for narrow config (`UseKestrel`, `UseUrls`); not gone        | low      |

Note the last row. The `IWebHostBuilder` *interface* is not deleted. `WebApplicationBuilder` exposes it as `builder.WebHost` so you can still call `builder.WebHost.ConfigureKestrel(...)`. What is deprecated is the standalone `WebHost.CreateDefaultBuilder()` bootstrap and the `IWebHost` it builds. The migration target is `WebApplication.CreateBuilder`, not the removal of every type with `WebHost` in its name.

## Pre-flight checklist

1. Install the .NET 11 SDK on every dev machine and CI runner. Verify with `dotnet --list-sdks` and confirm `11.0.x` appears.
2. Confirm the project already targets `net6.0` or later. The minimal hosting model does not exist before .NET 6, so a .NET 5 or earlier app needs a framework bump first. See the [.NET 8 to .NET 11 checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) if you are also crossing LTS versions, or the [.NET Framework 4.8 to .NET 11 guide](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) for the larger jump.
3. Inventory your `Startup` class. List every line in `ConfigureServices` and every middleware call in `Configure`, in order. The order in `Configure` is the contract you must preserve.
4. Grep for `IStartupFilter` implementations and `IHostingStartup` assemblies. These run outside `Startup` and are easy to forget.
5. Commit a clean baseline so you have a one-command rollback.

## The before: a Startup-based app

Here is the shape almost every pre-6.0 app shares. Two files, with the host wiring split from the service and pipeline configuration.

```csharp
// Program.cs -- legacy generic host, ASP.NET Core 3.1 / 5.0 style
// Builds with ASPDEPR008 warnings on .NET 10/11 if WebHost APIs are used
public class Program
{
    public static void Main(string[] args) =>
        CreateHostBuilder(args).Build().Run();

    public static IHostBuilder CreateHostBuilder(string[] args) =>
        Host.CreateDefaultBuilder(args)
            .ConfigureWebHostDefaults(webBuilder =>
            {
                webBuilder.UseStartup<Startup>();
            });
}
```

```csharp
// Startup.cs -- legacy services + pipeline split
public class Startup
{
    public Startup(IConfiguration configuration) => Configuration = configuration;

    public IConfiguration Configuration { get; }

    public void ConfigureServices(IServiceCollection services)
    {
        services.AddControllers();
        services.AddDbContext<AppDbContext>(o =>
            o.UseSqlServer(Configuration.GetConnectionString("DefaultConnection")));
        services.AddScoped<IOrderService, OrderService>();
        services.AddSwaggerGen();
    }

    public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
    {
        if (env.IsDevelopment())
        {
            app.UseDeveloperExceptionPage();
            app.UseSwagger();
            app.UseSwaggerUI();
        }

        app.UseHttpsRedirection();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseEndpoints(endpoints => endpoints.MapControllers());
    }
}
```

## Migration steps

### 1. Move ConfigureServices into the builder

Create the builder, then copy every line from `Startup.ConfigureServices` verbatim, replacing `services` with `builder.Services`. `IConfiguration` is available as `builder.Configuration`, so the connection-string lookup carries over unchanged.

```csharp
// Program.cs -- .NET 11, minimal hosting model
var builder = WebApplication.CreateBuilder(args);

// formerly Startup.ConfigureServices, services -> builder.Services
builder.Services.AddControllers();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection")));
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddSwaggerGen();
```

Verify: run `dotnet build`. The project should compile with the service registrations in place, before you touch the pipeline. If a registration fails to resolve `builder.Configuration`, you copied a `Configuration` field reference that no longer exists; swap it for `builder.Configuration`.

### 2. Build the app and re-express the pipeline in the same order

Call `builder.Build()`, then translate `Startup.Configure` line for line. `IApplicationBuilder app` becomes the `WebApplication app`, and `env.IsDevelopment()` becomes `app.Environment.IsDevelopment()`. The middleware order must match the original exactly, because order is the pipeline.

```csharp
// .NET 11, minimal hosting model -- continued
var app = builder.Build();

// formerly Startup.Configure, same order
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
```

Two things shrank. `UseRouting` and `UseEndpoints` are no longer required: the minimal host adds routing middleware automatically, and `app.MapControllers()` replaces the `UseEndpoints(e => e.MapControllers())` block. If you have middleware that must run *between* routing and endpoint execution (for example, a custom middleware that reads the matched endpoint metadata), keep an explicit `app.UseRouting()` call and place that middleware after it. Otherwise drop both.

Verify: `dotnet run`, then hit a known route. A 200 on a controller action confirms the pipeline is wired. A 404 on every route usually means `MapControllers` is missing or sits before a terminal middleware.

### 3. Delete Startup.cs and the CreateHostBuilder plumbing

Once `Program.cs` holds everything, delete `Startup.cs` and the old `CreateHostBuilder` method. Do not try to keep `Startup` alive by calling `builder.Host.ConfigureWebHostDefaults(web => web.UseStartup<Startup>())`. That throws at runtime: minimal hosting forbids configuring the web host through `builder.Host` or `builder.WebHost` once you are on `WebApplicationBuilder`.

If you cannot delete `Startup` in one pass (a giant `ConfigureServices` you want to migrate incrementally), the bridge pattern is to instantiate it manually rather than route it through the host:

```csharp
// .NET 11 -- temporary bridge, not the WebApplicationBuilder.Host path
var builder = WebApplication.CreateBuilder(args);
var startup = new Startup(builder.Configuration);
startup.ConfigureServices(builder.Services);

var app = builder.Build();
startup.Configure(app, app.Environment); // Configure must accept IApplicationBuilder
app.Run();
```

This compiles because `WebApplication` implements `IApplicationBuilder` and `IEndpointRouteBuilder`. Treat it as scaffolding for a single PR, not a destination.

Verify: search the solution for `UseStartup`, `WebHost.CreateDefaultBuilder`, and `ConfigureWebHostDefaults`. Zero hits means the legacy bootstrap is gone and `ASPDEPR008` will not fire.

### 4. Move host and Kestrel configuration onto the builder

Anything you configured on the old `IWebHostBuilder` (Kestrel limits, URLs, content root) moves onto `builder.WebHost`, which still exposes the `IWebHostBuilder` surface. Generic-host concerns (logging, the Serilog integration, `UseWindowsService`) move onto `builder.Host`.

```csharp
// .NET 11 -- host/web host configuration on the new builder
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 50 * 1024 * 1024);
builder.Host.UseSerilog((ctx, cfg) => cfg.ReadFrom.Configuration(ctx.Configuration));
```

Verify: confirm the configured limit takes effect (a request body over the limit returns `413`), and that your logging sink still receives entries.

## Verification

Run this checklist after the migration before you merge:

- `dotnet build` produces zero `ASPDEPR008` warnings and zero `UseStartup` references.
- `dotnet run` starts and serves a known route with the expected status code.
- `dotnet test` passes, including any `WebApplicationFactory` integration tests (see the gotcha below).
- Middleware-dependent behavior still works end to end: authentication challenges, HTTPS redirect, CORS preflight, exception-handler responses.
- A request body over your Kestrel limit still returns `413`, confirming host config migrated.

## Rollback plan

This migration is reversible until you delete `Startup.cs`. The safe sequence is to do steps 1 and 2 on a branch, confirm tests pass, and only then delete the legacy files in a separate commit. If something regresses after the delete, `git revert` the delete commit to restore `Startup.cs` and the old `Program.cs`. Because the `Startup` pattern still runs on .NET 11 (it only warns, it is not removed), a temporary revert keeps you shipping while you debug. The point of no return is removing the generic-host bootstrap entirely; keep that in its own commit.

## Gotchas we hit

**The startup DI scope is gone.** The old generic host created a DI scope while building the service provider, so code that resolved a scoped service during startup happened to work. Minimal hosting does not. If you resolved a `DbContext` in `Configure` to run a migration or seed step, you now get `Cannot resolve scoped service '...' from root provider`. Wrap startup work in an explicit scope:

```csharp
// .NET 11 -- explicit scope for startup-time scoped resolution
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}
app.Run();
```

This is the single most common runtime break in the migration. The general rule and its variants are covered in [resolving scoped services from a singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) and in [using scoped services inside a BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

**`WebApplicationFactory<TStartup>` no longer has a `Startup` to point at.** Integration tests that referenced `WebApplicationFactory<Startup>` need a new entry-point type. The minimal host's entry point is the auto-generated `Program` class, but it is `internal`, so the test project cannot see it. Expose it by adding a partial declaration at the bottom of `Program.cs`:

```csharp
// Program.cs -- end of file, .NET 11
public partial class Program { }
```

Then change the test factory to `WebApplicationFactory<Program>`. Without the partial declaration you get `'Program' is inaccessible due to its protection level` in the test project.

**`IStartupFilter` still runs, but the order shifts.** Filters registered via `services.AddTransient<IStartupFilter, MyFilter>()` continue to execute, wrapping the configured pipeline. With minimal hosting there is no explicit `Configure` method for them to wrap, so a filter that assumed it ran before your routing setup may now run in a slightly different position. If you used `IStartupFilter` purely to inject middleware from a library, audit where that middleware lands relative to your `app.Use...` calls and reorder if a request behaves differently.

**Middleware that reads the matched endpoint needs explicit `UseRouting`.** Dropping `UseRouting` is fine for the common case, but if you have middleware calling `context.GetEndpoint()`, it must sit after routing has run. Re-add `app.UseRouting()` before that middleware and keep `app.MapControllers()` after it. For a deeper comparison of the two endpoint styles, see [minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/).

**Order-dependent registration of named options.** A handful of teams relied on `ConfigureServices` running before a library's `IHostingStartup`. The minimal host evaluates `builder.Services` eagerly at `builder.Build()`, so if you registered a service after calling a library extension that captured the collection, the timing can differ. This is rare, but if a configured option comes back null after the migration, check whether you registered it after the consuming `Add...` call.

Once you are on `WebApplication.CreateBuilder`, the rest of the modern surface opens up: minimal API endpoints alongside your controllers, `CreateSlimBuilder` for Native AOT, and the cleaner exception handling shown in [adding a global exception handler in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/). The hosting migration is the gate; everything else is incremental from there.

## Sources

- [WebHostBuilder, IWebHost, and WebHost are obsolete](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/webhostbuilder-deprecated) (.NET breaking changes, diagnostic `ASPDEPR008`)
- [Migrate from ASP.NET Core in .NET 5 to .NET 6](https://learn.microsoft.com/en-us/aspnet/core/migration/50-to-60) (the original minimal-hosting migration guide)
- [Code samples migrated to the new minimal hosting model](https://learn.microsoft.com/en-us/aspnet/core/migration/50-to-60-samples) (before/after `Startup` examples)
- [Deprecating WebHostBuilder, IWebHost, and WebHost](https://github.com/dotnet/aspnetcore/discussions/63480) (dotnet/aspnetcore discussion #63480)
