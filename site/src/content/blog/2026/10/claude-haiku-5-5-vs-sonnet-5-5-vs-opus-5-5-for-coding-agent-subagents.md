---
title: "Claude Haiku 5.5 vs Sonnet 5.5 vs Opus 5.5 for Coding-Agent Subagents: Picking a Model per Role"
description: "Run the orchestrator on claude-opus-5-5, give implementer and reviewer subagents claude-sonnet-5-5, and send search, triage and summarizing work to claude-haiku-5-5 at medium effort. Here is the role matrix, the cost math per subagent run, Haiku 5.5's 100k-token price cliff, and the Claude Code model-resolution rules that silently override your choice."
pubDate: 2026-10-28
template: vs
tags:
  - "claude-code"
  - "ai-agents"
  - "llm"
  - "subagents"
  - "comparison"
  - "anthropic"
---

**Short answer:** keep the main session (the orchestrator) on `claude-opus-5-5`, put subagents that write or review code on `claude-sonnet-5-5`, and send read-only work (codebase search, log and test-output triage, summarizing, classification) to `claude-haiku-5-5` at `medium` effort. Haiku 5.5 costs $0.10 / $0.50 per million input/output tokens, 20x less than Sonnet 5.5, but only while each request's prompt stays under 100,000 tokens, and it scores 39.2% on Terminal-Bench 4.0 against Sonnet 5.5's 70.6%. So Haiku is for subagents whose output the parent checks, not for ones that edit code unsupervised. Everything here is against the Claude API model IDs as of October 2026 and Claude Code 2.1.292 or later.

The question comes up because the 5.5 family landed in three steps (Opus 5.5 in September, Sonnet 5.5 late September, Haiku 5.5 on October 7, 2026), and each release changed the price gap between tiers. Haiku 5.5 is the one that rewrites the subagent math: it is priced 90% below Haiku 4.5 for prompts up to 100k tokens, and Anthropic's own model-selection matrix now lists "subagent tasks" as a Haiku use case. That does not mean every subagent should run on it.

## The three models side by side

| | Claude Haiku 5.5 | Claude Sonnet 5.5 | Claude Opus 5.5 |
| --- | --- | --- | --- |
| API model ID | `claude-haiku-5-5` | `claude-sonnet-5-5` | `claude-opus-5-5` |
| Input / output per MTok | $0.10 / $0.50 (prompt up to 100k), $0.50 / $2.50 (over 100k) | $2 / $10 | $4 / $20 |
| Cache read per MTok | $0.01 (up to 100k), $0.05 (over) | $0.10 | $0.20 |
| Context window / max output | 1M / 128K | 1M / 128K | 1M / 128K |
| Thinking | Adaptive, can be disabled at `high` or below | Adaptive, `between_tools` is the floor | Adaptive, always on |
| API default effort | `medium` | `high` | `medium` |
| Claude Code default effort | `medium` | `medium` | `medium` |
| Terminal-Bench 4.0 | 39.2% | 70.6% | not published on the Haiku page |
| OSWorld 2.1 (offline subset) | 72.4% | 83.9% | not published on the Haiku page |
| Claude Code alias (Anthropic API) | `haiku` | `sonnet` | `opus` |

