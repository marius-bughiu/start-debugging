---
title: "Fix: MCP Server Throws \"fetch is not defined\" and EBADENGINE on Node.js Below 18"
description: "An MCP server on Node 16 warns EBADENGINE at install, then dies with 'fetch is not defined' on the first tool call. Upgrade to Node 18+ (20+ for the 2.x SDK) or polyfill the web globals."
pubDate: 2026-07-20
template: error-page
tags:
  - "errors"
  - "mcp"
  - "claude-code"
  - "ai-agents"
  - "node-js"
---

If your MCP server prints `npm warn EBADENGINE Unsupported engine` at install and later crashes with `ReferenceError: fetch is not defined` or `ReferenceError: ReadableStream is not defined`, the runtime is too old. The official `@modelcontextprotocol/sdk` requires Node 18 or newer (Node 20+ on the `2.0.0` line), and it assumes web globals that older Node does not expose. Upgrade Node, point your MCP client at the new binary, and the errors disappear. This is written against `@modelcontextprotocol/sdk@1.29.0` and `2.0.0-alpha.0`.

## The errors, verbatim

There are two surfaces, and searchers land here from both. The first shows up at install time and is only a warning, so most people scroll past it:

```text
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@modelcontextprotocol/sdk@1.29.0',
npm warn EBADENGINE   required: { node: '>=18' },
npm warn EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm warn EBADENGINE }
```

The install still finishes. The real failure comes later, at runtime, when a code path that uses a web API actually runs:

```text
ReferenceError: fetch is not defined
    at Client.request (.../@modelcontextprotocol/sdk/dist/esm/client/index.js)

ReferenceError: ReadableStream is not defined
    at new StreamableHTTPClientTransport (.../sdk/dist/esm/client/streamableHttp.js)
```

Inside a client like Claude Code or Claude Desktop the same crash is wrapped in JSON-RPC and reads as a protocol error, which sends people hunting for a config bug that does not exist:

```text
MCP error -32603: fetch is not defined
```

The tell is that all three trace back to a Node version that predates the global these packages rely on. The green `EBADENGINE` warning and the red `ReferenceError` are the same problem seen twice.

## Why old Node breaks the SDK

The MCP TypeScript SDK is built on the platform web APIs that modern Node exposes as globals: `fetch`, `Request`, `Response`, `Headers`, and the WHATWG stream types `ReadableStream` and `TransformStream`. The streamable HTTP transport is a thin wrapper over `fetch` and web streams, and the client's request path calls `fetch` directly. None of that is polyfilled inside the package. It expects the runtime to provide it.

Those globals landed in Node on a schedule, and if your runtime is below the line the reference simply is not there:

- `fetch`, `Request`, `Response`, `Headers`, `FormData` became globals in Node 18.0.0 (experimental in 17.5 behind `--experimental-fetch`).
- `ReadableStream`, `WritableStream`, `TransformStream` became globals in Node 18.0.0. On Node 16 they exist only under `require('node:stream/web')`.
- `structuredClone` became a global in Node 17.0.0.
- The Web Crypto `globalThis.crypto` became a global in Node 19.0.0. Before that you have to reach it through `require('node:crypto').webcrypto`.

That last one matters for the `2.0.0` SDK. The stable `1.x` line declares `"engines": { "node": ">=18" }`, but the `2.0.0-alpha.0` package bumps that to `">=20"` precisely because it leans on `globalThis.crypto` for id generation. So "below 18" is the floor for the current stable SDK, and Node 18 or 19 can still trip the newer alpha with `ReferenceError: crypto is not defined`.

