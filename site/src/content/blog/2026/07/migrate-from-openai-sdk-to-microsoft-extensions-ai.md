---
title: "Migrate From the OpenAI SDK to Microsoft.Extensions.AI in a .NET App"
description: "A step-by-step checklist for moving a .NET app off the raw OpenAI 2.12 SDK onto the provider-neutral Microsoft.Extensions.AI 10.7 IChatClient. Covers the AsIChatClient bridge, the CompleteChatAsync-to-GetResponseAsync rewrite, streaming, tool calling, DI registration, and the gotchas that bite mid-cutover."
pubDate: 2026-07-09
updatedDate: 2026-07-09
template: migration
tags:
  - "migration"
  - "llm"
  - "ai-agents"
  - "microsoft-extensions-ai"
  - "openai-sdk"
  - "dotnet-11"
---

If you called an LLM from .NET in 2025, you almost certainly did it through the official `OpenAI` NuGet package, wiring `ChatClient.CompleteChatAsync` and reading `completion.Content[0].Text`. That works, but it welds your code to one provider's type system. `Microsoft.Extensions.AI` (currently **10.7.0**, on `IChatClient`) is the provider-neutral abstraction the rest of the modern .NET AI stack standardized on, and the migration off the raw SDK is smaller than it looks: the same OpenAI client you already construct gets a single `.AsIChatClient()` call, and everything above it swaps `CompleteChatAsync` for `GetResponseAsync`. This post is the checklist for a real app running the **OpenAI .NET SDK 2.12.0** on **.NET 11 / C# 14**, moving to `Microsoft.Extensions.AI 10.7.0`: what breaks, the exact API mapping, streaming and tool-calling rewrites, and how to verify each step.

If you are still deciding *whether* an abstraction layer earns its keep, read the [Anthropic SDK vs Microsoft.Extensions.AI comparison first](/2026/06/anthropic-sdk-vs-microsoft-extensions-ai-for-calling-claude-from-dotnet/); this post assumes you have already decided to move.

## Why bother when the OpenAI SDK already works

The migration is not about the OpenAI SDK being bad. It is about what the abstraction buys you once you are on it:

- **Swap providers without touching call sites.** `IChatClient` is implemented by the OpenAI SDK, Azure OpenAI, the Anthropic SDK, Ollama, and Foundry Local. Moving from `gpt-5.1` to Claude or a local model becomes a one-line factory change instead of a rewrite of every `CompleteChatAsync` call.
- **Middleware you do not have to write.** `ChatClientBuilder` layers automatic function invocation, distributed caching, and OpenTelemetry as pipeline stages. With the raw SDK you hand-roll the tool-call loop and the caching yourself.
- **One type system end to end.** `ChatMessage`, `ChatRole`, and `AIContent` are the same types the [Microsoft Agent Framework](/2026/07/migrate-a-semantic-kernel-app-to-microsoft-agent-framework-1-0/) and the rest of the stack speak. Your chat layer stops being an island.
- **Testability.** `IChatClient` is an interface, so a unit test injects a fake without a network mock or a captured HTTP handler.

The cost is one indirection layer and learning a second set of type names. For a throwaway script it is not worth it. For a service you will maintain, it is.

## What breaks

Nothing about the transport or your API key changes. What changes is every type name in the request/response path. The severity is mostly "mechanical rename", with two real behavioral traps.

| Area | OpenAI SDK 2.12 | Microsoft.Extensions.AI 10.7 | Severity |
| --- | --- | --- | --- |
| Client type | `OpenAI.Chat.ChatClient` | `IChatClient` (via `.AsIChatClient()`) | low |
| Call method | `CompleteChatAsync(messages)` | `GetResponseAsync(messages)` | low |
| Result type | `ChatCompletion` | `ChatResponse` | low |
| Reading text | `completion.Content[0].Text` | `response.Text` | medium |
| Messages | `SystemChatMessage` / `UserChatMessage` | `ChatMessage(ChatRole.System, ...)` | low |
| Options | `ChatCompletionOptions` | `ChatOptions` | medium |
| Streaming update | `StreamingChatCompletionUpdate` | `ChatResponseUpdate` | low |
| Tool definition | `ChatTool.CreateFunctionTool` + manual loop | `AIFunctionFactory.Create` + `UseFunctionInvocation` | high |
| Tool result message | `ToolChatMessage(id, result)` | handled by the pipeline | high |

