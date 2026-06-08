---
title: "Anthropic SDK vs Microsoft.Extensions.AI for Calling Claude From .NET"
description: "Two ways to call Claude from C#: the official Anthropic .NET SDK directly, or the provider-neutral Microsoft.Extensions.AI IChatClient that wraps it. When each wins, what you lose at the abstraction boundary, and why it is not actually either/or. With claude-opus-4-8 and claude-sonnet-4-6 examples."
pubDate: 2026-06-08
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "microsoft-extensions-ai"
  - "dotnet-11"
  - "csharp"
---

If you are calling Claude from a .NET app in 2026 you have two front doors, and the choice between them is less about Anthropic and more about how much of your code you want tied to one provider. You can code against the official **Anthropic .NET SDK** (`Anthropic` on NuGet, version 10+, currently beta) and get Anthropic-shaped types with every API feature exposed. Or you can code against **Microsoft.Extensions.AI** (`IChatClient`, GA since May 2025), a provider-neutral abstraction that gives you a function-calling loop, telemetry, caching middleware, and a one-line swap to OpenAI or a local model later. The trap is treating it as either/or. The Anthropic SDK ships an `AsIChatClient()` adapter, so Microsoft.Extensions.AI sits *on top of* the same package. The real question is which surface your application code binds to.

This post pins both stacks on current versions: the `Anthropic` package (10+, `Model.ClaudeOpus4_8` and `Model.ClaudeSonnet4_6`), Microsoft.Extensions.AI 10.6, and .NET 10/11. We go through the same chat call written both ways, then the decision that actually matters: which features you forfeit at the abstraction boundary, and when forfeiting them is the right call.

## The same call, two front doors

Here is a one-shot completion through the Anthropic SDK directly. The types are Anthropic's own: `AnthropicClient`, `MessageCreateParams`, `Message`.

```csharp
// .NET 10, Anthropic 10+ (NuGet: Anthropic), beta
using Anthropic;
using Anthropic.Models.Messages;

AnthropicClient client = new(); // reads ANTHROPIC_API_KEY

MessageCreateParams parameters = new()
{
    Model = Model.ClaudeSonnet4_6,
    MaxTokens = 1024,
    Messages =
    [
        new() { Role = Role.User, Content = "Summarise the CAP theorem in two sentences." }
    ]
};

Message message = await client.Messages.Create(parameters);
Console.WriteLine(message.Content[0].Text);
```

Now the same completion through Microsoft.Extensions.AI. You still need a provider underneath, and the official Anthropic SDK gives you one with `AsIChatClient(modelId)`. From there you are speaking the neutral `IChatClient` vocabulary: `ChatMessage`, `ChatRole`, `GetResponseAsync`.

```csharp
// .NET 10, Anthropic 10+, Microsoft.Extensions.AI 10.6
using Anthropic;
using Microsoft.Extensions.AI;

AnthropicClient anthropic = new();
IChatClient chat = anthropic.AsIChatClient("claude-sonnet-4-6");

ChatResponse response = await chat.GetResponseAsync(
    "Summarise the CAP theorem in two sentences.");

Console.WriteLine(response.Text);
```

Same network call, same model, same key. The difference is the type vocabulary your code is written against. In the first version, swapping to OpenAI means rewriting every `MessageCreateParams` and `Message.Content[0].Text`. In the second, it means changing `anthropic.AsIChatClient(...)` to `openAIClient.GetChatClient("gpt-5").AsIChatClient()` and leaving the rest alone. That portability is the entire value proposition of the abstraction, and it is real. So is the cost, which is the rest of this post.

## What the abstraction gives you for free

The reason to reach for `IChatClient` is rarely the basic completion. It is the middleware pipeline that the `ChatClientBuilder` lets you stack on top, none of which exists in the raw Anthropic SDK.

The headline is automatic function invocation. With the Anthropic SDK directly you write the tool loop yourself: send tool definitions, inspect the response for a `tool_use` block, deserialise the arguments, call your method, append a `tool_result`, call the model again, repeat until it stops. Microsoft.Extensions.AI collapses that into one builder step.

```csharp
// .NET 10, Anthropic 10+, Microsoft.Extensions.AI 10.6
using Anthropic;
using Microsoft.Extensions.AI;

[System.ComponentModel.Description("Get the shipping status for an order")]
static string GetOrderStatus(int orderId) =>
    orderId == 1042 ? "packed, ships tomorrow" : "unknown order";

AnthropicClient anthropic = new();

IChatClient chat = anthropic
    .AsIChatClient("claude-sonnet-4-6")
    .AsBuilder()
    .UseFunctionInvocation()
    .Build();

ChatOptions options = new()
{
    Tools = [AIFunctionFactory.Create(GetOrderStatus)]
};

ChatResponse response = await chat.GetResponseAsync(
    "Is order 1042 ready to ship?", options);

Console.WriteLine(response.Text); // model called GetOrderStatus, then answered
```

