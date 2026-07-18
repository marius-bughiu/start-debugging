---
title: "Fix: \"413 Request Entity Too Large\" when uploading a file to an ASP.NET Core endpoint"
description: "Kestrel caps request bodies at 30,000,000 bytes by default and returns 413 when you exceed it. Raise MaxRequestBodySize globally, per endpoint, or in web.config behind IIS."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "file-upload"
---

An upload returns `413 Request Entity Too Large` because Kestrel caps every request body at 30,000,000 bytes (about 28.6 MiB) by default, and your file is bigger. Raise the limit where it actually applies: set `MaxRequestBodySize` on Kestrel globally, apply `[RequestSizeLimit]` or `[DisableRequestSizeLimit]` on a controller action, bump `FormOptions.MultipartBodyLengthLimit` for form posts, and behind IIS raise `maxAllowedContentLength` in `web.config`. Verified against ASP.NET Core 11 on .NET 11 with C# 14; the limits and defaults are identical from .NET 8 through .NET 11.

## The error in context

There are two ways this surfaces. The first is the HTTP response the client sees:

```
HTTP/1.1 413 Request Entity Too Large
Content-Length: 0
Connection: close
Date: Fri, 17 Jul 2026 10:04:11 GMT
```

The second is the log line Kestrel writes on the server, which is the one that tells you exactly which limit fired:

```
Microsoft.AspNetCore.Server.Kestrel.Core.BadHttpRequestException:
Request body too large. The max request body size is 30000000 bytes.
```

That `30000000` is the tell. If you have not changed anything, the number in the message is the framework default, and the fix is to raise or remove the limit on the layer that owns it. If the number is something else, someone already configured a limit and you are hitting it. Either way the cause is the same: the request body exceeded a configured maximum, and the server rejected the connection before your handler could finish reading it.

## Why this happens

An upload can be blocked by four different limits, and they live in different places. Getting the fix right means knowing which one produced your `413`.

- **Kestrel `MaxRequestBodySize`** caps the total request body at 30,000,000 bytes by default. Exceed it and Kestrel throws `BadHttpRequestException` and returns `413`. This is the one that produces the exact message above.
- **`FormOptions.MultipartBodyLengthLimit`** caps the length of a multipart form body at 134,217,728 bytes (128 MiB) by default. Exceed it and the form reader throws `InvalidDataException`, which surfaces as a `400 Bad Request`, not a `413`. People conflate the two constantly.
- **IIS `maxAllowedContentLength`** (when you host behind IIS) caps the request at the IIS request-filtering layer, default 30,000,000 bytes, before the request ever reaches your app. IIS returns its own error for this, so raising the Kestrel limit alone does nothing behind IIS.
- **A reverse proxy** (nginx, YARP, an API gateway, a cloud load balancer) can enforce its own body cap and return `413` before Kestrel sees the request at all.

If the request works against Kestrel directly but fails behind a proxy or IIS, the limit you need to change is not in your C# code. Check the outermost layer first.

## Minimal repro

The smallest endpoint that reproduces the default `413`. No custom limits, just the framework defaults:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapPost("/upload", async (HttpRequest request) =>
{
    // Reading the body is what trips the limit
    using var reader = new StreamReader(request.Body);
    var content = await reader.ReadToEndAsync();
    return Results.Ok(new { bytes = content.Length });
});

app.Run();
```

Post anything larger than 30,000,000 bytes and the read throws:

```bash
# .NET 11 -- generate a 40 MB file and POST it
head -c 40000000 /dev/urandom > big.bin
curl -i -X POST http://localhost:5000/upload \
  -H "Content-Type: application/octet-stream" \
  --data-binary @big.bin
# -> HTTP/1.1 413 Request Entity Too Large
```

The 40 MB payload clears the 128 MiB multipart limit (it is not multipart anyway), but it blows past the 30 MB Kestrel body cap, so you get `413`, not `400`.

## Raise the limit where it applies

Work through these based on where your `413` is coming from. Most self-hosted Kestrel apps only need the first one.

### 1. Raise or remove the Kestrel global limit

Configure `KestrelServerOptions.Limits.MaxRequestBodySize` at startup. Set it to a specific byte count, or to `null` to remove the cap entirely:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(options =>
{
    // 200 MB ceiling for the whole app
    options.Limits.MaxRequestBodySize = 200 * 1024 * 1024;
});

var app = builder.Build();
```

