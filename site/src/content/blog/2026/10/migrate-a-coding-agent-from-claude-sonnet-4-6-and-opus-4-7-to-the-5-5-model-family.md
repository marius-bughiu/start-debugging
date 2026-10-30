---
title: "Migrate a Coding Agent from Claude Sonnet 4.6 and Opus 4.7 to the 5.5 Family: Model IDs, Effort, and Cost"
description: "Moving an agent from claude-sonnet-4-6 or claude-opus-4-7 to claude-sonnet-5-5 or claude-opus-5-5 is not just a model ID swap. Thinking is always on, thinking-off and forced tool_choice now return 400, the effort defaults moved, Sonnet counts about 30% more tokens, and Claude Code ignores your old effortLevel on Opus 5.5. Here is the full checklist with before/after code."
pubDate: 2026-10-30
template: migration
tags:
  - "llm"
  - "claude-code"
  - "ai-agents"
  - "migration"
  - "anthropic-sdk"
  - "anthropic"
---

**Short answer:** change `claude-sonnet-4-6` to `claude-sonnet-5-5` and `claude-opus-4-7` to `claude-opus-5-5`, then fix the five things that now return a 400 or change silently. (1) Thinking is on for every request, so `thinking: {"type": "disabled"}` and `budget_tokens` are rejected; on Sonnet 5.5 the thinking-off route is `{"type": "between_tools"}`. (2) Forced `tool_choice` (`any` or `tool`) is rejected; use `auto` plus `strict: true` and check that the call happened. (3) Set `output_config.effort` explicitly: Opus 5.5 defaults to `medium` where Opus 4.7 defaulted to `high`, and Sonnet 5.5's levels are recalibrated. (4) Read response blocks by `type` and pass `thinking` blocks back unchanged. (5) On Sonnet, recount tokens: the same text is about 30% more tokens than on Sonnet 4.6. The work usually takes a day for one agent harness plus an effort sweep, and it pays off: Opus 5.5 lists at $4 / $20 per million tokens against Opus 4.7's $5 / $25, and Sonnet 5.5 at $2 / $10 against Sonnet 4.6's $3 / $15.

Everything below is against the Claude API as of October 30, 2026, the `2023-06-01` API version, and Claude Code 2.1.280 or later (the first release that knows Opus 5.5).

## Why this migration is not a find-and-replace

The 4.6/4.7 generation and the 5.5 generation disagree on one basic question: who decides whether the model thinks. On Opus 4.7 and Sonnet 4.6, a request with no `thinking` field runs without thinking, and you opt in. On Opus 5.5 and Sonnet 5.5, a request with no `thinking` field runs with adaptive thinking, and on Opus 5.5 you cannot opt out at all. Almost every breaking change in this migration falls out of that inversion: `max_tokens` budgets that were sized for answer-only output, parsers that read `content[0].text`, UIs that went quiet, and routes that set `thinking: {"type": "disabled"}` to save latency.

The second shift is that effort replaced the thinking budget as the only dial, and the defaults moved. The reason to do the work anyway is cost per finished task: in Anthropic's testing, Opus 5.5 at `medium` matched or beat Opus 5 at `high` on multistep coding with about half the tokens. That is a vendor number, so treat it as a reason to run your own sweep, not as a result.

## What breaks, by source model

| Area | From Sonnet 4.6 | From Opus 4.7 | Severity |
| --- | --- | --- | --- |
| Request with no `thinking` field | Ran without thinking, now thinks | Ran without thinking, now thinks | high (silent truncation) |
| `thinking: {"type": "disabled"}` | 400, use `between_tools` | 400, no off switch | high |
| `thinking: {"type": "enabled", "budget_tokens": N}` | 400 (was deprecated) | already 400 on 4.7 | high |
| `tool_choice` `any` / `tool` | 400 | 400 | high |
| `temperature` / `top_p` / `top_k` | 400 on non-default values | already 400 on 4.7 | medium |
| Default `effort` | `high`, recalibrated | `medium` (was `high`) | medium |
| `thinking.display` default | `"omitted"` (was `"summarized"`) | `"omitted"` (unchanged) | medium |
| Tokenizer | about 30% more tokens | unchanged | medium |
| Text between tool calls | arrives in `thinking` blocks | arrives in `thinking` blocks | medium |
| Editing earlier turns, `system`, or `tools` | can 400 on new accounts | can 400 on new accounts | medium |
| `computer_20251124` tool | 400 on Claude API and Google Cloud | 400 on Claude API and Google Cloud | low unless you use computer use |

