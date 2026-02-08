---
title: "AWS Lambda Supports .NET 10: What to Verify Before You Flip the Runtime"
description: "AWS Lambda support for .NET 10 is starting to show up in community channels today, and it is the kind of change that looks “done” until you hit cold starts, trimming, or a native dependency in production. Source discussion: https://www.reddit.com/r/dotnet/comments/1q7p9t3/aws_lambda_supports_net_10/ Runtime support is the easy part, your deployment shape is the hard part Moving a…"
pubDate: 2026-01-08
tags:
  - "net"
  - "net-10"
---
AWS Lambda support for **.NET 10** is starting to show up in community channels today, and it is the kind of change that looks “done” until you hit cold starts, trimming, or a native dependency in production.

Source discussion: [https://www.reddit.com/r/dotnet/comments/1q7p9t3/aws\_lambda\_supports\_net\_10/](https://www.reddit.com/r/dotnet/comments/1q7p9t3/aws_lambda_supports_net_10/)

## Runtime support is the easy part, your deployment shape is the hard part

Moving a Lambda from .NET 8/9 to **.NET 10** is not just a target framework bump. The runtime you select drives:

-   **Cold start behavior**: JIT, ReadyToRun, native AOT, and how much code you ship all change the startup profile.
-   **Packaging**: container image vs ZIP, plus how you handle native libraries.
-   **Reflection-heavy frameworks**: trimming and AOT can turn “works locally” into “fails at runtime”.

If you want .NET 10 primarily for performance, don’t assume the Lambda runtime upgrade is the win. Measure cold starts with your real handler, real dependencies, real environment variables, and real memory settings.

## A minimal .NET 10 Lambda handler you can benchmark

Here’s a small handler that is easy to benchmark and easy to break with trimming. It also shows a pattern I like: keep the handler tiny, push everything else behind DI or explicit code paths.

```cs
using Amazon.Lambda.Core;

[assembly: LambdaSerializer(typeof(Amazon.Lambda.Serialization.SystemTextJson.DefaultLambdaJsonSerializer))]

public sealed class Function
{
    // Use a static instance to avoid per-invocation allocations.
    private static readonly HttpClient Http = new();

    public async Task<Response> FunctionHandler(Request request, ILambdaContext context)
    {
        // Touch something typical: logging + a small outbound call.
        context.Logger.LogLine($"RequestId={context.AwsRequestId} Name={request.Name}");

        var status = await Http.GetStringAsync("https://example.com/health");
        return new Response($"Hello {request.Name}. Upstream says: {status.Length} chars");
    }
}

public sealed record Request(string Name);
public sealed record Response(string Message);
```

Now publish in a way that matches your intended production path. If you are testing trimming, make it explicit:

```bash
dotnet publish -c Release -f net10.0 -p:PublishTrimmed=true
```

If you plan to go further into native AOT in .NET 10, publish that way too, and validate that your dependencies are actually AOT-compatible (serialization, reflection, native libs).

## A practical checklist for the first .NET 10 rollout

-   **Measure cold start and steady-state separately**: p50 and p99 for both.
-   **Turn on trimming only if you can test it**: trimming failures are usually runtime failures.
-   **Confirm your Lambda memory setting**: it changes CPU allocation and can flip your results.
-   **Pin dependencies that are sensitive to TFMs**: `Amazon.Lambda.*`, serializers, and anything that uses reflection.

If you want a safe first step, upgrade the runtime to **.NET 10** and keep your deployment strategy the same. Once it is stable, experiment with trimming or AOT in a branch, and only ship it when your monitoring says it is boring.
