---
title: "How to Call the Claude API from a .NET 11 Minimal API with Streaming"
description: "Stream Claude responses from an ASP.NET Core 11 minimal API end-to-end: the official Anthropic .NET SDK, TypedResults.ServerSentEvents, SseItem, IAsyncEnumerable, cancellation flow, and the gotchas that buffer your tokens silently. With Claude Sonnet 4.6 and Opus 4.7 examples."
pubDate: 2026-04-30
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "aspnet-core"
  - "dotnet-11"
  - "streaming"
---

If you wire Claude into an ASP.NET Core 11 minimal API the obvious way, you will get a request that "works" and an output that arrives in one slow lump after twelve seconds. The Anthropic API is streaming the response as it generates each token. Your endpoint is collecting them, JSON-serialising the full message, and shipping the whole thing once the model says `message_stop`. Every server, proxy, and browser between Kestrel and the user is buffering it because nothing told them this was a stream.

This guide shows the right wiring on the current stack: ASP.NET Core 11 (preview 3 as of April 2026, RTM later this year), the official Anthropic .NET SDK (`Anthropic` on NuGet), Claude Sonnet 4.6 (`claude-sonnet-4-6`) and Claude Opus 4.7 (`claude-opus-4-7`), and `TypedResults.ServerSentEvents` from `Microsoft.AspNetCore.Http`. We will go from a plain endpoint that buffers, to an `IAsyncEnumerable<string>` endpoint that streams chunked text, to a typed `SseItem<T>` endpoint that emits proper SSE events a browser `EventSource` can read. Then we will deal with cancellation, errors, tool calls, and the proxies that quietly break the whole thing.

## Why "just await the response" is wrong here

A non-streaming Claude call returns a complete `Message` after the model has finished. For a 1,500-token response on Sonnet 4.6 that is roughly six to twelve seconds of dead air. That is bad UX in a chat UI and worse on a slow connection, because the user sees nothing until everything has arrived. It also costs you the same input tokens whether you stream or not, so there is no upside to buffering.

