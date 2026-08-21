---
title: "How to Cut Cursor Cloud Agent Startup Time With Prebuilt Builds"
description: "Cursor shipped Builds for Cloud Agents on August 13, 2026: a bootable filesystem snapshot of an already prepared machine. Cursor reports 3x faster time to first token. The lever you control is the install vs start split in .cursor/environment.json."
pubDate: 2026-08-21
tags:
  - "cursor"
  - "ai-agents"
  - "cloud-agents"
  - "llm"
  - "devops"
---

Cursor shipped [Builds for Cloud Agents on August 13, 2026](https://cursor.com/changelog/08-13-26), and it changes where your agent's startup time goes. A Build is a bootable filesystem snapshot of a machine that already has your repositories cloned, your dependencies installed, and your artifacts compiled. New agents fork that live machine from a pre-warmed pool instead of booting one and running your setup script. Cursor reports environments booting 10x faster internally and 3x faster time to first token. The part you actually control is one line in `.cursor/environment.json`: every second of work you move out of `start` and into `install` leaves the agent's startup path entirely, because `install` runs during the Build and `start` runs when the agent wakes up. This is a server-side Cloud Agents change, so there is no client version to upgrade to (the most recent documented desktop release is Cursor 3.11 from July 10, 2026).

## Where the minutes actually went before

The old model was just-in-time. Every cloud agent session booted a fresh VM, cloned the repo, and ran your install script, and only then did the model see its first token of your prompt. Cursor's own framing in [the Builds announcement](https://cursor.com/blog/builds) is blunt about the cost on big repositories: several minutes before the agent started executing.

That cost is paid per session, not per day. If you are running the kind of setup I described in [assigning a Jira ticket to a cloud agent and getting a PR back](/2026/05/how-to-assign-a-jira-ticket-to-a-cursor-cloud-agent-and-get-a-pr-back/), where a ticket transition fires an agent, you pay it on every ticket. Fan out to ten parallel agents and you pay it ten times, concurrently, on ten machines.

Builds moves that work off the critical path and amortises it. Cursor prepares the environment in the background on a schedule (by default, a new Build every hour) and keeps warm copies of the active Build ready to fork. It is included with Cloud Agents at no extra cost, so there is no billing reason to leave it off.

## What a Build is, precisely

Per [the Builds documentation](https://cursor.com/docs/cloud-agent/builds), every Build moves through five stages:

| Stage | What happens |
| --- | --- |
| Trigger | Started on a schedule, after an environment config or secret is saved, manually from the Builds tab, or by an agent |
| Prepare | Cursor clones your repositories at the default branch and runs the `install` command |
| Snapshot | The machine's disk state is saved along with the environment version and the commit SHA of each repository |
| Activate | A successful Build becomes the active Build |
| Start agents | New agent runs launch from the active Build |

The word to hold onto is **disk**. A Build preserves disk state and nothing else. Processes that were running when the snapshot was taken are gone. Shell variables you exported during `install` are gone. Anything you warmed into memory is gone. Files are what survive, and that constraint drives every decision below.

## The install vs start vs terminals split

Cursor's environment config has three command hooks, and they now run at two completely different times:

- `install` runs **during each Build**. Dependencies, code generation, compilation, cache warming.
- `start` runs **at agent startup**, every session. Docker, databases, long-lived services.
- `terminals` runs **at agent startup**, every session, to open tmux sessions shared between you and the agent.

Before Builds, the split was mostly cosmetic because everything ran back to back on a cold machine. Now `install` is free from the agent's point of view and `start` is not. Here is a configuration that looks reasonable and is now actively wrong:

```json
// .cursor/environment.json, the anti-pattern under Builds
{
  "install": "pnpm install",
  "start": "pnpm prisma generate && pnpm build && docker compose up -d",
  "terminals": [
    { "name": "dev", "command": "pnpm dev" }
  ]
}
```

`prisma generate` writes a client into `node_modules`. `pnpm build` writes to `dist`. Both are pure disk output, both are deterministic given the lockfile, and both are being paid for on every single agent start. Move them:

```json
// .cursor/environment.json, tuned for Builds (Cloud Agents, August 2026)
{
  "install": "pnpm install --frozen-lockfile && pnpm prisma generate && pnpm build",
  "start": "docker compose up -d",
  "terminals": [
    { "name": "dev", "command": "pnpm dev" }
  ]
}
```

Only `docker compose up -d` stays in `start`, because containers are running processes and running processes do not survive a snapshot. Everything else is now baked into the image the agent forks.

The same reshuffle on a .NET repository:

```json
// .cursor/environment.json for a .NET solution
{
  "install": "dotnet restore && dotnet build -c Debug --no-restore && dotnet tool restore",
  "start": "docker compose -f docker-compose.dev.yml up -d"
}
```

`dotnet restore` populates `~/.nuget/packages`, `dotnet build` populates `obj/` and `bin/`, and `dotnet tool restore` populates the local tool manifest cache. All three are on disk, so all three land in the snapshot. On a large solution this is the difference between an agent that can run `dotnet test` immediately and one that spends 90 seconds restoring before it can compile a single file.

One rule the docs are explicit about: **`install` must be idempotent and complete**. It runs on every Build, on a machine that may already carry a warm cache from a previous Build, and its exit code decides whether the Build activates. A script that appends to a config file without checking, or that succeeds only on a clean machine, will produce Builds that drift or fail.

## Exported variables are the trap

This is the failure mode I would expect to burn the most people, because it works locally and it worked before Builds.

```bash
# Runs during install. Survives nothing.
export DATABASE_URL="postgres://localhost:5432/app"
export PATH="$HOME/.local/bin:$PATH"
```

The snapshot captures the filesystem, not the shell that ran `install`. Write to disk instead, and make the write idempotent so repeated Builds do not stack duplicate lines:

```bash
# Runs during install. Survives, because .bashrc is a file.
LINE='export PATH="$HOME/.local/bin:$PATH"'
grep -qxF "$LINE" ~/.bashrc || echo "$LINE" >> ~/.bashrc
```

The same logic applies to anything that lives in a daemon rather than a file. A warmed Redis, a running language server, a connection pool: none of it comes back. If you need it, it belongs in `start`.

## Turning Builds on for an environment you already have

New environments get Builds automatically. Existing ones do not, and there are two ways to opt in:

1. Open the Cloud Agents dashboard, go to the **Builds** tab for the environment, and enable it there.
2. Run a setup agent first. Cursor's agent-led setup inspects the repo, proposes changes to `.cursor/environment.json`, verifies the environment by actually running your software, and creates the first Build. You review the proposed config before it lands.

Option 2 is worth the extra step on a repo where you are not sure what belongs in `install`, because the agent has to prove the environment works before it snapshots it.

If your environment is defined by a Dockerfile rather than a saved snapshot, the same fields still apply:

```json
// Dockerfile-based environment. build.context defaults to .cursor
{
  "build": {
    "dockerfile": "Dockerfile",
    "context": ".."
  },
  "install": "pnpm install --frozen-lockfile && pnpm build"
}
```

The Dockerfile produces the base image, `install` runs on top of it during the Build, and the result is what gets snapshotted. That layering is the same one that made [Cursor 3.4's cached Dockerfile rebuilds](/2026/05/cursor-3-4-multi-repo-cloud-agent-environments/) worth configuring carefully, and multi-repo environments still work here: the Build records one commit SHA per repository.

## When a rebuild happens, and when it is skipped

| Trigger | Runs |
| --- | --- |
| Recurring | On a schedule, hourly by default |
| Configuration change | Whenever the environment config or a secret is saved |
| Manual | On demand via "Trigger build" in the Builds tab |
| Agent-requested | When an agent runs a test Build during setup or debugging |

Only the recurring trigger can be skipped. Cursor skips it when nothing has changed since the last completed Build: no new commits on the default branch of any repository in the environment, and no configuration or secret changes. The other three always run.

This is the answer to "why is my agent still using yesterday's dependencies." If your lockfile changed on a feature branch and never merged to the default branch, the recurring Build has nothing to react to, because Prepare clones the default branch. Trigger a manual Build, or land the lockfile change.

## Staleness: how far behind the default branch your agent starts

Because a Build pins commit SHAs, an agent that starts from it starts at those SHAs. Cursor exposes two settings for this:

- **Update stale builds**, which pulls the latest default-branch code at agent start if the Build is older than the threshold.
- **Staleness threshold**, default 24 hours, settable to `0` to always pull.

Setting `0` gives you freshness at the cost of putting a `git pull` (and whatever your package manager does about a changed lockfile) back on the critical path. The default of 24 hours combined with an hourly recurring Build is usually fine, since a Build older than 24 hours only happens on a repository with no default-branch activity. On a busy monorepo I would leave the threshold alone and rely on the hourly cadence; on a repo where merges land in bursts, tighten it.

Feature branch runs behave differently, and this catches people: the run starts from the active Build, then checks out the branch you asked for. So the dependency state you inherit is the default branch's, and a `package.json` change that exists only on your branch is applied on top without a reinstall unless something in `start` handles it.

## Secrets: user secrets cannot participate

The secret model splits cleanly along the snapshot boundary:

- **Team and environment secrets** are available during Builds and are captured in the snapshot.
- **User secrets** are injected only when an agent starts. They are not available during Builds and never become part of a shared snapshot.

That is the right security posture, since a per-user token should not be baked into an image that every teammate's agents fork. But it means an `install` step that authenticates with a user secret will fail during the Build. A private npm registry, a private NuGet feed, or a `git clone` of a private sibling repo all need an **environment** secret, not a user one. Saving that secret also counts as a configuration change, so it triggers a fresh Build immediately.

## Measuring the win

Do not take the 3x on faith for your repo. The [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints) gives you both ends of the measurement: create a run, then stream its events and stamp the first one that is not a status change.

```js
// Cursor Cloud Agents API, /v1 endpoints, August 2026
const key = process.env.CURSOR_API_KEY;
const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

const t0 = Date.now();
const created = await fetch("https://api.cursor.com/v1/agents", {
  method: "POST",
  headers,
  body: JSON.stringify({
    prompt: { text: "Print the output of `dotnet --version` and stop." },
    repos: [{ url: "https://github.com/acme/monolith" }],
  }),
}).then((r) => r.json());

const agentId = created.agent.id;
const runId = created.run.id;

const stream = await fetch(
  `https://api.cursor.com/v1/agents/${agentId}/runs/${runId}/stream`,
  { headers }
);

const reader = stream.body.getReader();
const decoder = new TextDecoder();
let firstToken = null;

while (!firstToken) {
  const { value, done } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value);
  // event types: status, assistant, thinking, tool_call, result, error, done
  if (/event:\s*(assistant|thinking)/.test(chunk)) firstToken = Date.now();
}

console.log(`time to first token: ${firstToken - t0} ms`);
```

Run that against the same prompt before and after you move work from `start` into `install`. The terminal run object also carries `durationMs`, which is useful for the end-to-end number but not for isolating startup, since it includes the model doing actual work.

## When a Build fails

A failed Build does not interrupt anything. Agents keep launching from the last successful active Build while you debug, which is the resilience half of the feature: a bad commit or a broken dependency update stops poisoning every session that starts after it.

To debug, the Builds tab gives you type, status, timestamp, logs, commit SHAs, and which Build each agent run used. You can activate or deactivate a Build, cancel one in progress, and start an agent from a specific Build, including a failed one, so you can walk the machine in the state that broke it.

Agents can also work on this themselves through the built-in Cursor Cloud MCP, the diagnostics server available during cloud agent runs. Its tools include `run-info`, `environment-info`, `get-events`, `list-cloud-agents`, and `batch-fetch-details`, and per [the capabilities docs](https://cursor.com/docs/cloud-agent/capabilities) an agent can trigger test Builds, inspect Build status and logs, propose environment configuration, take snapshots of a verified environment, and request a user action that is blocking setup, such as adding a secret. Ask an agent to fix its own broken environment and it has the tools to do it, which is a different proposition from the team MCP servers you configure yourself in [a shared cloud and IDE config](/2026/07/distribute-team-mcp-config-across-cursor-cloud-agents-and-ide/).

## A short checklist

1. Move every deterministic, disk-writing step from `start` into `install`: dependency installs, code generation, compilation, tool restores.
2. Leave only services in `start`: Docker, databases, anything that is a process rather than a file.
3. Make `install` idempotent, and make its exit code honest.
4. Replace `export` in `install` with an idempotent append to a dotfile.
5. Move any secret that `install` needs from a user secret to an environment secret.
6. Decide your staleness threshold deliberately instead of inheriting 24 hours by accident.
7. Measure time to first token through the API before and after.

## Related

- [Cursor 3.4 Adds Multi-Repo Environments and Faster Dockerfile Builds for Cloud Agents](/2026/05/cursor-3-4-multi-repo-cloud-agent-environments/) for the Dockerfile layering and multi-repo config that Builds snapshots on top of.
- [Cursor Cloud Agents vs GitHub Copilot Coding Agent for Background PRs](/2026/07/cursor-cloud-agents-vs-github-copilot-coding-agent-for-background-prs/) if you are still deciding which background agent to standardise on.
- [How to Assign a Jira Ticket to a Cursor Cloud Agent and Get a PR Back](/2026/05/how-to-assign-a-jira-ticket-to-a-cursor-cloud-agent-and-get-a-pr-back/) for the event-driven flow where per-session startup cost compounds fastest.
- [How to Build a Cursor Automation with the /automate Skill and GitHub Triggers](/2026/07/build-a-cursor-automation-with-automate-skill-and-github-triggers/) for scheduling the agents that fork these Builds.
- [Cursor 3.3 Adds Build in Parallel, Split PRs, and a Unified PR Review](/2026/05/cursor-3-3-build-in-parallel-split-prs/) for why parallel fan-out is what makes a slow cold start expensive.

## Sources

- [Cursor changelog: Cloud Agents Start 3x Faster with Builds](https://cursor.com/changelog/08-13-26), August 13, 2026, for the 10x boot and 3x time-to-first-token figures and the enablement path for existing environments.
- [Cursor blog: Cloud agents start 3x faster with builds](https://cursor.com/blog/builds) for the forking-a-live-machine mechanism, the pre-warmed pool, and the hourly default cadence.
- [Cursor docs: Cloud Agent Builds](https://cursor.com/docs/cloud-agent/builds) for the five-stage lifecycle, the trigger table and skip conditions, the `install` / `start` / `terminals` split, the secret rules, and the staleness threshold default.
- [Cursor docs: Cloud Environment Setup](https://cursor.com/docs/cloud-agent/setup) for the `.cursor/environment.json` fields including `snapshot`, `build.dockerfile`, `build.context`, and `repositories`.
- [Cursor docs: Cloud Agent Capabilities](https://cursor.com/docs/cloud-agent/capabilities) for the Cursor Cloud MCP tool list and what agents may do to Builds.
- [Cursor docs: Cloud Agents API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints) for `/v1/agents`, the run stream event types, and `durationMs`.