`AIFunctionFactory.Create` generates the JSON schema from the method signature, `UseFunctionInvocation` runs the loop, and `FunctionInvokingChatClient` enforces the safe defaults (it refuses to invoke functions you did not register, caps iterations, and honours your `CancellationToken`). I covered the knobs that decide whether that loop is production-safe in [how to add tool calling to a Microsoft.Extensions.AI chat client](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/). Writing the equivalent against the bare Anthropic types is maybe forty lines of careful, easy-to-get-wrong glue per project.

The same builder pattern gives you `UseDistributedCache` (response caching keyed on the request), `UseOpenTelemetry` (spans and token-usage metrics that follow the OTel GenAI semantic conventions), and `UseLogging`, all as `DelegatingChatClient` layers. You opt into each with one line, and they are provider-agnostic, so the OpenTelemetry you wire today keeps working when you swap the model underneath.

There is a second, quieter payoff: MCP tools drop straight in. Because the Model Context Protocol C# SDK (`ModelContextProtocol`) exposes its tools as `AIFunction` instances, you can list a server's tools and hand them to `ChatOptions.Tools` without writing an adapter:

```csharp
// .NET 10, Anthropic 10+, Microsoft.Extensions.AI 10.6, ModelContextProtocol
using ModelContextProtocol.Client;

McpClient server = await McpClient.CreateAsync(
    new HttpClientTransport(new() { Endpoint = new("https://learn.microsoft.com/api/mcp") }));

ChatOptions options = new() { Tools = [.. await server.ListToolsAsync()] };
ChatResponse response = await chat.GetResponseAsync("How do I use IChatClient?", options);
```

If you are building agents rather than one-shot calls, this is the layer the [Microsoft Agent Framework](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) builds on, and it is why the framework can talk to Claude, GPT, and a local model through one orchestration surface. If your endpoint is going to grow tools, you almost certainly want the `IChatClient` side.

## What you forfeit at the boundary

`IChatClient` is, by construction, the intersection of what every provider can do. Anything Anthropic-specific that does not have an equivalent on OpenAI or Gemini either lives in the loosely-typed `AdditionalProperties` bag or is not reachable at all through the neutral surface. Four things you give up, in rough order of how often it bites:

**Prompt caching with explicit cache breakpoints.** Anthropic's prompt caching is driven by `cache_control` markers you place on specific content blocks (a long system prompt, a tool catalogue, a document) so the next request reuses the prefix at a 90% discount. That is an Anthropic-shaped concept. Through the raw SDK you set it directly on the content block; through `IChatClient` you are pushing provider-specific JSON into `AdditionalProperties` and hoping the adapter forwards it. If caching is central to your cost model, and at $3 / $15 per million tokens on Sonnet 4.6 it usually is for any app with a fat system prompt, stay close to the metal. The mechanics and how to read the hit rate are in [how to add prompt caching to an Anthropic SDK app](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/).

**Extended thinking.** Claude's thinking blocks (the `thinking_delta` events, the reasoning budget, the encrypted thinking signatures you must echo back on multi-turn tool use) are first-class on the Anthropic types and awkward through the neutral abstraction. Microsoft.Extensions.AI added a generic reasoning-content concept, but the fidelity (budget control, signature round-tripping) lives in the provider SDK.

**Message Batches, the Files API, citations, PDF input.** These are whole endpoints, not parameters. `client.Messages.Batches`, `client.Beta.Files`, and the document/citation content blocks have no `IChatClient` equivalent because they are not chat completions. You reach them only through `AnthropicClient`.

**Typed errors and retries.** The Anthropic SDK throws a typed hierarchy: `AnthropicRateLimitException` (429), `AnthropicBadRequestException` (400), `Anthropic5xxException`, and it retries connection errors, 408, 409, 429, and 5xx twice by default with backoff. Through `IChatClient` those surface as a more generic exception, and you lose the easy `catch (AnthropicRateLimitException)` pattern-match that lets you implement smart backoff. Handling `rate_limit_error` cleanly in a long agent loop is its own topic; the raw exception type makes it tractable.

The honest summary: the neutral surface covers chat, streaming, tool calling, and structured output. The moment you need an Anthropic capability that OpenAI does not have a twin for, you are either dropping into provider-specific escape hatches or back on `AnthropicClient`.

