---
title: "Fix: Tool Call Arguments Did Not Match Schema in Anthropic Tool Use"
description: "Why your Claude tool call fails schema validation, in both flavours: the API rejecting your tool definition at request time, and Claude returning a tool_use block your runner cannot accept. Concrete fixes for each, with strict mode, oneOf/anyOf, additionalProperties, and the retry loop pattern."
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "claude-code"
  - "anthropic-sdk"
  - "llm"
  - "ai-agents"
  - "mcp"
---

# Fix: Tool Call Arguments Did Not Match Schema in Anthropic Tool Use

If a Claude tool call fails with "arguments did not match schema", "input_schema is invalid", or your runner throws when validating `tool_use.input`, you are hitting one of two distinct failures that share an error string. Either the API is rejecting your tool definition at request time because the `input_schema` uses unsupported JSON Schema features, or Claude returned a `tool_use` block whose `input` does not satisfy the schema you sent and your runner refused to call the function. The fix path is different for each. Verified against the Claude API as of 2026-05, Anthropic Python SDK 0.50.x, the TypeScript SDK 0.30.x, and Claude Code 2.1.128.

## The error in context

Two shapes show up in production. The first is a 400 from the Messages API before the model is invoked at all:

```text
API Error: 400
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "tools.0.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level"
  }
}
```

The second is a runtime mismatch on a response that did succeed: Claude returned a `tool_use` block, but the `input` object is missing a required property, uses the wrong type, or contains a value outside an enum. Your validator throws something like:

```text
ValidationError: 1 validation error for SearchFlights
passengers
  Input should be a valid integer [type=int_type, input_value='two', input_type=str]
```

A third variant, common to Claude Code and MCP clients, is the strict mode incompatibility report:

```text
Input schema is not compatible with strict mode: string patterns are not supported
```

All three trace back to the same fundamental issue: the model can only honour the [supported JSON Schema subset](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), and unsupported features either get rejected up front or get silently violated at sampling time.

## Why this happens

Anthropic's tool use endpoint accepts a JSON Schema draft 2020-12 object as `input_schema`, but the structured-outputs pipeline that grammar-constrains the model's output only supports a strict subset of that spec. When you do not set `strict: true`, the schema is still validated for syntactic correctness, the model is shown the schema in a system prompt, and the model does its best to comply -- but nothing forces it to. Sonnet 4.6 will usually produce valid arguments for a clean schema. Once you start nesting unions, regex patterns, or numeric bounds, the model guesses.

When you do set `strict: true`, the schema is compiled into a grammar that constrains token sampling. The compiler refuses any construct outside the supported subset, which is why you get the 400 before the model runs. Both modes leave you with the same operational requirement: keep your schema inside the supported subset, and write the agent loop to recover from the runtime case anyway.

## Minimal repro: the request-time 400

The cleanest way to hit the 400 is to send a tool definition with a top-level `anyOf`. Common offenders are auto-generated schemas from Pydantic, FastAPI, or `zod-to-json-schema` that emit a union as a top-level branch.

```python
# Anthropic Python SDK 0.50.x, model claude-opus-4-7
from anthropic import Anthropic

client = Anthropic()

response = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Schedule a job"}],
    tools=[{
        "name": "schedule_job",
        "description": "Schedule a one-off job or a cron job",
        "input_schema": {
            "anyOf": [
                {
                    "type": "object",
                    "properties": {
                        "kind": {"const": "one_off"},
                        "run_at": {"type": "string", "format": "date-time"},
                    },
                    "required": ["kind", "run_at"],
                },
                {
                    "type": "object",
                    "properties": {
                        "kind": {"const": "cron"},
                        "cron": {"type": "string"},
                    },
                    "required": ["kind", "cron"],
                },
            ],
        },
    }],
)
```

