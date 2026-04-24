---
title: "How to Generate Strongly Typed Client Code from an OpenAPI Spec in .NET 11"
description: "Use Kiota, Microsoft's official OpenAPI code generator, to produce a fluent, strongly typed C# client from any OpenAPI spec. Step-by-step: install, generate, wire into ASP.NET Core DI, and handle authentication."
pubDate: 2026-04-24
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "aspnet"
  - "openapi"
---

The moment an API ships an OpenAPI document, maintaining a hand-rolled `HttpClient` wrapper is a losing bet. Every new field, renamed path, or extra status code means a manual update, and the spec and the client drift apart silently. The right fix is to flip the relationship: treat the spec as the source of truth and generate the C# types from it.

In .NET 11 the canonical tool for this is [Kiota](https://learn.microsoft.com/en-us/openapi/kiota/overview), Microsoft's OpenAPI-based client generator. Install it as a .NET tool, point it at a spec, and it writes a fluent, resource-oriented C# client with real strongly typed request and response classes. A single meta-package handles HTTP, JSON, and auth middleware. The whole setup takes under ten minutes on a clean spec.

## Why hand-writing HttpClient wrappers stops working

A typical hand-rolled wrapper looks like this: write a POCO for the response, add a method on a service class, hardcode the URL segment. Repeat for each endpoint. Then repeat again when the API owner adds a new response field, changes a path parameter name, or tightens a nullable contract. None of those changes produce a compiler error. They surface as runtime surprises -- null-reference exceptions in production, mismatched JSON property names that silently zero out a value.

A generated client flips that. The spec is compiled directly into C# types. If the spec says a field is `nullable: false`, the property is `string`, not `string?`. If the spec adds a new path, the next `kiota generate` run adds the method. A diff on the generated files shows exactly what changed in the API contract.

## Kiota vs NSwag: which generator to reach for

Two generators dominate the .NET space: NSwag (mature, produces a single monolithic class file) and Kiota (newer, resource-oriented, produces many small focused files).

Kiota builds a path hierarchy that mirrors the URL structure. A call to `GET /repos/{owner}/{repo}/releases` becomes `client.Repos["owner"]["repo"].Releases.GetAsync()`. Each path segment is a separate C# class. This produces more files but makes the generated code navigable and mockable at any path level.

NSwag generates one class with a method per operation: `GetReposOwnerRepoReleasesAsync(owner, repo)`. That is straightforward for small APIs but becomes unwieldy when the spec has hundreds of paths. The full GitHub OpenAPI spec generates a file approaching 400,000 lines with NSwag.

Kiota is what Microsoft uses for the Microsoft Graph SDK and the Azure SDK for .NET. It was declared generally available in 2024 and is the generator the official docs quickstarts point to. Both tools are shown below; the NSwag section covers the minimal alternative for teams already invested in that toolchain.

## Step 1: Install Kiota

**Global install** (simplest for a developer machine):

```bash
dotnet tool install --global Microsoft.OpenApi.Kiota
```

**Local install** (recommended for team projects -- reproducible across CI machines):

```bash
dotnet new tool-manifest   # creates .config/dotnet-tools.json
dotnet tool install Microsoft.OpenApi.Kiota
```

After a local install, `dotnet tool restore` on any developer machine or CI job installs the exact pinned version. No version drift across the team.

Verify the install:

```bash
kiota --version
# 1.x.x
```

## Step 2: Generate the client

```bash
# .NET 11 / Kiota 1.x
kiota generate \
  -l CSharp \
  -c WeatherClient \
  -n MyApp.ApiClient \
  -d ./openapi.yaml \
  -o ./src/ApiClient
```

The key flags:

| Flag | Purpose |
|------|---------|
| `-l CSharp` | Target language. Kiota also supports Go, Java, TypeScript, Python, PHP, Ruby. |
| `-c WeatherClient` | Name of the root client class. |
| `-n MyApp.ApiClient` | Root C# namespace for all generated files. |
| `-d ./openapi.yaml` | Path or HTTPS URL to the OpenAPI document. Kiota accepts YAML and JSON. |
| `-o ./src/ApiClient` | Output directory. Kiota overwrites it on each run -- do not edit generated files by hand. |

For large public specs (GitHub, Stripe, Azure), add `--include-path` to scope the client to the paths you actually call:

```bash
# Only generate the /releases subtree from GitHub's spec
kiota generate \
  -l CSharp \
  -c GitHubClient \
  -n MyApp.GitHub \
  -d https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml \
  -o ./src/GitHub \
  --include-path "/repos/{owner}/{repo}/releases/*"
```

Without `--include-path`, the full GitHub spec generates roughly 600 files. With it, you get the dozen files for the releases subtree. You can always widen the filter later.

Commit the generated files to source control. The spec URL or local path is enough to regenerate them, and reviewers can see the exact types in use during code review.

## Step 3: Add the NuGet package

```bash
dotnet add package Microsoft.Kiota.Bundle
```

`Microsoft.Kiota.Bundle` is a meta-package that brings in:

- `Microsoft.Kiota.Abstractions` -- request adapter contracts and serialization interfaces
- `Microsoft.Kiota.Http.HttpClientLibrary` -- `HttpClientRequestAdapter`, the default HTTP backend
- `Microsoft.Kiota.Serialization.Json` -- System.Text.Json serialization
- `Microsoft.Kiota.Authentication.Azure` -- optional, for Azure Identity auth providers

The bundle targets `netstandard2.0`, so it is compatible with .NET 8, .NET 9, .NET 10, and .NET 11 (currently in preview) without any extra `<TargetFramework>` gymnastics.

## Step 4: Use the client in a console app

```csharp
// .NET 11, Kiota 1.x
using MyApp.ApiClient;
using Microsoft.Kiota.Abstractions.Authentication;
using Microsoft.Kiota.Http.HttpClientLibrary;

var adapter = new HttpClientRequestAdapter(new AnonymousAuthenticationProvider());
var client = new WeatherClient(adapter);

// GET /forecasts
var all = await client.Forecasts.GetAsync();
Console.WriteLine($"Received {all?.Count} forecasts.");

// GET /forecasts/{location}
var specific = await client.Forecasts["lon=51.5,lat=-0.1"].GetAsync();
Console.WriteLine($"Temperature: {specific?.Temperature}");

// POST /forecasts
var created = await client.Forecasts.PostAsync(new()
{
    Location = "lon=51.5,lat=-0.1",
    TemperatureC = 21,
});
Console.WriteLine($"Created forecast ID: {created?.Id}");
```

`AnonymousAuthenticationProvider` adds no auth headers -- correct for public APIs. See the authentication section below for Bearer tokens.

Every generated async method accepts an optional `CancellationToken`. Pass one from your own context:

```csharp
// .NET 11, Kiota 1.x
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
var forecasts = await client.Forecasts.GetAsync(cancellationToken: cts.Token);
```

The token flows through the HTTP adapter and cancels the underlying `HttpClient` call. No extra wiring needed.

## Step 5: Wire the client into ASP.NET Core DI

Newing up the request adapter in every handler wastes sockets (bypassing `IHttpClientFactory`'s connection pooling) and makes the client untestable. The correct pattern is a factory class that accepts a managed `HttpClient` via constructor injection.

Create the factory:

```csharp
// .NET 11, Kiota 1.x
using MyApp.ApiClient;
using Microsoft.Kiota.Abstractions.Authentication;
using Microsoft.Kiota.Http.HttpClientLibrary;

public class WeatherClientFactory(HttpClient httpClient)
{
    public WeatherClient GetClient() =>
        new(new HttpClientRequestAdapter(
            new AnonymousAuthenticationProvider(),
            httpClient: httpClient));
}
```

Register everything in `Program.cs`:

```csharp
// .NET 11
using Microsoft.Kiota.Http.HttpClientLibrary;

// Register Kiota's built-in HTTP message handlers in the DI container
builder.Services.AddKiotaHandlers();

// Register the named HttpClient and attach those handlers
builder.Services.AddHttpClient<WeatherClientFactory>(client =>
{
    client.BaseAddress = new Uri("https://api.weather.example.com");
})
.AttachKiotaHandlers();

// Expose the generated client directly for injection
builder.Services.AddTransient(sp =>
    sp.GetRequiredService<WeatherClientFactory>().GetClient());
```

`AddKiotaHandlers` and `AttachKiotaHandlers` are extension methods from `Microsoft.Kiota.Http.HttpClientLibrary`. They register Kiota's default delegating handlers -- retry, redirect, header inspection -- and wire them into the `IHttpClientFactory` lifecycle so they are disposed correctly.

Inject `WeatherClient` directly into your minimal API endpoints:

```csharp
// .NET 11
app.MapGet("/weather", async (WeatherClient client, CancellationToken ct) =>
{
    var forecasts = await client.Forecasts.GetAsync(cancellationToken: ct);
    return forecasts;
});
```

The `CancellationToken` parameter in a minimal API handler is automatically bound to the HTTP request-abort token. If the client disconnects, the in-flight Kiota call is cancelled cleanly without any extra code.

## Step 6: Authentication

For APIs that require a Bearer token, implement `IAccessTokenProvider` and pass it to `BaseBearerTokenAuthenticationProvider`:

```csharp
// .NET 11, Kiota 1.x
using Microsoft.Kiota.Abstractions;
using Microsoft.Kiota.Abstractions.Authentication;

public class StaticTokenProvider(string token) : IAccessTokenProvider
{
    public Task<string> GetAuthorizationTokenAsync(
        Uri uri,
        Dictionary<string, object>? additionalContext = null,
        CancellationToken cancellationToken = default) =>
        Task.FromResult(token);

    public AllowedHostsValidator AllowedHostsValidator { get; } = new();
}
```

Wire it in the factory:

```csharp
// .NET 11, Kiota 1.x
var authProvider = new BaseBearerTokenAuthenticationProvider(
    new StaticTokenProvider(apiKey));

return new WeatherClient(new HttpClientRequestAdapter(authProvider, httpClient: httpClient));
```

For production, swap `StaticTokenProvider` for an implementation that reads the token from the current HTTP context, an `IOptions<>` value, or Azure Identity's `DefaultAzureCredential` (the `Microsoft.Kiota.Authentication.Azure` package exposes `AzureIdentityAuthenticationProvider` for exactly this case).

## Using NSwag if you prefer a simpler file structure

If your project already uses NSwag or was scaffolded with `dotnet-openapi`, you do not need to migrate. Install the NSwag CLI and regenerate with:

```bash
dotnet tool install --global NSwag.ConsoleCore

nswag openapi2csclient \
  /input:openapi.yaml \
  /classname:WeatherClient \
  /namespace:MyApp.ApiClient \
  /output:WeatherClient.cs
```

NSwag produces a single C# file containing the client class and a matching `IWeatherClient` interface. That interface makes unit testing straightforward -- you can mock `IWeatherClient` directly without any path-level indirection. For small, stable specs where the entire generated file fits on one screen, NSwag is a practical choice. For large or frequently changing specs, Kiota's per-path file structure makes API diffs easier to review.

## Gotchas before you commit the generated files

**Spec quality determines type accuracy.** Kiota validates the OpenAPI document at generation time. A missing `nullable: true` annotation becomes `string` where you expected `string?`. An incorrect `type: integer` becomes `int` where the API actually sends floats. If you own the server, run [Spectral](https://stoplight.io/open-source/spectral) against the spec before generating. Garbage in, misleading types out.

**`--include-path` is not optional for large public APIs.** Without it, the GitHub spec generates hundreds of files, the Stripe spec generates even more. Scope the client at generation time to the paths you call. You can always regenerate with a broader filter later; a 600-file client that grows over time is harder to trim.

**Model naming collisions are namespaced automatically.** If a `GET /posts/{id}` and a `GET /users/{id}` both reference a schema named `Item`, Kiota generates `Posts.Item.Item` and `Users.Item.Item`. Check your `using` statements if names appear to collide.

**`CancellationToken` in minimal API endpoints is free.** Declare it as a parameter and ASP.NET Core binds it to the request-abort token without any attribute. Pass it to every Kiota call and your HTTP client automatically cancels when the browser closes the connection or a gateway timeout fires. The mechanics of cooperative cancellation in C# are covered in depth at [how to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

**Regenerate in CI, not just locally.** Add `dotnet tool restore && kiota generate [...]` as a pipeline step. If the spec changes and the generated code in the repo is stale, the build will detect the difference before it ships.

## Related

- If you expose the API server yourself and want Bearer auth to show up correctly in the Scalar documentation UI, the wiring is non-obvious: [Scalar in ASP.NET Core: why your Bearer token is ignored](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- If your service-to-service calls go over gRPC rather than REST, the container networking traps are different from the HTTP ones: [gRPC in containers in .NET 9 and .NET 10](/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/)
- Adding distributed traces to the HTTP client layer sits naturally alongside [ASP.NET Core 11 native OpenTelemetry tracing](/2026/04/aspnetcore-11-native-opentelemetry-tracing/)

## Source links

- [Kiota overview](https://learn.microsoft.com/en-us/openapi/kiota/overview) -- Microsoft Learn
- [Build API clients for .NET](https://learn.microsoft.com/en-us/openapi/kiota/quickstarts/dotnet) -- Microsoft Learn
- [Register a Kiota client with dependency injection in .NET](https://learn.microsoft.com/en-us/openapi/kiota/tutorials/dotnet-dependency-injection) -- Microsoft Learn
- [NSwag: the Swagger/OpenAPI toolchain for .NET](https://github.com/RicoSuter/NSwag) -- GitHub
