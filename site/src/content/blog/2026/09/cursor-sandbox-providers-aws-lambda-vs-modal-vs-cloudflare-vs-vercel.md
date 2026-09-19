---
title: "Cursor Sandbox Providers Compared: AWS Lambda vs Modal vs Cloudflare vs Vercel"
description: "Four ways to run Cursor Self-Hosted Machines workers for Cloud Agents, compared on isolation, pickup latency, session limits, per-session cost, and where the team service-account key ends up. Vercel Sandbox is the default pick, AWS Lambda MicroVMs if agents must reach your VPC."
pubDate: 2026-09-19
template: vs
tags:
  - "cursor"
  - "ai-agents"
  - "cloud-agents"
  - "comparison"
  - "devops"
---

**Short answer:** for a Cursor Enterprise team that wants Cloud Agent tool calls to run on infrastructure it pays for, start with **Vercel Sandbox**. Its reference integration (published 2026-09-02) is the only one of the four that keeps the long-lived team service-account key out of the sandbox, it scales to zero, and it came out second-cheapest in my cost model. Pick **AWS Lambda MicroVMs** instead when agents must reach private resources in a VPC. Pick **Modal** when agents need a GPU. Pick **Cloudflare Containers** when per-session cost matters more than anything else.

All four run the same thing: the Cursor agent CLI started as `agent worker ... start`, which opens an outbound HTTPS connection to Cursor and executes the agent's terminal commands, file edits, and builds. The agent loop and inference stay in Cursor's cloud. What differs is the controller that claims pending pool requests, the isolation boundary, how long a session may live, and how much trust you put inside the box. If you have not set up Self-Hosted Machines yet, read [how to keep Cursor agent tool execution inside your own network](/2026/09/how-to-keep-cursor-agent-tool-execution-inside-your-own-network/) first. This post assumes you already know what a Team Pool is and just need to pick where to run it.

## The comparison table

Versions and prices checked on 2026-09-19. Templates: `anysphere/aws-lambda-workers` (last push 2026-08-28), `anysphere/cloudflare-workers` (2026-09-03), `modal-cursor` via `uvx`, and the Vercel KB guide (updated 2026-09-03).

| | AWS Lambda MicroVMs | Cloudflare Containers | Modal Sandboxes | Vercel Sandbox |
| --- | --- | --- | --- | --- |
| Isolation per session | Firecracker microVM | Container in its own VM | gVisor sandbox | Firecracker microVM |
| Controller | Scheduled Lambda running `agent worker controller --spawn` | Worker on a 5-minute cron holding the SSE stream | Long-running Modal app `modal-cursor-control-plane` | Durable Vercel Workflow with adaptive polling |
| Setup | CloudFormation + `deploy.sh` + image build | `wrangler deploy` | `uvx modal-cursor init` | Next.js app you write (~250 lines) |
| Default idle release in template | 300 s | 300 s | 600 s | 600 s |
| Max session life | 8 h (`--maximum-duration-in-seconds 28800`) | 8 h (template watchdog) | 6 h default (`MODAL_CURSOR_SANDBOX_TIMEOUT_S`) | 45 min Hobby, 24 h Pro |
| CPU architecture | arm64 (Graviton) only | x86_64 | x86_64 | x86_64 |
| GPU | No | No | Yes (`gpu=` on `pool.machine()`) | No |
| Hibernation / follow-up reconnect | Platform supports suspend, template does not wire it | No | No (`workerReadyTimeoutSeconds=0`) | No (`workerReadyTimeoutSeconds: 0`) |
| Private network access | VPC egress connector | Public egress in template | Public egress in template | Egress allowlist, credential brokering |
| Cursor key inside the sandbox | Yes, team service-account key | Yes, team service-account key | Yes, team service-account key | No, 1-hour user-scoped sub-token |
| CPU billing | Provisioned baseline per second | Active CPU only | max(request, usage) | Active CPU only |
| Modelled cost, 40 min session | $0.195 | $0.086 | $0.178 | $0.115 |

The cost row comes from the script in the cost section below. It is a model built from list prices, not a bill. Every provider's free allowance is ignored.

## The row that should decide it: where the Cursor key lives

Every Self-Hosted Machines worker has to authenticate to Cursor. The simple way, which three of the four templates use, is to put the team service-account API key into the worker's environment as `CURSOR_API_KEY`.

