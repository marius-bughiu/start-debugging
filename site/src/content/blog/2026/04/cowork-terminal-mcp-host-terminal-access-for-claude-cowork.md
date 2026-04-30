---
title: "cowork-terminal-mcp: Host Terminal Access for Claude Cowork in One MCP Server"
description: "cowork-terminal-mcp v0.4.1 bridges Claude Cowork's sandboxed VM to your host shell. One tool, stdio transport, hard-pinned Git Bash on Windows."
pubDate: 2026-04-29
tags:
  - "mcp"
  - "claude-cowork"
  - "claude-code"
  - "ai-coding-agents"
---

[Claude Cowork](https://www.anthropic.com/claude-cowork) runs inside a sandboxed Linux VM on your machine. That sandbox is what makes Cowork comfortable to leave running unattended, but it also means the agent cannot install your project's dependencies, run your build, or push a commit to your host repo on its own. Without a bridge, the agent stops at the VM's filesystem boundary. [`cowork-terminal-mcp`](https://github.com/marius-bughiu/cowork-terminal-mcp) v0.4.1 is that bridge: a single-purpose [MCP server](https://modelcontextprotocol.io/) that runs on the host, exposes one tool (`execute_command`), and calls it a day. The whole thing is roughly 200 lines of TypeScript and ships on npm as [`cowork-terminal-mcp`](https://www.npmjs.com/package/cowork-terminal-mcp).

## The one tool the server exposes

`execute_command` is the entire surface. Its Zod schema lives in [`src/tools/execute-command.ts`](https://github.com/marius-bughiu/cowork-terminal-mcp/blob/main/src/tools/execute-command.ts) and accepts four parameters:

| Parameter | Type                       | Default          | Description                                              |
|-----------|----------------------------|------------------|----------------------------------------------------------|
| `command` | `string`                   | required         | The bash command to execute                              |
| `cwd`     | `string`                   | user home        | Working directory (prefer this over `cd <path> &&`)      |
| `timeout` | `number`                   | `30000` ms       | How long before the run is aborted                       |
| `env`     | `Record<string, string>`   | inherited        | Extra environment variables overlaid on `process.env`    |

It returns a JSON object with `stdout`, `stderr`, `exitCode`, and `timedOut`. Output is capped at 1MB per stream, with a `[stdout truncated at 1MB]` (or `stderr`) suffix appended when the limit is hit.

Why one tool? Because every "list files", "run the tests", "what does git status say" request collapses into a shell command. A second tool would just be a thinner wrapper over the same `spawn`. The MCP catalogue stays small, the model doesn't pick the wrong tool, and the host attack surface stays trivial to audit.

## Wiring it into Claude Cowork

Claude Cowork reads MCP servers from the **Claude Desktop** config and forwards them into its sandboxed VM. The config file lives in one of three places:

- **Windows (Microsoft Store install):** `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
- **Windows (standard install):** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

The minimal config:

```json
{
  "mcpServers": {
    "cowork-terminal": {
      "command": "npx",
      "args": ["-y", "cowork-terminal-mcp"]
    }
  }
}
```

On Windows, wrap the command in `cmd /c` so `npx` resolves correctly (Claude Desktop spawns commands through PowerShell-compatible plumbing that does not always find npm shims):

```json
{
  "mcpServers": {
    "cowork-terminal": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "cowork-terminal-mcp"]
    }
  }
}
```

For Claude Code CLI users, the same server doubles as a host-terminal escape hatch and registers in one line:

```bash
claude mcp add cowork-terminal -- npx -y cowork-terminal-mcp
```

The only prerequisite is bash. On macOS and Linux the system shell is fine. On Windows, [Git for Windows](https://git-scm.com/download/win) must be installed -- and the server is opinionated about which `bash.exe` it will accept, which is the next interesting bit.

## The Windows Git Bash trap

`spawn("bash")` on Windows looks innocent and is almost always wrong. Windows PATH ordering puts `C:\Windows\System32` near the front, and `System32\bash.exe` exists on most modern Windows installs. That binary is the WSL launcher. When the MCP server hands a command to it, the command runs inside a Linux VM that cannot see the Windows filesystem the way the host does, cannot read the Windows `PATH`, and cannot execute Windows `.exe` files. The visible symptom is funny: `dotnet --version` returns "command not found" even though the .NET SDK is clearly installed and on `PATH`. So is `node`, `npm`, `git`, every Windows-native tool the agent reaches for.

`cowork-terminal-mcp` fixes this at startup. `resolveBashPath()` skips PATH lookup entirely on Windows and walks a fixed list of Git Bash install locations:

```typescript
const candidates = [
  path.join(programFiles, "Git", "bin", "bash.exe"),
  path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
  path.join(programFilesX86, "Git", "bin", "bash.exe"),
  path.join(programFilesX86, "Git", "usr", "bin", "bash.exe"),
  localAppData && path.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
  localAppData && path.join(localAppData, "Programs", "Git", "usr", "bin", "bash.exe"),
];
```

The first one that `existsSync` confirms wins, and the resolved absolute path is what `spawn` is called with. If none exists, the server throws at module-load time with an error that names every path it checked and points at `https://git-scm.com/download/win`. There is no fallback to System32 bash and no silent degradation.

