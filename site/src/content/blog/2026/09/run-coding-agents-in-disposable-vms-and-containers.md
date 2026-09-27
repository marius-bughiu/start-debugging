---
title: "How to Run a Coding Agent in a Disposable VM or Container Instead of on Your Laptop"
description: "Dev containers, Docker Sandboxes microVMs, Lima VMs, and hosted cloud sandboxes all move Claude Code, Codex, or Copilot CLI off your host. What each one actually isolates, the exact commands to make it throwaway, and the two things none of them protect: your writable workspace and your git hooks."
pubDate: 2026-09-27
template: how-to
tags:
  - "ai-agents"
  - "claude-code"
  - "security"
  - "sandboxing"
  - "docker"
  - "devops"
---

**Short answer:** put the whole agent process, not just its shell commands, behind a boundary you can delete. For a team repo, commit a dev container with a default-deny firewall and run `claude --dangerously-skip-permissions` inside it as a non-root user. For a single developer on macOS or Windows, `sbx run claude --branch <name>` from Docker Sandboxes (sbx 0.45.1) gives you a microVM with its own kernel and Docker daemon, and a proxy that injects credentials so the agent never holds them. For code you do not trust, use a real VM: Lima 2.2 with `--mount-none` and `limactl shell --sync` lets you review every changed file before it touches your checkout. In every case, never mount `~/.ssh`, `~/.aws`, or your home directory, and throw the environment away after each task.

Versions used in this post: Claude Code 2.1.283, Docker Sandboxes `sbx` 0.45.1 (released September 22, 2026), Lima 2.2.0, `@anthropic-ai/sandbox-runtime` 0.0.77, and the reference dev container from `anthropics/claude-code` as of this week. The commands are taken from each project's own docs; I did not benchmark startup times, so there are no latency numbers here.

## What an agent on your laptop can actually reach

A coding agent running directly on your host inherits your user account. That means it can read every file your user can read: `~/.ssh/id_ed25519`, `~/.aws/credentials`, `~/.config/gh/hosts.yml`, `.env` files in every other repo under `~/src`, and the Docker socket if you are in the `docker` group. It can also reach every service listening on `localhost`, including the database you left running for another project.

