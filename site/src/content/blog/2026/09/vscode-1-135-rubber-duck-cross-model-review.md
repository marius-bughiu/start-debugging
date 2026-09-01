---
title: "VS Code 1.135 Ships /rubber-duck, and It Deliberately Uses a Different Model"
description: "The experimental /rubber-duck command in VS Code 1.135 hands the agent's plan, code, and tests to a model from another family for review. GPT-5.4 critiques Claude, and the cross-family choice is the whole point."
pubDate: 2026-09-01
tags:
  - "ai-agents"
  - "github-copilot"
  - "llm"
  - "claude-code"
---

VS Code 1.135 shipped on August 26, 2026, and GitHub rolled it into the "GitHub Copilot in VS Code, August 2026 releases" changelog on August 31. Buried among the session-layout work is the most interesting thing in the release: an experimental `/rubber-duck` command that gets a second opinion on the agent's work from a model in a different family.

## Self-review does not find what the model already missed

Asking a model to check its own output is close to free, which is why nearly every agent harness does it. It is also weak. The same weights that produced the plan produce the review, so the blind spots are correlated: if the model did not think about the concurrent-write case while writing the code, it does not think about it while reviewing the code either.

Rubber Duck takes the opposite bet. The orchestrator is any Claude family model picked from the model picker, and the reviewer is GPT-5.4. The complementary-model strategy is explicit, not incidental: the reviewer is chosen from a family other than the primary model's, so a Claude session gets a GPT critic and a GPT session gets the reverse. GitHub is candid that this is an experiment, saying it is "exploring other model families for the orchestrator and for the Rubber Duck."

## A read-only critic with a triage output

Rubber Duck cannot edit. It reads the plan, the diff, and the tests, and looks for substantive problems: logic errors, design flaws, security holes, missing test coverage. What comes back is triaged rather than dumped:

```text
> /rubber-duck

Blocking
  - RefreshTokenAsync writes the new token before the old one is revoked.
    A crash between the two leaves both valid.

Non-blocking
  - The retry loop has no jitter. Three clients failing together will
    stay in lockstep.

Suggestions
  - No test covers an expired token with a valid signature.
```

The blocking / non-blocking / suggestions split is the part worth stealing if you build your own review subagent. An unranked list of twelve observations gets skimmed; three blocking items get read.

## It fires on its own, sparingly

You can invoke it by hand, but Copilot also calls it at four moments where the payoff is highest: after drafting a plan, after a complex implementation, after writing tests but before running them, and when the agent is stuck in a loop. That last trigger is the one that earns its keep, since a looping agent is the clearest signal that the primary model has run out of ideas about its own output.

Under the hood it runs through Copilot's existing task tool, the same machinery as other subagents. That means it is not free: every automatic invocation is a full model turn against your premium usage, on top of the primary agent's tokens. VS Code 1.135 also added per-model token accounting on the chat response footer, which is how you will find out what the duck costs.

## Turning it on

In VS Code, `/rubber-duck` works inside a Copilot agent host session, the mode that runs the harness in a dedicated process over the Agent Host Protocol. If you have not enabled agent host sessions yet, that is the same feature set that [first landed multi-chat Claude agent-host sessions in VS Code 1.128](/2026/07/vscode-1-128-multi-chat-claude-agent-host-sessions/). In GitHub Copilot CLI, gate it on with the `/experimental` slash command.

Availability is conditional: the main session has to be on a Claude or GPT model, and a suitable complementary model has to be available. If neither holds, the command simply is not there.

Full details are in the [VS Code 1.135 release notes](https://code.visualstudio.com/updates/v1_135) and GitHub's writeup on [combining model families for a second opinion](https://github.blog/ai-and-ml/github-copilot/github-copilot-cli-combines-model-families-for-a-second-opinion/).
