---
title: "The New .NET Unit-Test Agent's Best Idea Is Not Writing Tests"
description: "On 2026-07-31 Microsoft shipped a polyglot unit-test agent in dotnet/skills. The interesting part is the mandatory pre-completion gate that pseudo-mutates your assertions before the agent is allowed to say it is done."
pubDate: 2026-08-01
tags:
  - "dotnet"
  - "ai-agents"
  - "testing"
  - "github-copilot"
  - "agent-skills"
---

Every coding agent will happily generate unit tests. The failure mode is not that it refuses, it is that you end up with 40 green tests that assert `Assert.NotNull(result)` and would survive you deleting the method body. On 2026-07-31 Amaury Levé published [From generated code to trusted code with a unit-test agent](https://devblogs.microsoft.com/dotnet/polyglot-unit-testing-agent/), shipping the `dotnet-test` plugin in [dotnet/skills](https://github.com/dotnet/skills/tree/main/plugins/dotnet-test). It targets exactly that failure mode, and the mechanism is worth stealing even if you never install it.

## Installing It Takes Two Lines

The plugin rides on the GitHub Copilot CLI marketplace, the same distribution path the [modernize-dotnet agent moved to earlier in July](/2026/07/modernize-dotnet-anywhere-github-copilot-cli-plugin/):

```bash
/plugin marketplace add dotnet/skills
/plugin install dotnet-test@dotnet-agent-skills
```

Despite living under `dotnet/`, the agent is polyglot: .NET, Python, TypeScript, JavaScript, Java, Go, Ruby, Rust, Swift, Kotlin, PowerShell, and C++. It scopes itself to unit tests only, isolating the code under test and mocking external services. No integration, e2e, or perf tests.

## The Gate That Runs Before It Reports Success

Under the hood, `code-testing-generator` is an internal orchestrator (`user-invocable: false`) that fans out to a chain of subagents: researcher, planner, implementer, builder, tester, fixer, linter. It picks one of three work paths based on scope, and the guidance is refreshingly conservative: most requests should take the Direct path and skip the pipeline entirely, reserving full Research to Plan to Implement cycles for scope that spans unrelated source files.

The part that matters is what happens before the agent is allowed to finish. For any non-trivial addition (roughly five or more tests, or an enumerated list of behaviors), a pre-completion review is mandatory and runs three checks:

1. **Pseudo-mutation analysis** via the `test-gap-analysis` skill: would these assertions actually fail if the implementation changed?
2. **Assertion depth review** via `assertion-quality`: are the assertions weak, missing, or tautological?
3. **Prompt-scenario mapping**: does every behavior you asked for have a dedicated test, not just an incidental one?

That is the difference between a test the compiler accepts and a test that earns its place:

```csharp
// Fails the assertion-quality check: green even if Apply() returns input unchanged
Assert.NotNull(cart.Apply(coupon));

// Survives pseudo-mutation: pins the actual behavior
var result = cart.Apply(coupon);
Assert.Equal(90.00m, result.Total);
Assert.Single(result.AppliedDiscounts, d => d.Code == "SAVE10");
```

Only after that does it run the full workspace build and the complete suite, and verify the repo's own test discovery finds the new tests.

## What the Numbers Say

Microsoft reports a 92.1% completion rate (140 of 152 tasks) against 78.9% for stock Copilot, with the gap widening on vague prompts: 88.8% versus 66.3%. Average task time was 359 seconds, producing 72.4% line and 49.8% branch coverage.

Read the branch number honestly. Half your branches still go uncovered, which is roughly what you would expect from an agent that stops when its checklist clears rather than when a coverage target is hit. The value here is not that it replaces you writing tests. It is that the mutation-and-assertion gate is a codified answer to "how do I know this generated test is worth keeping," and you can lift that idea into whatever agent you already run.
