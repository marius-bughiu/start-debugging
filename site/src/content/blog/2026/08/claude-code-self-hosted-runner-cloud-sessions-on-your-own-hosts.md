---
title: "Claude Code Cloud Sessions Can Now Run on Your Own Hosts"
description: "Claude Code 2.1.224 adds claude self-hosted-runner, a public beta that executes cloud sessions on machines you provision. Here is the setup, the one-user runner rule, and what still leaves your network."
pubDate: 2026-08-11
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
---

Cloud sessions in Claude Code, the ones you start from claude.ai, the mobile and desktop apps, a scheduled routine, or the terminal with `claude --cloud`, have always executed on Anthropic's infrastructure. Claude Code 2.1.224, published on August 7, 2026, changes that. A new subcommand, `claude self-hosted-runner`, turns a Linux or macOS host into the machine that actually runs the session. It is a public beta on Team and Enterprise plans, and it stays invisible until an Owner or admin turns on "Allow self-hosted environments" on the Cloud environments admin page.

## Environment, runner, session

Three pieces make this work. An **environment** is a named destination created in claude.ai admin settings that appears in the environment picker next to Anthropic-hosted options. A **runner** is a long-lived process you deploy inside your network. A **session** is one task, claimed off the environment's queue by a runner, which clones the repository and spawns a child `claude` process to do the work.

The smallest working setup is three commands plus the environment secret, which claude.ai shows exactly once at creation and which expires after 365 days:

```bash
mkdir -p /etc/claude
(umask 077 && cat > /etc/claude/environment-secret)
mkdir -p /srv/claude-work

claude self-hosted-runner \
  --environment-secret-file '/etc/claude/environment-secret' \
  --base-dir '/srv/claude-work'
```

Skip `--base-dir` and the runner falls back to `/workspace`, which only works if that path already exists and is writable. Verify the host first with `claude self-hosted-runner --help`: on anything older than 2.1.224 the subcommand is unrecognized and you get the general `claude --help` output instead. There is also a guided path, `claude self-hosted-runner setup`, which walks the admin UI steps and writes a cheat sheet to `./runner-setup/CHEAT-SHEET.md`.

## Why one runner serves exactly one user

This is the design decision that shapes your fleet sizing. The first session a runner claims locks that runner to the account of the user who started it, and from then on it only takes work for that account, up to `--capacity` concurrent sessions. The default capacity is `1`. Your minimum fleet size is therefore the number of users you expect to be active at the same time, not the number of sessions.

Runners are also disposable by default. `--drain-grace-sec` defaults to `0`, so a runner exits as soon as its active sessions finish rather than polling for more, which lets Kubernetes restart it with a fresh disk ready for any account. That is how per-user checkout isolation is achieved without deleting state between users. Polling doubles as the heartbeat: stop polling for roughly 60 seconds and the control plane requeues the session elsewhere. Health and Prometheus metrics land on `/healthz` and `/metrics` at `--health-port`, default `8080`.

## What still goes to api.anthropic.com

Repository checkouts, build artifacts, secrets, and any file a session writes stay on your machines. The conversation does not: prompts, responses, and tool results go to `api.anthropic.com` for inference, and Anthropic stores the transcript so the session can resume from another surface. Every connection is outbound, and Anthropic never connects into your network.

Three limits are worth checking before you plan a rollout. Zero Data Retention organizations cannot use this. Inference cannot be routed through Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, or an LLM gateway, because sessions authenticate with an Anthropic-issued session-scoped token. And Claude Tag, Claude Security, and Code Review sessions do not route to self-hosted environments yet.

The same release also shipped [cross-session messaging](/2026/08/claude-code-2-1-224-sessions-message-each-other/). Full flag tables are in the [self-hosted environments reference](https://code.claude.com/docs/en/self-hosted-environments-reference).
