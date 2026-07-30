---
title: "Visual Studio 18.9 Lets You Set Thinking Effort Per Model"
description: "Visual Studio 18.9 Insiders 2 adds a per-model thinking effort control with Low through Max levels, exposing the same reasoning-effort dial the underlying model APIs take."
pubDate: 2026-07-30
tags:
  - "visual-studio"
  - "ai-agents"
  - "dotnet"
  - "copilot"
---

On 2026-07-29 Rachel Kang published [Tell your model when to think harder](https://devblogs.microsoft.com/visualstudio/tell-your-model-when-to-think-harder/), and the feature it describes is more interesting than the title suggests. Starting in **Visual Studio 18.9 Insiders 2**, supported models come with a thinking effort control, and it is set per model rather than per request.

## Model choice and reasoning depth stopped being the same decision

Until now, picking a model in Visual Studio picked two things at once: which weights answer your question, and how much reasoning you get before the answer arrives. If a model reasoned deeply, every "rename this variable" prompt paid for it.

Splitting the two means you can keep the same model for a whole session and move the dial instead. The levels are:

- **Low** - "Quick responses with minimal reasoning", and it consumes fewer AI credits.
- **Medium** - "Balanced reasoning and speed, and usually the default."
- **High** - deeper reasoning, for a tricky algorithm, an architecture decision, or a bug you cannot pin down.
- **Extra High** and **Max** - "The most reasoning some models offer, for the gnarliest problems."

Models that do not expose a thinking control show a dash and keep working exactly as before, so the control is additive rather than a behavior change across the board.

## Where it lives

Open the model picker, click **Manage models** to bring up the expanded model management window, and set the thinking level per model from there. It is not buried in Tools > Options, and it is not a per-prompt toggle.

## The ladder is the provider's, not Visual Studio's

Low, Medium, High, Extra High, Max is not five names Microsoft invented for a slider. It is the reasoning-effort parameter the model APIs already take, surfaced in the IDE. On the Anthropic API, effort lives inside `output_config` and accepts exactly `low`, `medium`, `high`, `xhigh`, and `max`:

```csharp
using Anthropic;
using Anthropic.Models.Messages;

AnthropicClient client = new();

var response = await client.Messages.Create(new MessageCreateParams
{
    Model = "claude-opus-5",
    MaxTokens = 16000,
    Thinking = new ThinkingConfigAdaptive(),
    OutputConfig = new OutputConfig { Effort = Effort.High },
    Messages = [new() { Role = Role.User, Content = "Why does this query deadlock?" }],
});
```

On the wire that is `"output_config": { "effort": "high" }`, with `xhigh` sitting between `high` and `max`. Note that `Effort` is nested under `OutputConfig` and is not a top-level property, which is the mistake worth avoiding if you go build the same control into your own tooling.

Two details matter when you reason about what the IDE setting actually does. Effort is a ceiling on reasoning depth and overall token spend, not a fixed budget: on current Claude models, adaptive thinking still decides per request how much to reason, and effort bounds it. And the older approach of naming a hard thinking-token budget is gone on those models, which is exactly why a five-rung named ladder is the thing an IDE can put in front of you.

## The part that shows up on your bill

"Higher thinking levels do more reasoning, which consumes more credits. Lower levels use fewer." That makes the control a cost lever as much as a quality lever, which pairs with the [AI credit session limits in the Copilot CLI and SDK](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/): one caps the ceiling, the other sets the per-request rate.

If you are on 18.9 Insiders, the fastest calibration is to leave your usual model selected, drop it to Low for a day of routine edits, and see how little you miss.
