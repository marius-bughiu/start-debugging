---
title: "How to Add Tool Calling to a Microsoft.Extensions.AI Chat Client"
description: "Wire AIFunctionFactory.Create, ChatOptions.Tools, and ChatClientBuilder.UseFunctionInvocation in Microsoft.Extensions.AI 10.5 so an IChatClient can call your .NET methods automatically. Covers OpenAI and Azure OpenAI providers, the FunctionInvokingChatClient knobs that actually matter (iteration limits, concurrent calls, approval prompts, error handling), and streaming responses with tools."
pubDate: 2026-05-03
tags:
  - "llm"
  - "ai-agents"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "openai-sdk"
---

The shortest path to giving an LLM access to your code in .NET is no longer "pick the OpenAI SDK and hand-roll the tool loop". With **Microsoft.Extensions.AI 10.5.1** (released May 2, 2026, targeting .NET 8 / 9 / 10, .NET Standard 2.0, and .NET Framework 4.6.2+), you build an `IChatClient` pipeline with `ChatClientBuilder.UseFunctionInvocation()`, declare your tools as plain delegates wrapped by `AIFunctionFactory.Create`, and the library runs the call/response loop, the JSON schema generation, and the result marshalling for you. The same pipeline works against OpenAI, Azure OpenAI, Ollama, and anything else that ships an `IChatClient` adapter.

This post walks through wiring tool calling on a real `Program.cs`, covers the `FunctionInvokingChatClient` settings that decide whether the loop is safe in production (`MaximumIterationsPerRequest`, `AllowConcurrentInvocation`, `IncludeDetailedErrors`, `MaximumConsecutiveErrorsPerRequest`, `TerminateOnUnknownCalls`), explains how to add streaming and how to gate dangerous tools behind explicit approval with `ApprovalRequiredAIFunction`, then ends with the gotchas you only learn after the model gets a tool call wrong on a Friday afternoon.

## Why `Microsoft.Extensions.AI` is now the right entry point for tool calling

Until the **9.x preview wave in early 2025**, every provider shipped its own tool-calling primitive. The OpenAI .NET SDK had `ChatTool.CreateFunctionTool`, the Anthropic community SDKs had their own `Tool` records, Azure had a slightly different shape on top of the OpenAI library, and Semantic Kernel papered over it with `[KernelFunction]`. Each one needed its own loop: call the model, inspect the response, look for a function call, deserialise arguments, invoke the .NET method, append a result message, call again. Easy to get wrong, easy to leak details, and tied your application code to whichever provider you started with.

`Microsoft.Extensions.AI` collapses that into one abstraction. The `Microsoft.Extensions.AI.Abstractions` package defines `IChatClient`, which any provider library can implement. The `Microsoft.Extensions.AI` package adds the middleware that runs on top: function invocation, telemetry, caching, distributed tracing, and structured-output parsing. The same `IChatClient` you build for OpenAI today can be swapped to Azure OpenAI or to a local Ollama instance tomorrow with one constructor change, and the `UseFunctionInvocation()` step does not move.

There is a second reason worth pinning. Function invocation in this library is not just "send tool definitions and parse a function call". The middleware is a real `DelegatingChatClient` (see [`FunctionInvokingChatClient`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.ai.functioninvokingchatclient)) that loops until there are no more pending calls or until you hit a stop condition you set. That loop respects `CancellationToken`, surfaces structured errors, and refuses to invoke functions the caller has not registered. You get the safe defaults for free, and the unsafe knobs are off by default.

## A concrete scenario: an order-lookup tool over OpenAI

The example throughout this post is a console app that exposes one tool, `get_order_status(orderId)`, to the model and asks it questions like "Is order 1042 ready to ship?". The shape generalises to any internal API or EF Core query.

Start with a fresh project on .NET 10 and the latest stable Microsoft.Extensions.AI bits. The OpenAI provider package is **Microsoft.Extensions.AI.OpenAI 10.5.1**, which depends on the official `OpenAI` SDK and exposes the `AsIChatClient()` adapter.

```bash
# .NET 10, Microsoft.Extensions.AI 10.5.1, OpenAI 2.x
dotnet new console -o ToolCallingDemo
cd ToolCallingDemo
dotnet add package Microsoft.Extensions.AI --version 10.5.1
dotnet add package Microsoft.Extensions.AI.OpenAI --version 10.5.1
dotnet add package Microsoft.Extensions.Configuration
dotnet add package Microsoft.Extensions.Configuration.UserSecrets
dotnet user-secrets init
dotnet user-secrets set OpenAIKey sk-...
dotnet user-secrets set ModelName gpt-5
```

