---
title: "Prompt Caching on Claude Sonnet 4.6 vs Opus 4.7: When It Pays Off"
description: "The cache read and write multipliers are identical on both models, so the break-even point is the same. What differs is the minimum cacheable prefix (1,024 vs 4,096 tokens), the per-token dollar savings, and a new Opus 4.7 tokenizer that counts up to 35% more tokens. With claude-sonnet-4-6 and claude-opus-4-7 pricing math."
pubDate: 2026-06-09
tags:
  - "llm"
  - "ai-agents"
  - "prompt-caching"
  - "anthropic-sdk"
---

The instinct when comparing prompt caching across two Claude models is to ask which one caches "better." That framing leads nowhere, because the caching mechanism is identical: on both `claude-sonnet-4-6` and `claude-opus-4-7`, a cache write costs 1.25x base input for the 5-minute TTL or 2x for the 1-hour TTL, and a cache read costs 0.1x base input. Same multipliers, same break-even arithmetic. So the real question is not which model caches better but where the two diverge: the **minimum cacheable prefix** differs by 4x (1,024 tokens on Sonnet 4.6, 4,096 on Opus 4.7), the **absolute dollar savings** scale with the base price, and Opus 4.7 ships a **new tokenizer** that can count up to 35% more tokens for the same text. Those three differences decide whether caching is a free win or a silent no-op on each model.

This post pins everything to the current first-party API pricing (verified against the Anthropic [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) in June 2026) and the prompt caching docs. The model IDs are exact: `claude-sonnet-4-6` (Sonnet 4.6, $3/$15 per MTok) and `claude-opus-4-7` (Opus 4.7, $5/$25 per MTok). If you have not added caching yet, start with the mechanics in [adding prompt caching to an Anthropic SDK app](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/); this post is about the model choice on top of it.

## The multipliers are the same, the break-even is the same

Here is the part that surprises people: the break-even point for caching does not depend on the model. It is a function of the multipliers, which are constant across the lineup.

The relevant prices per million tokens:

| | Base input | 5m cache write | 1h cache write | Cache read | Output |
| --- | --- | --- | --- | --- | --- |
| Sonnet 4.6 | $3.00 | $3.75 (1.25x) | $6.00 (2.0x) | $0.30 (0.1x) | $15.00 |
| Opus 4.7 | $5.00 | $6.25 (1.25x) | $10.00 (2.0x) | $0.50 (0.1x) | $25.00 |

Take a shared prefix reused across `N` requests with the 5-minute TTL. You pay one write at 1.25x, then `N-1` reads at 0.1x each, versus `N` full-price reads with no caching. Caching wins when:

```
1.25 + 0.1 * (N - 1)  <  N
```

Solve it and `N > 1.28`, so `N >= 2`. One write plus one read, the content used twice, already beats paying full price both times. The 1-hour TTL writes at 2x, so:

```
2.0 + 0.1 * (N - 1)  <  N
```

gives `N > 2.11`, so `N >= 3`. That is the official framing on the pricing page: the 5-minute cache pays off after the first cache read, the 1-hour cache after the second. Notice the model never enters the equation. The ratios are identical, so **the 5-minute cache pays off on the second use of a prefix on both Sonnet 4.6 and Opus 4.7**, and the 1-hour cache on the third.

The percentage cost reduction is also model-independent. For a prefix reused across 50 turns of a session with the 5-minute TTL:

```
[1.25 + 0.1 * 49] / 50  =  6.15 / 50  =  0.123
```

That is an 87.7% reduction on the prefix, and you get the same 87.7% on Sonnet 4.6 and on Opus 4.7. If you have a multi-turn agent loop where the system prompt is reused every turn, see [caching multi-turn Claude conversations across API calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/) for the breakpoint placement that makes this hold.

So if break-even and percentage savings are identical, what is there to compare?

## Where they diverge #1: the minimum cacheable prefix

This is the difference that silently burns money. A prompt prefix below a model-specific token threshold **will not cache at all**, even if you mark it with `cache_control`. There is no error. The request just processes at full input price, and `cache_creation_input_tokens` comes back as zero.

The thresholds are not the same:

| Model | Minimum cacheable prefix |
| --- | --- |
| Sonnet 4.6 | 1,024 tokens |
| Opus 4.7 | 4,096 tokens |

That is a 4x gap. A 3,000-token shared prefix, a modest system prompt plus a couple of tool schemas, caches cleanly on Sonnet 4.6 and silently does nothing on Opus 4.7. If you build a caching layer against Sonnet, verify the hit rate, then switch the model string to `claude-opus-4-7`, your cache can quietly stop working and your input bill can jump while every line of code stays the same.

You confirm this with the usage object, not by assuming:

```python
# anthropic 0.42 (Python), claude-opus-4-7 vs claude-sonnet-4-6
resp = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    system=[{
        "type": "text",
        "text": SHARED_PREFIX,            # ~3,000 tokens
        "cache_control": {"type": "ephemeral"},
    }],
    messages=[{"role": "user", "content": "..."}],
)

# On Opus 4.7 with a 3k prefix: both stay 0 (under the 4,096 minimum).
# On Sonnet 4.6 with the same prefix: cache_creation_input_tokens > 0.
print(resp.usage.cache_creation_input_tokens)
print(resp.usage.cache_read_input_tokens)
```

The practical rule: **measure the minimum on the model you actually ship, not the one you prototyped on.** If you are on Opus 4.7 and your shared prefix is in the 1,000-to-4,000-token range, you have three options. Pad the prefix to clear 4,096 (only worth it if the padding is real reused context, not filler). Move more stable content, tool definitions, few-shot examples, a style guide, into the cached prefix until it clears the bar. Or accept that small prefixes do not cache on Opus and do not pay the cognitive cost of pretending they do.

