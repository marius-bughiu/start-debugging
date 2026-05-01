---
title: "How to write integration tests against a real SQL Server with Testcontainers"
description: "A complete guide to running ASP.NET Core integration tests against a real SQL Server 2022 using Testcontainers 4.11 and EF Core 11: WebApplicationFactory wiring, IAsyncLifetime, swapping the DbContext registration, applying migrations, parallelism, Ryuk cleanup, and CI gotchas."
pubDate: 2026-05-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "sql-server"
---

To run integration tests against a real SQL Server from a .NET 11 test project, install `Testcontainers.MsSql` 4.11.0, build a `WebApplicationFactory<Program>` that owns an `MsSqlContainer`, start the container in `IAsyncLifetime.InitializeAsync`, override the `DbContext` registration in `ConfigureWebHost` to point at `container.GetConnectionString()`, and apply migrations once before the first test. Use `IClassFixture<T>` so xUnit shares one container across the tests in a class. Pin the SQL Server image to a specific tag, default to `mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04`, and let Ryuk dispose the container if your process crashes. This guide is written against .NET 11 preview 3, C# 14, EF Core 11, xUnit 2.9, and Testcontainers 4.11. The pattern is unchanged on .NET 8, 9, and 10, only the package versions move.

## Why a real SQL Server, not the in-memory provider

EF Core ships an in-memory provider and a SQLite-in-memory option that both look like SQL Server until they don't. The in-memory provider has no relational behaviour at all: no transactions, no foreign-key enforcement, no `RowVersion` concurrency tokens, no SQL translation. SQLite is a real relational engine but uses a different SQL dialect, different identifier quoting, and a different decimal type. The exact issues you want integration tests to catch, such as a missing index, a unique constraint violation, a `nvarchar` truncation, or a `DateTime2` precision drop, are silently masked.

The official EF Core docs went so far as to add a "do not test against in-memory" warning years ago, and the team's recommended pattern in the [testing without your production database system](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) page is "spin up a real one in a container". Testcontainers makes that one method call. The tradeoff is the cold-start time of pulling and booting a SQL Server image (around 8 to 12 seconds on a warm Docker daemon), but every assertion you make after that is one your production engine actually evaluates.

## Pin the image, do not float

Before any code, settle on the image tag. The Testcontainers docs default to `mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04`, which is the right choice for the same reason you do not float `:latest` in production: a CI pipeline that worked yesterday has to work today. A new cumulative update is not a free upgrade in your test pipeline because each CU can change the optimiser, change `sys.dm_*` schemas, and bump the minimum patch level for tools like `sqlpackage`.

The `2022-CU14-ubuntu-22.04` image is roughly 1.6 GB compressed and the first pull on a fresh CI runner is the slowest part of the suite. Cache that layer in your CI: GitHub Actions has `docker/setup-buildx-action` with `cache-from`, Azure DevOps caches `~/.docker` for the same effect. After the first warm cache, pulls are around 2 seconds.

If you need SQL Server 2025 features (vector search, `JSON_CONTAINS`, see [SQL Server 2025 JSON contains in EF Core 11](/2026/04/efcore-11-json-contains-sql-server-2025/)), bump the tag to `2025-CU2-ubuntu-22.04`. Otherwise stay on 2022 because the developer image for 2022 is more widely tested by the Testcontainers maintainers.

## The packages you need

Three packages cover the happy path:

```xml
<!-- .NET 11, xUnit-based test project -->
<ItemGroup>
  <PackageReference Include="Testcontainers.MsSql" Version="4.11.0" />
  <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="9.0.0" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
</ItemGroup>
```

`Testcontainers.MsSql` brings in the core `Testcontainers` package and the `MsSqlBuilder`. `Microsoft.AspNetCore.Mvc.Testing` ships `WebApplicationFactory<TEntryPoint>`, which boots your full DI container and HTTP pipeline against a `TestServer`. `Microsoft.EntityFrameworkCore.SqlServer` is what your production code already references; the test project pulls it in so the fixture can apply migrations.

If your tests run xUnit, also add `xunit` 2.9.x and `xunit.runner.visualstudio` 2.8.x. If you are on NUnit or MSTest the same factory pattern works, only the lifecycle hooks change name.

## The factory class

The integration-test factory does three jobs: it owns the container's lifetime, it exposes the connection string to the host's DI, and it applies the schema before any test runs. Here is the full implementation against a hypothetical `OrdersDbContext`:

