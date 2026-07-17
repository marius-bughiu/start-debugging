---
title: "Fix: System.InvalidOperationException: Headers are read-only, response has already started"
description: "You set a header, status code, or content type after the body was already flushed. Set all headers before the first write, or guard with HttpResponse.HasStarted and OnStarting."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "aspnetcore-11"
---

The fix: something already wrote to the response body, which flushed the headers to the client and made them read-only, and then your code tried to set a header, status code, or content type. In ASP.NET Core, `HttpResponse.StatusCode`, `HttpResponse.ContentType`, and everything in `HttpResponse.Headers` must be set **before** the first byte of the body is written. Move all header and status assignments ahead of any `WriteAsync`, `Redirect`, or downstream middleware that writes the body. When you cannot control the ordering, guard the assignment with `if (!context.Response.HasStarted)` or register the work in `HttpResponse.OnStarting` so it runs the instant before headers flush. This guide is written against ASP.NET Core 11 (`Microsoft.AspNetCore.App` 11.0.0-preview.4), C# 14, and Kestrel 11.0.0-preview.4; the behaviour is identical back to ASP.NET Core 3.0.

```text
System.InvalidOperationException: Headers are read-only, response has already started.
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpResponseHeaders.ThrowHeadersReadOnlyException()
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpHeaders.Microsoft.AspNetCore.Http.IHeaderDictionary.set_Item(String key, StringValues value)
   at MyApp.SecurityHeadersMiddleware.InvokeAsync(HttpContext context)
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpProtocol.ProcessRequests[TContext](IHttpApplication`1 application)
```

The stack trace almost always ends in `ThrowHeadersReadOnlyException` inside Kestrel (or the equivalent in HTTP.sys and IIS). The frame directly above it is the line that tried the mutation. That frame is your culprit: it is setting a header, `StatusCode`, `ContentType`, or calling `Redirect` after the response has already begun.

## Why setting a header after the first write is impossible

HTTP is ordered on the wire: status line, then headers, then a blank line, then the body. Once the server has sent the header block to the client, it cannot un-send it. ASP.NET Core models this by making the header collection read-only the moment the response starts, and it throws rather than silently dropping your change, because a silently ignored security header or content type is a far worse bug than a loud exception.

Two things start the response. The docs put it plainly: "An app can't modify headers after the response has started. Once the response starts, the headers are sent to the client. A response is started by flushing the response body or calling `HttpResponse.StartAsync(CancellationToken)`." The first of those is the one that bites people, because it is implicit. Writing the body flushes it: "Unless response buffering is enabled, all write operations (for example, `WriteAsync`) flush the response body internally and mark the response as started. Response buffering is disabled by default." So the first `WriteAsync`, the first `CopyToAsync` into `Response.Body`, the first `FlushAsync` on `Response.BodyWriter`, and returning a result that streams content all flip `HttpResponse.HasStarted` to `true` and freeze the headers.

That is why `HttpResponse.StatusCode`, `HttpResponse.ContentType`, and `HttpResponse.Headers` are each documented as "Must be set before writing to the response body." They are not advisory notes. They are the contract, and the exception is the enforcement.

## A minimal repro

The smallest version writes the body, then tries to set a header:

```csharp
// ASP.NET Core 11, C# 14
using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/broken", async (HttpContext context) =>
{
    await context.Response.WriteAsync("Processing...");   // flushes: HasStarted is now true
    context.Response.Headers["X-Trace-Id"] = "abc123";     // throws: headers are read-only
});

