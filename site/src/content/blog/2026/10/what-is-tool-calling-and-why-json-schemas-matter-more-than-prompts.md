---
title: "What Is Tool Calling and Why JSON Schemas Matter More Than Prompts"
description: "Tool calling is a protocol, not magic: the model emits a structured request matching a JSON Schema you supplied, your code runs it, and the result goes back as a message. The schema and its descriptions are rendered into the model's prompt and, with strict mode, into a decoding grammar, so they shape behaviour more reliably than any system-prompt instruction. Here is how it works on claude-sonnet-5-5 and OpenAI strict mode, with schema patterns that make invalid calls impossible."
pubDate: 2026-10-05
template: how-to
tags:
  - "llm"
  - "ai-agents"
  - "tool-calling"
  - "anthropic-sdk"
  - "json-schema"
  - "structured-outputs"
---

**Short answer:** tool calling (also called function calling) is a protocol in which you send a model a list of tools, each described by a name, a description and a JSON Schema for its arguments. When the model decides it needs one, it stops generating prose and returns a structured request such as `{"name": "get_issue", "input": {"issue_number": 4821}}`. Your code executes it and sends the result back as a message, and the model continues. The model never runs anything itself. The JSON Schema matters more than your prompt for two concrete reasons: the API renders your tool definitions into the model's prompt, so descriptions and enums are the instructions the model reads at the exact moment it chooses a tool, and with strict mode (`strict: true`) the schema is compiled into a grammar that constrains token sampling, so a malformed call is impossible rather than merely discouraged. The examples below use the `anthropic` Python SDK 1.11.0 on Python 3.14 against `claude-sonnet-5-5`, with OpenAI's strict mode for comparison.

## The protocol in four messages

Strip away the frameworks and every tool call is the same four-step exchange. Here it is against the Messages API:

```python
# anthropic 1.11.0, Python 3.14, model claude-sonnet-5-5
import json
import anthropic

client = anthropic.Anthropic()

tools = [{
    "name": "github_get_issue",
    "description": (
        "Fetch a single GitHub issue from the current repository by number. "
        "Returns title, body, labels, state and the 20 most recent comments. "
        "Use this whenever the user refers to an issue by number (for example '#4821'). "
        "Do not use it to search issues by keyword; it only accepts an exact number."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "issue_number": {"type": "integer", "description": "The issue number without the '#'."},
        },
        "required": ["issue_number"],
    },
}]

messages = [{"role": "user", "content": "Summarise #4821 in two sentences."}]

# 1. Request: the tool list travels with every call.
resp = client.messages.create(model="claude-sonnet-5-5", max_tokens=2048,
                              tools=tools, messages=messages)

# 2. The model answers with stop_reason == "tool_use" and a tool_use block.
call = next(b for b in resp.content if b.type == "tool_use")
print(call.name, json.dumps(call.input))   # github_get_issue {"issue_number": 4821}

# 3. Your code runs the tool and returns a tool_result with the same id.
issue = {"title": "Crash on startup", "state": "open", "labels": ["bug"]}  # your lookup here
messages += [
    {"role": "assistant", "content": resp.content},
    {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": call.id, "content": json.dumps(issue)},
    ]},
]

# 4. The model reads the result and continues (answers, or calls another tool).
final = client.messages.create(model="claude-sonnet-5-5", max_tokens=2048,
                               tools=tools, messages=messages)
print(next(b.text for b in final.content if b.type == "text"))
```

Three details in that snippet are the whole mental model:

- **The model only produces a request.** `stop_reason: "tool_use"` means "I am paused, waiting for you". Nothing executed. Anthropic's [overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) calls these client tools; server tools such as `web_search` are the exception, where Anthropic's infrastructure runs the call for you.
- **The tool list is stateless.** You resend `tools` on every request. The API keeps no memory of which tools exist between calls.
- **An agent is this loop in a `while`.** Repeat steps 2 to 4 until `stop_reason` is `end_turn`, and you have built a coding agent. Claude Code, Cursor and Copilot all run this loop with richer tools. If you have read [what the difference between an AI agent and an AI workflow is](/2026/10/what-is-the-difference-between-an-ai-agent-and-an-ai-workflow/), this loop is the "model owns the control flow" half.