The tokenizer row is the one that surprises people in opposite directions. Sonnet 5.5 uses Sonnet 5's tokenizer, which emits roughly 30% more tokens than Sonnet 4.6 for the same text. Opus 4.7 already introduced that tokenizer family, so Opus 4.7 to Opus 5.5 leaves token counts roughly where they were. I covered the Sonnet side in detail when [Sonnet 5 became the Claude Code default and token budgets needed a recount](/2026/07/claude-sonnet-5-claude-code-default-new-tokenizer-token-budgets/); the same advice carries over to 5.5.

## What it costs after the move

List prices per million tokens, from the Anthropic pricing page on October 30, 2026:

| Model | Input | 5m cache write | Cache read | Output | Batch in / out |
| --- | --- | --- | --- | --- | --- |
| `claude-sonnet-4-6` | $3.00 | $3.75 | $0.30 | $15.00 | $1.50 / $7.50 |
| `claude-sonnet-5-5` | $2.00 | $2.50 | $0.10 | $10.00 | $1.00 / $5.00 |
| `claude-opus-4-7` | $5.00 | $6.25 | $0.50 | $25.00 | $2.50 / $12.50 |
| `claude-opus-5-5` | $4.00 | $5.00 | $0.20 | $20.00 | $2.00 / $10.00 |

For Opus the arithmetic is simple: same token counts, 20% lower rates, 60% cheaper cache reads. For Sonnet, text that was 1,000,000 tokens on 4.6 becomes about 1,300,000 tokens on 5.5. At the new rates that is about $2.60 of input instead of $3.00, and about $13.00 of output instead of $15.00 for the same reply text: roughly 13% cheaper, not the 33% the rate card suggests. The real swing is thinking: if your Sonnet 4.6 route ran without thinking, every 5.5 request now produces billed thinking tokens on top of the answer. Cache reads drop from $0.30 to $0.10, which is why a long agent loop with a warm cache usually still comes out cheaper. If you have not measured your hit rate yet, [add prompt caching and measure the hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/) before you compare bills, or you will be comparing noise. Both 5.5 models also lower the minimum cacheable prompt to 512 tokens (1,024 on Sonnet 4.6), so short system prompts that never cached may start caching.

## Pre-flight checklist

- Know which account you are on: preserved-thinking checks are enforced by default for accounts created on or after August 31, 2026, 00:00 UTC.
- Grep the harness for `thinking`, `budget_tokens`, `tool_choice`, `temperature`, `top_p`, `top_k`, `content[0]`, `computer_20251124`, and any code that rewrites `messages`, `system`, or `tools` mid-conversation.
- Have an eval set, even 30 real tasks, that you can run at two or three effort levels. Without it, the effort step is guesswork.
- Check your rate-limit tier for each 5.5 model. Both have their own pools; moving traffic does not inherit headroom from the 4.x pools.
- Upgrade Claude Code to 2.1.280 or later if your agent runs inside it.

## Migration steps

