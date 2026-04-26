---
title: "How to unit-test code that uses HttpClient"
description: "A complete guide to testing HttpClient in .NET 11: why you should not mock HttpClient directly, how to write a stub HttpMessageHandler, swapping the primary handler with IHttpClientFactory, verifying Polly retries, and the WireMock.Net option."
pubDate: 2026-04-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "testing"
  - "httpclient"
---

To unit-test code that talks to an HTTP API, do not mock `HttpClient` itself. Replace its `HttpMessageHandler` with a stub that returns the response you want to fake, then inject the resulting `HttpClient` (or an `IHttpClientFactory` that hands one out) into the class under test. The handler is the seam, not the client. Everything below targets .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14) with xUnit 2.9, but the pattern is unchanged on .NET 6, 8, 9, and 10.

## Why mocking HttpClient directly is the wrong move

`HttpClient` has a public surface (`GetAsync`, `PostAsync`, `SendAsync`) that looks mockable, and Moq will let you new up a mock without complaining. The trouble is what those methods actually do: every one of them funnels into `HttpMessageInvoker.SendAsync(HttpRequestMessage, CancellationToken)` on the underlying `HttpMessageHandler`. The convenience methods on `HttpClient` itself are not `virtual`, which means a `Mock<HttpClient>` either does not intercept them at all or relies on tools like Moq's `Protected()` to reach into private internals.

Two practical consequences:

1. Tests that mock `HttpClient.GetAsync` directly silently bypass the handler pipeline. Anything you wired into `IHttpClientFactory`, retry handlers, logging handlers, authentication handlers, never runs in the test, so a green test can ship a broken handler chain.
2. If you change from `GetAsync` to `Send`, the test breaks even though the behaviour is identical.

The official Microsoft guidance, every reasonable Stack Overflow answer since 2018, and the source of `HttpClient` itself all point to the same seam: substitute the `HttpMessageHandler`. The handler has exactly one method to override (`SendAsync`), it is `protected internal virtual`, and it is the contract every other piece of the pipeline already targets.

## A minimal stub handler

The simplest implementation is a class that wraps a delegate. No mocking framework required:

```csharp
// .NET 11, C# 14
public sealed class StubHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _handler;
    public List<HttpRequestMessage> Requests { get; } = new();

    public StubHttpMessageHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler)
    {
        _handler = handler;
    }

    public StubHttpMessageHandler(HttpStatusCode status, string? body = null, string mediaType = "application/json")
        : this((_, _) => Task.FromResult(new HttpResponseMessage(status)
        {
            Content = body is null ? null : new StringContent(body, Encoding.UTF8, mediaType),
        }))
    {
    }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        Requests.Add(request);
        return _handler(request, cancellationToken);
    }
}
```

Two constructors cover most tests: a delegate constructor for tests that need to inspect the request, and a status/body shortcut for the trivial "return 200 with this JSON" case. The `Requests` list lets the test assert what was sent.

## The class under test

To make the rest concrete, here is the typical shape of code people want to test:

```csharp
// .NET 11, C# 14
public sealed record Repo(int Id, string Name, int Stars);

public sealed class GitHubClient
{
    private readonly HttpClient _http;

    public GitHubClient(HttpClient http) => _http = http;

    public async Task<Repo> GetRepoAsync(string owner, string name, CancellationToken ct = default)
    {
        var path = $"/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(name)}";
        using var response = await _http.GetAsync(path, ct);
        response.EnsureSuccessStatusCode();

        var dto = await response.Content.ReadFromJsonAsync<RepoDto>(ct);
        return new Repo(dto!.Id, dto.Full_Name, dto.Stargazers_Count);
    }

    private sealed record RepoDto(int Id, string Full_Name, int Stargazers_Count);
}
```

The constructor takes an `HttpClient`, not a static reference and not a freshly newed-up one. That single design choice is what makes everything below possible.

## A test that returns a canned response