That key is long-lived and team-scoped. It can list and claim pending requests for the team, register pools, and mint tokens for other users. And the worker is the machine where an LLM runs arbitrary shell commands on untrusted repository content. A prompt injection that gets the agent to run `env` or `cat /proc/self/environ` has the key.

Here is what each template actually does, read from the source:

- **Cloudflare**: `guestEnvForClaim()` in `src/controller.ts` builds the container environment with `CURSOR_API_KEY: apiKey`. The comment in `wrangler.jsonc` says it plainly: "Team service-account key (claims + guests)."
- **AWS Lambda**: the AWS guide says the key is read from SSM Parameter Store at runtime and "never baked into the image". That is true, but `controller/handler.py` injects the key into the controller process environment, and `spawn.sh` forwards every `CURSOR_*` variable except the endpoint ones through `--run-hook-payload`. So the key reaches the guest anyway. Even without that, `entrypoint.sh` falls back to `aws ssm get-parameter`, so the guest's IAM role can read it.
- **Modal**: the Modal docs say it directly: "It is available in each Cursor worker's environment, so code running in a worker sandbox can read it." Credit to them for saying so. The GitHub token for private clones is handled better: it is used for the clone and removed before the worker starts.
- **Vercel**: the control plane keeps the service-account key in Vercel Functions and Workflow. For each claim it calls `POST /v1/sub-tokens` with the requesting user's ID, writes the one-hour token into the sandbox with mode `0600`, and starts the worker with `--auth-token-file`. The long-lived key never enters the microVM.

This pattern is not specific to Vercel. It uses public Cursor API endpoints, so you can port it to any of the other three. On Cloudflare the change is small: mint the sub-token in the Worker, pass it as a file instead of `CURSOR_API_KEY`, and change the entrypoint to `agent worker --auth-token-file <path> --pool "$CURSOR_POOL" start`:

```typescript
// Cloudflare template variant, Cursor CLI worker as of 2026-09.
// Mint a user-scoped token in the controller instead of forwarding the team key.
async function mintWorkerToken(apiKey: string, userId: number): Promise<string> {
  const res = await fetch("https://api.cursor.com/v1/sub-tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ forUserId: userId }),
  });
  if (!res.ok) throw new Error(`sub-token mint failed: ${res.status}`);
  const { accessToken } = (await res.json()) as { accessToken: string };
  return accessToken; // expires after one hour, cannot refresh itself
}
```

The tradeoff is the one Vercel's guide admits. The token lasts one hour and cannot refresh itself, so a session that runs longer needs a refresh path from the controller. For most agent runs that is fine. For an 8-hour migration run it is a real piece of engineering. Even so, a token that expires in an hour is a much better thing to lose than a team key that never expires. This is the same reasoning as [keeping secrets out of an agent's Bash environment](/2026/06/claude-code-sandbox-credentials-block-secrets-from-bash/), applied to the worker's own credential.

## What a session costs

Cursor's own docs are clear about who pays: "With Self-Hosted Machines, you also pay for and operate your machines, containers, or cluster." Model tokens are billed by Cursor as usual. The compute is yours.

Agent sessions are an unusual workload. Most of the wall-clock time is spent waiting for model turns, so the CPU sits mostly idle, while memory stays allocated the whole time. That makes the billing model matter more than the headline rate. Here is the model I used:

```python
# session_cost.py - marginal compute cost of one Cursor self-hosted worker session.
# Rates: public list prices checked 2026-09-19 (us-east-1 / iad1 / default region).
# Ignores free allowances, egress, and storage. Python 3.10+.
import sys

active_min = float(sys.argv[1]) if len(sys.argv) > 1 else 40   # agent working
idle_s     = float(sys.argv[2]) if len(sys.argv) > 2 else 300  # --idle-release-timeout
cpu_util   = float(sys.argv[3]) if len(sys.argv) > 3 else 0.30 # CPU busy share while active

vcpu, mem_gb = 2, 4
active_s = active_min * 60
wall_s = active_s + idle_s
busy_vcpu_s = vcpu * cpu_util * active_s  # CPU burned; idle window ~0

providers = {
    # Lambda MicroVMs, Graviton: baseline vCPU + memory billed per second of runtime,
    # plus one snapshot read (resume/launch) of roughly the memory size.
    "AWS Lambda MicroVMs": vcpu * wall_s * 0.0000276944
                         + mem_gb * wall_s * 0.0000036667
                         + mem_gb * 0.00155,
    # Cloudflare Containers standard-3 (2 vCPU, 8 GiB, 16 GB): CPU on active use,
    # memory and disk on provisioned size.
    "Cloudflare Containers": busy_vcpu_s * 0.000020
                           + 8 * wall_s * 0.0000025
                           + 16 * wall_s * 0.00000007,
    # Vercel Sandbox, Pro: Active CPU per vCPU-hour, provisioned memory per GB-hour.
    "Vercel Sandbox": busy_vcpu_s / 3600 * 0.128
                    + mem_gb * wall_s / 3600 * 0.0212,
    # Modal Sandboxes: max(request, usage); 1 physical core = 2 vCPU requested.
    "Modal Sandboxes": max(1.0, busy_vcpu_s / wall_s / 2) * wall_s * 0.00003942
                     + mem_gb * wall_s * 0.00000667,
}

print(f"session: {active_min:.0f} min active, {idle_s:.0f} s idle window, {cpu_util:.0%} CPU")
for name, usd in sorted(providers.items(), key=lambda kv: kv[1]):
    print(f"  {name:<22} ${usd:.3f}")
```

