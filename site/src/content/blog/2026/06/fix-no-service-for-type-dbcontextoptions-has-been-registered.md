---
title: "Fix: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered"
description: "EF Core throws this when AddDbContext never ran, ran after Build, or your context's constructor takes the wrong DbContextOptions. Register before Build and use DbContextOptions<YourContext>."
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "dependency-injection"
---

The fix: the dependency injection container was asked for `DbContextOptions` while building your `DbContext`, and it had nothing to hand back. In almost every case that means `AddDbContext<YourContext>(...)` was never called, was called after `builder.Build()`, lives in a `ConfigureServices` method that no longer runs, or your context's constructor declares a parameter the container does not register. Add `builder.Services.AddDbContext<YourContext>(...)` before `Build()`, and give the constructor a `DbContextOptions<YourContext>` parameter, not the non-generic `DbContextOptions`.

```text
System.InvalidOperationException: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered.
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService[T](IServiceProvider provider)
```

You may also see the same root cause through the activation path, with the generic backtick form of the type name:

```text
System.InvalidOperationException: Unable to resolve service for type 'Microsoft.EntityFrameworkCore.DbContextOptions`1[MyApp.Data.AppDbContext]' while attempting to activate 'MyApp.Data.AppDbContext'.
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.GetService(...)
```

This guide is written against .NET 11, EF Core 11.0.0 (`Microsoft.EntityFrameworkCore` 11.0.0), and `Microsoft.Extensions.DependencyInjection` 11.0.0. The behaviour described here has been stable since EF Core 3.0, so the fixes apply cleanly to EF Core 6, 8, and 10 as well.

## The two message shapes are the same bug

.NET's container emits two different sentences for one underlying failure, and which one you get depends on how the resolution started:

- `No service for type 'X' has been registered.` comes from `GetRequiredService<X>()`. Something asked the provider for `X` directly and `X` was not in the collection.
- `Unable to resolve service for type 'X' while attempting to activate 'Y'.` comes from `ActivatorUtilities`. The container was building `Y`, hit a constructor parameter of type `X`, and could not satisfy it.

In both cases here, `X` is `DbContextOptions` (or its generic `DbContextOptions<AppDbContext>`, which the runtime prints as ``DbContextOptions`1[AppDbContext]``). `Y`, when present, is your context. Read the type names before changing anything: the error is about the options object EF Core needs to configure the context, not about the context itself.

## What AddDbContext actually registers

Understanding the fix means understanding what `AddDbContext<TContext>` puts in the container. Internally it registers two things for the options (`Microsoft.EntityFrameworkCore.EntityFrameworkServiceCollectionExtensions`, the `AddCoreServices` method):

```csharp
// EF Core 11.0.0 - paraphrased from AddCoreServices
serviceCollection.TryAdd(
    new ServiceDescriptor(
        typeof(DbContextOptions<TContextImplementation>),
        CreateDbContextOptions<TContextImplementation>,
        optionsLifetime));

serviceCollection.Add(
    new ServiceDescriptor(
        typeof(DbContextOptions),
        p => p.GetRequiredService<DbContextOptions<TContextImplementation>>(),
        optionsLifetime));
```

Two facts fall out of this and explain every variant of the error:

1. The generic `DbContextOptions<TContext>` is the real registration. It is added with `TryAdd`, so the first call wins for that closed type.
2. The non-generic `DbContextOptions` is a forwarder added with `Add` (unconditional). It just calls `GetRequiredService<DbContextOptions<TContext>>()` under the hood. Because it is `Add`, not `TryAdd`, every `AddDbContext` call appends another forwarder, and when you resolve the non-generic `DbContextOptions` the **last one registered wins**.

So if you never call `AddDbContext`, neither registration exists, and asking for either form throws. And if you register two contexts but one takes the non-generic `DbContextOptions`, that context silently receives the other context's options. Both of those are covered below.

## Minimal repro

The smallest .NET 11 program that throws, by forgetting the registration entirely:

```csharp
// .NET 11, EF Core 11.0.0, Microsoft.AspNetCore.App 11.0.0
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// No builder.Services.AddDbContext<AppDbContext>(...) here.
builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();

public sealed class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
    public DbSet<Product> Products => Set<Product>();
}

public sealed class Product
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

[ApiController]
[Route("products")]
public sealed class ProductsController(AppDbContext db) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(db.Products.Count());
}
```

