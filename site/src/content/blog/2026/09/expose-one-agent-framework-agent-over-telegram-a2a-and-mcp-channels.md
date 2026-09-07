---
title: "How to Expose One Microsoft Agent Framework Agent over Telegram, A2A, and MCP Channels"
description: "The agent-framework-hosting packages are conversion helpers, not a runtime. One Agent instance, one AgentState, and three thin adapters give you a Telegram bot, an A2A peer, and an MCP tool from the same process. Here is the wiring, the per-channel session-ID policy, and the four things each channel refuses to do."
pubDate: 2026-09-07
template: how-to
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "mcp"
  - "llm"
  - "a2a"
  - "python"
  - "agent-hosting"
---

**Short answer:** install `agent-framework-hosting` plus one `agent-framework-hosting-<channel>` package per channel, build your `Agent` exactly once, wrap it in a single `AgentState`, and then let each channel translate its own protocol into `Agent.run` arguments. The channel packages are pure conversion helpers: they do not own a web framework, a bot client, an MCP `Server`, or an A2A `AgentExecutor`. Per-channel behaviour lives in two places only, the session ID your app mints and the run options each adapter forwards. Versions in this post: `agent-framework` 1.17.0 (2026-09-03), `agent-framework-hosting`, `-a2a`, `-mcp`, and `-telegram` all at `1.0.0a260730` (2026-07-30), Python 3.10 or newer.

## What Microsoft actually shipped on 2026-08-26