The two high-severity rows are the tool-calling ones, because the whole hand-written call/result loop disappears. That is a win, but it means you delete code rather than translate it line for line.

## Pre-flight checklist

Before you touch a call site:

1. **SDK is on .NET 8 or later.** `Microsoft.Extensions.AI` targets `net8.0` and up. On .NET 11 / C# 14 you are fine. Confirm with `dotnet --version` and your `<TargetFramework>`.
2. **Pin the OpenAI SDK you already have.** You keep the `OpenAI` package; the bridge wraps it. Note your current version (`dotnet list package | grep OpenAI`) so a rollback is a known-good pin.
3. **Inventory your call sites.** `grep -rn "CompleteChat" src/` and `grep -rn "ChatCompletionOptions" src/`. That list is your migration surface.
4. **Have a green test.** At least one end-to-end test that sends a prompt and asserts on the reply, so each step below has a checkpoint.

## Step 1: Add the bridge package

Add `Microsoft.Extensions.AI.OpenAI`, which carries `Microsoft.Extensions.AI` transitively and provides the `.AsIChatClient()` extension for OpenAI client types.

```bash
# .NET 11, from the project directory
dotnet add package Microsoft.Extensions.AI.OpenAI --version 10.7.0
```

`Microsoft.Extensions.AI` (the abstractions plus the middleware) comes along for the ride; you do not need to add it separately unless a class library only references abstractions.

**Verify:** `dotnet build` succeeds with the new package restored. No code has changed yet.

## Step 2: Wrap the client you already build

This is the only line that touches the provider. The `OpenAI.Chat.ChatClient` you construct today gets `.AsIChatClient()` appended.

```csharp
// OpenAI SDK 2.12.0 -- before
using OpenAI.Chat;

ChatClient client = new(
    model: "gpt-5.1",
    apiKey: Environment.GetEnvironmentVariable("OPENAI_API_KEY"));
```

```csharp
// Microsoft.Extensions.AI 10.7.0 -- after
using Microsoft.Extensions.AI;
using OpenAI.Chat;

IChatClient client = new ChatClient(
    model: "gpt-5.1",
    apiKey: Environment.GetEnvironmentVariable("OPENAI_API_KEY"))
    .AsIChatClient();
```

The `AsIChatClient()` extension lives in the `Microsoft.Extensions.AI` namespace and is defined for `OpenAI.Chat.ChatClient`, `OpenAI.Responses.ResponsesClient`, and `OpenAI.Assistants.AssistantClient`, so the same move works whether you are on Chat Completions, the Responses API, or Assistants.

**Verify:** it still compiles. The variable type changed from `ChatClient` to `IChatClient`, so the next step is the call sites that used to bind to the concrete type.

## Step 3: Rewrite the call and read the reply

The single-turn call is a rename plus a simpler property read. The OpenAI SDK buries the text one level down in `Content[0].Text`; `IChatClient` flattens it to `response.Text`.

```csharp
// OpenAI SDK 2.12.0 -- before
List<ChatMessage> messages =
[
    new SystemChatMessage("You are a terse assistant."),
    new UserChatMessage("Summarize the CAP theorem in one sentence."),
];

ChatCompletion completion = await client.CompleteChatAsync(messages);
string reply = completion.Content[0].Text;
```