Hit `GET /products` and MVC asks the container to activate `ProductsController`, which needs an `AppDbContext`, which needs a `DbContextOptions<AppDbContext>`. Nothing registered it, so you get the activation form of the error. This is the exact shape you hit right after scaffolding a controller in Visual Studio against a context you have not wired into `Program.cs` yet.

## Fix one: register the context before the host is built

The answer the vast majority of the time. Add the registration in `Program.cs` and make sure it runs before `builder.Build()`:

```csharp
// .NET 11, EF Core 11.0.0
var connectionString = builder.Configuration.GetConnectionString("DefaultConnection")
    ?? throw new InvalidOperationException("Connection string 'DefaultConnection' not found.");

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(connectionString));

var app = builder.Build();
```

`builder.Build()` snapshots the service collection. Anything you add to `builder.Services` after that line is silently ignored by the running host, so this is wrong:

```csharp
// .NET 11 - bug: registration after Build is discarded
var app = builder.Build();
builder.Services.AddDbContext<AppDbContext>(options => options.UseSqlServer(cs)); // too late
app.Run();
```

If you are on the older `Startup` model, the registration belongs in `ConfigureServices`, and the classic version of this bug is a second `ConfigureServices` overload, or a commented-out `services.AddDbContext` line that someone disabled while debugging and never restored. Search the whole project for `AddDbContext` and confirm the call you find is actually on the code path the host runs.

If you build a `DbContext` outside the request pipeline, the same rule applies inside whatever provider you built. Resolving a scoped `DbContext` from the root provider, or before `app.Run()` without creating a scope, fails for the same reason:

```csharp
// .NET 11 - resolve a scoped DbContext correctly outside a request
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.MigrateAsync();
}
```

## Fix two: give the constructor a DbContextOptions<YourContext>

If the registration is present and you still hit the error, look at the constructor. EF Core's DI registration produces `DbContextOptions<AppDbContext>`, so that is the parameter the constructor should declare:

```csharp
// Right: generic, tied to this specific context type
public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
```

The non-generic version compiles and, with a single registered context, even works, because the forwarder described above resolves it. But it is fragile:

```csharp
// Risky: non-generic. Works with one context, breaks with two.
public AppDbContext(DbContextOptions options) : base(options) { }
```

The moment a second context is registered, both `AddDbContext` calls append a non-generic `DbContextOptions` forwarder, the last one wins, and your context is handed the wrong options, usually the wrong connection string or even the wrong database provider. The failure can surface as a `No service` error during a partial registration, or worse, as a context that quietly queries the wrong database. The Microsoft docs are explicit about this:

> Most `DbContext` subclasses that accept a `DbContextOptions` should use the generic `DbContextOptions<TContext>` variation. This ensures that the correct options for the specific `DbContext` subtype are resolved from dependency injection, even when multiple `DbContext` subtypes are registered.

There is one legitimate use of the non-generic form: a base class meant to be inherited from. The base takes a non-generic `DbContextOptions` so each concrete subclass can pass its own `DbContextOptions<TConcrete>`:

```csharp
// .NET 11, EF Core 11.0.0 - base class shared by several contexts
public abstract class AppDbContextBase : DbContext
{
    protected AppDbContextBase(DbContextOptions options) : base(options) { }
}

public sealed class CatalogDbContext : AppDbContextBase
{
    public CatalogDbContext(DbContextOptions<CatalogDbContext> options) : base(options) { }
}

public sealed class OrdersDbContext : AppDbContextBase
{
    public OrdersDbContext(DbContextOptions<OrdersDbContext> options) : base(options) { }
}
```

Each concrete context still exposes the generic constructor, so DI hands it the right options; the base only provides a constructor for the subclasses to chain to. A context that needs to be both instantiated directly and inherited from should expose both constructors, with the generic one public and the non-generic one protected.

## Fix three: design-time tools (migrations and scaffolding)

A distinct flavour of this error shows up only when you run `dotnet ef`:

```text
Unable to create a 'DbContext' of type ''. The exception 'Unable to resolve service for type
'Microsoft.EntityFrameworkCore.DbContextOptions`1[MyApp.Data.AppDbContext]' while attempting to
activate 'MyApp.Data.AppDbContext'.' was thrown while attempting to create an instance.
```

At design time there is no running web host, so EF Core cannot pull options out of your application's DI container. It tries to build the context anyway and fails on the options parameter. Two reliable fixes:

1. Let EF find your app's host. If your `DbContext` lives in the startup project and `Program.cs` calls `AddDbContext`, EF's tooling can use the app's service provider. Keep the design-time and runtime project the same, or pass `--startup-project`.
2. Provide an explicit factory. Implement `IDesignTimeDbContextFactory<TContext>` next to the context. EF discovers it automatically and uses it instead of guessing:

```csharp
// .NET 11, EF Core 11.0.0 - found automatically by dotnet ef
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

