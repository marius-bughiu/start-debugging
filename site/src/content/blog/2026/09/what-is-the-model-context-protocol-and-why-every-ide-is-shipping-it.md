---
title: "What Is the Model Context Protocol, and Why Is Every IDE Shipping It?"
description: "MCP is a JSON-RPC protocol that lets any AI host call tools, read resources and use prompts from any server, the way LSP did for language support. Here is how it works on the wire under revision 2026-07-28, captured from a real server, and why VS Code, Visual Studio, JetBrains, Xcode, Zed and Cursor all converged on it."
pubDate: 2026-09-30
template: how-to
tags:
  - "mcp"
  - "ai-agents"
  - "llm"
  - "claude-code"
  - "cursor"
  - "github-copilot"
---

**Short answer:** the Model Context Protocol (MCP) is an open JSON-RPC 2.0 protocol that lets an AI application (the *host*: Claude Code, VS Code, Cursor, Xcode) talk to external programs (*servers*) that expose three things: **tools** the model can call, **resources** the host can attach as context, and **prompts** the user can invoke. Every IDE ships it for the same reason every editor shipped the Language Server Protocol: without a shared protocol, `M` AI clients times `N` integrations means `M x N` custom adapters, and with it you write the GitHub, database or build-system integration once and it works everywhere. The current spec revision is `2026-07-28`, which made every request stateless, and everything below was run against `@modelcontextprotocol/server` 2.2.0 on Node 26.

## The problem MCP was built to delete

Before MCP, each AI tool had its own way to plug things in. ChatGPT had plugins with an OpenAPI manifest, Copilot had extensions, and every agent framework had its own function-calling wrapper. If you maintained, say, an internal deployment API and wanted it usable from three assistants, you wrote three integrations with three auth stories, and redid them whenever a vendor changed its plugin format.

Anthropic open-sourced MCP in November 2024 with a deliberately boring premise: take the design that already worked for programming languages and apply it to AI context. The [specification says so directly](https://modelcontextprotocol.io/specification/2026-07-28): MCP "takes some inspiration from the Language Server Protocol". LSP turned "support Rust in 40 editors" into "write one rust-analyzer". MCP turns "give 10 assistants access to Jira" into "write one Jira server".

The adoption numbers made it a de facto standard fast. When Anthropic [donated MCP to the Agentic AI Foundation](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation) under the Linux Foundation on December 9, 2025, it cited more than 10,000 active public servers and 97 million monthly SDK downloads across Python and TypeScript, with ChatGPT, Cursor, Gemini, Microsoft Copilot and VS Code already on board. The foundation was co-founded by Anthropic, Block and OpenAI, which is the part that matters for an IDE vendor: the protocol is no longer one model provider's format, so betting on it is not betting on a competitor.

## Three roles: host, client, server

The spec defines three participants, and the naming trips people up because "client" does not mean the app:

- **Host**: the application the user runs. Claude Code, VS Code with Copilot, Cursor, Visual Studio, Xcode, Zed.
- **Client**: a connector inside the host. The host creates one client per server it connects to.
- **Server**: the program that exposes capabilities. It can be a local process (the GitHub server launched with `npx`) or a remote HTTP endpoint (`https://api.githubcopilot.com/mcp`).

The host owns the model, the conversation and the permission UI. The server never sees the conversation unless the host chooses to send part of it. That split is why MCP servers are cheap to write: a server is just a program that answers a handful of JSON-RPC methods, and it never has to know which model is on the other side.

## Tools, resources and prompts are controlled by different parties

The three server primitives look similar on the wire, but the real difference is who decides when they are used:

| Primitive | Who triggers it | Typical host UI | Methods |
| --- | --- | --- | --- |
| Tools | The model | Tool picker, approval prompt | `tools/list`, `tools/call` |
| Resources | The host or the user | `#` references, attach-context menus | `resources/list`, `resources/read` |
| Prompts | The user | Slash commands, prompt pickers | `prompts/list`, `prompts/get` |

Tools get all the attention because they are what turns a chat model into an agent, but resources and prompts are where IDE integration shows. Visual Studio, for example, lets you reference an MCP resource in Copilot Chat with `#` and insert MCP prompts through **Add Reference > Prompts**, per its [MCP documentation](https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers).

Clients can offer features back to servers too. Under `2026-07-28` the main one is **elicitation**: a server asking the user for a missing value in the middle of a tool call, now expressed as a result that says "input required" plus a client retry, instead of a server-initiated request on an open stream.

## A complete server in 50 lines

Here is a server that exposes one of each primitive. It runs as a stdio process, which is how most IDEs launch local servers:

```ts
// server.ts
// @modelcontextprotocol/server 2.2.0, MCP protocol revision 2026-07-28, Node 26
// package.json needs "type": "module"; Node 26 runs .ts files directly.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

serveStdio(() => {
  const server = new McpServer(
    { name: 'repo-notes', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // Tool: the model decides when to call it.
  server.registerTool(
    'count_todos',
    {
      description: 'Counts TODO comments in a file. Read-only.',
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.object({ count: z.number() }),
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      const text = await readFile(path, 'utf8');
      const count = (text.match(/\bTODO\b/g) ?? []).length;
      return {
        content: [{ type: 'text', text: `${count} TODOs in ${path}` }],
        structuredContent: { count },
      };
    },
  );

  // Resource: the host (or the user) decides when to attach it.
  server.registerResource(
    'conventions',
    'notes://conventions',
    { title: 'Team conventions', mimeType: 'text/markdown' },
    async (uri) => ({
      contents: [{ uri: uri.href, text: '- Tests live next to the code.\n- No default exports.' }],
    }),
  );

  // Prompt: the user picks it, usually as a slash command.
  server.registerPrompt(
    'triage',
    { description: 'Triage the TODOs in one file', argsSchema: z.object({ path: z.string() }) },
    ({ path }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Call count_todos on ${path}, then rank the TODOs by risk.` } }],
    }),
  );

  return server;
});
```

Install with `npm i @modelcontextprotocol/server@2.2.0 zod` and it is ready for any host. Note that `serveStdio` takes a *factory*, not a server instance. The SDK decides per connection whether the client speaks the new stateless revision or the older `2025-11-25` handshake and builds one server instance for that connection. More on why that matters below.

## What actually goes over the wire

The stdio transport is newline-delimited JSON on the child process's stdin and stdout. I drove the server above with a 10-line Node script that writes raw JSON-RPC lines, so the following is captured output, not an illustration.

Under `2026-07-28` there is no handshake. Every request carries its protocol version and the client's capabilities in `_meta`. The first thing I tried was sending only the version, and the server rejected it with a precise error:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32602,
 "message":"Invalid _meta envelope for protocol revision 2026-07-28: io.modelcontextprotocol/clientCapabilities: missing",
 "data":{"envelope":{"key":"io.modelcontextprotocol/clientCapabilities","problem":"missing"}}}}
```