The [agent and workflow channels announcement](https://devblogs.microsoft.com/agent-framework/introducing-agent-and-workflow-channels/) reads like a hosting framework, and it is not one. That is the single most useful thing to internalise before you write any code. The framing in the post is that "an agent or workflow is only useful when people and other systems can reach it through the interfaces and channels they already use," and the design conclusion Microsoft drew is that your application keeps its own web framework, routing, auth, storage, and deployment shape.

Five packages came out of that:

| Package | Version | What it converts |
| --- | --- | --- |
| `agent-framework-hosting` | `1.0.0a260730` | Nothing. Shared `AgentState` / `WorkflowState` session helpers. |
| `agent-framework-hosting-responses` | `1.0.0a260903` | OpenAI Responses requests and results |
| `agent-framework-hosting-telegram` | `1.0.0a260730` | Telegram Bot API `Update` JSON, both directions |
| `agent-framework-hosting-a2a` | `1.0.0a260730` | Native A2A SDK message parts, plus `AgentCard` generation |
| `agent-framework-hosting-mcp` | `1.0.0a260730` | Native MCP tool arguments and `ContentBlock` values |

Every one of them is an alpha pre-release, so `pip install` needs `--pre`. The `agent-framework-hosting-telegram` README states the boundary bluntly: it "does not provide a bot client, a hosting/channel registry, or a long-running service." The A2A package "does not provide an `AgentExecutor`, task lifecycle, event queue, task store, routes, session policy, authentication, or deployment." The MCP package leaves you the `Server`, handler registration, request context, transport, and session-key policy.

That is why one agent across three channels is genuinely cheap here. There is no runtime to fight. There are three functions that turn protocol X into a dict you pass to `run(...)`, and three functions that turn the result back.

## The agent you build once

Start with the target. Nothing about it is channel-aware:

```python
# agent-framework 1.17.0, agent-framework-hosting 1.0.0a260730, Python 3.11
from typing import Annotated

from agent_framework import Agent, InMemoryHistoryProvider, tool
from agent_framework.openai import OpenAIChatClient
from agent_framework_hosting import AgentState


@tool(approval_mode="never_require")
def lookup_incident(
    incident_id: Annotated[str, "The incident ID, for example INC-4821."],
) -> str:
    """Return the current status of an incident."""
    return f"{incident_id}: mitigated, owner is the payments on-call."


def create_agent() -> Agent:
    return Agent(
        client=OpenAIChatClient(),
        name="IncidentAgent",
        description="Answers questions about production incidents.",
        instructions="Answer in one or two sentences. Always cite the incident ID.",
        tools=[lookup_incident],
        context_providers=[InMemoryHistoryProvider()],
    )


state = AgentState(create_agent)
```

`AgentState` accepts a direct instance, a synchronous factory, an asynchronous factory, or an awaitable, and it caches the resolved target by default. Pass `cache_target=False` when you need a fresh instance per request. That matters more for workflows than agents: a `Workflow` instance allows only one active run, so `WorkflowState(create_workflow, cache_target=False)` is mandatory if two channels can hit the same workflow concurrently.

`AgentState` pairs that target with a `SessionStore`. The default store is an in-memory dict, and the README is explicit that it has **no eviction**: every ID you ever hand out stays resolvable for the life of the process. That is deliberate, because protocols like the OpenAI Responses `previous_response_id` are designed to let a caller resume from any earlier point, not just the newest turn. For anything long-lived, swap in `FileSessionStore` or your own backend:

```python
from agent_framework import FileSessionStore

# msgspec JSON is the default; msgpack is the compact binary option.
store = FileSessionStore("storage/sessions", serialization_format="msgpack")
state = AgentState(create_agent, session_store=store)
```

If you park custom objects in `AgentSession.state`, register them at module import time with `register_state_type(MyState, type_id="my_state")`, before any provider instance exists. Cold-start deserialisation is not guaranteed on the legacy auto-registration path, which now emits a `DeprecationWarning`. Choosing where those sessions ultimately land is its own decision with real retention consequences, which I worked through in [the tradeoffs of storing agent chat history](/2026/09/where-to-store-agent-chat-history-cost-privacy-portability/).

## Channel one: MCP, where the agent becomes a single tool

`AgentMCPTool` derives the MCP `Tool` definition from the agent, then keeps listing, argument parsing, execution, result conversion, and session persistence aligned so the schema cannot drift from the conversion:

```python
# agent-framework-hosting-mcp 1.0.0a260730, MCP Python SDK server
from agent_framework_hosting_mcp import AgentMCPTool

incident_tool = AgentMCPTool(
    state,
    name="ask_incident_agent",
    argument_description="A question about a production incident.",
    parameters={"session_id": {"type": "string", "minLength": 1}},
    required_parameters={"session_id"},
    session_id_parameter="session_id",
    chat_option_parameters={
        "reasoning_effort": {"type": "string", "enum": ["low", "medium", "high"]},
    },
)


@server.list_tools()
async def list_tools():
    return await incident_tool.list_tools()


@server.call_tool()
async def call_tool(name, arguments):
    return await incident_tool.call_tool(name, arguments)
```

The distinction between `parameters` and `chat_option_parameters` is the one people get wrong. Both add JSON Schema properties to the tool. Only `chat_option_parameters` values are copied into `run["options"]` and reach the model client. Anything in `parameters` stays visible in the message's raw representation and goes no further. If you want an MCP caller to be able to dial reasoning effort up for a hard incident, it has to be a chat option parameter.

`session_id_parameter` wires the argument into the `AgentState` get / run / set sequence, and a configured session parameter is always marked required in the generated schema. What the adapter does not do is authorise it. The README is direct about this: "The application must authenticate or authorize that session identifier and serialize concurrent calls for the same session." An MCP client that can guess another tenant's session ID reads that tenant's conversation. Treat it as an untrusted string until your own policy has cleared it.

Four MCP limits are structural and no amount of configuration removes them:

- **No streaming.** `tools/call` returns one final `CallToolResult`. Streamable HTTP can carry progress notifications while work runs, but neither that nor the experimental MCP tasks extension turns agent response updates into incremental tool results.
- **No multimodal arguments.** MCP does not define image, audio, or resource content blocks for tool *arguments*, so the helper converts exactly one selected string argument rather than inventing a non-standard JSON convention.
- **`function_call` content is dropped** from tool results, because the `CallToolResult.content` union does not include sampling-only `ToolUseContent`.
- **No branching.** `AgentMCPTool` treats the session ID as one mutable conversation: load, run, store back under the same key. There is no `previous_response_id`-style fork.

For non-image binary output, `mcp_from_run(...)` uses `content.additional_properties["uri"]` when your code set it and otherwise falls back to the literal `af://binary`, with the payload only in the resource's `blob` field. If your transport choice is still open, the [stdio vs HTTP vs SSE comparison](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) covers which one this server should sit behind.

## Channel two: A2A, where the agent becomes a discoverable peer

A2A is the channel where other *agents* call yours, which is a different contract from a tool call. [The distinction between agent-to-agent and agent-to-tool protocols](/2026/07/a2a-protocol-vs-mcp-agent-to-agent-vs-agent-to-tool/) is worth being deliberate about before you expose both: MCP callers want a function, A2A callers want a collaborator with a published card.

`AgentA2AAdapter` generates that card and re-exposes the conversion helpers so one object covers both jobs:

```python
# agent-framework-hosting-a2a 1.0.0a260730, A2A SDK v1
from a2a.types import AgentCapabilities, AgentInterface
from agent_framework_hosting_a2a import AgentA2AAdapter

adapter = AgentA2AAdapter(
    state,
    version="1.0.0",
    supported_interfaces=[
        AgentInterface(url="https://ops.example.com/a2a", protocol_binding="JSONRPC"),
    ],
    capabilities=AgentCapabilities(streaming=True),
)
card = await adapter.get_card()
```

`get_card()` is async precisely so factory-backed states can resolve their target first. The adapter infers name and description from the agent, uses conservative text input and output modes, and by default discovers Agent Framework `Skill` values from any `SkillsProvider` on the agent, turning each skill's frontmatter name and description into a native A2A `AgentSkill`. Set `infer_skills=False` when the advertised list should be session-specific, because card discovery happens outside an agent run and context-aware skill sources get no session.

Two card fields carry real deployment weight. `supported_interfaces` must list only bindings you have actually configured (`JSONRPC`, `HTTP+JSON`, or `GRPC`), and the `url` is the public base URL including the mount path. `capabilities` stays explicit because it describes the public application contract, not the agent's `run` method. Advertising `streaming=True` because your agent can stream, on a route that does not, is a card that lies.

Inside the executor, the conversion is three lines:

```python
run = adapter.a2a_to_run(context.message, stream=True)
session_id = f"a2a:{context.tenant}:{context.context_id}"
session = await state.get_or_create_session(session_id)
result = await (await state.get_target()).run(
    run["messages"], session=session, options=run["options"], stream=run["stream"]
)
await state.set_session(session_id, session)
parts = adapter.a2a_from_run(result)
```

Adapter conversions validate against the configured card modes by default; pass `validate_modes=False` to opt out. Mode parsing has an exhaustive built-in set: `text`, `application/json`, `application/octet-stream`, concrete media types like `image/png`, and wildcards like `image/*`. A custom mode string passes validation when the native part already carries that exact media type, but conversion **raises** when it would have to synthesise that representation with no built-in parser. That is a startup-time decision, so pin your modes before you publish the card.

`a2a_from_run(...)` returns a flat part list and preserves content-level metadata. Your executor decides how to group parts into messages or artifacts.

## Channel three: Telegram, where the agent becomes a chat

Telegram is the channel with the most application-owned surface, because the helper package deliberately does not ship a bot client. Your app fetches updates, verifies webhook authenticity, calls the Bot API, handles rate limits and retries, and dispatches commands. The helpers give you six functions and a `TelegramOperation` TypedDict of `{"method": str, "payload": dict}`.

Session identity is the interesting part. `telegram_session_id(update, bot_id=...)` mints `telegram:<bot_id>:<user_id>` for private chats and `telegram:<bot_id>:<chat_id>` for everything else. That single rule gives you per-user memory in DMs and one shared thread in a group, which is almost always what people expect, and it is bot-scoped so two bots in the same group do not collide.

Streaming is where Telegram diverges hardest from MCP:

```python
# agent-framework-hosting-telegram 1.0.0a260730, aiogram 3.29
run = await telegram_to_run(update, resolve_file_url=resolve_file_url, stream=True)
placeholder = await bot.send_message(chat_id=chat_id, text="...")

session = await state.get_or_create_session(session_id)
stream = (await state.get_target()).run(
    run["messages"], stream=True, session=session, options=run["options"]
)

last_edit_at = 0.0
async for operation in telegram_from_streaming_run(
    stream, chat_id=chat_id, message_id=placeholder.message_id, initial_text="...",
):
    if operation["method"] == "editMessageText":
        delay = 0.4 - (time.monotonic() - last_edit_at)
        if delay > 0:
            await asyncio.sleep(delay)
        last_edit_at = time.monotonic()
    await execute_operation(operation)

await state.set_session(session_id, session)
```

`telegram_from_streaming_run` yields `editMessageText` operations carrying the cumulative text so far, then `sendPhoto` operations for any images in the final response. Passing your placeholder text as `initial_text` suppresses an identical first edit. The 0.4 second throttle is not in the library, it is in the [official sample](https://github.com/microsoft/agent-framework/tree/main/python/samples/04-hosting/af-hosting/local_telegram), and you need it because Telegram enforces per-chat rate limits that an unthrottled token stream will blow through immediately.

Inbound media only works if you supply `resolve_file_url`, normally backed by `getFile`. Without it, or when it returns `None`, text and captions survive and media is dropped. A media-only update with no resolvable URL raises `ValueError`, so catch it and ignore the update rather than letting it kill the handler.

The sample also serialises each chat with an `asyncio.Lock` keyed on the session ID, so a `/new` command cannot delete a session while an earlier response is still writing to it. In a distributed deployment an in-process lock is not enough, and you need your storage backend's own locking or another cross-process ordering strategy.

One security note that deserves repeating from the docs: the webhook secret header authenticates Telegram's *delivery*. It does not authorise the Telegram user or chat to reach your application's data. Chat and user IDs are untrusted input until your authorisation policy says otherwise.

## Per-channel behaviour is a session-ID policy, not three agents

Put the three channels side by side and the actual design surface is small:

| | Session ID source | Streaming | Multimodal in | Validation |
| --- | --- | --- | --- | --- |
| MCP | Required tool argument, app-authorised | No, one `CallToolResult` | No, one string argument | JSON Schema `inputSchema` |
| A2A | App-composed, for example `a2a:<tenant>:<context_id>` | Yes, via native executor | Yes, per advertised modes | Card input/output modes |
| Telegram | `telegram:<bot_id>:<user_id or chat_id>` | Yes, as throttled edits | Yes, via `resolve_file_url` | None, you own it |

Everything a channel is allowed to change about the run flows through `run["options"]`. That is your per-channel behaviour knob: MCP callers may set `reasoning_effort` because you listed it in `chat_option_parameters`, A2A callers get whatever your executor composes, and Telegram users get whatever you hardcode. The agent itself, its instructions, and its tools stay identical, which is the entire point.

If you want the same session to be reachable from more than one channel, you have to build that yourself. The `agent-framework-hosting` README lists cross-channel identity linking, multicast delivery, background runs, continuation tokens, and durable delivery runners as follow-up enhancements, explicitly not part of the v1 state surface. A Telegram user and an A2A caller do not share a conversation unless you write the mapping.

## The gaps to plan around

Language coverage is uneven right now. Telegram self-hosting helpers are Python only, with the .NET docs saying "coming soon" and Go marked unavailable. A2A hosting does exist for .NET through `Microsoft.Agents.AI.Hosting.A2A.AspNetCore` with `AddA2AServer`, `MapA2AHttpJson`, and `MapA2AJsonRpc`, but that is a different, heavier surface than the Python conversion helpers, and its default `InMemoryAgentSessionStore` and `InMemoryTaskStore` are development only. Background responses are still not supported for A2A-hosted .NET agents; `AgentRunMode` defaults to `DisallowBackground`.

The alpha version pins matter too. All four channel packages sit at `1.0.0a260730` while `agent-framework` itself has moved to 1.17.0, and `agent-framework-hosting-responses` already jumped to `1.0.0a260903`. Pin exact versions in your lockfile. The samples in the repo still carry `[tool.uv.sources]` blocks wiring the hosting packages to the upstream repo, which you should drop now that they are on PyPI.

Finally, none of this survives a process restart on defaults. The in-memory `SessionStore` is a dict, the .NET A2A stores are in-memory, and both lose everything on restart and share nothing across instances. Wire durable storage before you call any of these channels production, whether that is `FileSessionStore` for a single node or [a Cosmos DB backed history provider](/2026/09/microsoft-agent-framework-persistent-memory-with-azure-cosmos-db/) for a real deployment.

### Read next

- [A2A vs MCP: agent-to-agent vs agent-to-tool](/2026/07/a2a-protocol-vs-mcp-agent-to-agent-vs-agent-to-tool/), for deciding which channels you actually need.
- [MCP stdio vs HTTP vs SSE transport](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/), for what sits under your MCP `Server`.
- [Stateful vs stateless MCP servers](/2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away/), for why the session-ID argument pattern exists at all.
- [Giving an Agent Framework agent persistent memory with Azure Cosmos DB](/2026/09/microsoft-agent-framework-persistent-memory-with-azure-cosmos-db/), for replacing the in-memory default.
- [Where to store agent chat history](/2026/09/where-to-store-agent-chat-history-cost-privacy-portability/), for the retention and portability side of that choice.

**Sources:** [Introducing agent and workflow channels](https://devblogs.microsoft.com/agent-framework/introducing-agent-and-workflow-channels/) on the Microsoft Agent Framework blog, the [agent-framework-hosting](https://pypi.org/project/agent-framework-hosting/), [agent-framework-hosting-a2a](https://pypi.org/project/agent-framework-hosting-a2a/), [agent-framework-hosting-mcp](https://pypi.org/project/agent-framework-hosting-mcp/), and [agent-framework-hosting-telegram](https://pypi.org/project/agent-framework-hosting-telegram/) package READMEs, the [af-hosting samples](https://github.com/microsoft/agent-framework/tree/main/python/samples/04-hosting/af-hosting), Microsoft Learn on [self-hosting Telegram bots](https://learn.microsoft.com/en-us/agent-framework/hosting/self-hosting/telegram) and [A2A hosting](https://learn.microsoft.com/en-us/agent-framework/hosting/self-hosting/a2a/dotnet), and the [A2A protocol specification](https://a2a-protocol.org/latest/specification/).