public sealed class AppDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=DesignTime;ConnectRetryCount=0")
            .Options;

        return new AppDbContext(options);
    }
}
```

The factory builds `DbContextOptions<AppDbContext>` by hand, so design-time commands never touch your application DI. This is the canonical fix when the context lives in a class library with no startup host of its own. For the broader version of that failure, see the dedicated walkthrough on [why `dotnet ef migrations add` reports "Unable to create an object of type DbContext"](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

## Constructing a context by hand

If you are not using DI at all, the non-generic `DbContextOptions` registration is irrelevant. Build the options yourself and pass them to the constructor:

```csharp
// .NET 11, EF Core 11.0.0 - no DI container involved
var options = new DbContextOptionsBuilder<AppDbContext>()
    .UseSqlServer(connectionString)
    .Options;

using var db = new AppDbContext(options);
```

This is the right shape for a console tool, a test, or a background utility that has no `IServiceProvider`. Note the builder is generic too: `DbContextOptionsBuilder<AppDbContext>` produces a `DbContextOptions<AppDbContext>`, which matches the generic constructor.

## Variants that land on this page by mistake

Several lookalikes search the same way but resolve differently:

- **`No connection string named 'DefaultConnection' could be found`.** The context registered fine; the connection string lookup failed. Different layer, different fix. See [the DefaultConnection connection-string error](/2026/05/fix-no-connection-string-named-defaultconnection/).
- **`Unable to resolve service for type 'X' while attempting to activate 'Y'`, where X is your own service, not `DbContextOptions`.** That is a plain missing registration in your code, not an EF Core wiring problem. See [the general resolve-service error](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- **`Cannot consume scoped service 'AppDbContext' from singleton 'Y'`.** The context is registered correctly; a singleton is capturing it. The fix is a scope, not a registration.
- **`A second operation was started on this context instance`.** The context resolved fine and is being shared across threads or awaited incorrectly.
- **`AddDbContextPool` and `AddDbContextFactory`.** Both register `DbContextOptions<TContext>` the same way `AddDbContext` does, so the constructor rule is identical: pooled contexts and factory-built contexts also require the generic `DbContextOptions<TContext>` parameter. If you are swapping the context out in tests through the pooled factory, see [removing a pooled DbContext factory for a test swap in EF Core 11](/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).

## Confirming the wiring in ten seconds

When the registration looks correct but the error persists, prove it from a scope instead of guessing:

```csharp
// .NET 11 - remove before commit
using (var scope = app.Services.CreateScope())
{
    var options = scope.ServiceProvider.GetService<DbContextOptions<AppDbContext>>();
    Console.WriteLine(options is null ? "OPTIONS NOT REGISTERED" : "options OK");

    var ctx = scope.ServiceProvider.GetService<AppDbContext>();
    Console.WriteLine(ctx is null ? "CONTEXT NOT REGISTERED" : ctx.GetType().FullName);
}
```

If the options line prints `OPTIONS NOT REGISTERED`, `AddDbContext` never ran on this provider, and you are in Fix one. If the options resolve but the context does not, the constructor parameter is wrong, and you are in Fix two. You can also turn on build-time validation so the host refuses to start with a broken graph rather than failing on the first request:

```csharp
// .NET 11
builder.Host.UseDefaultServiceProvider(o =>
{
    o.ValidateScopes = true;
    o.ValidateOnBuild = true;
});
```

`ValidateOnBuild` walks every registration once and fails fast, which turns a runtime 500 into a startup error you cannot miss. Pair the generic constructor with `AddDbContext` before `Build`, and the `DbContextOptions` error does not come back. For the patterns behind unit tests that construct contexts without DI at all, the companion piece on [mocking DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) covers the trade-offs.

## Sources

- Microsoft Learn, [DbContext Lifetime, Configuration, and Initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), including the `DbContextOptions` versus `DbContextOptions<TContext>` section.
- Microsoft Learn, [Design-time DbContext Creation](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation) and `IDesignTimeDbContextFactory<TContext>`.
- EF Core source, [`EntityFrameworkServiceCollectionExtensions.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Extensions/EntityFrameworkServiceCollectionExtensions.cs), where `AddCoreServices` registers the generic and non-generic options.
- dotnet/efcore issue [#32936](https://github.com/dotnet/efcore/issues/32936) on the design-time activation error and the factory fix.
