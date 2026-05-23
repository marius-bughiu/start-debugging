---
title: "Fix: Extra Inputs Are Not Permitted on a Tool Call With a Structured Argument"
description: "Your agent's tool call fails with Pydantic's 'Extra inputs are not permitted'. The model added a field your structured argument forbids. Turn on strict tool use so the grammar blocks it, relax the validator, or recover in the loop."
pubDate: 2026-05-23
template: error-page
tags:
  - "errors"
  - "mcp"
  - "llm"
  - "ai-agents"
  - "claude-code"
  - "anthropic-sdk"
  - "pydantic"
---

# Fix: Extra Inputs Are Not Permitted on a Tool Call With a Structured Argument

Your agent called a tool whose argument is a structured object, and the call blew up with `Extra inputs are not permitted [type=extra_forbidden]`. The model put a field in that object that your schema does not declare, and a Pydantic model configured with `extra="forbid"` rejected it. The durable fix is to turn on grammar-constrained tool use (`strict: true` plus `additionalProperties: false` on every object) so the model physically cannot emit the extra key. If you cannot use strict mode, either relax the validator to `extra="ignore"` or return the error to the model and let it retry. Verified against Pydantic 2.11/2.12, the MCP Python SDK 1.x with FastMCP 2.x, the Anthropic Python SDK 0.50.x, and `claude-opus-4-7` as of 2026-05.

## The error in context

The full traceback points at a nested key inside the tool argument, not at the top-level call:

```text
pydantic_core._pydantic_core.ValidationError: 1 validation error for SearchTickets
filters.priority
  Extra inputs are not permitted [type=extra_forbidden, input_value='urgent', input_type=str]
    For further information visit https://errors.pydantic.dev/2.11/v/extra_forbidden
```

Through an MCP client, the same failure usually arrives wrapped in a `tool_result` rather than a raw stack trace:

```text
Error calling tool 'search_tickets': 1 validation error for search_tickets
filters.priority
  Extra inputs are not permitted [type=extra_forbidden, input_value='urgent', input_type=str]
```

The two signals to read here are the error `type`, which is `extra_forbidden`, and the dotted path, `filters.priority`. The path tells you the offending key lives one level down, inside the `filters` object, which is the structured argument. That is what separates this error from its lookalike, `Unexpected keyword argument` (`type=unexpected_keyword_argument`), which fires when the surplus key lands on a plain function parameter at the top level instead of inside a model.

## Why this happens

Pydantic v2 `BaseModel` defaults to `extra="ignore"`. Out of the box, an undeclared field is silently dropped, not rejected. So if you are seeing `extra_forbidden`, something in your stack explicitly closed the object with `extra="forbid"`. There are three usual sources:

1. **You wrote it.** A `model_config = ConfigDict(extra="forbid")` on the argument model, often copied from a config or settings class where forbidding typos is the right call.
2. **A framework set it for you.** Structured-output and tool-binding libraries (instructor, Pydantic AI, the function-tool wrappers in agent frameworks) close their argument models so the model's output has to match exactly.
3. **The schema demanded it.** The structured-outputs pipeline used by both Anthropic and OpenAI requires `additionalProperties: false` on objects. When a library round-trips that JSON Schema back into a Pydantic model to validate the response, `additionalProperties: false` maps to `extra="forbid"`.

Whatever closed the object, the trigger is the same: the model emitted a key that is not in the schema for that object. The common shapes are a hallucinated extra field (the model decides a `priority` or `reason` or `confidence` belongs in your filter), an envelope the model wrapped around the real arguments, or a duplicated value under a slightly different name. In non-strict tool use, `additionalProperties: false` is only advice to the model. Nothing stops it from adding the field at sampling time, and your validator is the first thing that actually enforces the contract.

## Minimal repro

A FastMCP tool with a nested Pydantic model is the shortest path to the error. The `extra="forbid"` on `Filters` is what closes the object and produces `additionalProperties: false` in the generated schema.

```python
# Python 3.13, pydantic 2.11, fastmcp 2.x
from pydantic import BaseModel, ConfigDict
from fastmcp import FastMCP

mcp = FastMCP("tickets")

class Filters(BaseModel):
    model_config = ConfigDict(extra="forbid")  # closed object
    status: str
    assignee: str | None = None

@mcp.tool()
def search_tickets(query: str, filters: Filters) -> list[str]:
    return [f"matched {query} with {filters}"]
```

The model is told the tool takes `query` and a `filters` object with `status` and `assignee`. The moment it decides a ticket search obviously needs a priority and calls:

```json
{
  "query": "login broken",
  "filters": { "status": "open", "priority": "urgent" }
}
```

