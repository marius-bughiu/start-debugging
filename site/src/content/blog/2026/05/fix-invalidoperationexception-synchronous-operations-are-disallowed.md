---
title: "Fix: InvalidOperationException: Synchronous operations are disallowed"
description: "Replace the Stream.Read or Write call with ReadAsync/WriteAsync. As a last resort, set AllowSynchronousIO on Kestrel, IIS, or per-request via IHttpBodyControlFeature."
pubDate: 2026-05-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "aspnetcore-11"
  - "kestrel"
---

The fix: ASP.NET Core 3.0 and later disable synchronous reads and writes on `HttpRequest.Body` and `HttpResponse.Body` by default, so any code that calls `Stream.Read`, `Stream.Write`, `Stream.Flush`, `StreamReader.ReadToEnd`, `StreamWriter.Write`, or `JsonSerializer.Deserialize(stream)` will throw `InvalidOperationException: Synchronous operations are disallowed`. The clean fix is to switch the call to its async equivalent (`ReadAsync`, `WriteAsync`, `DeserializeAsync`) and await it. If you cannot change the caller, enable `AllowSynchronousIO = true` on Kestrel or IIS, or flip `IHttpBodyControlFeature.AllowSynchronousIO` on the offending request only.

```text
System.InvalidOperationException: Synchronous operations are disallowed. Call ReadAsync or set AllowSynchronousIO to true instead.
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpRequestStream.Read(Byte[] buffer, Int32 offset, Int32 count)
   at System.IO.Stream.CopyTo(Stream destination, Int32 bufferSize)
   at Newtonsoft.Json.JsonSerializer.DeserializeInternal(JsonReader reader, Type objectType)
   at MyApp.LegacyHandler.Parse(HttpRequest request)
```

This guide is written against ASP.NET Core 11 (`Microsoft.AspNetCore.App` 11.0.0-preview.4) and Kestrel 11.0.0-preview.4. The check has been in place since 3.0.0-preview3 (February 2019) and applies to Kestrel, HTTP.sys, IIS in-process, and `TestServer`. The exception text is identical across versions; only the default servers and the convenience APIs around it have changed.

## Why the server blocks synchronous I/O by default

Every blocked thread inside a request handler is a thread that is not available to the rest of the application. Synchronous `Stream.Read` on a slow client connection can park a thread-pool thread for seconds at a time. Under load, the pool runs out of threads, request latency spikes, and the process eventually appears hung even though the CPU is idle. This pattern, thread-pool starvation, was responsible for a long tail of production incidents in ASP.NET Core 1.x and 2.x where applications would freeze under bursty traffic.

The 3.0 release flipped `AllowSynchronousIO` from `true` to `false` across every built-in server. The runtime now actively rejects synchronous calls instead of letting them block silently. The exception is not a bug, it is the server telling you that the call would have blocked a thread for the duration of the network read or write. Once you understand that, the "fix" stops being "turn the check off" and starts being "stop blocking the thread".

The runtime team's announcement at [aspnetcore#7644](https://github.com/dotnet/aspnetcore/issues/7644) lists the affected servers and the recommended `IHttpBodyControlFeature` escape hatch.

## A minimal repro

```csharp
// ASP.NET Core 11, C# 14, Newtonsoft.Json 13.0.4
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapPost("/legacy", (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var json = reader.ReadToEnd();                      // throws
    return Results.Ok(json.Length);
});

app.Run();
```

`StreamReader.ReadToEnd` calls `Stream.Read` under the hood. Kestrel's `HttpRequestStream` overrides `Read` to throw immediately when `AllowSynchronousIO` is `false`. The same shape of error appears with any of these callers:

- `JsonSerializer.Deserialize<T>(request.Body)` from `System.Text.Json`.
- `JsonSerializer.Create().Deserialize(...)` from `Newtonsoft.Json` when handed `request.Body`.
- `request.Body.CopyTo(target)` for forwarding a request body.
- `response.Body.Write(buffer, 0, count)` from a custom middleware.
- `XmlSerializer.Deserialize(request.Body)`.
- Any third-party library that internally calls `Stream.Read` or `Stream.Write` on the request/response stream.

