---
title: "How to write integration tests with WebApplicationFactory<T> in ASP.NET Core 11"
description: "A complete guide to WebApplicationFactory<TEntryPoint> in ASP.NET Core 11: making the Program entry point reachable, ConfigureTestServices vs ConfigureWebHost, replacing the EF Core registration through IDbContextOptionsConfiguration, the new ConfigureHostApplicationBuilder hook in .NET 11 preview 6, faking authentication, WebApplicationFactoryClientOptions, and UseKestrel when you need a real port."
pubDate: 2026-07-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "xunit"
---

To write an integration test with `WebApplicationFactory<TEntryPoint>` in ASP.NET Core 11, reference `Microsoft.AspNetCore.Mvc.Testing` from the test project, make the app's entry point reachable by adding `public partial class Program { }` to the bottom of `Program.cs`, then inject `WebApplicationFactory<Program>` into an xUnit test class through `IClassFixture<T>` and call `CreateClient()`. That `HttpClient` talks to your real middleware pipeline and your real DI container over an in-memory transport, with no socket, no port, and no `dotnet run`. Everything else (swapping a service for a fake, pointing EF Core at a different database, faking an authenticated user) happens inside `ConfigureWebHost` or `WithWebHostBuilder`. This post targets .NET 11 (preview 6 at the time of writing, GA in November 2026) with C# 14, and calls out the two APIs that are new since .NET 9: `UseKestrel` from .NET 10 and `ConfigureHostApplicationBuilder` from .NET 11 preview 6. Everything else runs unchanged on .NET 8, 9, and 10.

## What the factory actually boots

`WebApplicationFactory<TEntryPoint>` does not start your app the way `dotnet run` does. It uses `HostFactoryResolver` to invoke your entry point, intercepts the `IHost` right before it would have been run, swaps the server implementation for `TestServer`, and hands the built host back to you. The consequence is worth internalising because it explains most of the surprising behaviour:

- Your `Program.cs` runs. Every `builder.Services.Add*` call, every middleware registration, every `MapGet` executes exactly as in production.
- No network socket is opened. `TestServer` implements `IServer` over an in-memory `HttpMessageHandler`, so requests skip the transport layer entirely. Kestrel is not involved, which also means HTTPS redirection, HTTP/2 negotiation, and connection limits are not exercised.
- The DI container is the production container plus whatever you layer on in `ConfigureTestServices`. Singletons live for the lifetime of the factory, so state leaks across tests in the same fixture unless you reset it.

That last point is the real value proposition. A unit test tells you a handler returns the right object. An integration test tells you the route template matches, model binding parses the body, the authorization policy admits the caller, the filter pipeline runs in the right order, and the JSON on the wire has the property names your client expects. None of that is exercised by calling the handler directly.

## Steps to add a WebApplicationFactory test

1. Add a test project and reference `Microsoft.AspNetCore.Mvc.Testing` plus a project reference to the app under test.
2. Expose the entry point by appending `public partial class Program { }` to the app's `Program.cs`.
3. Inject `WebApplicationFactory<Program>` into the test class via `IClassFixture<T>` and call `CreateClient()`.
4. Derive a custom factory and override `ConfigureWebHost` when you need to replace services or configuration.
5. Use `WithWebHostBuilder` for per-test overrides that should not leak into the rest of the class.
6. Reset shared state between tests, since the host and its singletons are shared across the fixture.

## The packages

```xml
<!-- .NET 11 preview 6, test project -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="11.0.0-preview.6.*" />
  <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.0" />
  <PackageReference Include="xunit.v3" Version="3.1.0" />
  <PackageReference Include="xunit.runner.visualstudio" Version="3.1.0" />
</ItemGroup>

<ItemGroup>
  <ProjectReference Include="..\..\src\Orders.Api\Orders.Api.csproj" />
</ItemGroup>
```

On .NET 10 use the stable `10.0.0` version of `Microsoft.AspNetCore.Mvc.Testing`. If you have not migrated off xUnit v2 yet, `xunit` 2.9.x works identically for everything below except the `IAsyncLifetime` signature, which is covered in the lifetime section.

`Microsoft.AspNetCore.Mvc.Testing` is not MVC-specific despite the name. It works for minimal APIs, controllers, Razor Pages, and Blazor Server. It also ships an MSBuild target that stamps a `WebApplicationFactoryContentRootAttribute` onto the test assembly so the factory can find the app's content root, which matters for static files and Razor views.