Three runs, all for a 40-minute session on 2 vCPU and 4 GB (Cloudflare has no 4 GB size at 2 vCPU, so it is modelled as `standard-3` with 8 GiB):

| Scenario | Cloudflare | Vercel | Modal | AWS Lambda |
| --- | --- | --- | --- | --- |
| 300 s idle window, 30% CPU | $0.086 | $0.115 | $0.178 | $0.195 |
| 3600 s idle window (CLI default), 30% CPU | $0.156 | $0.193 | $0.397 | $0.427 |
| 300 s idle window, 80% CPU (heavy builds) | $0.134 | $0.200 | $0.178 | $0.195 |

Three things stand out.

First, **the idle window matters more than the vendor.** The CLI's `--idle-release-timeout` defaults to `3600` seconds. Each template overrides it (300 or 600 seconds). If you write your own spawn hook and forget to set it, every session keeps its sandbox alive for an extra hour waiting for a follow-up message that usually never comes. On the providers that bill provisioned CPU, that more than doubles the cost. Set `CURSOR_WORKER_IDLE_RELEASE_TIMEOUT` explicitly, whatever you choose.

Second, **billing on active CPU wins for agents.** Cloudflare and Vercel charge for CPU only while it is busy, so a session that is mostly waiting on the model is cheap. AWS bills the provisioned baseline for every second the microVM runs. Modal bills whichever is higher of request and usage, and 1 Modal core counts as 2 vCPU. Modal's Sandbox CPU rate ($0.00003942 per core per second) is also about 3x its Functions rate, so do not budget from the Functions price.

Third, **the gap closes under real build load.** At 80% CPU, Vercel's active-CPU rate is the highest of the four, and AWS's provisioned baseline stops being a disadvantage. If your agents spend their sessions compiling a monorepo, the ranking changes.

At these numbers, a team running 2,000 sessions a month pays roughly $170 to $390 in compute at the 300 s setting, depending on the provider. That is small next to the model tokens those sessions use. Cost is a tiebreaker, not the main decision, unless you run agents at a scale where tens of thousands of sessions make it matter.

## Pickup latency: how fast a queued agent starts

A pending request waits in Cursor's queue until something claims it. The controller design sets the worst-case wait before your spawn hook even runs:

- **Modal** runs a long-lived controller that reads the pending-request SSE stream, with a 24-hour invocation lifetime and up to 10 retries. That gives the fastest pickup of the four.
- **Cloudflare** runs a cron every five minutes, and each run holds the SSE stream for `CONTROLLER_RUN_BUDGET_MS = 290_000` (4 minutes 50 seconds), so coverage is almost continuous. The Cloudflare guide warns that the first scheduled run after deploy can take up to five minutes. If you change the cron, change the budget constant with it.
- **AWS** fires the controller Lambda on an EventBridge `rate(1 minute)` rule. Each invocation runs `agent worker controller --spawn ./spawn.sh` for a five-minute SSE window. Pickup is fast. The microVM boots from a Firecracker snapshot, which AWS describes as near-instant.
- **Vercel** as written in the guide polls, with no SSE: every 5 seconds while draining a backlog, every minute when recently idle, and every 5 minutes after five empty checks. The first agent after a quiet afternoon can wait up to five minutes before anything is claimed. The guide says to switch to the SSE flow if you need faster pickup, and for interactive use you should.

