---
title: "HttpClient vs HttpClientFactory vs Refit: which should you use in .NET 11?"
description: "Never new up HttpClient per request. Use IHttpClientFactory to manage lifetime, and add Refit on top when you want a typed interface instead of hand-written request code. Raw singleton HttpClient is fine only for the simplest cases."
pubDate: 2026-05-23
template: vs
tags:
  - "comparison"
  - "httpclient"
  - "httpclientfactory"
  - "refit"
  - "dotnet"
  - "dotnet-11"
---

The first thing to understand is that these three are not really competitors. They are three layers of the same stack. `IHttpClientFactory` manages the lifetime of `HttpClient`, and Refit generates `HttpClient` calls for you on top of the factory. So the real question is how high up the stack you should sit. For new .NET 11 code in 2026: register your clients through **IHttpClientFactory** so connection lifetime and DNS are handled correctly, and reach for **Refit** when you want a typed interface instead of writing request-building code by hand. A raw, long-lived `HttpClient` singleton is acceptable only for the simplest one-call cases, and `new HttpClient()` per request is the one pattern that is always wrong.

Every example here targets `<TargetFramework>net11.0</TargetFramework>` with the .NET 11 SDK and C# 14. Refit refers to version 10.1.6 (released 2026-03-21, current stable on NuGet), and the resilience pieces use `Microsoft.Extensions.Http.Resilience` 10.6.0. `IHttpClientFactory` lives in `Microsoft.Extensions.Http`, which ships in-box with the ASP.NET Core and Worker SDKs.

## The feature matrix at a glance

This is the table you came for. The columns are the three ways you will actually wire up an HTTP call, and the rows are the decisions that change which one you pick.

| Concern | Raw HttpClient (singleton) | IHttpClientFactory | Refit (+ HttpClientFactory) |
| ------- | -------------------------- | ------------------ | --------------------------- |
| Socket exhaustion safe | Yes, if truly singleton | Yes | Yes |
| Honors DNS changes | Only with `PooledConnectionLifetime` | Yes, handler rotates (default 2 min) | Yes, inherits factory |
| Handler pipeline via DI | Manual | First-class (`AddHttpMessageHandler`) | First-class, inherits factory |
| Built-in resilience | Hand-rolled | `AddStandardResilienceHandler` | `AddStandardResilienceHandler` |
| Named / typed clients | No | Yes | Yes, the interface is the client |
| Request-building code you write | All of it | All of it | None, generated at build time |
| Strongly-typed responses | Manual deserialize | Manual deserialize | Automatic |
| Native AOT / trimming | Yes | Yes | Yes, since 9.0.2 on .NET 10+ |
| Extra NuGet dependency | None (in-box) | None for ASP.NET Core | `Refit`, `Refit.HttpClientFactory` |
| Best for | One or two simple calls | Most server-side code | Many endpoints against one API |

The pattern in the table is that each column inherits the safety guarantees of the one to its left and adds ergonomics on top. The cost of moving right is a dependency and a little indirection, not correctness.

## When raw HttpClient is actually fine

There is a persistent myth that you must never use `HttpClient` directly. That is an overcorrection. A single, long-lived `HttpClient` shared across the whole application is a perfectly valid and well-supported pattern. The danger was never `HttpClient` itself, it was creating a new one per request inside a `using` block, which leaks sockets in `TIME_WAIT` and eventually exhausts the port range under load.

A static singleton avoids socket exhaustion, but it introduces a second, subtler problem: `HttpClient` resolves DNS only when it opens a connection, and a long-lived connection pool never re-resolves. If the target host fails over to a new IP, your singleton keeps hammering the old one. The fix, on .NET Core and .NET 5+, is to bound the connection lifetime on the handler:

```csharp
// .NET 11, C# 14 - a singleton that still picks up DNS changes
using System.Net;

var handler = new SocketsHttpHandler
{
    // Recycle pooled connections so DNS failover is respected
    PooledConnectionLifetime = TimeSpan.FromMinutes(2),
    AutomaticDecompression = DecompressionMethods.All
};

// Construct once, reuse for the entire process lifetime
var http = new HttpClient(handler)
{
    BaseAddress = new Uri("https://api.example.com")
};
```

Use this when you have a console tool, a small worker, or a library with no DI container and you make calls to one or two endpoints. The moment you have a DI container and more than a couple of clients, you are reimplementing `IHttpClientFactory` by hand, and you should stop and use the real thing.

