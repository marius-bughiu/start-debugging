---
title: "Fix: HTTP MCP Server URL Won't Connect in Claude Desktop (stdio vs HTTP Transport)"
description: "Claude Desktop's claude_desktop_config.json only validates stdio servers. Drop a 'url' field in and it silently strips the entry, crashes on startup, or boots with zero tools. Use a custom connector for remote URLs and mcp-remote as a stdio bridge for local HTTP servers."
pubDate: 2026-05-28
tags:
  - "mcp"
  - "claude-code"
  - "ai-agents"
  - "anthropic-sdk"
---

If you paste an HTTP MCP server URL into `claude_desktop_config.json` and Claude Desktop ignores it, drops the whole `mcpServers` block on the next save, or refuses to launch, you ran into the transport mismatch. Claude Desktop's local config schema validates **stdio** servers only. The `url` and `type: "http"` fields you see in Claude Code docs and on every "remote MCP" landing page are parsed by a different client. Two fixes work today: register the remote server as a **Custom Connector** in Settings, or wrap it with the `mcp-remote` stdio bridge in `claude_desktop_config.json`.

This post explains why the mismatch exists, walks through both fixes, and shows when to pick which. Everything below is tested against Claude Desktop 0.13.x on Windows and macOS, Claude Code 2.1.128 (for the contrast), `mcp-remote` 0.1.x, the MCP TypeScript SDK 1.29.0, the Python SDK 1.13.0, and the MCP specification dated [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), which formalises Streamable HTTP and keeps stdio as the second of the two standard transports.

## TL;DR

`claude_desktop_config.json` is a stdio-only file. Use one of the two paths below, never both for the same server.

1. **Public HTTPS endpoint with OAuth or an API key.** Add it as a Custom Connector in `Settings -> Connectors -> Add custom connector`. Anthropic's cloud connects to it via Streamable HTTP. No JSON editing.
2. **Local HTTP server on `http://localhost:PORT/mcp`.** Keep `claude_desktop_config.json`, but launch `npx mcp-remote <url>` as a stdio process. Claude Desktop speaks stdio to `mcp-remote`; `mcp-remote` speaks Streamable HTTP to your server.