```csharp
// Microsoft.Extensions.AI 10.7.0 -- after
using Microsoft.Extensions.AI;

List<ChatMessage> messages =
[
    new ChatMessage(ChatRole.System, "You are a terse assistant."),
    new ChatMessage(ChatRole.User, "Summarize the CAP theorem in one sentence."),
];

ChatResponse response = await client.GetResponseAsync(messages);
string reply = response.Text;
```

Watch the name collision: both libraries define a `ChatMessage` type, and they are not the same type. After you add `using Microsoft.Extensions.AI;`, an un-migrated `new ChatMessage("...")` that expected the OpenAI shape will fail to compile or bind to the wrong constructor. This is a feature, not a bug: the compiler is handing you the exact list of call sites still to convert. Work through them until the build is green.

**Verify:** run your end-to-end test. Same prompt, same model, same reply. If the text comes back empty, you are reading `response.Text` on a response whose content is a tool call, not text (covered in Step 5).

## Step 4: Move options to ChatOptions

Per-request knobs move from `ChatCompletionOptions` to the provider-neutral `ChatOptions`. The common ones map directly.

```csharp
// OpenAI SDK 2.12.0 -- before
var options = new ChatCompletionOptions
{
    Temperature = 0.2f,
    MaxOutputTokenCount = 500,
};
ChatCompletion completion = await client.CompleteChatAsync(messages, options);
```

```csharp
// Microsoft.Extensions.AI 10.7.0 -- after
var options = new ChatOptions
{
    Temperature = 0.2f,
    MaxOutputTokens = 500,
};
ChatResponse response = await client.GetResponseAsync(messages, options);
```

Note `MaxOutputTokenCount` became `MaxOutputTokens`. For a provider-specific setting that `ChatOptions` does not surface, use `RawRepresentationFactory` to reach the underlying `ChatCompletionOptions`, so you keep the abstraction without losing access to the raw knob:

```csharp
// Microsoft.Extensions.AI 10.7.0 -- provider passthrough
var options = new ChatOptions
{
    Temperature = 0.2f,
    RawRepresentationFactory = _ => new OpenAI.Chat.ChatCompletionOptions
    {
        // OpenAI-only settings the neutral surface does not expose
        FrequencyPenalty = 0.5f,
    },
};
```

**Verify:** assert on a behavior the option controls (for example a low `MaxOutputTokens` truncating the reply). If your passthrough setting had no effect, confirm you are on a provider that honors it.

## Step 5: Delete the tool-call loop

This is where the migration pays for itself. With the raw SDK you defined a `ChatTool`, sent it, inspected `completion.ToolCalls`, dispatched each one yourself, appended a `ToolChatMessage`, and called the API again in a loop. All of that disappears.

```csharp
// OpenAI SDK 2.12.0 -- before (abbreviated: the manual loop)
ChatTool weatherTool = ChatTool.CreateFunctionTool(
    functionName: "GetWeather",
    functionDescription: "Get the weather for a city",
    functionParameters: BinaryData.FromString("""
        { "type": "object", "properties": { "city": { "type": "string" } } }
        """));

var options = new ChatCompletionOptions { Tools = { weatherTool } };
ChatCompletion completion = await client.CompleteChatAsync(messages, options);

while (completion.FinishReason == ChatFinishReason.ToolCalls)
{
    messages.Add(new AssistantChatMessage(completion));
    foreach (ChatToolCall call in completion.ToolCalls)
    {
        string result = Dispatch(call.FunctionName, call.FunctionArguments);
        messages.Add(new ToolChatMessage(call.Id, result));
    }
    completion = await client.CompleteChatAsync(messages, options);
}
```

With `Microsoft.Extensions.AI`, you describe the .NET method with `AIFunctionFactory.Create`, register `UseFunctionInvocation` once on the pipeline, and the middleware runs the loop for you.

