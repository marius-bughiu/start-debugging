---
title: "How to Measure an Agent's Fixed Token Overhead Before the First User Token"
description: "Every agent request pays for its system prompt, the provider's hidden tool-use preamble, and every tool schema before the user says anything. How to measure that fixed cost with differential count_tokens calls on the Anthropic API, the input_tokens endpoint on OpenAI, an MCP listTools probe, and /context in Claude Code, anchored to claude-opus-5-5, claude-sonnet-5, and @modelcontextprotocol/client 2.1.0."
pubDate: 2026-09-28
template: how-to
tags:
  - "llm"
  - "ai-agents"
  - "mcp"
  - "claude-code"
  - "anthropic-sdk"
  - "openai-sdk"
  - "token-counting"
  - "context-window"
---

**Short answer:** do not estimate the overhead from string lengths. Ask the provider. On the Anthropic API, call `POST /v1/messages/count_tokens` twice: once with your real `system` and `tools` plus a one-character user message, once with only that one-character message. The difference is your fixed overhead, and it already includes the hidden tool-use system prompt the API injects whenever `tools` is non-empty (286 tokens on `claude-opus-5-5`, 354 on `claude-sonnet-5` with `tool_choice: auto`). Then count each tool alone to see which schemas are expensive. On OpenAI, `client.responses.inputTokens.count()` does the same job. For MCP servers, list the tools with an MCP client and feed them through the same counter. In Claude Code, where you do not own the system prompt, run `/context`.

Versions used in this post: `@anthropic-ai/sdk` 0.128.0, `openai` 7.23.0, `@modelcontextprotocol/client` 2.1.0, `@modelcontextprotocol/server-filesystem` 2026.8.31, Node 26.4.0, and Claude Code 2.1.x. Model IDs: `claude-opus-5-5`, `claude-sonnet-5`, and `gpt-5.4`. The MCP listing numbers below come from a real run of the script. The token figures I quote are the vendors' own published numbers; I did not have an API key in the environment where I verified the code, so run the script yourself to get your counts.

## Why the fixed part is the number that matters

An agent loop sends the same prefix on every turn: system prompt, tool definitions, then the conversation. The conversation grows and gets compacted, but the prefix is paid on turn one of every session, on every subagent you spawn, and on every retry. If the prefix is 20,000 tokens and a subagent does three turns of real work at 2,000 tokens each, the prefix is sent three times and makes up over 80% of the input that subagent pays for.

Prompt caching softens the price but not the size. Cached reads are cheap, yet the tokens still occupy the context window, still count toward the point where compaction kicks in, and still get written to the cache at a premium on the first request of each session. Tool-selection quality also degrades as the tool list grows, which is a separate cost that no discount fixes.

The frustrating part is that the fixed overhead is mostly invisible. You wrote the system prompt, so you can see it. You did not write the provider's tool-use preamble, you rarely read the JSON schemas an MCP server hands you, and in a hosted agent like Claude Code you do not see the system prompt at all. So you measure.

## What goes into the prefix

