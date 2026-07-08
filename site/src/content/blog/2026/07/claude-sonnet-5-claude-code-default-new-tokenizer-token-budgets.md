---
title: "Claude Sonnet 5 Is the New Claude Code Default: Recount Your Token Budgets"
description: "Claude Sonnet 5 (claude-sonnet-5) shipped June 30, 2026 and now backs the 'sonnet' alias in Claude Code. Its new tokenizer emits about 30% more tokens for the same text, so cost estimates and max_tokens limits tuned for Sonnet 4.6 need a recount."
pubDate: 2026-07-08
tags:
  - "claude-code"
  - "ai-agents"
  - "llm"
---

Claude Sonnet 5 (`claude-sonnet-5`) landed on June 30, 2026, and it is not a preview you have to opt into. On the Anthropic API the `sonnet` alias now resolves to it, and in Claude Code it is the account default for Pro, Team Standard, and Enterprise subscription seats. That means a lot of people are already running it without changing a line of config. The catch is that "drop-in upgrade" does not mean "same token math", and if you budget cost or size `max_tokens` by hand, the numbers you tuned for Sonnet 4.6 are now wrong.

## The tokenizer changed under you

Sonnet 5 ships a new tokenizer. The same input text produces roughly 30% more tokens than on Sonnet 4.6. Per-token pricing is unchanged, $3/$15 per million input/output tokens (with an introductory $2/$10 in effect through August 31, 2026), but 30% more tokens for identical text means the cost of an equivalent request goes up even though the rate card did not.

Three things you measure in tokens all shift:

- **Per-request cost.** Any estimate derived from a Sonnet 4.6 token count is now low.
- **`max_tokens` budgets.** An output limit sized close to your expected response can truncate on Sonnet 5, because the same reply spends more tokens.
- **Context capacity in text terms.** The window is 1M tokens, but each token covers less text on average, so the same window holds less prose.

Do not extrapolate. Recount against the model with the count-tokens endpoint before you trust any budget:

```bash
curl https://api.anthropic.com/v1/messages/count_tokens \
  --header "x-api-key: $ANTHROPIC_API_KEY" \
  --header "anthropic-version: 2023-06-01" \
  --header "content-type: application/json" \
  --data '{
    "model": "claude-sonnet-5",
    "messages": [{ "role": "user", "content": "Summarize this build log." }]
  }'
```

Run the same payload against `claude-sonnet-4-6` and compare `input_tokens`. That delta is your budget correction.

## Three API behaviors that now 400

If you call Sonnet 5 directly, three requests that worked on Sonnet 4.6 now return `400`:

- **Sampling parameters.** Setting `temperature`, `top_p`, or `top_k` to a non-default value is rejected. Remove them and steer with the system prompt instead.
- **Manual extended thinking.** `thinking: {"type": "enabled", "budget_tokens": N}` is gone. Use adaptive thinking, which is on by default.
- **Assistant prefill.** Still unsupported, unchanged from Sonnet 4.6.

## What it means inside Claude Code

Sonnet 5 requires Claude Code v2.1.197 or later; run `claude update` if `sonnet` still resolves to 4.6. On the Anthropic API it always runs with the native 1M context window, with no `[1m]` suffix and no usage credits, and sessions auto-compact at about 967K tokens. If you need a hard 200K cap for cost control, set `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`. And if you want to control exactly when your team moves versions, pin the full ID rather than riding the alias:

```json
{
  "model": "claude-sonnet-5"
}
```

The migration itself is genuinely a one-line model-ID swap. The work is in the budgets around it. Full details are in the [Sonnet 5 release notes](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5).
