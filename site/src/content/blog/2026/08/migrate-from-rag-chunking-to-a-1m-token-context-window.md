---
title: "Migrate an Agent from Chunking-and-RAG to a 1M-Token Context Window"
description: "The 1M-token context window is now the default on Claude Opus 5, Opus 4.8/4.7/4.6, Sonnet 5, and Sonnet 4.6, with no beta header and no long-context premium. Here is when deleting the vector store actually pays off, the 10x cache-read rule that decides it, the ~30% tokenizer inflation that breaks your sizing estimate, and the seven-step migration with a verification line on each one."
pubDate: 2026-08-12
updatedDate: 2026-08-12
template: migration
tags:
  - "migration"
  - "llm"
  - "ai-agents"
  - "rag"
  - "prompt-caching"
  - "anthropic-sdk"
---

For most of the last three years, "put the whole corpus in the prompt" was a thought experiment. It is not anymore. Per the [context windows documentation](https://platform.claude.com/docs/en/build-with-claude/context-windows), Claude Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5, and Sonnet 4.6 all have a 1M-token context window on the Claude API, Bedrock, Google Cloud, and Microsoft Foundry, and the docs are explicit that "1M is the default: you don't need a beta header, and long-context requests are billed at standard pricing." The [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) says the same thing in blunter terms: a 900k-token request is billed at the same per-token rate as a 9k-token request.

So the question is no longer whether you can skip retrieval. It is whether you should. The short answer: migrate if your corpus fits under roughly 10x what your retriever currently returns per query, because that is exactly where a cached prefix costs the same as top-k retrieval. Below that line you delete a chunker, an embedding pipeline, a vector store, and a reranker for free. Above it you are paying real money to hand the model a haystack. Budget a day for the migration and keep the retriever behind a feature flag for two weeks, because the thing that breaks is almost never the code.

## The 10x rule that actually decides this

Everything hinges on one number from the [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) pricing table: a cache read costs **0.1x** the base input rate. Retrieved chunks can never benefit from that, because the retrieved set is query-dependent, so the prefix differs on every request and you bill at the full 1.0x.

Set the two paths equal. If `C` is your whole corpus in tokens and `R` is what your retriever puts in the prompt per query:

```
0.1 x C = 1.0 x R   ->   C = 10R
```

A typical top-20 retrieval over 1,000-token chunks is `R = 20,000`, which puts the break-even corpus at **200,000 tokens**. Concretely, on `claude-sonnet-5` at $2/MTok base input:

| Path | Tokens billed per request | Rate | Cost per request |
| ---- | ------------------------- | ---- | ---------------- |
| RAG, top-20 x 1k chunks | 20,000 at 1.0x | $2 / MTok | $0.040 |
| Cached 200k corpus | 200,000 at 0.1x | $0.20 / MTok | $0.040 |
| Cached 800k corpus | 800,000 at 0.1x | $0.20 / MTok | $0.160 |
| Uncached 800k corpus | 800,000 at 1.0x | $2 / MTok | $1.600 |

Two things fall out of that table. First, at 800k the cached path is 4x the retrieval path and the *uncached* path is 40x, which is why a migration that forgets the cache breakpoint reads as a 40x cost regression on the invoice. Second, the cache write is a separate fixed cost: a 1-hour write bills at 2x base, so writing an 800k prefix on Sonnet 5 costs `800,000 x $4/MTok = $3.20`. That amortizes to nothing at a thousand requests an hour and dominates the bill at five.

Cache reads refresh the TTL at no charge, so a steadily-used prefix is written once. A bursty one is written on every cold start: 24 cold starts a day on an 800k prefix is $76.80/day, about $2,300/month, purely in cache writes. Measure your traffic shape before you assume the write is free.

## Why migrate at all

- **You delete a tuning surface you do not want to own.** Anthropic's [contextual retrieval evaluation](https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide) puts naive dense-vector RAG at 87.15% Pass@10 and a contextual-embeddings plus reranking pipeline at 95.26%, a 47% reduction in retrieval failures. That 8-point gap is your team's ongoing job. Long context has no Pass@10, because there is no retrieval step to miss.
- **Chunk boundaries stop losing facts.** A retriever cannot return a fact that spans two chunks. This is the failure mode that shows up as "the answer is definitely in the docs and it still got it wrong."
- **Index freshness stops being a subsystem.** No re-embedding job, no staleness window, no partial reindex after a bad deploy.
- **The cost becomes predictable.** Standard pricing across the full window plus a 0.1x cache read means per-request cost is a multiplication, not a function of how many chunks the reranker decided to keep.

## What breaks

| Area | Change | Severity |
| ---- | ------ | -------- |
| Token accounting | Claude 4.7 and later use a newer tokenizer that emits roughly 30% more tokens for the same text | high |
| Cost model | Per-request cost now scales with corpus size, not with query complexity | high |
| Cache strategy | The corpus must be a byte-stable prefix; any edit anywhere invalidates the whole thing | high |
| Provenance | You lose the retrieval scores and chunk IDs your vector store gave you for citations | medium |
| Recall | Accuracy degrades with input length (context rot), and distractors make it worse | medium |
| Latency | Time-to-first-token scales with the uncached portion of the prefix | medium |
| Output cap | Models with a 1M window cap `max_tokens` at 128k | low |
| Attachments | 600 images or PDF pages per request on 1M models, 100 on 200k models | low |

The tokenizer row is the one that catches people. The pricing docs note that Claude 4.7 and later models use a newer tokenizer producing about 30% more tokens for the same text, while Sonnet 4.6 and earlier use the previous one. A corpus you measured at 780k tokens against Sonnet 4.6 is roughly 1.01M against Opus 5, and it no longer fits. In text terms, Opus 5's 1M window holds about as much prose as a 770k window did on the old tokenizer.

## Pre-flight checklist

- **Measure the corpus in bytes first.** Do not guess.
- **Pick the target model and confirm the minimum cacheable prefix.** It is 512 tokens on Opus 5, 1,024 on Opus 4.8 / Sonnet 5 / Sonnet 4.6, 2,048 on Opus 4.7, and 4,096 on Opus 4.6 and Haiku 4.5. Below the minimum, caching silently does not happen and no error is returned.
- **Keep your RAG evaluation set.** The migration is only defensible if you can show the long-context path does not regress against it.
- **Confirm nothing per-request lives in `tools` or `system`.** The cache hierarchy is `tools` then `system` then `messages`, and a change at any level invalidates that level and everything after it.

## Migration steps

1. **Size the corpus against the real budget.** Walk the source tree, sum the bytes, and divide by a conservative characters-per-token figure. The docs use roughly 4 characters per token for English, but markdown with embedded code is denser, so 3.5 is a safer floor and 3.1 approximates the 4.7+ tokenizer.

   ```python
   # sizing gate, run before you write any migration code
   import os
   ROOT, SKIP = "docs", {".git", "node_modules"}
   total = 0
   for dirpath, dirnames, filenames in os.walk(ROOT):
       dirnames[:] = [d for d in dirnames if d not in SKIP]
       for f in filenames:
           if f.endswith((".md", ".mdx", ".txt")):
               total += os.path.getsize(os.path.join(dirpath, f))
   for divisor, label in ((4.0, "4.0 c/tok"), (3.5, "3.5 c/tok"), (3.1, "4.7+ tokenizer")):
       print(f"~{round(total / divisor):>9,} tokens @ {label}")
   ```

   **Verify:** the 3.1 figure must land under 900k, leaving headroom for the system prompt, tool schemas, and the turn itself. Run it on this site's own content and the answer is instructive: all 723 English posts are 7.16 MB, about 1.88M tokens at 4 c/tok and 2.44M at 3.1, so the whole blog does not fit and never will. The 158 posts carrying a coding-agents tag are 1.70 MB, about 446k at 4 c/tok and 575k at 3.1. That subset fits comfortably. **If the whole corpus does not fit, partition it before you conclude the migration is impossible.**

2. **Freeze the corpus into one deterministic prefix.** Sort the file list explicitly. Directory-walk order is not stable across machines or filesystems, and an unstable prefix means a permanent cache miss that you will only notice on the invoice.

   ```python
   # deterministic corpus assembly, Python 3.12+
   parts = []
   for path in sorted(paths):                       # sorted() is the load-bearing call
       with open(path, encoding="utf-8") as fh:
           parts.append(f"<doc path=\"{path}\">\n{fh.read()}\n</doc>")
   corpus = "\n\n".join(parts)
   ```

   **Verify:** build the corpus twice in separate processes and assert the SHA-256 digests match.

3. **Put the corpus behind a cache breakpoint, ahead of the query.** Place `cache_control` on the last block whose prefix is identical across requests, which is the corpus block, not the user turn.

   ```python
   # anthropic-sdk-python, claude-sonnet-5, 1M context window, August 2026
   response = client.messages.create(
       model="claude-sonnet-5",
       max_tokens=4096,
       system=[
           {"type": "text", "text": INSTRUCTIONS},
           {
               "type": "text",
               "text": corpus,
               "cache_control": {"type": "ephemeral", "ttl": "1h"},
           },
       ],
       messages=[{"role": "user", "content": question}],
   )
   ```

   **Verify:** on the second identical call, `response.usage.cache_read_input_tokens` must be roughly the corpus size and `cache_creation_input_tokens` must be 0. If both are 0, caching did not engage and you are on the 40x path.

4. **Stop mutating the prefix.** Strip timestamps, request IDs, per-user preambles, and anything else that varies. If per-request context is genuinely needed, it goes after the breakpoint, never inside it.

   **Verify:** log `cache_read_input_tokens / (cache_read_input_tokens + input_tokens)` per request and confirm the hit rate holds above 0.95 over a real traffic sample. The same measurement approach is covered in detail in [adding prompt caching to an Anthropic SDK app](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/).

5. **Re-run the retrieval evaluation set against the long-context path.** Same questions, same graders, both pipelines, side by side. Pay particular attention to questions whose answer is buried in the middle of the corpus, because that is where the degradation lives.

   **Verify:** long-context accuracy is at or above the RAG baseline on your own set. A vendor benchmark is not a substitute here.

6. **Add a context guard for the agent loop.** A single-shot question-answering call is bounded, but an agent that accumulates tool results on top of an 800k prefix will hit the ceiling. Server-side [compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) summarizes older turns automatically.

   ```python
   # beta header compact-2026-01-12, supported on Opus 5 / 4.8 / 4.7 / 4.6, Sonnet 5 / 4.6
   response = client.beta.messages.create(
       betas=["compact-2026-01-12"],
       model="claude-opus-5",
       max_tokens=4096,
       messages=messages,
       context_management={
           "edits": [
               {"type": "compact_20260112", "trigger": {"type": "input_tokens", "value": 700_000}}
           ]
       },
   )
   ```

   **Verify:** drive a synthetic session past the trigger and confirm a `compaction` block appears in the response, then confirm the next request succeeds instead of returning a 400 `invalid_request_error`.

7. **Decommission the vector store behind a flag, not with a delete.** Route a percentage of traffic to the long-context path, hold the retriever warm, and only tear down the embedding pipeline once the flag has been at 100% for two weeks.

   **Verify:** flip the flag off in staging and confirm the RAG path still answers correctly. If it does not, your rollback does not exist.

## Verification checklist

Run all of these before you call the migration done:

- Second identical request reports a non-zero `cache_read_input_tokens`.
- `count_tokens` on a full request returns under 900k for the largest expected input.
- Evaluation-set accuracy is at or above the RAG baseline, including mid-corpus questions.
- p50 and p95 latency measured on cache hits, not on the cold write.
- A week of billing data shows the cost per request you predicted, within 10%.
- Compaction fires and the session survives it.
- The rollback flag has been exercised at least once.

## Rollback plan

This migration is reversible for exactly as long as your index is fresh. Keep the ingestion and embedding jobs running for two weeks after cutover, even though nothing reads their output. The moment you stop them, rollback stops being a flag flip and becomes a full reindex, which on a large corpus is hours of work under exactly the kind of pressure that makes you do it badly. Write the shutdown date in the ticket.

## Gotchas

**The cache invalidation hierarchy will bite you before the token count does.** Changes to `tools` invalidate everything. Toggling web search or citations invalidates system and message caches. Even the speed setting invalidates system and messages. If your agent builds its tool list dynamically per request, your 800k prefix is being written from scratch every single time and you will not notice until the invoice arrives.

**The 20-block lookback.** You get up to 4 cache breakpoints, and the lookback window is 20 content blocks. A growing conversation that pushes 20+ blocks past the last cache write needs a second explicit breakpoint or you silently start missing.

**Context rot is measured, not folklore.** Chroma's [context rot study](https://www.trychroma.com/research/context-rot) evaluated 18 models across roughly 194,480 needle-in-a-haystack calls and found that performance varies significantly with input length even on trivial tasks. Two findings matter for this migration specifically: low needle-question similarity degrades much faster than high similarity, and a *single* distractor measurably reduces accuracy, with four compounding it. A corpus full of near-duplicate documents is the worst possible input, which is a reason to deduplicate before you paste rather than after you regret it. Anthropic makes the same point in [effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), framing attention as a finite budget and recommending you "find the smallest set of high-signal tokens that maximize the likelihood of your desired outcome."

**Data residency multiplies the whole bill.** On Claude 4.6 and later, `inference_geo: "us"` applies a 1.1x multiplier to every pricing category including cache reads. On a 200k cached prefix that is invisible; on 800k across a million requests it is not.

**Do not reach for tool-result clearing as your first context guard.** The `clear_tool_uses_20250919` strategy invalidates cached prefixes when it fires. If you use it, set `clear_at_least` so it clears a meaningful chunk each time rather than re-writing your cache on every marginal trim. Agent loops that thrash on this look exactly like [Claude Code's autocompact thrashing](/2026/07/fix-claude-code-autocompact-thrashing-on-large-file-or-tool-output/) does.

**"It fits" is not the same as "it is the right answer."** The honest end state for most teams is hybrid: retrieve a generous 100k to 200k tokens instead of a stingy 20k, cache what is stable, and let the model reason across the result. That is a much cheaper migration than either extreme, and it keeps the provenance you get from a retriever.

## Related

- [How to add retrieval-augmented generation to a Claude Code session](/2026/05/how-to-add-retrieval-augmented-generation-to-a-claude-code-session/) is the mirror image of this post, and worth reading first if you are not certain your corpus has outgrown agentic grep.
- [Prompt caching on Claude Sonnet 4.6 vs Claude Opus 4.7: when it pays off](/2026/06/prompt-caching-on-claude-sonnet-4-6-vs-claude-opus-4-7-when-it-pays-off/) works through the write-versus-read arithmetic that step 3 depends on.
- [How to cache multi-turn Claude conversations across API calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/) covers the breakpoint placement problem once the conversation itself starts growing past the corpus.
- [How to structure a monorepo so Claude Code's context stays small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/) is the partitioning exercise from step 1, applied to source trees instead of documents.
- [Fix: context window exceeded during an Aider refactor](/2026/05/fix-context-window-exceeded-during-an-aider-refactor/) is what step 6 exists to prevent.

## Sources

- [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows) on the Claude platform docs, for the 1M model list, the no-beta-header default, the 128k output cap, and the 600-page attachment limit.
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing), for per-model rates, the long-context section, the cache multipliers, and the tokenizer note on Claude 4.7 and later.
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), for minimum cacheable lengths, the 4-breakpoint and 20-block limits, TTL refresh behaviour, and the invalidation hierarchy.
- [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) and [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing), for the `compact-2026-01-12` and `context-management-2025-06-27` beta headers and their parameters.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), Anthropic Engineering, for the attention-budget framing.
- [Context Rot: How Increasing Input Tokens Impacts LLM Performance](https://www.trychroma.com/research/context-rot), Chroma Research, for the 18-model evaluation and the distractor and needle-similarity findings.
- Corpus figures were measured against this repository's own content on August 12, 2026. Character-per-token divisors are estimates; confirm against the [token counting API](https://platform.claude.com/docs/en/build-with-claude/token-counting) before committing to a budget.
