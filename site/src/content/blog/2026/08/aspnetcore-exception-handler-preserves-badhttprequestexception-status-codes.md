---
title: "ASP.NET Core Stops Turning 413 Into 500 in UseExceptionHandler"
description: "A PR merged into dotnet/aspnetcore main on August 19, 2026 makes ExceptionHandlerMiddleware honour BadHttpRequestException.StatusCode instead of overwriting it with 500."
pubDate: 2026-08-20
tags:
  - "aspnetcore"
  - "dotnet"
  - "error-handling"
  - "dotnet-11"
---

If you run `app.UseExceptionHandler()` in production, every request that Kestrel rejects for being too large has been showing up in your telemetry as a server fault. [PR #68632](https://github.com/dotnet/aspnetcore/pull/68632) landed in `dotnet/aspnetcore` `main` on August 19, 2026 and fixes that. It closes [issue #43831](https://github.com/dotnet/aspnetcore/issues/43831), filed in September 2022.

## The 500 that was really a 413

`ExceptionHandlerMiddleware` sets the response status code before it invokes your handler, and until this PR it hardcoded 500 whenever `ExceptionHandlerOptions.StatusCodeSelector` was null. `BadHttpRequestException` carries its own `StatusCode`, and that value was thrown away.

Here is the shape of it, verified against ASP.NET Core 10.0.0 on SDK 10.0.201:

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 100);

var app = builder.Build();
app.UseExceptionHandler();

app.MapPost("/upload", async (HttpContext ctx) =>
{
    using var ms = new MemoryStream();
    await ctx.Request.Body.CopyToAsync(ms);   // throws when the body exceeds 100 bytes
    return Results.Ok(ms.Length);
});

app.Run();
```

Post 500 bytes to `/upload`. The exception that reaches the middleware is `BadHttpRequestException` with `StatusCode = 413` and the message "Request body too large. The max request body size is 100 bytes." The response you actually get back is:

```
HTTP/1.1 500 Internal Server Error
Content-Type: application/problem+json

{"type":"https://tools.ietf.org/html/rfc9110#section-15.6.1",
 "title":"An error occurred while processing your request.","status":500,...}
```

The client is told it broke the server. Your 5xx dashboards agree. This is the same class of confusion behind [413 Request Entity Too Large on file uploads](/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/), except here the correct status never reaches the wire at all.

## What changed

The middleware now pattern-matches the exception before falling back to 500:

```csharp
context.Response.StatusCode = _options.StatusCodeSelector?.Invoke(edi.SourceException)
    ?? (edi.SourceException switch
    {
        BadHttpRequestException badHttpRequestException => badHttpRequestException.StatusCode,
        _ => DefaultStatusCode,
    });
```

Three details worth knowing. `StatusCodeSelector` still wins if you set one, so existing overrides keep their behaviour. Custom `ExceptionHandler` delegates and `IExceptionHandler` services can still change the code afterwards. And a 404 carried by a `BadHttpRequestException` is now treated as deliberate rather than as a misconfigured handler, so it no longer needs `AllowStatusCode404Response = true` to survive.

The scope is narrow on purpose: only `BadHttpRequestException` is remapped. Calling `Request.ReadFormAsync()` with a `text/plain` body throws `InvalidOperationException` ("Incorrect Content-Type"), and that still returns 500 both before and after. Minimal API model binding is unaffected too, because a malformed JSON body is turned into a bare 400 by the request delegate before any exception escapes.

At the time of writing the commit is in `main` only. It is not in the `release/11.0-rc1` branch, so expect it in a later .NET 11 build rather than RC1. If you are on .NET 8 through 11 today, the workaround remains a `StatusCodeSelector` that unwraps the exception yourself.
