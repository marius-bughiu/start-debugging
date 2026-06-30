---
title: "Fix: Claude Code Drops MCP Tools After Auto-Compaction"
description: "After auto-compaction, Claude Code can leave your MCP server connected but with no tools. Run /mcp to reconnect; if tools stay gone, /clear or restart. Here is why and how to prevent it."
pubDate: 2026-06-30
template: error-page
tags:
  - "errors"
  - "mcp"
  - "claude-code"
  - "ai-agents"
---

You are deep in a long Claude Code session, the context bar fills up, auto-compaction kicks in, and suddenly every MCP tool call fails. The fastest fix: run `/mcp` and reconnect the affected server. That re-establishes the transport and, in most builds, re-registers the tools. If `/mcp` reports the server as "connected" but the tools are still missing, you have hit the known re-registration bug and the only reliable recovery is `/clear` or a fresh session. This is tested against Claude Code 2.1.x and the MCP specification dated [2026-03-26](https://modelcontextprotocol.io/specification/2026-03-26).

## What you actually see

There is no single exception string here, which is part of why this one is hard to search for. The tell is that a tool you were using two messages ago is gone. Claude Code injects a system message into the transcript when an MCP server drops mid-session:

```
The following deferred tools are no longer available (their MCP server
disconnected). Do not search for them; ToolSearch will return no match.
```

After that line appears, the model stops offering those tools, `ToolSearch` returns nothing for them, and any attempt to call one fails. Meanwhile `/mcp` may still list the server. That gap between "server shows connected" and "tools are unusable" is the signature of this bug, reported against Claude Code current as of 2026-03-23 on `claude-opus-4-6` in [issue #38043](https://github.com/anthropics/claude-code/issues/38043).

The disconnect that triggers it is often silent. There is no error toast, no failed tool call to alert you. You only notice when you ask for something that needs the tool and the model says it cannot find it. That silent-drop behavior is tracked separately in [issue #24350](https://github.com/anthropics/claude-code/issues/24350).

## Why auto-compaction is the trigger

Claude Code keeps the whole conversation in the model's context window. When that window approaches its limit, auto-compaction summarizes the older turns into a compressed form and replaces them, freeing room to keep going. You can also trigger it yourself with `/compact`.

MCP tools are not part of the message history that gets summarized. They live in a separate registry that is populated when each MCP server connects and completes its `tools/list` handshake. The problem is what happens to that registry around a compaction boundary:

1. A long session keeps an stdio or HTTP MCP transport open for a long time. Idle connections get dropped by the OS, a proxy, or the server's own timeout.
2. When the connection drops, Claude Code marks the server's tools as unavailable and writes the "deferred tools are no longer available" message.
3. Compaction rebuilds the prompt from the summarized history, but it does not re-run the connect-and-list handshake for servers that dropped. The tool registry stays empty for that server.

So compaction is rarely the literal cause of the disconnect. It is the moment the lost connection becomes visible, because the rebuilt context no longer carries whatever cached state was papering over the drop. For OAuth-based connectors the failure is sharper: the authenticated session is lost during compaction and every call returns an auth error until you reconnect, which is the Cowork variant in [issue #34832](https://github.com/anthropics/claude-code/issues/34832).

## Reproducing it on purpose

You do not need a flaky network to see this. The smallest repro is a stdio server with a short idle timeout plus a session long enough to compact:

```jsonc
// .mcp.json, Claude Code 2.1.x
{
  "mcpServers": {
    "demo": {
      "command": "node",
      "args": ["./demo-server.js"]
    }
  }
}
```

```js
// demo-server.js -- MCP TypeScript SDK 1.x, spec 2026-03-26
// Exits itself after 60s idle to simulate a transport drop.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  { name: "demo", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

let idle = setTimeout(() => process.exit(0), 60_000);
const bump = () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), 60_000); };

server.setRequestHandler(/* tools/list + tools/call handlers */ {}, bump);

await server.connect(new StdioServerTransport());
```

Connect it, confirm the tool shows up in `/mcp`, then work in the session without touching that tool for a minute while the context grows past the auto-compaction threshold. After the compaction, the tool is gone and the deferred-tools message is in your scrollback. The mechanics are the same as the broader stdio lifecycle issues covered in [why an MCP server hangs when launched from Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/).

## The fix, in order of preference

### 1. Run `/mcp` and reconnect

`/mcp` opens the MCP management view inside the session. Select the dropped server and reconnect it. This re-runs the transport connect and the `tools/list` handshake, and in current 2.1.x builds it re-registers the tools into the active session without clearing your conversation. This is the headline workaround and it resolves the common case.

If you are scripting around the problem, you can also check status from a second shell without disturbing the session:

```bash
# Claude Code 2.1.x -- list servers and their connection state
claude mcp list
```

### 2. If `/mcp` shows "connected" but tools are still missing

This is the sharp edge of the bug. The transport reconnected, `/mcp` is green, but the tool registry was never repopulated for the rest of the session. There is no `/mcp refresh` to force re-registration as of 2.1.x, so the recovery options are:

- `/clear` to reset the conversation in the same process. You lose the chat history but keep the running Claude Code instance and its server connections, which re-list cleanly.
- Start a fresh session. `claude --resume` in the same directory brings back the conversation and re-initializes every MCP server from scratch, which is the most reliable way to get the tools back.

Splitting the work is the durable answer: when a task is long enough to compact several times, it is long enough to hit this. End the session at a natural boundary and resume rather than running one marathon context.

### 3. Stop the drop from happening

The reconnect dance is a symptom. The two levers that prevent it:

- **Keep the context small enough that you rarely auto-compact.** Every compaction is a chance to lose a connection. Read large files in ranges instead of whole, push heavy file work into a subagent so it runs in its own context window, and `/compact` deliberately at clean checkpoints instead of letting the limit force it. The same context discipline that [keeps a monorepo's context small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/) directly reduces how often you compact.
- **Trim how many MCP tools you load.** Fewer tools means a smaller registry to lose and fewer servers to babysit across a compaction. The mechanics of pruning the tool set are in [reducing the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/).

## Auto-compaction thrashing is a different problem

Do not confuse this with the thrashing error, which has its own message:

```
Autocompact is thrashing: the context refilled to the limit ...
```

That one means compaction succeeded but a single file or tool output immediately refilled the window several times in a row, so Claude Code stops retrying to avoid burning API calls in a loop. Per the official [troubleshooting docs](https://code.claude.com/docs/en/troubleshooting), the fixes are to read the oversized file in smaller chunks, run `/compact keep only the plan and the diff` to drop the large output, move the work to a subagent, or `/clear` if the earlier conversation is no longer needed. Thrashing is about context refilling too fast; the MCP tool drop is about a connection not being re-established. Different cause, different fix.

## Telling this apart from the other MCP failures

This bug lands on the same search terms as several unrelated MCP problems. Quick triage:

- **Tools were never there.** If the server never connected in the first place, you are looking at a startup failure, not a drop. That usually surfaces as [MCP error -32000: Connection closed](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/), which means the server process exited before the handshake finished.
- **Disconnect only inside WSL.** If the drop is specific to a WSL environment and the server runs fine on native Windows or Linux, the cause is the cross-filesystem path and networking quirks covered in [Claude Code reports MCP server disconnected inside WSL](/2026/05/fix-claude-code-reports-mcp-server-disconnected-inside-wsl/).
- **Everything broke after an app update.** If all servers stopped at once right after updating the desktop app, the config path likely moved. That is its own fix: [MCP servers stopped working after a Claude Desktop update on Windows](/2026/06/fix-mcp-servers-stop-working-after-claude-desktop-update-on-windows/).

The auto-compaction drop is specifically the case where the server *was* working, *is* still listed as connected, and the tools vanished around a context boundary. If your symptoms match a row above instead, follow that thread.

## What to watch for going forward

Automatic reconnection after a drop is the obvious fix and it is an open feature request, with proposals to re-inject tool definitions when a server reconnects and to mark tools as temporarily unavailable with retry rather than permanently removing them. Until that ships, treat MCP tools in a long Claude Code session as something that can quietly disappear at any compaction, and build the `/mcp` reconnect into your muscle memory the same way you would a `git fetch` after a long pull. When in doubt, `/clear` or `claude --resume` is the reset that always works.

## Sources

- [anthropics/claude-code #38043 -- MCP tools permanently removed after a transient server disconnect](https://github.com/anthropics/claude-code/issues/38043)
- [anthropics/claude-code #24350 -- MCP server connections drop silently and require manual /mcp reconnection](https://github.com/anthropics/claude-code/issues/24350)
- [anthropics/claude-code #34832 -- Cowork MCP connectors lose auth after context compaction](https://github.com/anthropics/claude-code/issues/34832)
- [Claude Code troubleshooting: performance, stability, and auto-compaction thrashing](https://code.claude.com/docs/en/troubleshooting)
- [Model Context Protocol specification, 2026-03-26](https://modelcontextprotocol.io/specification/2026-03-26)
