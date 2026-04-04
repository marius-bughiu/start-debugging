# git-push MCP server

A tiny, zero-dependency MCP (Model Context Protocol) server that runs `git push` from outside the Cowork sandbox.

## Why this exists

Cowork runs its shell tool inside an Ubuntu sandbox whose egress proxy blocks `github.com`, `api.github.com`, and `codeload.github.com`. Any `git push` from inside that sandbox returns HTTP 403 at the proxy. That includes pushes attempted by scheduled tasks.

MCP stdio servers declared in `.mcp.json` are launched by the Cowork client as **native host processes** - not inside the sandbox. A Node.js process started this way has the user's real network connectivity and the Windows Git Credential Manager, so it can push normally.

The scheduled daily blog task uses this server's `git_push` tool as its final step.

## Tools

- **`git_status`** - current branch, ahead/behind vs origin, short working tree status.
- **`git_log`** - last N commits (default 5, max 50) as `<hash> <subject>`.
- **`git_push`** - `git pull --rebase origin <branch>` (optional, default on) then `git push origin <branch>`. Returns before/after HEAD hashes.

All tools operate on a single repository, configured via the `REPO_ROOT` env var.

## Requirements

- Node.js 18 or newer (no npm install needed - zero dependencies)
- `git` on `PATH`
- Valid git credentials on the host (Git Credential Manager on Windows, keychain on macOS, SSH key + agent, etc.)

## How it is wired

The repo's root `.mcp.json` registers this server and sets `REPO_ROOT` to `C:\S\start-debugging`:

```json
{
  "mcpServers": {
    "git-push": {
      "command": "node",
      "args": ["mcp-servers/git-push/server.js"],
      "env": {
        "REPO_ROOT": "C:\\S\\start-debugging"
      }
    }
  }
}
```

When Cowork loads the project, it launches `node mcp-servers/git-push/server.js` as a native Windows process. The server speaks MCP over stdio and exposes the three tools above.

## Manual smoke test (Windows PowerShell)

```powershell
cd C:\S\start-debugging
$env:REPO_ROOT = "C:\S\start-debugging"
node mcp-servers/git-push/server.js
```

Then paste these lines into stdin (one per line):

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"git_status","arguments":{}}}
```

You should see an `initialize` response, a tools list, and a git status dump on stdout. Diagnostic logs appear on stderr.

## Design notes

- **Zero dependencies.** The MCP stdio protocol is just newline-delimited JSON-RPC 2.0. Handling it in ~50 lines of plain Node is more reliable than pulling an SDK into a single-file server.
- **Logs to stderr.** stdout is reserved for JSON-RPC frames; anything written there would corrupt the protocol.
- **Shell-free git.** `spawnSync('git', ...)` with no shell avoids any quoting issues and makes the commands identical across platforms.
- **Fails loudly.** `git_push` surfaces the full stderr from git when pull or push fail, so the calling agent can diagnose auth issues, non-fast-forward errors, etc.