1. **Swap the model IDs.** Use the bare IDs `claude-sonnet-5-5` and `claude-opus-5-5`, no date suffix (`anthropic.claude-opus-5-5` on Amazon Bedrock). Verify with one request that `response.model` echoes the new ID.
2. **Replace every thinking-off or budget setting with an effort level.** Remove `budget_tokens` everywhere, remove `{"type": "disabled"}` on Opus, and on Sonnet try adaptive at `low` before reaching for `between_tools`. Verify by running each route once: zero 400s.
3. **Set `output_config.effort` explicitly on every route.** Do not inherit defaults. Verify by logging the effort value next to each request.
4. **Resize `max_tokens` for thinking plus answer.** Start at 64,000 for long agentic coding turns. Verify that no response in your eval run ends with `stop_reason: "max_tokens"`.
5. **Read content by block type and echo thinking blocks back unchanged.** Verify by running a multi-tool turn end to end.
6. **Replace forced `tool_choice` with `auto` plus strict tools and a call check.** Verify with the routes that used to force a tool.
7. **Remove sampling parameters.** Verify by grepping the final request payloads, including wrapper libraries.
8. **Make history append-only and handle `refusal`.** Verify with a replayed long conversation and a forced refusal path.
9. **Recount tokens and re-run the effort sweep.** Verify cost per completed task, not cost per request.

The sections below show the code for the steps that need more than a sentence.

## The thinking rewrite, before and after

This is the most common shape I see in agents written for Sonnet 4.6: a fixed thinking budget for the planner call, thinking off for the cheap calls, and the reply read by position.

```python
# Before: anthropic Python SDK, claude-sonnet-4-6, API version 2023-06-01
import anthropic

client = anthropic.Anthropic()

plan = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=16000,
    thinking={"type": "enabled", "budget_tokens": 8000},  # 400 on 5.5
    temperature=0.2,                                       # 400 on 5.5
    messages=[{"role": "user", "content": task}],
)
print(plan.content[-1].text)

label = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=256,
    thinking={"type": "disabled"},                         # 400 on 5.5
    messages=[{"role": "user", "content": f"Classify: {issue_title}"}],
)
print(label.content[0].text)                               # breaks on 5.5
```

The 5.5 version drops the budget and the sampling parameter, moves the dial to effort, gives the cheap call room to think, and reads text by type:

```python
# After: anthropic Python SDK, claude-sonnet-5-5, API version 2023-06-01
import anthropic

client = anthropic.Anthropic()

def text_of(message) -> str:
    return "".join(b.text for b in message.content if b.type == "text")

plan = client.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=64000,
    output_config={"effort": "medium"},   # agentic coding starting point
    messages=[{"role": "user", "content": task}],
)
print(text_of(plan))

label = client.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=2048,                      # thinking counts toward max_tokens
    output_config={"effort": "low"},      # low skips thinking on most simple requests
    messages=[{"role": "user", "content": f"Classify: {issue_title}"}],
)
print(text_of(label))
```

If a Sonnet route genuinely must not think up front (a latency SLO you have measured, not a hunch), Sonnet 5.5 has one escape hatch:

```python
# claude-sonnet-5-5 only: the lowest thinking setting
label = client.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=512,
    thinking={"type": "between_tools"},   # no other field allowed inside thinking
    output_config={"effort": "high"},     # 400 at xhigh or max
    messages=[{"role": "user", "content": f"Classify: {issue_title}"}],
)
```

`between_tools` has sharp edges. It is accepted only at `low`, `medium`, and `high`; any other field inside `thinking` is a 400; per-message effort changes are a 400; and every other model rejects it, so a router or retry that re-sends the same body to a different model must strip it first. Opus 5.5 has no equivalent: its answer to "I want less thinking" is `effort: "low"`, which Anthropic says reduces thinking more reliably than a "think less" instruction.

## Picking effort without guessing

The defaults are a trap because they differ by model and by surface:

| Model | API default | Claude Code default | Notes |
| --- | --- | --- | --- |
| `claude-opus-4-7` | `high` | `xhigh` | `xhigh` was recommended for coding |
| `claude-opus-5-5` | `medium` | `medium` | at a given level, thinks more per turn than Opus 5 |
| `claude-sonnet-4-6` | `high` | `high` | no `xhigh` level |
| `claude-sonnet-5-5` | `high` | `medium` | levels recalibrated against Sonnet 5 |

