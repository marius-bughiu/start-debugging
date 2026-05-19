---
title: "Fix: Claude Code Reports `MCP server disconnected` Inside WSL"
description: "Why Claude Code shows 'MCP server disconnected' or 'Connection closed' for a working MCP server when launched from WSL2. Covers stdio spawning across the Windows/Linux boundary, npx and node ENOENT, mirrored networking for HTTP servers, VMMem reaping, and how to diagnose the right one with claude --debug."
pubDate: 2026-05-19
tags:
  - "mcp"
  - "claude-code"
  - "ai-agents"
  - "wsl"
  - "windows"
---

If Claude Code logs `MCP server disconnected` or `Connection closed` for an MCP server that runs fine from a plain `npx` or `python` shell inside WSL2, you are not chasing a bug in the server. You are chasing one of four boundary problems between Windows, WSL2's Linux VM, and the way Claude Code spawns subprocesses. This post walks through each one, with the exact `~/.wslconfig`, `mcp.json`, and `claude mcp add` syntax that makes the disconnect go away. Tested against Claude Code 2.1.128 on Windows 11 26200, WSL 2.4.x with kernel 6.6, the MCP TypeScript SDK 1.29.0, the Python SDK 1.13.0, and the MCP spec dated [2026-03-26](https://modelcontextprotocol.io/specification/2026-03-26).

## TL;DR

`MCP server disconnected` from inside or alongside WSL almost always falls into one of these buckets, in rough order of frequency:

1. **Wrong host runs the server**: Claude Code is installed on Windows but you registered the MCP server with a Linux command. The Windows host has no `bash`, no `node`, or a different `node`, so the spawn fails immediately and the client logs a disconnect.
2. **`npx`/`node` ENOENT on Windows side**: Claude Code is on Windows, the server is meant to run on Windows, but `npx` is a `.cmd` shim that Node's `child_process.spawn` cannot launch without `cmd /c`.
3. **NAT loopback breaks HTTP/SSE MCP**: Claude Code runs inside WSL but the MCP server listens on `127.0.0.1:port` on the Windows host (or the reverse). WSL2's default NAT mode hides them from each other.
4. **VMMem reaping or sleep/resume**: The server connects, then disconnects mid-session because Windows reclaimed the WSL2 VM or your laptop slept. Claude Code logs a clean disconnect but the cause is upstream.

Run `claude --debug` once and the right bucket is usually obvious from the spawn line. The rest of the post is the fixes, in that order.

## What "disconnected" actually means

