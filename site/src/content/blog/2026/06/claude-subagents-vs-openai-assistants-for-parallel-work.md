---
title: "Claude Subagents vs OpenAI Assistants for Parallel Work in 2026"
description: "Claude subagents give you orchestration-level parallelism out of the box: one agent spawns isolated sub-contexts that run concurrently. OpenAI Assistants never had that, and it shuts down August 26, 2026, so new parallel work belongs on the Responses API plus your own fan-out. Here is how the two models actually differ and which to reach for."
pubDate: 2026-06-10
template: vs
tags:
  - "comparison"
  - "ai-agents"
  - "claude-code"
  - "llm"
  - "subagents"
  - "anthropic-sdk"
  - "openai-sdk"
---

If you are choosing a way to run parallelizable LLM work in mid-2026, the first thing to know is that "OpenAI Assistants" is no longer a choice you should make. The Assistants API beta was deprecated on August 26, 2025 and shuts down for good on **August 26, 2026**, after which calls to `/v1/assistants`, `/v1/threads`, and `/v1/runs` fail outright. The replacement is the Responses API plus the Conversations API. So the real question this post answers is: how does Claude's subagent model compare to the way you parallelize work on OpenAI today, and which one fits your problem? The short version: **Claude subagents are an orchestration primitive (one agent spawns isolated agents that run concurrently and report back), while OpenAI gives you request-level parallelism (you fan out N independent calls and build the orchestration yourself). Pick Claude subagents when you want the orchestration handed to you; pick the OpenAI Responses API plus a fan-out when you want a thin, stateless layer you control end to end.**

Everything below is pinned to versions current as of June 10, 2026: Claude Code 2.1.x and the Claude Agent SDK running `claude-opus-4-8`, `claude-sonnet-4-6`, and `claude-haiku-4-5`; the OpenAI Responses API as the supported successor to the Assistants beta. Where a claim depends on a price or a hard limit, the number is in the code comment.

## The two things people mean by "parallel"

The comparison gets muddy because "parallelisable work" hides two very different shapes, and the two products sit on opposite sides of the line.

**Orchestration-level parallelism** is when a single agent decides, mid-task, to spin up several independent workers, hand each a slice of the problem, let them run at the same time in separate contexts, and then synthesize their results. The agent owns the fan-out. This is what a Claude subagent is.

**Request-level parallelism** is when *you* already know the work decomposes into N independent units, so you fire N API calls concurrently from your own code and collect the answers. The model is stateless; your code owns the fan-out. This is what you do with OpenAI, and it is also available on Anthropic's API.

The old Assistants API was neither of these. It was a managed conversation loop: you created an assistant, attached a thread, started a run, and polled the run until tools were called or the answer came back. It had no notion of one assistant spawning others. The only parallelism it offered was parallel *tool calls* inside a single run. That limitation is part of why the Responses API exists, and part of why the comparison people reach for ("Claude subagents vs OpenAI Assistants") is really "agent-spawns-agents vs you-fan-out-yourself."

## What a Claude subagent actually is

A subagent in Claude Code is a separate Claude instance with its own context window, its own system prompt, its own tool allowlist, and its own model. The main agent delegates a self-contained task to it; the subagent does the noisy work (reading dozens of files, running a test suite, fetching docs) in its own context and returns only a summary. The verbose output never touches the main conversation. You define one as a Markdown file with YAML frontmatter under `.claude/agents/`:

```markdown
<!-- .claude/agents/api-researcher.md -->
<!-- Claude Code 2.1.x -->
---
name: api-researcher
description: Investigates one API module in isolation. Use proactively for parallel research across independent areas.
tools: Read, Grep, Glob
model: haiku
---

You research a single module. Read only what you need, then return a
tight summary: public surface, key dependencies, and any risk you spotted.
Do not modify files.
```

The `model: haiku` line is the lever that makes parallelism affordable. Each subagent burns tokens independently, so three concurrent subagents on Opus cost roughly 3x a sequential Opus pass. Routing read-only research to `claude-haiku-4-5` while the orchestrator stays on `claude-opus-4-8` is how you keep a wide fan-out cheap. This is the same context-isolation idea behind [a Claude Code subagent that runs your browser tests](/2026/05/how-to-write-a-claude-code-subagent-that-runs-browser-tests/): the test output stays in the subagent, the verdict comes back.

