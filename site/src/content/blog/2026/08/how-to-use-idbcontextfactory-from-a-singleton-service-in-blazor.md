---
title: "How to use IDbContextFactory<T> from a singleton service in Blazor"
description: "A singleton cannot inject a DbContext, but it can inject IDbContextFactory<T>, because AddDbContextFactory registers the factory as a singleton by default. Create and dispose one context per call, never cache the instance."
pubDate: 2026-08-16
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "ef-core"
  - "dependency-injection"
---

A singleton service cannot take a `DbContext` in its constructor: `AddDbContext<T>` registers the context as scoped, and ASP.NET Core's scope validator rejects the capture at startup. It can take `IDbContextFactory<T>`, because `AddDbContextFactory<T>` registers the factory as a **singleton** by default. Inject the factory, call `CreateDbContextAsync` inside each method, wrap it in `await using`, and never store the returned context in a field. That last rule is the whole game: a singleton in Blazor is shared by every circuit on the server, so a cached context gets hit by several users at once and EF Core corrupts or throws.

This guide is written against .NET 11 and EF Core 11. Everything here also applies unchanged to .NET 6, 8, and 10, because `IDbContextFactory<T>` has had the same registration shape since EF Core 5.0. The registration dumps and error messages below were produced on the .NET 10.0.201 SDK with `Microsoft.EntityFrameworkCore.Sqlite` 10.0.11, since that is the runtime I had installed when writing this.

## Why a Blazor singleton is the hostile case for DbContext

Server-side Blazor keeps a *circuit* per connected user. That circuit is one long-lived DI scope that lives as long as the browser tab, not as long as an HTTP request. Microsoft's own EF Core guidance for Blazor calls out all three standard lifetimes as wrong for a `DbContext`: singleton shares one instance across every user, scoped shares one instance across every component in a single user's circuit, and transient produces contexts that live as long as the component holding them.

A singleton is the worst of the three, and it is easy to end up with one by accident. A catalog cache, a lookup-table service, a `IHostedService` that refreshes reference data, an `IEmailSender` that stamps an audit row: all of these are naturally singletons, all of them want database access, and none of them can hold a `DbContext`.

Scope validation catches the naive version at startup. Registering the context normally and injecting it into a singleton fails `BuildServiceProvider` with `ValidateOnBuild`:

```text
Error while validating the service descriptor 'ServiceType: BadWarmer Lifetime: Singleton
ImplementationType: BadWarmer': Cannot consume scoped service 'AppDb' from singleton 'BadWarmer'.
```

That is the same captive-dependency check that produces the [cannot consume scoped service from singleton error](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) in plain ASP.NET Core apps. The factory is the sanctioned way out.

## What AddDbContextFactory actually registers

The reason a singleton can inject the factory is not convention, it is the declared default. The signature is:

```csharp
// EF Core 11, Microsoft.Extensions.DependencyInjection
public static IServiceCollection AddDbContextFactory<TContext>(
    this IServiceCollection serviceCollection,
    Action<DbContextOptionsBuilder>? optionsAction = null,
    ServiceLifetime lifetime = ServiceLifetime.Singleton)
    where TContext : DbContext;
```

`lifetime` defaults to `ServiceLifetime.Singleton`, and it controls "the lifetime with which to register the factory **and options**". Dumping the service descriptors that a single `AddDbContextFactory<AppDb>` call adds makes the shape concrete:

```text
Singleton  Microsoft.EntityFrameworkCore.DbContextOptions`1[AppDb]
Singleton  Microsoft.EntityFrameworkCore.DbContextOptions
Singleton  Microsoft.EntityFrameworkCore.Internal.IDbContextFactorySource`1[AppDb]
Singleton  Microsoft.EntityFrameworkCore.IDbContextFactory`1[AppDb]
Scoped     AppDb
```

Two things are worth noticing.

First, `IDbContextFactory<AppDb>` is a singleton, so injecting it into your own singleton passes scope validation cleanly. The concrete implementation resolved is EF Core's built-in `DbContextFactory<TContext>`.

Second, and this surprises people: `AddDbContextFactory` **also registers the context type itself as scoped**. That is documented behaviour, not a leak. The API remarks say it plainly: "For convenience, this method also registers the context type itself as a scoped service. This allows a context instance to be resolved from a dependency injection scope directly or created by the factory, as appropriate." So after one `AddDbContextFactory` call, `@inject AppDb Db` still compiles and still works in a component. It is a trap in Blazor, because that scoped instance is circuit-scoped and shared by every component in the tab. Registering the factory does not stop anyone from injecting the context the wrong way.

## Wire it up in four steps

1. Register the factory in `Program.cs` and leave the lifetime at its default. Do not pass `ServiceLifetime.Scoped`, which is the single most common way to break this.

   ```csharp
   // .NET 11, EF Core 11
   builder.Services.AddDbContextFactory<CatalogDb>(options =>
       options.UseSqlServer(builder.Configuration.GetConnectionString("Catalog")));

   builder.Services.AddSingleton<CatalogCache>();
   ```

2. Expose the `DbContextOptions<TContext>` constructor on the context, exactly as you would for `AddDbContext`. The factory passes options through this constructor, so a context with only a parameterless constructor will fail to be created.

   ```csharp
   public sealed class CatalogDb(DbContextOptions<CatalogDb> options) : DbContext(options)
   {
       public DbSet<Product> Products => Set<Product>();
   }
   ```

3. Inject `IDbContextFactory<TContext>` into the singleton and create one context per method call. Use `CreateDbContextAsync` and `await using` so async disposal runs on the provider's own path.

   ```csharp
   public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
   {
       public async Task<List<Product>> GetActiveAsync(CancellationToken ct = default)
       {
           await using var db = await factory.CreateDbContextAsync(ct);
           return await db.Products
               .AsNoTracking()
               .Where(p => p.IsActive)
               .ToListAsync(ct);
       }
   }
   ```

4. Turn on scope validation in every environment so a future refactor that reintroduces a captive `DbContext` fails at startup rather than at 3am under load.

   ```csharp
   builder.Host.UseDefaultServiceProvider(options =>
   {
       options.ValidateScopes = true;
       options.ValidateOnBuild = true;
   });
   ```

The contexts the factory hands you are **not** owned by the DI container. The EF Core documentation is explicit that instances created this way "are not managed by the application's service provider and therefore must be disposed by the application". The `await using` in step 3 is not optional politeness; without it you leak connections for the life of the process.

## What actually breaks when you cache the context

The tempting shortcut is to create one context in the singleton's constructor and reuse it. It looks harmless in development, where you are the only user. Here is the same `CatalogCache` holding a single context, hit by 25 concurrent callers on real threads:

```csharp
// Do not do this. One context, shared by every circuit on the server.
public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
{
    private readonly CatalogDb _shared = factory.CreateDbContext();

    public Task<int> CountAsync() => _shared.Products.CountAsync();
}
```

Running that three times in a row on EF Core 10.0.11 produced three different outcomes, two of which were distinct exceptions:

```text
run 1: InvalidOperationException: A second operation was started on this context instance
       before a previous operation completed. This is usually caused by different threads
       concurrently using the same instance of DbContext.
run 2: InvalidOperationException: ExecuteReader can only be called when the connection is open.
run 3: InvalidOperationException: A second operation was started on this context instance ...
```

That nondeterminism is the point. EF Core's thread-safety detector produces the friendly first message when it wins the race, but it does not always win: the second run surfaced a raw ADO.NET connection-state failure instead, because two operations had already interleaved on the same connection. Under different timing the same bug silently returns wrong data rather than throwing at all. Earlier in my testing, 25 tasks that happened to complete synchronously all returned the correct answer and threw nothing, which is exactly why this bug reaches production.

Swapping to one context per call, the same 25 concurrent callers all succeeded with identical results. That is not clever code, it is just the [single-unit-of-work rule](/2026/05/fix-second-operation-was-started-on-this-context-instance/) applied honestly.

The same reasoning explains why capturing a context into a detached task produces [ObjectDisposedException on a disposed context instance](/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/): both bugs come from letting a context outlive the operation that needed it.

## The overload that quietly breaks the pattern

`AddDbContextFactory` takes an optional `lifetime`. Passing `ServiceLifetime.Scoped` is a popular piece of copy-paste advice, usually inherited from a multi-tenant sample where the connection string is resolved per request. It changes the factory registration and reintroduces exactly the captive dependency you were avoiding:

```csharp
// This compiles, then fails at startup once a singleton consumes the factory.
builder.Services.AddDbContextFactory<CatalogDb>(
    options => options.UseSqlServer(connectionString),
    lifetime: ServiceLifetime.Scoped);
