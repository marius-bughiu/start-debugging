---
title: "How to Trace Anthropic SDK Calls With the Built-In OpenTelemetry Export"
description: "The Anthropic Python and TypeScript SDKs now emit OpenTelemetry spans on their own: register a tracer provider before the first call and every messages.create becomes an anthropic.messages.create CLIENT span with gen_ai.* token, model and stop-reason attributes. Content mode, conversation IDs, user.id baggage, linking to the Claude Platform's server-side spans, streaming and tool runner behavior, and the env-var override trap, checked against anthropic 2.8.0."
pubDate: 2026-11-11
template: "how-to"
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "opentelemetry"
  - "observability"
---

**Short answer:** upgrade to a current SDK (`anthropic` 2.8.0 on PyPI, `@anthropic-ai/sdk` 1.8.0 on npm at the time of writing), register an OpenTelemetry tracer provider with an exporter **before** your first Claude call, and do nothing else. The SDK picks up the global provider and turns every `messages.create` into an `anthropic.messages.create` span of kind `CLIENT` carrying `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, the cache read/write counts, `anthropic.message.stop_reason` and the `request-id`. Prompts and responses are left out unless you set `content_mode` to `content`. Turn it off per client with `open_telemetry=False` or globally with `ANTHROPIC_OPEN_TELEMETRY=false`. The feature is in public beta, so span names and attributes can still change: pin your SDK version.

## Why the SDK grew its own tracing

Until this beta, getting Claude calls into Jaeger, Honeycomb, Grafana Tempo or Datadog meant one of three things: wrapping every call in a hand-rolled span, installing a third-party instrumentor (OpenInference, OpenLLMetry, Langfuse's SDK patch), or routing traffic through a gateway that logged on your behalf. All three drift. The instrumentor monkey-patches methods the SDK renames, the gateway does not see what your code did before and after the call, and the hand-rolled spans never agree on attribute names.

Anthropic now ships the instrumentation inside the client libraries (Python, TypeScript, Java, Go, C#, PHP, Ruby) and, separately, lets the Claude Platform itself send server-side spans to an OTLP endpoint you configure in the Console. Both sides use the OpenTelemetry GenAI semantic conventions (`gen_ai.*`), so any backend that understands those conventions renders model, token and tool data without custom mapping. If you have already wired [GitHub Copilot agent sessions into an OpenTelemetry backend](/2026/10/how-to-export-github-copilot-app-agent-sessions-to-an-opentelemetry-backend/), the Claude spans land next to them in the same shape.

## The minimal setup: a console exporter in 15 lines

This is the smallest program that proves the wiring. It prints each finished span as JSON to stdout:

```python
# anthropic 2.8.0, opentelemetry-sdk 1.45.2, Python 3.12
# pip install anthropic opentelemetry-sdk
from anthropic import Anthropic
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor

provider = TracerProvider()
provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))
trace.set_tracer_provider(provider)  # must happen before the first Claude call

client = Anthropic()  # no tracing option needed: tracing is on by default

message = client.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello, Claude"}],
)
print(message.content)
```

The TypeScript equivalent uses `NodeTracerProvider`. Calling `register()` matters for more than the global provider: it also installs the async context manager, which is what lets SDK spans nest under spans you start yourself.

```typescript
// @anthropic-ai/sdk 1.8.0, @opentelemetry/sdk-trace-node 2.x, Node 22
// npm install @anthropic-ai/sdk @opentelemetry/sdk-trace-node
import Anthropic from "@anthropic-ai/sdk";
import {
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";

const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
});
provider.register(); // global provider + context manager

