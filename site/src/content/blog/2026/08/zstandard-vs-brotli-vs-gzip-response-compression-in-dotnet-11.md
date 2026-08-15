---
title: "Zstandard vs Brotli vs Gzip response compression in .NET 11"
description: "Zstandard is the right default for dynamic API responses in .NET 11, but not at the quality the ASP.NET Core provider ships with. Benchmarks on real JSON payloads showing why quality 1 beats the default quality 3 on both size and CPU, when Brotli still wins, and why Gzip survives only as a fallback."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "csharp"
  - "compression"
  - "performance"
---

For dynamic API responses in .NET 11, use Zstandard, which is already the default, but set `Quality = 1` explicitly instead of taking the provider's default. On the JSON payloads I measured, Zstandard at quality 1 compressed 7.37x while the provider's default quality 3 managed only 6.66x, and quality 1 did it at nearly twice the throughput. Brotli only wins when you can compress once and serve many times, and even then only at quality 11, which costs 3.2 seconds per 3 MB response. Gzip is now purely a compatibility fallback.

Everything below targets .NET 11 (Preview 7 at the time of writing, GA in November 2026) and C# 14. The Zstandard provider is new in ASP.NET Core 11; Brotli and Gzip have been in the middleware since ASP.NET Core 2.1 and behave identically on .NET 8, 9, and 10.

## The matrix

