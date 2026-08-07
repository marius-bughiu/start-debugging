---
title: "WebApplicationFactory vs Testcontainers for ASP.NET Core integration tests"
description: "They are not alternatives. WebApplicationFactory boots your app, Testcontainers boots your dependencies. Measured on .NET SDK 10.0.201: a container fixture costs 1.7 s per class against 10 ms for SQLite, and a HasMaxLength(16) violation that Postgres rejects with 22001 is silently accepted by SQLite."
pubDate: 2026-08-07
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "ef-core"
---

Use both. `WebApplicationFactory<T>` boots your application; Testcontainers boots the things your application talks to. The only decision you actually have to make is what backs your data layer, and the answer is: if the test asserts on anything the database enforces, you need a real database in a container. If it asserts on routing, model binding, authorization, or JSON shape, skip Docker and pay 10 ms instead of 1.7 seconds.

Everything below was measured on .NET SDK 10.0.201 with `Microsoft.AspNetCore.Mvc.Testing` 10.0.1, `Testcontainers.PostgreSql` 4.13.0, EF Core 10.0.1, and `postgres:17.6-alpine`, running on Docker Desktop 29.5.3 (WSL2 backend, 20 CPUs allocated) on an Intel Core Ultra 7 265KF with 32 GB of RAM, Windows 11 26200. The APIs are unchanged in .NET 11 preview.

## The three configurations people actually mean

"WebApplicationFactory vs Testcontainers" is a badly-posed question, because the two live at different layers. What people are choosing between is one of these three setups:

| | A. WAF + in-process fake | B. WAF + Testcontainers | C. Testcontainers all the way |
| --- | --- | --- | --- |
| App runs | In your test process | In your test process | In a container you built |
| Transport | `TestServer`, no socket | `TestServer`, no socket | Real socket, real Kestrel |
| Database | SQLite / in-memory / mock | Real engine in a container | Real engine in a container |
| Needs Docker | No | Yes | Yes |
| Fixture cost (measured) | ~10 ms | ~1.7 s | ~1.7 s plus image build |
| Can breakpoint into app code | Yes | Yes | No |
| Can swap a service for a fake | Yes | Yes | No |
| Tests your Dockerfile / entrypoint | No | No | Yes |
| Tests HTTPS, HTTP/2, Kestrel limits | No | No | Yes |
| Catches DB constraint violations | No (see below) | Yes | Yes |

A and B are the same code with a different connection string. C is a genuinely different thing and is the only row where "vs" is a real either/or, because in C you lose `ConfigureTestServices` entirely: the app is a sealed artifact and you can only talk to it over HTTP.

Most teams want B, reach for A because Docker felt slow, and never seriously evaluate C. The numbers below say A is cheaper than you think it is expensive, B is cheaper than you think, and the reason to pick B is not performance at all.

## The measurement

The system under test is a minimal API with one `POST /orders` writing through EF Core and one `GET /orders` reading back. `Order.Sku` is configured `HasMaxLength(16)` with a unique index. The harness boots a fresh factory three times per configuration, in the same process, so round 1 includes JIT and EF model building and rounds 2 and 3 show the steady state.

```csharp
// .NET 10.0.201, C# 14, Mvc.Testing 10.0.1, Testcontainers.PostgreSql 4.13.0
var sw = Stopwatch.StartNew();
var pg = new PostgreSqlBuilder("postgres:17.6-alpine").Build();
await pg.StartAsync();
var containerStart = sw.ElapsedMilliseconds;

sw.Restart();
await using var factory = new PostgresFactory(pg.GetConnectionString());
var client = factory.CreateClient();
var boot = sw.ElapsedMilliseconds;
```

Configuration A, `WebApplicationFactory<T>` over a SQLite in-memory connection, no Docker:

| Round | Factory boot | Schema create | First request | 100 writes | 100 reads |
| --- | --- | --- | --- | --- | --- |
| 1 | 129 ms | 309 ms | 64 ms | 205 ms | 193 ms |
| 2 | 11 ms | 2 ms | 4 ms | 49 ms | 70 ms |
| 3 | 4 ms | 7 ms | 3 ms | 49 ms | 67 ms |

Configuration B, the same factory pointed at a Testcontainers PostgreSQL instance, image already pulled:

| Round | Container start | Factory boot | Schema create | First request | 100 writes | 100 reads | Teardown |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2933 ms | 5 ms | 198 ms | 4 ms | 210 ms | 191 ms | 321 ms |
| 2 | 1403 ms | 5 ms | 42 ms | 6 ms | 131 ms | 197 ms | 300 ms |
| 3 | 1424 ms | 4 ms | 32 ms | 5 ms | 81 ms | 81 ms | 306 ms |

Two things fall out of this that contradict the folklore.

**The factory itself is free in both.** Booting `WebApplicationFactory<T>` costs 4 to 5 ms once the process is warm, whichever database sits behind it. When people say "integration tests are slow", they are almost never talking about `TestServer`.