The built-in protections narrow this, but not all the way. Claude Code's [sandboxed Bash tool](/2026/06/claude-code-sandbox-credentials-block-secrets-from-bash/) restricts what shell commands can read and write, and the [network egress allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/) restricts where they can connect. Anthropic's own [sandbox environments page](https://code.claude.com/docs/en/sandbox-environments) is explicit about the gap: the per-command sandbox covers Bash, PowerShell, and Monitor commands, while "MCP servers and command hooks are separate processes that run unconstrained on the host." Built-in file tools are gated by permission rules, not by the OS boundary.

That is fine when you approve each action. It stops being fine the moment you want unattended runs. The same page says it plainly: always run `--dangerously-skip-permissions` sessions inside a container, a VM, or the sandbox runtime, so that file tools, MCP servers, and hooks are inside the boundary too. [Auto mode](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/) is a classifier, a per-action control, and not an isolation boundary either.

## The four boundaries, and what each one isolates

| Option | Boundary | Own kernel | Agent can run Docker | Credentials | Best for |
| --- | --- | --- | --- | --- | --- |
| Dev container | Linux container on your Docker host | No | Only via host socket or DinD | Whatever you mount or pass as env | Team-standard environment |
| Docker Sandboxes (`sbx`) | microVM | Yes | Yes, its own daemon | Host-side proxy injects them | Solo unattended runs |
| Lima VM | Full VM (vz or QEMU) | Yes | If you install it | Whatever you copy in | Untrusted repos, review-before-apply |
| Hosted (`claude --cloud`, Docker Cloud Sandboxes) | Provider-managed VM | Yes | Depends on provider | Proxy-held GitHub token (Claude), proxy injection (Docker) | Laptop stays out of it entirely |

There is a fifth option that is not a VM or container: `npx @anthropic-ai/sandbox-runtime claude` wraps the entire Claude Code process in the same Seatbelt (macOS) or bubblewrap (Linux) sandbox the Bash tool uses. It is the lightest way to get MCP servers and hooks inside a boundary, but it shares your kernel and your home directory layout, and Anthropic still labels it a beta research preview. Treat it as a stronger sandbox, not as a disposable machine.

## Option 1: a dev container your whole team can rebuild

The dev container path is the one Anthropic maintains a reference for. The minimum is a feature line:

```json
// .devcontainer/devcontainer.json
// Claude Code Dev Container Feature 1.0 (installs latest Claude Code, 2.1.283 at time of writing)
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "remoteUser": "vscode",
  "features": {
    "ghcr.io/anthropics/devcontainer-features/claude-code:1.0": {}
  },
  "mounts": [
    "source=claude-code-config-${devcontainerId},target=/home/vscode/.claude,type=volume"
  ],
  "containerEnv": {
    "CLAUDE_CONFIG_DIR": "/home/vscode/.claude"
  }
}
```

Two details in there are easy to get wrong. First, `remoteUser` must be a non-root account: the CLI refuses `--dangerously-skip-permissions` when it runs as root on Linux and macOS. Second, Claude Code keeps its OAuth account and per-project trust in `~/.claude.json`, which sits *outside* `~/.claude`. Mounting a volume at `~/.claude` alone does not keep you signed in across rebuilds; setting `CLAUDE_CONFIG_DIR` to the volume path makes Claude Code write `.claude.json` inside it. The `${devcontainerId}` suffix gives each repo its own volume, so one project's session history never leaks into another's.

The feature alone gives you process and filesystem isolation but no network control. For that, copy the [reference `.devcontainer/`](https://github.com/anthropics/claude-code/tree/main/.devcontainer) instead. Its `devcontainer.json` adds `--cap-add=NET_ADMIN` and `--cap-add=NET_RAW` to `runArgs` and runs `sudo /usr/local/bin/init-firewall.sh` as the `postStartCommand`. The script sets `iptables -P OUTPUT DROP`, then builds an `ipset` from GitHub's published `web`, `api`, and `git` ranges plus the resolved IPs of `registry.npmjs.org`, `api.anthropic.com`, `sentry.io`, `statsig.com`, and the VS Code marketplace hosts. It finishes by checking that `https://example.com` is unreachable and `https://api.github.com/zen` is reachable, and exits non-zero if either check fails.

To make it disposable rather than just isolated, drive it from the [Dev Containers CLI](https://github.com/devcontainers/cli) instead of your editor, and recreate the container for each task:

```bash
# @devcontainers/cli, Claude Code 2.1.283
npx @devcontainers/cli up --workspace-folder . --remove-existing-container

npx @devcontainers/cli exec --workspace-folder . \
  claude --dangerously-skip-permissions -p "Fix the failing tests in src/billing and explain the root cause"
```

`--remove-existing-container` throws away everything outside the workspace mount and the named volumes, so a tool the agent installed with `npm -g`, a modified `~/.bashrc`, or a stray daemon does not survive to the next task.

What it does not throw away is the workspace. The reference config bind-mounts `${localWorkspaceFolder}` to `/workspace`, so every file the agent writes lands in your real checkout immediately.

## Option 2: Docker Sandboxes, a microVM per task

[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) is Docker's standalone product for exactly this job, and Anthropic's docs now point to it as the VM-grade option. Each sandbox is a microVM with its own kernel and its own Docker Engine, which solves the problem dev containers handle badly: the agent can `docker build` and `docker compose up` without you handing it the host socket or running privileged Docker-in-Docker. It does not need Docker Desktop. Andrew Lock's April walkthrough ran it on macOS arm64 and Windows 11 x86_64; Docker's launch post listed Linux as a next step, so check the [release page](https://github.com/docker/sbx-releases/releases) for your platform.

```bash
# Docker Sandboxes sbx 0.45.1
sbx login

# Store credentials in the OS keychain; they never land inside the VM
sbx secret set github --command 'gh auth token'

# Run Claude Code in a microVM, working on a git worktree instead of your branch
sbx run --name billing-fix claude --branch billing-fix

# Widen the network policy only for what this task needs
sbx policy allow network "pypi.org,files.pythonhosted.org"
sbx policy ls

# Done: delete the VM and everything inside it
sbx rm billing-fix
```

Three design choices make this the best local option for unattended runs.

**Credentials go through a proxy, not into the VM.** Per Docker's [default security posture](https://docs.docker.com/ai/sandboxes/security/defaults/), no credentials are available inside unless you provide them with `sbx secret` or environment variables, and secrets set with `sbx secret` are injected into outbound HTTP requests by a host-side proxy. A prompt-injected agent that runs `env` or greps the filesystem finds nothing to exfiltrate. That is the same pattern as a [credential gateway](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/), built in.

**The network starts closed.** On first run you choose Open, Balanced (default deny with common dev sites allowed), or Locked Down. The documented default is that all outbound TCP, including HTTPS and SSH, is blocked unless a rule allows it, UDP is off, and ICMP is blocked. The host's `localhost` is not reachable from inside.

**Branch mode keeps your working branch clean.** `--branch` creates a git worktree under `.sbx/<sandbox-name>-worktrees/` in your project root and points the agent at it, so you review the result as a branch diff rather than discovering it in your working tree.

The costs are real. Lock reported noticeable slowdowns even on a small project, and SSH-agent-based commit signing (1Password in his case) does not reach into the VM. If your repo requires signed commits, sign on the host after review, which is what you should be doing anyway.

## Option 3: a Lima VM with review-before-apply sync

When the repository itself is the thing you do not trust (a take-home assignment, a dependency you are auditing, a PR from a stranger), the agent's writes should not reach your disk until you have looked at them. Lima 2.1 added exactly that, and it is the only option here with a built-in review step.

Lima's default template mounts your entire home directory, so never use it as-is for an agent. The [Lima AI agents guide](https://lima-vm.io/docs/examples/ai/) gives two safer shapes:

```bash
# Lima 2.2.0: mount only the project, writable
limactl start --mount-only .:w

# Or: mount nothing, and sync with review (requires Lima >= 2.1)
limactl start --name=agent --mount-none template:default
limactl shell agent sudo snap install node --classic
limactl shell agent sudo npm install -g @anthropic-ai/claude-code

limactl shell --sync . agent claude --dangerously-skip-permissions \
  -p "Add error handling to every exported function in src/"
```

With `--sync`, Lima rsyncs your working directory into the guest, runs the command, then shows `Accept the changes?` with Yes, No, and "View the changed contents" before anything is copied back. Requirements from the docs: rsync on both sides, an instance created with `--mount-none`, a host directory at least four levels deep, and not the `wsl2` VM type.

When the task is done, `limactl delete -f agent` removes the VM, its disk, and anything the agent installed. Keep a clean base instance around and clone it with `limactl clone` if provisioning Node on every run is too slow.

Lima does nothing about network egress on its own. Either run the Claude Code Bash sandbox with an allowlist inside the guest, or apply the same iptables approach as the reference dev container.

## Option 4: let someone else host the VM

If the point is to keep the agent off your laptop entirely, the hosted versions are now one flag away.

`claude --cloud` starts a Claude Code cloud session in an Anthropic-managed VM. A network proxy enforces a default allowlist, and a separate proxy holds your GitHub token outside the sandbox while issuing scoped credentials inside it. Launching from the CLI with `--cloud` bundles and uploads your local repo, so it works without a connected GitHub account. If your company wants that model on its own hardware, the [self-hosted runner](/2026/08/claude-code-self-hosted-runner-cloud-sessions-on-your-own-hosts/) runs the same sessions on machines you provision.

Docker shipped [Cloud Sandboxes](https://www.docker.com/blog/introducing-cloud-sandboxes-start-on-your-laptop-finish-in-the-cloud/) on September 24, 2026, with the same `sbx` CLI:

```bash
# sbx 0.45.1 or later, Docker Personal or Pro pay-as-you-go plan
sbx --cloud run claude

# Or start locally, then move the sandbox's filesystem to the cloud (and back)
sbx move billing-fix --to cloud
```

Pricing is per second, from $0.07 an hour for Micro (1 vCPU, 2 GiB) through $0.14 for the default Small (2 vCPU, 4 GiB) up to $1.12 for XL (16 vCPU, 32 GiB). Sessions default to one hour and cap at 24, and paused sandboxes cost nothing. Cursor users have an equivalent spread of hosted options, compared in [Cursor's sandbox providers](/2026/09/cursor-sandbox-providers-aws-lambda-vs-modal-vs-cloudflare-vs-vercel/).

## The two things no boundary protects

Every option above except Lima's `--sync` shares one hole: the workspace is writable and shows up on your host.

**Git hooks and git config.** Docker's own docs say the agent has full permissions in the mounted workspace, "including hidden files, configuration files, build scripts, and Git hooks." A dev container or microVM stops the agent from running code on your host *now*. It does not stop it from writing `.git/hooks/pre-commit`, a `core.fsmonitor` or `core.hooksPath` entry in `.git/config`, or a `postinstall` script in `package.json`, all of which execute on your host the next time you run `git commit` or `npm install` outside the sandbox. Anthropic's sandbox runtime denies writes to `.git/hooks` and `.git/config` by default for exactly this reason. For container and VM setups, check after every run:

```bash
# Run on the host after the agent finishes, before any git or npm command
git -C . config --local --list | grep -E 'hooksPath|fsmonitor|sshCommand|editor|pager'
ls -la .git/hooks | grep -v '\.sample$'
git diff --stat HEAD -- package.json '*.csproj' Makefile .github/ .vscode/ .devcontainer/
```

Better still, point the agent at a fresh clone or a worktree (sbx `--branch` does this for you) and fetch its commits into your real checkout as a branch. A fetch copies objects; it never copies hooks or config.

**What goes to the model.** Isolation changes what the agent can reach, not what it sends. Every file it reads is still transmitted to the model provider. A sandbox is not a data-residency control.

## Gotchas worth knowing before the first run

- **The firewall resolves names once.** The reference `init-firewall.sh` resolves each allowed domain to IPs at container start and adds those IPs to the ipset. If a CDN rotates addresses mid-session, requests start failing. Re-run the script, or use a proxy-based allowlist that matches on hostname.
- **`NET_ADMIN` is a capability you are granting.** The reference container needs it to set iptables rules. Since the firewall runs from `postStartCommand` with `sudo`, make sure the agent's user cannot `sudo` anything else, or it can flush the rules. The reference Dockerfile limits sudo to the firewall script for this reason.
- **Never mount host credentials "just for git push".** Use a fine-grained token scoped to one repository, pass it as an env var or `sbx secret`, or do not push from inside at all. For Claude Code auth, `claude setup-token` produces a `CLAUDE_CODE_OAUTH_TOKEN` you can pass instead of mounting `~/.claude`.
- **Nested sandboxing needs a setting.** Running the Claude Code Bash sandbox inside an unprivileged container is supported, but bubblewrap needs the nested-sandbox option described in [Sandboxing troubleshooting](https://code.claude.com/docs/en/sandboxing#troubleshooting).
- **The dev container is a convention, not a control.** Anthropic's docs note that committing one standardizes the environment, but nothing forces developers to use it. If policy requires isolation, enforce it with device management or set `permissions.disableBypassPermissionsMode` to `"disable"` in managed settings so the bypass flag only works where you intended.

## Which one to pick

For a team, start with the dev container: it is versioned with the repo, reviewable in a PR, and the firewall script is short enough to read in one sitting. For a single developer on macOS or Windows who wants the agent to build containers and run unattended, Docker Sandboxes is the better boundary, mostly because of the credential proxy. For anything you would not `npm install` on your own machine, use a Lima VM with `--sync`, read the diff, and delete the VM. And if you only need the agent to stop prompting while you sit next to it, you do not need any of this: auto mode plus the built-in Bash sandbox covers that case.

## Related

- [Lock down a coding agent's network egress with a strict host allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/)
- [Claude Code's sandbox.credentials setting keeps secrets away from Bash](/2026/06/claude-code-sandbox-credentials-block-secrets-from-bash/)
- [Keep API keys out of agent context with a credential gateway](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/)
- [Auto mode vs manual approval: what each permission mode lets through](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/)
- [Running Claude Code cloud sessions on your own hosts](/2026/08/claude-code-self-hosted-runner-cloud-sessions-on-your-own-hosts/)

## Sources

- [Claude Code: Choose a sandbox environment](https://code.claude.com/docs/en/sandbox-environments)
- [Claude Code: Development containers](https://code.claude.com/docs/en/devcontainer)
- [anthropics/claude-code reference `.devcontainer/`](https://github.com/anthropics/claude-code/tree/main/.devcontainer) and [`init-firewall.sh`](https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh)
- [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- [Docker Sandboxes documentation](https://docs.docker.com/ai/sandboxes/) and [default security posture](https://docs.docker.com/ai/sandboxes/security/defaults/)
- [Docker: Introducing Cloud Sandboxes](https://www.docker.com/blog/introducing-cloud-sandboxes-start-on-your-laptop-finish-in-the-cloud/)
- [Andrew Lock: Running AI agents safely in a microVM using docker sandbox](https://andrewlock.net/running-ai-agents-safely-in-a-microvm-using-docker-sandbox/)
- [Lima: AI agents](https://lima-vm.io/docs/examples/ai/)
- [Dev Containers CLI](https://github.com/devcontainers/cli)
