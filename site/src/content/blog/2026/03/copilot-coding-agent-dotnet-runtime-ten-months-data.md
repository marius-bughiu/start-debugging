---
title: "What 878 Copilot Coding Agent PRs in dotnet/runtime Actually Look Like"
description: "The .NET team shares ten months of real data on running GitHub's Copilot Coding Agent in dotnet/runtime: 878 PRs, a 67.9% merge rate, and clear lessons on where AI-assisted development helps and where it still falls short."
pubDate: 2026-03-29
tags:
  - "dotnet"
  - "ai"
  - "ai-agents"
  - "github-copilot"
  - "copilot"
  - "github"
---

GitHub's Copilot Coding Agent has been running in the [dotnet/runtime](https://github.com/dotnet/runtime) repository since May 2025. Stephen Toub's [deep-dive post](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/) covers ten months of real usage: 878 PRs submitted, 535 merged, a 67.9% merge rate, and a revert rate of just 0.6%.

## Where the Numbers Get Interesting

Not all PR sizes are created equal. Small, focused changes succeed at higher rates:

| PR Size (lines changed) | Success Rate |
|---|---|
| 1-10 lines | 80.0% |
| 11-50 lines | 76.9% |
| 101-500 lines | 64.0% |
| 1,001+ lines | 71.9% |

The dip at 101-500 lines reflects the boundary where mechanical tasks blur into architectural ones. Cleanup and removal work tops categories at 84.7% success, followed by test additions at 75.6%. These are tasks with clear success criteria, no ambiguity about intent, and limited blast radius.

## Instructions Are the Entire Game

The team's first month produced a 41.7% merge rate with no meaningful configuration. After writing a proper agent instructions file -- specifying build commands, test patterns, and architectural boundaries -- the rate climbed to 69% within weeks and eventually reached 72%.

A minimal but effective setup looks like this:

```markdown
## Build
Run `./build.sh clr -subset clr.runtime` to build the runtime.
Run `./build.sh -test -subset clr.tests` to run tests.

## Testing Patterns
New public APIs require tests in src/tests/.
Use existing helpers in XUnitHelper rather than writing from scratch.

## Scope Limits
Do not change public API surface without a linked tracking issue.
Native (C++) components require Windows CI -- avoid if not needed.
```

The instructions do not need to be long. They need to be specific.

## Review Capacity Becomes the Bottleneck

A telling observation from the data: a single developer could queue nine substantial PRs from a phone while travelling, generating 5-9 hours of review work for the team. PR generation scaled faster than PR review. That asymmetry prompted parallel investment in AI-assisted code review to absorb the new volume. This pattern will repeat in any team that adopts the agent at scale.

## What CCA Does Not Replace

Architectural decisions, cross-platform reasoning, and judgment calls about API shape consistently required human intervention. CCA's merged code breaks down as 65.7% test code versus 49.9% for human contributors. It is strongest at filling in the mechanical work humans routinely deprioritize.

The broader validation covered seven .NET repositories (aspire, roslyn, aspnetcore, efcore, extensions, and others): 1,885 merged PRs from 2,963 submitted, a 68.6% success rate. The pattern holds at scale.

For teams thinking about adopting Copilot Coding Agent: start with small cleanup or test tasks, write your instructions file before anything else, and plan for review capacity to become the next constraint.

The full analysis is at [devblogs.microsoft.com](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/).