**Per-request cost is roughly the same.** 100 round trips through the full middleware pipeline, model binding, EF Core, and back cost 49 ms against SQLite and 81 ms against a containerized Postgres in the steady state. That is 0.3 ms per request of difference, over a loopback socket into WSL2. The database being real is not what makes your suite slow.

What is expensive is the fixture: about 1.7 seconds of container start plus teardown, per fixture, against roughly 10 ms for the in-process option. Multiply by the number of test classes that each own a container and you have your answer. A suite with 40 container-owning fixtures spends 68 seconds doing nothing but starting and stopping Postgres.

The cold cost is worth stating separately, because it is what your first CI run pays: pulling `postgres:17.6-alpine` from scratch took 11.3 seconds for a 106 MB image. That is the cheap end. A SQL Server developer image is over an order of magnitude larger, which is why the [Testcontainers SQL Server guide](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) spends a section on caching the layer in CI.

## The result that decides it

Performance is not the axis. This is:

```csharp
// .NET 10.0.201, EF Core 10.0.1
// Order.Sku is configured HasMaxLength(16)
db.Orders.Add(new Order { Sku = "TOOLONGSKU-0123456789", Total = 1m });
await db.SaveChangesAsync();
```

Against the container:

```
postgres: 22001: value too long for type character varying(16)
```

Against SQLite in-memory:

```
sqlite:   ACCEPTED, stored 21 chars
```

SQLite has no `varchar` length enforcement. EF Core faithfully emits `TEXT` for a `HasMaxLength(16)` string, SQLite stores all 21 characters without complaint, and the test that was supposed to prove your validation works passes. In production the same write throws. That single divergence is the whole argument, and it generalises: SQLite differs from Postgres and SQL Server on decimal precision, on identifier case sensitivity, on `DateTime` precision, on concurrent write behaviour, and on almost every `FromSql` query you will ever write. The EF Core in-memory provider is worse still, since it enforces no relational semantics at all.

So the rule is not "always use Testcontainers" and it is not "Testcontainers is too slow". It is: **the moment a test's assertion depends on something the database engine enforces, a fake database makes that test a lie.** Constraint violations, cascade deletes, `rowversion` concurrency tokens (see [optimistic concurrency with a rowversion token](/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)), raw SQL, migrations, and anything touching the query translator all belong in configuration B.

## When to pick each

**Pick A (WAF, no Docker) when** the test is about the HTTP surface. Does `/orders/{id:int}` reject `abc` with a 400? Does the `[Authorize(Policy = "Admin")]` attribute return 403 for a non-admin? Does the response serialize `total` as a number and not a string? Does the exception handler produce a `ProblemDetails` body? None of those care whether the database is real, and many do not need a database at all: register a stub repository through `ConfigureTestServices` and skip persistence entirely. These are the tests you want to run on every keystroke, and at 10 ms of setup they can.

**Pick B (WAF + Testcontainers) when** the assertion reaches the storage engine. This is the default for repository tests, EF Core query tests, migration verification, and any endpoint whose interesting behaviour is a database error path. It is also the only honest way to test that your migrations actually apply to an empty database, which is a class of failure that no fake catches and that takes production down.

**Pick C (fully containerized) when** the artifact is the thing under test. You are verifying the Dockerfile builds a runnable image, the entrypoint reads the environment variables your Helm chart sets, TLS terminates correctly, or HTTP/2 negotiation works. `TestServer` cannot tell you any of this because it never opens a socket. C is a handful of smoke tests at the end of the pipeline, not a test strategy.

## Making B cheap: reuse

The 1.7 seconds per fixture is not a fixed cost. Testcontainers has supported container reuse for a while, and it turns the fixture cost into a rounding error during local development:

```csharp
// Testcontainers 4.13.0
var pg = new PostgreSqlBuilder("postgres:17.6-alpine")
    .WithReuse(true)
    .Build();
await pg.StartAsync();
// deliberately not disposed: reuse keeps the container alive between runs
```

Measured across three consecutive starts in the same process:

| Start | Duration | Container ID |
| --- | --- | --- |
| 1 | 1812 ms | `81ae62b0f2b4` |
| 2 | 103 ms | `81ae62b0f2b4` |
| 3 | 81 ms | `81ae62b0f2b4` |

Same container, 81 ms instead of 1812. Reuse matches on a hash of the container configuration, so changing the image tag, the environment, or the port mapping correctly produces a new container.

The caveat is cleanup. The Testcontainers docs are explicit that enabling reuse disables the resource reaper, so Ryuk will not remove the container for you, and calling `DisposeAsync()` on a reusable container stops it rather than deleting it. A stale container carrying last week's schema will happily serve your tests until you remove it by hand. That state-between-runs property is what makes reuse a local-development optimisation rather than a CI one: gate it behind an environment check so your pipeline always gets a clean engine.

Note that unlike the Java implementation, Testcontainers for .NET needs no `~/.testcontainers.properties` opt-in. `WithReuse(true)` is sufficient on its own, which is convenient and also why the gating is your job.

The other lever, which matters more in CI, is sharing one container across many test classes instead of one per class. In xUnit that is a collection fixture or an assembly fixture rather than `IClassFixture<T>`; the framework differences are covered in the [xUnit v3 vs NUnit vs MSTest comparison](/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/). Share the container, isolate the data: give each test class its own schema or database on the shared server, or reset with a truncate between tests.

