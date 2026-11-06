---
title: "ACP vs MCP: What the Agent Client Protocol Does That MCP Doesn't"
description: "ACP (Agent Client Protocol, v1) connects an editor to a coding agent; MCP (spec 2026-07-28) connects an agent to tools. They sit on opposite sides of the agent and are used together: ACP's session/new even carries the MCP servers the agent should start. Here is the feature matrix, the wire flow, and a working agent and client checked against @agentclientprotocol/sdk 2.4.0."
pubDate: 2026-11-06
template: vs
tags:
  - "ai-agents"
  - "mcp"
  - "agent-client-protocol"
  - "github-copilot"
  - "comparison"
  - "typescript"
---

**Short answer:** ACP and MCP are not competitors, so the real question is which side of the agent you are building. The [Agent Client Protocol](https://agentclientprotocol.com/) (protocol version `1`) is the wire between an editor and a coding agent: the editor sends prompts, the agent streams back messages, tool calls, and permission requests. The [Model Context Protocol](https://modelcontextprotocol.io/) (current spec `2026-07-28`) is the wire between that agent and its tools. If you are building an editor, a chat frontend, or a CI driver that hosts agents, implement ACP. If you are exposing tools or data, implement MCP. If you are building the agent itself, you implement both: ACP upward, MCP downward.

This came up again on November 3, 2026, when [GitHub Copilot became selectable in JetBrains Air](https://github.blog/changelog/2026-11-03-github-copilot-is-now-available-in-jetbrains-air/). The changelog says the integration "uses the Agent Client Protocol (ACP)", and a lot of people reading it already had MCP servers wired into Copilot and wondered whether ACP replaces them. It does not. Below is where each protocol sits, what each one can express that the other cannot, and a small agent plus editor in TypeScript that ran against `@agentclientprotocol/sdk` 2.4.0 on Node 26.4.0.

## The feature matrix

| | ACP (v1) | MCP (2026-07-28) |
| --- | --- | --- |
| Connects | editor / client UI to coding agent | agent (host) to tool and data servers |
| Who starts whom | editor spawns the agent as a subprocess | host spawns or dials the server |
| Encoding | JSON-RPC 2.0, UTF-8 | JSON-RPC 2.0, UTF-8 |
| Standard transport | stdio, newline-delimited | stdio and Streamable HTTP |
| Remote transport | Streamable HTTP / WebSocket still an RFD | Streamable HTTP, OAuth 2.1 |
| Unit of work | session with prompt turns | tool call, resource read, prompt get |
| Streaming | `session/update` notifications (message chunks, tool call status, plans) | progress notifications, task polling |
| Asks the human | `session/request_permission` with allow/reject options | elicitation |
| Touches the editor's files | `fs/read_text_file`, `fs/write_text_file` (unsaved buffers included) | no, tools run on the server's side |
| Runs commands in the editor | `terminal/create`, `terminal/output`, `terminal/kill` | no |
| Version field | integer major version (`1`), v2 in draft | date string (`2026-07-28`) |
| Typical implementers | Zed, JetBrains IDEs and Air, Neovim/Emacs plugins, Copilot CLI, Gemini CLI, Claude Agent | GitHub, Playwright, databases, every "MCP server" |
| Relationship | `session/new` carries `mcpServers` for the agent to start | knows nothing about ACP |

The last row is the important one. ACP was designed with MCP as the layer below it. The protocol overview says it "re-uses the JSON representations used in MCP where possible", so content blocks and resources look the same on both wires.

## Where each protocol sits

Draw the stack top to bottom:

1. A human types in an editor (Zed, IntelliJ, Air, a terminal UI).
2. The editor talks **ACP** to an agent process (Copilot CLI, Gemini CLI, Claude Agent, Goose, OpenCode, your own).
3. The agent calls a model provider over that provider's API.
4. The agent talks **MCP** to zero or more tool servers (GitHub, a database, a browser).

Before ACP, layer 2 was bespoke. Every editor that wanted Claude Code, Codex, or Gemini CLI had to write a custom integration, and every agent vendor had to ship a plugin per editor. ACP does for that layer what the Language Server Protocol did for compilers: one agent binary, every editor that speaks the protocol. MCP had already done the same for layer 4. For a refresher on MCP itself, see [what the Model Context Protocol is and why every IDE ships it](/2026/09/what-is-the-model-context-protocol-and-why-every-ide-is-shipping-it/).

The two protocols also face different trust problems. An MCP server is code the agent chose to call, so the questions are about authorization and transport, covered in [MCP stdio vs HTTP vs SSE](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/). An ACP agent is code the *editor* launched with the user's workspace in reach, so the questions are about what the agent may do to that workspace, which is why permission requests and file access are first-class ACP methods.

## The ACP wire flow in one prompt turn

An ACP conversation has three phases. The client sends `initialize` with its capabilities (can it read files, write files, host terminals), and the agent answers with its own (can it reload sessions, accept images, connect to HTTP MCP servers). The client then opens a session with `session/new`, passing an absolute `cwd` and the MCP servers it wants the agent to use:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/new",
  "params": {
    "cwd": "/home/user/project",
    "mcpServers": [
      {
        "name": "filesystem",
        "command": "/path/to/mcp-server",
        "args": ["--stdio"],
        "env": []
      }
    ]
  }
}
```

That `mcpServers` array is the only place the two protocols touch. The editor owns the user's MCP configuration and hands it to whichever agent is selected, so switching from Copilot to Gemini CLI keeps the same tools. The spec says all agents must support stdio MCP servers, and HTTP or SSE servers only when the agent advertised `mcpCapabilities.http` or `mcpCapabilities.sse`.

Finally the client sends `session/prompt`. While the agent works, it streams `session/update` notifications back: `agent_message_chunk` for text, `tool_call` when it starts a tool, `tool_call_update` as the tool progresses. If a tool needs approval, the agent sends a *request* to the client, `session/request_permission`, and blocks until the human picks an option. The turn ends when the agent answers the original `session/prompt` with a `stopReason` of `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, or `cancelled`. The client can interrupt at any time with a `session/cancel` notification.

Note the direction of those calls. In MCP, requests mostly flow from host to server. In ACP, requests flow both ways all the time: the agent asks the editor to read a file, to run a terminal command, or to get a human's approval. That bidirectionality is the thing MCP does not give you.

## A working agent and editor in about 100 lines

The scenario: an agent that counts `TODO` lines in `notes.md`, which it must read through the editor (so unsaved buffer contents would win over disk) and only after the user allows it. The editor is a tiny Node script that spawns the agent over stdio. Both files ran with `node client.ts` on Node 26.4.0 (built-in type stripping) and passed `tsc --noEmit --strict` with TypeScript 7.0.2.

```bash
# Node 26.4.0, @agentclientprotocol/sdk 2.4.0
npm init -y && npm pkg set type=module
npm install @agentclientprotocol/sdk
printf '# notes\n- TODO wire auth\n- done: tests\n- TODO ship it\n' > notes.md
```

The agent registers handlers for the three baseline methods it needs and calls back into the client from inside `session/prompt`:

```typescript
// agent.ts -- ACP v1, @agentclientprotocol/sdk 2.4.0, Node 26
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

agent({ name: "todo-counter" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "todo-counter", version: "0.1.0" },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    // stdout is the protocol channel; logs go to stderr
    console.error(`[agent] session/new cwd=${params.cwd} mcpServers=${params.mcpServers.length}`);
    return { sessionId: "sess_1" };
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const path = `${process.env.ACP_CWD}/notes.md`;
    const say = (text: string) =>
      client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });

    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "call_1", title: `Read ${path}`, kind: "read", status: "pending" },
    });

    const decision = await client.request(methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: { toolCallId: "call_1" },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Reject", kind: "reject_once" },
      ],
    });
    if (decision.outcome.outcome !== "selected" || decision.outcome.optionId !== "allow") {
      await say("Permission denied, not reading the file.");
      return { stopReason: "end_turn" };
    }

    const { content } = await client.request(methods.client.fs.readTextFile, { sessionId: params.sessionId, path });
    const todos = content.split("\n").filter((l) => l.includes("TODO")).length;
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" },
    });
    await say(`notes.md has ${todos} TODO lines.`);
    return { stopReason: "end_turn" };
  })
  .connect(stream);
```

The editor side is the mirror image. It answers the agent's requests (permission, file reads) and prints the notifications:

```typescript
// client.ts -- ACP v1, @agentclientprotocol/sdk 2.4.0, Node 26
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const cwd = process.cwd();
const child = spawn("node", ["agent.ts"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ACP_CWD: cwd } });
const stream = ndJsonStream(
  Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
);

const editor = client({ name: "tiny-editor" })
  .onNotification(methods.client.session.update, ({ params }) => {
    const u = params.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") console.log(`[agent says] ${u.content.text}`);
    else console.log(`[update] ${u.sessionUpdate}`);
  })
  .onRequest(methods.client.session.requestPermission, ({ params }) => {
    console.log(`[permission] ${params.toolCall.toolCallId} -> allow`);
    return { outcome: { outcome: "selected", optionId: "allow" } };
  })
  .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
    console.log(`[fs] read ${params.path}`);
    return { content: await readFile(params.path, "utf8") };
  });

await editor.connectWith(stream, async (agentCtx) => {
  const init = await agentCtx.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
    clientInfo: { name: "tiny-editor", version: "0.1.0" },
  });
  console.log(`[init] agent=${init.agentInfo?.name} protocolVersion=${init.protocolVersion}`);

  const { sessionId } = await agentCtx.request(methods.agent.session.new, { cwd, mcpServers: [] });
  const res = await agentCtx.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "How many TODOs are in notes.md?" }],
  });
  console.log(`[stop] ${res.stopReason}`);
});
child.kill();
```

Output of `node client.ts` (the `cwd` path shortened here):

```text
[init] agent=todo-counter protocolVersion=1
[agent] session/new cwd=/.../acp mcpServers=0
[update] tool_call
[permission] call_1 -> allow
[fs] read /.../acp/notes.md
[update] tool_call_update
[agent says] notes.md has 2 TODO lines.
[stop] end_turn
```

Two things in that trace have no MCP equivalent. The agent paused mid-turn to ask the *editor* for a human decision, and it read a file through the editor rather than from disk. In an MCP-only world, the file read would be a tool on some server, and the server would see the saved file, not the buffer the user is looking at.

To run the same agent inside a real editor, register the command. In Zed, add an `agent_servers` entry with `"type": "custom"`, a `command`, and `args` (see [Zed's external agents docs](https://zed.dev/docs/ai/external-agents)). In JetBrains IDEs, AI Chat's "Add Custom Agent" creates `~/.jetbrains/acp.json` with the same `agent_servers` shape (see the [JetBrains ACP docs](https://www.jetbrains.com/help/ai-assistant/acp.html)). Production agents work the same way: Copilot CLI becomes an ACP agent with `copilot --acp` (or `copilot --acp --port 8080` over TCP), per the [January 2026 changelog](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/).

## When to pick ACP

- **You are building a frontend for agents.** An editor plugin, a desktop chat app, a Slack bot, or a CI runner that should work with Copilot CLI, Gemini CLI, Goose, and Claude Agent without four integrations. Implement the ACP client side once; the [agents list](https://agentclientprotocol.com/get-started/agents) is already long.
- **You are shipping an agent and want it in every editor.** Implement the ACP agent side once and you appear in Zed, JetBrains IDEs and Air, and the Neovim and Emacs plugins. That is how Copilot reached JetBrains Air.
- **Your agent must edit what the user sees.** ACP's `fs/*` methods go through the editor, so unsaved buffers, diffs, and review UIs work. The editor can render a `tool_call` with `kind: "edit"` as a reviewable diff.
- **You are driving an agent programmatically.** A test harness or batch job that runs `copilot --acp` and scripts prompts gets structured stop reasons and tool events instead of scraping terminal output. Agent Framework users get a typed wrapper for that via the [Copilot CLI provider](/2026/08/agent-framework-github-copilot-provider-copilot-cli-as-aiagent/).

## When to pick MCP

- **You are exposing tools or data.** A database, an internal API, a browser, a ticket system. MCP servers are reused by every agent and every host, ACP-based or not. See [how to build an MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/).
- **You need a remote, authenticated service today.** MCP has a finished Streamable HTTP transport with OAuth 2.1. ACP's own transport page lists only stdio as defined; remote ACP is still an RFD.
- **Your work outlives a chat turn.** MCP's [Tasks extension](/2026/11/what-is-the-mcp-tasks-extension-and-when-do-you-need-poll-based-long-running-tools/) gives you durable, pollable tool calls. ACP sessions are about the conversation, not about a job that runs for an hour on someone else's server.

## The gotchas that decide it for you

**Stdout is sacred on both, but the cost of breaking it differs.** The ACP transport spec says the agent "MUST NOT write anything to its stdout that is not a valid ACP message", and messages are newline-delimited with no embedded newlines. A stray `console.log` in an ACP agent corrupts the editor connection, the same failure mode as a [stdio MCP server that hangs under Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/). Log to stderr; editors such as Zed expose it (`dev: open acp logs`).

**Paths must be absolute.** ACP requires absolute paths everywhere, `cwd` included, and line numbers are 1-based. Agents that resolve relative paths against their own working directory break as soon as an editor launches them from somewhere else.

**Capabilities are opt-in on both sides.** An omitted capability means unsupported. If the client did not advertise `fs.writeTextFile`, the agent must write files itself or not at all, and if the agent did not advertise `mcpCapabilities.http`, the editor should not pass it HTTP MCP servers. Check `initialize` results instead of assuming.

**Version numbering is different.** MCP negotiates a date string; ACP negotiates an integer major version. The TypeScript SDK's default import is v1, and v2 lives behind `@agentclientprotocol/sdk/experimental/v2` with an explicit warning that its wire format may change in any release. Ship v1.

**Billing and governance follow the agent, not the protocol.** In JetBrains Air, Copilot tasks "use your Copilot plan rather than JetBrains AI credits", and Air's analytics do not include Copilot usage. In Zed, the Claude Agent "owns its own authentication and billing". ACP moves prompts and events; it does not federate accounts. Cloud execution is also the agent host's business: Air runs Copilot cloud tasks in a Docker container on a fresh VM, which is a different sandbox model from Copilot's own, compared in [local sandbox vs cloud sandbox vs dev container](/2026/10/copilot-local-sandbox-vs-cloud-sandbox-vs-dev-container/).

## The recommendation, restated

Pick by direction. Facing the human (editor, UI, harness driving an agent): ACP v1, with `@agentclientprotocol/sdk` 2.4.0 in TypeScript, `agent-client-protocol` on PyPI or crates.io for Python and Rust. Facing the tools (anything an agent should call): MCP `2026-07-28`. If you are writing an agent, do both, and pass the `mcpServers` from `session/new` straight through to your MCP client so the user's tool configuration follows them from editor to editor.

## Sources

- [Agent Client Protocol: introduction](https://agentclientprotocol.com/overview/introduction) and [protocol overview](https://agentclientprotocol.com/protocol/overview)
- [ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup), [prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn), and [transports](https://agentclientprotocol.com/protocol/v1/transports)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) (`@agentclientprotocol/sdk` 2.4.0, published 2026-11-02)
- [GitHub Copilot is now available in JetBrains Air](https://github.blog/changelog/2026-11-03-github-copilot-is-now-available-in-jetbrains-air/) (GitHub changelog, 2026-11-03)
- [ACP support in Copilot CLI is now in public preview](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/) (GitHub changelog, 2026-01-28)
- [Zed: external agents](https://zed.dev/docs/ai/external-agents) and [JetBrains AI Assistant: ACP](https://www.jetbrains.com/help/ai-assistant/acp.html)
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification)