The pipeline is three lines. `OpenAIClient.GetChatClient(model).AsIChatClient()` gives you the raw `IChatClient`. Wrapping it in `ChatClientBuilder` and calling `UseFunctionInvocation()` returns an `IChatClient` that handles the loop.

```csharp
// Microsoft.Extensions.AI 10.5.1, .NET 10, OpenAI 2.x
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Configuration;
using OpenAI;

IConfigurationRoot config = new ConfigurationBuilder()
    .AddUserSecrets<Program>()
    .Build();

string model = config["ModelName"] ?? "gpt-5";
string apiKey = config["OpenAIKey"]!;

IChatClient client = new ChatClientBuilder(
        new OpenAIClient(apiKey).GetChatClient(model).AsIChatClient())
    .UseFunctionInvocation()
    .Build();
```

Swap to Azure OpenAI by changing the inner client only. Everything below this line is identical.

```csharp
// Azure OpenAI variant. Microsoft.Extensions.AI.OpenAI 10.5.1 + Azure.AI.OpenAI 2.x.
using Azure;
using Azure.AI.OpenAI;

IChatClient client = new ChatClientBuilder(
        new AzureOpenAIClient(
            new Uri(config["AZURE_OPENAI_ENDPOINT"]!),
            new AzureKeyCredential(config["AZURE_OPENAI_API_KEY"]!))
        .GetChatClient(config["AZURE_OPENAI_GPT_NAME"]!).AsIChatClient())
    .UseFunctionInvocation()
    .Build();
```

## Declaring tools with `AIFunctionFactory.Create`

`AIFunctionFactory.Create` accepts any `Delegate`, reflects over its parameters, generates a JSON Schema from the parameter types, and returns an `AIFunction` ready to drop into `ChatOptions.Tools`. The schema is built from parameter names, types, and `[Description]` attributes. Optional parameters become optional in the schema. Nullable reference annotations become nullable JSON properties.

```csharp
// AIFunction is the runtime representation the model sees.
// AIFunctionFactory.Create handles schema generation and the invocation contract.
using System.ComponentModel;

ChatOptions chatOptions = new()
{
    Tools =
    [
        AIFunctionFactory.Create(
            ([Description("The numeric order id, e.g. 1042")] int orderId,
             CancellationToken ct) => GetOrderStatus(orderId, ct),
            name: "get_order_status",
            description: "Looks up the current shipping status for an order.")
    ]
};

static async Task<string> GetOrderStatus(int orderId, CancellationToken ct)
{
    // Call EF Core, an internal API, etc.
    await Task.Delay(20, ct);
    return orderId == 1042
        ? "{\"status\":\"packed\",\"carrier\":\"UPS\",\"eta\":\"2026-05-05\"}"
        : "{\"status\":\"unknown\"}";
}
```

Three things are happening here that are easy to miss. First, the `CancellationToken` parameter is recognised and never appears in the JSON schema sent to the model. The middleware injects the active token at invocation time, which means a cancelled request actually cancels in-flight tool work. Second, `[Description]` flows through to the schema's `description` field on the property, which is what the model sees and what shapes how it picks the tool. Third, returning a JSON string is fine but not required: the middleware will serialise any `Task<T>` return value through `System.Text.Json` with the options you configure on the `ChatClientBuilder`.

If you have a class with several related methods, point `Create` at instance methods or use the overload that takes a `MethodInfo` plus a target object. That keeps construction in DI without losing the schema generation.

```csharp
public sealed class OrderTools(IOrderRepository repo)
{
    [Description("Looks up the current shipping status for an order.")]
    public Task<OrderStatus> GetOrderStatusAsync(
        [Description("The numeric order id, e.g. 1042")] int orderId,
        CancellationToken ct) => repo.GetStatusAsync(orderId, ct);
}

OrderTools tools = serviceProvider.GetRequiredService<OrderTools>();

ChatOptions chatOptions = new()
{
    Tools = [AIFunctionFactory.Create(tools.GetOrderStatusAsync)]
};
```

Run the conversation and the loop runs itself.

```csharp
List<ChatMessage> history =
[
    new(ChatRole.System, "You are an internal ops assistant. Use the order tools to answer."),
    new(ChatRole.User, "Is order 1042 ready to ship?")
];

ChatResponse response = await client.GetResponseAsync(history, chatOptions);
Console.WriteLine(response.Text);
```

What the user sees is a plain answer. What the middleware did under the covers: forwarded the request to the inner OpenAI client, observed a `FunctionCallContent` in the response, located the matching `AIFunction` by name, deserialised the arguments, invoked the .NET method, packaged the return value into a `FunctionResultContent`, and called the inner client again with the appended history. That loop repeats until the model produces an assistant message with no further calls. The `ChatResponse.Messages` collection contains the full intermediate history, including the function calls and their results, which is what you should persist if you want the next turn to continue cleanly.