So an Opus 4.7 agent that ran at Claude Code's `xhigh` default lands on `medium` after the swap, two levels lower, and a Sonnet 4.6 API caller that omitted effort lands on a `high` that no longer means the same amount of work. Anthropic's starting points for 5.5 are `medium` for agentic coding and multistep tool use, `low` for chat, classification and extraction, and `xhigh` or `max` only where your evals show a gain. Run the sweep instead of trusting the table:

```python
# effort_sweep.py: anthropic Python SDK, claude-opus-5-5 or claude-sonnet-5-5
import anthropic, statistics

client = anthropic.Anthropic()
MODEL = "claude-opus-5-5"
PRICES = {"claude-opus-5-5": (4.00, 20.00), "claude-sonnet-5-5": (2.00, 10.00)}  # USD per MTok

def run(task: str, effort: str):
    msg = client.messages.create(
        model=MODEL,
        max_tokens=64000,
        output_config={"effort": effort},
        messages=[{"role": "user", "content": task}],
    )
    inp, out = PRICES[MODEL]
    cost = (msg.usage.input_tokens * inp + msg.usage.output_tokens * out) / 1_000_000
    return msg, cost

for effort in ("low", "medium", "high"):
    costs, passed = [], 0
    for task, check in EVAL_SET:            # your (prompt, grader) pairs
        msg, cost = run(task, effort)
        costs.append(cost)
        passed += check(msg)
    print(f"{effort:>6}: pass {passed}/{len(EVAL_SET)}, "
          f"median ${statistics.median(costs):.4f}, "
          f"cost per pass ${sum(costs) / max(passed, 1):.4f}")
```

Pick the lowest level whose pass rate holds, then judge it by cost per pass. If you want a single session to run cheap most of the time and spend more on a hard turn, use the per-message effort change (beta `mid-conversation-output-config-2026-07-01`) rather than changing the top-level `effort` between requests, because the top-level change invalidates the prompt cache. Per-role model choice is a separate decision; I worked through it for [Haiku 5.5 vs Sonnet 5.5 vs Opus 5.5 across subagent roles](/2026/10/claude-haiku-5-5-vs-sonnet-5-5-vs-opus-5-5-for-coding-agent-subagents/).

## Forced tool use, the other hard 400

Both 5.5 models reject `tool_choice: {"type": "any"}` and `{"type": "tool", "name": ...}`, on `messages.create`, on Message Batches, and on `count_tokens`. The error reads `tool_choice: type "tool" and "any" are not supported for this model.` Migrate by intent:

```python
# After: claude-opus-5-5 / claude-sonnet-5-5, steering instead of forcing
response = client.messages.create(
    model="claude-opus-5-5",
    max_tokens=16000,
    output_config={"effort": "medium"},
    tools=[{**tool, "strict": True} for tool in tools],  # schemas need additionalProperties: false
    tool_choice={"type": "auto"},
    messages=[{"role": "user",
               "content": f"{question}\n\nUse the run_tests tool to answer."}],
)
if not any(b.type == "tool_use" for b in response.content):
    ...  # retry once with a firmer instruction, or treat as a text answer
```

If the forced call only existed to get JSON back, which is the most common reason, drop the tool entirely and use structured outputs via `output_config.format`. `strict: true` keeps the arguments schema-valid; it does not guarantee the call happens, which is why the check matters. There is more background on why schemas carry this weight in [what tool calling is and why JSON schemas matter more than prompts](/2026/10/what-is-tool-calling-and-why-json-schemas-matter-more-than-prompts/).

## Thinking blocks are now part of your transcript contract

Three things change in the response, and none of them raise an error on their own.

First, responses can start with `thinking` blocks, empty by default because `thinking.display` is `"omitted"`. Sonnet 4.6 defaulted to `"summarized"`, so a UI that showed reasoning goes blank; set `thinking: {"type": "adaptive", "display": "summarized"}` to bring it back.

Second, the short notes the model writes between tool calls ("found the failing test, checking the fixture next") come back as `thinking` blocks instead of `text`. A client that renders only `text` goes quiet for the whole agentic turn. Set `display: "updates"` (beta `thinking-display-updates-2026-08-18`) to get just those notes, and render each non-empty `thinking` block ahead of the `tool_use` that follows it.

