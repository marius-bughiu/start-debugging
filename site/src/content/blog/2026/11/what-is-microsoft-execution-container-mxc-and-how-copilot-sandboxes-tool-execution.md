---
title: "What Is Microsoft eXecution Container (MXC) and How Copilot Sandboxes Tool Execution"
description: "MXC is Microsoft's MIT-licensed SDK for running untrusted code, including model output, plugins and tools, under one deny-by-default policy that it maps to Seatbelt on macOS, bubblewrap on Linux and ProcessContainer on Windows. Here is what MXC SDK 1.0.1 and schema 1.0.0 actually define, how Copilot CLI hands it a policy per process, and what stays outside the box."
pubDate: 2026-11-05
tags:
  - "github-copilot"
  - "ai-agents"
  - "sandboxing"
  - "security"
  - "mxc"
---

[Microsoft eXecution Container (MXC)](https://github.com/microsoft/mxc) is an open-source, MIT-licensed SDK for running untrusted code: model output, plugins, and tools. You describe one containment policy (which paths can be read or written, which network peers can be reached, which UI surfaces exist), and MXC enforces it with whatever the host OS offers natively: Seatbelt on macOS, bubblewrap on Linux, and ProcessContainer (the BaseContainer implementation) on Windows 11. GitHub Copilot's local sandbox, generally available since [October 7, 2026](https://github.blog/changelog/2026-10-07-local-sandboxing-for-github-copilot-now-generally-available), is the best-known consumer. Copilot CLI declares a policy for each child process it starts, and MXC applies it. This post covers MXC SDK 1.0.1 (released October 17, 2026) and the stable config schema `1.0.0`.

The short version: MXC is the policy engine and launcher, not a VM and not a container runtime in the Docker sense. It wraps an ordinary process in OS-level containment, and it only covers the processes it launches.

## Why an agent needs a process sandbox at all

Coding agents gate dangerous work with approval prompts. The prompt shows you a command string, and you decide whether to run it. That check runs on the string. It does not see what the process does after it starts. `npm test` looks harmless until a postinstall script reads `~/.ssh` and posts it somewhere. A prompt-injected README can ask for a command that looks routine but does damage through an argument. An approval prompt catches neither of these.

A process sandbox moves the check from "did a human approve this text" to "what is this process allowed to touch". The kernel answers that question at the syscall. A denied read fails with `Access is denied` or `Operation not permitted`, whatever the command line said. That is the gap MXC fills. Each OS already has a mechanism for it, and each has its own syntax. Seatbelt profiles are TinyScheme. bubblewrap is a stack of bind-mount flags. Windows process isolation goes through AppContainer or the newer BaseContainer APIs. MXC gives a caller one schema and maps it to all three.

## What ships in MXC

The [v1.0.0 release](https://github.com/microsoft/mxc/releases) on October 7, 2026 was the first stable SDK surface. v1.0.1 followed on October 17 as a patch, and the stable schema version stayed at `1.0.0`. Three SDKs ship from the same repo:

- Rust: crate `mxc-sdk`, entry point `mxc_sdk::v1`
- .NET: NuGet `Microsoft.Mxc.Sdk`, namespace `Microsoft.Mxc.Sdk.V1`
- Node: npm `@microsoft/mxc-sdk`, subpath `@microsoft/mxc-sdk/v1`

Under the SDKs sit native pieces. `mxc_ffi` is a C-callable library that takes a NUL-terminated UTF-8 JSON request. `wxc-exec` is a command-line executor that takes the same JSON, which is useful for testing or for apps that cannot embed an SDK. The npm tarball for 1.0.1 shows how the parts fit together: `bin/arm64/` contains `libmxc_ffi.dylib`, `libmxc_ffi.so`, `mxc_ffi.dll`, `mxc-exec-mac`, `wxc-exec.exe`, `lxc-exec` and the WSL and Windows Sandbox daemons. One package covers every platform.

## The backends

The `containment` field takes either an abstract intent or a concrete backend. The intent `"process"` resolves to the host's native process sandbox. The README lists these per platform:

| Platform | Default backend | Other backends |
| --- | --- | --- |
| Windows 11 x64/ARM64 | `processcontainer` | `wslc`, `isolation_session`, `windows_sandbox`*, `microvm`*, `hyperlight`* |
| Linux x64/ARM64 | `bubblewrap` | `lxc`, `hyperlight` |
| macOS ARM64/x64 | `seatbelt` | none |

\* Experimental. MicroVM is Windows x64 only.

So "container" in the name covers a range. The process-level backends (`seatbelt`, `bubblewrap`, `processcontainer`) wrap a normal process on your machine. `wslc` and `lxc` run the workload in a real Linux container. `windows_sandbox`, `microvm` and `hyperlight` move it into a VM. Copilot's local sandbox uses only the process-level tier. GitHub's docs say it "does not run your commands inside a separate virtual machine or container".

The Node 1.0.1 type definitions also show a tier ladder inside the Windows backend: `IsolationTier = 'base-container' | 'appcontainer-bfs' | 'appcontainer-dacl'`. `processcontainer` is an abstraction. At run time it picks the legacy AppContainer implementation or the newer BaseContainer implementation, depending on the host build. Copilot requires BaseContainer, which is why its Windows requirement is so specific: Windows 11 25H2 with KB5124010 or later, or 26H1 with KB5124006 or later.

## The policy model

A raw config for `wxc-exec` looks like this. The field names come from the repo's [schema documentation](https://github.com/microsoft/mxc/blob/main/docs/schema.md). The schema file is `schemas/stable/mxc-config.schema.1.0.0.json`.

```json
{
  "$schema": "./schemas/stable/mxc-config.schema.1.0.0.json",
  "version": "1.0.0",
  "containment": "process",
  "process": {
    "commandLine": "node build.js",
    "cwd": "/Users/dev/repo",
    "env": ["CI=1"],
    "inheritDefaultEnv": true,
    "timeout": 60000
  },
  "filesystem": {
    "readwritePaths": ["/Users/dev/repo"],
    "readonlyPaths": ["/Users/dev/.nvm"],
    "deniedPaths": ["/Users/dev/repo/.env"]
  },
  "network": {
    "egress": {
      "default": "deny",
      "allow": [
        { "to": [{ "cidr": "203.0.113.0/24" }], "ports": [{ "protocol": "tcp", "port": 443 }] }
      ]
    },
    "ingress": { "default": "deny", "hostLoopback": "deny" }
  },
  "ui": { "disable": true, "clipboard": "none", "injection": false }
}
```

The policy has four parts.

**Filesystem.** Three string arrays: `readwritePaths`, `readonlyPaths`, `deniedPaths`. Anything not listed stays restricted. That is the deny-by-default property, and the [access-denied logging doc](https://github.com/microsoft/mxc/blob/main/docs/logging-access-denied.md) states it in those words. On Windows there are precedence rules to know. A path that appears in both a readwrite list and a denied list is denied. A readwrite child of a denied parent is still reachable. A grant on a volume root like `C:\` does not cascade to child folders.

**Network.** This is directional, with `egress` and `ingress`, and both default to `deny`. The rules match **numeric CIDR plus protocol and port**. There is no hostname field. The schema doc lists `allowedHosts`, `blockedHosts`, `allowLocalNetwork` and the older `network.proxy` as retired fields, and every supported contract rejects them. If you need hostname filtering, you use proxy mode: set `runtimeConfig.networkProxy` to an HTTP/S proxy you run, and "the proxy owns any destination filtering". Direct egress rules and a runtime proxy cannot be combined. On Windows you can pin the proxy to a specific package identity with `processContainer.network.allowedProxyPeer`. Without it you need `hostLoopback: "allow"`, which the docs call "a weaker development/testing deployment".

**Process.** `commandLine` is the only required field. `env` is a `KEY=value` array. `inheritDefaultEnv` (added in schema 0.9) decides whether that array is layered over the backend's default environment or replaces it. On Windows ProcessContainer, `SYSTEMROOT` and `LOCALAPPDATA` must survive, or many binaries fail to start.

**UI.** `disable` (default `true`), `clipboard` (`none`, `read`, `write`, `all`; default `none`) and `injection` (default `false`). ProcessContainer and Seatbelt enforce these. IsolationSession and WSLc refuse any `ui` block you supply.

Backend-specific blocks hang off the same root: `seatbelt` (with `keychainAccess`, `guiAccess`, `extraMachLookups` and a raw `profileOverride` escape hatch), `processContainer`, `lxc`, `wslc`, `hyperlight`.

One field is missing: credentials. The schema has no secret or token concept. Credential handling is the caller's job, and that matters for the Copilot section below.

## How Copilot CLI uses it

GitHub's [concepts page](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/about-cloud-and-local-sandboxes) puts it in one sentence: Copilot CLI "declares the sandbox policy it wants to enforce" and MXC "applies that policy using the appropriate isolation backend for your operating system". In practice, before each sandboxed child process starts, Copilot works out the effective policy from the working directory, environment, settings, and any automatic grants. It then launches that process through MXC.

The boundary is **per child process**, and it matters which processes are children:

- **Sandboxed by the OS:** shell commands, file search (the grep and glob tools run ripgrep as a child process), and, by default, local MCP servers and LSP servers.
- **Checked only in software:** the built-in read and edit tools. They run inside the Copilot CLI process, and they check the policy "on a best-effort basis". GitHub's [local sandboxing page](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/understanding-local-sandboxing) calls this "a software-only safeguard rather than one the operating system enforces".
- **Not sandboxed:** remote MCP servers. They are not local processes, so there is nothing to wrap. When "Sandbox MCP servers" is on, network policy can still restrict the connections to them.

The default Copilot policy maps cleanly onto MXC's three filesystem lists. The working directory is read/write. In a Git repo, `.git` is read/write and the rest of the repo is read-only. PATH directories and some tool caches are granted, so compilers and package managers can run. Your home directory as a whole is not granted.

Network and credentials are where Copilot adds a layer that MXC's schema does not have. Copilot exposes host rules ("allow outbound", "allow local network", per-host rules) and credential toggles ("Authenticate git", "Authenticate gh"). Sandboxed tools get placeholder credentials, and a local proxy swaps in the real ones only for approved HTTPS hosts. For `gh`, those hosts are `github.com`, `api.github.com` and `uploads.github.com`. Custom secrets work the same way through `sandbox.credentials.envVars`:

```jsonc
// ~/.copilot/settings.json, Copilot CLI with local sandboxing (GA 2026-10-07)
{
  "sandbox": {
    "enabled": true,
    "credentials": {
      "envVars": {
        "EXAMPLE_API_TOKEN": { "injectHosts": ["api.example.com"] }
      }
    }
  }
}
```

This design matches MXC's split. MXC enforces CIDR rules and can force traffic through a caller-owned proxy. The caller, here Copilot, runs that proxy and puts hostname rules and secret injection in it. A sandboxed `curl` never holds the real token, so a compromised build script cannot print it. GitHub's docs give one Windows caveat that follows from this: proxying and host rules only work for programs that honor proxy settings, and they need "Allow local network" on.

The day-to-day controls live in Copilot, not MXC: `/sandbox status`, `/sandbox policy [COMMAND]` to see the effective policy for a command, `/sandbox enable|disable`, and the `--sandbox` / `--no-sandbox` flags for a single session. The [how-to on enabling it](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/) covers those settings key by key.

## Calling MXC yourself

MXC is not tied to Copilot. The README describes it as "an SDK dependency that builds into your app", so if you build your own agent harness, you can use it to wrap tool execution. With the Node SDK, the v1 surface exposes `run` (captured output), `spawn` (streaming pipes) and `spawnWithPty`. The example below is written against the `ContainerRequest` and `ExecutionResult` types in the published `@microsoft/mxc-sdk@1.0.1` package. It has not been executed for this post, so treat it as a typed sketch and check it against the package's own samples before you rely on it.

```ts
// @microsoft/mxc-sdk 1.0.1, schema 1.0.0, Node.js 24+
import { run, getAvailableBackends, type ContainerRequest } from '@microsoft/mxc-sdk/v1';

// Which backends and tiers does this host actually have?
console.log(getAvailableBackends());
// e.g. [{ backend: 'seatbelt', capabilities: [...], warnings: [] }]

const repo = process.cwd();

const request: ContainerRequest = {
  command: 'npm test',
  workingDirectory: repo,
  filesystem: {
    readwritePaths: [repo],
    deniedPaths: [`${repo}/.env`],
  },
  network: { egress: { default: 'deny' } }, // no outbound at all
  environment: { CI: '1' },
  inheritDefaultEnvironment: true,
  timeoutMs: 120_000,
};

const result = await run(request);
// ExecutionResult: { stdout, stderr, exitCode, timedOut, warnings, outputMetadata? }
if (result.timedOut) throw new Error('tool call timed out');
console.log({ exitCode: result.exitCode, output: result.stdout, errors: result.stderr });
```

There is one difference from the raw JSON. The SDK request uses its own field names (`command`, `workingDirectory`, `environment` as an object, `timeoutMs`), and a v1 adapter maps them to the wire schema (`process.commandLine`, `process.cwd`, `process.env` as an array, `process.timeout`). You do not pass a `version`. The v1 entry point always targets the newest 1.x contract it owns. With `wxc-exec`, you write the JSON yourself, and `version` has to match exactly.

To debug a policy, the Windows executor has `wxc-exec.exe --debug config.json` for diagnostics. `wxc-exec.exe --audit policy.json` records what a workload would touch. The README warns that `--audit` "turns off all sandbox security for the workload being analyzed", so never use it with untrusted code. For the same job under enforcement, the schema has `processContainer.captureDenials` with `mode: "block"`. It writes a JSON file of every denied file, network, UI and capability access while the policy stays enforced.

## Gotchas that are not obvious from the README

- **The version string is exact.** `"1.0.0"` is valid. `"1.0.1"`, `"1.0"` and an omitted field are rejected. The SDK version (1.0.1) and the schema version (1.0.0) are separate numbers. There is no range matching and no "latest" fallback.
- **Hostname rules in raw config fail validation.** If you copy an older example with `allowedHosts`, it is rejected outright, not ignored. Use CIDR rules or a proxy.
- **The sandbox covers child processes only.** Any work your agent does in-process (reading files with `fs`, making HTTP calls from the harness itself) is outside MXC. Copilot's built-in edit tools have exactly this limit. If your harness has its own file tools, they need their own path checks.
- **IsolationSession cannot restrict networking.** Egress, ingress and `hostLoopback` must all be `allow` on that backend. If you need network policy on Windows, stay on `processcontainer`.
- **Windows support depends on the OS build.** Process isolation needs at least the August 2026 cumulative update (KB5120998) on 24H2/25H2, and loopback ingress and enumerate-only paths need KB5124010. A host that lacks the needed OS support fails before the container is created (the docs show `backend_unavailable` for capture features). Check `getAvailableBackends()` at startup, not after the first tool call.
- **macOS needs 15 or later** for the Seatbelt backend. Copilot gives the same floor.
- **Filesystem checks are not atomic.** The schema doc says path validation does not "eliminate races between validation and mounting". A process sandbox shrinks the blast radius. It is not a hard trust boundary on the level of a VM. If the workload is actively hostile, use one of the VM backends or [a disposable VM or remote container](/2026/09/run-coding-agents-in-disposable-vms-and-containers/).
- **Telemetry differs between builds.** Official Microsoft builds send required diagnostic data on the `1.1.0-alpha` dev contract. Earlier published contracts keep telemetry optional and off by default. Local open-source builds send nothing, and telemetry is a no-op on non-Windows hosts.

## Where MXC sits next to the other sandboxes

MXC is one answer to a question every agent vendor has had to answer this year. Claude Code solves the same problem with [its own Bash sandbox and credential masking](/2026/06/claude-code-sandbox-credentials-block-secrets-from-bash/). Cursor moved agents [off the laptop into hosted sandbox providers](/2026/09/cursor-sandbox-providers-aws-lambda-vs-modal-vs-cloudflare-vs-vercel/). And whichever process sandbox you pick, a [strict egress allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/) is still the control that stops data from leaving. MXC stands out because it is a standalone, cross-platform SDK with a versioned schema, published under MIT, that any harness can embed. Copilot is its first big consumer, but nothing in it is Copilot-specific.

If you are deciding how much isolation an agent needs, start with [Copilot's local sandbox vs a cloud sandbox vs a dev container](/2026/10/copilot-local-sandbox-vs-cloud-sandbox-vs-dev-container/). If a command already breaks under the sandbox, [the permission-denied and network-denied fixes](/2026/10/fix-copilot-agent-command-fails-with-permission-or-network-denied-after-enabling-local-sandboxing/) walk through the common causes.

## Sources

- [microsoft/mxc repository and README](https://github.com/microsoft/mxc)
- [MXC releases (v1.0.0, v1.0.1)](https://github.com/microsoft/mxc/releases)
- [MXC schema documentation](https://github.com/microsoft/mxc/blob/main/docs/schema.md)
- [MXC access-denied logging and learning mode](https://github.com/microsoft/mxc/blob/main/docs/logging-access-denied.md)
- [MXC ProcessContainer OS version support](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/os-version-support.md)
- [MXC API reference](https://github.com/microsoft/mxc/blob/main/docs/api-reference/README.md)
- [@microsoft/mxc-sdk on npm](https://www.npmjs.com/package/@microsoft/mxc-sdk)
- [GitHub changelog: Local sandboxing for GitHub Copilot now generally available](https://github.blog/changelog/2026-10-07-local-sandboxing-for-github-copilot-now-generally-available)
- [GitHub Docs: About cloud and local sandboxes](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/about-cloud-and-local-sandboxes)
- [GitHub Docs: Understanding local sandboxing](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/understanding-local-sandboxing)
- [GitHub Docs: Using local sandboxing](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/using-local-sandboxing)
- [GitHub Docs: Configuring local sandbox settings](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/configuring-local-sandbox-settings)