If you have used the Anthropic SDK directly to drive a similar loop, this is the same control flow described in [the Claude API streaming guide](/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/), but the loop is library code instead of yours.

## The `FunctionInvokingChatClient` settings that matter in production

Defaults are sensible; the failure modes are interesting. The `IChatClient` returned by `UseFunctionInvocation()` is a `FunctionInvokingChatClient`, and you can configure it with the overload that exposes the instance.

```csharp
IChatClient client = new ChatClientBuilder(
        new OpenAIClient(apiKey).GetChatClient(model).AsIChatClient())
    .UseFunctionInvocation(loggerFactory: null, configure: f =>
    {
        f.MaximumIterationsPerRequest = 5;
        f.MaximumConsecutiveErrorsPerRequest = 2;
        f.AllowConcurrentInvocation = false;
        f.IncludeDetailedErrors = false;
        f.TerminateOnUnknownCalls = true;
    })
    .Build();
```

`MaximumIterationsPerRequest` is the hard cap on how many times the model can ping-pong with your tools inside a single `GetResponseAsync` call. The default is generous enough that a misbehaving model can rack up real money before it gives up. Five is a reasonable ceiling for most internal tools. If you go above ten you almost certainly want to redesign the prompt.

`MaximumConsecutiveErrorsPerRequest` exists because models will sometimes loop on a tool that keeps throwing. Without this cap a buggy database call can chew through tokens for nothing. Two is a safe upper bound, three at most.

`AllowConcurrentInvocation` is `false` by default and you should keep it that way unless you have proven your tools are thread-safe. The setting only governs concurrent invocations within the same request; concurrent requests against the same `FunctionInvokingChatClient` instance can still hit your tool simultaneously, so make the underlying methods thread-safe regardless.

`IncludeDetailedErrors` defaults to `false`, which is correct in production. When a tool throws, the middleware sends the model a sanitised error and lets it decide what to do. Flipping this to `true` for development is fine; leaving it on in production leaks stack traces into the prompt and, depending on your provider, into the provider's logs.

`TerminateOnUnknownCalls` should usually be `true`. The default behaviour treats an unknown function call as an error to feed back to the model, which can lead to it confidently making up other unknown calls. Terminating the loop puts the conversation back in your hands.

## Streaming responses while tools fire

`UseFunctionInvocation()` works just as well with `GetStreamingResponseAsync`. The middleware buffers the function-call portions of the stream, runs the tool, then resumes streaming the assistant text. You see only the user-visible chunks.

```csharp
await foreach (ChatResponseUpdate chunk in
    client.GetStreamingResponseAsync(history, chatOptions))
{
    if (chunk.Text is { Length: > 0 } text)
    {
        Console.Write(text);
    }
}
```

Two operational details are worth knowing. The middleware will not interleave a tool result mid-token; it waits for the full call payload before invoking the tool, which means latency during a tool call looks like a brief stall. And streaming with multiple tool calls in flight requires `ChatOptions.AllowMultipleToolCalls` to be set explicitly. Setting it to `false` forces the model to call one tool at a time, which is the right tradeoff when those tools touch shared state.

## Human-in-the-loop with `ApprovalRequiredAIFunction`

Some tools should never be invoked automatically. Anything that writes, sends, or charges belongs behind an explicit approval. Wrap the `AIFunction` in `ApprovalRequiredAIFunction` and the middleware will replace the model's call with a `ToolApprovalRequestContent`, returning control to your code.

```csharp
// Microsoft.Extensions.AI 10.5.1
AIFunction refundTool = AIFunctionFactory.Create(
    (string orderId, decimal amount) => IssueRefundAsync(orderId, amount),
    name: "issue_refund",
    description: "Issues a refund of `amount` for the given order.");

ChatOptions chatOptions = new()
{
    Tools = [new ApprovalRequiredAIFunction(refundTool)]
};

ChatResponse response = await client.GetResponseAsync(history, chatOptions);

foreach (ChatMessage msg in response.Messages)
{
    foreach (AIContent c in msg.Contents)
    {
        if (c is ToolApprovalRequestContent approval)
        {
            // Surface to a human, then send a ToolApprovalResponseContent
            // back in the next request. Until you do, the loop is paused.
        }
    }
}
```

Approvals are sticky for a single response. If any one call in a model response requires approval, every other tool call from the same response also surfaces as an approval request, even if the underlying tool is not approval-gated. If that is too coarse, set `ChatOptions.AllowMultipleToolCalls = false` so the model can only call one tool at a time and approvals stay scoped to a single tool.

## Per-pipeline tools with `AdditionalTools`

`ChatOptions.Tools` is per-call. `FunctionInvokingChatClient.AdditionalTools` is per-pipeline. Use the second one for tools that should always be available regardless of which `ChatOptions` the caller passes, like a `get_current_time` helper or a logging-only tool.