FastMCP validates the arguments against the generated schema before your function body runs, `Filters` rejects `priority`, and you get `filters.priority: Extra inputs are not permitted`. Your handler never executes, so you cannot fix it inside `search_tickets`.

The Anthropic SDK case is the same contract from the other direction. You hand-write the tool schema, leave strict mode off, and validate the response with a closed model:

```python
# Anthropic Python SDK 0.50.x, claude-opus-4-7, pydantic 2.11
from anthropic import Anthropic
from pydantic import BaseModel, ConfigDict

client = Anthropic()

class Filters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str

tool = {
    "name": "search_tickets",
    "description": "Search tickets by free-text query and a filters object.",
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "filters": {
                "type": "object",
                "properties": {"status": {"type": "string"}},
                "required": ["status"],
                "additionalProperties": False,
            },
        },
        "required": ["query", "filters"],
        "additionalProperties": False,
    },
}
# When the tool_use block arrives, Filters.model_validate(block.input["filters"])
# raises extra_forbidden if the model added a key.
```

`additionalProperties: false` is in the schema, but without `strict: true` it does not bind the model. It only documents intent. The enforcement happens later, in `model_validate`, and that is where the exception surfaces.

## Fix 1: turn on strict tool use so the extra key cannot be emitted

This is the real fix when you are on Anthropic or OpenAI and your schema fits the supported subset. Setting `strict: true` compiles the schema into a grammar and constrains token sampling, so the model can only produce schema-valid output. An undeclared key is unreachable, and your validator never sees one.

```python
# Anthropic Python SDK 0.50.x, claude-opus-4-7
tool = {
    "name": "search_tickets",
    "description": "Search tickets by free-text query and a filters object.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "filters": {
                "type": "object",
                "properties": {
                    "status": {"type": "string"},
                    "assignee": {"type": "string"},
                },
                "required": ["status"],
                "additionalProperties": False,
            },
        },
        "required": ["query", "filters"],
        "additionalProperties": False,
    },
}
```

The detail that bites people: `additionalProperties: false` is required on **every** object in the schema, including the nested `filters` object, not just the root. Anthropic's docs are explicit that strict tool use guarantees the input matches the schema by grammar-constraining the sample, and the strict compiler rejects any object that omits `additionalProperties: false`. If you close the root but forget the nested object, the nested object is not constrained, and the model can still slip an extra field into `filters`. That produces the exact `filters.priority` error you started with, now harder to spot because the root looked locked down.

Strict tool use is available on current models including `claude-opus-4-7` and `claude-sonnet-4-6`. If you are generating the schema from Pydantic, let the official SDK do the transform rather than hand-rolling JSON Schema, because the SDK adds `additionalProperties: false` to nested objects for you and drops keywords the grammar compiler does not support.

## Fix 2: relax the validator to ignore unknown keys

If you own the argument model and silently dropping unexpected fields is acceptable, set the model back to Pydantic's default behavior. This is the right move when the extra field is genuinely noise (a stray `reason`, a client-injected id) and discarding it changes nothing about the result.

```python
# pydantic 2.11
from pydantic import BaseModel, ConfigDict

class Filters(BaseModel):
    model_config = ConfigDict(extra="ignore")  # drop unknown keys
    status: str
    assignee: str | None = None
```

Two caveats. First, do not reach for `extra="allow"` here. `allow` keeps the unknown key as an untyped attribute, which means it survives into your handler and any extra data the model invents now flows into your business logic unchecked. `ignore` drops it; `allow` smuggles it through. Second, never relax a model whose extra field could carry a security-relevant instruction or an argument your handler will act on. For a search filter, ignoring `priority` is harmless. For a `run_command` or `transfer_funds` tool, an unexpected key is a signal that the model misunderstood the contract, and you want that to fail loudly, not get swallowed.

## Fix 3: return the error and let the model retry

When you cannot use strict mode, because you are on an older Bedrock runtime, a non-Anthropic provider that does not expose the flag, or a schema that falls outside the supported subset, the durable pattern is the recovery loop. Validate the input, and on failure return a `tool_result` with `is_error: true` whose content names the offending key precisely. The model reads the error on the next turn and drops the field.

```python
# Anthropic Python SDK 0.50.x, pydantic 2.11
import json
from pydantic import ValidationError

def call_tool(block):
    try:
        args = Filters.model_validate(block.input["filters"])
    except ValidationError as e:
        return {
            "type": "tool_result",
            "tool_use_id": block.id,
            "is_error": True,
            "content": (
                "Tool call rejected: "
                + json.dumps(e.errors(include_url=False))
            ),
        }
    return tool_result_ok(block.id, run_search(args))
```