Third, thinking blocks are bound to the model and the conversation. Echo the assistant message back exactly as received in tool-use loops. If your harness edits history (deletes a per-turn reminder, swaps the system prompt mid-session, adds tools later, or compacts older turns while replaying newer ones with their thinking), the API checks that the `system` prompt, `tools`, and every earlier message are byte-identical to when the block was produced. On accounts created on or after August 31, 2026, a mismatch is a 400. The append-only replacements are a mid-conversation `role: "system"` message for changed instructions, `tool_addition` / `tool_removal` blocks for tool changes, and server-side compaction. During the transition you can opt into dropping the stale blocks instead of failing:

```python
# claude-opus-5-5: drop thinking blocks invalidated by a history edit instead of returning 400
response = client.beta.messages.create(
    model="claude-opus-5-5",
    max_tokens=64000,
    betas=["thinking-binding-controls-2026-08-01"],
    thinking={"type": "adaptive",
              "block_binding": {"prefix_mismatch_behavior": "drop_block"}},
    output_config={"effort": "medium"},
    messages=history,
)
```

`block_binding` works only with adaptive thinking, not with `between_tools`. Treat `drop_block` as a bridge: every dropped block is reasoning the model no longer has.

## Refusals and fallback

Both 5.5 models run safety classifiers that decline some requests with HTTP 200, `stop_reason: "refusal"`, and a `stop_details.category` such as `"cyber"` or `"bio"` (Sonnet 5.5 adds `"frontier_llm"`, `"reasoning_extraction"`, and `"general_harms"`). Code that indexes into `content` unconditionally breaks on that. Check `stop_reason` first, and opt into server-side fallback from day one so a false positive does not become an outage:

```python
# claude-opus-5-5, Claude API only: let Anthropic pick the fallback by refusal category
response = client.beta.messages.create(
    model="claude-opus-5-5",
    max_tokens=16000,
    betas=["server-side-fallback-2026-07-01"],
    extra_body={"fallbacks": "default"},
    output_config={"effort": "medium"},
    messages=history,
)
if response.stop_reason == "refusal":
    log.warning("declined: %s", response.stop_details)
```

Two caveats. A fallback model cannot read Opus 5.5's thinking blocks, so the turns after a fallback run without that reasoning. And on Sonnet 5.5, server-side fallback only retries `cyber` and `frontier_llm` declines. Coming from Sonnet 4.6, real-time cyber safeguards are new to you entirely; legitimate security tooling should apply to Anthropic's Cyber Verification Program rather than prompt around it.

## The Claude Code side of the same migration

If the agent is Claude Code itself, the model ID swap is mostly done for you: on the Anthropic API, `opus` resolves to Opus 5.5 and `sonnet` to Sonnet 5.5 from Claude Code 2.1.280. On Bedrock and Google Cloud, `sonnet` still resolves to an older Sonnet, so pin it if you want 5.5 there:

```json
{
  "model": "opus",
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-5"
  },
  "modelSettings": {
    "claude-opus-5-5": { "effortLevel": "high" },
    "claude-sonnet-5-5": { "effortLevel": "medium" }
  }
}
```

The `modelSettings` block is the part people miss. A top-level `effortLevel` in `~/.claude/settings.json` (the form `/effort` wrote before Claude Code 2.1.251) keeps applying to Opus 4.7 and Opus 5, but Opus 5.5 and later models ignore it and start at their own `medium` default. So the `"effortLevel": "xhigh"` you set months ago for Opus 4.7 silently stops applying the day `opus` moves to 5.5. Run `/effort status` after the switch, or save a per-model level with `/effort high`, which writes under `modelSettings`. In project, local, and managed settings the top-level key still applies to every model, and `CLAUDE_CODE_EFFORT_LEVEL` and `--effort` outrank both.

Custom subagents that pin `model: claude-sonnet-4-6` in their frontmatter keep running on 4.6 until you change them. That is fine as a staged rollout, and a trap if you forgot they were pinned.

## Verification

