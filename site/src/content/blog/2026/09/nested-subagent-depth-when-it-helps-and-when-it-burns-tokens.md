---
title: "Nested Subagent Hierarchies: When Delegation Depth Helps and When It Just Burns Tokens"
description: "The cold start of a subagent is not what costs you money. Measured across 117 real Claude Code subagent transcripts, startup context was 0.6% to 18% of each agent's total spend. Depth is expensive because every layer runs its own agentic loop and hands the layer above a summary instead of evidence. Here is the compression test that tells you which layer to delete."
pubDate: 2026-09-05
tags:
  - "ai-agents"
  - "claude-code"
  - "subagents"
  - "llm"
  - "cursor"
---

The standard argument against nesting subagents is that every child pays for a fresh context window, so a three-layer tree costs three context windows. That argument is wrong, and the numbers are not close. Across 117 subagent transcripts from real Claude Code 2.1.246 and 2.1.247 runs on my machine, the startup context accounted for between 0.6% and 17.8% of what each subagent eventually cost, with a median under 8%. Delegation depth is genuinely expensive, but the bill comes from somewhere else: each extra layer is another agentic loop that runs 50 to 100 turns of its own, and each hop upward replaces evidence with a summary. The rule that follows from that is simple. A layer earns its place only if it returns dramatically fewer tokens than it consumed. If it returns roughly what it was given, it is a pass-through, and you should delete it.

## The cold start is not where the money goes

Claude Code writes a separate transcript per subagent at `.claude/projects/<project>/<sessionId>/subagents/agent-<agentId>.jsonl`, and every assistant line carries the raw `usage` block from the API. That makes the cost of a delegation tree directly measurable rather than a matter of opinion.