```csharp
// .NET 11, C# 14, xUnit 2.9
[Fact]
public async Task GetRepoAsync_returns_parsed_repo_when_api_returns_200()
{
    var json = """
    { "id": 42, "full_name": "octocat/hello-world", "stargazers_count": 1300 }
    """;

    var handler = new StubHttpMessageHandler(HttpStatusCode.OK, json);
    var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com") };
    var sut = new GitHubClient(http);

    var repo = await sut.GetRepoAsync("octocat", "hello-world");

    Assert.Equal(42, repo.Id);
    Assert.Equal("octocat/hello-world", repo.Name);
    Assert.Equal(1300, repo.Stars);

    var sent = Assert.Single(handler.Requests);
    Assert.Equal(HttpMethod.Get, sent.Method);
    Assert.Equal("/repos/octocat/hello-world", sent.RequestUri!.AbsolutePath);
}
```

Three things to notice. The handler is constructed with a status and a body, the `HttpClient` is constructed with that handler and a `BaseAddress`, and the test asserts both the parsed result and the outgoing request. The third assertion is the one most tests skip and the one that catches the most regressions, a wrong path, a forgotten header, a body that is empty when it should not be.

## Returning different responses per request

For a class that issues several calls (paginated list, retry, conditional GET), pass a delegate:

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_throws_on_404()
{
    var handler = new StubHttpMessageHandler((req, _) =>
        Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
        {
            RequestMessage = req,
            Content = new StringContent("""{ "message": "Not Found" }""", Encoding.UTF8, "application/json"),
        }));

    var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com") };
    var sut = new GitHubClient(http);

    await Assert.ThrowsAsync<HttpRequestException>(() => sut.GetRepoAsync("octocat", "ghost"));
}
```

For sequential responses (first call returns 401, second call returns 200 after a token refresh), keep a counter inside the delegate:

```csharp
// .NET 11, C# 14
var calls = 0;
var handler = new StubHttpMessageHandler((req, _) =>
{
    var status = calls++ == 0 ? HttpStatusCode.Unauthorized : HttpStatusCode.OK;
    return Task.FromResult(new HttpResponseMessage(status)
    {
        Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                    Encoding.UTF8, "application/json"),
    });
});
```

This is enough for almost every unit-test scenario. No mocking framework, no protected member trickery, no ceremony.

## The Moq variant, and why I avoid it

If your codebase already standardises on Moq, the equivalent is:

```csharp
// .NET 11, C# 14, Moq 4.20
var handler = new Mock<HttpMessageHandler>(MockBehavior.Strict);
handler
    .Protected()
    .Setup<Task<HttpResponseMessage>>(
        "SendAsync",
        ItExpr.IsAny<HttpRequestMessage>(),
        ItExpr.IsAny<CancellationToken>())
    .ReturnsAsync(new HttpResponseMessage(HttpStatusCode.OK)
    {
        Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                    Encoding.UTF8, "application/json"),
    });

var http = new HttpClient(handler.Object) { BaseAddress = new Uri("https://api.github.com") };
```

It works. The downsides:

- `"SendAsync"` is a string. If the framework ever renames it (it will not, but the principle stands), the compiler will not catch it.
- `Protected()` requires `using Moq.Protected;` and forces every developer reading the test to know the trick.
- Returning a single `HttpResponseMessage` from a singleton mock setup leaks state across calls if the response is enumerated more than once. The stub handler in the previous section creates a fresh response per call.

For one-off tests Moq is fine. For a test class with five HTTP scenarios, the hand-rolled stub is shorter, faster to read, and easier to debug.

## Testing through IHttpClientFactory

In production code that uses `IHttpClientFactory` (and most modern code does), the unit under test takes an `IHttpClientFactory` or a typed client, and the factory builds an `HttpClient` with whatever handler chain you registered in `Program.cs`. The test seam moves from "construct an `HttpClient` directly" to "configure the factory's primary handler".

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http 11.0
[Fact]
public async Task TypedClient_uses_registered_handler_chain()
{
    var stub = new StubHttpMessageHandler(HttpStatusCode.OK,
        """{ "id": 7, "full_name": "a/b", "stargazers_count": 5 }""");

    using var provider = new ServiceCollection()
        .AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
        .ConfigurePrimaryHttpMessageHandler(() => stub)
        .Services
        .BuildServiceProvider();

    var sut = provider.GetRequiredService<GitHubClient>();

    var repo = await sut.GetRepoAsync("a", "b");
    Assert.Equal(7, repo.Id);
}
```

