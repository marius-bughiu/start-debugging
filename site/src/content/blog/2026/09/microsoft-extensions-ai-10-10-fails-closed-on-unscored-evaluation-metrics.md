---
title: "Microsoft.Extensions.AI 10.10 Fails Evaluation Metrics the Judge Never Scored"
description: "Microsoft.Extensions.AI.Evaluation.Quality 10.10.0 now marks unparseable and out-of-range quality scores as failed, and Microsoft.Extensions.AI.OpenAI 10.10.0 drops the Assistants adapter. Measured before and after on 10.9.0."
pubDate: 2026-09-15
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "testing"
  - "csharp"
---

The `dotnet/extensions` [v10.10.0 release notes](https://github.com/dotnet/extensions/releases/tag/v10.10.0) landed on September 14, 2026 (the packages hit NuGet on September 9). Most of it is plumbing, but two changes can alter what your build does: the quality evaluators now fail closed, and the OpenAI Assistants adapter is gone. If you gate CI on AI evaluation results, the first one can turn a green pipeline red, and that is the correct outcome.

## A judge that says nothing no longer counts as a pass

`CoherenceEvaluator`, `FluencyEvaluator`, `RelevanceEvaluator` and the rest of `Microsoft.Extensions.AI.Evaluation.Quality` ask an LLM judge for a 1 to 5 score and interpret it themselves. Up to 10.9.0 the interpretation only failed a metric when the value parsed to a number below 4.0. When the judge returned text with no score, `metric.Value` was `null`, the rating became `Inconclusive`, and `Failed` stayed `false`. A score of 6 took the same path. Any pipeline that checks "did anything fail?" read a metric that was never scored as green.

[PR #7735](https://github.com/dotnet/extensions/pull/7735) (fixing [issue #7665](https://github.com/dotnet/extensions/issues/7665)) closes that hole. I ran the same probe against both versions, with a canned `IChatClient` as the judge:

```csharp
var result = await new CoherenceEvaluator().EvaluateAsync(
    new ChatMessage(ChatRole.User, "What is 2+2?"),
    new ChatResponse(new ChatMessage(ChatRole.Assistant, "4")),
    new ChatConfiguration(new CannedJudge(reply)));

var m = result.Get<NumericMetric>(CoherenceEvaluator.CoherenceMetricName);
Console.WriteLine($"value={m.Value} rating={m.Interpretation?.Rating} failed={m.Interpretation?.Failed}");
```

| Judge reply | 10.9.0 | 10.10.0 |
| --- | --- | --- |
| `<S2>5</S2>` | Exceptional, not failed | Exceptional, not failed |
| `<S2>3</S2>` | Average, failed | Average, failed |
| `<S2>6</S2>` | Inconclusive, **not failed** | Inconclusive, failed: "Coherence is outside the valid range." |
| "I am unable to evaluate this response." | Inconclusive, **not failed** | Inconclusive, failed: "Coherence has no score." |

Scores inside the scale behave exactly as before, including the 4.0 boundary. What changes is that a flaky, rate-limited or misconfigured judge now shows up as a failure instead of hiding behind a pass. If your nightly run suddenly reports failures after the upgrade, look at the `Reason` text first: "has no score" points at the judge model, not at your app.

The fix is scoped to the Quality package. The PR notes that the Safety package's `InterpretContentSafetyScore` and `InterpretContentHarmScore` and the NLP package's score interpretation have the same shape and were left alone, so do not assume those fail closed yet.

## The Assistants adapter is removed, not deprecated

OpenAI shut down the Assistants API on August 26, 2026, and [PR #7724](https://github.com/dotnet/extensions/pull/7724) removed the matching experimental surface from `Microsoft.Extensions.AI.OpenAI`: both `AssistantClient.AsIChatClient(...)` overloads, `OpenAIAssistantsChatClient`, and `AsOpenAIAssistantsFunctionToolDefinition`. The `OpenAI` 2.13.0 package still ships `AssistantClient`, so the upgrade fails at compile time rather than at restore:

```text
error CS1929: 'AssistantClient' does not contain a definition for 'AsIChatClient' and the best extension method overload 'OpenAIClientExtensions.AsIChatClient(ResponsesClient, string?)' requires a receiver of type 'OpenAI.Responses.ResponsesClient'
```

The replacement is the Responses client, with instructions moving onto `ChatOptions` and the conversation id taking over from the thread id. This compiles against 10.10.0:

```csharp
IChatClient chat = new OpenAIClient(apiKey)
    .GetResponsesClient()
    .AsIChatClient("gpt-5-mini");

var options = new ChatOptions
{
    Instructions = "You are the support assistant for Contoso.",
    ConversationId = conversationId, // previous response id, replaces the thread id
};

ChatResponse response = await chat.GetResponseAsync("Where is my order?", options);
```

Since the endpoints already return errors, any code still on that path was broken in production two weeks ago. The compile error just makes it visible.

The rest of 10.10.0 is smaller: `OpenAI` moves to 2.13.0, unsupported image `detail` values no longer throw `ArgumentNullException`, and the Azure storage result store validates path segments. If you picked up the routing clients from [Microsoft.Extensions.AI 10.9](/2026/08/microsoft-extensions-ai-10-9-routing-and-failover-chat-clients/), this is a safe bump, as long as you are ready for the evaluation gate to start telling the truth.