Prices come from the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing), benchmark numbers from the [Haiku 5.5 announcement](https://www.anthropic.com/claude-haiku-5-5), and defaults from the [effort docs](https://platform.claude.com/docs/en/build-with-claude/effort) and the [Claude Code model config page](https://code.claude.com/docs/en/model-config). Note the effort row: on the API, Sonnet 5.5 defaults to `high`, but Claude Code runs all three 5.5 models at `medium` unless you say otherwise.

## Roles, and the model each one gets

A coding-agent setup usually has five or six recurring roles. This is the split I use, and why.

| Role | Model | Effort | Why |
| --- | --- | --- | --- |
| Orchestrator (main session) | `claude-opus-5-5` | `medium`, `high` for hard tasks | It plans, dispatches and synthesizes. Every subagent's summary is only as useful as the model reading it. |
| Planner / architect | `inherit` (Opus 5.5) | `high` | Plan quality caps everything downstream. The built-in Plan subagent already inherits. |
| Implementer | `claude-sonnet-5-5` | `medium`, `high` for long or vague tasks | Anthropic's guidance for Sonnet 5.5 agentic coding is `medium` for well-specified tasks, `high` for harder ones. |
| Reviewer / verifier | `claude-sonnet-5-5` | `high` | A reviewer has to catch what the implementer missed. Same tier, more effort. Move to `opus` for security or concurrency review. |
| Explorer / codebase search | `claude-haiku-5-5` | `medium` | Read-only, output goes straight back to the orchestrator, which checks it. |
| Log, CI and test-output triage | `claude-haiku-5-5` | `low` or `medium` | High volume, short, checkable output. |

The rule underneath the table: **pick the model by what happens when the subagent is wrong, not by how hard the task looks.** An Explore subagent that misses a file costs the orchestrator one more search. An implementer that writes a subtly wrong migration costs you a review cycle, or worse, a merge. Terminal-Bench 4.0 is the closest public proxy to "run commands and edit code until it works", and Haiku 5.5's 39.2% against Sonnet 5.5's 70.6% is not a gap you want sitting in a write path with no checker above it.

### Why not Haiku for the implementer at least on small edits

You can, and for mechanical edits (rename a symbol across a package, add a missing `using`, bump a version string) it is fine. But the Haiku 5.5 effort guidance has a specific warning worth taking literally: "In long agent prompts, the model is more likely to skip a search, stop early, or skip a check at `low`." Implementer subagents in Claude Code get long prompts, because they carry the orchestrator's brief plus the tool definitions. If you do give an implementer Haiku, keep it at `medium` or `high` and keep its task narrow enough that a single test run proves it.

### Why not Opus for every subagent

Cost, mostly, and Anthropic has published the measurement that makes the case. In [Optimizing for cost and intelligence](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence), the orchestrator-worker pattern only saved money in two situations: routine work with a long cost tail, and work larger than one context window. When the work was "one dependent chain, or fits in a single context without a long cost tail, the orchestrator's model alone at lower effort came out ahead in every case measured." Read that as: if a subagent would run on Opus anyway, ask whether it should be a subagent at all, or whether the main session should just do the work at lower effort.

## Wiring it up in Claude Code

Each role is a file under `.claude/agents/`. The `model` field accepts an alias (`haiku`, `sonnet`, `opus`, `fable`), a full model ID, or `inherit`. The `effort` field takes `low` through `max`.

```markdown
---
# .claude/agents/explorer.md -- Claude Code 2.1.292+, claude-haiku-5-5
name: Explore
description: Read-only codebase search. Use for "where is X defined", "what calls Y", and mapping a module before edits.
tools: Read, Grep, Glob
model: claude-haiku-5-5
effort: medium
autoCompactWindow: 100000
---
Search the repository and answer with file paths and line numbers.
Quote the 3-10 lines that prove each claim. Do not summarize code you did not open.
If you could not find something, say which patterns you searched for.
```

Naming the file `Explore` overrides the built-in. That matters, because the built-in Explore no longer drops to a cheap model on its own: per the [subagent docs](https://code.claude.com/docs/en/sub-agents), it uses the main conversation's model (or Opus when the main session runs Fable). Without the override, every search your Opus session delegates is billed at Opus rates.

The `autoCompactWindow: 100000` line is the one most people miss, and it gets its own section below.

```markdown
---
# .claude/agents/implementer.md -- Claude Code 2.1.292+, claude-sonnet-5-5
name: implementer
description: Makes a scoped code change from a written spec, runs the affected tests, and reports the diff.
tools: Read, Edit, Write, Grep, Glob, Bash
model: claude-sonnet-5-5
effort: medium
---
Implement exactly the change described. Run the tests that cover the files you touched.
Report: files changed, test command, pass/fail output, anything you were unsure about.
```

```markdown
---
# .claude/agents/reviewer.md -- Claude Code 2.1.292+, claude-sonnet-5-5
name: reviewer
description: Reviews a diff for correctness bugs before it is committed. Use after every implementer run.
tools: Read, Grep, Glob, Bash
model: claude-sonnet-5-5
effort: high
---
Review the current diff against the stated intent. Report only defects you can point to
with a file and line, plus the input that triggers them. No style comments.
```

I write full IDs (`claude-haiku-5-5`) instead of aliases on purpose. More on that in the gotchas.

## What one subagent run actually costs

Rather than "Haiku is cheaper", here is the arithmetic for one realistic subagent run: 20 requests, each with an average prompt of 60,000 tokens of which 55,000 are cache reads and 5,000 are new 5-minute cache writes, and 1,500 output tokens per request. Prices are straight from the pricing table above.

```python
# subagent_cost.py -- prices from platform.claude.com/docs/en/about-claude/pricing, October 2026
# (input, 5m cache write, cache read, output) in USD per million tokens
PRICES = {
    "claude-haiku-5-5 (<=100k)": (0.10, 0.125, 0.01, 0.50),
    "claude-haiku-5-5 (>100k)":  (0.50, 0.625, 0.05, 2.50),
    "claude-sonnet-5-5":         (2.00, 2.50,  0.10, 10.00),
    "claude-opus-5-5":           (4.00, 5.00,  0.20, 20.00),
    "claude-fable-5-1":          (10.00, 12.50, 0.25, 50.00),
}

def run_cost(prompt_tokens, requests=20, new_tokens=5_000, output_tokens=1_500):
    for model, (_inp, write, read, out) in PRICES.items():
        cached = prompt_tokens - new_tokens
        per_request = (cached * read + new_tokens * write + output_tokens * out) / 1e6
        print(f"{prompt_tokens:>7} {model:<27} ${requests * per_request:.4f}")

run_cost(60_000)
run_cost(150_000)
```

| Average prompt | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 | Fable 5.1 |
| --- | --- | --- | --- | --- |
| 60k tokens | $0.04 | $0.66 | $1.32 | $3.03 |
| 150k tokens | $0.28 (over-100k tier) | $0.84 | $1.68 | $3.48 |

At 60k tokens, the Haiku run is about 17x cheaper than Sonnet and 34x cheaper than Opus. At 150k tokens, the gap to Sonnet collapses to 3x. Nothing about the model changed: the run just crossed Haiku 5.5's pricing threshold.

## The 100k-token cliff, and how to stay under it

Haiku 5.5 is the only current model priced by prompt length. The [long-context pricing section](https://platform.claude.com/docs/en/about-claude/pricing#long-context-pricing) is specific: a request's prompt length "counts all of its input tokens, including cache reads and cache writes", and "each request is priced on its own". Caching does not save you. A request whose prompt is 100,001 tokens pays $0.50 / $2.50, a 5x jump on every token in that request.

Subagents drift across that line easily. A Claude Code subagent starts with the system prompt, tool definitions and any `CLAUDE.md` it loads, and then accumulates every file it reads. An explorer that opens fifteen medium-sized files is past 100k before it answers.

Two levers keep it under:

1. **`autoCompactWindow: 100000`** in the subagent's frontmatter (Claude Code 2.1.296+). That is the minimum value the field accepts, and it makes the subagent compact as it approaches 100k instead of at the main session's roughly 967k window. Most requests then bill at the low tier. It is not a hard guarantee: the request that triggers compaction can still land slightly above the line. The details, including the trap where `100k` in frontmatter parses as `100`, are in [how to give each Claude Code subagent its own compaction threshold](/2026/10/how-to-give-each-claude-code-subagent-its-own-compaction-threshold-with-autocompactwindow/).
2. **Narrow tools and narrow prompts.** An explorer with `tools: Read, Grep, Glob` and an instruction to quote 3-10 lines per claim reads less than one that is told to "understand the module". Fewer tool definitions also shrink the fixed overhead each request starts with, which I measured in [the fixed token overhead post](/2026/09/measure-an-agents-fixed-token-overhead-before-the-first-user-token/).

If a role genuinely needs more than 100k tokens of context per request (reading an entire large package to answer one question), Haiku's price advantage shrinks to 4x on input and output against Sonnet. At that point I would rather pay for Sonnet and get the stronger model.

## Gotchas that silently change which model runs

### Aliases resolve differently per provider

The `haiku` alias means Haiku 5.5 only on the Anthropic API. On Amazon Bedrock, Google Cloud's Agent Platform, Claude Platform on AWS and Microsoft Foundry, it resolves to Haiku 4.5, and `sonnet` resolves to Sonnet 4.5 or 4.6 depending on the platform ([alias table](https://code.claude.com/docs/en/model-config)). Haiku 4.5 is $1 / $5, ten times Haiku 5.5's low tier, and it does not support the effort parameter at all, so your `effort: medium` line does nothing. Pin the model: either use the full ID in frontmatter, or set `ANTHROPIC_DEFAULT_HAIKU_MODEL` to the platform's Haiku 5.5 ID (for example `anthropic.claude-haiku-5-5` on Bedrock).

### `CLAUDE_CODE_SUBAGENT_MODEL` is a default, not an override

Since Claude Code 2.1.251, the resolution order is: the per-invocation `model` parameter, then the definition's `model` field, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main model. Before 2.1.251 the environment variable came first. If you upgraded and your "force everything to Haiku" setup stopped working, that is why. To force it again, add `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (2.1.257+):

```json
{
  "env": {
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-haiku-5-5",
    "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1"
  }
}
```

With force on, the `model` field in every definition is ignored, including your implementer's Sonnet. That is usually the wrong trade for a whole team. I only use it in CI runs where the subagents are all triage.

### The orchestrator can override your frontmatter

The per-invocation `model` parameter wins over the definition. The orchestrator can only pass aliases there (`sonnet`, `opus`, `haiku`, `fable`), and a family alias resolves to the main conversation's exact model when that model is in the same family. So an Opus 5.5 session that decides to spawn your explorer with `model: opus` gets Opus 5.5, whatever your file says. If you see this in transcripts, add a line to `CLAUDE.md` telling the orchestrator not to pass `model` for named subagents.

### A global effort setting flattens your roles

`CLAUDE_CODE_EFFORT_LEVEL` takes precedence over both the `effort` field and the per-invocation effort parameter. Set it to `high` in your shell profile and your `low` triage subagent runs at `high` too, which on Haiku 5.5 means more thinking tokens and a faster climb toward the 100k line.

### Thinking is shared, context is not

Subagents inherit the main conversation's thinking setting; there is no per-subagent thinking toggle. Context window size, on the other hand, comes from the subagent's own model. Every current 5.5 model has a 1M window, but if an alias quietly resolves to Haiku 4.5 on another provider, that subagent is back to 200k.

### Haiku 5.5 counts more tokens than Haiku 4.5

Haiku 5.5 uses the tokenizer introduced with Opus 4.7, so the same text is roughly 30% more tokens than on Haiku 4.5. If you set a token budget or a compaction threshold from Haiku 4.5 measurements, re-measure.

## When to reach for Fable 5.1 instead

Not for subagents, in almost every case. `claude-fable-5-1` is $10 / $50 and slower. Anthropic's own guidance is to move to it only when Opus 5.5 at `xhigh` or `max` still falls short. Where it can make sense is as an *advisor* to an Opus 5.5 executor rather than a worker, but the measured result is sobering: on Anthropic's internal agentic-coding benchmark, Opus 5.5 with a Fable 5.1 advisor scored 1.7 points above Opus alone, "at the edge of run-to-run noise", for about 2.1x the cost. Measure on your own tasks before paying for it.

## The recommendation, restated

Orchestrator on Opus 5.5. Planner inherits it. Implementer and reviewer on Sonnet 5.5, the reviewer one effort level higher than the implementer. Explorer and triage subagents on Haiku 5.5 at `medium`, with `autoCompactWindow: 100000` so they stay on the cheap side of the price cliff, and full model IDs everywhere so a provider switch cannot swap in Haiku 4.5 behind your back.

If you only make one change today, override the built-in `Explore` with a Haiku 5.5 definition. It is the subagent that runs most often, it never writes code, and on an Opus session it is currently billed at Opus rates.

## Related

- [Claude Code skills vs subagents vs MCP servers: when to build each](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/) covers whether a role should be a subagent in the first place.
- [When nested subagent depth helps and when it burns tokens](/2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens/) measures where subagent spend actually goes.
- [Subtask vs fork vs background agent in Claude Code](/2026/08/subtask-vs-fork-vs-background-agent-in-claude-code/) picks the delegation mechanism once you have picked the model.
- [What a context window is and how agents stretch it in 2026](/2026/10/what-is-a-context-window-and-how-do-agents-stretch-it-in-2026/) explains compaction and the 1M windows these models share.
- [Cursor subagents vs Claude Code subagents](/2026/07/cursor-subagents-vs-claude-code-subagents/) if your team runs both tools.

## Sources

- [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview) and [Claude Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview), Anthropic docs.
- [Pricing, including long context pricing](https://platform.claude.com/docs/en/about-claude/pricing), Anthropic docs.
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) and [Choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model), Anthropic docs.
- [Optimizing for cost and intelligence](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence), Anthropic docs.
- [Introducing Claude Haiku 5.5](https://www.anthropic.com/claude-haiku-5-5), Anthropic.
- [Subagents](https://code.claude.com/docs/en/sub-agents) and [Model configuration](https://code.claude.com/docs/en/model-config), Claude Code docs.