The stack trace is your friend here: read it bottom up to find the synchronous API that landed in the server stream.

## Fix 1: switch to the async API (recommended)

This is the only fix that actually solves the underlying problem. Almost every common API has an async sibling.

```csharp
// ASP.NET Core 11, C# 14
app.MapPost("/legacy", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var json = await reader.ReadToEndAsync();
    return Results.Ok(json.Length);
});
```

For JSON, prefer `System.Text.Json`'s streaming deserialiser, which never materialises the full payload as a string:

```csharp
// ASP.NET Core 11, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

app.MapPost("/orders", async (HttpRequest request) =>
{
    var order = await JsonSerializer.DeserializeAsync<Order>(
        request.Body,
        cancellationToken: request.HttpContext.RequestAborted);
    return Results.Ok(order);
});

record Order(string Sku, int Quantity);
```

If you are reading a model in a minimal API, the simplest fix is to let the framework bind it. `[FromBody]` parameters in minimal APIs and MVC both deserialise asynchronously, so the synchronous I/O check never fires.

```csharp
app.MapPost("/orders", (Order order) => Results.Ok(order));
```

For Newtonsoft.Json, the migration target is `System.Text.Json` and its async deserialiser. If you cannot migrate, read the body into a `MemoryStream` asynchronously first, then hand that buffer to Newtonsoft:

```csharp
// ASP.NET Core 11, Newtonsoft.Json 13.0.4
using Newtonsoft.Json;

app.MapPost("/legacy", async (HttpRequest request) =>
{
    using var ms = new MemoryStream();
    await request.Body.CopyToAsync(ms);
    ms.Position = 0;

    using var reader = new StreamReader(ms);
    using var jsonReader = new JsonTextReader(reader);
    var serializer = new JsonSerializer();
    var order = serializer.Deserialize<Order>(jsonReader);
    return Results.Ok(order);
});
```

Newtonsoft's synchronous `Deserialize` now operates on a `MemoryStream`, not on Kestrel's request stream, so the check passes. This pattern is also how you wrap synchronous-only third-party parsers. For long-term planning, see the [migration from Newtonsoft.Json to System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) angle.

## Fix 2: enable AllowSynchronousIO server-wide

If you are stuck on a library that has no async API at all, you can re-enable synchronous I/O on the server. This is a global escape hatch and should be paired with a tracked plan to remove it. The configuration depends on which server you run.

**Kestrel:**

```csharp
// ASP.NET Core 11
builder.WebHost.ConfigureKestrel(options =>
{
    options.AllowSynchronousIO = true;
});
```

**IIS in-process:**

```csharp
// ASP.NET Core 11
builder.Services.Configure<IISServerOptions>(options =>
{
    options.AllowSynchronousIO = true;
});
```

**HTTP.sys:**

```csharp
// ASP.NET Core 11
builder.WebHost.UseHttpSys(options =>
{
    options.AllowSynchronousIO = true;
});
```

