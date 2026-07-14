---
title: "How to add response compression to an ASP.NET Core 11 API"
description: "A complete guide to response compression in ASP.NET Core 11: AddResponseCompression and UseResponseCompression, the new built-in Zstandard provider alongside Brotli and Gzip, compression levels, EnableForHttps and the CRIME/BREACH risk, custom MIME types, middleware ordering, and when to let the reverse proxy do it instead."
pubDate: 2026-07-14
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "performance"
---

To add response compression to an ASP.NET Core 11 API you need exactly two lines: register the middleware with `builder.Services.AddResponseCompression()` and add it to the pipeline with `app.UseResponseCompression()`. That gives you Brotli, Gzip, and (new in .NET 11) Zstandard, negotiated automatically from the client's `Accept-Encoding` header. The catch is that it does nothing over HTTPS unless you opt in with `EnableForHttps = true`, and that opt-in carries a real security risk you need to understand before you flip it. This post covers the full path: the two-line setup, the .NET 11 Zstandard addition, compression levels, MIME types, the HTTPS gotcha, and the cases where you should let your reverse proxy do the compressing instead.

Everything here targets .NET 11 (Preview 5 at the time of writing, GA in November 2026) with `Microsoft.NET.Sdk.Web` and C# 14. The `Microsoft.AspNetCore.ResponseCompression` middleware has been stable since ASP.NET Core 2.1, so the Brotli and Gzip parts work unchanged on .NET 8, 9, and 10. The Zstandard provider is the one piece that is .NET 11 and later only.

## The two moving parts

Response compression lives in the shared framework, so there is no NuGet package to install. Register the services and add the middleware:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCompression();

var app = builder.Build();

app.UseResponseCompression();

app.MapGet("/data", () => Enumerable.Range(0, 1000)
    .Select(i => new { Id = i, Name = $"Item {i}", Note = "some repeated text" }));

app.Run();
```

Here is the full procedure, start to finish:

1. Call `builder.Services.AddResponseCompression()` to register the middleware and its default providers (Brotli, Gzip, and Zstandard on .NET 11).
2. Call `app.UseResponseCompression()` early in the pipeline, before any middleware that writes the response body.
3. If your API is served over HTTPS (almost always), set `EnableForHttps = true` in the options, after reading the security section below.
4. Add any non-default MIME types you serve (for example `image/svg+xml`) to `ResponseCompressionOptions.MimeTypes`.
5. Tune the compression level per provider if the default (fastest) is not the tradeoff you want.
6. Verify with a client that sends `Accept-Encoding` and inspect the `Content-Encoding` and `Vary` response headers.

That is the whole feature. The rest of this post is about doing each step correctly instead of just making it compile.

## What .NET 11 changes: Zstandard is now built in

If you have set up response compression on an older .NET version, the muscle memory is "Brotli and Gzip." In .NET 11 that list grew. Zstandard (encoding token `zstd`, [RFC 8878](https://datatracker.ietf.org/doc/html/rfc8878)) is now a first-class compression provider, shipped inbox in the `System.IO.Compression` stack with no NuGet package, no P/Invoke, and no third-party binding. When you call `AddResponseCompression()` with no explicit providers, ASP.NET Core 11 registers all three: `BrotliCompressionProvider`, `GzipCompressionProvider`, and `ZstandardCompressionProvider`.

The negotiation order also changed. On .NET 10 and earlier, the middleware preferred Brotli, then fell back to Gzip. On .NET 11, the preference is Zstandard first, then Brotli, then Gzip. So when a modern browser sends `Accept-Encoding: gzip, deflate, br, zstd`, an ASP.NET Core 11 API now answers with `Content-Encoding: zstd`. The reason for the reshuffle is that Zstandard hits a better point on the speed/ratio curve for dynamic API responses: at its default level it compresses meaningfully faster than Brotli at an equivalent ratio, and it decompresses faster than both Brotli and Gzip, which matters when the client is a mobile device or another service.

The important operational consequence: after upgrading to .NET 11, your API will start emitting `zstd` to any client that advertises it, without you changing a line. That is fine for browsers and modern HTTP clients, but if you have an old internal consumer that claimed `zstd` support and cannot actually decode it (rare, but it happens with hand-rolled clients), you will see garbled bodies. The fix is not to disable compression globally but to constrain the provider list, which the next section shows.

## Choosing providers explicitly

The moment you add even one provider by hand, the automatic defaults switch off. This is the single most common footgun: writing `options.Providers.Add<BrotliCompressionProvider>()` and then wondering why Gzip stopped working. When you add providers explicitly, only the ones you list are active.

So to keep all three and enable HTTPS compression:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});
```