Here are eight subagents from two fan-outs, all running `claude-opus-5`, priced at the [published Opus 5 rates](https://platform.claude.com/docs/en/about-claude/pricing) of $5 per million input tokens, $6.25 per million 5-minute cache writes, $0.50 per million cache reads, and $25 per million output tokens:

| Startup tokens | Cache write | Cache read | Requests | Final context | Startup cost | Total cost | Startup share |
|---|---|---|---|---|---|---|---|
| 21,817 | 21,815 | 0 | 116 | 195,911 | $0.136 | $9.15 | 1.5% |
| 21,310 | 6,896 | 14,412 | 59 | 78,515 | $0.050 | $2.63 | 1.9% |
| 21,877 | 7,463 | 14,412 | 98 | 206,548 | $0.054 | $9.55 | 0.6% |
| 32,194 | 32,192 | 0 | 51 | 81,512 | $0.201 | $3.94 | 5.1% |
| 32,327 | 7,380 | 24,945 | 47 | 81,124 | $0.059 | $3.03 | 1.9% |
| 32,369 | 7,422 | 24,945 | 50 | 84,597 | $0.059 | $4.32 | 1.4% |
| 32,297 | 7,350 | 24,945 | 68 | 105,411 | $0.058 | $6.18 | 0.9% |
| 32,245 | 7,298 | 24,945 | 49 | 78,727 | $0.058 | $3.75 | 1.5% |

The bottom five are one fan-out of five sibling agents. Together they cost $21.22, of which the cold starts were $0.435, or 2.0%. Look at the first column against the last one: an agent that started with 21,817 tokens of context finished its 116th request holding 195,911. It grew its own context by a factor of nine while working. That growth, not the seed, is the bill.

## Why one agent starts at 21k and another at 200k

The other 109 transcripts in the sample started between 184,338 and 213,919 tokens, an order of magnitude above the cluster in the table, and several of them came from the same repository on the same day. Depth had nothing to do with it. The [subagent documentation](https://code.claude.com/docs/en/sub-agents) explains the split: a subagent's startup context is its own system prompt, the delegation message, the full `CLAUDE.md` hierarchy, a git status snapshot, and the full text of any skills named in its `skills` field, except that the built-in Explore and Plan agents skip the `CLAUDE.md` hierarchy and the git snapshot entirely. The 21k agents were Explore agents. The 200k agents were custom implementation agents in a repository with a deep `CLAUDE.md` hierarchy, a wide MCP tool surface, and a long skill roster.

So cold start is a function of the agent definition, not of tree depth, and you control it directly:

```yaml
---
# .claude/agents/verifier.md, Claude Code 2.1.219+
name: verifier
description: Confirms or refutes a single review finding against the source
tools: Read, Grep, Glob
model: sonnet
maxTurns: 8
---

Confirm or refute exactly one finding. Return a verdict, the file and line
that proves it, and nothing else.
```

Narrow `tools` shrinks the schema block. `maxTurns` caps the loop, which is where the real money is. Picking `sonnet` for a leaf that only reads files halves the input rate against Opus 5 and gives a much cheaper output rate.

There is also a discount that most cost models miss. In the five-agent fan-out above, the first sibling paid 32,192 tokens of cache writes and read nothing. The next four each wrote only about 7,350 tokens and read 24,945 from cache. The stable prefix, the harness system prompt and tool schemas, is shared, so sibling two onward cost $0.058 against the first agent's $0.201, about 29%. Breadth at one depth is cheap. That is a real argument for wide, shallow trees over narrow, deep ones, but note that the discount applies to the seed only, and the seed is the 2%.

## What depth actually multiplies

Three things, none of them the cold start.

**Turns.** Every layer you add is a full agentic loop. The agents in the table ran 47 to 116 API requests each. A layer-2 agent is not a function call, it is another 50-turn conversation with its own tool results accumulating in its own context. Two layers of five is not ten cold starts, it is ten loops.

**Output tokens, paid repeatedly.** A leaf discovers something and writes it as output. That output becomes a tool result in its parent's context, so the parent pays for it as input. The parent then re-encodes it into its own report, paying output rates again, and the root pays for that as input a third time. Output is priced at five times input on every current Claude model, so each hop upward re-bills the same finding at the most expensive rate on the sheet. Depth `n` means the same sentence is generated `n` times.

**Wall clock.** Breadth is parallel up to the concurrency cap. Depth is serial by construction: the middle layer cannot summarize until its children finish. Anthropic's own [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) puts the aggregate number on this, reporting that agents use roughly 4 times the tokens of a chat interaction and multi-agent systems roughly 15 times, and concludes that the architecture only pays for tasks valuable enough to justify it.

There is a fourth cost that does not appear on any invoice. The root sees the leaf's work through the middle layer's compression, and it cannot interrogate the leaf about what got dropped. Anthropic's research on [patterns and problems in multiagent systems](https://www.anthropic.com/research/multiagent-systems) found agents failing to surface unshared critical facts during group deliberation, with scores far below what the same models reach solo. Every hop is a chance to lose the one detail that mattered.

## The compression test

Put those together and you get a single question to ask of any layer in a tree:

> Does this layer return substantially fewer tokens than it consumed?

Define the ratio as the tokens the layer's final report contributes to its parent, divided by the tokens the layer consumed producing it. A layer with a ratio near 1 is a pass-through: it paid a loop's worth of tokens to move a string. A layer with a ratio of 0.01, an agent that reads 40 files and returns 12 lines of verdict, has earned its place, because those 40 files never enter the parent's context.

The test also tells you when the compression is the problem rather than the point. If the root needs the leaf's output verbatim, an exact stack trace, a diff to apply, the precise wording of an error, then a compressing layer between them is actively destructive. Flatten it. Depth is for evidence you want summarized, not for artifacts you want intact.

## Where a second layer earns its keep

Four shapes pass the test consistently.

**Unknown fan-out width.** The root cannot fan out over findings it has not discovered yet. A reviewer subagent reads the diff, produces `N` findings, and only then spawns `N` verifiers. Depth 2 exists because `N` is discovered at layer 1, not because the tree looks nicer. This is exactly the shape the depth-3 default was chosen for when [nesting reopened in Claude Code 2.1.219](/2026/07/claude-code-2-1-219-nested-subagents-three-layers-deep/).

**Context that would otherwise overflow.** A reviewer that must read 40 files cannot hold them and still reason. Delegating the reads keeps 40 file bodies out of its window and brings back 40 verdicts.

**Untrusted content.** Anthropic's guidance on [context engineering for agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) makes the security case: a subagent can absorb untrusted text and return structured facts, so the raw content never reaches the orchestrator that holds your credentials and write permissions. The compression here is the containment.

**Different permissions or a different working tree.** A leaf that needs `isolation: worktree`, a stricter `permissionMode`, or a narrower tool allowlist than its parent has a structural reason to exist that has nothing to do with tokens.

```json
// Fan out only after the count is known. Claude Code 2.1.219+
{
  "env": {
    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "2",
    "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "8"
  }
}
```

Setting the depth to `2` rather than the default `3` is a useful default for review and research trees. It permits discover-then-verify and forbids the accidental third layer that nobody designed.

## Three trees that waste money

**The pass-through router.** A middle agent whose prompt is "figure out which specialist should handle this and delegate to it" spends a full cold start and two summarization hops to forward a string. Routing is a decision, not a workload. Make it in the root, or make it a skill.

**Fanning out under a known count.** If the root already has the list of six files, spawning one agent that spawns six is strictly worse than the root spawning six. Same leaves, one extra loop, one extra summarization pass, and a serialization point that costs you the parallelism. Flatten it.

**Depth as an alias for sequencing.** "Analyze, then implement, then test" is a pipeline, not a hierarchy. Running the tester as a child of the implementer buries the test output inside the implementer's report. Run them as siblings at one depth and let the root sequence them, which also keeps the failing test output readable instead of paraphrased. The distinction between delegating for isolation and delegating for scheduling is the same one that separates [a subtask from a fork from a background agent](/2026/08/subtask-vs-fork-vs-background-agent-in-claude-code/).

Owain Lewis's [experiment with nested subagents](https://newsletter.aiengineer.co/p/i-tested-nested-subagents-in-claude) reached about thirty levels before he cancelled the run, and landed on the same practical ceiling: an orchestrator, workers, and specialized sub-workers, and past three levels "it stops making sense".

## Measuring your own tree

Do not estimate. The transcripts have the numbers. This prints startup and total output for every subagent of every session:

```bash
# Claude Code 2.1.246+, requires jq
for f in ~/.claude/projects/*/*/subagents/agent-*.jsonl; do
  jq -s --arg f "$(basename "$f")" '
    [ .[] | .message.usage | select(. != null) ] as $u
    | { agent: $f,
        startup_input: ($u[0] | .input_tokens
                              + .cache_creation_input_tokens
                              + .cache_read_input_tokens),
        cache_write: $u[0].cache_creation_input_tokens,
        cache_read:  $u[0].cache_read_input_tokens,
        requests:    ($u | length),
        output_total: ([$u[] | .output_tokens] | add) }' "$f"
done
```

An agent with a high `requests` count and a small `output_total` is compressing well. An agent with a large `output_total` relative to what it was asked to find is a candidate for `maxTurns` or for deletion.

For a fleet rather than one session, Claude Code's [OpenTelemetry export](https://code.claude.com/docs/en/monitoring-usage) already carries the attribution. Both `claude_code.token.usage` and `claude_code.cost.usage` are tagged with `query_source`, which is `main`, `subagent`, or `auxiliary`, and with `agent.name`:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```

Group `claude_code.cost.usage` by `agent.name` and you get the per-agent-type spend of your whole tree without parsing a single JSONL file. Note that user-defined agent names are reported as `custom`, so name the ones you want to track by using distinct built-ins or by correlating on `session.id`.

## The caps that stop you before your budget does

Depth 3 has been the default since 2.1.219, set through `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, and at the limit the `Agent` tool is simply withheld from the child. Twenty concurrent subagents is the default ceiling, above which spawns queue rather than fail, and the [hard caps introduced in 2.1.213](/2026/07/claude-code-2-1-213-caps-runaway-subagent-fleets/) added the per-session limits of 200 subagent spawns and 200 web searches on top. Dynamic workflows carry their own `workflowSizeGuideline`, defaulting to medium, which aims at fewer than 15 agents per workflow.

If your tree runs in Cursor instead, the ceiling is lower and it is not configurable in the same way: a subagent spawned by another subagent cannot spawn further, which caps you at two effective levels, as covered in the comparison of [Cursor subagents against Claude Code subagents](/2026/07/cursor-subagents-vs-claude-code-subagents/). Design for depth 2 and both harnesses will run your tree unchanged.

The number to keep in your head is the one from the table: the cold start is single-digit percent. Stop optimizing it. Ask instead what each layer compresses, delete the layers that compress nothing, cap the loops with `maxTurns`, and put the cheap model on the leaves.

## Related

- [Subtask vs Fork vs Background Agent in Claude Code](/2026/08/subtask-vs-fork-vs-background-agent-in-claude-code/) covers the primitive you should reach for before you think about depth at all.
- [Claude Code Skills vs Subagents vs MCP Servers](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/) answers the question one level up: whether a subagent is the right shape in the first place.
- [Claude Code 2.1.219 Reopens Nested Subagents, Three Layers Deep](/2026/07/claude-code-2-1-219-nested-subagents-three-layers-deep/) has the history behind the depth default and the settings key that overrides it.
- If your cold starts look more like the 200k cluster than the 21k one, [structuring a monorepo so Claude Code's context stays small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/) is the fix, because that number is your `CLAUDE.md` hierarchy.
- The sibling cache discount is the same mechanism described in [prompt caching on Claude Sonnet 4.6 vs Claude Opus 4.7](/2026/06/prompt-caching-on-claude-sonnet-4-6-vs-claude-opus-4-7-when-it-pays-off/).

## Sources

- [Create custom subagents](https://code.claude.com/docs/en/sub-agents), Claude Code documentation, for the startup context list, the spawn depth and concurrency defaults, and the frontmatter reference.
- [Monitoring usage](https://code.claude.com/docs/en/monitoring-usage), Claude Code documentation, for the `query_source` and `agent.name` attributes on the token and cost metrics.
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing), Anthropic, for the Opus 5 and Sonnet 5 token and cache multipliers used in the cost table.
- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), Anthropic Engineering, for the 4x and 15x token multiples and the subagent scaling guidance.
- [Patterns and problems in multiagent systems](https://www.anthropic.com/research/multiagent-systems), Anthropic Research, for the information-loss failure modes in coordinated agent groups.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), Anthropic Engineering, for the isolation-and-distillation argument.