## Where they diverge #2: the tokenizer

The pricing page carries a note that is easy to miss and changes the math: Opus 4.7 and later use a new tokenizer, and it may use **up to 35% more tokens for the same fixed text** than earlier models. Sonnet 4.6 uses the older tokenizer.

This cuts two ways for caching.

It interacts with the minimum-prefix threshold in an almost cruel way. A body of context that tokenizes to 3,000 tokens on Sonnet 4.6 can be up to roughly 4,050 tokens on Opus 4.7. You might hope that pushes you over Opus's 4,096 minimum for free. It does not, quite: 4,050 is still under 4,096, and the multiplier is "up to" 35%, not a guarantee. You cannot rely on the fatter tokenizer to clear the threshold for you. Tokenize on the actual model and check.

It also inflates the absolute cost of everything, cached or not. The same document is more tokens on Opus 4.7, and each token is priced higher. When you are comparing the cost of running the same workload on the two models, the gap is wider than the headline $3-versus-$5 base price suggests, because Opus is charging a higher rate on a higher token count. Count tokens with the API's `count_tokens` endpoint against the specific model rather than reusing a Sonnet estimate; a client-side approximation calibrated on the old tokenizer will undercount Opus 4.7 input.

## Where they diverge #3: the dollars saved per cached token

The percentage savings are identical, but the dollars are not, and dollars are what shows up on the invoice. The saving from caching one input token, compared to paying full base price for it, is `base - read`:

| Model | Base input | Cache read | Saved per cached MTok |
| --- | --- | --- | --- |
| Sonnet 4.6 | $3.00 | $0.30 | $2.70 |
| Opus 4.7 | $5.00 | $0.50 | $4.50 |

Caching saves $4.50 per million cached tokens on Opus 4.7 versus $2.70 on Sonnet 4.6, 67% more dollars for the identical action. Layer the tokenizer on top, because the same source text is more tokens on Opus, and the absolute gap widens further.

Put it in a worked example. Take a shared system prompt and tool catalog that measures 8,000 tokens on Sonnet 4.6, reused across a 50-turn session inside the 5-minute window. On Opus 4.7 the same text runs to roughly 10,800 tokens because of the tokenizer.

Sonnet 4.6, 8,000-token prefix:

```
Uncached: 50 * 8,000 * $3.00/MTok       = $1.200
Cached:   8,000 * $3.75/MTok            = $0.030   (one write)
        + 49 * 8,000 * $0.30/MTok       = $0.118   (49 reads)
        = $0.148  ->  saves ~$1.05
```

Opus 4.7, same source text at ~10,800 tokens:

```
Uncached: 50 * 10,800 * $5.00/MTok      = $2.700
Cached:   10,800 * $6.25/MTok           = $0.068   (one write)
        + 49 * 10,800 * $0.50/MTok      = $0.265   (49 reads)
        = $0.332  ->  saves ~$2.37
```

Both sessions get the same ~88% reduction on the prefix. But the Opus session saves about $2.37 against the Sonnet session's $1.05, more than double the absolute dollars, from the higher base rate and the fatter token count compounding. The conclusion runs against intuition: caching is not "more worth it" on Opus 4.7 as a percentage, it is more worth it in money, which means **the case for caching gets stronger, not weaker, as you move up the model tier.** The cost of forgetting to cache, or of letting a sub-4,096-token prefix silently fall through, is larger on Opus.

## Choosing the TTL, which is also model-independent

The 5-minute versus 1-hour decision is a function of traffic shape, not model. The 1-hour TTL costs 2x to write instead of 1.25x but survives twelve times longer. If your prefix is read at least once every five minutes, the 5-minute cache stays warm on its own refreshes and the cheaper write wins. If your traffic is bursty, with idle gaps longer than five minutes, the 5-minute entry expires and you pay the write cost again on the next request, so the 1-hour TTL pays for itself the moment two reads land inside an hour-long window.

```python
# 1-hour TTL: worth it when reads are sparse but recur within the hour
"cache_control": {"type": "ephemeral", "ttl": "1h"}
```

This logic is identical on Sonnet 4.6 and Opus 4.7. The only model-flavored wrinkle is that on Opus 4.7 the 2x write is a larger absolute number, so a 1-hour write you place and then never read back is a more expensive mistake. Do not set `ttl: "1h"` speculatively on Opus across many distinct prefixes; each unread write is 2x of a higher base.

## What this means in practice

If you are on a long-running agent loop and watching cost, caching is not optional on either model, and the choice between them does not change whether to cache, only how much it saves. The same caching discipline that keeps a [long Sonnet 4.6 agent loop](/2026/05/fix-rate-limit-error-on-claude-sonnet-4-6-in-a-long-agent-loop/) under control applies unchanged on Opus 4.7, with bigger dollar stakes. The three things to actually check when you compare or switch:

1. **Re-verify the cache hit on the target model.** A prefix that cached on Sonnet 4.6 can fall under Opus 4.7's 4,096-token minimum. Read `cache_read_input_tokens` after the switch; do not trust that the breakpoint still fires.
2. **Re-baseline token counts, not just prices.** Opus 4.7's tokenizer can add up to 35% to the same text. A cost model built on Sonnet token counts will be wrong on Opus before you even apply the higher rate.
3. **Expect bigger absolute savings on Opus, and treat unread writes as a bigger waste.** The 0.1x read and 1.25x/2x write multipliers are the same, but every multiplier sits on a higher base.

None of this is about one model caching "better." The cache works the same way on both. What changes is the floor you have to clear to use it, the ruler you measure your prompt with, and the size of the bill you are cutting.

## Sources

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) (base, cache write/read, and the Opus 4.7 tokenizer note)
- [Prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (per-model minimum cacheable prefix, breakpoints, usage fields)