Prefer a real ceiling over `null`. An unbounded body size is a denial-of-service vector: one client can stream gigabytes into your process and exhaust memory or disk. Pick the largest legitimate upload you expect and add headroom, rather than disabling the guard.

### 2. Set a per-endpoint limit on controllers with attributes

If only one endpoint accepts large uploads, do not raise the global limit for the whole app. On a controller action or Razor Page, use `[RequestSizeLimit(bytes)]` to set a specific cap, or `[DisableRequestSizeLimit]` to remove it for that action only. Both attributes implement `IRequestSizeLimitMetadata`, which the MVC pipeline reads per request:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
[ApiController]
[Route("api/[controller]")]
public sealed class FilesController : ControllerBase
{
    [HttpPost("upload")]
    [RequestSizeLimit(200 * 1024 * 1024)]   // 200 MB, this action only
    public async Task<IResult> Upload(IFormFile file)
    {
        await using var stream = System.IO.File.Create(
            Path.Combine("uploads", file.FileName));
        await file.CopyToAsync(stream);
        return Results.Ok(new { file.FileName, file.Length });
    }
}
```

Swap `[RequestSizeLimit(...)]` for `[DisableRequestSizeLimit]` when the action must accept arbitrarily large bodies and you have another guard (streaming, a quota check) in place.

### 3. Set the limit per request in minimal APIs

Minimal APIs do not honor `[RequestSizeLimit]` the way controllers do, because there is no MVC resource filter in the pipeline to read it. Set the limit imperatively through `IHttpMaxRequestBodySizeFeature`, before anything reads the body:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/upload", async (HttpContext context) =>
{
    var sizeFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
    if (sizeFeature is not null && !sizeFeature.IsReadOnly)
    {
        sizeFeature.MaxRequestBodySize = 200 * 1024 * 1024;   // 200 MB
    }

    using var reader = new StreamReader(context.Request.Body);
    var content = await reader.ReadToEndAsync();
    return Results.Ok(new { bytes = content.Length });
});
```

Check `IsReadOnly` first. Once the server has started reading the body, the limit is locked and assigning to it throws `InvalidOperationException`. That is also why this technique does not work with an `IFormFile` parameter on a minimal API: model binding reads the multipart body before your handler runs, so by the time you can touch the feature it is already read-only (this is the root of dotnet/aspnetcore issue #50871, where large multipart uploads to a minimal API silently returned `200` with a truncated file). For minimal API uploads, bind `HttpContext` or `HttpRequest`, raise the limit, then read the form yourself with `request.ReadFormAsync()`, or set a group-wide limit with a small middleware on a `MapGroup`.

### 4. Raise the multipart form limit for form posts

If your `413` is actually a `400` with an `InvalidDataException` about a multipart body length, the limit that fired is `FormOptions.MultipartBodyLengthLimit`, not Kestrel's. Raise it globally through options, or per controller action with `[RequestFormLimits]`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- global, in Program.cs
builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = 200 * 1024 * 1024;   // 200 MB
});
```

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- per action
[HttpPost("upload")]
[RequestSizeLimit(200 * 1024 * 1024)]
[RequestFormLimits(MultipartBodyLengthLimit = 200 * 1024 * 1024)]
public async Task<IResult> Upload(IFormFile file) { /* ... */ }
```

For a large upload you typically need both raised: `MaxRequestBodySize` governs the whole request, and `MultipartBodyLengthLimit` governs the form body inside it. Set them to the same value.

### 5. Behind IIS, raise maxAllowedContentLength in web.config

When you host behind IIS (in-process or out-of-process), the IIS request-filtering module enforces `maxAllowedContentLength`, default 30,000,000 bytes, before the request reaches Kestrel. Raising the Kestrel limit does nothing until you also raise this. Add it to `web.config`:

```xml
<!-- web.config -- value is in bytes; 200 MB here -->
<system.webServer>
  <security>
    <requestFiltering>
      <requestLimits maxAllowedContentLength="209715200" />
    </requestFiltering>
  </security>
</system.webServer>
```