## Making the entry point reachable

This is where most first attempts stop. Top-level statements compile to a class named `Program` whose accessibility is `internal`, so referencing it from a test assembly fails at compile time:

```
error CS0122: 'Program' is inaccessible due to its protection level
```

The fix is one line at the very bottom of `Program.cs`, after `app.Run()`:

```csharp
// .NET 11, C# 14 -- Program.cs, last line
app.Run();

public partial class Program { }
```

The compiler merges your partial declaration with the generated one and the class becomes public. The alternative is `[assembly: InternalsVisibleTo("Orders.Api.Tests")]` in the app project, which keeps `Program` internal but also opens every other internal type to the test assembly. Pick the partial class unless you have a policy reason not to.

A related failure looks like this at runtime:

```
System.InvalidOperationException: The entry point exited without ever building an IHost.
```

That means the resolver ran your `Program.cs` to completion without ever seeing a host get built. The usual causes are an early `return` on some argument path, a `Main` that calls `Environment.Exit`, or an exception thrown during startup that gets swallowed. Note that the app's startup code really does execute during the test, so a `Program.cs` that reads a connection string and throws when it is missing will throw here too. Configuration you rely on at startup has to be available to the test process.

## The first test

With the entry point exposed, the default factory needs no subclass at all:

```csharp
// .NET 11, xUnit v3
using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;

public sealed class OrdersEndpointTests
    : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public OrdersEndpointTests(WebApplicationFactory<Program> factory)
        => _client = factory.CreateClient();

    [Fact]
    public async Task Unknown_order_returns_404()
    {
        var response = await _client.GetAsync("/orders/does-not-exist");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Theory]
    [InlineData("/health")]
    [InlineData("/orders")]
    public async Task Endpoint_returns_json(string url)
    {
        var response = await _client.GetAsync(url);

        response.EnsureSuccessStatusCode();
        Assert.Equal("application/json; charset=utf-8",
            response.Content.Headers.ContentType?.ToString());
    }
}
```

`IClassFixture<T>` builds the factory once per test class and disposes it after the last test in that class. `CreateClient` can be called repeatedly; each call returns a fresh `HttpClient` bound to the same host, with a cookie container of its own.

## Replacing services with ConfigureTestServices

The moment you need a fake payment gateway or a different database you subclass the factory and override `ConfigureWebHost`. Use `ConfigureTestServices`, not `ConfigureServices`:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

public sealed class OrdersApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");

        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IPaymentGateway>();
            services.AddSingleton<IPaymentGateway, StubPaymentGateway>();
        });
    }
}
```

The distinction matters. `ConfigureServices` callbacks run in registration order alongside the app's own, so yours may execute before `Program.cs` adds its implementation. `ConfigureTestServices` is deliberately deferred until after the application's service registration has completed, which is what makes last-wins overriding reliable.

Last-wins only applies to a single-service resolve. `GetRequiredService<IPaymentGateway>()` returns the last registration, but `GetRequiredService<IEnumerable<IPaymentGateway>>()` returns both, and anything injected as `IEnumerable<T>` (validators, health checks, hosted services, `IStartupFilter`) will see the original too. That is why `RemoveAll<T>` appears before the `Add`. For services registered by key, .NET 11's DI has `RemoveAllKeyed<T>`, which pairs with [keyed service registration and resolution](/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/).

For a one-off override that should not affect the rest of the class, use `WithWebHostBuilder`. It returns a new factory sharing nothing but the configuration you supply:

```csharp
[Fact]
public async Task Gateway_timeout_maps_to_502()
{
    var client = _factory.WithWebHostBuilder(builder =>
    {
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IPaymentGateway>();
            services.AddSingleton<IPaymentGateway, TimingOutGateway>();
        });
    }).CreateClient();

    var response = await client.PostAsJsonAsync("/orders",
        new { customerId = "C-1", amount = 10m });

    Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
}
```

## The EF Core registration gotcha

Tutorials written before EF Core 9 tell you to find and remove the `DbContextOptions<TContext>` descriptor before adding your own provider. That snippet no longer does what it says. Since EF Core 9, `AddDbContext` registers the provider configuration through `IDbContextOptionsConfiguration<TContext>` in `Microsoft.EntityFrameworkCore.Infrastructure`, and removing only `DbContextOptions<TContext>` leaves the original SQL Server configuration in place. You then add a second provider and EF throws:

```
System.InvalidOperationException: Only a single database provider can be registered
in a service provider. If possible, ensure that Entity Framework is managing its
service provider by removing the call to UseInternalServiceProvider.
```

The registration to remove in EF Core 9, 10, and 11 is this one:

```csharp
// .NET 11, EF Core 11
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;