To actually run them in parallel, you ask for it. Claude Code uses subagents conservatively by default, so the prompt has to be explicit:

```text
Research the authentication, database, and API modules in parallel using
separate subagents, then tell me which one has the riskiest change surface.
```

Each subagent explores its area concurrently, then the main agent synthesizes. Foreground subagents block the main conversation; background subagents run while you keep working and auto-deny anything that would otherwise prompt for permission. Two limits matter for parallel design: **subagents cannot spawn other subagents** (no infinite nesting), and when many subagents each return a detailed result, those results all land back in your main context, so a wide fan-out with verbose returns can itself blow the context budget. For sustained, large-scale parallelism you reach for agent teams instead, where each worker keeps its own independent context.

The same model is available programmatically through the Claude Agent SDK, which is what you would wire into CI or a [scheduled, dynamic multi-agent workflow](/2026/05/claude-code-dynamic-workflows-opus-4-8/). The subagent definitions are identical; only the launcher changes.

## How you parallelize on OpenAI today

OpenAI has no subagent primitive. There is no "this agent spawns those agents" construct in the Responses API. What you get instead are three request-level tools, and you compose them yourself.

**Parallel tool calls inside one response.** The Responses API expects parallel tool calls by default. If the model decides a turn needs three independent tool calls, it emits all three at once and you execute them concurrently. This is genuinely useful, but it is parallelism *within a single reasoning turn*, not multiple agents. (Worth knowing: developers have reported the Responses API being more reluctant to emit parallel tool calls than the older Chat Completions endpoint for the same prompt, so test it against your actual workload rather than assuming.)

**Concurrent responses you orchestrate.** When work decomposes cleanly, you fire independent `responses.create` calls and gather them. In Python this is just `asyncio`:

```python
# openai-python >= 1.x, Responses API, June 2026
import asyncio
from openai import AsyncOpenAI

client = AsyncOpenAI()
modules = ["auth", "database", "api"]

async def research(module: str) -> str:
    resp = await client.responses.create(
        model="gpt-5.1",
        input=f"Summarize the risk surface of the {module} module.",
        parallel_tool_calls=True,
    )
    return resp.output_text

async def main():
    # You own the fan-out, the concurrency cap, and the synthesis step.
    summaries = await asyncio.gather(*(research(m) for m in modules))
    print(summaries)

asyncio.run(main())
```

This is the closest analogue to Claude's "research three modules in parallel," and the difference is exactly the point: with subagents the agent decided to fan out and synthesized for you; here *your code* decided, capped the concurrency, and has to do the synthesis. You get more control and a thinner abstraction, at the cost of writing the orchestrator. The migration from Assistants makes this explicit, mapping `Assistants -> Prompts`, `Threads -> Conversations`, `Runs -> Responses`, and `Run Steps -> Items`, and noting that tool loops are now your responsibility rather than something the run manages for you.

**The Batch API for bulk async.** When the units are independent and you do not need answers in real time, both vendors offer a batch endpoint at a 50% discount on input and output tokens, processed within 24 hours. The capacities differ:

```jsonl
# OpenAI Batch API: up to 50,000 requests / 200 MB per input file, 50% off, <=24h
{"custom_id": "auth",     "method": "POST", "url": "/v1/responses", "body": {"model": "gpt-5.1", "input": "Summarize the auth module."}}
{"custom_id": "database", "method": "POST", "url": "/v1/responses", "body": {"model": "gpt-5.1", "input": "Summarize the database module."}}
```

```python
# Anthropic Message Batches API: up to 10,000 requests / 32 MB per batch, 50% off, <=24h
# anthropic-sdk-python, June 2026
import anthropic

client = anthropic.Anthropic()
batch = client.messages.batches.create(requests=[
    {"custom_id": "auth",     "params": {"model": "claude-sonnet-4-6", "max_tokens": 512,
        "messages": [{"role": "user", "content": "Summarize the auth module."}]}},
    {"custom_id": "database", "params": {"model": "claude-sonnet-4-6", "max_tokens": 512,
        "messages": [{"role": "user", "content": "Summarize the database module."}]}},
])
print(batch.id)  # poll for completion, then pull results by custom_id
```