The MCP stdio transport is defined in the [transports section of the spec](https://modelcontextprotocol.io/specification/2026-03-26/basic/transports): the client launches the server as a subprocess, writes JSON-RPC 2.0 over stdin, and parses newline-delimited JSON-RPC from stdout. There is no heartbeat. If the subprocess exits, or if `spawn()` itself errors with `ENOENT`, the client surfaces it as `MCP server disconnected`. There is no distinction in the UI between "never started" and "started, then crashed".

Claude Code 2.1.128 logs the actual cause in two places:

```powershell
# Windows PowerShell or pwsh
claude --debug 2>&1 | Select-String -Pattern "mcp|spawn|stdio"
```

```bash
# Inside WSL
claude --debug 2>&1 | grep -E "mcp|spawn|stdio"
```

You want the line that starts with `Spawning MCP server` and the line immediately after, which is usually one of: `Error: spawn npx ENOENT`, `Error: spawn EACCES`, `MCP server exited with code 1`, or `Connection closed`. Each one points at a different bucket below.

`claude mcp list` is the second diagnostic: it prints the configured command and args verbatim, which is how you confirm what is actually being spawned versus what you think you registered.

## Decide which side runs Claude Code first

WSL turns a single-host story into a two-host one. Before any fix, pin down which `claude` binary is running, because that decides where the server has to live.

```powershell
# In Windows PowerShell
where.exe claude
# Typically: C:\Users\<you>\AppData\Local\AnthropicClaude\claude.exe
#   or:     C:\Users\<you>\.npm\bin\claude  (npm global install)
```

```bash
# In WSL
which claude
# Typically: /home/<you>/.npm-global/bin/claude
#   or:     /usr/local/bin/claude
```

If you have both, you have two independent installations with two independent `~/.claude/` directories and two independent MCP registries. Edits in one are invisible to the other. The first thing the `MCP server disconnected` reports usually mean is: "the side you are typing into is not the side where the MCP server lives." Pick one and stick with it.

## Fix 1: Claude Code on Windows, server on the WSL side

This is the most common shape and the trickiest to wire up. Claude Code runs in Windows Terminal or VS Code on Windows, but the MCP server is a Python or Node process you want to run inside Ubuntu because that is where your project, your `venv`, and your `node_modules` live.

The fix is to register the server with `wsl.exe` as the command. Everything inside the args runs in Linux:

```powershell
# Claude Code 2.x, run from Windows PowerShell
claude mcp add --transport stdio my-server `
  --scope project `
  -- wsl.exe -d Ubuntu -- bash -lc `
  "cd /home/me/proj && /home/me/.venv/bin/python -m my_server"
```

A few things matter here and they bite people in this exact order:

- **`-lc`, not `-c`**: a login shell sources `~/.profile` and `nvm.sh`, so `node`, `python`, and `PATH` resolve. With plain `-c`, a `node` installed via `nvm` is invisible because nvm only initializes for interactive or login shells.
- **Absolute interpreter paths**: even with `-lc`, prefer `/home/me/.venv/bin/python` or `/usr/bin/node` over bare `python`. Claude Code spawns the subprocess with a minimal env, and `which python` differing between your terminal and Claude Code's spawn is a leading cause of intermittent disconnects.
- **`;` over `&&` in some chains**: `bash -lc` handles `&&` correctly. `cmd /c wsl -- ...` does not always; if you see the first command run and the second silently skipped, switch the separator to `;`.
- **Pin the distro**: `-d Ubuntu` removes one source of nondeterminism. If you have two distros and the default changes, the server config silently points at nothing.

For the special case of running `claude mcp serve` itself (Claude Code's built-in MCP server) from a Windows IDE that wants to talk to your WSL repo, the working [community config](https://github.com/BAM-DevCrew/Claude-Code-MCP-Server-WSL) is the same shape:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "wsl",
      "args": [
        "-d", "Ubuntu",
        "bash", "-lc",
        "cd /mnt/c/repos/my-project; /usr/bin/claude mcp serve"
      ]
    }
  }
}
```

Note `/mnt/c/repos/my-project`, not `C:\repos\my-project`. Windows paths reach WSL through `/mnt/<drive>/`. Forget the translation and you get a clean disconnect with `cd: No such file or directory` buried in the debug log.

## Fix 2: `spawn npx ENOENT` when Claude Code is on Windows

If both sides are Windows and you have not touched WSL at all, the disconnect is almost always Node's `spawn()` refusing to launch a `.cmd` shim. `npx` on Windows is `npx.cmd`, a batch wrapper. `child_process.spawn("npx", ...)` without `shell: true` calls `CreateProcess` directly, which only accepts real executables, not batch files. The MCP host wraps `spawn`, so the failure surfaces as `Error: spawn npx ENOENT` followed by `MCP server disconnected`. This is the same root cause documented in [modelcontextprotocol/servers#40](https://github.com/modelcontextprotocol/servers/issues/40).

Two fixes, in order of preference:

```powershell
# Preferred: wrap with cmd /c so CreateProcess sees a real exe
claude mcp add --transport stdio context7 `
  -- cmd /c npx -y @upstash/context7-mcp@latest
```

```json
// .claude.json / project mcp config equivalent
{
  "mcpServers": {
    "context7": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@upstash/context7-mcp@latest"]
    }
  }
}
```

The `-y` flag prevents the npx install prompt from blocking stdin and causing the same disconnect for a completely different reason -- the prompt corrupts the JSON-RPC framing on stdout. The dedicated [MCP server stdio hang post](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/) covers that failure mode in depth.

The alternative is to skip the shim entirely. Install the server globally and point Claude Code at the real `node.exe`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@modelcontextprotocol\\server-filesystem\\dist\\index.js",
        "C:\\projects"
      ]
    }
  }
}
```

This is uglier but the most robust option, because there is no shell, no shim, and `spawn()` is calling a real Win32 binary with an absolute path.

## Fix 3: HTTP or SSE MCP across the WSL/Windows boundary

The stdio problems above only apply when the server runs as a subprocess. If you use the HTTP or SSE transport, the disconnect mode is networking, not spawning.

WSL2 in its default networking mode runs as a Hyper-V VM with NAT. From inside WSL, `127.0.0.1` points at the Linux VM's loopback. From Windows, `127.0.0.1` points at the Windows loopback. They are not the same interface. A Claude Code instance running on the Windows side that tries to reach `http://127.0.0.1:3000/sse` will not hit a server bound to `localhost:3000` inside WSL, and vice versa. The MCP client logs `Connection refused` or `socket hang up` and surfaces it as `MCP server disconnected`.

The clean fix is mirrored networking. It collapses the two loopback interfaces into one, so `127.0.0.1` resolves to the same place on both sides. Put this in `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored

[experimental]
hostAddressLoopback=true
```

Then restart WSL from an elevated PowerShell:

```powershell
wsl --shutdown
```