The official Kestrel docs confirm the property is on `KestrelServerOptions` and defaults to `false`; see [Configure options for the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/options?view=aspnetcore-10.0#synchronous-io). Setting it everywhere makes the check disappear, but it also re-introduces the thread-starvation risk the default was added to prevent. Treat the flag as a label that says "I have not finished migrating to async yet", not as a permanent configuration.

## Fix 3: enable synchronous I/O on one request

If only one endpoint has a synchronous dependency, do not flip the server-wide switch. Use `IHttpBodyControlFeature` to opt in on that request alone, ideally inside middleware scoped to the exact route.

```csharp
// ASP.NET Core 11
using Microsoft.AspNetCore.Http.Features;

app.MapPost("/legacy/export", (HttpContext ctx) =>
{
    var feature = ctx.Features.Get<IHttpBodyControlFeature>();
    if (feature is not null)
    {
        feature.AllowSynchronousIO = true;
    }

    using var writer = new StreamWriter(ctx.Response.Body);
    writer.Write("<huge legacy XML payload>");
    return Results.Empty;
});
```

The feature must be flipped before the first call that would otherwise throw. If you read the body first and then set the flag, the read has already failed. For MVC, the equivalent is a filter that runs on `OnActionExecuting` and toggles the feature before the model binder reads the body.

This per-request approach keeps the rest of the application protected by the default. It is the right answer when you have one legacy endpoint surrounded by modern async ones.

## Gotchas and lookalikes

**The exception sometimes wraps a different complaint.** A response with `Response.Body.Write(...)` after `await Response.WriteAsync(...)` can throw the same exception even though the developer thought everything was async; the issue is usually a hidden `Flush` call inside a logger or a `JsonSerializer` that does not accept the cancellation token. Read the full stack trace, not just the top frame.

**`HttpRequest.ReadFormAsync` is the safe form for form data.** A common path into this error is `request.Form["..."]`, which is a synchronous accessor that internally calls `Read`. Switch to `await request.ReadFormAsync()` and then access the resulting `IFormCollection`.

**Logging middleware that calls `Response.Body.Seek` or `CopyTo`.** Custom response-capture middleware almost always trips this check. Replace `CopyTo` with `CopyToAsync` and swap any blocking reads on the wrapper stream for the async overloads.

**The check does not fire under TestServer in some scenarios.** `TestServer` does not always set up the same `IHttpBodyControlFeature` as Kestrel. Code that works in tests can throw in production. Run a smoke test against Kestrel locally before shipping.

**Setting `AllowSynchronousIO = true` does not silence every async-related error.** It only changes the synchronous I/O check. `TaskCanceledException` from a client disconnect is a different problem; see the post on [TaskCanceledException: A task was canceled in HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) for that family of errors.

**JSON-specific lookalikes.** A `JsonException: The JSON value could not be converted to System.DateTime` is a deserialisation format error, not an I/O error, even though both surface inside a request handler. If your stack frame ends in `System.Text.Json`, see the [DateTime deserialisation guide](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) instead.

**`DisposeAsync` matters.** Calling synchronous `Dispose` on a stream that the server has handed you can implicitly call `Flush`, which is a write. Use `await using` for any stream you obtain from `HttpContext`.

```csharp
// ASP.NET Core 11
await using var writer = new StreamWriter(response.Body);
await writer.WriteAsync("done");
```

The `await using` pattern is one of those small habits that pays for itself the first time it saves a request from this exception.

## Related

- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) covers the async patterns the runtime expects when you write large responses.
- [How to upload a large file with streaming to Azure Blob Storage](/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) is the matching write-side guide.
- [How to unit-test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/) shows the async test plumbing you want around any handler that touches request or response bodies.
- [Fix: A second operation was started on this context instance before a previous operation completed](/2026/05/fix-second-operation-was-started-on-this-context-instance/) is the EF Core cousin of this error: another case where the runtime catches a sync-over-async mistake.
- [Fix: TaskCanceledException: A task was canceled in HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) for the related client-side timeout family.

## Sources

- [Configure options for the ASP.NET Core Kestrel web server, Synchronous I/O](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/options?view=aspnetcore-10.0#synchronous-io) (MS Learn, .NET 10 / 11)
- [Announcement: AllowSynchronousIO disabled in all servers, dotnet/aspnetcore#7644](https://github.com/dotnet/aspnetcore/issues/7644)
- [ASP.NET Core breaking changes for versions 3.0 and 3.1](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnetcore)
- [`KestrelServerOptions.AllowSynchronousIO` API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.server.kestrel.core.kestrelserveroptions.allowsynchronousio)
- [`IHttpBodyControlFeature` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.features.ihttpbodycontrolfeature)