```

```text
Error while validating the service descriptor 'ServiceType: CacheWarmer Lifetime: Singleton
ImplementationType: CacheWarmer': Cannot consume scoped service
'Microsoft.EntityFrameworkCore.IDbContextFactory`1[AppDb]' from singleton 'CacheWarmer'.
```

If you genuinely need a per-circuit connection string, do not make the factory scoped and then consume it from a singleton. Keep the factory singleton and pass the tenant in explicitly, or resolve the tenant-specific factory through `IServiceScopeFactory` inside the method. Which leads to the real limitation of this whole pattern.

## A singleton has no circuit, so it has no user

This is the constraint people hit second, after they get the wiring right. A singleton is created once for the whole server. It has no `AuthenticationStateProvider`, no circuit-scoped tenant resolver, no `HttpContext`. Any `DbContextOptions` computed from the ambient user simply do not exist at the moment your singleton runs.

Concretely, this does not work:

```csharp
// The singleton has no circuit, so there is no current user to read here.
builder.Services.AddDbContextFactory<CatalogDb>((sp, options) =>
    options.UseSqlServer(sp.GetRequiredService<ITenantContext>().ConnectionString));
```

If the data your singleton touches is genuinely per-user, the singleton is the wrong home for it. Either move the work into a scoped service that the component calls, or pass the tenant identity in as a method parameter and select the connection string yourself:

```csharp
public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
{
    public async Task<int> CountForAsync(string tenantId, CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Products.CountAsync(p => p.TenantId == tenantId, ct);
    }
}
```

Reference data, lookup tables, and cross-tenant aggregates are the right fit for a singleton plus a factory. Anything keyed to "the current user" is not. If you are reaching for a singleton mainly to avoid repeated queries, a cache is the better primitive, and [HybridCache versus IMemoryCache and IDistributedCache](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) covers picking one.

## When to reach for the pooled factory instead

`AddPooledDbContextFactory<TContext>` registers a singleton `IDbContextFactory<TContext>` too, backed by `PooledDbContextFactory<TContext>`, with a `poolSize` that defaults to 1024 in EF Core 6 and later (it was 128 in EF Core 5.0). Disposing a pooled context resets it and returns it to the pool rather than throwing it away, which measurably cuts allocation on hot paths.

Verified behaviour on EF Core 10.0.11: creating a context, disposing it, and creating another returns the **same** instance, and touching the first one after disposal throws `ObjectDisposedException`. So the pool is genuinely recycling, and use-after-dispose is still caught.

Two caveats before you switch:

- The pooled overloads take no `lifetime` parameter, and `optionsAction` is required rather than optional. Configuration must be done externally, because `OnConfiguring` is not called on pooled contexts at all.
- Pooled contexts cannot take arbitrary injected services in their constructor, since the instance is reused across unrelated operations. Any state you stash on the context survives into the next caller unless EF Core resets it.

For a singleton doing high-frequency short reads, the pooled factory is the better default. For a singleton doing occasional work, the plain factory is simpler and the allocation difference will not show up in a profile. If the queries themselves are the hot path rather than the context construction, [compiled queries for EF Core hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) is the bigger lever.

## Render modes, WebAssembly, and hosted services

Three edge cases worth naming, because they change where the singleton lives.

**Interactive WebAssembly and Auto render modes.** A singleton registered in the server project's `Program.cs` exists on the server only. Components running on the client have their own service provider in the WebAssembly project, and a `DbContext` cannot open a database connection from the browser sandbox at all. If a component moves from interactive server to interactive WebAssembly, the singleton it depended on silently stops being resolvable client-side. That boundary is the same one behind the [Blazor static-to-interactive state problem](/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/).

**Static SSR and prerendering.** During static server-side rendering there is no circuit, but the app's root provider still exists, so a singleton with a factory works normally. This is one of the few database patterns that behaves identically across static SSR, prerender, and interactive server rendering, which is a real argument for it.

**BackgroundService.** `AddHostedService<T>` registers a singleton, so a hosted service that needs data has exactly the same problem and exactly the same solution. Inject `IDbContextFactory<T>` when the work is pure data access; reach for `IServiceScopeFactory` when the unit of work needs several scoped services together, which is covered in [using scoped services inside a BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

The pattern is small enough to state in one line: singletons may hold factories, never contexts. Everything else in this post is a consequence of that.

## Sources

- [DbContext Lifetime, Configuration, and Initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), EF Core documentation, on `AddDbContextFactory` and unmanaged context disposal.
- [ASP.NET Core Blazor with Entity Framework Core](https://learn.microsoft.com/en-us/aspnet/core/blazor/blazor-ef-core), on circuits and why singleton, scoped, and transient are all inappropriate for a `DbContext`.
- [EntityFrameworkServiceCollectionExtensions.AddDbContextFactory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.adddbcontextfactory), for the `ServiceLifetime.Singleton` default and the scoped context-type registration.
- [EntityFrameworkServiceCollectionExtensions.AddPooledDbContextFactory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.addpooleddbcontextfactory), for the `poolSize` default and the `OnConfiguring` caveat.