OpenAI's Responses API, Gemini and every open-weight model served through vLLM or Ollama use the same shape with different field names (`function_call`, `tool_calls`, `parameters` instead of `input_schema`). MCP sits one layer above it: an [MCP server](/2026/09/what-is-the-model-context-protocol-and-why-every-ide-is-shipping-it/) is a standard way to publish tool definitions so any client can put them in this `tools` array.

## Where your schema actually goes

The reason the schema beats the prompt is mechanical. Anthropic documents it on the [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) page: when you pass `tools`, the API builds a special system prompt that starts with "In this environment you have access to a set of tools", then injects your tool definitions in JSON Schema format, then your own system prompt. OpenAI says the same thing in its [function calling guide](https://developers.openai.com/api/docs/guides/function-calling): definitions are "injected into the system message in a syntax the model has been trained on".

So your schema is not metadata sitting next to the prompt. It *is* prompt, and it is prompt in a format the model was trained on specifically for choosing and filling tool calls. That has consequences:

1. **The description is read at decision time.** When the model is deciding between `github_get_issue` and `github_search_issues`, the text it weighs is the two descriptions, not a paragraph in your system prompt 3,000 tokens earlier. Anthropic calls detailed descriptions "by far the most important factor in tool performance" and recommends at least 3 to 4 sentences per tool, covering what it does, when to use it, when not to, and what it does not return.
2. **Structure is unambiguous where prose is not.** "Labels must be one of bug, feature, question" in a system prompt is a request. `"enum": ["bug", "feature", "question"]` is a type the model has seen millions of times, and in strict mode it is an enforced constraint.
3. **It costs tokens on every request.** Definitions are billed as input tokens on every call. On top of that, Anthropic adds a fixed tool-use system prompt whenever at least one tool is present: 286 tokens on `claude-opus-5-5` and `claude-sonnet-5-5`, 497 on `claude-sonnet-4-6`, 496 on `claude-haiku-4-5` (from the [pricing table](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview#pricing) as of October 2026). This is why [measuring an agent's fixed token overhead](/2026/09/measure-an-agents-fixed-token-overhead-before-the-first-user-token/) and [trimming the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/) are worth doing.

## Without strict mode, the schema is a strong hint

By default the schema guides generation but does not bind it. The model usually produces conforming JSON, but "usually" is the problem in a loop that makes 200 calls a day. Anthropic's own [strict tool use page](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use) lists the failure modes: incompatible types (`"2"` instead of `2`) and omitted required fields. In practice you also see near-miss enum values (`"Bug"` for `"bug"`), invented extra keys, and dates in whatever format the model felt like that turn.

Here is what that looks like against a triage tool's schema, validated client-side with the `jsonschema` package:

```python
# jsonschema 4.x, Python 3.14
from jsonschema import Draft202012Validator

schema = {
    "type": "object",
    "properties": {
        "issue_number": {"type": "integer"},
        "label": {"type": "string", "enum": ["bug", "feature", "question", "duplicate"]},
        "duplicate_of": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
    },
    "required": ["issue_number", "label", "duplicate_of"],
    "additionalProperties": False,
}

validator = Draft202012Validator(schema)
sloppy = {"issue_number": "4821", "label": "Bug"}       # a plausible non-strict call
print([e.message for e in validator.iter_errors(sloppy)])
# ["'4821' is not of type 'integer'",
#  "'Bug' is not one of ['bug', 'feature', 'question', 'duplicate']",
#  "'duplicate_of' is a required property"]
```

Without strict mode you must run that validation yourself on every call, and when it fails, send back a `tool_result` with `is_error: true` and the validation message so the model can retry. That works, but each retry is a full extra round trip with the whole context resent. When the API itself rejects a malformed call, you get errors like the ones in [Tool call arguments did not match schema](/2026/05/fix-tool-call-arguments-did-not-match-schema-in-anthropic-tool-use/) and [Extra inputs are not permitted](/2026/05/fix-extra-inputs-are-not-permitted-on-a-tool-call-with-a-structured-argument/).

## With strict mode, the schema is a grammar

Strict mode changes the mechanism, not just the reliability. With `strict: true`, the API compiles your `input_schema` into a grammar and uses grammar-constrained sampling: at each step, tokens that would make the JSON invalid against the schema are masked out before the model samples. The model cannot emit `"4821"` for an integer field because the opening quote is not a legal next token.

```python
# anthropic 1.11.0, Python 3.14, model claude-sonnet-5-5
triage_tool = {
    "name": "github_label_issue",
    "description": (
        "Apply exactly one triage label to a GitHub issue. Use 'duplicate' only when you "
        "have found the original issue, and pass its number in duplicate_of; otherwise "
        "pass null. Call this once per issue after reading it with github_get_issue."
    ),
    "strict": True,                       # top-level field, next to name and input_schema
    "input_schema": {
        "type": "object",
        "properties": {
            "issue_number": {"type": "integer"},
            "label": {"type": "string", "enum": ["bug", "feature", "question", "duplicate"]},
            "duplicate_of": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
        },
        "required": ["issue_number", "label", "duplicate_of"],
        "additionalProperties": False,    # required on every object in strict mode
    },
}

resp = client.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=2048,
    tools=[tools[0], triage_tool],
    messages=[{"role": "user", "content": "Triage #4821. Use github_label_issue when done."}],
)
```

What strict mode guarantees on Claude: the tool `input` follows `input_schema`, and the tool `name` is always one you provided. What it requires: `additionalProperties: false` on every object, and a schema inside the supported subset. Per the [structured outputs limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations), that subset includes `enum`, `const`, `anyOf`, `allOf`, `$ref`/`$defs` and string formats such as `date` and `uuid`. It excludes recursive schemas, numeric constraints (`minimum`, `maximum`), string length constraints and complex array constraints. Compiled grammars are cached for up to 24 hours since last use, so the first request with a new schema pays a one-time compilation latency.

OpenAI's [strict mode](https://developers.openai.com/api/docs/guides/function-calling) has the same idea with one stricter rule: every property must be listed in `required`, and optional fields are expressed as a union with `null` (`"type": ["string", "null"]`). Writing your schemas that way (all keys required, nullable for "not applicable") makes them portable between both providers, which is why `duplicate_of` above is required and nullable instead of optional.

Strict mode also matters more than it used to. On `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-fable-5-1`, forced tool use (`tool_choice` of `any` or `tool`) now returns a 400. Anthropic's documented replacement is `tool_choice: auto` plus a prompt instruction naming the tool, with `strict: true` keeping the schema-valid-arguments guarantee. Check that a call was actually made, since `auto` does not guarantee one.

## Schema patterns that replace prompt instructions

The useful habit is to look at every rule in your system prompt that talks about tool arguments and ask whether the schema can express it instead. Most can.

**Enums instead of "use one of these values".** Any closed set (labels, environments, sort orders, units) belongs in an `enum`. In strict mode the model physically cannot produce a value outside it.

**Required plus nullable instead of "only include X when Y".** Optional fields invite the model to omit things you needed. Making a field required and nullable forces an explicit decision on every call, which is easier to log and debug.

**Discriminated unions instead of "if mode is A, pass these fields".** A tool with a `mode` string and six optional fields that apply to different modes is a prose contract. An `anyOf` of objects, each with a `const` discriminator, makes the invalid combinations unrepresentable:

```json
{
  "type": "object",
  "properties": {
    "target": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "kind": {"const": "file"},
            "path": {"type": "string"}
          },
          "required": ["kind", "path"],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {"const": "symbol"},
            "name": {"type": "string"},
            "file_hint": {"anyOf": [{"type": "string"}, {"type": "null"}]}
          },
          "required": ["kind", "name", "file_hint"],
          "additionalProperties": false
        }
      ]
    }
  },
  "required": ["target"],
  "additionalProperties": false
}
```

OpenAI's guide phrases the principle as using enums and object structure "to prevent invalid states". It also suggests an "intern test": could someone use this function correctly with only the definition in front of them?

**Formats instead of "dates must be ISO 8601".** `{"type": "string", "format": "date"}` is shorter than the sentence and enforced under strict mode.

**Property descriptions for semantics the type cannot carry.** A type says `integer`, a description says "the issue number without the '#'". Keep the description next to the field it explains, not in the system prompt.

**`input_examples` for format-sensitive or nested inputs.** Claude accepts an optional `input_examples` array on each tool definition. Every example is validated against `input_schema` (an invalid example returns a 400), and each one costs roughly 20 to 50 tokens for a simple shape, 100 to 200 for complex nested objects, per the [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#providing-tool-use-examples) docs. Use them for tools like the union above, where seeing one valid `symbol` target teaches more than another sentence of description.

## What still belongs in the prompt

Schemas constrain the *shape* of a single call. They cannot express policy across calls, and that is where the system prompt still earns its tokens:

- **Ordering and preconditions.** "Read the issue before labelling it" spans two tools. Say it in the tool description (as `github_label_issue` does above) and, if it matters, enforce it in code by rejecting a label call for an issue that was never fetched.
- **When to stop or ask.** Whether to ask the user for a missing value or guess one is behaviour, not shape. Anthropic notes that Opus models are more likely to ask for a missing required parameter, while Sonnet may infer a plausible value.
- **How eagerly to use tools at all.** With `tool_choice: auto`, a line such as "Use the tools to investigate before responding" in the system prompt shifts the call rate. That is the documented lever for under-calling.

Even here, prefer the description over the system prompt when the rule is about one tool. The description is co-located with the thing it governs and travels with the tool if you move it to an MCP server.

## Gotchas

- **Schema validity is not semantic validity.** Strict mode guarantees `issue_number` is an integer, not that issue 4821 exists or that the agent should touch it. Validate business rules and permissions in the tool handler, and return a clear `is_error: true` result when they fail.
- **`max_tokens` and `refusal` can still truncate a call.** A grammar does not help if generation stops mid-object. Check `stop_reason` before executing any tool in a turn.
- **Unsupported keywords are not silently enforced.** `minimum: 1` is outside Claude's strict subset. The Python and TypeScript SDK helpers strip unsupported constraints and validate them client-side; a raw HTTP call does not. Enforce numeric ranges in your handler.
- **Changing tools invalidates the prompt cache.** Tools render first in the cached prefix (`tools`, then `system`, then `messages`). Reordering or editing a definition mid-session forces a full re-read of everything after it, so keep the tool list deterministic.
- **More tools means more confusion, not just more tokens.** OpenAI recommends aiming for fewer than 20 functions available at the start of a turn. Anthropic recommends consolidating related operations into one tool with an `action` parameter and namespacing names by service (`github_list_prs`, `slack_send_message`). Past a few dozen tools, defer loading through tool search, or consider [CodeAct instead of a classic tool-calling loop](/2026/07/codeact-vs-tool-calling-loop-for-agents/).
- **Do not put secrets or PHI in schemas.** Anthropic caches compiled strict schemas separately from message content, and its docs explicitly say protected health information must not appear in property names, `enum` values, `const` values or `pattern` regexes.

## Related

- [What is the difference between an AI agent and an AI workflow?](/2026/10/what-is-the-difference-between-an-ai-agent-and-an-ai-workflow/)
- [How to reduce the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/)
- [Measure an agent's fixed token overhead before the first user token](/2026/09/measure-an-agents-fixed-token-overhead-before-the-first-user-token/)
- [Fix: tool call arguments did not match schema in Anthropic tool use](/2026/05/fix-tool-call-arguments-did-not-match-schema-in-anthropic-tool-use/)
- [How to add tool calling to a Microsoft.Extensions.AI chat client](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/)

## Sources

- Anthropic, [Tool use with Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) (protocol, pricing and tool-use system prompt token table)
- Anthropic, [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) (constructed system prompt, description best practices, `input_examples`, `tool_choice`)
- Anthropic, [Strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use) and [Structured outputs: JSON Schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations)
- Anthropic Engineering, [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- OpenAI, [Function calling guide](https://developers.openai.com/api/docs/guides/function-calling) (strict mode requirements and function design best practices)
- [anthropic on PyPI](https://pypi.org/project/anthropic/) (1.11.0)
