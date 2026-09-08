---
title: "How to Keep Cursor Agent Tool Execution Inside Your Own Network"
description: "Cursor's Self-Hosted Machines, shipped September 2, 2026, move Cloud Agent tool calls onto hardware you own while inference stays in Cursor's cloud. The agent worker CLI, My Machines vs Team Pools, the three outbound hosts, and the data that still leaves your network."
pubDate: 2026-09-08
tags:
  - "cursor"
  - "ai-agents"
  - "cloud-agents"
  - "devops"
---

Cursor shipped Self-Hosted Machines on September 2, 2026. It lets a Cloud Agent run its terminal commands, file edits, builds, and browser automation on a machine you own, while the agent loop and inference stay in Cursor's cloud. You install the Cursor CLI, run `agent worker start`, and the machine opens a long-lived outbound HTTPS connection that Cursor pushes tool calls over. There are no inbound ports and no public IP. Two shapes exist: **My Machines**, a personal laptop or VM bound to your own Cursor user, and **Team Pools**, named routing targets backed by a fleet, which require an Enterprise plan and a service account key.

The important thing to understand before you plan a rollout: this is not an air gap. Only execution moves. Tool output still travels to Cursor so the model can read it.

## What moves and what does not

The split is clean and worth stating precisely, because a lot of internal security reviews start from the wrong assumption.

Stays in Cursor's cloud:

- The agent loop and planning.
- Inference against whichever model the session picked.
- Session orchestration, the run transcript, and the UI you drive it from.

Moves to your machine:

- Every terminal command the agent runs.
- Every file read and write, against a working copy that lives on your disk.
- The git clone itself, so the repository never lands on Cursor infrastructure.
- Build outputs, test artifacts, and anything the build writes to disk.
- Local MCP server processes and their tool calls.
- Computer use, when you enable it.

The Cursor docs are explicit that the worker still sends back "the content the agent needs, such as file contents, terminal output, diffs, screenshots, local MCP results." That is the model's entire input, so it has to cross the boundary. What you gain is that the *durable* copies stay put: the checkout, the artifacts, the secrets in your CI environment, the database the tests hit. What you do not gain is a guarantee that no source code text reaches Cursor. If your compliance requirement is the second thing, Self-Hosted Machines does not satisfy it and no configuration flag will change that.