For thousands of independent prompts (classify a backlog, summarize every file in a repo, score a test set), the Batch API is the right tool on either platform, and it is orthogonal to the subagent question. Note the ceiling difference: OpenAI takes 50,000 requests and 200 MB per file; Anthropic takes 10,000 requests and 32 MB per batch, so very large jobs need to be split into more batches on the Anthropic side.

## The axis that actually decides it

Strip away the branding and there is one question: **do you want the agent to own the fan-out, or do you want to own it?**

Reach for **Claude subagents** when:

- The decomposition is discovered at runtime, not known up front. The agent reads the problem, decides it splits into three independent investigations, and spawns them. You did not have to enumerate the units.
- You want context isolation for free. Each subagent's noisy work stays out of your main window, which is the same discipline behind [keeping a monorepo's context small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/).
- You want per-worker model and tool scoping declared in one Markdown file, not built in application code.
- The work lives in or near a coding agent (research, refactors, test runs) rather than in a request-response API surface.

Reach for the **OpenAI Responses API plus your own fan-out** (or Anthropic's API the same way) when:

- The units are known and uniform: N documents, N rows, N test cases. You do not need an agent to discover the split; a `for` loop and `asyncio.gather` express it more honestly.
- You need hard control over concurrency, retries, idempotency, and cost ceilings. A subagent that decides to spawn ten workers is harder to bound than a semaphore you wrote.
- You are building a stateless service and do not want a long-lived agent context. The Responses API is deliberately thin: send items, get items back.
- The job is bulk and latency-tolerant, in which case the Batch API beats both interactive paths on price.

A useful tell: if you find yourself writing the words "and then decide whether to split this," you want subagents. If you already know it is "do this exact thing to each of these," you want a fan-out.

## The cost trap on the subagent side

The one place teams get burned is treating subagents as free concurrency. They are not. Three parallel Sonnet subagents cost about three times one Sonnet pass, and because each returns a summary into the parent, a careless fan-out pays twice: once for the subagent's work, once for the tokens its result adds to the orchestrator. Two habits keep this sane. First, route read-only and research subagents to `claude-haiku-4-5` and reserve `claude-opus-4-8` for the orchestrator and for work that genuinely needs the strongest model. Second, lean on [prompt caching across multi-turn calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/) so the shared context a fan-out depends on is not re-billed on every worker. On the OpenAI side the equivalent discipline is a concurrency semaphore and the Batch API, because the failure mode there is hammering your rate limit with an unbounded `gather`, not surprise token spend from an agent that decided to spawn more workers than you expected.

## Where this leaves you in June 2026

Do not start new work on the OpenAI Assistants API. It is on a hard clock and will be gone on August 26, 2026; anything you build there is a migration you are scheduling for yourself. For request-level parallel work on OpenAI, go straight to the Responses API and own the fan-out, or use the Batch API when latency does not matter. If what you actually want is for the agent to decide how to split the work and run the pieces concurrently with isolated contexts, that is the thing Claude subagents give you that the OpenAI surface does not, and it is the reason the comparison is worth making at all. If you are still weighing the harnesses themselves rather than the APIs underneath them, the trade-offs in [how the big coding agents compare](/2026/06/claude-code-vs-cursor-vs-copilot-agent-mode-where-each-wins/) are the next thing to read.

Sources: [Create custom subagents (Claude Code docs)](https://code.claude.com/docs/en/sub-agents), [Subagents in the Agent SDK](https://platform.claude.com/docs/en/agent-sdk/subagents), [Message Batches / batch processing (Claude API docs)](https://platform.claude.com/docs/en/build-with-claude/batch-processing), [Assistants API migration guide (OpenAI)](https://developers.openai.com/api/docs/assistants/migration), [OpenAI API deprecations](https://developers.openai.com/api/docs/deprecations), and [OpenAI function calling / parallel tool calls](https://developers.openai.com/api/docs/guides/function-calling).