If you already pasted `"url": "..."` into `claude_desktop_config.json`, delete that entry before you restart the app. Recent builds silently strip the broken `mcpServers` map on load, taking your good stdio entries with it ([anthropics/claude-code#37286](https://github.com/anthropics/claude-code/issues/37286), [#30327](https://github.com/anthropics/claude-code/issues/30327)).

## Why the config file does not accept a URL

MCP defines [two standard transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): **stdio**, where the client launches the server as a subprocess and exchanges newline-delimited JSON-RPC over `stdin`/`stdout`; and **Streamable HTTP**, where the server runs independently and the client POSTs JSON-RPC to a single MCP endpoint that also supports GET for SSE streaming. The 2025-11-25 spec retains both, deprecates the older HTTP+SSE transport from `2024-11-05`, and tells clients they `SHOULD` support stdio whenever possible.

Claude Desktop made a deliberately narrow choice. Its `claude_desktop_config.json` parser, gated by a Zod schema, accepts only the stdio shape:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./server.js"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

`command` is required. Pass `url`, `type`, `transport`, or any other Streamable-HTTP-flavoured key and validation fails. Older Claude Desktop builds crashed on startup with `TypeError: Cannot read properties of undefined (reading 'value')` because the Zod parser threw before the renderer mounted ([anthropics/claude-code#30327](https://github.com/anthropics/claude-code/issues/30327)). Newer builds catch the parse error, but then rewrite the file on next save and drop your `mcpServers` block entirely ([anthropics/claude-code#37286](https://github.com/anthropics/claude-code/issues/37286)). Either way, the URL never reaches a connection attempt.

This is also where confusion creeps in. **Claude Code** (the CLI, currently 2.1.128) reads `~/.claude.json` and does support a richer schema with `type: "http"`, `type: "sse"`, and direct `url` fields. Documentation that targets Claude Code looks like it should work in Claude Desktop. It does not. The two clients are different products with different parsers.

## Fix 1: register a Custom Connector for a remote URL

If your MCP server is reachable on the public internet, the cleanest fix is to skip `claude_desktop_config.json` entirely and use the Connectors UI. This is the path Anthropic added in late 2025 specifically to take HTTP MCP servers out of the local config file.

Open Claude Desktop, then go to `Settings -> Connectors -> Add custom connector`. Paste the MCP endpoint URL, for example `https://mcp.example.com/mcp`. If the server uses OAuth, fill in the client ID and (optionally) client secret; Claude runs the full OAuth 2.1 + PKCE flow before the first request. Save, then start a new chat. The connector's tools show up in the model's tool list within a second or two.

What this actually does, per Anthropic's [custom connectors help article](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp): your local Claude Desktop sends the connector URL to Anthropic's cloud. The cloud, not your machine, opens the Streamable HTTP connection to your server. That has two consequences worth knowing before you debug a "won't connect" symptom in this mode:

- The server **must be reachable from Anthropic's public IP ranges**. Servers on a private corporate network, behind a VPN with no public ingress, or fronted by a firewall that whitelists your laptop will never connect. `localhost` URLs are a hard no for Custom Connectors. Try the next section instead.
- TLS is effectively mandatory. The cloud will refuse self-signed certificates without an intermediate proxy. If you are pre-production, use a public tunnel (Cloudflare Tunnel, ngrok with a reserved domain, Tailscale Funnel) that terminates a real certificate.

Custom Connectors are available on Free (one connector limit), Pro, Max, Team, and Enterprise plans, on Claude Desktop, claude.ai, and Cowork. The same connector entry works across all three.

## Fix 2: bridge a local HTTP server with `mcp-remote`

If your server runs on `http://localhost:PORT/mcp`, Custom Connectors will not see it. The fix is to keep using `claude_desktop_config.json`, but configure a stdio-launched shim that internally talks Streamable HTTP to your server. The de facto bridge is [mcp-remote](https://www.npmjs.com/package/mcp-remote), a Node 18+ proxy maintained as part of the broader MCP tooling ecosystem.

Edit `claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "my-local-http-server": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8080/mcp",
        "--transport",
        "http-only"
      ]
    }
  }
}
```

On Windows the file lives at `%APPDATA%\Claude\claude_desktop_config.json`. On macOS, at `~/Library/Application Support/Claude/claude_desktop_config.json`. Restart Claude Desktop, then check `Settings -> Developer -> MCP Servers`. The entry should report `connected` with the tool count your server publishes.

A few details that catch people:

- **Use `127.0.0.1`, not `localhost`.** Node's DNS resolution returns `::1` first on many systems, but local servers often bind IPv4 only. The same trap shows up when [a local MCP server starts before the client is ready](/2026/05/fix-econnrefused-when-a-local-mcp-server-starts-before-the-client-is-ready/), with `ECONNREFUSED` as the symptom instead of a hang.
- **Pin `--transport http-only` if your server does not implement the SSE half of Streamable HTTP.** `mcp-remote` defaults to negotiating SSE first and falling back; the explicit flag avoids a five-second backoff per launch.
- **Add `-y` to `npx`.** Without it the first launch blocks waiting for an install confirmation, which manifests as the same stdio hang covered in [the Claude Code stdio post](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/).
- **Headers go through `--header`.** Pass an API key with `"--header", "Authorization: Bearer ${TOKEN}"` and an `env` block; do not bake it into the URL.

Full version with auth:

```json
{
  "mcpServers": {
    "my-local-http-server": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8080/mcp",
        "--transport",
        "http-only",
        "--header",
        "Authorization: Bearer ${API_TOKEN}"
      ],
      "env": {
        "API_TOKEN": "sk-local-dev-..."
      }
    }
  }
}
```

`mcp-remote` writes detailed logs to `~/.mcp-auth/<server-hash>_debug.log` when you pass `--debug`. That file is the first thing to read if the connector reports `connected` but no tools register.

## A minimal Streamable HTTP server to test against

To verify the bridge end-to-end, here is a minimal MCP server in TypeScript that speaks Streamable HTTP and exposes one tool. Useful as a known-good fixture when you are debugging which side is broken.

```typescript
// server.ts -- MCP TypeScript SDK 1.29.0, MCP spec 2025-11-25
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";

const server = new Server(
  { name: "demo", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "echo",
    description: "Echo the input back",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: String(req.params.arguments?.text ?? "") }]
}));

const app = express();
app.use(express.json());

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID()
});
await server.connect(transport);

app.all("/mcp", (req, res) => transport.handleRequest(req, res, req.body));
app.listen(8080, "127.0.0.1", () => console.error("MCP server on http://127.0.0.1:8080/mcp"));
```

Two things to notice. The `console.error` log goes to stderr because stdout is reserved for stdio servers; on an HTTP server that does not strictly matter, but keeping the habit means the same code drops into a stdio context unchanged. And the listen address is `127.0.0.1`, not `0.0.0.0`. The spec explicitly requires local Streamable HTTP servers to bind loopback to prevent DNS rebinding attacks ([transports security section](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)), and `mcp-remote` will happily talk to a loopback address.

Hit the endpoint directly to confirm it is alive before you point Claude Desktop at it:

```bash
curl -i -X POST http://127.0.0.1:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-11-25" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

A healthy response is HTTP 200 with `Content-Type: application/json` (or `text/event-stream`) and an `MCP-Session-Id` header. If `curl` succeeds and Claude Desktop still cannot see the tools, the problem is the bridge configuration, not the server.

## When neither fix is what you want

Two cases where you should reach for a different tool entirely.

**You actually wanted Claude Code, not Claude Desktop.** Claude Code 2.1.x supports HTTP transport natively in `~/.claude.json`:

```json
{
  "mcpServers": {
    "my-http-server": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

No bridge, no UI dance. The product split is real: Claude Desktop optimises for end users who never see a config file (hence the Connectors UI); Claude Code optimises for developers who do. If you live in a terminal anyway, switch and the problem evaporates. The same goes for [building a custom MCP server in TypeScript](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) and pointing Claude Code at it directly.

**You are building a desktop-distributable MCP server.** Custom Connectors only ship one URL. `mcp-remote` requires your users to have Node installed, edit a JSON file, and know what `127.0.0.1` means. Neither is a great experience for end users. Anthropic has [Desktop Extensions](https://support.claude.com/en/articles/10065433-installing-extensions-on-claude-desktop) (`.dxt` packages) precisely for this case: a stdio MCP server, plus a manifest, packaged as a one-click install. Bundle as a `.dxt`, distribute the file, and your users never see `claude_desktop_config.json` at all.

## Gotchas worth knowing

- **The "transport" field is a moving target.** The 2024-11-05 spec defined HTTP+SSE with separate POST and SSE endpoints; the 2025-03-26 spec replaced that with Streamable HTTP on one endpoint; 2025-11-25 keeps Streamable HTTP and tightens session header rules. `mcp-remote` supports both old and new; older `--transport sse` flags still work but log a deprecation notice. New servers should target Streamable HTTP.
- **OAuth tokens cache under `~/.mcp-auth/`.** If a Custom Connector or `mcp-remote --auth` session breaks after a token rotation, delete the matching `<server-hash>` folder and restart. The bridge will re-run the OAuth dance.
- **Origin header validation will reject non-localhost reverse proxies.** A Streamable HTTP server bound on `127.0.0.1` that you front with an LAN nginx will get a 403 Forbidden from the server itself, not from Claude Desktop. The spec requires `Origin` validation to defend against DNS rebinding; bypass it in dev with an explicit allowlist on the server, not by punching a hole in `mcp-remote`.
- **`MCP-Protocol-Version` is now mandatory on every HTTP request after init.** If your server returns 400 on the second call because the client omitted the header, you are running on an SDK version older than the 2025-11-25 spec rollout. Upgrade the server SDK; the bridge already sends the header.
- **Restart, do not reload.** Claude Desktop reads `claude_desktop_config.json` once at process start. Editing it while the app is open does nothing until you quit from the system tray (Windows) or `Cmd-Q` (macOS) and relaunch. Closing the window is not enough.

## Related

- [Fix: ECONNREFUSED When a Local MCP Server Starts Before the Client Is Ready](/2026/05/fix-econnrefused-when-a-local-mcp-server-starts-before-the-client-is-ready/) covers the failure mode one layer deeper, once the bridge is talking to your server.
- [Fix: MCP Server stdio Hang When Launched From Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/) covers the stdio side of the same architectural split.
- [How to Build a Custom MCP Server in TypeScript That Wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) starts from an empty repo and walks through the same SDK used in the test server above.
- [How to Reduce the Number of MCP Tools Claude Loads to Avoid the Tool-Use Limit](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/) for what to do once you have several connected servers fighting for the same tool budget.
- [How to Build a Custom MCP Server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) for the .NET side of the same transport story, with the same Streamable HTTP plumbing on the server end.

## Source links

- MCP specification, [Transports (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
- Claude Help Center, [Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
- `mcp-remote` on npm, [package and usage docs](https://www.npmjs.com/package/mcp-remote).
- `anthropics/claude-code` issue [#30327](https://github.com/anthropics/claude-code/issues/30327): Claude Desktop crashes when config uses HTTP transport without `command`.
- `anthropics/claude-code` issue [#37286](https://github.com/anthropics/claude-code/issues/37286): Claude Desktop silently destroys `claude_desktop_config.json` when an MCP server uses the `url` field.