The in-process hosting module has a second, separate limit you can set in code through `IISServerOptions`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- in-process IIS hosting
builder.Services.Configure<IISServerOptions>(options =>
{
    options.MaxRequestBodySize = 200 * 1024 * 1024;   // 200 MB
});
```

Behind IIS you may need all three aligned: `maxAllowedContentLength` in `web.config`, `IISServerOptions.MaxRequestBodySize`, and Kestrel's `MaxRequestBodySize`. The request is rejected by whichever is smallest.

### 6. Raise the cap on your reverse proxy

If a proxy sits in front of the app, it has its own limit and returns `413` before your app is involved. On nginx, the directive is `client_max_body_size` (default 1 MiB, which is far smaller than Kestrel's default and a common surprise):

```nginx
# nginx.conf -- allow 200 MB uploads through the proxy
client_max_body_size 200M;
```

For YARP, an API gateway, or a cloud load balancer, find the equivalent request-size setting in that layer's configuration. Raising the app-side limits will not help until the proxy lets the body through.

## Gotchas and variants

- **`413` is not `400`.** A `413 Request Entity Too Large` comes from Kestrel's `MaxRequestBodySize`. A `400 Bad Request` with `InvalidDataException: Multipart body length limit ... exceeded` comes from `FormOptions.MultipartBodyLengthLimit`. They are different limits with different defaults (30 MB vs 128 MiB). Read the exception type, not just the status code.
- **HttpSys returns `500`, not `413`.** If you host on `HttpSys` instead of Kestrel, exceeding `HttpSysOptions.MaxRequestBodySize` produces a `500 Internal Server Error`, not a `413`. Same root cause, different surface.
- **Bytes, not mebibytes.** The default is `30000000` (thirty million) bytes, which is about 28.6 MiB, not 30 MiB. If you are computing a limit from "megabytes", decide whether you mean `1024 * 1024` or `1000 * 1000` and be consistent, so a 30 MB file does not fail against a "30 MB" limit.
- **Do not reach for `null` in production.** Removing the limit entirely turns every upload endpoint into a memory or disk exhaustion target. Pair a generous limit with streaming so you never buffer the whole file. See [how to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) and [how to upload a large file with streaming to Azure Blob Storage](/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/).
- **Blazor Server and SignalR have their own limit.** A large upload over a SignalR or Blazor Server circuit is bounded by `HubOptions.MaximumReceiveMessageSize` (default 32 KB), not by `MaxRequestBodySize`. That is a different fix in a different place.
- **The client can close the connection first.** A `413` often arrives with `Connection: close`, and some HTTP clients report it as a socket error rather than a clean `413`. Log the server-side `BadHttpRequestException` to confirm the real cause instead of trusting the client's error string.

The mental model: an upload passes through a stack of size gates (proxy, IIS, Kestrel body size, multipart form size), and it is rejected by the first one it exceeds. Find the layer that produced your `413`, raise that limit to a real, bounded value, and pair it with streaming so a bigger limit does not become a bigger liability.

## Related

- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) for serving large files without loading them into memory.
- [How to upload a large file with streaming to Azure Blob Storage](/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) for pushing big uploads straight to blob storage.
- [Fix: "415 Unsupported Media Type" from a minimal API endpoint in ASP.NET Core 11](/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/) for the sibling error when the request Content-Type is wrong.
- [How to customize minimal API validation error responses with IProblemDetailsService in ASP.NET Core 11](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) for turning a bare status code into a useful error body.
- [How to add response compression to an ASP.NET Core 11 API](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) for the outbound counterpart to inbound body limits.

## Sources

- ASP.NET Announcements, [New default 30 MB (~28.6 MiB) max request body size limit](https://github.com/aspnet/Announcements/issues/267) (Kestrel and HttpSys default of 30,000,000 bytes, `413` on Kestrel and `500` on HttpSys, `MaxRequestBodySize`, `IHttpMaxRequestBodySizeFeature`, `[RequestSizeLimit]` / `[DisableRequestSizeLimit]`, IIS behavior).
- Microsoft Learn, [Upload files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/mvc/models/file-uploads?view=aspnetcore-10.0) (`FormOptions.MultipartBodyLengthLimit` default of 134,217,728 bytes, `[RequestFormLimits]`, `IISServerOptions.MaxRequestBodySize`, `maxAllowedContentLength` in `web.config`).
- Microsoft Learn, [IRequestSizeLimitMetadata.MaxRequestBodySize](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.metadata.irequestsizelimitmetadata.maxrequestbodysize?view=aspnetcore-10.0) (the metadata interface the size-limit attributes implement).
- dotnet/aspnetcore, [Minimal API endpoints accepting IFormFile terminating with HTTP 200 for large files](https://github.com/dotnet/aspnetcore/issues/50871) (why `IHttpMaxRequestBodySizeFeature` cannot be set after the multipart body is bound on a minimal API).