The serialized Pydantic error is the part that makes this work. "Invalid input" forces the model to guess; `{"type": "extra_forbidden", "loc": ["priority"], "msg": "Extra inputs are not permitted"}` tells it exactly which key to remove, and it almost always recovers on the next turn. Keep the `tool_use_id` matching the id the model generated, or the next request fails for an unrelated reason: tool_use blocks without matching tool_result blocks. This is the same recovery shape covered in [the broader tool-schema mismatch fix](/2026/05/fix-tool-call-arguments-did-not-match-schema-in-anthropic-tool-use/), applied to the specific case of a closed object.

## Fix 4: stop the model from inventing the field

Sometimes the model adds `priority` because your description practically invited it. If the tool blurb says "search tickets by status, priority, and assignee" but the schema only has `status` and `assignee`, the model is doing what you asked and the schema is the lie. Align the two: either add the field to the schema or remove the promise from the description. An example payload in the description also helps the model anchor on the exact shape:

```python
tool = {
    "name": "search_tickets",
    "description": (
        "Search tickets. The filters object accepts only status and "
        "assignee. Example: {\"query\": \"login\", \"filters\": "
        "{\"status\": \"open\"}}. Do not add other keys to filters."
    ),
    # ... schema unchanged
}
```

This is a softener, not a guarantee. In non-strict mode the model can still ignore the instruction, which is why Fix 1 exists. But for providers without grammar-constrained sampling, a tight description plus a worked example measurably cuts the rate of invented fields.

## Gotchas and lookalikes

A few failures share the symptom but have different roots:

- **`Unexpected keyword argument` (`type=unexpected_keyword_argument`).** The surplus key hit a plain function parameter, not a model field. This is what you get when an MCP client injects a transport key your tool signature does not declare. The n8n MCP Client Tool, for instance, has sent a `toolCallId` argument that FastMCP rejected with this exact error (see [n8n#21500](https://github.com/n8n-io/n8n/issues/21500)). The fix is on the client or at the params layer, not in your model.
- **The model wrapped the arguments in a string.** Some clients hand FastMCP the whole argument object as a single JSON string instead of a dict, which fails validation before your handler runs and cannot be caught in your code (see [fastmcp#932](https://github.com/jlowin/fastmcp/issues/932)). Parse and unwrap at the boundary, or accept a `str | dict` and normalize.
- **`$ref` and `$defs` rejected as extra.** If your Pydantic model has nested models, Pydantic emits a schema with `$defs` and `$ref`. Providers that do not resolve refs can echo those metadata keys into the value, where a closed validator then rejects them as extra inputs (this is the shape behind [fast-agent#356](https://github.com/evalstate/fast-agent/issues/356)). Inline the nested models so the schema has no refs.
- **Pydantic 2.12 changed `additionalProperties` emission.** As of 2.12, the JSON Schema generator populates `additionalProperties` based on the model's closed/extra setting, not only for `forbid`. If you upgraded and a schema that used to round-trip now closes objects you expected to stay open, this is why.
- **Do not string-compare the input.** Newer models escape Unicode and forward slashes differently. Parse `block.input` before any comparison, or you will chase a phantom mismatch that is really an encoding difference.

## Related

- [Fix: Tool call arguments did not match schema in Anthropic tool use](/2026/05/fix-tool-call-arguments-did-not-match-schema-in-anthropic-tool-use/) covers the request-time 400s and runtime type mismatches that sit alongside this one.
- [Build a custom MCP server in Python with the official SDK](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) shows the FastMCP tool definitions where closed Pydantic models live.
- [Fix: MCP server stdio hang when launched from Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/) is the other half of the "tool registered but the call goes nowhere" diagnosis.
- [How to add tool calling to a Microsoft.Extensions.AI chat client](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/) is the .NET-side equivalent of validating and recovering from a bad tool call.
- [How to call the Claude API from a .NET 11 minimal API with streaming](/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/) sets up the request and response shape these tool blocks live inside.

## Sources

- [Strict tool use -- Claude API docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use)
- [Structured outputs and JSON Schema limitations -- Claude API docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Pydantic model config: extra ignore/allow/forbid](https://docs.pydantic.dev/latest/api/config/)
- [Pydantic v2.12 release notes -- additionalProperties emission change](https://pydantic.dev/articles/pydantic-v2-12-release)
- [FastMCP tools and argument validation](https://gofastmcp.com/servers/tools)
- [n8n#21500 -- MCP Client Tool sends an unexpected toolCallId](https://github.com/n8n-io/n8n/issues/21500)
- [fastmcp#932 -- JSON arguments encapsulated as a string](https://github.com/jlowin/fastmcp/issues/932)
- [fast-agent#356 -- Extra inputs are not permitted on $ref/$defs](https://github.com/evalstate/fast-agent/issues/356)