| | Zstandard | Brotli | Gzip |
| --- | --- | --- | --- |
| `Accept-Encoding` token | `zstd` | `br` | `gzip` |
| Specification | [RFC 8878](https://datatracker.ietf.org/doc/html/rfc8878) | [RFC 7932](https://datatracker.ietf.org/doc/html/rfc7932) | [RFC 1952](https://www.ietf.org/rfc/rfc1952.txt) |
| Inbox in `System.IO.Compression` since | .NET 11 | .NET Core 2.1 | .NET Framework 2.0 |
| Registered by default in ASP.NET Core 11 | Yes, first | Yes, second | Yes, third |
| Provider default level | quality 3 | `CompressionLevel.Fastest` | `CompressionLevel.Fastest` |
| Level range | `MinQuality` (negative) to 22 | 0 to 11 | 0 to 9 |
| Ratio on 292 KB JSON (best sane level) | 7.26x | 7.01x | 6.55x |
| Compression throughput at that level | 572 MB/s | 215 MB/s | 208 MB/s |
| Decompression throughput | 3103 MB/s | 1134 MB/s | 1575 MB/s |
| Works in Blazor WebAssembly | No | Yes | Yes |
| Dictionary support | Trainable (`ZstandardDictionary`) | Built-in static only | No |

The two rows that decide most arguments are decompression throughput and the WebAssembly row. Everything else is close enough that you could flip a coin.

## What .NET 11 actually registers, and in what order

If you call `AddResponseCompression()` without naming providers, ASP.NET Core 11 registers three, and the order in [`ResponseCompressionProvider`](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ResponseCompressionProvider.cs) is the server's preference order:

```csharp
// ASP.NET Core 11, from ResponseCompressionProvider.cs
_providers = new ICompressionProvider[]
{
    new CompressionProviderFactory(typeof(ZstandardCompressionProvider)),
    new CompressionProviderFactory(typeof(BrotliCompressionProvider)),
    new CompressionProviderFactory(typeof(GzipCompressionProvider)),
};
```

So a browser sending `Accept-Encoding: gzip, deflate, br, zstd` gets `Content-Encoding: zstd` from an ASP.NET Core 11 app that you never configured. On .NET 10 the same request got `br`. That is the entire user-visible change, and it happens on upgrade with no code edit.

The moment you add one provider by hand, the defaults switch off entirely and only your list is active. This is the most common way people accidentally disable Zstandard while thinking they are just enabling HTTPS compression.

## The default quality is the wrong default

Here is the part that does not show up in the release notes. `BrotliCompressionProviderOptions` and `GzipCompressionProviderOptions` both default to `CompressionLevel.Fastest`. The Zstandard provider does not have a `Level` property at all. It has this:

```csharp
// ASP.NET Core 11, from ZstandardCompressionProviderOptions.cs
public ZstandardCompressionOptions CompressionOptions { get; set; } = new();
```

A fresh `ZstandardCompressionOptions` leaves `Quality` at `0`, and `0` means "implementation-defined default", which libzstd resolves to level 3. So the Brotli and Gzip providers ship tuned for latency while the Zstandard provider ships at libzstd's balanced default. Nobody wrote that asymmetry down, but it is what the source says.

That would be a minor nit if quality 3 were simply a slower, smaller option. It is not. On the JSON payloads I measured, quality 3 is worse than quality 1 on **both** axes:

| zstd quality | Size of 2.88 MB JSON | Ratio | Compression throughput |
| --- | --- | --- | --- |
| 1 | 409,809 B | 7.37x | 806 MB/s |
| 2 | 427,111 B | 7.07x | - |
| 3 (provider default) | 453,130 B | 6.66x | 425 MB/s |
| 4 | 460,813 B | 6.55x | - |
| 5 | 449,750 B | 6.71x | - |
| 6 | 436,263 B | 6.92x | 159 MB/s |
| 9 | 422,148 B | 7.15x | - |
| 12 | 416,795 B | 7.24x | 54 MB/s |
| 19 | 362,100 B | 8.34x | - |

Read that column again. The ratio falls from level 1 to level 4, then climbs back, and does not beat level 1 again until level 9. Paying 1.9x the CPU to get an 11% larger body is a bad trade in any direction.

This is not a bug and it is not specific to .NET. Zstandard levels are not a single dial: each level selects a different match-finder strategy plus its own window, chain, hash, and minimum-match parameters. Asking libzstd directly for the parameters it uses shows the discontinuity:

```
level  1: strategy=1 (fast)   windowLog=19 chainLog=13 hashLog=14 minMatch=7
level  2: strategy=1 (fast)   windowLog=20 chainLog=15 hashLog=16 minMatch=6
level  3: strategy=2 (dfast)  windowLog=21 chainLog=16 hashLog=17 minMatch=5
level  4: strategy=2 (dfast)  windowLog=21 chainLog=18 hashLog=18 minMatch=5
level  5: strategy=3 (greedy) windowLog=21 chainLog=18 hashLog=19 minMatch=5
level  6: strategy=4 (lazy)   windowLog=21 chainLog=18 hashLog=19 minMatch=5
```

The jump from level 2 to level 3 drops `minMatch` from 6 to 5 and switches strategy. On text with long, highly repetitive runs (JSON keys repeated once per array element, an identical `notes` string on every record), the level 1 configuration finds fewer but longer matches that entropy-code better. Those level tables were tuned against a general corpus, so the ordering holds on average, not on your payload.

The practical rule: the default level of any codec is a guess about data it has never seen. Measure your two or three real endpoint shapes and pin the quality.

## The benchmark

Payload: a JSON array of customer records, the shape a list endpoint actually returns. Deterministic, so you can reproduce it:

```csharp
// .NET 10 / .NET 11, C# 14
static Guid NextGuid(Random rnd)
{
    var b = new byte[16];
    rnd.NextBytes(b);
    return new Guid(b);
}

static byte[] MakeListPayload(int count, int seed)
{
    var rnd = new Random(seed);
    string[] cities = ["Bucharest", "Berlin", "Lisbon", "Warsaw", "Dublin", "Madrid", "Helsinki"];
    string[] statuses = ["active", "pending", "suspended", "closed"];
    var items = Enumerable.Range(1, count).Select(i => new
    {
        id = i,
        externalId = NextGuid(rnd).ToString(),
        name = $"Customer {i}",
        email = $"user{i}@example.com",
        city = cities[rnd.Next(cities.Length)],
        status = statuses[rnd.Next(statuses.Length)],
        balance = Math.Round(rnd.NextDouble() * 10000, 2),
        createdAt = new DateTime(2024, 1, 1).AddMinutes(i * 7).ToString("O"),
        tags = new[] { "vip", "eu", "newsletter" }.Take(rnd.Next(1, 4)).ToArray(),
        notes = "Imported from the legacy CRM during the 2024 migration."
    });
    return JsonSerializer.SerializeToUtf8Bytes(items);
}
```

Method: each codec wraps a `MemoryStream` exactly the way the response compression middleware wraps the response body, so per-response encoder setup is inside the measurement. Three warmup iterations, then 60 timed iterations for the 292 KB payload and 15 for the 2.88 MB one, reporting the median. Machine: Intel Core Ultra 7 265KF, Windows 11, .NET 10.0.5 x64.

One honest caveat about the environment. My machine has SDK 10.0.201 only, so `System.IO.Compression.ZstandardStream` was not available to compile against. The Zstandard rows come from [ZstdSharp.Port](https://www.nuget.org/packages/ZstdSharp.Port) 0.8.8, a managed port of the reference implementation. Two things make that substitution defensible. First, .NET 11 vendors [libzstd 1.5.7](https://github.com/dotnet/runtime/blob/main/src/native/external/zstd/lib/zstd.h), and I verified every ZstdSharp output size against native libzstd 1.5.7 on the identical bytes: they agree to within 0.05% (41,132 vs 41,135 bytes at quality 1, 43,644 vs 43,647 at quality 3). Compressed sizes are therefore what .NET 11 will produce. Second, throughput is the number that is not transferable: native libzstd hit 1092 MB/s at quality 1 on this hardware where the managed port hit 806 MB/s, so treat the Zstandard speed column as a floor, not a ceiling.

**292 KB JSON (1,000 records), raw 298,727 bytes:**

| codec | level | compressed | ratio | comp MB/s | decomp MB/s |
| --- | --- | --- | --- | --- | --- |
| gzip | Fastest | 69,832 | 4.28x | 743 | 1488 |
| gzip | Optimal | 45,586 | 6.55x | 208 | 1575 |
| brotli | Fastest | 44,606 | 6.70x | 564 | 808 |
| brotli | Optimal | 42,610 | 7.01x | 215 | 1134 |
| brotli | q11 (SmallestSize) | 34,025 | 8.78x | 1 | 728 |
| zstd | q1 | 41,132 | 7.26x | 572 | 3103 |
| zstd | q3 (provider default) | 43,644 | 6.84x | 276 | 1796 |
| zstd | q6 | 41,009 | 7.28x | 112 | 1735 |
| zstd | q12 | 38,881 | 7.68x | 20 | 1320 |

**2.88 MB JSON (10,000 records), raw 3,018,756 bytes:**

| codec | level | compressed | ratio | comp MB/s | decomp MB/s |
| --- | --- | --- | --- | --- | --- |
| gzip | Fastest | 697,252 | 4.33x | 712 | 1443 |
| gzip | Optimal | 452,661 | 6.67x | 204 | 1620 |
| brotli | Fastest | 447,954 | 6.74x | 786 | 726 |
| brotli | Optimal | 429,060 | 7.04x | 186 | 1088 |
| brotli | q11 (SmallestSize) | 341,338 | 8.84x | 1 | 842 |
| zstd | q1 | 409,805 | 7.37x | 806 | 3158 |
| zstd | q3 (provider default) | 454,007 | 6.65x | 425 | 1914 |
| zstd | q6 | 436,263 | 6.92x | 159 | 1846 |
| zstd | q12 | 416,792 | 7.24x | 54 | 1891 |

Three results carry the whole comparison.

**Zstandard quality 1 dominates Brotli `Fastest`.** Smaller output (41,132 vs 44,606 bytes), the same compression throughput (572 vs 564 MB/s), and 3.8x the decompression throughput. There is no axis on which Brotli's fast setting is the better choice for a dynamic response.

**Gzip `Fastest` is not competitive on size.** 69,832 bytes against Zstandard's 41,132 is a 70% larger body for no throughput advantage. If you are still emitting `gzip` to modern clients you are paying for it in bandwidth.

**Brotli q11 is a trap on a request path.** It is genuinely the smallest output in the table, 8.78x, roughly 17% better than Zstandard quality 1. It also took 272 milliseconds for the 292 KB payload and 3.2 seconds for the 2.88 MB one. That is per response. Anyone who benchmarks "Brotli compresses best" and configures `SmallestSize` on a live API has added three seconds of CPU-bound latency to every large response.

## When to pick each

**Zstandard, quality 1** for anything computed per request. JSON list endpoints, GraphQL responses, server-rendered HTML, log ingestion responses. This is the default in .NET 11 and the only change you need is pinning the quality.

**Zstandard, quality 12 to 19** for content compressed once and cached, where you are storing the compressed bytes and serving them repeatedly. Quality 19 reached 8.34x on the large payload, closing most of the gap with Brotli q11 at a fraction of the cost. Pair it with [output caching](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) so the CPU is paid once per cache entry rather than once per request.

**Brotli, quality 11** for static assets compressed at build time. Your JS bundle, your CSS, your WASM payload. Compression time does not matter when it happens in CI, and Brotli's built-in static dictionary is tuned for exactly this content. Do not do this in the response compression middleware; precompress and serve the `.br` file.

**Brotli, `Optimal`** when you need broad client support and cannot use Zstandard. Notably, this includes Blazor WebAssembly, discussed below.

**Gzip** only as the last entry in the provider list, for clients that advertise nothing else. Keep it registered; never prefer it.

## The gotchas that pick for you

**Zstandard does not exist in the browser or in WASI.** The runtime marks the whole type family with `[UnsupportedOSPlatform("browser")]` and `[UnsupportedOSPlatform("wasi")]`. If your client is a Blazor WebAssembly app doing its own decompression, or you are running on `wasi-wasm`, Zstandard is not an option and the analyzer will tell you so at build time. Server-side compression to a browser is unaffected: the browser's own `zstd` support handles `Content-Encoding: zstd` natively, and that has shipped in Chrome, Edge, and Firefox for a while now. This only bites code calling `ZstandardStream` inside a WASM runtime.

**`CompressionLevel.NoCompression` does not mean no compression for Zstandard.** The runtime maps the enum onto zstd quality like this:

```csharp
// .NET 11, from ZstandardUtils.cs
CompressionLevel.NoCompression => Quality_Min,   // ZSTD_minCLevel(), a large negative number
CompressionLevel.Fastest       => 1,
CompressionLevel.Optimal       => Quality_Default,  // 3
CompressionLevel.SmallestSize  => Quality_Max,      // 22
```

`NoCompression` maps to the *minimum quality*, which is still a compressing configuration, just an extremely fast and weak one. For Gzip and Brotli, `NoCompression` really does mean stored blocks. Passing the same enum value to the three codecs gets you three different behaviours.

**Negative qualities are legal, and the ASP.NET Core docs do not mention them.** [The response compression page](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0) says the quality level "ranges from 1 to 22". The runtime source is broader: `Quality` accepts anything from `MinQuality` up to `MaxQuality`, with negatives documented as extending the speed-versus-ratio range. They are rarely what you want for JSON. Quality -5 got compression up to 1635 MB/s but the ratio collapsed from 7.37x to 3.81x, which for a 3 MB response means shipping roughly 375 KB more over the wire to save a millisecond of CPU. Reach for quality 1, not for negatives.

**Enabling HTTPS compression is still an opt-in with a real risk attached.** `EnableForHttps` defaults to `false` because compressing a response that mixes a secret with attacker-influenced input leaks that secret through the compressed size ([CRIME](https://en.wikipedia.org/wiki/CRIME) and [BREACH](https://en.wikipedia.org/wiki/BREACH)). Switching codecs does not change this: Zstandard is exactly as vulnerable as Gzip was. If you want the reasoning and the mitigation checklist, the [full response compression setup guide](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) covers it.

**Small responses lose under every codec.** The single-record response in my test set is 179 bytes. Gzip `Fastest` turned it into 188 bytes, larger than the input, and Zstandard quality 1 into 157 bytes, a 1.14x "win" that is entirely eaten by the framing overhead and the per-response encoder setup. The framework's own guidance is not to compress below roughly 150 to 1,000 bytes, and the codec choice does not move that threshold.

## Configuring it

The full configuration for a JSON API, with the quality pinned:

```csharp
// .NET 11, C# 14
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<ZstandardCompressionProvider>();
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});

builder.Services.Configure<ZstandardCompressionProviderOptions>(options =>
{
    options.CompressionOptions = new ZstandardCompressionOptions
    {
        Quality = 1
    };
});

var app = builder.Build();

app.UseResponseCompression();

app.MapGet("/customers", () => Results.Ok(GetCustomers()));

app.Run();
```

Adding all three providers explicitly is redundant with the defaults, but it documents the preference order for the next person and survives someone adding a fourth provider later.

Two more knobs on `ZstandardCompressionOptions` are worth knowing for streaming responses. `TargetBlockSize` (valid range 1,340 to 131,072 bytes) hints at how often the encoder emits a block; smaller values mean lower latency for a trickling response, at some cost in ratio. `EnableLongDistanceMatching` improves ratios on large bodies at the cost of memory. Neither is worth touching until you have pinned the quality and measured.

If your responses are small, uniform, and repetitive, the feature actually worth investigating is `ZstandardDictionary`. Training a dictionary on representative samples lets Zstandard compress payloads that are individually too small to build a useful window from, which is the one case where the 179-byte response above becomes compressible. Brotli and Gzip have no equivalent you can train yourself.

## The recommendation, restated

Take the .NET 11 default and pin one property. Zstandard at quality 1 gave the best ratio of any level that runs fast enough for a request path, matched the fastest Brotli setting on compression throughput, and decompressed roughly 3x faster than anything else in the table, which is the number your mobile clients feel. Leave Brotli and Gzip registered underneath it so old clients still get something.

Do not accept the provider's default quality of 3. It is the one configuration in this comparison that is beaten on both size and speed simultaneously, and it is what you get if you change nothing.

## Related

- [How to add response compression to an ASP.NET Core 11 API](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) covers the middleware setup, MIME types, and the HTTPS security decision in full.
- [.NET 11 adds native Zstandard compression to System.IO.Compression](/2026/04/dotnet-11-zstandard-compression-system-io/) introduces the `ZstandardStream` API outside of the HTTP context.
- [Output caching vs response caching in ASP.NET Core 11](/2026/07/output-caching-vs-response-caching-in-aspnetcore-11/) is how you make a high-quality compression level affordable.
- [.NET 11 span-based Deflate and Gzip compression](/2026/05/dotnet-11-span-based-deflate-gzip-compression/) covers the allocation-free one-shot APIs for the older codecs.
- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) explains where compression and streaming interact badly.

## Sources

- [Response compression in ASP.NET Core 11 (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression?view=aspnetcore-11.0)
- [ResponseCompressionProvider.cs, default provider order (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ResponseCompressionProvider.cs)
- [ZstandardCompressionProviderOptions.cs (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/ResponseCompression/src/ZstandardCompressionProviderOptions.cs)
- [ZstandardCompressionOptions.cs, quality and window semantics (dotnet/dotnet)](https://github.com/dotnet/dotnet/blob/main/src/runtime/src/libraries/System.IO.Compression.Zstandard/src/System/IO/Compression/ZstandardCompressionOptions.cs)
- [ZstandardCompressionOptions class reference (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zstandardcompressionoptions?view=net-11.0)
- [Support zstd Content-Encoding (dotnet/aspnetcore issue 50643)](https://github.com/dotnet/aspnetcore/issues/50643)
- [RFC 8878: Zstandard Compression and the application/zstd Media Type](https://datatracker.ietf.org/doc/html/rfc8878)
- [Zstandard reference implementation](https://github.com/facebook/zstd)