- Every route runs once with zero 400s against both new model IDs.
- No eval response ends with `stop_reason: "max_tokens"`.
- Token counts are recounted, not scaled. For Sonnet, run `client.messages.count_tokens(model="claude-sonnet-5-5", messages=...)` on a sample of real prompts and update any client-side estimator or context-window threshold you calibrated against 4.6.
- The effort sweep shows pass rate and cost per pass at two or three levels.
- A replayed long conversation from production passes with no thinking-binding errors.
- The UI shows progress during a long tool-calling turn.

## Rollback

The swap is reversible: `claude-sonnet-4-6` and `claude-opus-4-7` are still served, so keep the old request shapes behind a per-model flag and flip back. Two things do not roll back cleanly. In-flight conversations continue on 4.x without the 5.5 thinking blocks, which the API drops unbilled. And Opus 4.7 rejects `role: "system"` inside `messages`, so if your append-only harness relies on mid-conversation system messages, gate that per model too.

## Gotchas worth checking twice

- **Opus 4.7 code that never set `thinking`.** There is nothing to delete, which is exactly why it gets missed. It now thinks on every call, bills those tokens as output, and can truncate if `max_tokens` was tight.
- **Wrapper libraries sending `temperature`.** LangChain, LiteLLM and similar wrappers may send sampling parameters from their own config. On API version `2026-10-21`, any value of `temperature`, `top_p`, or `top_k` is a 400 on every model, even the default.
- **Rate limits.** Each 5.5 model has its own pool. A cut-over at peak traffic can hit 429s even though your 4.x headroom was fine; if that happens, the backoff patterns from [fixing rate-limit errors in a long Sonnet 4.6 agent loop](/2026/05/fix-rate-limit-error-on-claude-sonnet-4-6-in-a-long-agent-loop/) still apply.
- **Computer use.** On the Claude API and Google Cloud, both 5.5 models accept only `computer_toolset_20260801`, where the action is the `tool_use` block's `name` and every result must echo `"toolset_name": "computer"`. Bedrock still takes `computer_20251124`.
- **Images on Sonnet.** A 2000x1500 screenshot costs about 2.5 times the image tokens it did on Sonnet 4.6, because Sonnet 5.5 reads up to 2,576 pixels on the long edge. Downsample if you do not need the detail.

If you only do one thing today, grep for `"disabled"`, `budget_tokens`, and `tool_choice` before you touch the model string. Those three are the 400s; everything else degrades quietly and shows up in your eval run.

## Related

- [Claude Sonnet 5 is the new Claude Code default: recount your token budgets](/2026/07/claude-sonnet-5-claude-code-default-new-tokenizer-token-budgets/) explains the tokenizer change Sonnet 5.5 inherits.
- [Claude Haiku 5.5 vs Sonnet 5.5 vs Opus 5.5 for coding-agent subagents](/2026/10/claude-haiku-5-5-vs-sonnet-5-5-vs-opus-5-5-for-coding-agent-subagents/) picks a model per role once you are on 5.5.
- [Prompt caching on Sonnet 4.6 vs Opus 4.7: when it pays off](/2026/06/prompt-caching-on-claude-sonnet-4-6-vs-claude-opus-4-7-when-it-pays-off/) is the baseline to compare the new cache-read prices against.
- [How to add prompt caching to an Anthropic SDK app and measure the hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/) for the measurement half of the cost comparison.
- [What tool calling is and why JSON schemas matter more than prompts](/2026/10/what-is-tool-calling-and-why-json-schemas-matter-more-than-prompts/) for the strict-tool pattern that replaces forced `tool_choice`.

## Sources

- [Claude Opus 5.5 migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide) and [Claude Sonnet 5.5 migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide), Anthropic docs.
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing), Anthropic docs.
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) and [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), Anthropic docs.
- [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking) and [Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback), Anthropic docs.
- [Model configuration](https://code.claude.com/docs/en/model-config) and [Settings reference: modelSettings](https://code.claude.com/docs/en/settings-reference#modelsettings), Claude Code docs.