```csharp
// Microsoft.Extensions.AI 10.7.0 -- after
using Microsoft.Extensions.AI;

[Description("Get the weather for a city")]
static string GetWeather(string city) => $"20C and sunny in {city}";

IChatClient client = new ChatClient("gpt-5.1", apiKey)
    .AsIChatClient();

IChatClient pipeline = new ChatClientBuilder(client)
    .UseFunctionInvocation()
    .Build();

var options = new ChatOptions
{
    Tools = [AIFunctionFactory.Create(GetWeather)],
};

ChatResponse response = await pipeline.GetResponseAsync(messages, options);
// GetWeather was already invoked and its result fed back for you.
```

`AIFunctionFactory.Create` reads the method signature and the `[Description]` attributes to build the JSON schema, so you no longer hand-write the `BinaryData` schema blob. The full mechanics of the tool loop, iteration limits, and approval gates are in [adding tool calling to a Microsoft.Extensions.AI chat client](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/).

**Verify:** log inside `GetWeather`. On a prompt that needs it, the method runs exactly once per requested call and the final `response.Text` reflects the tool output, with no manual loop in your code.

## Step 6: Convert streaming

Streaming renames the call and the update type. The per-chunk text lives on `.Text` in both, but the update type is `ChatResponseUpdate` instead of `StreamingChatCompletionUpdate`.

```csharp
// OpenAI SDK 2.12.0 -- before
await foreach (StreamingChatCompletionUpdate update
    in client.CompleteChatStreamingAsync(messages))
{
    foreach (var part in update.ContentUpdate)
        Console.Write(part.Text);
}
```

```csharp
// Microsoft.Extensions.AI 10.7.0 -- after
await foreach (ChatResponseUpdate update
    in client.GetStreamingResponseAsync(messages))
{
    Console.Write(update.Text);
}
```

If you were streaming out of an ASP.NET Core endpoint, the `IAsyncEnumerable` shape is unchanged, so your [minimal-API server-sent-events plumbing](/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/) keeps working; only the element type in the loop changes.

**Verify:** confirm tokens still arrive incrementally rather than buffering. If the whole reply lands at once, something downstream is awaiting the full enumerable before flushing.

## Step 7: Register it in DI

For an ASP.NET Core app, register the pipeline once with `AddChatClient` and inject `IChatClient` everywhere. This replaces newing up a `ChatClient` per call site.

```csharp
// Program.cs -- .NET 11, Microsoft.Extensions.AI 10.7.0
using Microsoft.Extensions.AI;
using OpenAI.Chat;

builder.Services.AddChatClient(_ =>
    new ChatClient("gpt-5.1", builder.Configuration["OpenAI:ApiKey"])
        .AsIChatClient())
    .UseFunctionInvocation()
    .UseDistributedCache()
    .UseOpenTelemetry();
```

Consumers take a dependency on the interface, never the OpenAI type:

```csharp
public class SummaryService(IChatClient chat)
{
    public async Task<string> SummarizeAsync(string text) =>
        (await chat.GetResponseAsync($"Summarize: {text}")).Text;
}
```

That constructor is the whole point of the migration. When you later move to Azure OpenAI or Claude, you edit the one factory in `Program.cs`; `SummaryService` never learns the provider changed. Keyed registrations let you run more than one model side by side under distinct service keys.

**Verify:** resolve `IChatClient` from the container in an integration test and run a prompt. Confirm the caching and telemetry stages fire (a cache hit on the second identical prompt is the easy tell).

## Verification checklist

Run this after the cutover, not one step at a time:

- `dotnet build` is clean with zero references to `CompleteChat` or `ChatCompletionOptions` in your own code (`grep` confirms).
- The end-to-end prompt test passes with the same model and comparable output.
- Tool-calling paths invoke each .NET method once per requested call, no manual loop remaining.
- Streaming still flushes incrementally.
- DI resolves `IChatClient`; caching and telemetry middleware are observable.

## Rollback plan