builder.ConfigureTestServices(services =>
{
    var registrations = services
        .Where(d => d.ServiceType ==
            typeof(IDbContextOptionsConfiguration<OrdersDbContext>))
        .ToList();

    foreach (var registration in registrations)
    {
        services.Remove(registration);
    }

    services.AddDbContext<OrdersDbContext>(options =>
        options.UseSqlite(_connection));
});
```

Note the SQLite connection is a field on the factory, opened once and kept open, because an in-memory SQLite database is destroyed when its last connection closes. Do not reach for the EF Core in-memory provider here: it has no relational semantics, so foreign keys, unique constraints, and column types are all unenforced. If the test needs to prove a constraint fires, run against the real engine as described in [integration tests against a real SQL Server with Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), and see [mocking DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) for the cases where a database is genuinely overkill.

## Configuration and environment

`UseEnvironment("Testing")` is the cheapest lever: it makes `IWebHostEnvironment.EnvironmentName` return `Testing`, loads `appsettings.Testing.json` if present, and lets production code branch on `env.IsProduction()` without special-casing tests.

For individual settings, the timing of the override is the tricky part. `ConfigureAppConfiguration` inside `ConfigureWebHost` runs after `WebApplication.CreateBuilder` has already returned, so a value you add there is invisible to any code in `Program.cs` that reads `builder.Configuration` during startup, which includes most `AddOptions` and `Bind` calls. .NET 11 preview 6 adds a hook that runs early enough:

```csharp
// .NET 11 preview 6 and later
private static readonly KeyValuePair<string, string?>[] s_settings =
[
    new("Payments:Endpoint", "https://localhost/stub"),
    new("Features:UseNewPricing", "true"),
];

protected override void ConfigureHostApplicationBuilder(
    IHostApplicationBuilder hostApplicationBuilder)
{
    hostApplicationBuilder.Configuration.AddInMemoryCollection(s_settings);
    base.ConfigureHostApplicationBuilder(hostApplicationBuilder);
}
```

The configuration source is in place before `CreateBuilder` returns, so startup code sees it. On .NET 10 and earlier the equivalent is overriding `CreateHost` and calling `builder.ConfigureHostConfiguration(...)` before `base.CreateHost(builder)`, or simply setting environment variables in the test process before the host is built.

## Faking an authenticated user

Do not try to obtain a real token in a test. Register a test authentication scheme that always succeeds and make it the default:

```csharp
// .NET 11, C# 14
public sealed class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string Scheme = "Test";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        Claim[] claims =
        [
            new(ClaimTypes.NameIdentifier, "user-1"),
            new(ClaimTypes.Name, "Test User"),
            new("scope", "orders:write"),
        ];

        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme));
        var ticket = new AuthenticationTicket(principal, Scheme);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}

// in ConfigureTestServices
services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = TestAuthHandler.Scheme;
    options.DefaultChallengeScheme = TestAuthHandler.Scheme;
})
.AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(
    TestAuthHandler.Scheme, _ => { });
```

Then set `client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(TestAuthHandler.Scheme)` and the request arrives authenticated. Your authorization policies still run for real, which is the point: this tests the policy, not the token format. If the thing you actually want to verify is token validation itself, that is a different test, and the parameters involved are covered in [setting up JWT bearer authentication in a minimal API](/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

## Client options that change the answer

`CreateClient` takes a `WebApplicationFactoryClientOptions`, and two of its properties routinely decide whether a test passes:

```csharp
var client = factory.CreateClient(new WebApplicationFactoryClientOptions
{
    AllowAutoRedirect = false,          // default true
    BaseAddress = new Uri("https://localhost"),
    HandleCookies = true,               // default true
    MaxAutomaticRedirections = 7,
});
```

`AllowAutoRedirect` defaults to `true`, so a handler returning `302` is silently followed and your assertion on `HttpStatusCode.Redirect` fails with `200 OK`. Turn it off whenever the redirect itself is the behaviour under test. The `BaseAddress` of `https://localhost` matters if the pipeline includes `UseHttpsRedirection`, since a request to `http://localhost` is answered with a redirect rather than the resource.

