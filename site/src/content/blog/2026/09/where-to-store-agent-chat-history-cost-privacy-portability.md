---
title: "Where to Store Agent Chat History: Cost, Privacy, and Portability Tradeoffs"
description: "Conversation history can live in your process, in your database, in the provider, or on the machine that ran the agent. Where you put it does not change your token bill, it decides your retention exposure, and it decides whether you can ever change providers. The numbers, the retention windows, and a storage shape that survives all three."
pubDate: 2026-09-04
tags:
  - "ai-agents"
  - "llm"
  - "anthropic-sdk"
  - "openai-sdk"
  - "microsoft-agent-framework"
  - "prompt-caching"
  - "privacy"
---

There are exactly four places an agent's conversation history can live: in the process that is running the loop, in a database you own, in the model provider's own storage, or in a file on the machine the agent ran on. Teams usually pick one by accident, discover the consequences a quarter later, and the three things they discover are always the same. The short version: **where you store history has almost no effect on your token bill** (caching does, and caching works the same regardless of where the bytes are parked), it has a very large effect on **how long someone else holds your users' text**, and it decides whether swapping `claude-opus-5` for `gpt-6-astra` is a config change or a rewrite.

This post uses real retention windows and real prices, current as of September 2026: the Claude API model table, the Responses API `store` semantics, and the compaction beta (`compact-2026-01-12`). The code is Python 3.13 with `anthropic` and `openai`, plus a C# `ChatHistoryProvider` for Microsoft Agent Framework.

## The four places, and who is actually holding the bytes

| Location | Who holds it | Survives a restart | Survives a provider swap |
| --- | --- | --- | --- |
| The `messages` list in your process | You, until the process exits | No | Yes, but it is gone anyway |
| Your database or object store | You | Yes | Yes, if you normalized it |
| Provider-side conversation state (`previous_response_id`, `conversation`, Assistants threads, Foundry sessions) | The provider | Yes | No |
| The agent host's own transcript files (Claude Code JSONL, Cursor's `LocalAgentStore`) | Whoever controls that machine | Yes | No |

The first row is not a storage strategy, but it is what most prototypes do, and it is worth naming because it is the baseline the other three are measured against. The Claude Messages API is stateless: every request carries the whole conversation, and Anthropic keeps nothing between calls unless a stateful feature is involved. That property is the reason the cost question and the storage question are independent, and it is the thing people get wrong first.

## Storage location does not change your token bill

The persistent misconception is that provider-side conversation state is cheaper because "you only send the new message." You do only send the new message. You are billed for all of it anyway. The OpenAI conversation-state guide is blunt about it: with `previous_response_id`, "all previous input tokens for responses in the chain are billed as input tokens in the API." The provider is replaying the prefix on your behalf, not absorbing it.

What actually moves the number is prompt caching. Take a 30-turn agent session on `claude-sonnet-5` ($2 per million input tokens, $2.50 per million for a 5-minute cache write, $0.20 per million for a cache read). Assume an 8,000-token system prompt plus tool schemas, and roughly 1,500 tokens of new user text, assistant output, and tool results per turn.

Without caching, turn `n` sends `8,000 + 1,500 * (n - 1)` input tokens. Across 30 turns that is 892,500 input tokens, or **$1.79** in input alone.

With rolling `cache_control` breakpoints, the only tokens paying write price are the newly appended ones: about 51,500 tokens of writes at $2.50 per million ($0.13), and about 841,000 tokens of reads at $0.20 per million ($0.17). Total **$0.30**, a six-fold reduction, and every byte in both scenarios sat in exactly the same place. Getting the breakpoints to roll correctly is its own topic, covered in [caching multi-turn Claude conversations across API calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/); the point here is that it is orthogonal to storage.

The one place storage and cost genuinely touch is compaction, because compaction changes what you are able to store.

## Compaction is a cost decision that mutates your record

Anthropic's server-side compaction (beta header `compact-2026-01-12`, available on Claude Opus 5, Claude Sonnet 5, and the Fable and Mythos 5 lines) summarizes older context when the input crosses a threshold:

