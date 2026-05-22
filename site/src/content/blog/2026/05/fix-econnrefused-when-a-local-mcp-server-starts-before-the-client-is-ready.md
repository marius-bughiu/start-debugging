---
title: "Fix: `ECONNREFUSED` When a Local MCP Server Starts Before the Client Is Ready"
description: "ECONNREFUSED from an MCP client means nothing was listening on that host:port yet. Fix the startup race, the localhost IPv4/IPv6 trap, and wrong-port mistakes for HTTP MCP servers."
pubDate: 2026-05-22
tags:
  - "mcp"
  - "claude-code"
  - "ai-agents"
  - "cursor"
---

If your MCP client logs `Error: connect ECONNREFUSED 127.0.0.1:3000` (or `::1:3000`) when it tries to reach a local Model Context Protocol server over HTTP, the server was not listening on that host and port at the instant the client connected. The three causes, in order: the client raced ahead of the server's `listen()` call, `localhost` resolved to IPv6 `::1` while the server bound IPv4 `127.0.0.1`, or the URL points at the wrong port or path. Fix the first by waiting for the port to accept connections before you register the server; fix the second by binding `::` and `0.0.0.0` or putting `127.0.0.1` in the URL; fix the third by checking the URL against what the server actually prints on boot.

This is the HTTP and Streamable HTTP transport failure mode, not the stdio one. If your server is launched as a subprocess and hangs on `Connecting...`, that is a different bug covered in [the stdio hang post](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/). Everything below is tested against Claude Code 2.1.128, Cursor 0.45, the MCP TypeScript SDK 1.29.0, the Python SDK 1.13.0, and the MCP spec dated [2026-03-26](https://modelcontextprotocol.io/specification/2026-03-26/basic/transports).

## The error in context

The exact string depends on the client and the runtime, but it is always a TCP-level refusal:

```
# Node-based client (Claude Code, Cursor, mcp-remote)
Error: connect ECONNREFUSED 127.0.0.1:3000
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1300:16)

# or, the IPv6 variant that surprises people
Error: connect ECONNREFUSED ::1:3000

# Python client (httpx under the MCP Python SDK)
httpx.ConnectError: All connection attempts failed
  ConnectionRefusedError: [Errno 111] Connection refused
```

In Claude Code you usually see it as a server stuck in a failed state in `/mcp`, with the underlying error visible only when you run `claude --debug`. In Cursor it shows as a red dot next to the server in Settings, with "Connection refused" in the MCP logs panel.

## What `ECONNREFUSED` actually means

`ECONNREFUSED` is precise, and that precision is the fastest way to diagnose it. When a process calls `connect()` to a TCP port where nothing is listening, the target host's kernel replies with a TCP `RST` packet. The OS turns that `RST` into `ECONNREFUSED`. It means: the host is reachable, the route is fine, DNS resolved, but no socket is bound to that port right now.

That rules out two lookalikes immediately:

- `ETIMEDOUT` means the `SYN` got no answer at all (wrong host, firewall dropping packets, server hung before binding). The host is not refusing, it is silent.
- `EAI_AGAIN` or `ENOTFOUND` means DNS failed before any TCP attempt. The hostname did not resolve.

So if you see `ECONNREFUSED`, stop looking at firewalls and DNS. Something is wrong with *which* port, *which* interface, or *when* you connected. Node's [errors documentation](https://nodejs.org/api/errors.html#common-system-errors) lists `ECONNREFUSED` under "(Connection refused) No connection could be made because the target machine actively refused it," which is exactly this.

## Cause 1: the client connects before the server is listening

This is the headline case from the queue, and it is a classic readiness-versus-liveness mistake. A process being "started" is not the same as a process being "ready to accept connections." Between `node server.js` returning a PID and the server actually calling `server.listen(3000)`, there can be hundreds of milliseconds (TypeScript compile, dependency init, a database connection, model warm-up). If anything connects in that window, it gets `ECONNREFUSED`.

The race shows up in three common setups:

1. **A launcher script** that starts the MCP server in the background and then immediately starts the client:

```bash
# the bug: nothing guarantees the server is listening before the client runs
node mcp-server.js &
claude   # connects to http://localhost:3000/mcp, often too early
```

2. **A bridge tool** like [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) or [`supergateway`](https://github.com/supercorp-ai/supergateway) that a stdio-only client spawns to reach an HTTP server. The client launches the bridge instantly; the bridge dials the HTTP server before it is up.

3. **Docker Compose**, where one service is the MCP server and another (or the host) connects to it. `depends_on` without a condition only waits for the container to *start*, not to be ready. The Docker docs are explicit: ["Compose does not wait until a container is 'ready', only until it's running."](https://docs.docker.com/compose/how-tos/startup-order/)

### Fix 1a: wait for the port, then start the client

The robust pattern is to poll the port until it accepts a connection, with a timeout, before you hand off to the client. `wait-on` does this in one line:

```bash
# wait-on 8.x: block until the TCP port accepts, then launch the client
npx wait-on tcp:127.0.0.1:3000 --timeout 30000 && claude
```

If you prefer not to add a dependency, a tiny poll loop is enough:

```bash
# POSIX shell: retry the MCP endpoint with backoff before giving up
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/mcp -X POST \
      -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'; then
    echo "MCP server is up"; break
  fi
  echo "waiting for MCP server ($i)"; sleep 1
done
```

Note that probing the Streamable HTTP endpoint with a real POST is more honest than a bare TCP check: per the [2026-03-26 transport spec](https://modelcontextprotocol.io/specification/2026-03-26/basic/transports), the server may have the socket open but not yet be answering JSON-RPC. A POST that returns any HTTP status (even 400) proves the HTTP layer is alive.

### Fix 1b: make the client retry instead of failing once

If you cannot control startup order, give the client retry-with-backoff. When you write your own SDK client, wrap the connect in a loop rather than connecting once:

```typescript
// MCP TypeScript SDK 1.29.0, Node 20+
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function connectWithRetry(url: URL, attempts = 10): Promise<Client> {
  for (let i = 0; i < attempts; i++) {
    const client = new Client({ name: "my-client", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(url));
      return client;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw err;
      await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** i, 4000)));
    }
  }
  throw new Error(`MCP server at ${url} never came up`);
}
```

The key detail: only retry on `ECONNREFUSED`. Re-throw everything else (a 401, a schema error, an `ENOTFOUND`) immediately, because those will not fix themselves by waiting.

### Fix 1c: in Docker Compose, gate on a health check

When the server runs in a container, replace the bare dependency with `condition: service_healthy` and define a health check that hits the MCP endpoint:

```yaml
# docker compose v2.x
services:
  mcp-server:
    build: .
    ports: ["3000:3000"]
    healthcheck:
      test: ["CMD", "curl", "-fsS", "-X", "POST",
             "-H", "content-type: application/json",
             "-d", '{"jsonrpc":"2.0","id":1,"method":"ping"}',
             "http://127.0.0.1:3000/mcp"]
      interval: 2s
      timeout: 3s
      retries: 15
  client:
    build: ./client
    depends_on:
      mcp-server:
        condition: service_healthy
```

Now Compose holds `client` until the server's health check passes, which closes the race for good.

## Cause 2: `localhost` resolves to `::1` but the server only bound `127.0.0.1`

This one looks like a race but is deterministic, and it bites Node-based clients hard. Since Node.js 17, `dns.lookup` no longer reorders results and returns them in the order the OS provides (`verbatim` defaults to `true`). On most systems `localhost` resolves to the IPv6 `::1` first. So a client connecting to `http://localhost:3000` tries `::1:3000`. If your server called `app.listen(3000, "127.0.0.1")`, it bound IPv4 only, nothing is listening on `::1`, and you get `connect ECONNREFUSED ::1:3000`. The exact same code worked on Node 16, which is why upgrading Node "broke" a server that did not change. This is tracked in [nodejs/node#40537](https://github.com/nodejs/node/issues/40537).

There are three clean fixes, in order of preference:

1. **Bind both stacks on the server.** Listen on `::` with dual-stack enabled (the Node default when you pass no host), or bind `0.0.0.0` for IPv4-any. Do not pin to `127.0.0.1` unless you have a reason:

```typescript
// Express / Node 20+, MCP Streamable HTTP server
// No host arg => binds :: with IPv4 mapped, so both ::1 and 127.0.0.1 work
app.listen(3000);
// or explicitly IPv4-any:
app.listen(3000, "0.0.0.0");
```

2. **Use `127.0.0.1` in the client URL, not `localhost`.** This sidesteps DNS entirely:

```bash
# Claude Code 2.x: prefer the literal IPv4 address over localhost
claude mcp add --transport http my-server http://127.0.0.1:3000/mcp
```

3. **Let the client try both families.** Node 20 enabled `autoSelectFamily` (the Happy Eyeballs algorithm, RFC 8305) by default, so a client on Node 20+ attempts IPv6 and IPv4 in parallel and uses whichever answers. If you are stuck on Node 18, you can opt in:

```javascript
// Node 18: opt into Happy Eyeballs so ::1 failure falls back to 127.0.0.1
require("net").setDefaultAutoSelectFamily(true);
```

If you only control the client config and it is on an older runtime, fix 2 is the one-line escape hatch. If you own the server, fix 1 is the correct long-term answer.

## Cause 3: the URL is simply wrong

Before you instrument anything, rule out the boring cause. `ECONNREFUSED` on the right host means the *port* has no listener, which is frequently a typo or a stale value:

- **Wrong port.** The server printed `listening on :8080` but your config says `:3000`. Read the server's own boot log, do not trust memory.
- **Wrong path.** Streamable HTTP servers expose one path, commonly `/mcp`. The deprecated SSE transport used `/sse`. Pointing an HTTP client at the SSE path (or vice versa) can refuse or 404 depending on the framework. Match the transport to the path the server actually mounts.
- **`http` vs `https`.** A local dev server on plain HTTP will refuse a client that was configured with `https://localhost:3000`.
- **Server bound to a container or VM, not the host.** If the server listens inside Docker on `127.0.0.1` *inside the container*, the host cannot reach it. Bind `0.0.0.0` in the container and publish the port. The same loopback-isolation problem across the WSL boundary is covered in [the WSL MCP disconnect post](/2026/05/fix-claude-code-reports-mcp-server-disconnected-inside-wsl/).

Verify the registered URL with `claude mcp list`, which prints the command, transport, and URL verbatim. The config it reads looks like this:

```json
// .mcp.json, Claude Code 2.x. "type": "http" is the streamable-http transport.
{
  "mcpServers": {
    "my-server": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

The [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) confirm `type: "http"` selects Streamable HTTP and accepts `streamable-http` as an alias. Cursor uses an `mcp.json` with a `url` field for HTTP servers and the same caveats apply.

## Cause 4: the server crashed on boot, so it never listened

A server that throws during startup never reaches `listen()`, and from the client's side that is indistinguishable from the race in Cause 1: the port stays refused forever instead of for 300 ms. The tell is that waiting does not help. The retry loop in Fix 1b exhausts all attempts because the server is dead, not slow.

Confirm by running the server directly in a terminal and watching it either print its listening line or exit with a stack trace:

```bash
# run the server by hand; if it exits, the client was never going to connect
node mcp-server.js
# look for either:  "MCP server listening on http://127.0.0.1:3000/mcp"
#            or:    an exception and a non-zero exit
```

Common boot-time killers: the port is already taken (`EADDRINUSE` from a previous instance you forgot to kill), a missing environment variable read at module load, or an unhandled promise rejection during database init. Fix the crash first; the connection follows.

## A diagnostic order that gets you there fast

When `ECONNREFUSED` shows up, walk this in order and you will land on the right cause in under a minute:

1. Read the address in the error. `::1:PORT` is almost always Cause 2 (IPv6 vs IPv4). `127.0.0.1:PORT` is Cause 1, 3, or 4.
2. Run the server by hand and read its listening line. If it never prints one, it is Cause 4.
3. `curl -X POST http://127.0.0.1:PORT/PATH` with a `ping` body. If curl connects but the client does not, it is Cause 2 (the client used `localhost`, curl used the literal IP) or a transport/path mismatch.
4. If curl also refuses while the server is clearly running, the port or path is wrong: Cause 3.
5. If everything works when you start it slowly by hand but fails under your launcher or Compose file, it is the race: Cause 1. Add the readiness gate.

## Related

- [Fix: MCP server stdio hang when launched from Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/) is the subprocess-transport counterpart: stdout pollution and timeouts instead of refused connections.
- [Fix: Claude Code reports `MCP server disconnected` inside WSL](/2026/05/fix-claude-code-reports-mcp-server-disconnected-inside-wsl/) covers the loopback-isolation version of this problem across the Windows/Linux boundary.
- [Build a custom MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) shows the server-side `listen()` and transport wiring that avoids the binding mistakes above.
- [Build a custom MCP server in Python with the official SDK](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) for the `uvicorn` host binding settings on the Python side.
- [Build a custom MCP server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) for the Kestrel `UseUrls` equivalent and dual-stack binding.

## Sources

- [MCP specification 2026-03-26: transports](https://modelcontextprotocol.io/specification/2026-03-26/basic/transports)
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
- [Node.js errors: common system errors (ECONNREFUSED)](https://nodejs.org/api/errors.html#common-system-errors)
- [nodejs/node#40537 -- localhost favours IPv6 in Node 17](https://github.com/nodejs/node/issues/40537)
- [Node.js net.setDefaultAutoSelectFamily / Happy Eyeballs](https://nodejs.org/api/net.html#netsetdefaultautoselectfamilyvalue)
- [Docker Compose: control startup and shutdown order](https://docs.docker.com/compose/how-tos/startup-order/)
- [mcp-remote on npm](https://www.npmjs.com/package/mcp-remote)
- [supergateway -- stdio to SSE/Streamable HTTP bridge](https://github.com/supercorp-ai/supergateway)
