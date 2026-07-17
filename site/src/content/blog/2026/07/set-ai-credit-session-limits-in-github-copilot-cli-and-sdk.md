---
title: "How to Set Per-Session AI Credit Spend Limits in the Copilot CLI and SDK"
description: "Copilot CLI 1.0.66 and SDK 1.0.5 (public preview, July 1 2026) add per-session AI credit limits. Cap what a single agent run can spend with --max-ai-credits, /limits set, or SessionLimitsConfig, and understand why it is a soft cap that can overshoot."
pubDate: 2026-07-17
tags:
  - "github-copilot"
  - "ai-agents"
  - "llm"
  - "cost-control"
  - "copilot-sdk"
---

Since June 1, 2026, every GitHub Copilot plan bills on usage-based AI credits, where 1 credit equals $0.01 USD once you exhaust your plan's included pool. That change made a long-standing worry concrete: an autonomous agent that loops longer than you expected, spawns subagents, and compacts its own context can quietly burn real money before it finishes. On July 1, 2026, GitHub shipped the fix as a public preview: per-session AI credit limits in Copilot CLI 1.0.66 and later, and the Copilot SDK 1.0.5 and later. You set a ceiling for a single agent run, and Copilot stops when it gets there instead of running until the task is done or you kill it by hand.

If you only remember one thing: in the CLI, pass `--max-ai-credits=NUMBER` for scripted runs or type `/limits set max-ai-credits NUMBER` inside an interactive session; in the SDK, set `sessionLimits: { maxAiCredits: 30 }` on `createSession`. It is a soft cap, not a hard kill switch, and the difference matters, so the rest of this post is about the edges.

## Why a session limit is not the same as your monthly budget

GitHub already had budget controls before this feature. User-level budgets (ULBs) cap how many AI credits a single user can consume in an entire billing cycle, and they always enforce a hard stop with no option to continue past the limit. A $0 budget blocks the user immediately. Those are the right tool for "this contractor cannot spend more than $50 this month," and you configure them in billing settings, as described in GitHub's [budgets for usage-based billing docs](https://docs.github.com/en/copilot/concepts/billing/budgets-for-usage-based-billing).

A session limit answers a different question: "this one agent run should not spend more than X, regardless of how much monthly budget is left." A ULB will not save you from a single runaway `copilot -p "refactor the whole repo"` invocation that eats your entire month's allowance in one afternoon. The session limit scopes the ceiling to the run, so a bad prompt costs you a bounded amount instead of the whole envelope. The two controls compose: the ULB is the outer wall for the billing cycle, the session limit is the fuse on each individual run.

This is the same shape of problem that made the June 2026 token-billing shift the deciding factor in [where Claude Code, Cursor, and Copilot each win on cost](/2026/06/claude-code-vs-cursor-vs-copilot-agent-mode-where-each-wins/). Once you pay per unit of work, per-run guardrails stop being a nice-to-have.

## Setting a limit in the Copilot CLI

The CLI covers two modes, and they behave differently when the limit is reached.

For a non-interactive, scripted run, pass the flag:

```bash
# Copilot CLI 1.0.66+, public preview July 1 2026
# Cap this run at 50 AI credits (~$0.50 of metered usage)
copilot -p "Migrate the auth module to the new token handler and run the tests" \
  --max-ai-credits=50
```

When a scripted run hits the ceiling, the run ends. That is the behavior you want in CI or a cron job: the process should exit rather than block waiting for a human who is not there. Combine it with your automation's own timeout and you have two independent stops, one on money and one on wall-clock time.

Inside an interactive session, you manage the limit with the `/limits` command family:

```text
# View, set, or remove the current session limit
/limits

# Set a ceiling of 40 AI credits for this session
/limits set max-ai-credits 40

# Remove the limit entirely
/limits unset
```