The order in which you add providers is the server's preference order when a client accepts more than one. Put Zstandard first if you want it preferred, Gzip last as the universal fallback. If you want to force Gzip only (say, to match a legacy CDN configuration), add just `GzipCompressionProvider` and no other, and the middleware will never emit Brotli or Zstandard.

## Compression levels, and why the default is "fastest"

Every provider defaults to `CompressionLevel.Fastest`, not `Optimal`. That surprises people who expect the smallest possible payload out of the box. The default is deliberate: for a dynamic response computed per request, the CPU you spend compressing is on the hot path of every response, so the framework favors latency over the last few percent of size. `Optimal` and `SmallestSize` can cost several times the CPU for single-digit-percent extra shrinkage on already-small JSON.

You set the level per provider through its options class:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});

builder.Services.Configure<BrotliCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.Fastest;
});

builder.Services.Configure<GzipCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.SmallestSize;
});
```

The `CompressionLevel` enum has four values: `NoCompression`, `Fastest`, `Optimal`, and `SmallestSize`. For an interactive API, leave Zstandard and Brotli at `Fastest`. Reserve `Optimal` or `SmallestSize` for responses you compress once and serve many times, which for a pure API usually means you are better off caching the compressed bytes yourself than paying optimal compression on every request. If you are also serving static assets, note that static file compression is a separate concern (build-time or CDN), not something this middleware should do at request time.

Zstandard has its own, finer-grained knob. Its quality ranges from 1 to 22, with the default sitting around level 3, and you set it through `ZstandardCompressionProviderOptions`:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.Configure<ZstandardCompressionProviderOptions>(options =>
{
    options.CompressionOptions = new ZstandardCompressionOptions
    {
        Quality = 6 // 1 to 22; higher = smaller output, slower
    };
});
```

Higher quality means a smaller body and more CPU. Level 6 is a reasonable step up from the default when your responses are large and repetitive (think list endpoints returning thousands of similar objects) and you have CPU headroom.

## The HTTPS security gotcha you cannot skip