This is the same boundary [Claude Code's self-hosted runner](/2026/08/claude-code-self-hosted-runner-cloud-sessions-on-your-own-hosts/) draws, and the two features are close enough that if you have already reviewed one, the threat model transfers.

## The single-machine path

Start here even if you are heading for a fleet, because it takes about two minutes and it proves the network path.

```bash
# macOS, Linux, WSL
curl https://cursor.com/install -fsS | bash

# Windows PowerShell
irm 'https://cursor.com/install?win32=true' | iex
```

Then authenticate and start a worker from inside a repository checkout:

```bash
agent login                       # browser sign-in, personal credential
cd ~/src/payments-api
agent worker start --name "mbp-devbox"
```

`agent login` opens a browser flow. You can also pass a personal API key with `--api-key`, or a user-scoped token file with `--auth-token-file`, which is what you want in a Kubernetes Secret. One restriction that trips people up on the first attempt: **My Machines workers require a personal credential.** A team service account key will not authenticate a My Machines worker. Service account keys are for pools.

`--name` is not cosmetic. It is the routing key. Once the worker is up, the machine appears in the environment dropdown at `cursor.com/agents`, and you can also address it from the integrations:

- Slack: `@Cursor worker=mbp-devbox fix the flaky auth test`
- GitHub: `@cursoragent worker=mbp-devbox ...` on an issue, PR, or review comment, and the commenter has to be trusted
- Linear: put `worker=mbp-devbox` in the issue body

Cursor only routes when the machine belongs to the Cursor user who triggered the request and the name matches. There is no cross-user borrowing on My Machines. That is a deliberate isolation property, not a missing feature.

A worker started in a git checkout picks up its repo label from the git remote. To span several repositories, repeat `--worker-dir`:

```bash
agent worker \
  --name "app-infra-devbox" \
  --worker-dir "$HOME/src/app" \
  --worker-dir "$HOME/src/infra" \
  start
```

Multi-root workers landed in the June 9, 2026 CLI release. The flag is repeatable up to 20 directories, and it also lets a worker start from a directory that is not a git repository at all.

## Team Pools, and the two pool shapes

A pool is a named routing target. Requests go to the pool, any connected worker in that pool can serve them. Pools need an Enterprise plan with Self-Hosted Machines enabled and a **service account** API key, not a personal one.

```bash
export CURSOR_API_KEY="sk-..."   # service account, agent scope
cd /srv/work/payments-api
agent worker --pool start
```

`--pool` with no argument registers into the pool named `default`. Name it when you have more than one:

```bash
# a GPU box that releases itself 10 minutes after a session ends
agent worker --pool gpu --idle-release-timeout 600 start
```

`--idle-release-timeout` defaults to `3600` seconds, so out of the box a worker sits claimed for an hour after a session ends, waiting for follow-up messages. Set it to `0` to keep the worker connected forever. When the timeout fires the CLI exits with code `0`, which is exactly what you want under systemd or a Kubernetes Job: a clean exit that a supervisor treats as success and recycles.

The two pool shapes differ in who owns the checkout:

**Repo-backed pools.** The worker starts inside a clone you provisioned. Cursor routes on `repo=<owner>/<repo>` derived from the git remote. Use this when the repositories are few, large, and expensive to clone, and you want a warm working copy sitting on disk.

**Any-repo pools.** Source control is managed outside Cursor's matching logic. The worker starts in a plain directory and requests match on pool name alone:

```bash
mkdir -p "$HOME/cursor-sandboxes/default"
agent worker --pool sandbox --worker-dir "$HOME/cursor-sandboxes/default" start

# or let the worker clone on claim
agent worker --pool sandbox --clone-git-repos start
```

Add `--mint-github-token` when you want Cursor to hand the worker a short-lived GitHub token instead of baking a long-lived PAT into the image.

The routing gotcha nobody reads until it bites: **pools are not repository-scoped.** Any worker in a pool can claim a request for any repository routed to that pool. If you have a team whose repos must not share hardware with another team's, that is two pools, not one pool with labels. Labels help you steer, they do not enforce:

```bash
agent worker --pool --label team=backend --label env=production start
agent worker --pool --labels-file labels.json start
```

Request-side, you reach a pool from the Cloud Agents dashboard worker selector, from Slack with `pool=<name>` or a bare `self_hosted`, from a GitHub comment with `@cursoragent pool=<name> ...`, from Linear with `pool=<name>` in the body, and from the API with `usePrivateWorker` plus `labels`. Launching directly is `POST /v1/agents` with `env.type: "pool"` and `env.name` set to the pool. For any-repo pools you can omit `repos` entirely.

## Scaling the fleet

For anything beyond a few static boxes you want a controller: a process that watches the pending-request queue and spawns a worker per request.

```bash
# claim-then-spawn, one worker per request
agent worker controller --spawn ./spawn.sh --api-key "$CURSOR_API_KEY" --pool gpu --pool default

# keep five warm idle workers on the gpu pool
agent worker controller --spawn ./spawn.sh --api-key "$CURSOR_API_KEY" --pool gpu --warm-idle 5
```

On Kubernetes, the `anysphere/k8s-workers` Helm chart wraps that pattern. The controller runs `kubectl create` for a one-shot Pod with `restartPolicy: Never`, and the Pod completes when the idle timeout fires:

```bash
helm upgrade --install my-workers ./chart \
  --namespace cursord --create-namespace \
  --set image.repository=registry.internal/cursor-worker \
  --set image.tag=2026.09.02 \
  --set pool=default \
  --set controller.warmIdle=0 \
  --set auth.existingSecret=cursor-workers-api-key
```

Note that the older Kubernetes *operator* is deprecated for new deployments. Existing installs keep running, but start new clusters on the Helm chart.

If you would rather not run the controller yourself, eight providers ship reference integrations: AWS Lambda (Firecracker microVMs, driven by the `--spawn` hook), Cloudflare, Coder, Daytona, E2B, Modal, Namespace, and Vercel. The Cloudflare template is the clearest one to read, because the controller is just a Worker on a five-minute cron that lists pending sessions for `CURSOR_POOL`, holds an SSE stream until the next tick, claims a session, and has a Durable Object launch one container per session running:

```sh
agent worker --worker-dir "$HOME/workspaces/repo-0" --pool "$CURSOR_POOL" start --verbose
```

If you are building your own controller against the raw API, the endpoints you need are `GET /v0/private-workers/pending-requests` to list, `GET /v0/private-workers/pending-requests/stream` for the SSE feed of `created` / `claimed` / `expired` events, `POST /v0/private-workers/claim` with `id` and `workerId` to atomically reserve work before the machine even boots, and `POST /v0/private-workers/claims/{id}/release` to drop the routing preference so a replacement worker can pick the same agent up immediately. `POST /v0/private-workers/pools` registers a durable pool before any worker connects, which is worth doing so the pool shows in the UI while your fleet is still at zero.

Hard limits: 200 workers per user and 1000 per team. Past that, it is a sales conversation.

For observability, give the worker a management address and scrape it:

```bash
agent worker --pool --management-addr ":8080" start
curl http://localhost:8080/metrics
```

Health and Prometheus metrics come off that address. `agent worker debug --json` is the pre-flight check; run it in your image build so a broken image fails at build time rather than on first claim.

## Hibernation and follow-up messages

Warm workers are the expensive part of a self-hosted fleet, and the naive fix (release aggressively) breaks follow-ups, because the next message in the conversation lands on a machine that no longer has the workspace. Cursor's answer is a reconnect window on the pool:

```bash
curl --request POST \
  --url "https://api.cursor.com/v0/private-workers/pools" \
  -u "$CURSOR_API_KEY:" \
  --header 'Content-Type: application/json' \
  --data '{
    "scope": "team",
    "poolName": "gpu",
    "workerReadyTimeoutSeconds": 900
  }'
```

With `workerReadyTimeoutSeconds` set, a follow-up waits up to that long for a worker to come back rather than failing. Your controller's spawn hook wakes the hibernated machine and the replacement worker restores the identity by exporting the claimed ID before starting:

```bash
export CURSOR_AGENT_WORKER_ID="<claimedWorkerId>"
agent worker --pool gpu start
```

Budget realistically here. Reconstructing a workspace from a snapshot takes minutes, not seconds, and 900 seconds of follow-up latency is a bad user experience even if it technically succeeds. If your team sends follow-ups conversationally, a longer `--idle-release-timeout` is cheaper than aggressive hibernation. The same tradeoff shows up when you tune [Cursor's prebuilt Builds for cloud agents](/2026/08/how-to-cut-cursor-cloud-agent-startup-time-with-builds/): moving work earlier beats paying for it at first token.

Two session lifecycle hooks fire on self-hosted workers, `sessionStart` and `sessionEnd`, when a session claims the worker and when the claim is released. That is your mount point for injecting short-lived credentials and scrubbing them afterwards. Prompt-based hooks and the IDE-only hooks (`beforeTabFileRead`, `afterTabFileEdit`, `workspaceOpen`) do not run on a worker.

## Computer use on hardware you own

Self-hosted workers support computer use on macOS and, since the September release, Linux. Enable it with a flag:

```bash
agent worker --computer-use start
agent worker --computer-use --share-desktop start   # Linux only
```

On Linux, install the desktop stack first: `dbus-x11`, `ffmpeg`, `tigervnc-standalone-server`, `x11-utils`, `x11-xserver-utils`, `xdotool`, `xfce4`, plus Chrome or Chromium if the agent needs a browser. `--share-desktop` exposes the agent's desktop through TigerVNC so a human can watch or take over from inside Cursor.

macOS is the fiddly one. The CLI installs a helper app called "Cursor Computer Use", and you must grant **Accessibility** and **Screen Recording** to that app specifically, not to Terminal, not to iTerm. The permissions attach to the bundle identifier `co.anysphere.cursor-computer-use`. A signed-in desktop session is required, so a headless Mac mini in a rack needs auto-login configured. For a fleet, grant the permissions once on a template Mac, verify with a real task, then snapshot the image. Permissions persist on the machine, so this is a one-time cost per image rather than per host.

## Egress, and the four hosts

Workers need outbound HTTPS to exactly three hosts:

- `api2.cursor.sh` and `api2direct.cursor.sh` for agent sessions
- `downloads.cursor.com` for CLI updates and the macOS Computer Use helper
- `cloud-agent-artifacts.s3.us-east-1.amazonaws.com` for artifact uploads

Nothing inbound. That is a firewall rule you can actually get approved, and it is far narrower than the egress surface of an agent running unrestricted, which is the problem [a strict host allowlist for coding agents](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/) exists to solve. Note the S3 bucket is region-pinned to `us-east-1`, so a proxy policy that filters by region will break artifact upload with a failure that surfaces late in a run.

Since March 2026 the worker no longer requires sudo, refreshes its token automatically, exposes Prometheus metrics, supports Windows, and honours proxy routing. If you evaluated this in the spring and bounced off the sudo requirement, re-check.

## What to decide before you roll this out

Cost model changes shape. Cursor-hosted Cloud Agents bundle the execution infrastructure. Self-hosted, you pay model pricing plus your own compute, which means idle warm workers are a line item you now own. Measure your claim-to-first-token latency with `--warm-idle 0` before you decide you need warm capacity.

Pick My Machines when a single person needs an agent on a specific box: the machine with the licensed toolchain, the connected hardware, the VPN route to a staging database. Pick Team Pools when the requirement is organisational rather than personal, and accept the Enterprise plan and the service account key that come with it.

And be honest in the security review about what the boundary actually is. Repository, artifacts, secrets, and running services stay inside. Tool output, diffs, and screenshots go out, because the model has to read them. Everything else is a routing detail.

## Related

- [Claude Code Cloud Sessions Can Now Run on Your Own Hosts](/2026/08/claude-code-self-hosted-runner-cloud-sessions-on-your-own-hosts/) for the same boundary drawn by Anthropic, including the one-user runner rule.
- [How to Lock Down a Coding Agent's Network Egress With a Strict Host Allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/) for the allowlist policy that pairs with the three-host rule above.
- [How to Cut Cursor Cloud Agent Startup Time With Prebuilt Builds](/2026/08/how-to-cut-cursor-cloud-agent-startup-time-with-builds/) for the startup-cost lever on Cursor-hosted agents, and the tradeoff that reappears in hibernation tuning.
- [How to Distribute a Team MCP Server Config Across Cursor Cloud Agents and the IDE](/2026/07/distribute-team-mcp-config-across-cursor-cloud-agents-and-ide/) because local MCP servers now run on your worker, and their config has to reach it.
- [Cursor Cloud Agents vs GitHub Copilot Coding Agent for Background PRs](/2026/07/cursor-cloud-agents-vs-github-copilot-coding-agent-for-background-prs/) if you are still choosing which background agent to standardise on.
- [Cursor 3.4 Adds Multi-Repo Environments and Faster Dockerfile Builds for Cloud Agents](/2026/05/cursor-3-4-multi-repo-cloud-agent-environments/) for the multi-repo model that `--worker-dir` mirrors on the worker side.

## Sources

- [Cursor changelog: Self-hosted machines](https://cursor.com/changelog/self-hosted-machines), September 2, 2026, for the My Machines and Team Pools split, the provider list, and Linux computer use.
- [Cursor blog: Run cloud agents on machines you manage](https://cursor.com/blog/self-hosted-machines) for the cloud-versus-local responsibility split and the hibernation caveats.
- [Cursor docs: Self-Hosted Machines](https://cursor.com/docs/cloud-agent/self-hosted) for the statement of what the worker sends back to Cursor and the cost model.
- [Cursor docs: My Machines](https://cursor.com/docs/cloud-agent/self-hosted/my-machines) for `agent login`, `--name` routing, and the personal-credential requirement.
- [Cursor docs: Team Pools](https://cursor.com/docs/cloud-agent/self-hosted/pool) for the flag table and defaults, the 200/1000 worker limits, the outbound host list, `workerReadyTimeoutSeconds`, and the session lifecycle hooks.
- [Cursor docs: Integrations](https://cursor.com/docs/cloud-agent/self-hosted/integrations) for the eight partner platforms and the deprecation of the Kubernetes operator.
- [Cursor docs: Computer use and desktop sharing](https://cursor.com/docs/cloud-agent/self-hosted/computer-use) for the Linux package list and the macOS `co.anysphere.cursor-computer-use` permission grants.
- [Cursor docs: Cloud Agents API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints) for `/v1/agents` with `env.type: "pool"` and the `/v0/private-workers/*` claim, release, and stream endpoints.
- [Cursor CLI changelog](https://cursor.com/docs/cli/changelog) for the August 26, 2026 pool flags and hooks, the June 9, 2026 multi-root `--worker-dir`, and the March 2026 removal of the sudo requirement.
- [anysphere/k8s-workers](https://github.com/anysphere/k8s-workers) for the Helm chart, the claim-then-spawn controller, and `controller.warmIdle`.
- [Cloudflare docs: Run Cursor Cloud Agents on Cloudflare via self-hosted machines](https://developers.cloudflare.com/sandbox/tutorials/cursor-cloud-agents/) for the cron-driven controller pattern and the container start command.