```csharp
// .NET 11, C# 14, EF Core 11, Testcontainers 4.11
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.MsSql;
using Xunit;

public sealed class OrdersApiFactory
    : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly MsSqlContainer _sql = new MsSqlBuilder()
        .WithImage("mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04")
        .WithPassword("Strong!Passw0rd_for_tests")
        .Build();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<DbContextOptions<OrdersDbContext>>();
            services.AddDbContext<OrdersDbContext>(opts =>
                opts.UseSqlServer(_sql.GetConnectionString()));
        });
    }

    public async Task InitializeAsync()
    {
        await _sql.StartAsync();

        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider
            .GetRequiredService<OrdersDbContext>();
        await db.Database.MigrateAsync();
    }

    public new async Task DisposeAsync()
    {
        await _sql.DisposeAsync();
        await base.DisposeAsync();
    }
}
```

Three details are worth pausing on. The container is constructed in the field initialiser but only started in `InitializeAsync` because xUnit calls that method exactly once per fixture. The host (and therefore the DI container) is built lazily by `WebApplicationFactory` the first time you read `Services` or call `CreateClient`, so by the time `InitializeAsync` calls `Services.CreateScope()` the SQL container is already up and the connection string is wired. The `RemoveAll<DbContextOptions<OrdersDbContext>>` line is non-negotiable: leave it out and you end up with two registrations, and `services.AddDbContext` becomes the second one, which silently keeps both depending on resolver order.

The `WithPassword` call sets the SA password. SQL Server's password policy demands at least eight characters and a mix of upper, lower, digit, and symbol; if you ship a weaker one the container starts but the engine fails health checks. The Testcontainers SA password defaults to `yourStrong(!)Password` which already passes the policy, so omitting `.WithPassword` works too.

## Using the factory in a test class

xUnit's `IClassFixture<T>` is the right scope for most cases. It constructs the fixture once, runs every test method in the class against the same SQL container, then disposes:

```csharp
// .NET 11, xUnit 2.9
public sealed class OrdersApiTests : IClassFixture<OrdersApiFactory>
{
    private readonly OrdersApiFactory _factory;
    private readonly HttpClient _client;

    public OrdersApiTests(OrdersApiFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task Post_creates_order_and_returns_201()
    {
        var response = await _client.PostAsJsonAsync("/orders",
            new { customerId = "C-101", amount = 49.99m });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    [Fact]
    public async Task Get_returns_persisted_order()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        db.Orders.Add(new Order { Id = "O-1", CustomerId = "C-101" });
        await db.SaveChangesAsync();

        var response = await _client.GetAsync("/orders/O-1");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
```

If you need a fresh container for every test (for example when a test rewrites schema), use `IAsyncLifetime` directly on the test class instead of `IClassFixture`. That is rare; in nine cases out of ten you want the cold-start cost paid once per class, and you reset state by truncating tables, not by reboot.

## Reset state between tests, do not reboot the container

The honest cost of "real SQL Server" tests is state leak: test A inserts rows, test B asserts on a count and gets a wrong answer. There are three solutions, in order of speed:

1. **Truncate at the start of each test.** Cheapest. Keep a `static readonly string[] TablesInTruncationOrder` and run `TRUNCATE TABLE` against each one. This is what the Testcontainers maintainers recommend in their ASP.NET Core sample.
2. **Wrap each test in a transaction and roll back at the end.** Works if your code under test does not call `BeginTransaction` itself. EF Core 11 still does not allow nested transactions on SQL Server without an `EnlistTransaction` call.
3. **Use `Respawn`** ([package on NuGet](https://www.nuget.org/packages/Respawn)). Generates the truncation script once by reading information schema, caches it, and runs it before each test. This is what most large teams settle on after a few hundred tests.

Whatever you pick, do **not** call `EnsureDeletedAsync` and `MigrateAsync` between tests. EF Core's migration runner takes single-digit seconds even for a small schema; multiply that by 200 tests and your suite goes from 30 seconds to 30 minutes. For DbContext lifetime tradeoffs in tests, see [removing pooled DbContextFactory in EF Core 11 test swaps](/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) and the related notes on [warming up the EF Core model](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/).

## Parallel test execution

xUnit runs test classes in parallel by default. With one container per class fixture that means N classes lit up M containers at once, where M is bounded by your Docker host's memory. SQL Server eats around 1.5 GB of RAM per instance at idle, so a 16 GB GitHub Actions runner caps at around eight parallel classes before it starts swapping.

Two common knobs:

```xml
<!-- xunit.runner.json in the test project, copy to output -->
{
  "parallelizeTestCollections": true,
  "maxParallelThreads": 4
}
```

```csharp
// or, opt-out per assembly
[assembly: CollectionBehavior(MaxParallelThreads = 4)]
```

If you use a `[Collection]` attribute to share one container across multiple classes, those classes serialise. That is sometimes the right tradeoff: one warm container, slower wall clock per test, much less RAM pressure.

## What Ryuk does and why you should leave it on

Testcontainers ships a sidecar called Ryuk (image `testcontainers/ryuk`). When the .NET process starts, Ryuk attaches to the Docker daemon and watches the parent process. If your test runner crashes, panics, or is `kill -9`-ed, Ryuk notices the parent is gone and disposes the labelled containers. Without Ryuk, a crashed test run leaves orphan SQL Server containers, and the next run hits port collisions or runs out of RAM.

Ryuk is on by default. Disabling it (`TESTCONTAINERS_RYUK_DISABLED=true`) is sometimes recommended in restricted CI environments, but it shifts the cleanup burden to your CI. If you must disable, add a post-job step that runs `docker container prune -f --filter "label=org.testcontainers=true"`.

## CI gotchas

GitHub Actions runners ship Docker preinstalled on Linux runners (`ubuntu-latest`) but not on macOS or Windows runners. Pin to Linux for the SQL container or pay the cost of `docker/setup-docker-action`. Azure DevOps Microsoft-hosted Linux agents work the same way; on self-hosted Windows agents you need Docker Desktop with WSL2 backend and a SQL Server image that matches your host architecture.

The other thing that bites teams is timezone and culture. The Ubuntu base image is UTC; if your tests assert against `DateTime.Now` they will pass locally and fail on CI. Use `DateTime.UtcNow` everywhere or inject `TimeProvider` (built into .NET 8 and later) and seed a deterministic time.

## Verifying the container actually started

If a test fails with `A network-related or instance-specific error occurred`, the container did not finish starting before EF Core opened a connection. The Testcontainers MsSql module has a built-in wait strategy that polls until the engine answers, so this only happens if you replaced the wait. Confirm with:

```csharp
// peek at the dynamic host port
var port = _sql.GetMappedPublicPort(MsSqlBuilder.MsSqlPort);
Console.WriteLine($"SQL is listening on localhost:{port}");
```

The wait strategy uses `sqlcmd` inside the container; if your SQL Server image does not include `sqlcmd` (older images), pass `.WithWaitStrategy(Wait.ForUnixContainer().UntilCommandIsCompleted("/opt/mssql-tools18/bin/sqlcmd", "-Q", "SELECT 1"))` to override.

## Where this stops being enough

Testcontainers gives you a real SQL Server. It does not give you Always On, sharded routing, or full-text search across multiple files. If your production database is a configured cluster, your integration tests run against one node and your suite has a known coverage gap. Document it and write smaller targeted tests against a staging environment for the cluster-specific behaviour, see [unit testing code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/) for the pattern that handles the staging-API calls.

The thing the in-memory provider taught a generation of .NET teams is that "passes locally" is not a deployment signal. Real database, real port, real bytes on the wire, paid for by 10 seconds of cold start. Cheap insurance.

## Related

- [How to mock DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Removing pooled DbContextFactory for cleaner test swaps in EF Core 11](/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)
- [Warm up the EF Core model before the first query](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)
- [Single-step migrations with `dotnet ef update --add` in EF Core 11](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Unit-testing code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/)

## Sources

- [Microsoft SQL Server module (Testcontainers for .NET docs)](https://dotnet.testcontainers.org/modules/mssql/)
- [ASP.NET Core example (Testcontainers for .NET docs)](https://dotnet.testcontainers.org/examples/aspnet/)
- [Testcontainers.MsSql 4.11.0 on NuGet](https://www.nuget.org/packages/Testcontainers.MsSql)
- [Choosing a testing strategy (EF Core docs)](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy)
- [Respawn package on NuGet](https://www.nuget.org/packages/Respawn)
