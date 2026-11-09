---
title: "How to Add or Change a Tool Mid-Conversation Without Invalidating the Claude Prompt Cache"
description: "Stop editing the tools array between turns. Append a role: system message with tool_addition and tool_removal blocks (beta inline-tools-2026-09-15) so a Claude agent gains, loses or re-versions tools while the cached prefix and preserved thinking stay valid. Placement rules, defer_loading, schema changes, error codes and model support."
pubDate: 2026-11-09
template: "how-to"
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "prompt-caching"
  - "tool-use"
---

**Short answer:** leave the request's `tools` array exactly as you sent it on turn one, and append a `role: "system"` message whose `content` holds `tool_addition` or `tool_removal` blocks. A `tool_addition` either names a tool already declared in `tools` (`{"type": "tool_reference", "name": ...}`) or carries a full definition (`{"type": "tool_definition", "definition": {...}}`). Because nothing before the new message changes, the cached prefix still hits and only the appended message is billed as fresh input. Defining a tool by value needs the `inline-tools-2026-09-15` beta header; it works on `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-4-8` and the Fable/Mythos 5.x models, but not on Claude Sonnet 5. The Python below uses plain dicts with the `anthropic` SDK's `client.beta.messages.create`; it was written against the documentation and was not executed for this post.

## Why editing `tools` throws away the whole cache

Prompt caching hashes the request in a fixed order: `tools`, then `system`, then `messages`. The [prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) spell out the consequence: "Changes at each level invalidate that level and all subsequent levels." The `tools` array is the first level, so touching it, even to append one harmless tool at the end, invalidates every cached token in the conversation. The [tool use with prompt caching table](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching) lists "Modifying tool definitions" as invalidating the "Entire cache (tools, system, messages)".

For a one-shot chat that barely matters. For an agent loop it is expensive. A coding agent forty turns into a task might be carrying 300k tokens of history. If it unlocks a `deploy` tool after the tests pass, the naive implementation (rebuild `tools`, resend) turns the next request from a cache read into a full cache write of all 300k tokens. If you have been [measuring your cache hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/), this shows up as a single request where `cache_read_input_tokens` drops to zero and `cache_creation_input_tokens` jumps to roughly the whole prompt.

There is a second, newer cost. On the 5.5 model family, thinking blocks are bound to the exact prefix they were produced under. The [preserved thinking docs](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking) list "Add, remove, rename, or edit a tool in `tools`" as an invalid edit. On accounts created on or after August 31, 2026, replaying those blocks after a `tools` edit returns a 400 (`Invalid signature in thinking block. The block is bound to a different conversation.`), which the [5.5 migration guide](/2026/10/migrate-a-coding-agent-from-claude-sonnet-4-6-and-opus-4-7-to-the-5-5-model-family/) covers in detail. So editing `tools` mid-session is no longer just slow; on new accounts it breaks the loop.

## The append-only alternative: system messages with tool blocks

Since the [mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages) beta, `messages` can contain entries with `role: "system"`. Their `content` array accepts `text` blocks (changed instructions), `tool_addition` blocks and `tool_removal` blocks, mixed freely. The docs put the benefit plainly: "The `tools` array itself never changes, so the cached prefix stays intact."

Two beta headers are involved, and they cover different things:

| Header | What it allows | Where |
|---|---|---|
| `mid-conversation-tool-changes-2026-07-01` | Add or remove tools **by reference** (the tool must already be declared in `tools`) | Claude API, Amazon Bedrock, Claude Platform on AWS, both Google Cloud variants |
| `inline-tools-2026-09-15` | Everything above, plus **define a tool by value** inside the block | Claude API, Claude Platform on AWS, Claude Models on Google Cloud (Anthropic managed) |