## You can have both

The framing that trips people up is "pick one SDK". You do not have to. Because `AsIChatClient()` is just an adapter over the same `AnthropicClient`, you can hold both references and use whichever fits the call.

```csharp
// .NET 10, Anthropic 10+, Microsoft.Extensions.AI 10.6
using Anthropic;
using Microsoft.Extensions.AI;

AnthropicClient anthropic = new();

// The agent loop runs against the portable surface...
IChatClient chat = anthropic
    .AsIChatClient("claude-sonnet-4-6")
    .AsBuilder()
    .UseFunctionInvocation()
    .UseOpenTelemetry()
    .Build();

// ...and the Anthropic-only batch job uses the native client directly.
var batch = await anthropic.Messages.Batches.Create(/* ... */);
```

In a DI container, register `AnthropicClient` as a singleton and expose `IChatClient` as a second registration that resolves the same underlying client. Your agent and chat code take `IChatClient` and stay portable; the two or three places that need prompt caching, batches, or thinking budgets take `AnthropicClient` and stay precise. This is the pattern I reach for by default now: bind the broad surface of the app to the abstraction, and let the small set of Anthropic-specific calls bind to the metal.

## A note on which Anthropic package

Watch the package identity, because the NuGet name was reused. As of version 10+, the `Anthropic` package is the **official** Anthropic SDK (the one with `AnthropicClient`, `MessageCreateParams`, and `AsIChatClient`). Versions 3.x and below under that same name were the community tryAGI SDK, which has since moved to the `tryAGI.Anthropic` package. There is also a separate, popular community package literally named `Anthropic.SDK` (currently 5.x) that predates the official one and ships its own `IChatClient` support. If you copy a snippet off a 2025 blog post and your `using` statements do not resolve, you are almost certainly mixing these three. For anything new, use the official `Anthropic` package and pin it explicitly, because it is still in beta and minor versions can carry breaking changes.

One more version note: the official SDK's model constants track the current lineup, so `Model.ClaudeOpus4_8`, `Model.ClaudeSonnet4_6`, and `Model.ClaudeHaiku4_5` compile away the string-typo risk. Through `IChatClient` you pass the model ID as a string (`"claude-opus-4-8"`), which is one fewer compile-time guard. Keep those IDs in one constants file either way.

## How I would choose

A short decision matrix, since that is what you came for:

- **One provider, and you need Anthropic-specific features** (prompt caching with explicit breakpoints, extended thinking budgets, batches, files, citations): code against `AnthropicClient` directly. The abstraction would only get in your way.
- **You expect to swap providers, or run more than one** (an A/B between Sonnet and GPT, a cheap local fallback, BYOK): code against `IChatClient`. The one-line provider swap is worth the lowest-common-denominator surface.
- **You are building an agent or anything tool-heavy**: `IChatClient`, for `UseFunctionInvocation` and the MCP tool integration alone. Hand-rolling the tool loop per provider is a tax you do not need to pay.
- **You want both** (most non-trivial apps): bind the app to `IChatClient`, keep an `AnthropicClient` on hand for the handful of native calls. They are the same client underneath.
- **A streaming chat endpoint specifically**: either works at the HTTP boundary; the wiring, cancellation flow, and proxy-buffering traps are the same. I walked through the SSE plumbing in [how to call the Claude API from a .NET 11 minimal API with streaming](/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/).

The instinct to standardise everything on `IChatClient` because "abstractions are good" is the one to watch. Abstractions are good until the feature you are paying Anthropic for lives below the abstraction. Prompt caching is the usual culprit: teams adopt the neutral surface, lose the cache breakpoints, and quietly pay full input price on every turn. Pick the front door per call, not per codebase, and you keep both the portability and the features. If you are coming at this from the broader "how do I do GenAI on .NET at all" angle, the [generative AI for beginners on .NET](/2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai/) walkthrough sets up the same Microsoft.Extensions.AI foundation this post builds on.

## Sources

- [Anthropic C# SDK documentation](https://platform.claude.com/docs/en/api/sdks/csharp)
- [Anthropic .NET SDK on GitHub](https://github.com/anthropics/anthropic-sdk-csharp)
- [Anthropic NuGet package](https://www.nuget.org/packages/Anthropic)
- [Use the IChatClient interface, .NET docs](https://learn.microsoft.com/en-us/dotnet/ai/ichatclient)
- [AI and Vector Data Extensions are now GA, .NET Blog](https://devblogs.microsoft.com/dotnet/ai-vector-data-dotnet-extensions-ga/)
- [Claude API pricing](https://www.anthropic.com/pricing)