With both keys present, a client typically starts with `server/discover`, the method that replaced the `initialize` result as the place to learn what a server can do:

```json
>> {"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{
     "io.modelcontextprotocol/protocolVersion":"2026-07-28",
     "io.modelcontextprotocol/clientCapabilities":{}}}}
<< {"result":{"supportedVersions":["2026-07-28"],
     "capabilities":{"tools":{"listChanged":true},"resources":{"listChanged":true},"prompts":{"listChanged":true}},
     "resultType":"complete","ttlMs":0,"cacheScope":"private",
     "_meta":{"io.modelcontextprotocol/serverInfo":{"name":"repo-notes","version":"1.0.0"}}},
   "jsonrpc":"2.0","id":1}
```

Then `tools/list`. This is the payload the host turns into the tool definitions it sends to the model, and the JSON Schema here is generated from the zod schema:

```json
<< {"result":{"tools":[{"name":"count_todos",
     "description":"Counts TODO comments in a file. Read-only.",
     "inputSchema":{"type":"object","$schema":"https://json-schema.org/draft/2020-12/schema",
       "properties":{"path":{"type":"string"}},"required":["path"]},
     "annotations":{"readOnlyHint":true},
     "outputSchema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",
       "properties":{"count":{"type":"number"}},"required":["count"],"additionalProperties":false}}],
   "resultType":"complete","ttlMs":0,"cacheScope":"private", ...}}
```

When the model decides to use the tool, the host sends `tools/call` and gets both a human-readable `content` block and machine-readable `structuredContent`:

```json
>> {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"count_todos",
     "arguments":{"path":"sample.js"},"_meta":{...}}}
<< {"result":{"content":[{"type":"text","text":"2 TODOs in sample.js"}],
     "structuredContent":{"count":2},"resultType":"complete", ...},"jsonrpc":"2.0","id":3}
```