The interactive case is more forgiving by design. When you reach the limit in a live session, Copilot does not silently die. It pauses, tells you the limit was hit, and prompts you to raise or adjust it. Bump it with `/limits set max-ai-credits 80` and the agent continues from where it stopped, with no need to restart the task or re-establish context. That makes the limit usable as a checkpoint, not just a kill switch: set it low, let the agent make progress, and re-authorize spend in deliberate increments when you can see what it has done so far.

One number to internalize before you pick a value: GitHub's own guidance is that session limits work best above 30 AI credits, because most individual model calls cost more than 20. Set it to 10 and the very first model turn can trip the limit before the agent does anything useful. Treat 30 as the practical floor and scale up from the complexity of the task.

## Setting a limit in the Copilot SDK

The SDK is where this gets interesting, because you are usually embedding Copilot's agent runtime inside your own app rather than driving it by hand. If you have already [embedded the Copilot agent runtime in a C# service](/2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp/), the session limit is one more field on the config object you already build.

In TypeScript, set `sessionLimits` when you create the session:

```typescript
// @github/copilot SDK 1.0.5+, public preview July 1 2026
import { CopilotClient } from "@github/copilot";

const client = new CopilotClient();

const session = await client.createSession({
  sessionLimits: { maxAiCredits: 30 },
});
```

The C# surface mirrors it with a strongly typed config object:

```csharp
// GitHub.Copilot SDK 1.0.5+, public preview July 1 2026
var session = await client.CreateSessionAsync(new SessionConfig
{
    SessionLimits = new SessionLimitsConfig { MaxAiCredits = 30 }
});
```

The limit is scoped to the session's current accounting window, so it survives across the multi-turn back-and-forth of a single run rather than resetting per model call. When you resume a session, the limit does not carry over automatically. Set it again on resume if you want the ceiling to keep applying to the continued work:

```typescript
// Resuming keeps you in the same session but you re-state the ceiling
const resumed = await client.resumeSession(session.sessionId, {
  sessionLimits: { maxAiCredits: 30 },
});
```

```csharp
var resumed = await client.ResumeSessionAsync(session.SessionId,
    new ResumeSessionConfig
    {
        SessionLimits = new SessionLimitsConfig { MaxAiCredits = 30 }
    });
```

Setting it on resume matters because a resumed session is exactly where an agent tends to blow past a budget: it already has a plan, it is confident, and it will keep calling models. Re-stating the limit on each resume keeps the fuse in place.

## Watch the events, do not poll for a balance

The SDK deliberately does not hand you a `getRemainingCredits()` method. Usage is reported through events, which is the right model for an async agent runtime because credit consumption happens across model calls, subagents, and background work you did not directly trigger. Two events carry the signal you care about.

`session.usage_checkpoint` records durable usage as the session runs. It carries `totalNanoAiu` (cumulative usage in a fine-grained unit) and `totalPremiumRequests`. Subscribe to it if you want a live gauge in your own UI or a log line per checkpoint:

```typescript
// Track cumulative spend as the agent works
session.on("session.usage_checkpoint", (event) => {
  console.log(
    `usage checkpoint: ${event.totalPremiumRequests} premium requests so far`
  );
});
```

`session_limits_exhausted.requested` fires when the session hits its ceiling. It includes `usedAiCredits` and `maxAiCredits`, so you can decide programmatically whether to raise the limit and continue, or let the run stop:

```typescript
session.on("session_limits_exhausted.requested", (event) => {
  console.warn(
    `limit hit: used ${event.usedAiCredits} of ${event.maxAiCredits} credits`
  );
  // Optionally raise the ceiling for a supervised continuation,
  // or record the stop and surface it to a human.
});
```

Building your cost dashboard on these events instead of on a polled balance means you see the same numbers the runtime uses to enforce the cap, and you catch the exhaustion the instant it happens rather than on your next poll.

## The soft-cap gotcha that trips everyone

