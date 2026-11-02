---
title: "Fix: Claude Code Reports `MCP server disconnected` Inside WSL"
description: "Diagnose MCP disconnects across Windows and WSL: check the actual launcher, stdio output, NAT versus mirrored networking, and evidence of process termination."
updatedDate: 2026-11-02
pubDate: 2026-05-19
tags:
  - "mcp"
  - "claude-code"
  - "ai-agents"
  - "wsl"
  - "windows"
---

`MCP server disconnected` tells you the connection is unavailable; it does not identify whether a subprocess failed to start, exited later, or a remote connection dropped. In WSL, first establish which operating system runs Claude Code and which runs the server. Then investigate the failing transport.

> **Correction — November 2, 2026:** Removed an unpublished MCP version, unsupported testing and reconnect-setting claims, and incorrect explanations of WSL localhost forwarding and memory reclamation. The Windows/WSL steps below were checked against official documentation, not reproduced on a Windows machine.

## Identify the launcher and configuration

Run these in the environment where you start Claude Code:

```bash
# Inside WSL
command -v claude
command -v node
command -v python3
claude --version
claude mcp get my-server
claude --debug
```

On Windows, use `Get-Command claude`, `Get-Command node`, and `Get-Command npx` in PowerShell. Do not infer the operating system from the terminal window: Windows Terminal can host a Linux shell, and a WSL shell can launch Windows executables through interoperability.

`claude mcp get my-server` inspects the registered entry; `/mcp` shows the active session's server state. Debug log wording varies by release. Look for the actual executable, arguments, connection error, exit code and timestamp rather than a particular hard-coded log prefix. Avoid sharing credentials from configuration or logs.

For ordinary CLI scopes, a same-named local entry takes precedence over project, then user configuration. Managed settings can also override these. Check the [scope rules](https://code.claude.com/docs/en/mcp#scope-hierarchy-and-precedence) before changing an entry that the session is not using.

## Launch a Linux stdio server deliberately

If Claude Code runs inside WSL, use the Linux interpreter and Linux paths directly. If Claude Code runs natively on Windows but the server must run in Ubuntu, make the boundary explicit:

```powershell
claude mcp add --transport stdio --scope project my-server -- wsl.exe -d Ubuntu --exec /home/me/proj/.venv/bin/python -u /home/me/proj/server.py
```

Replace the distro and paths. `--exec` runs the command without the default Linux shell, avoiding its startup files; `--` alone only passes the remaining command line through. Microsoft documents this distinction in the [WSL release notes, Build 18305](https://learn.microsoft.com/en-us/windows/wsl/release-notes#build-18305). If the server requires a working directory, use a small Linux launcher:

```bash
#!/bin/sh
set -eu
cd /home/me/proj
exec /home/me/proj/.venv/bin/python -u /home/me/proj/server.py
```

Register `wsl.exe -d Ubuntu --exec /bin/sh /home/me/proj/start-mcp.sh` as the command and arguments. A failed `cd` must stop the launcher; replacing `&&` with `;` can run the server in the wrong directory. A login shell does not guarantee that a particular `nvm` installation will be initialized. Absolute paths make that dependency explicit.

The launcher and server must reserve stdout for MCP messages. Diagnostics belong on stderr. A process waiting quietly for stdin is normal for stdio and is not, by itself, proof that its MCP handshake works. Use an SDK client or Inspector to establish that, as shown in the [stdio troubleshooting guide](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/).

## Handle Windows command shims where necessary

The official [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) documents `cmd /c` for an `npx` stdio launcher on native Windows:

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", "C:\\projects"]
    }
  }
}
```

Use only a server package you intend to run and a directory it should access. This is a shim-specific workaround, not a rule that every Windows launcher needs a shell. For example, an actual `.exe` can be launched directly. Check the resolved command before adding wrappers.

## Distinguish the two directions of WSL networking

HTTP servers are independent processes, so their failures concern addresses and listeners rather than stdio spawning. Under the default NAT architecture, Microsoft's [WSL networking documentation](https://learn.microsoft.com/en-us/windows/wsl/networking) distinguishes these cases:

| Client and server | Address to investigate |
| --- | --- |
| Windows client → WSL server | Windows can normally access the WSL application through `localhost`; check forwarding and the listening application if it fails. |
| WSL client → Windows server | Normally use the Windows host IP, with a listener and firewall rule that permit that connection. |
| Mirrored networking | Supported configurations allow the Linux side to reach Windows through `127.0.0.1`; this does not mean the two operating systems share every socket. |

From WSL, the default gateway can identify the Windows host in NAT mode:

```bash
ip route show default | awk '{print $3}'
```

On supported Windows 11 systems, mirrored networking is configured in the Windows user's `.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Apply configuration changes with `wsl --shutdown` from Windows after saving work; it stops running WSL distributions. Consult the networking documentation for Windows version requirements and firewall behavior. `hostAddressLoopback` is not required for the documented `127.0.0.1` case.

Do not expose a local MCP server on every interface merely to work around an address mismatch. The [published Streamable HTTP security guidance](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning) recommends a loopback bind for local servers, Origin validation and appropriate authentication. If cross-host access is intentional, configure the specific listener and firewall accordingly.

## Investigate a connection that drops later

Check whether the process exited, the machine slept, the network changed, or authentication expired. `SIGKILL` or a shell status of 137 alone does not prove an out-of-memory event. Correlate it with Linux kernel logs, for example `dmesg` or `journalctl -k` where available and permitted. WSL cache reclamation is not evidence that Windows killed the newest or largest MCP process.

Change memory or swap settings only after establishing memory pressure; there is no universal RAM setting that fixes disconnects. Microsoft's [WSL configuration reference](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) describes those controls.

For an interactive Claude Code session, select the failed stdio server in `/mcp` and reconnect it. Current [reconnection documentation](https://code.claude.com/docs/en/mcp#automatic-reconnection) distinguishes remote retries from restarting an exited stdio process. There is no documented `claude config get mcp.autoReconnect` setting to enable.

A refused HTTP connection has its own diagnostic path: [MCP ECONNREFUSED and readiness checks](/2026/05/fix-econnrefused-when-a-local-mcp-server-starts-before-the-client-is-ready/). A transport closure during a request is covered in [MCP error -32000](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/).