This migration is reversible per file. Because you keep the `OpenAI` package installed the whole time (the bridge wraps it, it does not replace it), a rollback is `git revert` on the call-site commit; nothing is uninstalled. The safe sequence is to land Steps 1 and 2 (add package, wrap client) in one commit, then convert call sites in small commits per feature area. Each is independently shippable and independently revertible. Do not do the whole app in one commit: the `ChatMessage` name collision means a half-finished conversion will not build, and you want a green checkpoint between each batch.

## Gotchas we hit

**The `ChatMessage` name collision is the whole difficulty.** `OpenAI.Chat.ChatMessage` and `Microsoft.Extensions.AI.ChatMessage` are different types with different constructors. Once both `using` directives are in scope, an un-migrated line binds to the wrong one. Convert files fully rather than half; if you must straddle, alias one with `using OAIChat = OpenAI.Chat;`.

**`response.Text` is empty when the turn is a tool call.** If you skipped `UseFunctionInvocation` but still passed `Tools`, the model returns a tool-call content part, not text, so `response.Text` is empty and `response.Messages` holds a `FunctionCallContent`. Add the middleware, or the loop never closes.

**`AIFunctionFactory.Create` needs real parameter names.** It builds the JSON schema from your method signature, so trimming or obfuscation that renames parameters produces a schema the model cannot fill correctly. Keep `[Description]` on parameters that need disambiguation.

**Azure OpenAI uses a different entry type.** From `Azure.AI.OpenAI`, construct `AzureOpenAIClient`, call `.GetChatClient(deployment)`, then `.AsIChatClient()`. The deployment name, not the model ID, is the string that matters, and that mismatch is the most common first-run 404.

**The bridge does not change your token bill.** `AsIChatClient()` is a thin adapter over the same HTTP calls; it neither adds nor removes tokens. If you want to actually cut cost, that comes from the middleware you can now add, chiefly [prompt caching](/2026/06/anthropic-sdk-vs-microsoft-extensions-ai-for-calling-claude-from-dotnet/) and `UseDistributedCache`, not from the abstraction itself.

## Related

- [Anthropic SDK vs Microsoft.Extensions.AI for calling Claude from .NET](/2026/06/anthropic-sdk-vs-microsoft-extensions-ai-for-calling-claude-from-dotnet/) - the decision behind adopting the neutral interface, and what you give up at the boundary.
- [How to add tool calling to a Microsoft.Extensions.AI chat client](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/) - the full `UseFunctionInvocation` mechanics you inherit in Step 5.
- [How to call the Claude API from a .NET 11 minimal API with streaming](/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/) - the SSE plumbing that survives the streaming rewrite in Step 6.
- [Migrate a Semantic Kernel app to Microsoft Agent Framework 1.0](/2026/07/migrate-a-semantic-kernel-app-to-microsoft-agent-framework-1-0/) - the next layer up, once your chat calls speak `IChatClient`.
- [Generative AI for Beginners .NET v2: rebuilt on Microsoft.Extensions.AI](/2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai/) - a full course on the same `IChatClient` pattern you just migrated to.

## Sources

- [Microsoft.Extensions.AI libraries overview](https://learn.microsoft.com/en-us/dotnet/ai/microsoft-extensions-ai) - the abstractions, middleware, and DI story.
- [Use the IChatClient interface](https://learn.microsoft.com/en-us/dotnet/ai/ichatclient) - `GetResponseAsync`, `GetStreamingResponseAsync`, and `ChatOptions`.
- [Microsoft.Extensions.AI.OpenAI README (dotnet/extensions)](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.AI.OpenAI/README.md) - the `AsIChatClient()` bridge and `ChatClientBuilder` composition.
- [OpenAIClientExtensions.AsIChatClient method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.ai.openaiclientextensions.asichatclient) - the supported OpenAI client types.
- [OpenAI official .NET library](https://github.com/openai/openai-dotnet) - the 2.x `ChatClient`, `CompleteChatAsync`, and tool-calling surface you are migrating from.
- [Microsoft.Extensions.AI 10.7.0 on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.AI/) - the package version pinned in this guide.