Boot time comes after that. Every template avoids installing the CLI at claim time: AWS and Vercel restore snapshots, Cloudflare bakes the CLI into the image and can restore post-clone repo snapshots from R2, and Modal uses a pinned `pool.worker_image()`. Clone time on a large repo still dominates. The same "move work earlier" logic from [cutting Cursor cloud agent startup time with Builds](/2026/08/how-to-cut-cursor-cloud-agent-startup-time-with-builds/) applies here, except that you now own the cache.

## When to pick AWS Lambda MicroVMs

- Your agents need to reach private resources: an Aurora staging database, an ElastiCache cluster, an internal package registry. The template attaches the managed `INTERNET_EGRESS` connector, and you swap it for a VPC egress connector at launch. None of the other three templates give you a comparable path into a private network without extra plumbing.
- You want AWS IAM as the permission model for what the agent can touch. The guest runs with `MicroVmExecutionRoleArn`, so short-lived AWS credentials come from the role, not from secrets you copy in.
- You can live with arm64. The MicroVMs are Graviton only, and the template's troubleshooting table lists "Exec format error on node" for images built for the wrong architecture. If your toolchain includes an x86-only binary, this option is out.
- You want to build hibernation later. MicroVMs support suspend and resume with state preserved, billed at storage rates while suspended. Cursor's `workerReadyTimeoutSeconds` reconnect window fits that model, but the reference `spawn.sh` sets `autoResumeEnabled: false`, so you would have to wire it yourself.

## When to pick Cloudflare Containers

- Cost per session is the main constraint and the workload is mostly idle CPU. It came out cheapest in every scenario I modelled.
- You want the smallest amount of infrastructure: one `wrangler deploy` ships the Worker, Durable Object, container app, R2 binding, and cron.
- You accept the defaults' limits. The template ships `standard-1` (1/2 vCPU, 4 GiB), which is too small for real builds; move to `standard-3` or `standard-4` (4 vCPU, 12 GiB is the top). `max_instances` in `wrangler.jsonc` caps concurrent sessions at 10 by default.
- Plan deploy windows. The Cloudflare guide warns that "a new container image rollout stops running containers," so a routine redeploy kills in-flight agent sessions.

## When to pick Modal

- Agents need a GPU: training scripts, CUDA test suites, local model evaluation. `pool.machine(gpu="A10G")` is one argument, and none of the other three offer GPUs here at all.
- Your team works in Python and wants the pool definition as code: `pools/<name>.py` is ordinary Python, and custom images extend `pool.worker_image()` with `.apt_install()` or `.pip_install()`.
- You want observability built in: set `OTEL_EXPORTER_OTLP_ENDPOINT` and the controller exports spans per pool, request, worker, and sandbox. Modal says the spans leave out keys and secret values.
- Be careful with `uvx modal-cursor destroy`. All pools share one control-plane app, so destroying one pool stops new sessions for every pool until you deploy again.

## When to pick Vercel Sandbox

- You care about the credential boundary and want it handled by the reference design rather than something you retrofit later.
- Your team is on TypeScript and is fine owning the controller code. The guide is a walkthrough, not a package: you write `lib/cursor-workers.ts`, two workflows, and a route handler. That is more code on day one, but every idempotency decision is visible: deterministic worker IDs, per-request workflow leases, and `Sandbox.getOrCreate()` with deterministic names.
- You are on Pro or Enterprise. On Hobby the 45-minute session cap and 10 concurrent sandboxes make it a demo, not a pool. The guide's own `timeout: 45 * 60 * 1000` is the Hobby limit, so raise it on Pro.

## The gotchas that decide it for you

**Enterprise is required regardless.** Every integration needs a Cursor Enterprise plan with Self-Hosted Machines turned on and an agent-scoped team service-account key. Personal API keys return `401` from the pool endpoints. That is a Cursor requirement, not a provider one.

**Follow-ups land on a fresh machine.** Modal registers `workerReadyTimeoutSeconds=0`, the Vercel guide does the same, and the Cloudflare and AWS templates do not hibernate. When the idle window ends and the user sends another message, the agent starts again on a new sandbox and rebuilds its workspace. If your team talks to agents in long conversations, raise the idle window and pay for it. That costs less than building hibernation.

