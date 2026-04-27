---
title: "How to reduce cold-start time for a .NET 11 AWS Lambda"
description: "A practical, version-specific playbook for cutting .NET 11 Lambda cold starts. Covers Native AOT on provided.al2023, ReadyToRun, SnapStart on the managed dotnet10 runtime, memory tuning, static reuse, trim safety, and how to actually read INIT_DURATION."
pubDate: 2026-04-27
template: how-to
tags:
  - "aws"
  - "aws-lambda"
  - "dotnet-11"
  - "native-aot"
  - "performance"
---

A typical .NET Lambda goes from "default `dotnet new lambda.EmptyFunction`" with a 1500-2500 ms cold start to under 300 ms by stacking four levers: pick the right runtime (Native AOT on `provided.al2023` or SnapStart on the managed runtime), give the function enough memory that init runs on a full vCPU, hoist everything reusable into static initialization, and stop loading code you do not need. This guide walks each lever for a .NET 11 Lambda (`Amazon.Lambda.RuntimeSupport` 1.13.x, `Amazon.Lambda.AspNetCoreServer.Hosting` 1.7.x, .NET 11 SDK, C# 14), explains the order to apply them in, and shows how to verify each step from the `INIT_DURATION` line in CloudWatch.

## Why a default .NET Lambda cold-starts so slowly

A managed-runtime cold start in Lambda runs four things back to back, and a default .NET function pays for all of them. First, the **firecracker microVM** boots and Lambda fetches your deployment package. Second, the **runtime initializes**: for a managed runtime that means CoreCLR loads, the host JIT warms, and your function assemblies are mapped into memory. Third, your **handler class is constructed**, including any constructor injection, configuration loading, and AWS SDK client construction. Only after all of that does Lambda call your `FunctionHandler` for the first invocation.

The .NET-specific cost shows up in steps two and three. CoreCLR JIT-compiles every method on first call. ASP.NET Core (when you use the API Gateway hosting bridge) builds a full host with logging, configuration, and an option-binding pipeline. The default AWS SDK clients lazily resolve credentials by walking the credential provider chain, which on Lambda is fast but still allocates. Reflection-heavy serializers like default `System.Text.Json` paths inspect every property of every type they see for the first time.

You can pull on four levers, in this order, with diminishing-returns trade-offs:

1. **Native AOT** ships a pre-compiled binary, so JIT cost goes to zero and the runtime boots a tiny self-contained executable.
2. **SnapStart** snapshots an already-warmed init phase and restores from disk on cold start.
3. **Memory size** buys you proportional CPU, which speeds up everything in init.
4. **Static reuse and trimming** shrink what runs during init and what gets re-done per cold start.

## Lever 1: Native AOT on provided.al2023 (the biggest single win)

Native AOT compiles your function and the .NET runtime to a single static binary, eliminates the JIT, and cuts the cold start to roughly the time it takes Lambda to launch a process. AWS publishes [first-class guidance](https://docs.aws.amazon.com/lambda/latest/dg/dotnet-native-aot.html) for this on the `provided.al2023` custom runtime. With .NET 11, the toolchain matches what shipped with .NET 8, but the trim analyzer is stricter and `ILLink` warnings that were green in .NET 8 may light up.

The minimal AOT-ready function looks like this:

```csharp
// .NET 11, C# 14
// PackageReference: Amazon.Lambda.RuntimeSupport 1.13.0
// PackageReference: Amazon.Lambda.Serialization.SystemTextJson 2.4.4
using System.Text.Json.Serialization;
using Amazon.Lambda.Core;
using Amazon.Lambda.RuntimeSupport;
using Amazon.Lambda.Serialization.SystemTextJson;

var serializer = new SourceGeneratorLambdaJsonSerializer<LambdaFunctionJsonContext>();

var handler = static (Request req, ILambdaContext ctx) =>
    new Response($"hello {req.Name}", DateTimeOffset.UtcNow);

await LambdaBootstrapBuilder.Create(handler, serializer)
    .Build()
    .RunAsync();

public record Request(string Name);
public record Response(string Message, DateTimeOffset At);

[JsonSerializable(typeof(Request))]
[JsonSerializable(typeof(Response))]
public partial class LambdaFunctionJsonContext : JsonSerializerContext;
```

The `csproj` switches that matter:

```xml
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <PublishAot>true</PublishAot>
  <StripSymbols>true</StripSymbols>
  <InvariantGlobalization>true</InvariantGlobalization>
  <RootNamespace>MyFunction</RootNamespace>
  <AssemblyName>bootstrap</AssemblyName>
  <TieredCompilation>false</TieredCompilation>
</PropertyGroup>
```

`AssemblyName` of `bootstrap` is required by the custom runtime. `InvariantGlobalization=true` removes ICU, saving package size and avoiding the dreaded ICU initialization on cold start. If you need real culture data, swap it for `<PredefinedCulturesOnly>false</PredefinedCulturesOnly>` and accept the size hit.

Build on Amazon Linux (or in a Linux container) so the linker matches the Lambda environment:

```bash
# .NET 11 SDK
dotnet lambda package --configuration Release \
  --framework net11.0 \
  --msbuild-parameters "--self-contained true -r linux-x64 -p:PublishAot=true"
```

The `Amazon.Lambda.Tools` global tool packages the `bootstrap` binary into a ZIP that you upload as a custom runtime. With a 256 MB function and the boilerplate above, expect cold starts in the **150 ms to 300 ms** range, down from 1500-2000 ms on the managed runtime.

The trade-off: every reflection-heavy library you pull in becomes a trim warning. `System.Text.Json` source generators handle serialization, but if you use anything that reflects over generic types at runtime (older AutoMapper, Newtonsoft, MediatR's reflection-based handlers), you will get ILLink warnings or a runtime exception. Treat every warning as a real bug. A trim-friendly mediator alternative is covered in [SwitchMediator v3, a zero-alloc mediator that stays friendly to AOT](/2026/01/switchmediator-v3-a-zero-alloc-mediator-that-stays-friendly-to-aot/).

## Lever 2: SnapStart on the managed dotnet10 runtime

If your code is not AOT-friendly (heavy reflection, dynamic plugins, EF Core 11 with runtime model building), Native AOT is not viable. The next-best option is **Lambda SnapStart**, which is supported on the **managed `dotnet10` runtime** today. As of April 2026, the managed `dotnet11` runtime is not yet GA, so the practical "managed" target for .NET 11 code is to multi-target `net10.0` and run on the `dotnet10` SnapStart-enabled runtime, or to use the custom runtime described above. AWS announced the .NET 10 runtime in late 2025 ([AWS blog: .NET 10 runtime now available in AWS Lambda](https://aws.amazon.com/blogs/compute/net-10-runtime-now-available-in-aws-lambda/)) and SnapStart support for managed .NET runtimes is documented at [Improving startup performance with Lambda SnapStart](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html).

SnapStart freezes the function after init, takes a Firecracker microVM snapshot, and on cold start restores the snapshot instead of running init again. For .NET, where init is the expensive part, this typically reduces cold starts by 60-90%.

Two things matter for SnapStart correctness:

1. **Determinism after restore.** Anything captured during init (random seeds, machine-specific tokens, network sockets, time-derived caches) is shared across every restored instance. Use the runtime hooks AWS provides:

```csharp
// .NET 10 target multi-targeted with .NET 11
using Amazon.Lambda.RuntimeSupport;

Core.SnapshotRestore.RegisterBeforeSnapshot(() =>
{
    // flush anything that should not be captured
    return ValueTask.CompletedTask;
});

Core.SnapshotRestore.RegisterAfterRestore(() =>
{
    // re-seed RNG, refresh credentials, reopen sockets
    return ValueTask.CompletedTask;
});
```

2. **Pre-JIT what you want to be hot.** SnapStart captures the JITted state. Tiered compilation will not have promoted hot methods to tier-1 yet during init, so you get a snapshot of mostly-tier-0 code unless you nudge it. Walk the hot path once during init (call your handler with a synthetic warm-up payload, or invoke key methods explicitly) so the snapshot includes their JITted forms. With `<TieredPGO>true</TieredPGO>` (the .NET 11 default), this matters a little less, but it still helps measurably.

SnapStart is free of charge for managed .NET runtimes today, with the caveat that snapshot creation adds a small delay to deploys.

## Lever 3: Memory size buys CPU

Lambda allocates CPU proportionally to memory. At 128 MB you get a fraction of a vCPU. At 1769 MB you get one full vCPU, and above that you get more than one. **Init runs on the same proportional CPU**, so a function configured at 256 MB pays a JIT and DI bill that is significantly slower than the same code at 1769 MB.

Concrete numbers for a small ASP.NET Core minimal API Lambda:

| Memory | INIT_DURATION (managed dotnet10) | INIT_DURATION (Native AOT) |
| ------ | -------------------------------- | -------------------------- |
| 256 MB | ~1800 ms                         | ~280 ms                    |
| 512 MB | ~1100 ms                         | ~200 ms                    |
| 1024 MB| ~700 ms                          | ~180 ms                    |
| 1769 MB| ~480 ms                          | ~160 ms                    |

The takeaway is not "always use 1769 MB." It is that you cannot conclude anything about cold start at 256 MB. Benchmark at the memory size you actually plan to deploy at, and remember that **the [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) state machine** finds the cost-optimal memory size for your workload in a few minutes.

## Lever 4: Static reuse and trimming the init graph

Once you have picked the runtime and memory, the remaining wins come from doing less work during init and reusing more between invocations. Three patterns cover most of what is worth doing.

### Hoist clients and serializers into static fields

Lambda reuses the same execution environment across invocations until it cools down. Anything you put in a static field survives. The classic mistake is allocating an `HttpClient` or AWS SDK client inside the handler:

```csharp
// .NET 11 - bad: per-invocation construction
public async Task<Response> Handler(Request req, ILambdaContext ctx)
{
    using var http = new HttpClient(); // pays DNS, TCP, TLS every time
    var s3 = new AmazonS3Client();      // re-resolves credentials chain
    // ...
}
```

Move them up:

```csharp
// .NET 11 - good: shared across warm invocations
public sealed class Function
{
    private static readonly HttpClient Http = new();
    private static readonly AmazonS3Client S3 = new();

    public async Task<Response> Handler(Request req, ILambdaContext ctx)
    {
        // reuses Http and S3 across warm invocations on the same instance
    }
}
```

This pattern is documented in [How to unit-test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/), which covers the testability angle. For Lambda, the rule is simply: anything that is expensive to construct and safe to reuse goes static.

### Use System.Text.Json source generators, always

Default `System.Text.Json` reflects over your DTO types on first use, which inflates init time and is incompatible with Native AOT. Source generators do the work at build time:

```csharp
// .NET 11
[JsonSerializable(typeof(APIGatewayProxyRequest))]
[JsonSerializable(typeof(APIGatewayProxyResponse))]
[JsonSerializable(typeof(MyDomainObject))]
public partial class LambdaJsonContext : JsonSerializerContext;
```

Pass the generated context to `SourceGeneratorLambdaJsonSerializer<T>`. This trims hundreds of milliseconds off managed-runtime cold starts and is mandatory for AOT.

### Avoid full ASP.NET Core when you do not need it

The `Amazon.Lambda.AspNetCoreServer.Hosting` adapter lets you run a real ASP.NET Core minimal API behind API Gateway. It is a great DX win, but it boots the entire ASP.NET Core host: configuration providers, logging providers, options validation, the routing graph. For a 5-endpoint Lambda, that is hundreds of milliseconds of init. Compare to a hand-written `LambdaBootstrapBuilder` handler, which boots in tens of milliseconds.

Pick deliberately:

-   **Many endpoints, complex pipeline, want middleware**: ASP.NET Core hosting is fine, take the SnapStart route.
-   **One handler, one route, performance matters**: write a raw handler against `Amazon.Lambda.RuntimeSupport`. If you also want HTTP request shapes, accept `APIGatewayHttpApiV2ProxyRequest` directly.

### ReadyToRun when AOT is too restrictive

If you cannot ship Native AOT because of a reflection-heavy dependency, but you also cannot use SnapStart (perhaps because you target a managed runtime that does not support it yet), enable **ReadyToRun**. R2R pre-compiles IL to native code that the JIT can use without re-compiling on first call. It cuts JIT cost by roughly 50-70% on cold start at the cost of a larger package:

```xml
<PropertyGroup>
  <PublishReadyToRun>true</PublishReadyToRun>
  <PublishReadyToRunComposite>true</PublishReadyToRunComposite>
</PropertyGroup>
```

R2R is usually a 100-300 ms cold-start win on the managed runtime. It stacks with everything else and is essentially free, so it is the first thing to try if you cannot move to AOT or SnapStart.

## Reading INIT_DURATION correctly

The CloudWatch `REPORT` line for a cold-started invocation has the shape:

```
REPORT RequestId: ... Duration: 12.34 ms Billed Duration: 13 ms
Memory Size: 512 MB Max Memory Used: 78 MB Init Duration: 412.56 ms
```

`Init Duration` is the cold-start cost: VM boot + runtime init + your static constructor and handler-class construction. A few rules for reading it:

-   `Init Duration` is **not billed** on the managed runtime. It is on AOT custom runtimes via the `provided.al2023` model.
-   The first invocation per concurrent instance shows it. Warm invocations omit it.
-   SnapStart functions report `Restore Duration` instead of `Init Duration`. That is your cold-start metric on SnapStart.
-   `Max Memory Used` is the high-water mark. If it stays below ~30% of `Memory Size`, you are likely overprovisioned and could try a smaller size, but only after measuring at the smaller size since CPU drops with memory.

The tooling that makes this readable: a CloudWatch Log Insights query like

```
fields @timestamp, @initDuration, @duration
| filter @type = "REPORT"
| sort @timestamp desc
| limit 200
```

For deeper traces, [How to profile a .NET app with dotnet-trace and read the output](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) covers how to capture and read a flame graph of init from a local Lambda emulator session.

## Provisioned concurrency is the escape hatch, not the answer

Provisioned concurrency keeps `N` warm instances permanently. Cold starts on those instances are zero, because they are not cold. It is the right answer when you have a hard latency SLO that the levers above cannot meet, or when SnapStart's restore semantics conflict with your code. It is the wrong answer as a substitute for actually optimizing init: you are paying for warm capacity 24/7 to mask a fixable problem, and the bill scales with the number of instances you keep warm. Use Application Auto Scaling to scale provisioned concurrency on a schedule if your traffic is predictable.

## The order I apply these in production

Across roughly a dozen .NET Lambdas I have tuned:

1. **Always**: source-generated JSON, static fields for clients, R2R on, `InvariantGlobalization=true` if locale-independent.
2. **If reflection-free**: Native AOT on `provided.al2023`. This alone usually beats every other lever combined.
3. **If reflection is unavoidable**: managed `dotnet10` runtime with SnapStart, plus a synthetic warm-up call during init to pre-JIT the hot path.
4. **Verify** with INIT_DURATION at the actual deployment memory size. Use Power Tuning if the cost-vs-latency curve matters.
5. **Provisioned concurrency** only after the above, and only with auto-scaling.

The rest of the .NET 11 Lambda story (runtime versions, deployment shape, what changes if you flip from `dotnet10` to a future `dotnet11` managed runtime) is covered in [AWS Lambda supports .NET 10: what to verify before you flip the runtime](/2026/01/aws-lambda-supports-net-10-what-to-verify-before-you-flip-the-runtime/), which is the companion to this post.

## Sources

-   [Compile .NET Lambda function code to a native runtime format](https://docs.aws.amazon.com/lambda/latest/dg/dotnet-native-aot.html) - AWS docs.
-   [Improving startup performance with Lambda SnapStart](https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html) - AWS docs.
-   [.NET 10 runtime now available in AWS Lambda](https://aws.amazon.com/blogs/compute/net-10-runtime-now-available-in-aws-lambda/) - AWS blog.
-   [Lambda runtimes overview](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) - including `provided.al2023`.
-   [aws/aws-lambda-dotnet](https://github.com/aws/aws-lambda-dotnet) - the source for `Amazon.Lambda.RuntimeSupport`.
-   [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) - the cost-vs-latency tuner.