`EnableForHttps` is `false` by default, and that default is a security decision, not an oversight. Compressing a response whose body mixes a secret (a session token, a CSRF token, an account number) with attacker-influenced input, over TLS, opens the door to the [CRIME](https://en.wikipedia.org/wiki/CRIME) and [BREACH](https://en.wikipedia.org/wiki/BREACH) attacks. These side-channel attacks infer the secret by watching how the compressed response size changes as the attacker varies the input they control. Compression ratio leaks information about content, and over HTTPS the size of the encrypted body is still observable.

For a typical JSON API that returns no per-user secrets reflected alongside attacker-controlled query values, enabling HTTPS compression is a normal and reasonable thing to do, and nearly everyone does. But you should make that call deliberately:

- If your responses never embed a secret token in the body next to reflected user input, enabling compression over HTTPS is low risk.
- If they might (an HTML page with an antiforgery token, an endpoint that echoes a search term back next to a session identifier), mitigate before enabling: use antiforgery tokens (the standard mitigation in ASP.NET Core), avoid reflecting untrusted input into secret-bearing responses, and consider leaving compression off for those specific endpoints.

The `EnableForHttps` flag is global. If you need compression for public data endpoints but not for a sensitive one, the cleanest split is to run the sensitive endpoints without compression by segmenting the pipeline, or to serve them with a `Content-Type` you deliberately leave out of the compressible MIME list.

One more subtlety: even with `EnableForHttps = false`, you may still see a `Content-Encoding` header in production. IIS, IIS Express, and Azure App Service can apply Gzip at the web server layer independently of your app. If a compressed response shows up that you did not configure, check the `Server` response header before assuming the middleware is misbehaving.

## MIME types: what actually gets compressed

The middleware only compresses responses whose `Content-Type` matches its list. The defaults cover the usual API and web payloads: `application/json`, `application/javascript`, `application/xml`, `text/css`, `text/html`, `text/json`, `text/plain`, and `text/xml`. For a JSON API you get compression with zero configuration, because `application/json` is on the list.

To compress something outside the defaults, append to `ResponseCompressionOptions.MimeTypes`. Wildcards like `text/*` are not supported, so list each type:

```csharp
// .NET 11, C# 14
using System.Linq;
using Microsoft.AspNetCore.ResponseCompression;

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(
        new[] { "image/svg+xml", "application/manifest+json" });
});
```

Do not add already-compressed formats such as PNG, JPEG, WebP, or ZIP. They are compressed natively, and running them through Brotli or Zstandard burns CPU to produce a body that is the same size or slightly larger. The same applies to very small responses: below roughly 150 to 1,000 bytes the compression overhead can make the output bigger than the input, so tiny responses are not worth compressing regardless of type.

## Ordering: UseResponseCompression goes early

Middleware order decides whether compression works at all. `app.UseResponseCompression()` must run before any middleware that writes to the response body, because compression works by wrapping the response stream. If another middleware has already started writing, the compression wrapper never sees those bytes. In practice, put it near the top of the pipeline:

```csharp
// .NET 11, C# 14
var app = builder.Build();

app.UseResponseCompression();   // first, so it wraps everything below
app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
```

When compression is applied, the middleware also does the right thing with caching headers automatically: it strips `Content-Length` (the body length changed), removes `Content-MD5` (the hash is now invalid), and adds `Vary: Accept-Encoding` so that caches store the compressed and uncompressed variants separately. You do not manage those by hand.

## When to skip the middleware entirely

Response compression middleware is the right tool when you host directly on Kestrel or HTTP.sys with nothing in front, because neither server offers built-in compression. But if your API sits behind IIS, Nginx, Apache, or a CDN, the reverse proxy can usually compress faster than the managed middleware, and doing it in one place is simpler to reason about. Microsoft's own guidance is to prefer server-based compression when it is available.

Two traps to watch for when a proxy is involved:

- Nginx strips the `Accept-Encoding` header when it proxies a request upstream, which silently prevents the ASP.NET Core middleware from ever compressing. If you keep the middleware behind Nginx, either configure Nginx to preserve the header or let Nginx do the compression and drop the middleware.
- Double compression is wasted work and can corrupt responses. If the proxy already compresses, do not also run the middleware for the same content types. Pick one layer.

For a minimal API served straight from Kestrel in a container with no sidecar proxy, the middleware is exactly right and the two-line setup at the top of this post is all you need. For anything fronted by a mature proxy or CDN, measure first: you may already be getting compression you did not configure.

## Custom providers, briefly

If you need an encoding the framework does not ship, implement `ICompressionProvider`. The `EncodingName` property is the token the middleware matches against `Accept-Encoding`, and `CreateStream` returns your compressing wrapper:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.ResponseCompression;

public sealed class CustomCompressionProvider : ICompressionProvider
{
    public string EncodingName => "mycustomcompression";
    public bool SupportsFlush => true;

    public Stream CreateStream(Stream outputStream)
    {
        // Wrap outputStream in your compression stream here.
        return outputStream;
    }
}
```

Register it like any other provider with `options.Providers.Add<CustomCompressionProvider>()`. In practice, with Zstandard now inbox, the need for custom providers has mostly evaporated. Between Zstandard, Brotli, and Gzip, .NET 11 covers every encoding a real HTTP client will ask for, which is the whole point of the .NET 11 change: the fast, modern option is now on by default and you no longer have to reach outside the framework to get it.

## Related

- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) explains why compression middleware and streaming can fight each other.
- [How to add output caching to a minimal API in ASP.NET Core 11](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) pairs well with compression for read-heavy endpoints.
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) helps when you want compression on some route groups but not others.
- [How to return a typed Results union from a minimal API endpoint in ASP.NET Core 11](/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) covers the response types that flow through this middleware.
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) is worth reading if you care about the CPU cost of compression on cold starts.

## Sources

- [Response compression in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0)
- [ResponseCompressionOptions.EnableForHttps (API reference)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.responsecompression.responsecompressionoptions.enableforhttps)
- [CompressionLevel enum (API reference)](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.compressionlevel)
- [RFC 8878: Zstandard Compression](https://datatracker.ietf.org/doc/html/rfc8878)
- [CRIME attack (Wikipedia)](https://en.wikipedia.org/wiki/CRIME) and [BREACH attack (Wikipedia)](https://en.wikipedia.org/wiki/BREACH)