The request never reaches the model. The error message identifies the offending tool index and key, but nothing tells you which logical branch you wrote that produced the union. The same problem shows up with `oneOf` or `allOf` at the top level. See [anthropics/claude-code#5973](https://github.com/anthropics/claude-code/issues/5973) and [anthropics/claude-code#4753](https://github.com/anthropics/claude-code/issues/4753) for the canonical reports.

## Fix 1: flatten the top-level union into a discriminated object

The supported pattern is to pull the variants into nested `properties` and use a discriminator field instead of a top-level union. `anyOf` is allowed inside `properties`, just not as the root of `input_schema`.

```python
# Same tool, schema reshaped to fit the supported subset
{
    "name": "schedule_job",
    "description": (
        "Schedule a one-off job or a cron job. Set kind to 'one_off' and "
        "fill run_at, or set kind to 'cron' and fill cron."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": ["one_off", "cron"]},
            "run_at": {"type": "string", "format": "date-time"},
            "cron": {"type": "string"},
        },
        "required": ["kind"],
        "additionalProperties": False,
    },
}
```

You lose compiler-enforced "exactly one of run_at or cron". You move that check into your tool handler. In practice that is the right trade: the model handles the dispatch correctly when the description spells out the conditional, and your handler is the only place that can produce a useful error if the model still gets it wrong.

If the schema came out of an SDK transformer, regenerate. The official Anthropic SDKs (Python, TypeScript, Ruby, PHP) automatically transform Pydantic / Zod schemas by removing unsupported constraints and adding `additionalProperties: false`. If you have hand-rolled the schema or are using a third-party converter, run the request once with the SDK's own pipeline and diff the output.

## Fix 2: stop sending fields that fail the property-key regex

A second common 400 is on the property names themselves:

```text
tools.0.custom.input_schema.properties: Property keys should match pattern '^[a-zA-Z0-9_.-]{1,64}$'
```

The two repeat offenders here are `$schema` (added by many auto-generators) and `@type` (common in JSON-LD-derived schemas). Anthropic restricts property keys to a strict identifier regex because keys end up in the grammar and have to be tokenizable. Strip the metadata before sending:

```python
def sanitize_schema(schema: dict) -> dict:
    # Anthropic Python SDK 0.50.x, request-time check
    out = {k: v for k, v in schema.items() if not k.startswith("$")}
    if "properties" in out:
        out["properties"] = {
            k: sanitize_schema(v) for k, v in out["properties"].items()
            if not k.startswith("$") and not k.startswith("@")
        }
    return out
```

MCP servers in particular emit `$schema` keys at the top of their tool definitions; recent Claude Code builds reject them and surface the error as a generic "tool failed to load" event. The fix is in the server, not the client. See [anthropics/claude-code#34249](https://github.com/anthropics/claude-code/issues/34249) for the explore-subagent variant.

## Fix 3: add `strict: true` and `additionalProperties: false`

Once your schema is inside the supported subset, the next defence is to actually turn on validation. With `strict: true`, the tool input is guaranteed to be schema-valid because the model can only emit tokens that fit the grammar.

```python
# Anthropic Python SDK 0.50.x, claude-opus-4-7
tool = {
    "name": "search_flights",
    "description": "Search outbound flights by origin and destination.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "properties": {
            "origin": {"type": "string"},
            "destination": {"type": "string"},
            "departure_date": {"type": "string", "format": "date"},
            "passengers": {
                "type": "integer",
                "enum": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
            },
        },
        "required": ["origin", "destination", "departure_date"],
        "additionalProperties": False,
    },
}
```

Three rules to keep in mind every time you set `strict: true`:

1. **`additionalProperties: false` is mandatory.** Every object in the schema must declare it. Omitting it or setting it to `true` returns a 400 at request time.
2. **String `pattern` is not yet supported.** Drop the pattern and validate in your handler, or move to `enum` if the set is finite.
3. **No `minimum`, `maximum`, `minLength`, or `maxLength`.** These are silently dropped by the SDK transformers, then re-validated against the response. If you need numeric bounds, use `enum` for small ranges or check inside the handler.

The complete list lives in the [JSON Schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) docs. Match it once and the request-time 400s stop.

## The runtime case: Claude returns input that fails your validator

`strict: true` solves the model side. It does not solve the case where you are not in strict mode -- because your schema is outside the supported subset, because you are on an older model that does not support it, or because you have a non-Anthropic upstream like Bedrock that does not expose the flag. In that case Claude will sometimes return a `tool_use` block with the wrong shape, and your runner has to recover.

The canonical recovery pattern is the [troubleshooting tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/troubleshooting-tool-use) loop: validate the input, and if it fails, return a `tool_result` with `is_error: true` and a message describing exactly what was wrong. Claude reads the error in the next turn and retries.

```python
# Anthropic Python SDK 0.50.x
import json
from pydantic import BaseModel, ValidationError

class SearchFlightsInput(BaseModel):
    origin: str
    destination: str
    departure_date: str
    passengers: int

def call_tool(block):
    if block.name != "search_flights":
        return tool_result_error(block.id, f"unknown tool: {block.name}")
    try:
        args = SearchFlightsInput.model_validate(block.input)
    except ValidationError as e:
        return tool_result_error(
            block.id,
            "Tool call arguments did not match schema: "
            + json.dumps(e.errors(include_url=False)),
        )
    return tool_result_ok(block.id, run_search(args))

def tool_result_error(tool_use_id: str, msg: str):
    return {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "is_error": True,
        "content": msg,
    }
```

Two things matter about this shape. First, the `tool_use_id` must match the id Claude generated for that tool call -- the API rejects the next turn with "tool_use ids were found without tool_result blocks" if any id is missing. Second, the error content has to be specific. "Invalid input" forces the model to guess what is wrong; the serialised Pydantic error tells it which field was wrong and why, and it will typically recover on the next turn.

## Step-by-step diagnosis

When the error message alone is not enough, walk through the layers in order:

1. **Reproduce against the API directly with curl.** This proves whether the failure is in your schema (request-time 400) or in the model's output (runtime validation). If curl returns 200 and a `tool_use` block that does not match, the bug is downstream of the API.
2. **Diff against the SDK-transformed schema.** In Python: `print(client._tools_for_request(tools))` against the raw input. The SDK strips unsupported keywords, adds `additionalProperties: false`, and filters string formats. Compare what you intended against what the wire saw.
3. **Run the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) for MCP-sourced tools.** The Inspector renders the exact schema being served, including the `$schema` keys and `oneOf` branches that some MCP servers emit. If the Inspector schema fails one of the rules in the previous sections, the server has to be patched, not the client.
4. **Switch to `strict: true` temporarily, even if you do not plan to keep it.** Strict mode surfaces the exact incompatible construct in the 400 message. Once you know the offending feature, you can decide whether to drop strict mode again or rewrite the schema.

## Gotchas and lookalikes

A handful of failure modes look like the schema mismatch but have different root causes:

- **Missing `input_schema` field.** Surfaces as `tools.X.custom.input_schema: Field required`. This is not a validation failure of the contents; the field is absent entirely. Common when a config loader silently drops the key. See [anthropics/claude-code#27671](https://github.com/anthropics/claude-code/issues/27671).
- **Tool name regex.** Tool names must match `^[a-zA-Z0-9_-]{1,64}$`. Dots, slashes, or spaces in a tool name return a 400 that names the tool, not the schema -- and is easy to misread as a schema error if you are scanning quickly.
- **Wrong `tool_choice` shape.** A `tool_choice` value that points at a tool name not present in `tools` returns an error that mentions the schema array index. The actual fix is in `tool_choice`, not in `input_schema`.
- **Orphaned `tool_result`.** "`tool_use` ids were found without `tool_result` blocks" is a different error class -- it is about message history shape, not schema. If you are loading message history from a database that lost a turn, fix the loader.
- **Older Bedrock builds.** Anthropic models served through Bedrock did not expose `strict` until a relatively recent runtime update. If you are seeing schema mismatches on Bedrock that you cannot reproduce against the Anthropic endpoint, check the runtime version before assuming the model misbehaved.
- **JSON escaping differences in Opus 4.7.** Newer models escape Unicode and forward slashes differently. Never do a raw string comparison on the serialised `input`; always parse it before comparing.

## Related

- [Build a custom MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) for the server-side blueprint that produces a schema strict mode accepts.
- [Custom MCP server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) where the official SDK keeps the schema inside the supported subset by default.
- [Fix: MCP server stdio hang when launched from Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/) for the other half of the "tool registered but does nothing" diagnosis.
- [How to add tool calling to a Microsoft.Extensions.AI chat client](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/) for the .NET-side equivalent of the runtime validation loop.
- [How to call the Claude API from a .NET 11 minimal API with streaming](/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/) for the full request/response shape that surrounds these tool blocks.

## Sources

- [Strict tool use -- Claude API docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use)
- [Define tools -- Claude API docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- [Troubleshooting tool use -- Claude API docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/troubleshooting-tool-use)
- [Structured outputs and JSON Schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [anthropics/claude-code#5973 -- oneOf/allOf/anyOf at top level](https://github.com/anthropics/claude-code/issues/5973)
- [anthropics/claude-code#4753 -- Invalid Tool Input Schema with OneOf/AllOf](https://github.com/anthropics/claude-code/issues/4753)
- [anthropics/claude-code#10606 -- strict MCP schema validation in 2.0.21+](https://github.com/anthropics/claude-code/issues/10606)
- [anthropics/claude-code#34249 -- $schema in MCP tool schemas](https://github.com/anthropics/claude-code/issues/34249)
- [anthropics/claude-code#27671 -- WebSearch tool input_schema field required](https://github.com/anthropics/claude-code/issues/27671)