The single most important thing to understand: this is a soft cap, and it can overshoot. Copilot only knows what a model call cost after that call returns. So if you are sitting at 48 credits with a 50-credit limit and the next turn is a big one, that turn runs to completion, and you can land at 55 or 60 before the runtime blocks the next call. The docs state it plainly: a response already underway finishes before Copilot stops, so actual usage may slightly exceed the number you set.

Two consequences follow. First, do not set a session limit at the exact value where a single dollar of overshoot would hurt. If your true hard ceiling is 50 credits, set the session limit around 40 and leave headroom for one in-flight response. Second, the session limit is not a substitute for the hard-stop ULB when you need a guaranteed cap. Use both: the ULB is the enforced wall for the billing cycle, and the session limit is the early, per-run warning that stops most overruns before they get near that wall.

The overshoot also explains the "> 30 credits" guidance from a different angle. If a single model call can cost more than 20 credits and the cap is checked only after the call returns, a limit of 10 or 15 is meaningless: the first real turn blows through it and overshoots by design. The limit only does useful work when it sits comfortably above the cost of one turn.

## Where this fits in an autonomous setup

The most valuable place for a session limit is not the interactive CLI, where you are watching anyway. It is the unattended run: a [scheduled Copilot CLI plugin task](/2026/07/modernize-dotnet-anywhere-github-copilot-cli-plugin/), a cloud agent kicked off from the [Agent Tasks REST API](/2026/06/trigger-github-copilot-coding-agent-task-from-rest-api/), or an SDK-embedded agent handling a queue of jobs. In all three, no human is there to notice a loop, and each of these paths consumes credits through its own SKU. A session limit turns "I hope this migration script does not spend $40 per repo across 200 repos" into a bounded, per-run number you can multiply and budget for.

A reasonable default for unattended work: set `maxAiCredits` on every session you create, size it from the task (30 to 50 for a focused change, higher for a genuine multi-file refactor), subscribe to `session_limits_exhausted.requested`, and log the stop rather than auto-raising the ceiling. Auto-raising defeats the purpose. If a job needs more, that is a signal for a human to look, not for the code to quietly hand it more money.

The feature is in public preview as of July 1, 2026, across Copilot for Individuals, Business, and Enterprise. If your `--max-ai-credits` flag or `sessionLimits` config is silently ignored, check your versions first: the floor is Copilot CLI 1.0.66 and Copilot SDK 1.0.5. This landed the same month GitHub moved Copilot fully onto [usage-based AI credit billing](/2026/05/copilot-business-gpt-5-3-codex-base-model/), and the two are meant to be used together: usage-based billing makes every run cost money, and session limits make every run's cost bounded.

## Related

- [GitHub Copilot SDK Hits GA: Embed Copilot's Agent Runtime in Your Own C# Apps](/2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp/)
- [The .NET Modernization Agent Now Runs in the Copilot CLI, Not Just Visual Studio](/2026/07/modernize-dotnet-anywhere-github-copilot-cli-plugin/)
- [How to Trigger a GitHub Copilot Coding Agent Task from the Agent Tasks REST API](/2026/06/trigger-github-copilot-coding-agent-task-from-rest-api/)
- [Claude Code vs Cursor vs Copilot Agent Mode: Where Each Wins in 2026](/2026/06/claude-code-vs-cursor-vs-copilot-agent-mode-where-each-wins/)
- [GPT-5.3-Codex Becomes the Copilot Business and Enterprise Base Model](/2026/05/copilot-business-gpt-5-3-codex-base-model/)

## Sources

- [Set AI credit session limits in Copilot CLI and SDK - GitHub Changelog](https://github.blog/changelog/2026-07-01-set-ai-credit-session-limits-in-copilot-cli-and-sdk/)
- [Setting an AI credit session limit in GitHub Copilot CLI - GitHub Docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/set-session-limit)
- [Session limits - GitHub Copilot SDK Docs](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-limits)
- [Budgets for usage-based billing - GitHub Docs](https://docs.github.com/en/copilot/concepts/billing/budgets-for-usage-based-billing)
