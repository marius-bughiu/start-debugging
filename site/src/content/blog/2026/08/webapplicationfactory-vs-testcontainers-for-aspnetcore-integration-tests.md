---
title: "WebApplicationFactory vs Testcontainers for ASP.NET Core integration tests"
description: "Choose an ASP.NET Core integration-test setup by what it must prove: HTTP routing, production database behavior, or the published application image."
pubDate: 2026-08-07
updatedDate: 2026-11-02
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

`WebApplicationFactory<TEntryPoint>` starts the application under test. Testcontainers starts dependencies such as PostgreSQL or SQL Server. They can be used together. Choose the setup by the behavior your assertion needs to observe.

**Correction, November 2, 2026.** A failed `:int` route constraint normally produces 404. The earlier comparison gave 400 and implied that only a containerized app can exercise a real socket. The HTTP example below was checked with ASP.NET Core 10.0.10 and SDK 10.0.302. The old fixture timings had no published harness and have been removed.

## Choose the boundary

| What the test must prove | Setup | What to check |
| --- | --- | --- |
| The app routes, authorizes and serializes a request | Factory with its default `TestServer`, plus test service registrations | Status, headers and response body |
| The endpoint depends on production database semantics | Factory plus a Testcontainers instance of the production engine | Actual constraints, migrations, query translation and concurrency |
| The published image starts correctly | Build and run the app image with its services | Dockerfile, entry point, configuration and network behavior |

The default factory uses an in-process HTTP server. Since .NET 10, `UseKestrel()` can configure the factory to use Kestrel and a real port. Call it before initializing the factory. TLS and HTTP/2 still require the matching server and client configuration. An app container remains the right choice when the image itself is under test.

## An HTTP assertion with no database

```csharp
var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/orders/{id:int}", (int id) => TypedResults.Ok(id));
app.MapGet("/bound/{id}", (int id) => TypedResults.Ok(id));
app.Run();
```

`GET /orders/7` returns 200. `GET /orders/abc` fails the route constraint and returns 404 because no endpoint matches. `GET /bound/abc` matches the route, but binding `abc` to the handler's integer parameter fails and returns 400. These checks ran over Kestrel on loopback. For setting up the factory, replacing a service or testing authentication, follow the [WebApplicationFactory walkthrough](/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).

## A database assertion needs the relevant provider

SQLite enforces constraints such as uniqueness, but `VARCHAR(16)` alone does not enforce a 16-character maximum. PostgreSQL rejects an overlength non-space value assigned to `varchar(16)`. A green SQLite test cannot establish that your PostgreSQL length rule works. The same choice matters for provider-specific SQL, migrations and [row-version concurrency](/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

For an endpoint backed by SQL Server, start a SQL Server test container, apply the app migrations, point the factory at its connection string, and assert the database result. The [SQL Server Testcontainers walkthrough](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) covers that setup. Keep HTTP-only tests independent of Docker when persistence is incidental.

## Keep the fixture repeatable

Share a container only if test data remains isolated. A new schema or database per test group, or an explicit reset between tests, prevents prior writes from changing later results. Record image pulls, startup, schema creation and request timings separately when measuring your own suite. A warm local image and a clean CI worker measure different costs.

## Sources

- [ASP.NET Core integration tests](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests?view=aspnetcore-10.0)
- [Route constraints](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing?view=aspnetcore-10.0#route-constraints)
- [WebApplicationFactory.UseKestrel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.testing.webapplicationfactory-1.usekestrel?view=aspnetcore-10.0)
- [Testcontainers for .NET](https://dotnet.testcontainers.org/)
- [SQLite VARCHAR limits](https://sqlite.org/faq.html#q9) · [PostgreSQL character types](https://www.postgresql.org/docs/17/datatype-character.html)