```csharp
IChatClient client = new ChatClientBuilder(...)
    .UseFunctionInvocation(configure: f =>
    {
        f.AdditionalTools =
        [
            AIFunctionFactory.Create(
                () => DateTimeOffset.UtcNow.ToString("O"),
                "get_current_time_utc",
                "Returns the current UTC time as ISO 8601.")
        ];
    })
    .Build();
```

Per-call tools and additional tools both end up in the request, and the middleware can route a `FunctionCallContent` to either one. Keep ambient tools small; the schema for every registered tool ships with every request and counts against your prompt budget.

## Layering middleware: logging, caching, OpenTelemetry

The point of `ChatClientBuilder` is the order of middleware matters. Function invocation typically sits in the middle of the pipeline, with logging and tracing on the outside and caching closer to the inner client.

```csharp
IChatClient client = new ChatClientBuilder(
        new OpenAIClient(apiKey).GetChatClient(model).AsIChatClient())
    .UseOpenTelemetry(loggerFactory, sourceName: "ToolCallingDemo")
    .UseFunctionInvocation()
    .UseDistributedCache(cache) // optional, only caches non-tool calls
    .Build();
```

`UseDistributedCache` will not cache responses that include tool calls, which is the only sensible behaviour: caching a `FunctionCallContent` would short-circuit the tool. Plain Q&A turns where the model returns text only do get cached, which is where most of the savings live for repeat queries.

If you have not picked a tracing setup yet, the `UseOpenTelemetry` middleware emits the standard GenAI semantic conventions, the same shape used in [the .NET 11 native OpenTelemetry tracing post](/2026/04/aspnetcore-11-native-opentelemetry-tracing/), so existing dashboards pick it up without configuration.

## Gotchas, in priority order

Tool names must be stable across calls in a conversation. The model uses the name to bind a `FunctionCallContent` to a `FunctionResultContent`. Renaming a tool between turns will break replays of stored history. Keep names snake_case, ASCII, and short.

JSON schema drift bites silently. If you change a parameter from `int` to `int?`, the schema flips from required to optional and the model may stop providing it. After any signature change, log the generated schema once and diff it against the previous version. `AIFunction.JsonSchema` exposes the current shape.

`AIFunctionFactory.Create` reflects the parameter types eagerly. If you pass a delegate that closes over a captured variable, the schema is built once. Recreating the `AIFunction` per request is cheap, but if you cache it, make sure the captured state is still valid.

Tool methods that expect dependency-injected services should resolve them inside the method, not in the closure. The middleware can be reused across requests; a captured scoped service from the wrong scope will surface as a stale `DbContext` or a disposed `HttpClient`. The `IChatClient` you build in DI is `ITransient` or `IScoped` depending on how you register it; the underlying `FunctionInvokingChatClient` is thread-safe but does not own your tool dependencies.

If a tool returns `null` or throws, the model sees a structured tool result with the error message, not an exception. That is what you want, but make sure your tool returns useful error text. "Order not found" beats `NullReferenceException`.

For provider-specific behaviour, mind the rate limits. The `FunctionInvokingChatClient` makes one provider call per tool round trip, so a 5-iteration limit is up to 5 inbound requests for one user message. The Anthropic and OpenAI rate limiters count those individually.

## Related reading

- [How to Call the Claude API from a .NET 11 Minimal API with Streaming](/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/) - the lower-level streaming pattern, useful when you want to drive the loop yourself.
- [Microsoft Agent Framework 1.0: Building AI Agents in Pure C#](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) - the agent SDK that sits on top of `IChatClient` and adds memory, planners, and multi-agent orchestration.
- [How to Build a Custom MCP Server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) - exposes the same kind of tool over MCP so non-.NET clients can call it.
- [Generative AI for Beginners .NET v2: Rebuilt for .NET 10 with Microsoft.Extensions.AI](/2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai/) - end-to-end tutorials that exercise the full pipeline.
- [How to Migrate a Semantic Kernel Plugin to an MCP Server](/2026/05/migrate-a-semantic-kernel-plugin-to-an-mcp-server/) - the migration path when your existing tools live in `[KernelFunction]` classes.

## Sources

- [Microsoft.Extensions.AI libraries overview, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/ai/microsoft-extensions-ai)
- [Quickstart: Extend OpenAI using functions and execute a local function with .NET](https://learn.microsoft.com/en-us/dotnet/ai/quickstarts/use-function-calling)
- [`FunctionInvokingChatClient` API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.ai.functioninvokingchatclient)
- [`AIFunctionFactory` API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.ai.aifunctionfactory)
- [Microsoft.Extensions.AI 10.5.1 on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.AI/)