The inline header shipped on September 22, 2026 according to the [release notes](https://platform.claude.com/docs/en/release-notes/overview), and it supersedes the July one: you do not need to send both. If you run on Bedrock, you are limited to reference-only changes, which shapes the design below.

## Pattern 1: declare up front, unlock later with a reference

The docs recommend this as the default: "A tool you know about at the first request belongs in `tools`, with `defer_loading: true` and a later `tool_addition` reference if you don't want to offer it to the model yet." A deferred tool is part of the request but is not rendered into the prompt prefix, and it is not offered to the model until a `tool_addition` surfaces it.

Here is an agent that can read and test code from the start, but only gets `deploy` once its own test run passes:

```python
# Python 3.14, anthropic 2.6.0
# beta mid-conversation-tool-changes-2026-07-01, model claude-opus-5-5
import anthropic

client = anthropic.Anthropic()
BETAS = ["mid-conversation-tool-changes-2026-07-01"]

TOOLS = [
    {
        "name": "read_file",
        "description": "Read a UTF-8 file from the repository.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "run_tests",
        "description": "Run the test suite and return the summary.",
        "input_schema": {"type": "object", "properties": {}},
        "cache_control": {"type": "ephemeral"},  # cache the tool prefix
    },
    {
        "name": "deploy",
        "description": "Deploy the current commit to staging.",
        "input_schema": {
            "type": "object",
            "properties": {"commit": {"type": "string"}},
            "required": ["commit"],
        },
        "defer_loading": True,  # declared, not offered yet
    },
]

def call(messages):
    return client.beta.messages.create(
        model="claude-opus-5-5",
        max_tokens=16000,
        betas=BETAS,
        tools=TOOLS,  # identical on every request
        messages=messages,
    )
```

Note that the deferred `deploy` entry does not carry `cache_control`; the docs say "A deferred definition can't carry `cache_control`." The breakpoint sits on the last non-deferred tool instead.

When the loop sees a passing test result, it appends the `tool_result` user turn as usual and then a system message that unlocks `deploy`:

```python
# after executing run_tests for tool_use id `tu.id`
messages.append({
    "role": "user",
    "content": [{
        "type": "tool_result",
        "tool_use_id": tu.id,
        "content": "412 passed, 0 failed",
    }],
})

if tests_passed:
    messages.append({
        "role": "system",
        "content": [
            {"type": "text",
             "text": "Tests are green. You may now deploy the current commit to staging."},
            {"type": "tool_addition",
             "tool": {"type": "tool_reference", "name": "deploy"}},
        ],
    })

response = call(messages)
```

Everything before the new system message is byte-identical to the previous request, so the cache read covers the tools, the original system prompt and every earlier turn. The response can now contain an ordinary `tool_use` block named `deploy`, which you execute and answer with a `tool_result` like any other tool.

Taking a tool away is the mirror image. Say the agent should stop reading files once it moves into a summarization phase:

```python
messages.append({
    "role": "system",
    "content": [{
        "type": "tool_removal",
        "tool": {"type": "tool_reference", "name": "read_file"},
    }],
})
```

`tool_removal` always takes a reference, and a removed tool can be offered again later with another `tool_addition` reference. Earlier `tool_use` and `tool_result` blocks for the removed tool stay in history untouched; you are changing what the model may call from this point on, not rewriting what it already did.

This pattern is also the right shape when you have a large catalog and want to [cut down how many MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/): declare the whole catalog with `defer_loading: true`, offer a handful at first, and surface more with references as the task moves on.

## Pattern 2: define a tool by value when you could not know it up front

Sometimes the tool genuinely does not exist at the first request. A user connects a new data source mid-session, or your harness generates a tool from a schema it just discovered. With `inline-tools-2026-09-15`, the `tool_addition` block carries the definition itself:

```python
# Python 3.14, anthropic 2.6.0
# beta inline-tools-2026-09-15, model claude-sonnet-5-5
BETAS = ["inline-tools-2026-09-15"]

messages.append({
    "role": "system",
    "content": [{
        "type": "tool_addition",
        "tool": {
            "type": "tool_definition",
            "definition": {
                "name": "db_query",
                "description": "Run a read-only SQL query against the analytics database.",
                "input_schema": {
                    "type": "object",
                    "properties": {"sql": {"type": "string"}},
                    "required": ["sql"],
                },
            },
        },
    }],
})

response = client.beta.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=16000,
    betas=BETAS,
    tools=TOOLS,      # still the turn-one array
    messages=messages,
)
```

The `definition` is a normal `tools` entry "with its usual configuration, including `cache_control` and `defer_loading`." You can put `cache_control` either on the `tool_addition` block or inside the definition, not both, and it counts toward the request's breakpoint limit. Since the new message is the tail of the prompt, the simplest approach is to keep your usual rolling breakpoint on the last block of the latest turn, as described in [caching multi-turn Claude conversations](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/).

With the MCP connector's `mcp-client-2026-09-15` header added alongside, the definition can also be a whole MCP toolset:

```json
{
  "role": "system",
  "content": [{
    "type": "tool_addition",
    "tool": {
      "type": "tool_definition",
      "definition": {"type": "mcp_toolset", "mcp_server_name": "calendar"}
    }
  }]
}
```

The docs still steer you toward Pattern 1 where possible: "Define by value only what is unknown at the first request or changes later." A tool declared up front is part of the cached prefix from the very first request; one defined by value is paid for as new input the turn it appears.

## Changing a tool's schema without a cache miss

The same mechanism handles the case that used to force a full re-cache most often: the tool exists, but its schema has to change. Maybe `db_query` gains an optional `limit` parameter, or you want to move a server tool to a newer dated version. Send a new definition under the same name:

```python
messages.append({
    "role": "system",
    "content": [{
        "type": "tool_addition",
        "tool": {
            "type": "tool_definition",
            "definition": {
                "name": "db_query",
                "description": "Run a read-only SQL query. Results are capped at `limit` rows.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "sql": {"type": "string"},
                        "limit": {"type": "integer", "default": 500},
                    },
                    "required": ["sql"],
                },
            },
        },
    }],
})
```

Per the docs, "The new definition replaces the earlier one from that position onward." Earlier `tool_use` blocks that were valid under the old schema remain in history as they were. Re-sending an identical definition is a no-op, so a harness that blindly re-adds on every turn is wasteful but not wrong. Since the schema is the contract the model codes against (the argument made in [why JSON schemas matter more than prompts for tool calling](/2026/10/what-is-tool-calling-and-why-json-schemas-matter-more-than-prompts/)), pairing the schema change with a short `text` block explaining what changed helps the model stop producing the old shape.

One rule applies to dated server tools: "If a server tool you define by value requires its own beta header, send that header on every later request in the conversation." Dropping it a few turns later breaks the request even though the tool was added long ago.

## Where the system message is allowed to go

Placement is the part that produces most 400s. From the documented limitations:

- A system message with content cannot be the first entry in `messages`. Use the top-level `system` field for turn one.
- It must immediately follow a `user` turn (including one that only carries `tool_result` blocks) or an `assistant` turn ending in a server tool result, and it must precede an `assistant` turn or end the array.
- It cannot sit between a `tool_use` and its `tool_result`. In a loop, that means: append the tool results first, then the system message, then call the API. Inserting the change right after the assistant's `tool_use` turn is the classic mistake.
- `tool_addition` and `tool_removal` are not accepted directly after a paused `assistant` turn that ends in a server tool result, even though `text` blocks are. If you are continuing a `pause_turn`, resume first and make the tool change on the next user turn.

A small helper keeps loops honest:

```python
def append_tool_change(messages, blocks):
    last = messages[-1]
    if last["role"] != "user":
        raise ValueError("tool changes must follow a user turn (send tool_results first)")
    messages.append({"role": "system", "content": blocks})
```

If two changes happen in the same step, put both blocks in one system message rather than appending two consecutive system messages.

## Error codes worth handling

All of these come back as 400 `invalid_request_error`, with a machine-readable code in `error.details.error_code` on the Claude API:

- `tool_reference_unresolved`: a `tool_reference` names something not declared in `tools`. Either declare it up front with `defer_loading: true`, or switch to a by-value definition with the inline header.
- `tool_name_conflict`: a by-value definition reuses a name already held by a tool of a different type. A newer version of the same tool type does not count as a conflict.
- `available_tools_limit_exceeded`: more than 10,000 deferred tools, more than 10,000 tools defined after the first user message, or more than 4 MB (4,194,304 bytes) of tool definitions added after the first user message or of rendered tool text.

Some tool types cannot be defined inside a message yet; the computer use tool is the documented example, and it returns a 400 that says so. Declare those in `tools` and add them by reference.

## Gotchas that still cost a cache miss

**A `tools` array with no non-deferred tool.** If every tool is deferred (or `tools` is empty), "the first tool it defines by value changes the start of the rendered prompt, which costs one full cache miss on that request." A tool search tool counts as non-deferred, so a catalog fronted by tool search is fine. Otherwise, keep at least one ordinary tool declared up front.

**Forced `tool_choice` on newer models.** You cannot force the model to immediately call the tool you just added with `tool_choice: {"type": "tool", ...}` on `claude-opus-5-5`: the `any` and `tool` types return 400 there. Changing `tool_choice` is cheap for the cache (it only affects the messages level) and is outside the thinking prefix check, but on 5.5 models the steering has to come from the accompanying `text` block.

**Compaction.** If you compact history between turns, the tool changes you appended earlier are inside the summarized span. Re-apply the current tool state after the compacted block (a single system message with the active additions), or the model loses access to tools it was relying on. The [on-demand compaction walkthrough](/2026/11/how-to-keep-a-long-claude-agent-loop-under-the-context-limit-with-on-demand-compaction/) covers where to cut so the rest of the loop stays valid.

**Unsupported models.** The feature is in beta on Claude Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5.5, Opus 4.8, Opus 5, Sonnet 5.5 and Haiku 5.5. It is explicitly not available on Claude Sonnet 5, and older models such as `claude-opus-4-7` and `claude-sonnet-4-6` are not listed. A harness that routes between models needs a fallback path (editing `tools` and accepting the miss) for anything outside that list.

**Bedrock.** Only the reference-only header is listed for Amazon Bedrock, so by-value definitions are out. Pattern 1 works there; Pattern 2 does not.

## How to confirm it worked

Log `usage` on the request right after a tool change and compare it with the request before:

```python
u = response.usage
print("read", u.cache_read_input_tokens,
      "write", u.cache_creation_input_tokens,
      "fresh", u.input_tokens)
```

With the append-only approach, `cache_read_input_tokens` should be close to the previous request's total prompt size, and `input_tokens` plus `cache_creation_input_tokens` should be roughly the size of the last assistant turn, the tool results and the new system message. If `cache_read_input_tokens` collapses to zero right after a tool change, something before the tail changed: usually the `tools` array was rebuilt (a different key order or a regenerated description string counts) or a beta header was dropped.

The underlying rule is the same one that governs every cache-friendly agent: treat the request prefix as append-only. Tools used to be the one thing you could not change without breaking that rule. With `tool_addition` and `tool_removal` you can.

## Sources

- [Mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages) (tool changes, placement rules, limits, error codes)
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Tool use with prompt caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)
- [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
- [Claude Platform release notes](https://platform.claude.com/docs/en/release-notes/overview) (July 24 and September 22, 2026 entries)
