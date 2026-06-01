---
title: "Fix: MCP Servers Stopped Working After a Claude Desktop Update on Windows"
description: "After an MSIX update, Claude Desktop on Windows reads claude_desktop_config.json from a virtualized path while Edit Config opens the old %APPDATA% one. Edit the file under AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc and restart."
pubDate: 2026-06-01
template: error-page
tags:
  - "errors"
  - "mcp"
  - "claude-code"
  - "ai-agents"
  - "windows"
---

If your MCP servers vanished from Claude Desktop on Windows after an update, the config file did not break. The app moved. The "Edit Config" button still opens `%APPDATA%\Claude\claude_desktop_config.json`, but the MSIX build now reads from a virtualized copy under `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\`. Edit the file at that path instead, then fully quit and relaunch.

That one-paragraph fix is the whole story for most people. The rest of this post explains why an in-place update silently relocates the file Claude reads, how to find the real path on your machine in one command, and the traps (symlinks, blank screens, stale logs) that turn a five-minute fix into an afternoon. Everything below is verified against Claude Desktop 1.1.x on Windows 11 (build 26100), specifically the MSIX builds 1.1.3189.0 through 1.1.4173 where this surfaced, package family name `Claude_pzs8sxrjxfjjc`, the MCP specification dated [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), and the official [local MCP server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

## The symptom, exactly as it shows up

Nothing throws. That is what makes this one nasty. You update Claude Desktop, restart it, and the slider/hammer icon that lists your MCP tools is either empty or gone. No dialog, no red banner, no entry in `Settings -> Developer` complaining about bad JSON.

```text
- MCP tools that worked yesterday are missing after the update
- Settings -> Developer shows no servers (or fewer than configured)
- "Edit Config" opens a file that still has your full mcpServers block
- That file looks 100% correct -- valid JSON, right command, right args
- %APPDATA%\Claude\logs\mcp.log is empty or has no entry for your server
```

The second-to-last line is the tell. The config you are staring at is syntactically perfect, which sends people down a rabbit hole of escaping backslashes and reinstalling Node. The JSON is fine. Claude Desktop is simply reading a different file.

## Why an update relocates the file Claude reads

Claude Desktop on Windows ships as an [MSIX package](https://learn.microsoft.com/en-us/windows/msix/overview). The official `.exe` installer from claude.ai, the Microsoft Store build, and `winget install Anthropic.Claude` all land you on the MSIX path now. MSIX runs the app inside a lightweight container with a virtualized filesystem. When the app writes to `%APPDATA%\Claude\` (that is `C:\Users\<you>\AppData\Roaming\Claude\`), Windows transparently redirects that write into the package's private store:

```text
C:\Users\<you>\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json
```

So the running app reads and writes the virtualized copy. The problem is the "Edit Config" button. It calls Electron's `shell.openPath()`, which hands the path to the Windows shell, which is **not** inside the MSIX container and therefore does **not** apply the redirection. The button opens the real, non-virtualized `%APPDATA%\Claude\claude_desktop_config.json` in Notepad. You edit that one. Claude reads the other one. They drift apart. This is tracked in [anthropics/claude-code#26073](https://github.com/anthropics/claude-code/issues/26073) and the sibling Extensions-folder version in [#27041](https://github.com/anthropics/claude-code/issues/27041).

Why does it bite specifically *after an update*? Two ways. First, a fresh install or a migration to the MSIX build creates the virtualized config from scratch, leaving your hand-edited `%APPDATA%` file orphaned. Second, the official docs and every tutorial point at `%APPDATA%\Claude\claude_desktop_config.json`, which is genuinely where older non-MSIX builds read from. The doc was right; the packaging changed underneath it.

## A 30-second confirmation that you have the MSIX build

Before you edit anything, confirm which build you are on. Open PowerShell and run:

```powershell
# Windows 11, PowerShell 5.1+ -- confirms the MSIX package and its family name
Get-AppxPackage -Name "*Claude*" | Select-Object Name, PackageFullName, PackageFamilyName, InstallLocation
```

If you get a row back with `PackageFamilyName` of `Claude_pzs8sxrjxfjjc` and an `InstallLocation` under `C:\Program Files\WindowsApps\Claude_...`, you are on the MSIX build and this post applies. If the command returns nothing, you are on a legacy non-MSIX install and your config really is at `%APPDATA%\Claude\` -- your problem is something else (start with [the HTTP-transport mismatch](/2026/05/fix-http-mcp-server-url-wont-connect-in-claude-desktop/) or a [stdio hang](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/)).

Do not hardcode `Claude_pzs8sxrjxfjjc` into scripts you share. The `pzs8sxrjxfjjc` segment is the publisher hash and is stable today, but derive it at runtime so your tooling survives a republish:

```powershell
# Windows 11, PowerShell 5.1+ -- resolve the real config path without hardcoding the hash
$pkg = (Get-AppxPackage -Name "*Claude*").PackageFamilyName
$cfg = Join-Path $env:LOCALAPPDATA "Packages\$pkg\LocalCache\Roaming\Claude\claude_desktop_config.json"
$cfg
Test-Path $cfg
```

`Test-Path` returning `True` confirms the file the app actually reads exists. That is the file to edit.

## The fix, in order of preference

### 1. Edit the virtualized config and restart (the correct fix)

Open the real config in your editor of choice:

```powershell
# Windows 11 -- open the file Claude Desktop actually reads
$pkg = (Get-AppxPackage -Name "*Claude*").PackageFamilyName
notepad (Join-Path $env:LOCALAPPDATA "Packages\$pkg\LocalCache\Roaming\Claude\claude_desktop_config.json")
```

If the file already has content (it usually carries a `preferences` block the app wrote), merge your servers into the existing object rather than overwriting it. Drop your `mcpServers` map in alongside whatever is there:

```json
{
  "preferences": {
    "sidebarMode": "chat"
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:\\Users\\you\\Desktop"
      ]
    }
  }
}
```

Note the doubled backslashes (`C:\\Users\\you`). JSON treats a single backslash as an escape character, so a Windows path needs each separator doubled. A single backslash here is the most common cause of a config that loads on macOS but silently fails on Windows.

Then **fully quit** Claude Desktop. Closing the window is not enough; the app keeps running in the system tray and only reads the config once at process start. Right-click the tray icon and choose Quit (or end the `Claude.exe` processes), then relaunch. The MCP indicator should reappear with your tool count.

If you would rather keep editing the file the "Edit Config" button opens, that is fine too. Copy your finished `%APPDATA%\Claude\claude_desktop_config.json` over the virtualized one after every edit:

```powershell
# Windows 11 -- copy the human-edited config into the path Claude reads, then restart
$pkg = (Get-AppxPackage -Name "*Claude*").PackageFamilyName
$dest = Join-Path $env:LOCALAPPDATA "Packages\$pkg\LocalCache\Roaming\Claude\claude_desktop_config.json"
Copy-Item "$env:APPDATA\Claude\claude_desktop_config.json" $dest -Force
```

Wire that into a tiny script and re-run it whenever you touch the config until the underlying bug is fixed.

### 2. Use Connectors or Desktop Extensions to sidestep the file entirely

If you maintain this on more than one machine, stop hand-editing JSON. For a remote HTTPS MCP server, register it under `Settings -> Connectors -> Add custom connector`; that path never touches `claude_desktop_config.json` and so cannot drift. For a local server you want to distribute, package it as a `.dxt` [Desktop Extension](https://support.claude.com/en/articles/10065433-installing-extensions-on-claude-desktop) and install it with one click. Both routes are immune to the path-redirection bug because neither writes to the file the broken button opens. The tradeoffs between these transports are the same ones covered in [why an HTTP MCP server URL won't connect in Claude Desktop](/2026/05/fix-http-mcp-server-url-wont-connect-in-claude-desktop/).

### 3. Last resort: reinstall as a non-MSIX build

If you are blocked and cannot wait, uninstalling the Store/MSIX package and installing a standalone build returns config handling to the documented `%APPDATA%\Claude\` path. This is a heavy hammer, it loses the auto-update channel, and Anthropic is converging on MSIX, so treat it as temporary. Prefer fix 1.

## Reading the logs to confirm it worked

Logs have the same split-brain problem. The official docs point at `%APPDATA%\Claude\logs\mcp.log`, but the running MSIX app writes its logs into the virtualized tree next to the config it actually uses. Tail the real one:

```powershell
# Windows 11 -- read the MCP logs from the virtualized path
$pkg = (Get-AppxPackage -Name "*Claude*").PackageFamilyName
$logs = Join-Path $env:LOCALAPPDATA "Packages\$pkg\LocalCache\Roaming\Claude\logs"
Get-Content (Join-Path $logs "mcp.log") -Tail 40
```

A healthy startup logs a line per server with an `initialize` handshake and a tool count. A server that failed to spawn logs the spawn error here, in `mcp-server-<name>.log`. If `mcp.log` is empty after a restart, Claude never even tried to launch a server, which means it is still reading a config without an `mcpServers` block -- you edited the wrong file again.

## Gotchas and lookalikes

- **Do not symlink the two paths together.** Pointing `%APPDATA%\Claude` at the package's `LocalCache\Roaming\Claude` (or vice versa) looks clever and reliably produces a blank white window on the next launch, because the MSIX layer tries to virtualize a path that is already a reparse point. Reported repeatedly under [#26073](https://github.com/anthropics/claude-code/issues/26073). Copy the file; do not link the directory.
- **`${APPDATA}` showing up literally in a server's error log is a different bug.** If a server fails with a path containing the literal text `${APPDATA}`, the npx child process did not inherit the variable. Add an explicit `"env": { "APPDATA": "C:\\Users\\you\\AppData\\Roaming\\" }` to that server entry, per the official [troubleshooting note](https://modelcontextprotocol.io/docs/develop/connect-local-servers). That is unrelated to the MSIX relocation.
- **Servers connected but no tools appear** is the silent-failure cousin you hit once the config is in the right place. Walk it the same way you would [GitHub MCP tool calls that fail silently without a PAT](/2026/05/fix-github-mcp-server-tool-calls-fail-silently-without-pat/): check the per-server log, then run the server command by hand in a terminal.
- **`MCP server disconnected` immediately after connecting** is usually a stdio lifecycle problem, not a path problem. If you run Claude under WSL or proxy the server, see [why Claude Code reports "MCP server disconnected" inside WSL](/2026/05/fix-claude-code-reports-mcp-server-disconnected-inside-wsl/).
- **The Extensions folder buttons are wrong too.** `Settings -> Extensions -> Advanced -> Open Extensions Folder` opens the same stale `%APPDATA%` location and errors with "is unavailable" ([#27041](https://github.com/anthropics/claude-code/issues/27041)). Same cause, same `LocalCache\Roaming\Claude` destination.
- **Claude Code, the CLI, is not affected.** It reads `~/.claude.json`, which is a normal file outside any MSIX container. If you are building MCP servers anyway, pointing the CLI at them locally avoids this whole class of problem; the [TypeScript wrap-a-CLI walkthrough](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) starts from an empty repo.

## Related

- [Fix: HTTP MCP Server URL Won't Connect in Claude Desktop](/2026/05/fix-http-mcp-server-url-wont-connect-in-claude-desktop/) covers the other big Claude Desktop config trap: pasting a `url` field into a stdio-only file.
- [Fix: MCP Server stdio Hang When Launched From Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/) for when the config is right but the server never finishes its handshake.
- [Fix: GitHub MCP Server Tool Calls Fail Silently When the PAT Isn't Passed](/2026/05/fix-github-mcp-server-tool-calls-fail-silently-without-pat/) for the "connected but no tools" follow-on symptom.
- [Fix: Claude Code Reports "MCP Server Disconnected" Inside WSL](/2026/05/fix-claude-code-reports-mcp-server-disconnected-inside-wsl/) for the cross-boundary version of a dropped connection.
- [How to Build a Custom MCP Server in TypeScript That Wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) if you want a known-good server to test the fixed config against.

## Sources

- `anthropics/claude-code` issue [#26073](https://github.com/anthropics/claude-code/issues/26073): "Edit Config" opens the wrong `claude_desktop_config.json` on Windows MSIX; MCP servers silently fail to load.
- `anthropics/claude-code` issue [#27041](https://github.com/anthropics/claude-code/issues/27041): Desktop app points to the wrong Extensions directories on Windows.
- Model Context Protocol docs, [Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers): documented config path, restart steps, and log locations.
- Microsoft Learn, [MSIX packaging and filesystem virtualization](https://learn.microsoft.com/en-us/windows/msix/overview).
- Anthropic Help Center, [Installing extensions on Claude Desktop](https://support.claude.com/en/articles/10065433-installing-extensions-on-claude-desktop).