## When IHttpClientFactory is the right default

For almost all server-side code in 2026, `IHttpClientFactory` is the baseline. It encapsulates the lifetime management described above so you do not have to think about `PooledConnectionLifetime` or DNS rotation: the factory pools `HttpMessageHandler` instances and rotates them on a configurable interval (two minutes by default), which gives you socket reuse and DNS freshness at the same time.

The bigger win is the message-handler pipeline. You can register cross-cutting concerns (auth headers, logging, correlation IDs, retries) as `DelegatingHandler` instances in DI, and every client built by the factory composes them in order. A typed client binds a configured `HttpClient` to a specific service class:

```csharp
// .NET 11, C# 14 - typed client registered through the factory
using Microsoft.Extensions.DependencyInjection;

builder.Services.AddHttpClient<GitHubService>(client =>
{
    client.BaseAddress = new Uri("https://api.github.com");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
})
.AddStandardResilienceHandler(); // Polly-backed retries, timeout, circuit breaker

public sealed class GitHubService(HttpClient client)
{
    public async Task<Repo?> GetRepoAsync(string owner, string name, CancellationToken ct)
    {
        // You still hand-write the path, the verb, and the deserialize
        return await client.GetFromJsonAsync<Repo>($"/repos/{owner}/{name}", ct);
    }
}

public record Repo(long Id, string FullName, int StargazersCount);
```