The next `wsl` invocation rebuilds the VM with mirrored mode. The Microsoft [WSL networking docs](https://learn.microsoft.com/en-us/windows/wsl/networking) describe the trade-offs: mirrored mode is faster and removes the NAT loopback gap, but it can interact badly with Docker Desktop's networking and some corporate VPNs. If you hit one of those, the fallback is to bind your MCP server on `0.0.0.0` and use the Windows host's actual IP from inside WSL (`ip route show | awk '/^default/ {print $3}'`) instead of `127.0.0.1`. That works without `.wslconfig` changes but is fragile across reboots.

## Fix 4: Server connected, then disconnects mid-session

The other reports of `MCP server disconnected` come from mid-session drops, not startup failures. The server's `initialize` succeeds, tools register, you run a few prompts, and then twenty minutes in everything detaches. This is almost never the server, and the debug log shows `MCP server exited with code 137` or `... signal SIGKILL`.

Two upstream causes account for most of these:

**VMMem reaping**. By default WSL2 lets the VM grow to 50% of host RAM, and Windows is aggressive about reclaiming it for foreground processes. A long Claude Code session that loaded a couple of MCP servers, `node_modules`, and a browser-test subagent can comfortably push the VM over the cap, at which point the OOM killer takes the youngest large process, which is frequently the MCP server. Cap it explicitly and enable cache reclaim:

```ini
# C:\Users\<you>\.wslconfig
[wsl2]
memory=12GB
swap=4GB
localhostForwarding=true

[experimental]
autoMemoryReclaim=dropcache
sparseVhd=true
```

Pick the cap based on physical RAM: 6 GB for a 16 GB machine, 12 GB for 32 GB, 24 GB for 64 GB. `autoMemoryReclaim=dropcache` tells WSL to release page cache back to Windows instead of hoarding it, which is what flips the OOM-killer trigger most often. `wsl --shutdown` to apply.

**Sleep/resume**. WSL2's network stack is fragile across a host sleep. The MCP server keeps its TCP socket open, Windows resumes, the socket is half-closed, the next JSON-RPC write fails with `EPIPE`, Claude Code logs the disconnect. There is no perfect fix in WSL 2.4 short of running the server through a process supervisor (`pm2`, `systemd --user`) that restarts it on exit. The pragmatic workaround is to set Claude Code to re-init MCP servers on focus return; it is enabled by default in 2.1.128, but disabled in older versions. Confirm with:

```bash
claude config get mcp.autoReconnect
# expected: true
```

If you are on a Windows Insider Canary build, also check `wsl --version` against [release notes](https://github.com/microsoft/WSL/releases) -- a handful of recent Hyper-V changes broke WSL networking briefly, and mirrored mode in particular was unstable on a couple of Canary builds. Pin to a stable kernel with `wsl --update --rollback` if you are seeing disconnects only on Canary.

## Diagnostic playbook

When the disconnect is not obviously one of the four above, walk through this in order. None of these steps need server changes.

1. `claude mcp list`. Confirm the command Claude Code thinks it should run, not the one you think you registered. A stale entry from `--scope user` overrides a fresher project-scope entry of the same name.
2. `claude --debug` and reproduce the disconnect. Read the line right after `Spawning MCP server`. `ENOENT` is Fix 1 or 2. `Connection refused` is Fix 3. `code 137` or `SIGKILL` is Fix 4.
3. Run the exact same command outside Claude Code. If `wsl.exe -d Ubuntu -- bash -lc "/home/me/.venv/bin/python -m my_server"` works from a Windows PowerShell prompt and produces JSON-RPC output, the problem is environment, not the server. If it does not, fix that first and Claude Code follows.
4. `wsl --status` and `wsl --version`. Anything older than 2.0.0 is too old for mirrored networking; anything newer than the official Store release on Canary is unsupported and prone to disconnects.
5. `/doctor` inside Claude Code. It will not diagnose WSL networking, but it will tell you if MCP config validation failed or if Claude Code is on a stale CLI version that has known stdio bugs.

## Related posts

- The companion stdio failure mode that is not WSL-specific is covered in [stdout pollution and other stdio hangs](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/). Read that one if your server connects and then registers zero tools.
- Once your MCP server runs cleanly, the patterns in [Build a Custom MCP Server in TypeScript](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) and [Build a Custom MCP Server in Python](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) are the next stop.
- For C# servers running under WSL, [Build a Custom MCP Server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) covers the `Microsoft.Extensions.AI` host setup that does not have these Windows shim problems but does have its own PATH gotchas.
- If you ended up here because a long agent loop disconnected mid-flow rather than at startup, [Fix: Context Window Exceeded During an Aider Refactor](/2026/05/fix-context-window-exceeded-during-an-aider-refactor/) shows the prompt-side gotchas that look the same in Claude Code.

## Sources

- [MCP specification 2026-03-26: transports](https://modelcontextprotocol.io/specification/2026-03-26/basic/transports)
- [Claude Code troubleshooting docs](https://code.claude.com/docs/en/troubleshooting)
- [modelcontextprotocol/servers#40 -- npx ENOENT on Windows](https://github.com/modelcontextprotocol/servers/issues/40)
- [Microsoft WSL networking documentation](https://learn.microsoft.com/en-us/windows/wsl/networking)
- [Microsoft `.wslconfig` reference](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)
- [BAM-DevCrew Claude-Code-MCP-Server-WSL working config](https://github.com/BAM-DevCrew/Claude-Code-MCP-Server-WSL)