const client = new Anthropic();
const message = await client.messages.create({
  model: "claude-sonnet-5-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello, Claude" }],
});
console.log(message.content);
```

## What one span actually contains

To see the real attribute set without spending tokens, the Python program above was run against a local HTTP stub that returns a canned Messages API response (`anthropic` 2.8.0, `opentelemetry-sdk` 1.45.2, Python 3.12 on macOS). This checks the SDK's span construction, not Anthropic's servers. With content mode on and a conversation ID set, the exported span looked like this (trimmed):

```json
{
  "name": "anthropic.messages.create",
  "kind": "SpanKind.CLIENT",
  "status": { "status_code": "OK" },
  "attributes": {
    "gen_ai.provider.name": "anthropic",
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "claude-sonnet-5-5",
    "gen_ai.request.max_tokens": 256,
    "gen_ai.conversation.id": "conv_42",
    "http.route": "/v1/messages",
    "http.response.status_code": 200,
    "anthropic.request.id": "req_mock01",
    "gen_ai.response.id": "msg_mock01",
    "gen_ai.response.model": "claude-sonnet-5-5",
    "gen_ai.usage.input_tokens": 12,
    "gen_ai.usage.output_tokens": 4,
    "gen_ai.usage.cache_read.input_tokens": 0,
    "gen_ai.usage.cache_write.input_tokens": 0,
    "anthropic.message.stop_reason": "end_turn",
    "gen_ai.input.messages": "[{\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"content\":\"Hello, Claude\"}]}]",
    "gen_ai.output.messages": "[{\"role\":\"assistant\",\"parts\":[{\"type\":\"text\",\"content\":\"Hi there\"}]}]"
  }
}
```

Four attributes do most of the work in a dashboard:

- `anthropic.request.id` is the value of the `request-id` response header. It is what Anthropic support asks for, and now it sits on the span instead of in a log line you forgot to write.
- `gen_ai.response.model` can differ from `gen_ai.request.model` when you call an alias or a fallback model served the request. Group cost by the response model, not the request model.
- `anthropic.message.stop_reason` makes `max_tokens` truncations and `refusal` stops queryable. A spike in `max_tokens` stops is usually a prompt regression, not an outage.
- `error.type` is set on failures (`rate_limit_error`, `overloaded_error` and so on), which pairs well with the retry policy from [retry and backoff for long agent loops](/2026/11/retry-and-backoff-for-long-agent-loops-under-overloaded-and-rate-limit-errors/).

Other attributes appear when the request uses the matching feature: `gen_ai.request.reasoning.level` (the `output_config.effort` value), `anthropic.thinking.type` and `anthropic.thinking.budget_tokens`, `gen_ai.output.type` = `json` for structured output, `anthropic.beta` with the beta headers you sent, and `gen_ai.response.time_to_first_chunk` (seconds) on streamed responses.

### Reading the token counts without double counting

`gen_ai.usage.input_tokens` already **includes** cache reads and cache writes. Do not add `gen_ai.usage.cache_read.input_tokens` or `gen_ai.usage.cache_write.input_tokens` on top of it, or a well-cached agent will look several times more expensive than it is. This is the opposite of the raw Messages API `usage` object, where `input_tokens` excludes cached tokens, so a cost query ported from your old logging code will be wrong in a new way. The cache ratio you want is `cache_read / input_tokens`, which lines up with the hit rate described in [measuring the prompt cache hit rate in an Anthropic SDK app](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/).

Compaction tokens are separate: `anthropic.usage.compaction.input_tokens` and `anthropic.usage.compaction.output_tokens` are not inside the `gen_ai.usage.*` totals. If you use [on-demand compaction in a long agent loop](/2026/11/how-to-keep-a-long-claude-agent-loop-under-the-context-limit-with-on-demand-compaction/), add them explicitly when you sum SDK spans.

## Shipping spans to a real backend over OTLP

Swap the console exporter for an OTLP exporter and a batch processor. Nothing on the Anthropic side changes, because the SDK only talks to the tracer provider:

```python
# anthropic 2.8.0, opentelemetry-sdk 1.45.2, opentelemetry-exporter-otlp-proto-http 1.45.2
# pip install anthropic opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
from anthropic import Anthropic
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider(resource=Resource.create({"service.name": "issue-triager"}))
# Endpoint and auth headers come from OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_HEADERS
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