`resources/read` on `notes://conventions` and `prompts/get` on `triage` came back the same way, the first with a `contents` array, the second with a `messages` array ready to drop into the conversation. That is the whole protocol surface a basic integration needs: five methods and a `_meta` envelope.

Two details in that output are worth noticing. `ttlMs: 0` and `cacheScope: "private"` are the defaults the SDK attaches to list results. Because `2026-07-28` forbids `tools/list` from varying per connection, a host is allowed to cache the list, and a server that sets a real TTL saves every client a round trip. And `resultType: "complete"` is the other half of the new elicitation model: a tool that needs user input returns `"input_required"` instead and the client retries.

## The same server still works with older hosts

Not every IDE had moved to `2026-07-28` when this was written, which is exactly why `serveStdio` takes a factory. Sending the old handshake to the same process:

```json
>> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25",
     "capabilities":{},"clientInfo":{"name":"old-ide","version":"1"}}}
<< {"result":{"protocolVersion":"2025-11-25",
     "capabilities":{"tools":{"listChanged":true},"resources":{"listChanged":true},"prompts":{"listChanged":true}},
     "serverInfo":{"name":"repo-notes","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
>> {"jsonrpc":"2.0","method":"notifications/initialized"}
>> {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"count_todos","arguments":{"path":"sample.js"}}}
<< {"result":{"content":[{"type":"text","text":"2 TODOs in sample.js"}],"structuredContent":{"count":2}},"jsonrpc":"2.0","id":2}
```

One server, both eras, no code changes. If you ever see error `-32022` instead, one side is pinned to a single revision, and [the unsupported protocol version fix](/2026/08/fix-mcp-unsupported-protocol-version-2025-11-25-vs-2026-07-28/) walks through making it dual-era. For what the stateless revision removed and how to port a server that relied on sessions, see [stateful vs stateless MCP servers](/2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away/).

## Why every IDE converged on it

The LSP analogy explains the economics, but there are three more specific reasons IDE vendors moved in the space of about a year.