app.Run();
```

The `WriteAsync` call flushes the body and sends the headers. The next line tries to add `X-Trace-Id`, and Kestrel throws `InvalidOperationException: Headers are read-only, response has already started`. The same shape appears with a status code:

```csharp
// ASP.NET Core 11, C# 14
app.MapGet("/broken-status", async (HttpContext context) =>
{
    await context.Response.WriteAsync("partial output");
    context.Response.StatusCode = 500;   // throws for the same reason
});
```

And it appears with a redirect, because `Redirect` sets both the `Location` header and a 302 status:

```csharp
// ASP.NET Core 11, C# 14
app.MapGet("/broken-redirect", async (HttpContext context) =>
{
    await context.Response.WriteAsync("about to redirect");
    context.Response.Redirect("/login");   // throws: Location header is read-only
});
```

## Reorder so headers come first

The primary fix, and the one to reach for whenever the code is under your control, is to set every header, the status code, and the content type before you write anything to the body. In an endpoint or controller this is usually a one-line move:

```csharp
// ASP.NET Core 11, C# 14 -- correct order
app.MapGet("/fixed", async (HttpContext context) =>
{
    context.Response.StatusCode = 200;
    context.Response.ContentType = "text/plain";
    context.Response.Headers["X-Trace-Id"] = "abc123";   // set before any write

    await context.Response.WriteAsync("Processing...");  // now safe to flush
});
```

Prefer returning an `IResult` (minimal APIs) or an `IActionResult` (MVC) over writing to `Response.Body` by hand. `Results.Text`, `Results.Json`, `Results.File`, and `TypedResults` build the whole response, headers included, and only then write, so they never trip this error. Reaching for [a typed Results union from a minimal API endpoint](/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) keeps status and headers declarative and removes the manual ordering hazard entirely.

## Guard middleware with HasStarted

The harder case is middleware that runs `await next(context)` and then wants to touch the response. By the time `next` returns, a downstream endpoint has usually already written the body, so the response has started and any header change throws. This is the single most common source of the error, and the classic offender is a "security headers" or "correlation id" middleware written like this:

```csharp
// ASP.NET Core 11, C# 14 -- broken middleware
app.Use(async (context, next) =>
{
    await next(context);   // endpoint writes the body here; response starts
    context.Response.Headers["X-Frame-Options"] = "DENY";   // throws
});
```

There are two correct patterns, and the choice depends on whether you must set the header unconditionally.

**Register the work in `OnStarting`.** `HttpResponse.OnStarting` takes a callback that the server runs exactly once, right before it flushes the headers, whether the body is written by your middleware or by anything downstream. Register it before calling `next`, and the header is written at the last safe moment:

```csharp
// ASP.NET Core 11, C# 14 -- correct: set headers just before they flush
app.Use(async (context, next) =>
{
    context.Response.OnStarting(() =>
    {
        context.Response.Headers["X-Frame-Options"] = "DENY";
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        return Task.CompletedTask;
    });

    await next(context);
});
```

This is the right tool for cross-cutting response headers, because it works even when the downstream code starts streaming immediately. It is the same mechanism ASP.NET Core's own header middleware uses internally.

**Guard with `HasStarted`.** When the header only matters if the response has not already committed (for example, an exception handler that wants to turn a failure into a 500), check `HttpResponse.HasStarted` first and skip the mutation when it is `true`:

```csharp
// ASP.NET Core 11, C# 14 -- defensive guard
app.Use(async (context, next) =>
{
    try
    {
        await next(context);
    }
    catch (Exception)
    {
        if (!context.Response.HasStarted)
        {
            context.Response.Clear();
            context.Response.StatusCode = 500;
            await context.Response.WriteAsync("Something went wrong.");
        }
        throw;   // nothing safe to do if the response already started
    }
});
```

`HttpResponse.Clear()` resets the status code, headers, and any buffered body, but only works while `HasStarted` is `false`. Once the body has begun streaming, there is genuinely nothing you can do to change the status or headers, and the honest move is to let the exception propagate or call `HttpContext.Abort()` to sever the connection so the client sees a broken response rather than a lie. This is why the built-in exception handler and [a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) both check `HasStarted` before writing a problem-details body and rethrow when it is already too late.

## Buffer the body when middleware must rewrite it

Some middleware genuinely needs to read or transform the downstream response, minifying HTML, injecting a script tag, or compressing content, and only then set a `Content-Length` or `Content-Encoding` header. You cannot do that if the body has already flushed to the client. The fix is to swap the response body for a buffer, let downstream write into the buffer, then set your headers and copy the buffer to the real body:

```csharp
// ASP.NET Core 11, C# 14 -- buffer downstream output, then set headers
app.Use(async (context, next) =>
{
    var originalBody = context.Response.Body;
    using var buffer = new MemoryStream();
    context.Response.Body = buffer;

    await next(context);   // downstream writes into the MemoryStream, not the socket

    // Response has NOT started: the real body was never touched.
    context.Response.Headers["Content-Length"] = buffer.Length.ToString();
    buffer.Position = 0;
    context.Response.Body = originalBody;
    await buffer.CopyToAsync(originalBody);
});
```

Because the downstream write went into a `MemoryStream` and not into the connection, `HasStarted` stays `false` and the header assignments succeed. This is the manual version of what response-transforming middleware does; the framework-supported route is to work through `IHttpResponseBodyFeature` rather than assigning `Response.Body` directly, but the buffering principle is the same. If your goal is specifically compression, do not hand-roll this: reach for [response compression in an ASP.NET Core 11 API](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/), which handles the negotiation and the `Content-Encoding` header for you without buffering the whole response into memory.

## Gotchas and lookalikes

**`Response.Redirect` counts as a header write.** A redirect sets the `Location` header and a 3xx status, so calling it after any body write throws exactly this exception. If you find yourself redirecting from inside an action that has already written output, the real bug is that the decision to redirect was made too late; move it above the first write.

**Streaming endpoints have a tiny header window.** When you [stream a file from an endpoint without buffering](/2026/07/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/), the response starts the moment the first chunk flushes. Any `Content-Disposition` or `Content-Type` you want must be set before that first `WriteAsync`. If an error occurs mid-stream you cannot switch to a 500, because the 200 header block is already on the wire; the connection just terminates. Design streaming handlers to validate everything and set all headers up front.

**This is not the synchronous-I/O error.** `Headers are read-only, response has already started` is about *ordering*, not about sync versus async. If your message instead reads `Synchronous operations are disallowed`, that is a different problem with a different fix, covered in [InvalidOperationException: Synchronous operations are disallowed](/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed). Do not confuse the two; switching `WriteAsync` to `Write` will not help here and reordering will not help there.

**Blazor and Identity surface it indirectly.** Interactive Blazor components and ASP.NET Core Identity flows sometimes trigger this from framework code, typically when a component tries to set a cookie or redirect after rendering has begun, or when a render-mode mismatch forces output before authentication runs. If the stack trace points into Blazor rendering rather than your own middleware, check for a `NavigationManager.NavigateTo` or a cookie write happening after the first render, and see [a render mode is not supported by the parent component's render mode](/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor) for the adjacent render-mode issue.

**Middleware order decides who wins.** A header-setting middleware only works if it registers its `OnStarting` callback, or sets its headers, before the terminal middleware writes the body. If your custom header middleware sits *after* `UseStaticFiles` or the endpoint middleware in the pipeline for the paths that hit it, it is already too late. Register cross-cutting response middleware early in `Program.cs`.

**Double writes in exception paths.** A frequent production trigger is code that writes a partial success response, then hits an exception and an outer handler tries to overwrite it with an error. The first write already started the response. Validate and gather everything that can fail before you write the first byte, so the write is the last thing the handler does, not the first.

## Related

- [How to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) shows the `HasStarted` guard in a real exception handler.
- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/07/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) explains exactly when a streamed response commits its headers.
- [How to add response compression to an ASP.NET Core 11 API](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) is the supported way to transform the body without hand-buffering.
- [How to return a typed Results union from a minimal API endpoint](/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) keeps status and headers declarative so ordering can't go wrong.
- [Fix: InvalidOperationException: Synchronous operations are disallowed](/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed) is the other InvalidOperationException that looks similar but isn't.

## Sources

- [Use HttpContext in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/use-http-context?view=aspnetcore-10.0), Microsoft Learn, for the rule that headers, `StatusCode`, and `ContentType` must be set before writing, the exact exception text, and the note that `WriteAsync` flushes and starts the response because buffering is off by default.
- [HttpResponse.HasStarted](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresponse.hasstarted), .NET API docs, on detecting whether the response has committed.
- [HttpResponse.OnStarting](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresponse.onstarting), .NET API docs, for registering work that runs just before headers flush.
- [Write custom ASP.NET Core middleware](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/write?view=aspnetcore-10.0), Microsoft Learn, on the pipeline ordering that determines who writes the body first.
