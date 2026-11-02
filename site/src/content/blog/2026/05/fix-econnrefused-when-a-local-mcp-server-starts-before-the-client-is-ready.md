---
title: "Fix: `ECONNREFUSED` When a Local MCP Server Starts Before the Client Is Ready"
description: "Diagnose MCP ECONNREFUSED safely: check the listener and address, wait with a deadline, retry nested connection errors, and distinguish TCP readiness from MCP initialization."
updatedDate: 2026-11-02
pubDate: 2026-05-22
tags:
  - "mcp"
  - "claude-code"
  - "ai-agents"
  - "cursor"
---

`ECONNREFUSED` means a connection attempt was actively refused. For a local HTTP MCP server, common causes are a server that has not started listening, a wrong port, or an IPv4/IPv6 mismatch. Despite this article's original URL wording, the startup race is normally **the client connecting before the server is ready**.

> **Correction — November 2, 2026:** Removed an unpublished protocol version and unsupported client-testing claims. Corrected path/TLS diagnoses, unsafe advice to bind every interface, and a readiness probe that did not establish MCP initialization. The Python TCP gate and SDK retry example below were checked locally.

## Separate TCP, HTTP and MCP failures

The [Node error reference](https://nodejs.org/api/errors.html#common-system-errors) describes refusal as an actively rejected connection. It often means there is no listener on the selected address and port, but an actively rejecting firewall or intermediary can also produce it. The code alone does not prove routing and firewall configuration are correct.

| Result | What it establishes |
| --- | --- |
| `ECONNREFUSED` | The selected connection attempt was refused. Check the address, listener and rejection policy. |
| Timeout | The attempt did not finish within its deadline. It does not identify one particular cause. |
| HTTP 404 or 405 | An HTTP service answered; investigate its path or method. |
| HTTP 401 or 403 | An HTTP service answered with an authentication or authorization-related response; inspect its details. |
| TLS/protocol error | Check `http` versus `https` and certificate configuration. |
| Valid MCP initialization/discovery | The protocol exchange succeeded, which is stronger evidence than an open port. |

A wrong URL **path** does not itself cause TCP refusal: the path is sent after the connection is established. Speaking HTTPS to a plain HTTP listener commonly produces a TLS error, not a guaranteed `ECONNREFUSED`.

## Check the listener before changing the client

Run the server directly and inspect its startup log. Confirm the address and port it actually binds. A process that starts and then crashes can leave no listener; waiting longer cannot fix a persistent import error, missing setting or `EADDRINUSE`.

Inspect Claude Code's registered endpoint:

```bash
claude mcp get my-server
claude --debug
```

For a deliberately local IPv4 server, an explicit loopback URL avoids ambiguity:

```json
{
  "mcpServers": {
    "my-server": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

`type: "http"` is documented by [Claude Code](https://code.claude.com/docs/en/mcp). Do not assume another client's configuration uses the same aliases.

## Wait for TCP readiness with a deadline

Save this as `wait_tcp.py`. It exits successfully only after a connection succeeds, and exits nonzero after the deadline:

```python
import socket
import sys
import time

host, port = sys.argv[1], int(sys.argv[2])
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    try:
        with socket.create_connection((host, port), timeout=0.5):
            break
    except OSError:
        time.sleep(0.25)
else:
    raise SystemExit(f"No TCP listener at {host}:{port} within 30 seconds")
```

Then gate the client launch:

```bash
python3 wait_tcp.py 127.0.0.1 3000 && claude
```

This checks a **TCP listener**, not authentication or MCP readiness. The local test covered a listener that starts after a delay and a port that remains closed; the latter did not launch the following command. A separate application health endpoint can provide a stronger readiness signal if it reports whether required initialization has finished.

Do not treat a bare MCP `ping` POST as a universal health check. For the [published 2025-11-25 Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), requests have specific Accept-header requirements, and established sessions can require a session ID and protocol-version header. The [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) also defines initialization and the initialized notification. An SDK client handles that exchange. Receiving HTTP 400 only proves that an HTTP service responded.

## Retry connection setup, not arbitrary tool calls

When you own a client using **TypeScript SDK 1.29.0**, this bounded helper retries connection-refused errors, including errors nested inside `cause` or `AggregateError`. It closes each failed client/transport before another attempt:

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export function isConnectionRefused(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  return error.code === 'ECONNREFUSED'
    || isConnectionRefused(error.cause, seen)
    || (Array.isArray(error.errors)
      && error.errors.some(item => isConnectionRefused(item, seen)));
}

export async function connectWithRetry(url, attempts = 5) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('Invalid attempts');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const client = new Client({ name: 'readiness-demo', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url);
    let timer;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = Object.assign(new Error('MCP connection attempt exceeded 5000 ms'), {
            code: 'MCP_CONNECT_TIMEOUT'
          });
          reject(error);
          void transport.close().catch(() => {});
        }, 5000);
      });
      await Promise.race([client.connect(transport, { timeout: 5000 }), deadline]);
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      if (!isConnectionRefused(error) || attempt === attempts - 1) throw error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2000)));
  }
}
```

Use `await connectWithRetry(new URL('http://127.0.0.1:3000/mcp'))`, then close the returned client when finished. Each connection attempt has a five-second overall deadline, including the initialized notification. The SDK request timeout alone only bounds the initialize request; it does not bound that later notification. The outer deadline closes the transport and rejects with `MCP_CONNECT_TIMEOUT`, and its timer is cleared after success or failure. The refusal retries have bounded backoff; deadline expiry, authentication, malformed responses and unrelated failures are rethrown rather than retried by this helper.

This code was checked against SDK 1.29.0's published `2025-11-25` lifecycle. The [current 2026-07-28 protocol](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning) has a different discovery/version-declaration flow; this is not a hand-written implementation of that newer flow. Current Claude Code already has [transport-specific connection retries](https://code.claude.com/docs/en/mcp#automatic-reconnection), so this helper is for your own SDK client.

Never extend this loop blindly around a write tool call. A failed response can follow a successful side effect.

## Keep local servers local

If the error names `::1` but the server listens only on `127.0.0.1`, match the client to the intended IPv4 loopback address or explicitly configure IPv6 loopback. `localhost` resolution and Node's address-family fallback depend on the runtime and system; the error's actual address is the useful observation.

Binding `0.0.0.0` is not an IPv6 fix and exposes the listener beyond loopback. The [MCP transport security guidance](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning) recommends loopback binding for local servers, Origin validation and appropriate authentication. Use broader interfaces only when remote access is intentional and controlled.

In Docker, the container and host have different loopback interfaces. A containerized server may need to listen on the container network interface, while a host-published port can be restricted to `127.0.0.1`. A second container uses the service name, not the host's loopback address. Across Windows/WSL, consult the [direction-specific WSL networking checks](/2026/05/fix-claude-code-reports-mcp-server-disconnected-inside-wsl/).

For Compose startup ordering, `condition: service_healthy` waits for the configured health check, as the [Docker documentation](https://docs.docker.com/compose/how-tos/startup-order/) describes. Choose a check your application actually implements; `/healthz` is not a built-in MCP endpoint. A passing health check is an initial readiness observation, not a guarantee against later crashes.

If the server is a subprocess using stdio, a TCP gate is the wrong test. Start with [stdio launch and framing checks](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/) instead.