**The integration catalog is someone else's problem.** An IDE vendor that ships MCP client support instantly gets every server in the ecosystem: GitHub, Playwright, Figma, databases, cloud CLIs. Building those as first-party extensions would take years. VS Code made MCP [generally available in 1.102](https://code.visualstudio.com/updates/v1_102) in July 2025 with an MCP gallery in the Extensions view, and GitHub made Copilot's MCP support [GA for JetBrains, Eclipse and Xcode](https://github.blog/changelog/2025-08-13-model-context-protocol-mcp-support-for-jetbrains-eclipse-and-xcode-is-now-generally-available/) a month later.

**The IDE can be a server, not just a client.** This is the less obvious half. An IDE knows things no terminal agent does: the resolved symbol graph, the debugger state, the run configurations, the simulator. Exposing that as an MCP server lets *any* agent use it. [IntelliJ IDEA 2025.2 ships an integrated MCP server](https://www.jetbrains.com/help/idea/mcp-server.html) that auto-configures Claude Code, Codex, VS Code and GitHub Copilot CLI, and exposes tools for symbol lookup, refactoring, breakpoints and run configurations. Xcode 26.3 does the same through `xcrun mcpbridge`, which translates MCP to Xcode's internal XPC interface so agents can build, run tests and capture SwiftUI previews. Registering it in Claude Code is one line:

```bash
# Claude Code 2.x, Xcode 26.3 or later
claude mcp add --transport stdio xcode -- xcrun mcpbridge
```

**Enterprises needed a governable surface.** A protocol with a known shape can be allow-listed, audited and proxied. Visual Studio enforces GitHub organization MCP allow lists, resets tool approvals when a server fires `notifications/tools/list_changed` (explicitly to prevent "rug-pull" attacks), and since Visual Studio 2026 18.7 asks you to re-trust a server whose configuration or capabilities changed. None of that is possible when each integration is an opaque extension. If you administer this for a team, [controlling which MCP servers a team can run](/2026/08/centrally-control-which-mcp-servers-a-team-can-run/) covers the policy side.

## One protocol, five config files

The protocol is standard. The config files that point a host at a server are not, and this is the first thing that bites when you move between tools:

| Host | Project file | Top-level key | Notes |
| --- | --- | --- | --- |
| Claude Code | `.mcp.json` | `mcpServers` | `claude mcp add --scope project` writes it |
| Cursor | `.cursor/mcp.json` | `mcpServers` | Global: `~/.cursor/mcp.json` |
| VS Code | `.vscode/mcp.json` | `servers` | Also reads a portable `.mcp.json` with `mcpServers` |
| Visual Studio 17.14+ | `.mcp.json`, `.vs/mcp.json` | `servers` in the docs' example | Also reads `.vscode/mcp.json` and `.cursor/mcp.json` |
| Zed | `settings.json` | `context_servers` | Zed's name for MCP servers |
| JetBrains AI Assistant | settings UI (JSON) | `mcpServers` | Has "Import from Claude" |

The practical move for a shared repo is a single committed `.mcp.json` with `mcpServers`, which Claude Code, VS Code and Visual Studio all pick up, plus a `.cursor/mcp.json` if your team uses Cursor:

```json
{
  "mcpServers": {
    "repo-notes": {
      "command": "node",
      "args": ["tools/repo-notes/server.ts"]
    },
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

## Hosts do not implement the whole spec

"Supports MCP" is not a single checkbox. Hosts implement the parts that fit their UI, and the gaps are real:

- [Zed documents](https://zed.dev/docs/ai/mcp) support for tools and prompts only, and asks for contributions for discovery, sampling and elicitation.
- [Cursor lists](https://cursor.com/docs/context/mcp) tools, prompts, resources, roots, elicitation and MCP Apps.
- Visual Studio supports tools, prompts, resources, resource templates and sampling with a confirmation dialog.

Design for the lowest common denominator. If a capability is essential, make it a tool, because tools are the one primitive every host supports and the model can reach without the user doing anything. Put the same information in a resource as well if you want hosts with a resource picker to show it nicely.

## Gotchas that catch first-time server authors

**Never write to stdout from a stdio server.** Stdout is the protocol channel. A stray `console.log` corrupts the stream and most hosts report it as a disconnected server. Log to stderr.

**Tool descriptions are prompt text.** The model chooses tools from their names and descriptions, and every tool's schema costs context tokens on every turn. A server with 80 tools can eat a large part of the window before the user types anything, which is why [trimming the number of MCP tools a client loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/) is a real optimization, not a nicety.

**Annotations are hints, not guarantees.** `readOnlyHint: true` lets a host skip a confirmation prompt, but the spec says to treat annotations as untrusted unless the server is. Do not rely on them as a security boundary on either side.

**Remote servers need real auth.** A local stdio server inherits your user account. A remote HTTP server needs OAuth per the MCP authorization spec, which VS Code, Visual Studio and Claude Code all implement. Choosing between local and remote is its own decision, covered in [stdio vs HTTP vs SSE transport](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/). SSE is deprecated in favor of Streamable HTTP.

**MCP is agent-to-tool, not agent-to-agent.** If what you want is two agents negotiating with each other, that is a different protocol, and [A2A vs MCP](/2026/07/a2a-protocol-vs-mcp-agent-to-agent-vs-agent-to-tool/) draws the line.

## Where MCP fits next to everything else

MCP is not the only way to give a model tools. If you own the app and the model call end to end, plain function calling is less machinery. MCP pays off the moment you want the same integration in more than one host, which, given the table above, is almost always the case for anything a developer uses in an IDE. [MCP vs OpenAPI plugins vs custom tool calling](/2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents/) goes through that trade-off, and [skills vs subagents vs MCP servers](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/) covers when an MCP server is the wrong tool entirely. When you are ready to build one for real, [wrapping a CLI in a TypeScript MCP server](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) is the fastest useful first project.

### Sources

- [MCP specification, revision 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [Donating MCP to the Agentic AI Foundation](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation), Anthropic, December 9, 2025
- [VS Code 1.102 release notes](https://code.visualstudio.com/updates/v1_102) and [MCP servers in VS Code](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
- [Use MCP servers in Visual Studio](https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers)
- [IntelliJ IDEA MCP server](https://www.jetbrains.com/help/idea/mcp-server.html) and [AI Assistant MCP client](https://www.jetbrains.com/help/ai-assistant/mcp.html)
- [Copilot MCP support GA for JetBrains, Eclipse and Xcode](https://github.blog/changelog/2025-08-13-model-context-protocol-mcp-support-for-jetbrains-eclipse-and-xcode-is-now-generally-available/)
- [Cursor MCP docs](https://cursor.com/docs/context/mcp), [Zed MCP docs](https://zed.dev/docs/ai/mcp), [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
