---
title: "Copilot Local Sandbox vs Cloud Sandbox vs a Dev Container: How Much Isolation Each Gives an Agent"
description: "Turn on the local sandbox for everyday Copilot CLI work, move to a cloud sandbox when the code or the task should never touch your laptop, and use a dev container when the team needs the same reproducible toolchain. Compared on Copilot CLI 1.0.104: what each boundary isolates, what it leaks, what it costs, and how to stack them."
pubDate: 2026-10-27
template: vs
tags:
  - "comparison"
  - "github-copilot"
  - "ai-agents"
  - "copilot-cli"
  - "sandboxing"
  - "security"
  - "dev-containers"
---

**Short answer:** the local sandbox is the default you should turn on today, because it costs nothing, keeps your toolchain, and fences every shell command, `grep`, local MCP server and LSP server Copilot spawns. It is the weakest of the three boundaries, though: the agent process itself still runs as you, and since Copilot CLI 1.0.100 sandboxed commands can reach localhost and your private network by default. A cloud sandbox (`copilot --cloud --experimental`) is the strongest: the whole session runs in an ephemeral GitHub-hosted Linux environment with nothing of your laptop in it, billed per second. A dev container sits in the middle. It isolates the whole agent process, not just its commands, but shares your kernel, sees whatever you mount, and has open egress unless you add a firewall. Everything below is checked against Copilot CLI 1.0.104 (October 27, 2026), the `copilot-cli` dev container feature 1.1.3, and GitHub's docs as of today. Cloud sandboxes are still in public preview.

## Three boundaries drawn in three different places

The names make these sound like three sizes of the same thing. They are not. Each one draws the line around a different part of the agent:

- **Local sandbox** draws it around **each child process**. The Copilot CLI process runs on your machine with your user account. When it spawns a shell command, an MCP server or a language server, that child runs under an OS sandbox ([Microsoft eXecution Container](https://github.com/microsoft/mxc): Seatbelt on macOS, bubblewrap on Linux, ProcessContainer on Windows 11). The built-in read and edit tools run inside the Copilot process and are only checked in software.
- **Dev container** draws it around **the whole agent and its toolchain**. Copilot CLI, Node, your SDKs and every command run inside a Linux container. The container shares your host kernel and sees exactly what you mount into it, which is always at least the workspace.
- **Cloud sandbox** draws it around **the entire session, on someone else's machine**. GitHub runs the session in "a fully isolated, ephemeral Linux environment" built on [Azure Container Apps Sandboxes](https://docs.github.com/en/copilot/concepts/about-cloud-and-local-sandboxes). Your laptop is a terminal into it.

That is why "how much isolation" has no single ranking. The local sandbox can be stricter than a sloppy dev container on network egress, and a dev container can be stricter than the local sandbox on what the agent process itself can read.

## Feature matrix

| | Local sandbox (CLI 1.0.104, GA) | Dev container (`copilot-cli` feature 1.1.3) | Cloud sandbox (CLI 1.0.104, preview) |
| --- | --- | --- | --- |
| What is isolated | Child processes only (shell, `grep`/`glob`, local MCP and LSP servers) | Agent process and all children | Entire session |
| Agent process runs as | You, on your host | Container user | GitHub-hosted environment |
| Kernel | Yours | Yours (Docker Desktop VM on macOS/Windows) | Not yours |
| Your home dir, `~/.ssh`, `~/.aws` | Read-only by default, writes blocked | Invisible unless mounted | Not present |
| Workspace | Read/write | Read/write (bind mount) | Not mounted from your machine |
| Network default | Internet and local network allowed (local since 1.0.100), host allow/deny rules available | Fully open unless you add a firewall | Inherits Copilot cloud agent policies |
| git / `gh` credentials | Fake tokens, proxy injects real ones per approved host | Whatever you pass in (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`) | Your existing Copilot authentication |
| Headless `-p` runs | Yes (`copilot --sandbox -p ...`) | Yes | No, interactive only |
| Survives closing the laptop | No | No | Yes, stop/resume with snapshot |
| Cost | Included in the seat | Your Docker host | Per second: $0.000024 compute, $0.000003 per GiB memory, $0.005 per GiB-month snapshot |
| Admin control | `sandbox` key in managed settings, `failIfUnavailable` | None from GitHub | "Cloud Sandbox access" org/enterprise policy, off by default |

## Local sandbox: the fence you should always have

Turning it on is one command, and you can make it sticky:

```bash
# Copilot CLI 1.0.104
copilot --sandbox                 # this session only
copilot --sandbox -p "run the tests and fix the first failure"   # headless, still sandboxed

# inside a session: enable and persist to ~/.copilot/settings.json
/sandbox enable
/sandbox policy npm install       # print exactly what that command would get
```

The default policy is deny-by-default on the filesystem: the working directory, `.git` and temp are writable, the rest of the repo and your tools on `PATH` are read-only, and package-manager caches are writable when developer-tool access is on. Git and `gh` inside the sandbox receive placeholder tokens, and a local proxy swaps in the real ones only for approved HTTPS hosts. That last part is the strongest feature of the local sandbox, and neither alternative gives it to you for free: a malicious `postinstall` script can run, but it cannot read a real GitHub token out of the environment. The full setup is in [how to turn on Copilot local sandboxing and restrict what an agent can touch](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/).

Know its three holes before you rely on it:

1. **The agent process is not sandboxed.** The CLI's built-in file tools enforce the policy in software, best effort, with no OS backstop. If you are worried about a compromised Copilot process rather than a compromised `npm` dependency, this boundary does not cover you.
2. **Local network is open by default.** Copilot CLI 1.0.100 (October 19, 2026) changed the default so "commands can reach localhost and private-network services." That fixed a lot of broken test suites, but it also means a sandboxed command can talk to your local Postgres, your Docker socket over TCP if you exposed one, and your home router. Turn local access off in `/sandbox` (Network tab) if your tests do not need it.
3. **Remote MCP servers are never sandboxed.** The sandbox constrains processes on your machine, not HTTP MCP servers somewhere else.

Pick the local sandbox when:

- You are working interactively in a repo you trust, and the threat is a dependency or a generated script doing something you did not approve.
- You need headless runs (`-p`), for example a [Copilot CLI dynamic workflow running from CI](/2026/10/how-to-define-a-github-copilot-cli-dynamic-workflow-and-run-it-from-ci/), and want the commands fenced on the runner.
- Your org wants a policy it can enforce centrally. The `sandbox.enabled` plus `sandbox.failIfUnavailable` managed settings make Copilot refuse to run tools rather than run them unsandboxed.

## Dev container: isolate the agent, not just its commands

The official feature landed in `devcontainers/features`, so the minimum is one line:

```jsonc
// .devcontainer/devcontainer.json
// devcontainers/features copilot-cli 1.1.3 (installs Copilot CLI 1.0.104 at time of writing)
{
  "name": "agent-sandbox",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/copilot-cli:1": { "version": "latest" }
  },
  "remoteUser": "vscode",
  // Pass a fine-grained token instead of mounting ~/.config/gh
  "remoteEnv": {
    "COPILOT_GITHUB_TOKEN": "${localEnv:COPILOT_GITHUB_TOKEN}"
  },
  "runArgs": ["--cap-drop=ALL", "--security-opt=no-new-privileges"]
}
```

`COPILOT_GITHUB_TOKEN` takes precedence over `GH_TOKEN` for Copilot authentication, which lets you hand the container a token scoped to Copilot and nothing else. The feature also adds a `postStartCommand` that runs `copilot update` if auto-update is enabled, so a rebuilt container drifts to the newest CLI unless you pin `version`.

What a dev container buys you is that the agent process, the CLI's built-in file tools, its MCP servers and every command live in a filesystem namespace that only contains what you put there. `~/.ssh`, `~/.aws`, your other repos and your browser profile simply do not exist unless you mount them. On macOS and Windows, Docker Desktop adds a Linux VM between the container and your real OS, which is a meaningfully harder wall than Seatbelt alone.

What it does not buy you:

- **Egress control.** A default container can reach the whole internet and, through the Docker host, often your LAN. You have to add a default-deny firewall yourself, the way Anthropic's reference container does with an `init-firewall.sh` that allowlists a few hosts. The pattern is in [how to lock down a coding agent's network egress with a strict host allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/).
- **Credential masking.** Whatever token you pass in is a real token the agent can read. There is no proxy swapping placeholders for real values unless you build one, as described in [keeping API keys out of a coding agent's context with a credential gateway](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/).
- **Workspace protection.** The bind-mounted workspace is writable, including `.git/hooks`. A hook planted by the agent runs on your host the next time you commit outside the container.

Pick a dev container when:

- The team needs one reproducible toolchain anyway, and agent isolation comes along for free.
- You want the whole agent, not just its commands, off your user account, but still need headless runs and fast local iteration.
- You run Claude Code, Codex and Copilot side by side and want one boundary for all of them. The broader comparison is in [running a coding agent in a disposable VM or container](/2026/09/run-coding-agents-in-disposable-vms-and-containers/).

## Cloud sandbox: nothing of yours is in the room

```bash
# Copilot CLI 1.0.104, cloud sandboxes in public preview
copilot --cloud --experimental

# Since 1.0.92 you can also press Ctrl+E before the first prompt
# to switch a new session between local and cloud.
```

Each `--cloud` applies to that one session; it does not change the default. In the Copilot app you pick the cloud option when you create a session. Behind it, each session gets its own ephemeral Linux environment, isolated from your machine and from your other sessions. Stopping a session snapshots files, environment variables and in-progress work, and you can resume it from any device. Deleting it removes the environment and the snapshot.

This is the only one of the three where a fully compromised agent process still cannot reach your laptop, your LAN, your SSH keys or your other repositories, because none of them are there. GitHub says cloud sandbox policies "share the same configuration as Copilot cloud agent policies," so the org-level controls you already set for the cloud agent apply. The [agent firewall page](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-firewall) only describes the GitHub Actions environment the cloud agent runs in, though, so check the behavior yourself: ask the session to `curl` a host outside your allowlist before you trust a cloud sandbox with untrusted code.

The constraints are real:

- **Interactive only.** You cannot combine `--cloud` with `-p` or `-i`. It is not a CI runner.
- **Off by default for organizations.** An owner has to enable the "Cloud Sandbox access" policy.
- **Metered.** Compute is $0.000024 per second ($0.0864 per running hour). Memory is $0.000003 per GiB-second of memory *allocated*, not used. GitHub does not publish the sandbox size, so as an illustration, an 8 GiB allocation would add another $0.0864 per hour, for roughly $0.17 per hour total. Stopped sessions cost $0.005 per GiB-month of snapshot. The bill goes to the repository owner, and the preview $10 monthly entitlement ran through July 2026. Cloud sandboxes are not part of the "Bundled AI credits" budget, so set a product or SKU budget ("Sandbox Linux") with "Stop usage when budget limit is reached" if you want a hard cap.

Pick a cloud sandbox when:

- The code is untrusted: a third-party PR, a repo you just cloned to evaluate, an issue-reported repro.
- The task should outlive your laptop lid, or you want several sessions running in parallel without melting your machine.
- You cannot get the local sandbox to run at all (an old Windows 11 build, a Linux host without `bwrap` 0.5.0 and `slirp4netns`) and need a boundary today.

## The gotcha that decides it for you

Two constraints pick for you before preference does.

**If it must run headless, the cloud sandbox is out.** No `-p`, no `-i`. Scheduled jobs and CI pipelines get the local sandbox on the runner, a dev container, or the separate Copilot cloud agent, which runs on GitHub Actions with its own firewall and opens a PR instead of giving you a terminal.

**If you nest the local sandbox inside a dev container, test it first.** It is tempting to stack the two: container for the agent, sandbox for its commands. On Linux the local sandbox is bubblewrap with its own user and network namespaces, and Docker's default seccomp profile and dropped capabilities usually refuse unprivileged namespace creation. When that happens Copilot fails with the bubblewrap "requires unprivileged user and network namespaces, which this host refused" error, and with `sandbox.enabled` set it does not fall back to running unsandboxed: every shell command fails. Loosening the container (`--privileged`, `seccomp=unconfined`) to make the inner sandbox work weakens the outer one. In practice, pick one boundary per layer: dev container plus a firewall, or the local sandbox on the host.

Stacking that does work well is local sandbox plus cloud agent: fence your interactive sessions locally, and send anything you would not run on your own machine to `/delegate` or a cloud sandbox.

## Which one to reach for

Turn on the local sandbox everywhere, today, and switch local network access off unless you need it. It is free, it is GA, and its credential proxy closes the most common real-world leak (a dependency reading `GITHUB_TOKEN`). Use a dev container when the team already wants a reproducible toolchain, and add a default-deny firewall, because the container alone gives you filesystem isolation and almost nothing on the network. Use a cloud sandbox for untrusted code and long-running work you want off your machine entirely, and put a budget on it, since memory is billed on allocation.

The ranking for "how much can a compromised agent reach" is cloud sandbox, then a firewalled dev container, then the local sandbox. The ranking for "how much friction do I add" is exactly the reverse, which is why most developers should start at the bottom and climb only when the code in front of them gets less trustworthy.

## Related

- [How to turn on Copilot local sandboxing and restrict which directories, hosts and credentials an agent can touch](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/)
- [How to run a coding agent in a disposable VM or container instead of on your laptop](/2026/09/run-coding-agents-in-disposable-vms-and-containers/)
- [How to lock down a coding agent's network egress with a strict host allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/)
- [How to keep API keys out of a coding agent's context with a credential gateway](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/)
- [Cursor cloud agents vs GitHub Copilot coding agent for background PRs](/2026/07/cursor-cloud-agents-vs-github-copilot-coding-agent-for-background-prs/)

## Sources

- [About cloud and local sandboxes for GitHub Copilot](https://docs.github.com/en/copilot/concepts/about-cloud-and-local-sandboxes) (GitHub Docs)
- [Billing for cloud and local sandboxes](https://docs.github.com/en/billing/concepts/product-billing/cloud-and-local-sandboxes) (GitHub Docs)
- [Cloud and local sandboxes for GitHub Copilot now in public preview](https://github.blog/changelog/2026-06-02-cloud-and-local-sandboxes-for-github-copilot-now-in-public-preview/) (GitHub changelog, June 2, 2026)
- [Customize the agent firewall for Copilot cloud agent](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-firewall) (GitHub Docs)
- [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md), entries for 1.0.92, 1.0.100 and 1.0.104
- [`copilot-cli` dev container feature](https://github.com/devcontainers/features/tree/main/src/copilot-cli) (`devcontainers/features`, version 1.1.3)
- [Microsoft eXecution Container (MXC)](https://github.com/microsoft/mxc)