The streaming endpoint, documented in the [Anthropic streaming reference](https://platform.claude.com/docs/en/build-with-claude/streaming), uses Server-Sent Events. Each chunk is an SSE frame with a named event (`message_start`, `content_block_delta`, `message_stop`, etc.) and a JSON payload. The .NET SDK wraps that in an `IAsyncEnumerable` so you do not have to parse SSE yourself when calling Anthropic. The harder half is the *output* side: how do you re-emit those chunks to the browser without a framework helpfully buffering them?

ASP.NET Core 8 gained native `IAsyncEnumerable<T>` streaming for minimal APIs. ASP.NET Core 10 added `TypedResults.ServerSentEvents` and `SseItem<T>` so you can return proper SSE without hand-rolling `text/event-stream`. Both ship in 11. Together, they cover the two shapes you actually want.

## The buffered version that you should not ship

Here is the naive endpoint, just so we have a starting point to break.

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha (NuGet: Anthropic)
using Anthropic;
using Anthropic.Models.Messages;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(_ => new AnthropicClient());
var app = builder.Build();

app.MapPost("/chat", async (ChatRequest req, AnthropicClient client) =>
{
    var parameters = new MessageCreateParams
    {
        Model = Model.ClaudeSonnet4_6,
        MaxTokens = 1024,
        Messages = [new() { Role = Role.User, Content = req.Prompt }]
    };

    var message = await client.Messages.Create(parameters);
    return Results.Ok(new { text = message.Content[0].Text });
});

app.Run();

record ChatRequest(string Prompt);
```

This works. It also blocks the entire response until Claude finishes. The fix is two changes: switch the SDK call to `CreateStreaming`, and hand ASP.NET an enumerator instead of a `Task<T>`.

## Streaming text chunks with IAsyncEnumerable<string>

The Anthropic .NET SDK exposes `client.Messages.CreateStreaming(parameters)`, which returns an async enumerable of text deltas. Pair that with a minimal API endpoint that returns `IAsyncEnumerable<string>` and ASP.NET Core will stream it as `application/json` (a JSON array, written incrementally) without buffering.

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha
using System.Runtime.CompilerServices;
using Anthropic;
using Anthropic.Models.Messages;

app.MapPost("/chat/stream", (ChatRequest req,
                              AnthropicClient client,
                              CancellationToken ct) =>
{
    return StreamChat(req.Prompt, client, ct);

    static async IAsyncEnumerable<string> StreamChat(
        string prompt,
        AnthropicClient client,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var parameters = new MessageCreateParams
        {
            Model = Model.ClaudeSonnet4_6,
            MaxTokens = 1024,
            Messages = [new() { Role = Role.User, Content = prompt }]
        };

        await foreach (var chunk in client.Messages.CreateStreaming(parameters)
                                                    .WithCancellation(ct))
        {
            yield return chunk;
        }
    }
});
```

Three details matter here:

1. **Local function**, not a lambda. The C# compiler does not allow `yield return` inside lambdas or anonymous methods, so the minimal API delegate calls a local async iterator method. This trips up everyone who has been writing minimal APIs since .NET 6, because every other endpoint shape works as a lambda.
2. **`[EnumeratorCancellation]`** on the `CancellationToken` parameter of the iterator. Without it, the request abort token from ASP.NET will not flow into the enumerator, and a closed connection will not stop the SDK from happily continuing the stream and burning your output tokens. The compiler does not warn about this. Add the attribute or check with a profiler that closing the tab actually cancels the request.
3. **`.WithCancellation(ct)`** on the SDK enumerable. Belt and suspenders, but it makes the cancellation explicit at the boundary you care about.

The wire format on this endpoint is a JSON array. The browser does not get an `EventSource`-friendly stream, but `fetch` with a `ReadableStream` reader works fine, and so does any consumer that knows how to handle a chunked JSON array. If your client is a SignalR hub or a server-driven UI framework, this is usually the shape you want.

## Streaming proper SSE with TypedResults.ServerSentEvents

If your client is a browser using `EventSource` or a third-party tool that expects `text/event-stream`, you want SSE, not JSON. ASP.NET Core 10 added `TypedResults.ServerSentEvents`, which takes an `IAsyncEnumerable<SseItem<T>>` and writes a real SSE response with the right content type, no-cache headers, and correct framing.

`SseItem<T>` is in `System.Net.ServerSentEvents`. Each item carries an event type, an optional ID, an optional reconnection interval, and a `Data` payload of `T`. ASP.NET serialises the payload as JSON unless you ship a string, in which case it goes through verbatim.

```csharp
// .NET 11 preview 3, Anthropic 0.2.0-alpha
using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using Anthropic;
using Anthropic.Models.Messages;
using Microsoft.AspNetCore.Http;

app.MapPost("/chat/sse", (ChatRequest req,
                           AnthropicClient client,
                           CancellationToken ct) =>
{
    return TypedResults.ServerSentEvents(StreamChat(req.Prompt, client, ct));

    static async IAsyncEnumerable<SseItem<string>> StreamChat(
        string prompt,
        AnthropicClient client,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var parameters = new MessageCreateParams
        {
            Model = Model.ClaudeSonnet4_6,
            MaxTokens = 1024,
            Messages = [new() { Role = Role.User, Content = prompt }]
        };

        await foreach (var chunk in client.Messages.CreateStreaming(parameters)
                                                    .WithCancellation(ct))
        {
            yield return new SseItem<string>(chunk, eventType: "delta");
        }

        yield return new SseItem<string>("", eventType: "done");
    }
});
```

Now a browser can do this:

```javascript
// Browser, native EventSource (still GET-only) or fetch-event-source for POST.
const es = new EventSource("/chat/sse?prompt=...");
es.addEventListener("delta", (e) => append(e.data));
es.addEventListener("done", () => es.close());
```

The framing on the wire is the standard SSE shape:

```
event: delta
data: "Hello"

event: delta
data: " world"

event: done
data: ""

```

Two notes on choosing between the two endpoints. If the client is a browser using `EventSource`, you want SSE. If it is anything else, including your own front-end with a `fetch` reader, the `IAsyncEnumerable<string>` endpoint is simpler, more cacheable in CDN config, and keeps the body shape obvious. The `TypedResults.ServerSentEvents` API is documented under [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0).

## Pinning model IDs and cost

For chat-style streaming, the right defaults in April 2026 are:

- **Claude Sonnet 4.6 (`claude-sonnet-4-6`)** for general chat. $3 / million input tokens, $15 / million output. First-byte latency around 400-600 ms in `us-east-1`. Context window 200k.
- **Claude Opus 4.7 (`claude-opus-4-7`)** for hard reasoning. $15 / $75. Slower first byte, 800 ms-1.2 s. Context window 200k, 1M with the long-context beta.
- **Claude Haiku 4.5 (`claude-haiku-4-5`)** for high-throughput cheap calls. $1 / $5. Sub-300 ms first byte.

State the model ID in code, never via a config string the front end can override. The SDK constants (`Model.ClaudeSonnet4_6`, `Model.ClaudeOpus4_7`, `Model.ClaudeHaiku4_5`) compile away the typo risk. Pricing is on the [Claude API pricing page](https://www.anthropic.com/pricing); double-check before you invoice anything.

If you are about to put a long system prompt or tool catalogue in front of every request, you also want prompt caching turned on, because streaming and caching compose cleanly. The breakdown is in [How to add prompt caching to an Anthropic SDK app and measure the hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/).

## What the SDK is hiding from you

The string chunks coming out of `CreateStreaming` are the SDK's friendly view of the raw SSE event stream. The actual events you would see if you parsed the wire yourself are:

- `message_start`: a `Message` envelope with empty `content`. Carries the message ID and initial `usage`.
- `content_block_start`: opens a content block (text, tool_use, or thinking).
- `content_block_delta`: incremental updates. The `delta.type` is one of `text_delta`, `input_json_delta`, `thinking_delta`, or `signature_delta`.
- `content_block_stop`: closes the current block.
- `message_delta`: top-level updates including `stop_reason` and cumulative output token usage.
- `message_stop`: end of stream.
- `ping`: filler, sent to keep proxies from killing idle connections. Ignore.

The SDK collapses all of that into the iterator output you see, but you get a richer view if you ask for it. Check the SDK's overload that returns the raw events, or hold onto the accumulated `Message` after the loop with `.GetFinalMessage()` so you can read the real `usage` (cumulative on `message_delta`, final on `message_stop`). For an agent loop you almost always want the final message: it is where the SDK gives you `stop_reason`, the assembled tool calls, and the input/output token counts you need for billing.

## Cancellation that actually cancels

This is the bug nobody catches in dev and everybody catches in prod. The user closes the tab. ASP.NET trips the request abort token. Your endpoint's `IAsyncEnumerable` is supposed to stop, the SDK is supposed to stop, the underlying HTTP stream to Anthropic is supposed to close. Every link in that chain has to honour the token, and any one of them breaking it leaves you generating tokens nobody is reading.

Three places to verify:

1. The `[EnumeratorCancellation]` attribute on your iterator's token parameter. Without it, the token passed by ASP.NET on `WithCancellation` does not become the iterator's `ct`.
2. The `CreateStreaming` call needs the token. Pass it via `.WithCancellation(ct)` or via the SDK's per-call options if you are on a version that accepts a token directly.
3. The browser side has to actually close. `EventSource` reconnects by default. If you do not call `es.close()` from the client, a navigation away can fire a fresh request a few seconds later. For long completions, this can cost real money.

The cleanest test is to call the endpoint with `curl`, kill it with Ctrl-C mid-stream, and watch the Anthropic dashboard or your own request logs. The connection to Anthropic should close within a second of the client disconnect. If it does not, your token is not flowing somewhere.

For a longer treatment of cancellation in IO loops generally, see [How to cancel a long-running task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Errors mid-stream

A streaming response that has already started cannot return a 500. You committed to a 200 the moment Kestrel flushed the first byte. Errors after that point have to flow as data, not as an HTTP status. The pattern that keeps clients sane:

```csharp
static async IAsyncEnumerable<SseItem<string>> StreamChat(
    string prompt,
    AnthropicClient client,
    [EnumeratorCancellation] CancellationToken ct)
{
    var parameters = new MessageCreateParams
    {
        Model = Model.ClaudeSonnet4_6,
        MaxTokens = 1024,
        Messages = [new() { Role = Role.User, Content = prompt }]
    };

    IAsyncEnumerator<string>? enumerator = null;
    try
    {
        enumerator = client.Messages.CreateStreaming(parameters)
                                     .WithCancellation(ct)
                                     .GetAsyncEnumerator();
    }
    catch (Exception ex)
    {
        yield return new SseItem<string>(ex.Message, eventType: "error");
        yield break;
    }

    while (true)
    {
        bool moved;
        try
        {
            moved = await enumerator.MoveNextAsync();
        }
        catch (OperationCanceledException) { yield break; }
        catch (Exception ex)
        {
            yield return new SseItem<string>(ex.Message, eventType: "error");
            yield break;
        }

        if (!moved) break;
        yield return new SseItem<string>(enumerator.Current, eventType: "delta");
    }

    yield return new SseItem<string>("", eventType: "done");
}
```

This is uglier than the happy path but it is the right shape. A `try` cannot wrap a `yield return`, so you split the iteration into a manual `MoveNextAsync` loop. Mid-stream failures (rate limits, model overload, network hiccups) become an `error` event the client can render. Clean shutdowns become a `done` event. Cancellations exit silently because the request is already gone.

Two specific Anthropic errors deserve their own client-side handling: `overloaded_error` (the model is temporarily out of capacity, retry with backoff) and `rate_limit_error` (you hit the org's per-minute or per-day cap). Both arrive as exceptions from the SDK on the .NET side, with a typed `AnthropicException` you can pattern match on.

## Tool calls in a stream

If your endpoint can produce `tool_use` content blocks, the SDK still gives you a string-typed iterator for text deltas, but you lose the tool call payload unless you also subscribe to the events that carry it. The lower-level `Messages.CreateStreamingRaw` (or the equivalent on your SDK version) exposes the typed events. The pattern: route `text_delta` to your SSE delta channel, route `input_json_delta` (the tool call argument fragments) to a separate `tool` channel, and let the client decide what to render.

In practice, most chat UIs do not need to render the JSON arguments as they stream. They wait for `content_block_stop` on the tool block, then show "Calling get_weather..." and the result. Streaming tool arguments token-by-token is mostly a debugging aid.

If you are already wiring tool calls, you are also probably exposing services to Claude as MCP tools. The .NET-side server pattern is in [How to build a custom MCP server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/). The streaming endpoint here is the *client* of those tools, not the server.

## The proxy buffering that breaks everything

You wire all of this correctly. You hit it from `localhost`. It streams. You deploy it behind nginx, Cloudflare, or an Azure Front Door, and the response goes back to one big buffered lump. Three settings to know about, in priority order:

- **nginx**: set `proxy_buffering off;` on the SSE location, or add `X-Accel-Buffering: no` as a response header from your endpoint. The header trick is portable and survives reverse-proxy changes. Add it in middleware for any endpoint returning `text/event-stream` or `application/json` with `IAsyncEnumerable`.
- **Cloudflare**: enable [Streaming responses](https://developers.cloudflare.com/) on the relevant route. The default behaviour preserves chunks on most plans, but enterprise WAF rules can buffer. Test with the response header trick first.
- **Compression**: response compression middleware can collect chunks to compress in larger blocks. Either disable compression for `text/event-stream`, or use `application/json` with chunked transfer; ASP.NET's response compression knows about both, but a custom middleware ordered before the streaming endpoint can defeat it.

Add this filter to the streaming endpoints to make sure the header is present:

```csharp
app.MapPost("/chat/sse", ...)
   .AddEndpointFilter(async (ctx, next) =>
   {
       ctx.HttpContext.Response.Headers["X-Accel-Buffering"] = "no";
       return await next(ctx);
   });
```

For more on streaming bodies safely from ASP.NET Core, see [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/). The "do not let middleware collect your chunks" lesson applies identically to LLM streams.

## Observability for the streaming endpoint

A streaming Claude call has two latency numbers worth tracking: time-to-first-token (the latency the user feels) and total time-to-completion. Both should land in your traces. ASP.NET Core 11's native OpenTelemetry support makes this easy without taking a dependency on `Diagnostics.Otel` packages. The setup is in [Native OpenTelemetry tracing in ASP.NET Core 11](/2026/04/aspnetcore-11-native-opentelemetry-tracing/).

Capture three custom attributes on the request span: the model ID, the input token count (from the SDK's final `Message`), and the output token count. Cost reconstruction from logs alone is painful otherwise. Latency histograms grouped by model make it obvious when you should fall back from Opus 4.7 to Sonnet 4.6 for routine traffic.

## What about Microsoft.Extensions.AI

If you would rather code against the provider-neutral abstractions, Microsoft.Extensions.AI's `IChatClient.GetStreamingResponseAsync` returns `IAsyncEnumerable<ChatResponseUpdate>` and works the same way at the HTTP boundary. Wrap the Anthropic `IChatClient` adapter, project the updates to text or `SseItem<T>`, and the rest of this article applies unchanged. The trade-off is one layer of abstraction for the option to swap to OpenAI or a local model later. For agent code you also want the framework version, see [Microsoft Agent Framework 1.0: AI agents in C#](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/), which builds on top of those same abstractions.

For the BYOK angle (handing this same Anthropic key to GitHub Copilot in VS Code), the setup mirrors what you do here: the same model IDs, the same key, a different consumer. See [GitHub Copilot in VS Code: BYOK with Anthropic, Ollama, and Foundry Local](/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

## Sources

- [Streaming Messages, Claude API docs](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic .NET SDK on GitHub](https://github.com/anthropics/anthropic-sdk-csharp)
- [Anthropic NuGet package](https://www.nuget.org/packages/Anthropic/)
- [Create responses in Minimal API applications, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0)
- [System.Net.ServerSentEvents.SseItem<T>](https://learn.microsoft.com/en-us/dotnet/api/system.net.serversentevents.sseitem-1)
- [Claude API pricing](https://www.anthropic.com/pricing)