client = Anthropic()
```

Set `service.name`. Without it the SDK spans arrive as `unknown_service:python` (that is exactly what the local run above reported), and in a backend with several services they become impossible to filter. In short-lived scripts, call `provider.shutdown()` before exit so the batch processor flushes; a cron job that exits immediately after its last call otherwise drops its final spans.

If you need the SDK to use a provider other than the global one (for example, a dedicated pipeline for LLM traffic with a different sampler), pass it explicitly:

```python
client = Anthropic(open_telemetry={"tracer_provider": llm_provider})
```

```typescript
const client = new Anthropic({ openTelemetry: { tracerProvider: llmProvider } });
```

## Recording prompts and responses: content mode

By default the SDK runs in `metadata_only` mode: identifiers, timing, status, token counts and model names, but no message text. Switching to `content` adds `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.request.stop_sequences`, and on tool spans `gen_ai.tool.call.arguments` and `anthropic.tool_result.content`.

```python
# anthropic 2.8.0
client = Anthropic(open_telemetry={"traces": {"content_mode": "content"}})
```

```typescript
// @anthropic-ai/sdk 1.8.0
const client = new Anthropic({ openTelemetry: { traces: { contentMode: "content" } } });
```

or, for a client constructed without an option, `ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE=content`.

Content is capped at `max_content_bytes` per span, 750,000 bytes by default (`ANTHROPIC_OPEN_TELEMETRY_TRACES_MAX_CONTENT_BYTES` to change it). The docs size that default to fit a 200k-token English context and stay below a 1 MB OTLP request limit. A 1M-token context needs around 4 MB, and your collector may reject that. When content is cut, the span gets `anthropic.content.truncated = true`; request spans drop the system prompt and the earliest messages first, tool spans drop blocks from the end. Images and documents are recorded only as their type, never as bytes.

Treat content mode as a data-handling decision, not a debugging toggle. Prompts go to whatever backend the exporter points at, with that backend's retention and access rules.

### The override trap

The constructor option replaces the environment variables **as a whole**. The SDK source (`anthropic/_tracing.py`) only reads `ANTHROPIC_OPEN_TELEMETRY*` when the client is given no `open_telemetry` option at all, and every key you leave out of an explicit option takes its default. This was confirmed in the local run:

| Client construction | `ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE` | Content attributes on span |
|---|---|---|
| `Anthropic()` | unset | no |
| `Anthropic()` | `content` | yes |
| `Anthropic(open_telemetry={"conversation_id": "c"})` | `content` | **no** |
| `Anthropic(open_telemetry=False)` | any | no span at all |

So an ops team that enables content capture through the environment can be silently overruled by a developer who adds a conversation ID in code. Pick one place to configure tracing per service.

## Grouping calls: conversation IDs, user IDs and your own spans

An agent turn is many Claude calls. Three mechanisms tie them together.

**Your own parent span.** Wrap the unit of work in a span and the SDK span becomes its child, sharing the trace ID:

```python
# anthropic 2.8.0, opentelemetry-sdk 1.45.2
tracer = trace.get_tracer("issue-triager")

with tracer.start_as_current_span("triage_issue") as span:
    span.set_attribute("github.issue.number", 4812)
    client.messages.create(
        model="claude-sonnet-5-5",
        max_tokens=1024,
        messages=[{"role": "user", "content": "Classify this issue: ..."}],
    )
```

In the local run the `anthropic.messages.create` span had `parent_id` equal to the `triage_issue` span ID, as expected.

**`conversation_id`.** It sets `gen_ai.conversation.id`, which GenAI-aware backends use to thread sessions. In Python, `with_options()` returns a client copy but replaces the whole `open_telemetry` option, so spread the existing one:

```python
# anthropic 2.8.0
convo = client.with_options(
    open_telemetry={**client.open_telemetry, "conversation_id": "triage-4812"}
)
convo.messages.create(model="claude-sonnet-5-5", max_tokens=512, messages=[...])
```

TypeScript accepts it per call in the request options: `client.messages.create({...}, { openTelemetry: { conversationId: "triage-4812" } })`. The ID is exported in both content modes, so never put an email address or a secret in it.

**`user.id` baggage.** Set `user.id` in OpenTelemetry baggage and the SDK propagates it in the `baggage` header. The local stub received `baggage: user.id=4f2a` alongside the `traceparent` header. The SDK span itself does not carry `user.id`; the Claude Platform's server-side spans do, and the API drops any value that contains an email address. Use an opaque ID.

```python
from opentelemetry import baggage, context

token = context.attach(baggage.set_baggage("user.id", "4f2a"))
try:
    client.messages.create(model="claude-sonnet-5-5", max_tokens=512, messages=[...])
finally:
    context.detach(token)