**These are reference architectures.** Cursor's integration page states: "You own the worker image, infrastructure, secrets, scaling policy, and production validation." None of the templates restrict egress by default. Add [a strict host allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/) that allows `api2.cursor.sh`, `api2direct.cursor.sh`, `cloud-agent-artifacts.s3.us-east-1.amazonaws.com`, and your Git host, and nothing else.

**Kubernetes is the fifth option.** If you already run a cluster, `anysphere/k8s-workers` runs `agent worker controller --spawn` with one Pod per claim, and `--warm-idle` keeps warm Pods ready. Cloud Agents that run on an existing cluster cost nothing extra in infrastructure. The comparison above is for teams that do not want to run a cluster for this.

## The recommendation, restated

Default to Vercel Sandbox. It is the only reference integration that keeps the team key out of the box that runs untrusted code, it scales to zero, and it costs close to the cheapest option under typical agent load. Switch the discovery loop to SSE before you roll it out to people who notice a five-minute delay. Choose AWS Lambda MicroVMs when agents need your VPC, Modal when they need a GPU, and Cloudflare when cost per session decides. Whichever you choose, port the sub-token pattern and set the idle release timeout explicitly. Those two settings matter more than the choice of provider.

If you are still deciding whether to use Cursor's background agents at all, [Cursor Cloud Agents vs GitHub Copilot coding agent](/2026/07/cursor-cloud-agents-vs-github-copilot-coding-agent-for-background-prs/) covers that decision. Anthropic draws the same execution boundary with [Claude Code's self-hosted runner](/2026/08/claude-code-self-hosted-runner-cloud-sessions-on-your-own-hosts/).

## Related

- [How to keep Cursor agent tool execution inside your own network](/2026/09/how-to-keep-cursor-agent-tool-execution-inside-your-own-network/) for the worker CLI, Team Pools, and what still leaves your network.
- [How to lock down a coding agent's network egress with a strict host allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/) for the egress policy none of these templates ship.
- [Block secrets from Claude Code's Bash tool with sandbox credentials](/2026/06/claude-code-sandbox-credentials-block-secrets-from-bash/) for the same key-out-of-the-box principle on a local agent.
- [How to cut Cursor Cloud Agent startup time with Builds](/2026/08/how-to-cut-cursor-cloud-agent-startup-time-with-builds/) for the Cursor-hosted version of the startup problem.
- [Cursor Cloud Agents vs GitHub Copilot coding agent for background PRs](/2026/07/cursor-cloud-agents-vs-github-copilot-coding-agent-for-background-prs/) for the decision one level up.

## Sources

- [Cursor docs: Self-Hosted Machines integrations](https://cursor.com/docs/cloud-agent/self-hosted/integrations) for the partner list, reference templates, and "What every integration needs".
- [Cursor docs: Team Pools](https://cursor.com/docs/cloud-agent/self-hosted/pool) for `--idle-release-timeout` (default 3600), the controller `--spawn` and `--warm-idle` modes, and hibernation.
- [AWS docs: Using Lambda MicroVMs as a sandbox for Cursor Cloud Agents](https://docs.aws.amazon.com/lambda/latest/dg/microvms-integrations-cursor-self-hosted-machines.html) and [anysphere/aws-lambda-workers](https://github.com/anysphere/aws-lambda-workers) (`spawn.sh`, `controller/handler.py`, `microvm-image/entrypoint.sh`).
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/) for MicroVM vCPU-second, GB-second, and snapshot rates, and the [Lambda MicroVMs announcement](https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/).
- [Cloudflare docs: Run Cursor Cloud Agents on Cloudflare via self-hosted machines](https://developers.cloudflare.com/sandbox/tutorials/cursor-cloud-agents/) and [anysphere/cloudflare-workers](https://github.com/anysphere/cloudflare-workers) (`wrangler.jsonc`, `src/controller.ts`, `src/config.ts`).
- [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/) for instance types and per-second rates.
- [Modal docs: Run Cursor Cloud Agents on Modal](https://modal.com/docs/cursor) for `modal-cursor`, runtime defaults, and the credential note; [Modal pricing](https://modal.com/pricing) and [Modal resources guide](https://modal.com/docs/guide/resources) for Sandbox rates and request-or-usage billing.
- [Vercel KB: Run Cursor Cloud Agents on Vercel Sandbox](https://vercel.com/kb/guide/cursor-vercel-sandbox) for the Workflow controller, `/v1/sub-tokens`, and `--auth-token-file`; [Vercel Sandbox pricing and quotas](https://vercel.com/docs/sandbox/pricing) for rates and plan limits.