`ConfigurePrimaryHttpMessageHandler` swaps the bottom of the chain. Every other handler you registered (logging, retry, auth) still runs, which is the whole point. If you want to replace the entire chain (you almost never do), use `AddHttpMessageHandler` plus a stub handler at the end, or build the `HttpClient` manually as in the earlier examples.

## Verifying a Polly retry actually retried

This is the test that Moq makes painful and the stub handler makes trivial. Suppose your `Program.cs` registers:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 9.0
builder.Services.AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
    .AddStandardResilienceHandler();
```

The standard resilience handler retries 5xx and timeout errors three times by default. To prove it under test:

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_retries_on_503()
{
    var calls = 0;
    var handler = new StubHttpMessageHandler((_, _) =>
    {
        calls++;
        var status = calls < 3 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK;
        return Task.FromResult(new HttpResponseMessage(status)
        {
            Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                        Encoding.UTF8, "application/json"),
        });
    });

    using var provider = new ServiceCollection()
        .AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
        .AddStandardResilienceHandler()
        .Services
        .ConfigureAll<HttpClientFactoryOptions>(o => o.HttpMessageHandlerBuilderActions.Add(b =>
            b.PrimaryHandler = handler))
        .BuildServiceProvider();

    var sut = provider.GetRequiredService<GitHubClient>();
    var repo = await sut.GetRepoAsync("x", "y");

    Assert.Equal(3, calls);
    Assert.Equal(1, repo.Id);
}
```

The assertion `Assert.Equal(3, calls)` is what makes this an integration of-the-handler-chain test. A pure mock of `HttpClient.GetAsync` would not have invoked Polly at all and the assertion would have read `calls == 1`, which is the silent failure I warned about earlier.

## Cancellation and timeout

Cancellation is straightforward: the stub handler receives the `CancellationToken` and you can have it observe it.

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_propagates_cancellation()
{
    var handler = new StubHttpMessageHandler(async (_, ct) =>
    {
        await Task.Delay(TimeSpan.FromSeconds(5), ct);
        return new HttpResponseMessage(HttpStatusCode.OK);
    });

    var http = new HttpClient(handler) { BaseAddress = new Uri("https://x") };
    var sut = new GitHubClient(http);

    using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));

    await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        sut.GetRepoAsync("a", "b", cts.Token));
}
```

`HttpClient.Timeout` itself surfaces as a `TaskCanceledException` (with a `TimeoutException` inner since .NET 5). If you want to test timeout behaviour, set `http.Timeout = TimeSpan.FromMilliseconds(50)` and have the handler `await Task.Delay` longer than that. See [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) for the cooperative-cancellation patterns the production code should already follow.

## Asserting on request bodies

For `POST` and `PUT`, capture and read the request content inside the handler delegate:

```csharp
// .NET 11, C# 14
string? captured = null;
var handler = new StubHttpMessageHandler(async (req, ct) =>
{
    captured = req.Content is null ? null : await req.Content.ReadAsStringAsync(ct);
    return new HttpResponseMessage(HttpStatusCode.Created);
});
```

Read the body inside the handler, not after. Once `SendAsync` returns, the request stream may be disposed.

## Headers, query strings, and base addresses

`BaseAddress` plus a relative path is the cleanest setup, but watch the trailing slash. `new Uri("https://api.example.com/v1")` plus a request to `/users` discards `/v1` because the URI has no trailing slash. `https://api.example.com/v1/` plus `users` (no leading slash) gives you `/v1/users`. Test it:

```csharp
// .NET 11, C# 14
Assert.Equal("/v1/users", handler.Requests[0].RequestUri!.AbsolutePath);
```

Default headers go on the `HttpClient`, not on each request, and they are visible to the handler:

```csharp
// .NET 11, C# 14
http.DefaultRequestHeaders.Add("User-Agent", "start-debugging/1.0");
// in the handler:
Assert.Contains("start-debugging/1.0", req.Headers.UserAgent.ToString());
```

## When to reach for WireMock.Net instead

The stub handler approach is a unit test, no socket, no real HTTP. For component or integration tests that exercise the actual HTTP stack (TLS, content negotiation, real chunked transfer, server-sent timeouts) reach for [WireMock.Net](https://github.com/WireMock-Net/WireMock.Net):

```csharp
// .NET 11, C# 14, WireMock.Net 1.6
using var server = WireMockServer.Start();
server
    .Given(Request.Create().WithPath("/repos/octocat/hello-world").UsingGet())
    .RespondWith(Response.Create()
        .WithStatusCode(200)
        .WithHeader("Content-Type", "application/json")
        .WithBody("""{ "id": 42, "full_name": "octocat/hello-world", "stargazers_count": 1300 }"""));

var http = new HttpClient { BaseAddress = new Uri(server.Url!) };
var sut = new GitHubClient(http);
var repo = await sut.GetRepoAsync("octocat", "hello-world");
```

WireMock.Net runs an actual HTTP server on a localhost port. Slower than a stub handler, more realistic, more fragile (port conflicts, TLS, async startup). I use it for tests that need to verify behaviour the framework only does for real sockets, otherwise the stub handler is faster and quieter. For a comparable approach to mocking other dependencies see [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), which the deserialization step in `GetRepoAsync` already relies on.

## Mistakes that show up in code reviews

A short list of things I have flagged on more than one PR:

- Constructing `HttpClient` inside the class under test (`private readonly HttpClient _http = new();`). The test cannot inject a fake handler, so the test calls a real network or fails. Take the dependency.
- Using `MockBehavior.Loose` on the `HttpMessageHandler` mock and then forgetting to verify the request. The test passes when the production code never calls the API at all.
- Returning the same `HttpResponseMessage` instance from multiple test calls. The content stream is read-once, so the second call sees an empty body. Either build a fresh response per call (delegate constructor), or copy the body into a fresh `StringContent`.
- Asserting on `response.StatusCode` instead of behaviour. The point of the test is what `GetRepoAsync` does with a 503, not that an `HttpResponseMessage` literal you constructed has the status code you constructed it with.
- Mocking through `Mock<HttpClient>` directly. As covered above, this skips the handler chain and silently breaks resilience or auth handlers.

The handler is the seam, the rest follows. If your test needs Moq, NSubstitute, FakeItEasy, or WireMock, fine, but configure the seam, not the surface.

## Source links

- [HttpMessageHandler.SendAsync (MS Learn)](https://learn.microsoft.com/dotnet/api/system.net.http.httpmessagehandler.sendasync)
- [IHttpClientFactory guidance (MS Learn)](https://learn.microsoft.com/dotnet/core/extensions/httpclient-factory)
- [ConfigurePrimaryHttpMessageHandler (MS Learn)](https://learn.microsoft.com/dotnet/api/microsoft.extensions.dependencyinjection.httpclientbuilderextensions.configureprimaryhttpmessagehandler)
- [Microsoft.Extensions.Http.Resilience](https://learn.microsoft.com/dotnet/core/resilience/http-resilience)
- [WireMock.Net](https://github.com/WireMock-Net/WireMock.Net)