On the Anthropic Messages API, the [tool use pricing section](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview#pricing) lists three sources of tool tokens: the `tools` parameter itself (names, descriptions, schemas), `tool_use` blocks, and `tool_result` blocks. Only the first is fixed. On top of that, "the API also automatically includes a special system prompt for the model that enables tool use", and its size depends on the model and on `tool_choice`:

| Model | `auto` / `none` | `any` / `tool` |
| --- | --- | --- |
| Claude Opus 5.5 | 286 | not listed |
| Claude Opus 5 | 286 | 406 |
| Claude Sonnet 5 | 354 | 474 |
| Claude Opus 4.7 | 675 | 804 |
| Claude Sonnet 4.6 | 497 | 589 |
| Claude Haiku 4.5 | 496 | 588 |

Two details in that table bite people. First, forcing a tool with `tool_choice: {"type": "any"}` or a named tool costs 120 more tokens per request on Sonnet 5, on every turn. Second, the preamble only appears when at least one tool is present. A "tool-less" planning call and a tool-enabled executor call on the same model have different fixed costs even with an identical system prompt.

So the fixed overhead on the API is:

```text
fixed = system prompt + tool-use preamble (per model, per tool_choice) + sum(tool definitions) + message framing
```

And the tokenizer matters. Per the [token counting docs](https://platform.claude.com/docs/en/build-with-claude/token-counting), Claude Opus 4.7 and later use a tokenizer that produces "approximately 30 percent more tokens" for the same text. A tool catalogue you measured on Sonnet 4.6 is not the size it is on Sonnet 5. Always count with the model ID you ship. I covered the tokenizer change in more detail in [the Sonnet 5 token budget post](/2026/07/claude-sonnet-5-claude-code-default-new-tokenizer-token-budgets/).

## Differential counting on the Anthropic API

The [count_tokens endpoint](https://platform.claude.com/docs/en/api/messages/count_tokens) accepts the same body as `messages.create`, minus `max_tokens`, and returns `{ "input_tokens": N }`. It is free, rate-limited separately from message creation (5,000 requests per minute on the Start tier), and supports client tools. That makes it a measuring instrument, not just a pre-flight check.

The trick is to never read an absolute number in isolation. Count a baseline, add one thing, count again, subtract. Everything that is constant between the two calls, including framing tokens you cannot see, cancels out.

```ts
// overhead.mjs
// @anthropic-ai/sdk 0.128.0, Node 26.4.0, model claude-sonnet-5
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

const client = new Anthropic();
const MODEL = process.env.MODEL ?? "claude-sonnet-5";

const system = readFileSync("./system-prompt.md", "utf8");
const tools = JSON.parse(readFileSync("./tools.json", "utf8"));
const probe = [{ role: "user", content: "x" }];

async function count(body) {
  const r = await client.messages.countTokens({ model: MODEL, messages: probe, ...body });
  return r.input_tokens;
}

const bare = await count({});
const withSystem = await count({ system });
const withAll = await count({ system, tools });

console.log(`model                 ${MODEL}`);
console.log(`system prompt         ${withSystem - bare}`);
console.log(`tools + preamble      ${withAll - withSystem}`);
console.log(`fixed overhead        ${withAll - bare}`);

// Per-tool cost: each tool alone, minus the single-tool preamble.
// Count one trivial tool to isolate the preamble for this model.
const tiny = { name: "t", description: "", input_schema: { type: "object", properties: {} } };
const preambleAndTiny = (await count({ tools: [tiny] })) - bare;

const rows = [];
for (const tool of tools) {
  const alone = (await count({ tools: [tool] })) - bare;
  rows.push({ name: tool.name, tokens: alone - preambleAndTiny });
}
rows.sort((a, b) => b.tokens - a.tokens);
console.table(rows);
console.log(`sum of per-tool       ${rows.reduce((s, r) => s + r.tokens, 0)}`);
```

Run it with `ANTHROPIC_API_KEY` set:

```bash
node overhead.mjs
```

Three things to check in the output:

1. **`tools + preamble` minus the sum of per-tool costs** should land close to the preamble value in the table above (354 for Sonnet 5), plus the few tokens of the tiny probe tool. If it is far off, a tool in your list is not being serialized the way you think. The usual culprit is an SDK helper that adds `$schema`, `additionalProperties`, or `title` fields when it converts a Zod or Pydantic model.
2. **The top three rows of the per-tool table.** In practice the distribution is lopsided: one tool with a giant `enum`, a nested `oneOf`, or a description that doubles as documentation will outweigh ten simple tools. That is where to cut.
3. **The ratio of `fixed overhead` to your median turn size.** If the fixed part is larger than a typical user turn plus tool result, trimming it is the single cheapest optimization you have.

Swap `MODEL` to compare. Running the same script with `MODEL=claude-opus-5-5` and `MODEL=claude-sonnet-5` is the fastest way to see how much of a model switch is tokenizer and how much is preamble.

## Confirm the estimate against real usage

The docs are explicit that the count "is an **estimate**" and "may include tokens added automatically by Anthropic for system optimizations", which you are not billed for. So close the loop once with a real request and read `usage`:

```ts
// @anthropic-ai/sdk 0.128.0, model claude-sonnet-5
const msg = await client.messages.create({
  model: MODEL,
  max_tokens: 1,
  system,
  tools,
  messages: probe,
});
const u = msg.usage;
const billedInput =
  u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
console.log({ billedInput, ...u });
```

The important part is the sum. When prompt caching is active, `input_tokens` only covers the uncached tail, so a cached 18,000-token prefix will show up as `input_tokens: 4` and `cache_read_input_tokens: 18000`. People regularly "discover" that their overhead vanished after turning on caching, when it only moved to a different field. With `max_tokens: 1` the probe costs you the input plus one output token.

Note that `count_tokens` ignores `cache_control` entirely: the FAQ on the token counting page says caching "only occurs during actual message creation". Use it for size, use real `usage` for price.

## The same measurement on OpenAI

OpenAI's Responses API has an equivalent endpoint, `POST /v1/responses/input_tokens`, exposed in the Node SDK as `client.responses.inputTokens.count()`. The [token counting guide](https://developers.openai.com/api/docs/guides/token-counting) makes the same argument I am making here: local tokenizers miss formatting tokens, and "tools and schemas add tokens that are hard to count locally".

```ts
// openai 7.23.0, Node 26.4.0, model gpt-5.4
import OpenAI from "openai";

const openai = new OpenAI();
const MODEL = "gpt-5.4";

// Responses API function tools use "parameters", not "input_schema".
const oaTools = tools.map((t) => ({
  type: "function",
  name: t.name,
  description: t.description,
  parameters: t.input_schema,
}));

const count = async (body) =>
  (await openai.responses.inputTokens.count({ model: MODEL, input: "x", ...body })).input_tokens;

const bare = await count({});
const full = await count({ instructions: system, tools: oaTools });
console.log(`fixed overhead on ${MODEL}: ${full - bare}`);
```

Keep the comparison honest: the same tool catalogue will not cost the same on two providers because the tokenizer, the hidden preamble, and the schema serialization all differ. Measure on the provider you actually call.

## Measuring an MCP server before you connect it

MCP servers are the biggest source of surprise overhead because you never write their schemas. The fix is to treat `tools/list` as data. Connect with an MCP client, list the tools, convert them to the provider's tool shape, and run them through the counter above.

```ts
// list-mcp-tools.mjs
// @modelcontextprotocol/client 2.1.0, Node 26.4.0
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFileSync } from "node:fs";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", process.argv[2]],
});
const client = new Client({ name: "overhead-probe", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

// MCP "inputSchema" maps 1:1 to Anthropic "input_schema".
const asAnthropic = tools.map((t) => ({
  name: t.name,
  description: t.description ?? "",
  input_schema: t.inputSchema,
}));
writeFileSync("./tools.json", JSON.stringify(asAnthropic, null, 2));

for (const t of asAnthropic) {
  console.log(t.name.padEnd(28), JSON.stringify(t).length, "chars");
}
```

Against the reference filesystem server this lists 14 tools totalling 7,986 characters of compact JSON, ranging from 401 characters for `list_allowed_directories` to 837 for `read_text_file`. That is one small, well-written server. Then point `overhead.mjs` at the generated `tools.json` to turn characters into tokens for your model. For servers that need auth, swap in `StreamableHTTPClientTransport` with the same headers your agent uses, because some servers return a different tool list per scope.

Two caveats. `listTools()` is paginated, so for large servers loop on `nextCursor` until it is empty. And the count is an upper bound for agents that defer MCP schemas: if your runtime uses tool search, only the names load up front and full schemas arrive on demand. [Reducing the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/) covers `defer_loading` and `ENABLE_TOOL_SEARCH`, which is what you reach for once this measurement tells you the catalogue is too big.

## Claude Code: you do not own the prompt, so use /context

In Claude Code you cannot call `count_tokens` on the real request because you never see it. The built-in answer is `/context`, which the [context window docs](https://code.claude.com/docs/en/context-window) describe as "a live breakdown by category with optimization suggestions, including which CLAUDE.md and auto memory files loaded". Run it as the very first thing in a fresh session, before you type a prompt, and you have your fixed overhead broken down by source: system prompt, built-in tools, MCP tools, custom agents, memory files, and skills.

The docs' own simulation gives a feel for the scale of a default session: roughly 4,200 tokens of system prompt, 680 for auto memory, 280 for environment info, 120 for deferred MCP tool names, 450 for skill descriptions, 320 for `~/.claude/CLAUDE.md`, and 1,800 for a project `CLAUDE.md`. Your numbers will differ, and the categories that move the most are the ones you control: CLAUDE.md files, skills, and MCP servers whose schemas are loaded up front.

To track the number over time rather than eyeballing it, use print mode, which reports usage for the whole run:

```bash
# Claude Code 2.1.x
claude -p "x" --output-format json | jq '.usage'
```

Add `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens` from that object, the same way as on the API. Run it in CI on the main branch and fail the build when the number jumps by more than a threshold you pick. That catches the day someone adds a 600-line CLAUDE.md or a new MCP server to `.mcp.json` without anyone noticing. For the pieces that are hardest to see, [/skill-doctor](/2026/09/claude-code-2-1-261-skill-doctor-finds-skills-that-only-cost-context/) reports which skill listings cost context without ever being used, and [the monorepo context post](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/) covers splitting CLAUDE.md so it loads on demand.

## Gotchas that skew the measurement

- **Server tools cannot be counted.** `count_tokens` returns `invalid_request_error` for web search, web fetch, code execution, tool search, and the MCP connector (the advisor tool is the exception). For those, the only source of truth is `usage` on a real `messages.create` call.
- **`tool_choice` changes the preamble.** Measure with the `tool_choice` you use in production. An agent that forces the first call with `{"type": "any"}` and then relaxes to `auto` pays two different fixed costs within the same session.
- **Thinking blocks are not fixed overhead, but they can look like it.** Whether previous-turn thinking counts toward input depends on the model's preservation behavior, so measure overhead on a single-turn probe, never on turn five of a real transcript.
- **Tool order and cache prefixes.** Tools render before the system prompt in the cache prefix, so reordering or conditionally adding tools changes the prefix and forces a cache write. If your fixed overhead is fine but your bill is not, check whether the tool list is stable across requests. [Claude Code's cache-miss diagnostics](/2026/09/claude-code-now-names-the-likely-cause-of-a-prompt-cache-miss/) is a good example of how often this is the cause.
- **Don't budget with characters divided by four.** It is off by a lot for JSON schemas, which are full of punctuation and short keys, and it ignores the preamble completely. Characters are fine for ranking tools against each other, as in the MCP script above, and useless for absolute numbers.
- **Rate limits during a sweep.** Counting each of 200 tools individually is 200 requests. That is well within the free tier limits, but run it with a small concurrency cap rather than `Promise.all` over everything.

## Related

- [How to reduce the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/)
- [Claude Sonnet 5's new tokenizer and what it does to token budgets](/2026/07/claude-sonnet-5-claude-code-default-new-tokenizer-token-budgets/)
- [Finding skills that only cost context with /skill-doctor](/2026/09/claude-code-2-1-261-skill-doctor-finds-skills-that-only-cost-context/)
- [When prompt caching actually pays off on Sonnet 4.6 and Opus 4.7](/2026/06/prompt-caching-on-claude-sonnet-4-6-vs-claude-opus-4-7-when-it-pays-off/)
- [Keeping Claude Code's context small in a monorepo](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/)

## Sources

- [Anthropic: Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)
- [Anthropic API reference: Count message tokens](https://platform.claude.com/docs/en/api/messages/count_tokens)
- [Anthropic: Tool use overview, pricing and tool-use system prompt tokens](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview#pricing)
- [OpenAI: Counting tokens](https://developers.openai.com/api/docs/guides/token-counting)
- [OpenAI API reference: Get input token counts](https://developers.openai.com/api/reference/python/resources/responses/subresources/input_tokens/methods/count)
- [Claude Code: Explore the context window](https://code.claude.com/docs/en/context-window)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