```python
# anthropic 0.7x, beta compact-2026-01-12, September 2026
response = client.beta.messages.create(
    betas=["compact-2026-01-12"],
    model="claude-opus-5",
    max_tokens=4096,
    messages=messages,
    context_management={
        "edits": [{
            "type": "compact_20260112",
            "trigger": {"type": "input_tokens", "value": 150000},
        }]
    },
)

# The response content includes a `compaction` block. You MUST append the whole
# response, block types included, or the next request loses the summary.
messages.append({"role": "assistant", "content": response.content})
```

Two consequences worth internalizing. First, on the wire, when the API sees a `compaction` block in the message list it drops everything before it. Your local `messages` list can still hold the originals; the model will not see them. Second, compaction is not free: the summarization pass is billed at the full pre-compaction input size and shows up as its own entry in `usage.iterations`, so the top-level `input_tokens` field under-reports what you owe.

```python
total_input = sum(it["input_tokens"] for it in response.usage.iterations)
total_output = sum(it["output_tokens"] for it in response.usage.iterations)
```

A compaction triggered at 180,000 input tokens on `claude-opus-5` costs $0.90 in that one pass. It pays for itself if the session continues long enough that the shortened prefix saves more than that. It does not pay for itself on a session that ends two turns later, and there is no way for the API to know which one you are in.

The storage implication is the part people miss: if you persist only what you send, a compacted session leaves you with a summary and no transcript. That is fine for a chat product and disqualifying for anything you might have to audit. Store the pre-compaction messages alongside the compacted list, or accept that the record stops there. The same tradeoff shows up when you go the other direction and [move from chunk-and-retrieve to a 1M-token context window](/2026/08/migrate-from-rag-chunking-to-a-1m-token-context-window/): the thing you optimize for the model is not the thing you keep.

## Retention: the windows you are actually agreeing to

This is where the choice has teeth, because the defaults differ sharply by provider and by endpoint within the same provider.

On the **Claude API**, conversation content sent to `/v1/messages` is not retained by default, and organizations can get a contractual zero data retention (ZDR) arrangement in which prompts and responses are not stored at rest once the response is returned. The exceptions are specific and worth memorizing, because they are all the stateful features:

- **Covered Models** (Claude Fable 5.1, Claude Mythos 5.1, Claude Fable 5, Claude Mythos 5) require 30-day retention and are not available under ZDR unless Anthropic expressly authorizes it. A request to one of them from an org whose retention configuration does not permit it returns a `400 invalid_request_error`, which is a much better failure mode than silent storage.
- **Batch API**: 29-day retention, not ZDR-eligible.
- **Files API**: retained until you delete the file or it hits its configured expiration, not ZDR-eligible.
- **Code execution and programmatic tool calling**: container data retained up to 30 days, not ZDR-eligible.
- Anything flagged by automated trust and safety systems may be retained up to 2 years regardless of arrangement.

Notably, server-side compaction *is* ZDR-eligible, because the summary is returned to you and round-tripped statelessly rather than parked somewhere.