`AddStandardResilienceHandler` (from `Microsoft.Extensions.Http.Resilience` 10.6.0) stacks a rate limiter, total-request timeout, retry, circuit breaker, and per-attempt timeout with sane defaults. This is the modern replacement for hand-wiring Polly policies, and it is one line. If you are still seeing timeouts after adding it, the cause is usually a misconfigured per-attempt timeout rather than the handler itself, which is a common source of a [TaskCanceledException that a task was canceled](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

The one thing the factory does not do is write your request code. You still author the path, the HTTP verb, the query string, and the deserialization for every call. For one or two endpoints that is fine. For a REST API with thirty endpoints, that is thirty methods of nearly identical boilerplate, and that is exactly the gap Refit fills.

## When Refit earns its dependency

Refit turns a C# interface into a working REST client. You declare the shape of the API with attributes, and the Refit source generator emits the implementation at build time. There is no per-call request building and no manual deserialization:

```csharp
// .NET 11, C# 14, Refit 10.1.6 - the interface IS the client
using Refit;

public interface IGitHubApi
{
    [Get("/repos/{owner}/{name}")]
    Task<Repo> GetRepoAsync(string owner, string name, CancellationToken ct = default);

    [Get("/users/{user}/repos")]
    Task<IReadOnlyList<Repo>> GetUserReposAsync(string user, [Query] string sort = "updated");

    [Post("/repos/{owner}/{name}/issues")]
    Task<Issue> CreateIssueAsync(string owner, string name, [Body] NewIssue issue);
}

public record Repo(long Id, string FullName, int StargazersCount);
public record Issue(long Number, string Title);
public record NewIssue(string Title, string Body);
```

Register it against the same factory infrastructure with `Refit.HttpClientFactory`, so you keep every lifetime, DNS, and resilience guarantee from the layer below:

```csharp
// .NET 11, C# 14, Refit.HttpClientFactory 10.1.6
using Refit;
using Microsoft.Extensions.DependencyInjection;

builder.Services
    .AddRefitClient<IGitHubApi>()
    .ConfigureHttpClient(c =>
    {
        c.BaseAddress = new Uri("https://api.github.com");
        c.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
    })
    .AddStandardResilienceHandler(); // same resilience stack as a typed client
```

That is the entire client. Three interface methods replace what would be three hand-written methods plus their request-construction and parsing logic. For a codebase that talks to a large third-party API, the reduction in code you have to read and maintain is the whole argument. Refit also handles the awkward parts well: `[Query]` for query strings, `[Body]` with serialization, `[Header]` and `[Authorize]` for auth, multipart uploads, and `ApiResponse<T>` when you need the status code and headers rather than just the deserialized body.

Two practical notes for 2026. First, Refit 9.0.2 (November 2025) added Native AOT and trimming support for .NET 10 and later, so Refit is no longer disqualified from trimmed containers and scale-to-zero functions the way reflection-heavy clients are. For the AOT path, supply source-generated `System.Text.Json` metadata via a `JsonSerializerContext` so the serializer stays reflection-free, the same discipline covered in [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/). Second, if your API is described by an OpenAPI document, you do not even hand-write the interface: tooling can emit Refit interfaces from the spec, which overlaps with [generating a strongly-typed client from an OpenAPI spec](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## What the overhead actually is

The honest answer on performance is that for HTTP calls the network dominates and the choice between these three is in the noise. A round trip to a real API is measured in milliseconds to hundreds of milliseconds; the request-construction overhead is measured in microseconds. Picking Refit over a typed client to save CPU is optimizing the wrong layer.

That said, the overhead is not zero and it is worth knowing where it lives:

| Aspect | Raw / typed client | Refit |
| ------ | ------------------ | ----- |
| Per-call request build | Direct, hand-written | Generated, near-direct on .NET 8+ |
| Reflection at runtime | None | None with the source generator |
| Startup cost | None | One-time generated-stub registration |
| Allocation per call | Baseline | Comparable, attribute parsing is build-time |

The key methodological point: Refit moved to a Roslyn source generator (the `InterfaceStubGenerator`), so the interface analysis happens at compile time, not on every call. The old reflection-and-`Reflection.Emit` cost that AOT could not tolerate is gone. If you want a real number for your own object shapes, run BenchmarkDotNet against your DTOs rather than trusting a generic figure, but expect the delta between a typed client and a Refit client to be tens of nanoseconds against a network call that takes milliseconds. The decision is about code you maintain, not cycles you spend.

## The gotcha that picks for you

A few constraints settle the choice before preference enters the room.

**`new HttpClient()` per request is never the answer.** This is the one genuinely wrong pattern, and it is wrong for all three columns. It exhausts sockets under load even though `HttpClient` is `IDisposable` and looks like it wants a `using`. If you take one thing away, take this: construct `HttpClient` once, or let the factory construct it for you, but never per call.

**Singletons that capture a typed client defeat the factory.** Registering a typed client or a Refit client and then capturing it inside a singleton pins one handler forever, which means it stops rotating and stops seeing DNS changes, the exact problem the factory exists to solve. Inject the client where you use it, or inject `IHttpClientFactory` and create on demand. Do not stash it in a static field.

**Refit needs the response to match the contract.** Because deserialization is automatic, a response that does not match your record (a wrapped envelope, a different casing, an error body returned with a 200) surfaces as a deserialization failure rather than something you handle inline. Use `ApiResponse<T>` when you need to inspect status and headers, and configure the serializer the same way you would elsewhere. Testing these clients is also slightly different because there is no method body to mock; you mock the `HttpMessageHandler`, the same approach as [unit-testing code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/).

**Licensing is not a factor here.** Unlike some of the mapper and mediator debates in 2026, all three options are free and permissively licensed. `HttpClient` and `IHttpClientFactory` ship with .NET, and Refit is MIT. There is no commercial gate pushing you toward or away from any of them.

## The call, in one line

For new .NET 11 code in 2026: make `IHttpClientFactory` your default so lifetime, DNS, and resilience are handled for you, and add Refit on top when you are calling many endpoints against one API and want the request code generated rather than hand-written. Keep raw `HttpClient` for the genuinely simple case (a singleton with `PooledConnectionLifetime`, one or two calls, no DI), and never create one per request. These are not three rival libraries you choose between; they are three rungs of one ladder, and you climb to the rung that matches how much of the HTTP plumbing you want to stop writing yourself.

## Related

- [How to generate a strongly-typed client from an OpenAPI spec in .NET 11](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [How to unit-test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Fix: TaskCanceledException, a task was canceled in HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [System.Text.Json vs Newtonsoft.Json in 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## Sources

- [Use IHttpClientFactory to implement resilient HTTP requests](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-factory) - named and typed clients, handler lifetime, and the message-handler pipeline.
- [HttpClient guidelines for .NET](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines) - socket exhaustion, DNS, and the `PooledConnectionLifetime` pattern for singletons.
- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) - `AddStandardResilienceHandler` and the standard resilience stack.
- [Refit on GitHub](https://github.com/reactiveui/refit) - the source generator, attribute reference, and `Refit.HttpClientFactory` integration.
- [Refit.HttpClientFactory 10.1.6 on NuGet](https://www.nuget.org/packages/refit.httpclientfactory) - current stable version and target frameworks.
</content>
</invoke>