```

## Linking to the Claude Platform's server-side spans

The SDK writes a W3C `traceparent` header on every request (turn that off with `propagation: False` or `ANTHROPIC_OPEN_TELEMETRY_PROPAGATION=false`; spans are still emitted). If an organization admin has added an OpenTelemetry destination under the Console's telemetry settings, the Claude API reads that header and nests its own spans under your SDK span, sending them to the destination you configured. You then get one trace: your span, the SDK `CLIENT` span, the API `SERVER` span, and API-internal children such as `anthropic.model_request`, `anthropic.compaction` and `anthropic.tool_use web_search`.

Four things to know before you rely on it:

1. **Same name, different kind.** The SDK span and the API span for one request are both named `anthropic.messages.create`. Tell them apart by kind (`CLIENT` vs `SERVER`) or by `service.name`, which is `claude-platform` on the API side. When summing tokens, sum one side only. The API side is the one that reflects what was billed, including failed requests; the SDK side carries only what the response reported.
2. **Sampling controls the API too.** If the sampled flag in `traceparent` is off, the API emits nothing for that request. A 1% head sampler in your app means 1% of server spans as well. For audits, use the Usage and Cost API, not traces: delivery is best effort and at least once.
3. **Use the W3C propagator.** Python and TypeScript register it by default. If your stack uses B3 only, add W3C trace context or the API cannot parent its spans.
4. **TypeScript and undici instrumentation.** If you also use `@opentelemetry/instrumentation-undici` (pulled in by `@opentelemetry/auto-instrumentations-node`), set `openTelemetry: { propagation: false }` on the client. Otherwise a second `traceparent` header is added and the trace context becomes invalid ([opentelemetry-js-contrib#3711](https://github.com/open-telemetry/opentelemetry-js-contrib/issues/3711)).

The API does not emit spans for `count_tokens`, the OpenAI-compatible `/v1/chat/completions` endpoint, or custom tools your code executes. Those only exist on the SDK side.

## Streaming and the tool runner

**Streaming.** The SDK span ends when your code has read the whole stream or closed it. If you `break` out of a stream loop without closing it, the span does not end when you stop reading, and a stream closed early ends with an unset status rather than `OK`. Use the context manager form so close is guaranteed. Response content is recorded only when you read through `messages.stream()`; spans you start inside the read loop become siblings of the SDK span, not children, so wrap both the call and the loop in your own span if you want them grouped.

```python
# anthropic 2.8.0
with tracer.start_as_current_span("draft_reply"):
    with client.messages.stream(
        model="claude-sonnet-5-5", max_tokens=1024, messages=[...]
    ) as stream:
        for text in stream.text_stream:
            print(text, end="")
```

**Tool runner.** When the SDK runs your tool loop, you get an `anthropic.messages.tool_runner` span (`gen_ai.operation.name` = `invoke_agent`) as the parent, one `anthropic.messages.create` per model round trip, and one `anthropic.custom_tool_use <tool name>` span per tool execution with `gen_ai.tool.name` and `gen_ai.tool.call.id`. A tool that raises gets status `ERROR` and `error.type` = `tool_error`, and the loop continues. That is the trace view you want when debugging the patterns in [Claude reached its tool use limit for this turn](/2026/05/fix-claude-reached-its-tool-use-limit-for-this-turn/): the number of `create` children under one runner is the number of turns the agent took. Server tools (web search, code execution) and MCP connector tools show up as `anthropic.tool_use <tool>` and `anthropic.mcp_tool_use <tool>`.

## Gotchas worth checking first

- **No spans at all.** The provider was registered after the client's first call, `ANTHROPIC_OPEN_TELEMETRY=false` is set somewhere in the environment, or a dependency pinned an old SDK. Check `anthropic.__version__`.
- **Every request traced twice.** You still have OpenInference, OpenLLMetry or a vendor patch instrumenting the Anthropic client. Remove it, or disable the built-in spans with `open_telemetry=False`, not both.
- **Claude Agent SDK is a different path.** The Agent SDK runs the Claude Code CLI as a subprocess and is configured with `CLAUDE_CODE_ENABLE_TELEMETRY` and the standard `OTEL_*` variables, not with these client options. Do not point it at a console exporter: stdout is its message channel.
- **Beta churn.** Anthropic states that span names, attributes and options can change during the beta. Build dashboards on `gen_ai.*` attributes where possible, since those follow the upstream conventions, and pin the SDK version you validated.

The payoff for ten lines of setup is a per-request record of model, tokens, cache behavior, stop reason and request ID in the same trace as the rest of your service. That is enough to answer "why did this agent run cost four times more than yesterday" from a trace view, which is the question that usually starts the observability project in the first place. For the evaluation side of the same agent, pair it with an [LLM-as-judge eval harness](/2026/05/how-to-set-up-an-llm-as-judge-eval-harness-for-a-coding-agent/).

## Sources

- [Use OpenTelemetry with the Claude SDK, Claude Platform docs](https://platform.claude.com/docs/en/manage-claude/opentelemetry/sdk)
- [OpenTelemetry tracing for the Claude API, Claude Platform docs](https://platform.claude.com/docs/en/manage-claude/opentelemetry)
- [Set up OpenTelemetry with the Claude API, Claude Platform docs](https://platform.claude.com/docs/en/manage-claude/opentelemetry/api)
- [Span and attribute reference, Claude Platform docs](https://platform.claude.com/docs/en/api/opentelemetry/spans)
- [Claude Agent SDK observability with OpenTelemetry](https://code.claude.com/docs/en/agent-sdk/observability)
- [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [anthropic on PyPI](https://pypi.org/project/anthropic/) (2.8.0 used for the local check above)