On the **OpenAI API**, the shape is inverted. Abuse-monitoring logs hold prompts and responses for up to 30 days by default, and ZDR or Modified Abuse Monitoring can exclude customer content from those logs for approved customers. But the ZDR-eligible list is endpoints (`/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, and friends), and the stateful surfaces are explicitly not on it. Conversations, Assistants, Threads, and Vector Stores hold application state **until deleted**, ZDR or not. Objects you never delete are retained indefinitely, and deleting one purges it 30 days later.

That produces a trap: `store` defaults to `true` on the Responses API, so the naive first integration is storing everything. Responses carry a 30-day TTL, which is why a `previous_response_id` older than a month returns a 404 and your resume path breaks. Attach a response to a Conversation and the 30-day TTL goes away entirely, which fixes the 404 and quietly converts a self-expiring cache into indefinite storage of user text.

```python
# openai 2.x, September 2026
# Default is store=True. If you keep your own transcript, say so explicitly.
response = client.responses.create(
    model="gpt-6-astra",
    input=[{"role": "user", "content": user_text}],
    store=False,
)
```

Then there is the location nobody puts on the architecture diagram: the developer's laptop. Claude Code writes every session to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, one line per turn, full fidelity, including tool inputs and outputs. Under an organization with the Compliance API enabled, those local session transcripts are retained for **6 years** by default, or for the organization's custom conversation retention period when a finite one is set. If your threat model includes "an engineer pasted a production connection string into an agent session," that file, not your database, is the thing with the long half-life. Being able to read those files is also occasionally exactly what you want, which is what [exporting Claude Code conversations to PDF](/2026/04/export-claude-code-conversations-to-pdf-with-jsonl-to-pdf/) is for.

## Redact on write, never on read

If you keep your own transcript, the redaction pass belongs at the write boundary, before the row is durable, and it belongs on the same code path whether the message came from a user, a model, or a tool result. Redacting on read is a filter you will forget to apply somewhere, and it leaves the raw value in the store in the meantime.

```python
# Python 3.13. Envelope written once, on the way into storage.
import hashlib, json, re, uuid
from datetime import datetime, timezone

PATTERNS = [
    (re.compile(r"sk-[A-Za-z0-9_-]{20,}"), "api_key"),
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b"), "email"),
    (re.compile(r"\b(?:\d[ -]*?){13,19}\b"), "pan"),
]

def redact(text: str) -> tuple[str, list[str]]:
    hits = []
    for pattern, label in PATTERNS:
        def sub(m):
            digest = hashlib.sha256(m.group(0).encode()).hexdigest()[:12]
            hits.append(label)
            return f"[{label}:{digest}]"
        text = pattern.sub(sub, text)
    return text, hits

def envelope(session_id: str, role: str, blocks: list[dict], provider: str) -> dict:
    raw = json.dumps(blocks, separators=(",", ":"))
    clean, hits = redact(raw)
    return {
        "id": str(uuid.uuid4()),
        "session_id": session_id,
        "ts": datetime.now(timezone.utc).isoformat(),
        "role": role,
        "provider": provider,          # "anthropic" | "openai" | ...
        "blocks": json.loads(clean),   # provider-native block list, redacted
        "redactions": sorted(set(hits)),
        "schema": 1,
    }
```

Replacing a match with a stable hash of its value rather than a fixed `[REDACTED]` is a small thing that pays off: you can still tell whether turn 3 and turn 40 leaked the same secret, and you can still correlate across sessions, without holding the secret. The general principle is the same one behind [redacting sensitive values from logs with `LogProperties`](/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/): the sanitizer sits in the pipeline, not at the reader.

Retention is a column, not a policy document. Put a `delete_after` timestamp on each row at write time, derived from the tenant's configured window, and run one job against it. A store where every row knows its own expiry is auditable; a store where deletion is a quarterly script is not.

## Portability: keep the native blocks, add an envelope

The instinct when normalizing history is to flatten everything to `{role, text}`. That is the mistake, because it destroys the structure the next replay needs.

- Anthropic pairs `tool_use` and `tool_result` blocks by `id`. Flatten them to prose and the replay is invalid: the API rejects a `tool_result` with no matching `tool_use`, and even if it did not, the model has lost the binding between call and answer.
- OpenAI reasoning models require you to preserve every item in the response's `output` array, reasoning items included, when you send the next turn. A normalizer that keeps only messages silently degrades the model.
- Anthropic `compaction` blocks are load-bearing on replay and meaningless anywhere else. Round-trip them to Anthropic, strip them for anyone else, and be explicit about which.
- `cache_control` markers are request-time positioning, not history. Do not persist them. Recompute the breakpoints when you build the request, or you will pin a stale cache boundary forever.

The shape that survives is the one in the snippet above: a provider-neutral envelope (id, session, timestamp, role, provider, redaction metadata) wrapping the **provider-native block list, unflattened**. Query and expire on the envelope. Replay from the blocks. When you swap providers you write one adapter per direction and your archive stays readable, instead of discovering that two years of transcripts were lossy the day you need them.

Microsoft Agent Framework encodes this split in its API, which makes it a useful reference even if you are not on .NET. Local history goes through a `ChatHistoryProvider` you can back with anything:

```csharp
// Microsoft.Agents.AI, Agent Framework 1.x, September 2026
public sealed class PostgresChatHistoryProvider : ChatHistoryProvider
{
    protected override ValueTask<IEnumerable<ChatMessage>> ProvideChatHistoryAsync(
        InvokingContext context, CancellationToken ct = default) { /* load by session key */ }

    protected override ValueTask StoreChatHistoryAsync(
        InvokedContext context, CancellationToken ct = default)
    {
        // Only new messages: request messages plus response messages.
        var newMessages = context.RequestMessages.Concat(context.ResponseMessages ?? []);
        // redact here, then append
    }
}
```

The framework's own guidance is the important part. The provider instance is shared across every session, so session-scoped values (database keys, cursors) go in the `AgentSession` via `ProviderSessionState<T>`, never in a field. To persist across restarts you serialize the whole session, not the message text:

```csharp
JsonElement serialized = agent.SerializeSession(session);   // durable storage
AgentSession resumed = await agent.DeserializeSessionAsync(serialized);
```

And when the service holds the conversation instead, the session carries only an opaque identifier (`ChatClientAgentSession.ConversationId` in C#, `session.service_session_id` in Python, matching `resp_*` and `conv_*` on the OpenAI side). Those IDs are scoped to the backing API key or project, which means in a multi-tenant app they are an authorization boundary you have to enforce yourself: store them server-side, map them from your own session IDs, and verify ownership before resuming. An attacker who can guess or replay another tenant's `conv_*` gets their conversation. The same "who owns this handle" question shows up in [stateful versus stateless MCP servers](/2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away/), and the answer is the same: the handle is not a secret, so bind it to an identity you checked.

Coding-agent hosts land in the same place from the other direction. The Cursor SDK exposes `LocalAgentStore` with SQLite and JSONL implementations plus an interface you can implement against Postgres or Redis, which is worth reading as a worked example even outside Cursor, and is covered in [persisting Cursor SDK agent state across restarts](/2026/06/persist-cursor-sdk-agent-state-across-restarts-sqlite-vs-jsonl/).

## Picking, in one paragraph

If the conversation is disposable and short, keep it in the process and do not build anything. If you need resume, audit, or evals, own the bytes: append-only rows, native blocks inside a neutral envelope, redaction on write, a `delete_after` column per row. Reach for provider-side conversation state only when the provider is doing work you would otherwise have to build (server-side tool state, hosted threads), and go in knowing that on OpenAI those objects sit outside ZDR and outside the 30-day TTL, and that on Anthropic the stateful features are exactly the ones marked "No" in the ZDR eligibility table. And whatever you decide for the production agent, remember that the coding agents your team runs all day are writing full-fidelity transcripts to disk under a six-year default, which is usually the largest uncontrolled pile of conversation history an engineering org has.

## Related

- [How to Cache Multi-Turn Claude Conversations Across API Calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/) for the rolling breakpoints that actually move the bill.
- [Migrate an Agent From Chunking-and-RAG to a 1M-Token Context Window](/2026/08/migrate-from-rag-chunking-to-a-1m-token-context-window/) for what happens to the record when you stop retrieving and start replaying.
- [How to Persist Cursor SDK Agent State Across Restarts](/2026/06/persist-cursor-sdk-agent-state-across-restarts-sqlite-vs-jsonl/) for a concrete SQLite versus JSONL store with a pluggable interface.
- [Stateful vs Stateless MCP Servers](/2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away/) for the handle-ownership problem in its other form.
- [How to Redact Sensitive Values From Logs With LogProperties in .NET](/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/) for the write-boundary redaction pattern on the .NET side.
- [Export Claude Code Conversations to PDF With jsonl-to-pdf](/2026/04/export-claude-code-conversations-to-pdf-with-jsonl-to-pdf/) for reading the transcripts your agent host already wrote.

## Sources

- [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention), Claude Platform Docs, including the ZDR feature eligibility table and Covered Model requirements.
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing), Claude Platform Docs, for the per-model input, output, and cache multipliers used in the worked example.
- [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction), Claude Platform Docs, for the `compact_20260112` edit type and `usage.iterations` accounting.
- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state), OpenAI API docs, for `store`, `previous_response_id`, and the Conversations TTL exception.
- [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data), OpenAI API docs, for the 30-day abuse-monitoring window and the ZDR endpoint list.
- [Storage](https://learn.microsoft.com/en-us/agent-framework/concepts/agents/conversations/storage), Microsoft Agent Framework docs, for `ChatHistoryProvider`, `ProviderSessionState<T>`, and session serialization.