There is one more wrinkle that explains why the crash feels random. A pure stdio server does not call `fetch` at startup, so it can launch cleanly on Node 16 and look healthy. The `ReferenceError` only fires when a tool handler actually invokes `fetch` or the transport touches a stream. That is exactly the pattern reported in [modelcontextprotocol/servers issue #556](https://github.com/modelcontextprotocol/servers/issues/556) and [issue #1065](https://github.com/modelcontextprotocol/servers/issues/1065): the server "appears functional" over npx, then every tool call fails with `fetch is not defined`.

## Minimal repro

Any server built on the SDK reproduces this on an old runtime. Here is the smallest one that calls `fetch` inside a tool:

```typescript
// server.ts - @modelcontextprotocol/sdk 1.29.0, TypeScript 5.x
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "repro", version: "1.0.0" });

server.tool("ping", { url: z.string() }, async ({ url }) => {
  // fetch is a global on Node 18+. On Node 16 this line throws.
  const res = await fetch(url);
  return { content: [{ type: "text", text: String(res.status) }] };
});

await server.connect(new StdioServerTransport());
```

Run it under Node 16 and the process starts, registers the tool, and answers the client handshake. Call `ping` once and it dies:

```bash
# Node 16.20.2 - install warns, startup is clean, the tool call throws
node --version   # v16.20.2
node server.js   # no error yet
# ...client invokes ping -> ReferenceError: fetch is not defined
```

## Fix 1: upgrade Node, then verify the SDK sees it

The correct fix is to move the runtime past the floor. Use a version manager so you can switch cleanly instead of fighting a system package:

```bash
# nvm - install and pin a supported Node for MCP work
nvm install 20
nvm use 20
node --version   # v20.x - clears >=18 and the 2.0.0 >=20 requirement
```

```powershell
# nvm-windows - the equivalent on Windows
nvm install 20.11.0
nvm use 20.11.0
node --version
```

Node 20 is the pragmatic target: it clears the `1.x` `>=18` floor, the `2.0.0` `>=20` floor, and the `globalThis.crypto` requirement in one move, and it is an active LTS. Do not stop at Node 18 if you plan to touch the `2.x` SDK. After switching, reinstall so any native or engine-gated dependency resolves against the new runtime:

```bash
# Reinstall against the new Node so nothing is left on the old ABI
rm -rf node_modules package-lock.json
npm install
```

## Fix 2: make the MCP client launch the new Node, not the system one

This is the fix people miss, and it is why "I already upgraded Node" does not make the error go away. Your MCP client does not run the server in your interactive shell. Claude Desktop is a GUI app launched by the OS, so it never sources `~/.zshrc` or `~/.bashrc` and never sees your nvm shims. Claude Code spawns the server as a child process with whatever `PATH` it inherited. The result: `node --version` in your terminal proudly reports v20, while the server actually runs under the old `/usr/bin/node` the GUI found first.

The robust fix is to hand the client an absolute path to a modern Node instead of relying on `PATH`:

```json
{
  "mcpServers": {
    "repro": {
      "command": "/Users/you/.nvm/versions/node/v20.11.0/bin/node",
      "args": ["/abs/path/to/server.js"]
    }
  }
}
```

If you would rather not hardcode a path, use a manager that installs a global shim every process inherits. Volta places a `node` shim on the system `PATH` and pins the version per project, so a GUI-launched child gets the right runtime without any shell profile:

```bash
# Volta - a global shim that GUI apps inherit
volta install node@20
volta pin node@20   # writes the pin into package.json
```

Whichever route you pick, confirm the version the client actually used rather than trusting your shell. Add a one-line probe as the server's first action, or check the client logs. In Claude Desktop the MCP server logs live next to the config and record the spawn. If you are unsure which log or path applies after a client update moved things, the walkthrough on [MCP servers that stop working after a Claude Desktop update on Windows](/2026/06/fix-mcp-servers-stop-working-after-claude-desktop-update-on-windows/) covers where those paths went.

## Fix 3: polyfill the globals when you truly cannot upgrade

Sometimes the runtime is frozen: a locked corporate image, a distro LTS that ships Node 16, a CI base image you do not control. You can shim the missing globals at the very top of the server entrypoint, before any SDK import runs. Install `undici` for the Fetch APIs and pull the streams from Node's built-in `node:stream/web`:

```typescript
// polyfill.ts - load FIRST, before importing the MCP SDK. Node 16 stopgap.
import { fetch, Headers, Request, Response, FormData } from "undici";
import { ReadableStream, WritableStream, TransformStream } from "node:stream/web";
import { webcrypto } from "node:crypto";

const g = globalThis as unknown as Record<string, unknown>;
g.fetch ??= fetch;
g.Headers ??= Headers;
g.Request ??= Request;
g.Response ??= Response;
g.FormData ??= FormData;
g.ReadableStream ??= ReadableStream;
g.WritableStream ??= WritableStream;
g.TransformStream ??= TransformStream;
g.crypto ??= webcrypto;   // covers the 2.0.0 globalThis.crypto requirement
```

```typescript
// server.ts - import the polyfill before anything else
import "./polyfill.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// ...rest of the server
```

Treat this as a stopgap, not a home. The `EBADENGINE` warning still fires because `package.json` still says the engine is unsupported, `undici`'s `fetch` is not byte-for-byte identical to a native one, and the next SDK release can add another global you did not shim. It unblocks a frozen box today; it is not a substitute for a supported runtime.

## Fix 4: pin an SDK that matches your Node

If you are stuck exactly on Node 18 and hitting the `2.0.0-alpha` `crypto is not defined` crash, the cleanest move is to stay on the stable line rather than run an alpha your runtime cannot satisfy:

```bash
# Stay on the stable 1.x line, which requires only Node >=18
npm install @modelcontextprotocol/sdk@1.29.0
```

There is not much runway below that: `1.x` already requires Node 18, so downgrading the SDK will not rescue a Node 16 box. Version-pinning buys you the gap between "the alpha needs 20" and "I only have 18," and nothing lower.

## Gotchas and lookalikes

`fetch is not defined` also appears on a perfectly modern Node when a dependency bundles its own `node-fetch` and fails to import it, so do not assume every instance is a Node-version problem. Check `node --version` first; if it is 18 or newer, the cause is elsewhere.

The `EBADENGINE` line is a warning, not an error, and `npm install` exits 0. Setting `engine-strict=true` in `.npmrc` turns it into a hard failure so a bad runtime is caught at install instead of on the first tool call in production.

If the server dies the instant it launches rather than on a tool call, that is a different failure than this one. A server that exits on spawn surfaces as [MCP error -32000 Connection closed](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/), and a normal startup line written to stderr can be [misread by Claude Code as an error](/2026/07/fix-claude-code-misreads-mcp-server-stderr-as-error/). Neither is a Node-version problem. And when every server drops out at once, suspect a single [malformed-JSON syntax error in the config](/2026/07/fix-all-mcp-servers-fail-to-load-after-malformed-json-in-config/) rather than the runtime.

One more variant worth naming: if the `ReferenceError` names `ReadableStream` specifically and only your HTTP transport breaks while stdio works, you are hitting the web-streams gap, not the fetch gap. The transport choice decides which global you need, which is its own decision covered in [MCP stdio vs HTTP vs SSE transport](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/). Upgrading Node fixes both at once; a partial polyfill will not.

## Related

- [How to build a custom MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) - the from-scratch setup this error most often interrupts.
- [Fix: MCP error -32000 Connection closed in Claude Code](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/) - when the server dies on launch instead of on a tool call.
- [Fix: Claude Code misreads an MCP server's stderr as an error](/2026/07/fix-claude-code-misreads-mcp-server-stderr-as-error/) - a clean startup line mistaken for a crash.
- [MCP stdio vs HTTP vs SSE transport: which to choose](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) - which transport needs which web global.
- [Fix: an HTTP MCP server URL won't connect in Claude Desktop](/2026/05/fix-http-mcp-server-url-wont-connect-in-claude-desktop/) - the transport-mismatch sibling of this bug.

## Sources

- [@modelcontextprotocol/sdk on npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) - `1.29.0` engines `node >=18`, `2.0.0-alpha.0` engines `node >=20`.
- [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) - the SDK source and transports built on `fetch` and web streams.
- [servers issue #556: MCP error -32603 fetch is not defined](https://github.com/modelcontextprotocol/servers/issues/556).
- [servers issue #1065: 'fetch is not defined' when executing any tool](https://github.com/modelcontextprotocol/servers/issues/1065).
- [Node.js global fetch, added in v18.0.0](https://nodejs.org/en/blog/announcements/v18-release-announce#fetch-experimental) - the release that made `fetch` a global.