## When you need a real port

`TestServer` cannot serve a browser. Since .NET 10, `WebApplicationFactory` can run on Kestrel instead, binding a real loopback port:

```csharp
// .NET 10 and .NET 11
var factory = new OrdersApiFactory();
factory.UseKestrel(0);      // 0 means "pick a free port"
factory.StartServer();

var client = factory.CreateClient();
// client.BaseAddress is now the real bound address, for example
// http://127.0.0.1:53127/, taken from IServerAddressesFeature
await page.GotoAsync(client.BaseAddress!.ToString());
```

`UseKestrel` must be called before the factory is initialised, meaning before any `CreateClient` or `StartServer` call, or it throws `InvalidOperationException`. Once Kestrel is in play, `CreateClient` hands back a plain `HttpClient` whose `BaseAddress` was extracted from the server's `IServerAddressesFeature`, so Playwright or Selenium can drive the same host your other tests exercise in memory. There are also `UseKestrel()` and `UseKestrel(Action<KestrelServerOptions>)` overloads when you need to configure limits or HTTPS.

## Lifetime, disposal, and shared state

`WebApplicationFactory<T>` is disposable, and xUnit disposes the fixture for you. If your factory owns extra resources (a SQLite connection, a container, a temporary directory), implement `IAsyncLifetime` on it. In xUnit v3 the interface derives from `IAsyncDisposable` and both methods return `ValueTask`, so the v2 signatures returning `Task` no longer compile after a migration:

```csharp
// xUnit v3
public sealed class OrdersApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly SqliteConnection _connection = new("DataSource=:memory:");

    public async ValueTask InitializeAsync() => await _connection.OpenAsync();

    public override async ValueTask DisposeAsync()
    {
        await _connection.DisposeAsync();
        await base.DisposeAsync();
    }
}
```

The scope choice is a tradeoff: `IClassFixture<T>` boots one host per test class, `ICollectionFixture<T>` shares one host across every class in the collection (and serialises them), and an assembly fixture shares one across the whole run. Host startup is typically 200 to 500 ms, so per-class is a reasonable default, but remember that every singleton in the app is shared for that lifetime. A cache, a `static` counter, an `IMemoryCache`, or an in-process outbox will carry state from one test into the next. Reset it explicitly in the test, or scope the fixture more tightly.

For anything that depends on the clock, do not sleep. Register `TimeProvider` in the app and swap it for `FakeTimeProvider` in `ConfigureTestServices`, as described in [testing time-dependent code with TimeProvider and FakeTimeProvider](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/). And when the app calls out over HTTP, replace the handler rather than the client, following the pattern in [unit-testing code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/).

One last trap: `xunit.runner.visualstudio` shadow-copies test assemblies by default in some configurations, which breaks the content-root discovery that static files and Razor views depend on. If a page renders in production but 404s in a test, add `xunit.runner.json` with `"shadowCopy": false` and set it to copy to the output directory.

The mental model that keeps all of this straight is that `WebApplicationFactory` is your production host with exactly two things changed: the server implementation, and whatever you deliberately override in `ConfigureTestServices`. Every surprise it produces traces back to something in your real startup path that you forgot was going to run.

## Related

- [How to write integration tests against a real SQL Server with Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)
- [How to test time-dependent code with TimeProvider and FakeTimeProvider in .NET 11](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)
- [How to unit-test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [How to set up JWT bearer authentication in a minimal API in ASP.NET Core 11](/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)
- [How to register and resolve keyed services in .NET 11 dependency injection](/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)
- [WebApplication.CreateBuilder vs CreateSlimBuilder vs CreateEmptyBuilder in ASP.NET Core 11](/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/)

## Sources

- [Integration tests in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests)
- [WebApplicationFactory&lt;TEntryPoint&gt;.UseKestrel (API reference)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.testing.webapplicationfactory-1.usekestrel)
- [WebApplicationFactory.cs source (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Mvc/Mvc.Testing/src/WebApplicationFactory.cs)
- [IDbContextOptionsConfiguration&lt;TContext&gt; (EF Core API reference)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.idbcontextoptionsconfiguration-1)
- [Migrating unit tests from xUnit v2 to v3](https://xunit.net/docs/getting-started/v3/migration)