The broader lesson: on Windows, "trust PATH" is a foot-gun whenever a specific binary's behavior matters. Resolve by absolute path or fail loudly. The fix shipped in v0.4.1 explicitly because users were watching the agent insist `dotnet` was missing on machines where it was clearly installed.

## Timeouts, output caps, and the one shell rule

Three more deliberate choices show up in the executor.

**AbortController instead of a shell timeout.** When a command exceeds its `timeout`, the server does not wrap the bash invocation in `timeout 30s ...`. It calls `abortController.abort()`, which Node.js translates to a process kill. The child emits an `error` event whose `name` is `AbortError`, the handler clears the timer, and the tool resolves with `exitCode: null` and `timedOut: true`:

```typescript
const timer = setTimeout(() => {
  abortController.abort();
}, options.timeout);

child.on("error", (error) => {
  clearTimeout(timer);
  if (error.name === "AbortError") {
    resolve({ stdout, stderr, exitCode: null, timedOut: true });
  } else {
    reject(error);
  }
});
```

This keeps the timeout machinery out of the user's command string and behaves identically on Windows and Unix.

**1MB cap, per stream, baked in.** `stdout` and `stderr` are accumulated into JavaScript strings, but each `data` event is gated on `length < MAX_OUTPUT_SIZE` (1,048,576 bytes). Once the cap is hit, additional data is dropped and a flag is set. The final result string is suffixed with `[stdout truncated at 1MB]`. That is the cost of buffering rather than streaming: the model gets a clean structured result, but `tail -f some.log` is not a workload this server is built for. A typical `npm test` or `dotnet build` fits comfortably.

**The shell is bash, period.** v0.3.0 had a `shell` parameter that let the model pick `cmd` on Windows. v0.4.0 removed it. The reason is buried in the [CHANGELOG](https://github.com/marius-bughiu/cowork-terminal-mcp/blob/main/CHANGELOG.md): `cmd.exe`'s double-quote rules silently truncate multi-line strings at the first newline, so heredoc bodies the model sent through `cmd` collapsed to their first line. The model would assume the command ran with the body it constructed; bash on the other side disagreed. Removing the choice was cheaper than teaching the model to always pick bash. It is also why the tool description (in `src/tools/execute-command.ts`) actively coaches the model to use heredocs:

```
gh pr create --title "My PR" --body "$(cat <<'EOF'
## Summary

- First item
- Second item
EOF
)"
```

The `\n` characters in the JSON `command` string decode to real newlines before bash sees them, and bash's heredoc semantics handle the rest.

## No PTY, by design

The child is spawned with `stdio: ["ignore", "pipe", "pipe"]` -- no pseudo-terminal. There is no way to attach to a running prompt, no terminal width signaling, no color negotiation by default. For build commands, package installs, git, and test runs, this is fine; the model gets clean output uncluttered by ANSI escapes. For `vim`, `top`, `lldb`, or any REPL that expects an interactive TTY, this is the wrong tool. The server makes no attempt to fake one.

That tradeoff is deliberate. A PTY-backed MCP server would need streaming, partial-output protocol, and interactive I/O semantics that MCP itself does not currently model well. `cowork-terminal-mcp` stays inside the boundary where one-shot command execution actually fits the protocol.

## When this is the right bridge

`cowork-terminal-mcp` is small on purpose. One tool, stdio only, fail-loud bash resolution, deliberate output caps, no shell choice, no PTY. If you run Claude Cowork on Windows and want it to actually run things on the host, this is the bridge that makes the sandbox boundary stop hurting. If you already run Claude Code CLI, it is a cheap extra capability to have registered for the day a workflow needs to step outside the model's built-in `Bash` tool. Source and issues are at [github.com/marius-bughiu/cowork-terminal-mcp](https://github.com/marius-bughiu/cowork-terminal-mcp); the package is on npm at [cowork-terminal-mcp](https://www.npmjs.com/package/cowork-terminal-mcp).
