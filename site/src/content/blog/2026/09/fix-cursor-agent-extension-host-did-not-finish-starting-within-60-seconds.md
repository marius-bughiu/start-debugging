---
title: "Fix: Cursor Agent Won't Initialise Because the Extension Host Didn't Finish Starting Within 60 Seconds"
description: "Agent Execution Timed Out, ERROR_EXTENSION_HOST_TIMEOUT and Timeout waiting for EverythingProvider are one failure: Cursor's extension host missed its 60 s startup budget. Read exthost.log first, then fix the right cause: endpoint security, a VPN capturing loopback, a corrupt state database, or an extension."
pubDate: 2026-09-13
template: error-page
tags:
  - "errors"
  - "cursor"
  - "ai-agents"
  - "troubleshooting"
---

**Short answer:** "Agent Execution Timed Out" (`ERROR_EXTENSION_HOST_TIMEOUT`) and "Timeout waiting for EverythingProvider" in network diagnostics are the same failure. Cursor's extension host, the Node process that runs the agent's tools, did not finish starting within the 60 second budget, so the Agent never registered. Reinstalling or switching models will not fix it. Open `exthost.log` first. If the host never logged a start line, something outside Cursor is blocking it: endpoint security (add Cursor's process and path exclusions) or a VPN in TUN mode capturing `127.0.0.1` (exclude loopback). If the host started but activation stalled, rename `state.vscdb` and bisect your extensions. If activation was fast and the Agent still times out, it is the network path: run diagnostics and switch HTTP Compatibility Mode to HTTP/1.1.

The rest of this post shows how to tell those cases apart from the logs in under a minute. Log paths and timings are from Cursor 3.17.21 on macOS. Error strings are from Cursor's [agent troubleshooting page](https://cursor.com/help/troubleshooting/agent-issues) and forum reports on 2.5.x through 3.7.x.

## The three messages that are one bug

Depending on your Cursor version and where you look, this failure has three names:

```text
Agent Execution Timed Out [deadline_exceeded]
ERROR_EXTENSION_HOST_TIMEOUT
The agent execution provider did not respond in time. This may indicate the
extension host is not running or is unresponsive.
```

On older builds (2.5.x) the last line said "did not respond within 30 seconds". Cursor's docs now describe the condition as the extension host not finishing startup "within 60 seconds, so Agent features couldn't initialize". The third name is in **Cursor Settings > Network > Run Diagnostics**, where Authentication, Cursor Tab, Agent Endpoint and Codebase Indexing all fail with:

```text
Timeout waiting for EverythingProvider
```

That diagnostics output looks like a network outage, which sends people off to debug proxies. Usually the network is fine. The diagnostics call goes through the same extension host, so if the host is not up, every check times out waiting for it.

## Why the Agent depends on the extension host

Cursor is a VS Code fork, and like VS Code it runs extensions in a separate process, the extension host. Cursor ships its own agent machinery as built-in extensions in that process. You can see them in any healthy log directory:

```text
# Cursor 3.17.21, macOS: ~/Library/Application Support/Cursor/logs/<session>/window1_wb0/exthost/
exthost.log
anysphere.cursor-agent-exec/     # runs the agent's tool calls (shell, file edits, grep)
anysphere.cursor-socket/         # local transport between the UI and the host
anysphere.cursor-retrieval/      # indexing, grep service, agent review
anysphere.cursor-mcp/            # MCP servers
anysphere.cursor-always-local/   # Cursor Tab, file sync
```

When you send a prompt, the UI asks the "agent execution provider" (registered by `anysphere.cursor-agent-exec`) to run the tools the model picks. If that provider has not registered, because the host is slow, stuck or dead, the UI waits until the deadline and then shows the timeout. Chat, Tab and indexing go down with it because they are registered by the same process.

For scale, here is the start of a healthy `exthost.log` from Cursor 3.17.21 on an M-series Mac with an empty window:

```text
2026-08-28 18:02:20.772 [info] Extension host with pid 28754 started
2026-08-28 18:02:21.072 [info] ExtensionService#_doActivateExtension anysphere.cursor-agent-exec, startup: true, activationEvent: '*'
2026-08-28 18:02:23.263 [info] Eager extensions activated
```

In between, an `Extension activated success: anysphere.cursor-agent-exec` line reports 2187 ms (580 ms of code loading, 1602 ms waiting for `activate()` to resolve). The whole thing is about 2.5 seconds of a 60 second budget. To hit the timeout, something has to make startup roughly 25 times slower, or block it completely. That narrows the list of suspects a lot.

## Step 1: find exthost.log and read the first lines

Collect the logs before you change anything. The official route is `Cmd/Ctrl+Shift+P` > **Developer: Export Logs...** with Main, Window and Extension Host selected, plus **Output** > **Extension Host** from the dropdown. To read them yourself, the files are at:

```text
# Cursor 3.x log roots (one timestamped folder per app launch)
macOS:   ~/Library/Application Support/Cursor/logs/
Windows: %APPDATA%\Cursor\logs\
Linux:   ~/.config/Cursor/logs/

# then: <timestamp>/window<N>_wb<M>/exthost/exthost.log   (window1/exthost/ on older builds)
```

Pick the newest timestamp folder and the window that failed. This small script sorts that window into one of three buckets:

```js
// exthost-timing.mjs -- Node 18+, tested against Cursor 3.17.21 logs
// Usage: node exthost-timing.mjs "<log root>/<timestamp>/window1_wb0/exthost/exthost.log"
import { readFileSync } from "node:fs";

const lines = readFileSync(process.argv[2], "utf8").split(/\r?\n/);
const ts = (l) => Date.parse(l.slice(0, 23).replace(" ", "T"));

let started, eager;
const rows = [];
for (const l of lines) {
  if (/Extension host with pid \d+ started/.test(l)) started = ts(l);
  if (l.includes("Eager extensions activated")) eager = ts(l);
  const m = l.match(/Extension activated success: (\S+) .*?(\d+)ms/);
  if (m) rows.push({ id: m[1], ms: Number(m[2]) });
}

if (!started) {
  console.log("No 'Extension host ... started' line: the host never came up.");
  process.exit(1);
}
console.log(eager
  ? `host start -> eager extensions activated: ${eager - started} ms (budget 60000 ms)`
  : "Host started but 'Eager extensions activated' never logged: something blocked activation.");
rows.sort((a, b) => b.ms - a.ms).slice(0, 8)
  .forEach((r) => console.log(`${String(r.ms).padStart(7)} ms  ${r.id}`));
```

Against the healthy log above it prints:

```text
host start -> eager extensions activated: 2491 ms (budget 60000 ms)
   2187 ms  anysphere.cursor-agent-exec
    339 ms  anysphere.cursor-always-local
    266 ms  anysphere.cursor-mcp
    103 ms  anysphere.cursor-retrieval
     89 ms  vscode.git
```

The three outcomes map to the three sections below:

| What the log shows | Where the time went | Go to |
|---|---|---|
| No `exthost.log`, or an empty Extension Host output panel | The host process never started or was blocked before logging | Step 2 |
| Host started, one extension takes tens of seconds, or "Eager extensions activated" never appears | Activation is stalling inside the host | Step 3 |
| Eager activation in a few seconds, Agent still times out | The host is fine, the request path is not | Step 4 |

Cursor's docs call the empty panel "a strong diagnostic signal", and it is the most common case on corporate Windows machines.

## Step 2: the host never starts (endpoint security or a VPN on loopback)

### Endpoint security scanning every file the host loads

The extension host loads thousands of small JavaScript files at startup. An antivirus, EDR or DLP agent that scans each file on open adds latency per file, and Cursor's [endpoint security guide](https://cursor.com/docs/enterprise/endpoint-security) explains the result directly: the cumulative delay can exceed Cursor's startup timeout, and features like Agent fail. After startup the modules are in memory, so the rest of the session can feel normal, which is why this looks random.

On Windows, check what is hooked into the filesystem (admin PowerShell):

```powershell
# Windows 11, admin PowerShell -- from Cursor's endpoint security guide
Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct |
  Select-Object displayName, pathToSignedProductExe
fltmc   # filesystem minifilter drivers; ignore WdFilter, bindflt, wcifs, CldFlt, FileInfo and friends
Get-MpComputerStatus | Select-Object IsTamperProtected, RealTimeProtectionEnabled, AMRunningMode
```

On macOS, `systemextensionsctl list` shows the endpoint security system extensions that EDR products install.

The fix is exclusions, and it needs both kinds: **process** exclusions and **path** exclusions, because kernel-level drivers can scan a file no matter which process opened it:

```text
# Cursor endpoint security exclusions (per Cursor's enterprise docs, Sept 2026)
Windows processes: Cursor.exe, rg.exe, inno_updater.exe
Windows paths:     %LOCALAPPDATA%\Programs\cursor\   (user install)
                   %ProgramFiles%\cursor\             (system install)
                   %APPDATA%\Cursor\                  (user data and settings)
macOS:             /Applications/Cursor.app/
```

If you don't manage the security agent, this is a ticket for IT, not something to work around. Send them the endpoint security page and your exported logs. To confirm it worked, restart Cursor fully, run the Agent, and check that the Extension Host output panel fills with normal startup lines.

### A VPN in TUN mode capturing localhost

The second cause is less obvious. The UI talks to the extension host over local loopback (`anysphere.cursor-socket` is that local transport). VPN and proxy clients that run in TUN mode (Clash Verge, v2rayN, sing-box and similar) can capture `127.0.0.0/8` traffic along with everything else. Cursor staff diagnosed several ["Timeout waiting for EverythingProvider" threads](https://forum.cursor.com/t/timeout-waiting-for-everythingprovider/156748) this way, including one where the VPN client was intercepting the Windows network stack while it was switched off.

Exclude loopback from the tunnel. In sing-box that is `route_exclude_address` on the tun inbound:

```json
{
  "inbounds": [
    {
      "type": "tun",
      "stack": "system",
      "auto_route": true,
      "route_exclude_address": ["127.0.0.0/8", "::1/128"]
    }
  ]
}
```

In v2rayN or Clash-based clients, look for the TUN bypass or exclude list and add `127.0.0.1`, `localhost` and `::1`. If you have already uninstalled the VPN, check for leftovers. An orphaned virtual adapter or a stale WinHTTP proxy keeps causing the problem:

```powershell
# Windows: find leftover tunnel adapters and reset a stale machine proxy
Get-NetAdapter | Where-Object InterfaceDescription -match 'Wintun|TAP|TUN|Clash'
netsh winhttp show proxy
netsh winhttp reset proxy
```

Also check **Settings > Network & Internet > Proxy** and make sure a manual proxy is not still set from the old client. In the [second EverythingProvider thread](https://forum.cursor.com/t/timeout-waiting-for-everythingprovider-error/158146), removing Clash Verge leftovers was the only fix that worked for one reporter. Copying `cursor-socket`'s `dist` folder to `out`, a custom `--extensions-dir`, and turning off indexing all failed.

## Step 3: the host starts but activation stalls (state or extensions)

If the script shows the host starting and then one entry taking 20, 40 or more seconds, or never reaching "Eager extensions activated", the problem is inside the host.

### Test with a throwaway profile before deleting anything

The usual forum advice is to delete `~/.cursor` or reinstall. That is destructive, and in the [extension host initialisation thread](https://forum.cursor.com/t/extension-host-fails-to-initialize-timeout-waiting-for-auth-and-plugins-breaking-ai-agents-and-source-control/158539) wiping `~/.cursor` only helped until the host degraded again. Test with an isolated profile first. It changes nothing on disk:

```bash
# Cursor 3.x (VS Code CLI flags). Needs the `cursor` shell command installed
# from the command palette: "Shell Command: Install 'cursor' command in PATH".
cursor --user-data-dir /tmp/cursor-clean --extensions-dir /tmp/cursor-clean-ext ~/some/small/repo
```

`--user-data-dir` gives the instance its own settings, state database and workspace storage. If the Agent works there, the problem is in your real profile: either the state database or an extension.

### A corrupt state database

Cursor keeps UI and workspace state in SQLite files. When `globalStorage/state.vscdb` gets corrupted, the host can freeze during startup. Cursor staff's first suggestion in the [Windows unresponsive-host thread](https://forum.cursor.com/t/agent-execution-timed-out-extension-host-becomes-unresponsive-frequently-windows/152752) was to remove it. Rename it rather than delete it, because it can hold local chat history you may want to restore:

```bash
# Quit Cursor completely first (all windows). Cursor 3.x paths.
# macOS
mv ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb{,.bak}
# Linux
mv ~/.config/Cursor/User/globalStorage/state.vscdb{,.bak}
```

```powershell
# Windows
Rename-Item "$env:APPDATA\Cursor\User\globalStorage\state.vscdb" state.vscdb.bak
```

If only one project is affected, the per-workspace equivalent is the matching folder under `User/workspaceStorage/`. Every folder there has a `workspace.json` that names the project it belongs to. Move that one folder aside instead of the global file.

### A third-party extension blocking activation

The extension host is shared. A marketplace extension that does slow synchronous work in `activate()` (a language server that downloads on first run, a linter scanning the repo) delays every extension scheduled after it, including Cursor's own. The timing script usually names it: the top entry will not start with `anysphere.`.

To confirm, start with third-party extensions off:

```bash
# Cursor 3.x: disables installed extensions; built-in anysphere.* extensions still load
cursor --disable-extensions
```

If that fixes it, run **Help: Start Extension Bisect** from the command palette. It disables half of your extensions at a time and asks "Good now" or "This is bad", so 30 extensions take about six rounds. It is quicker than guessing, and the result tells you which extension to report.

### The multi-window race on 3.1.x and 3.2.x

One variant is a Cursor bug rather than your environment. On 3.1.17 and 3.2.11, staff traced a per-window initialisation race: a new window's UI started calling the backend, git and search before that window's providers and its Connect transport were registered. It showed up as `Extension host not ready after 10 attempts`, `[auth] Timeout waiting for auth ready signal` and `[PluginsProviderService] Timed out waiting for plugins provider after 30000ms`, and it almost always hit the second or later window of a session. Closing only the stuck window and reopening the folder worked. **File > New Window** from an existing instance did not. If your log matches those lines, update Cursor before trying anything else in this post.

## Step 4: the host is healthy but the Agent still times out

If eager activation finished in a few seconds and the Agent still reports `deadline_exceeded`, the extension host is not the problem. The request is not getting out. This is the corporate proxy case: Zscaler-style SSL inspection, or a proxy that buffers HTTP/2 streams. Run **Cursor Settings > Network > Run Diagnostics**. Unlike the EverythingProvider case, you will now see specific hosts failing. Then:

```jsonc
// Cursor 3.x settings.json -- or Cursor Settings > Network > HTTP Compatibility Mode: HTTP/1.1
{
  "cursor.general.disableHttp2": true
}
```

Restart Cursor fully after changing it, because a window reload keeps the old transport. Cursor also falls back to HTTP/1.1 Server-Sent Events automatically when HTTP/2 streaming breaks, per its [network configuration docs](https://cursor.com/docs/enterprise/network-configuration), but forcing it removes one variable. The proxy must also allow `*.cursor.sh`, `*.cursor-cdn.com`, `*.cursorapi.com` and `*.cursorvm.com`, and ideally exclude them from SSL inspection. The same allowlist thinking applies if you are [locking down a coding agent's network egress](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/) on purpose.

## What does not help

- **Reload Window.** It restarts the renderer and host but keeps the environment that broke them. A full quit is the minimum.
- **Switching models.** The timeout happens before any model is called.
- **Reinstalling first.** It sometimes works because it happens to reset `state.vscdb` or extension folders, but you learn nothing, and endpoint security or a VPN will break the new install the same way.
- **Chasing HTTP/2 when the Extension Host panel is empty.** If the host never started, the network settings don't matter yet.

## If you are on the Cursor CLI

The CLI (`cursor-agent`) has its own startup path, but it had a similar stall. The [August 11, 2026 CLI release](https://cursor.com/docs/cli/changelog) made a slow plugin list fall back to a plugin-less session instead of stalling startup, and moved syntax-highlighting grammars off the boot path. If the CLI hangs at launch on an older build, update it before debugging your environment.

## Read next

- [Fix: Cursor's Apply Button Does Nothing on a Large Diff](/2026/05/fix-cursor-apply-button-does-nothing-on-large-diff/) covers the other Cursor failure that looks like the model's fault but is not.
- [Fix: .mcp.json servers never start because the workspace is marked untrusted](/2026/07/fix-mcp-json-servers-never-start-because-the-workspace-is-untrusted/) is another startup gate that fails without an error.
- [How to Keep Cursor Agent Tool Execution Inside Your Own Network](/2026/09/how-to-keep-cursor-agent-tool-execution-inside-your-own-network/) is the option for teams whose security tooling can't coexist with a local extension host.
- [Cursor 3.9 Bundles Your Agent Setup Into Portable Plugins](/2026/06/cursor-3-9-plugins-bundle-skills-rules-mcps-hooks/) explains what plugins add to startup, which matters when you bisect.

## Sources

- Cursor Docs: [Agent troubleshooting](https://cursor.com/help/troubleshooting/agent-issues), [Endpoint Security Configuration](https://cursor.com/docs/enterprise/endpoint-security), [Network, proxy, and remote connections](https://cursor.com/help/troubleshooting/network), [Network Configuration](https://cursor.com/docs/enterprise/network-configuration), [CLI changelog](https://cursor.com/docs/cli/changelog).
- Cursor forum: [Extension Host fails to initialize (multi-window race)](https://forum.cursor.com/t/extension-host-fails-to-initialize-timeout-waiting-for-auth-and-plugins-breaking-ai-agents-and-source-control/158539), [Timeout waiting for EverythingProvider](https://forum.cursor.com/t/timeout-waiting-for-everythingprovider/156748), [Timeout waiting for EverythingProvider Error](https://forum.cursor.com/t/timeout-waiting-for-everythingprovider-error/158146), [ERROR_EXTENSION_HOST_TIMEOUT behind a proxy](https://forum.cursor.com/t/agent-execution-timed-out-error-extension-host-timeout/162908), [Extension host unresponsive on Windows](https://forum.cursor.com/t/agent-execution-timed-out-extension-host-becomes-unresponsive-frequently-windows/152752).
- VS Code: [Command line interface](https://code.visualstudio.com/docs/configure/command-line), [Extension Bisect](https://code.visualstudio.com/blogs/2021/02/16/extension-bisect).