## Three errors you will hit wiring this up

All three of these came out of building the harness for this post, on current package versions.

**`Solution root could not be located using application root`.** `WebApplicationFactory<T>` locates the app's content root by walking up from the test assembly looking for a `.sln` or `.slnx` file, unless the MSBuild target in `Microsoft.AspNetCore.Mvc.Testing` stamped a `WebApplicationFactoryContentRootAttribute` onto your test assembly. A test project that is not part of a solution file, which is increasingly common with `dotnet run app.cs`-era layouts, throws on the first `CreateClient()`. Either add the projects to a solution or override `CreateHost` and set the content root explicitly.

**`Services for database providers 'Npgsql.EntityFrameworkCore.PostgreSQL', 'Microsoft.EntityFrameworkCore.Sqlite' have been registered in the service provider. Only a single database provider can be registered in a service provider.`** This is the classic swap-the-DbContext failure, and the advice you will find on Stack Overflow is out of date. Removing `DbContextOptions<TContext>` is no longer sufficient, because `AddDbContext` in EF Core 9 and later also registers an `IDbContextOptionsConfiguration<TContext>` that still carries the production provider. Remove all three:

```csharp
// .NET 10.0.201, EF Core 10.0.1
protected override void ConfigureWebHost(IWebHostBuilder builder)
{
    builder.ConfigureTestServices(services =>
    {
        services.RemoveAll(typeof(IDbContextOptionsConfiguration<OrdersDbContext>));
        services.RemoveAll(typeof(DbContextOptions<OrdersDbContext>));
        services.RemoveAll(typeof(DbContextOptions));
        services.AddDbContext<OrdersDbContext>(o => o.UseNpgsql(_connectionString));
    });
}
```

The cleaner alternative, if you own `Program.cs`, is to not register a provider you intend to replace: read the connection string from configuration and let the test factory supply it through `ConfigureAppConfiguration`. Then there is nothing to remove.

**`'PostgreSqlBuilder.PostgreSqlBuilder()' is obsolete`.** As of Testcontainers 4.13.0 the parameterless module builders are obsolete and the image must be passed to the constructor: `new PostgreSqlBuilder("postgres:17.6-alpine")`. This is the tail end of the 4.10 change that stopped modules defaulting to a maintainer-chosen tag. It is a warning today and will be an error later, and it is the right call: a floating image tag means a CI pipeline that passed yesterday can fail today for reasons that have nothing to do with your commit.

## What I would actually do

Default to configuration B for anything with a repository in the call stack, and configuration A for everything else. Concretely: one shared container per assembly, `WithReuse(true)` locally, a truncate-between-tests reset rather than a container per class, and a separate fast test project with no Docker dependency for the HTTP-surface tests so `dotnet test` on that project stays under a second.

Do not use SQLite or the in-memory provider as a stand-in for your production engine. Use them when the database is genuinely incidental to what you are asserting, and be honest that at that point you are writing an HTTP test that happens to need a persistence layer to exist. The measured 30 ms per hundred requests you save is not worth a green test that would be red in production. If you want a fake at all, [mocking `DbContext` without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) is a more honest fake than a different SQL dialect.

And reach for configuration C sparingly. It is a real capability, not a better version of B: it tests the artifact rather than the code, so it belongs next to your deployment smoke tests rather than in the suite developers run before pushing.

## Related

- The full mechanics of the factory itself, including `ConfigureTestServices` versus `ConfigureWebHost` and faking authentication: [integration tests with `WebApplicationFactory<T>` in ASP.NET Core 11](/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).
- The container side in depth, with `IAsyncLifetime`, migrations, and Ryuk: [integration tests against a real SQL Server with Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Fixture sharing, parallelism defaults, and lifecycle differ per framework: [xUnit v3 vs NUnit vs MSTest in 2026](/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).
- The other common source of untrustworthy tests: [testing time-dependent code with `TimeProvider` and `FakeTimeProvider`](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).
- A concurrency behaviour that no fake database reproduces: [optimistic concurrency with a `rowversion` token in EF Core 11](/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

## Sources

- [Integration tests in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests) on `WebApplicationFactory<TEntryPoint>` and the content-root attribute
- [Choosing a testing strategy](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) in the EF Core docs, on why the in-memory provider is not a database
- [Testcontainers for .NET](https://dotnet.testcontainers.org/) documentation and the [4.10.0 through 4.13.0 releases](https://github.com/testcontainers/testcontainers-dotnet/releases), which introduced mandatory image pinning and the reuse-hash APIs
- [Testcontainers container reuse discussion](https://github.com/testcontainers/testcontainers-dotnet/discussions/1470) covering the obsolete parameterless builders
- Package versions from NuGet: [Microsoft.AspNetCore.Mvc.Testing 10.0.1](https://www.nuget.org/packages/Microsoft.AspNetCore.Mvc.Testing), [Testcontainers.PostgreSql 4.13.0](https://www.nuget.org/packages/Testcontainers.PostgreSql)
