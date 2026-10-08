---
title: "What Is GitHub Agentic Workflows, and How Is It Different From GitHub Actions?"
description: "GitHub Agentic Workflows (gh-aw v0.91.5) compiles a Markdown file into a hardened GitHub Actions .lock.yml that runs Copilot, Claude Code, Codex, Gemini or Pi in a read-only, firewalled job and applies writes through safe-outputs. What it adds on top of Actions, the jobs it generates, and when a plain workflow with claude-code-action is still the better tool."
pubDate: 2026-10-08
tags:
  - "ai-agents"
  - "github-copilot"
  - "claude-code"
  - "github-actions"
  - "agentic-workflows"
  - "automation"
---

**Short answer:** GitHub Agentic Workflows (the `gh aw` CLI extension, v0.91.5 as of October 7, 2026, still in technical preview since February 13, 2026) is not a replacement for GitHub Actions. It is a compiler that sits on top of it. You write a Markdown file with YAML frontmatter (trigger, permissions, engine, tools, allowed outputs) and a natural-language body (the task). `gh aw compile` turns that into a regular `.lock.yml` Actions workflow that runs a coding agent (Copilot CLI by default, or Claude Code, Codex, Gemini, Pi) inside a read-only, network-firewalled job, then applies any writes from separate, permission-scoped jobs after a threat-detection pass. Actions is the runtime; gh-aw is the guardrail layer you would otherwise hand-write.

That distinction matters because "run an AI agent in CI" was already possible before gh-aw existed. You could drop `anthropics/claude-code-action@v1` into any workflow and give it a prompt. The question developers actually have is: what does gh-aw add, what does it cost, and when is it worth the extra layer? This post answers that with the same task written both ways.

## The same issue-triage job, written twice

Take a common automation: when an issue is opened, read it, apply one label from a fixed set, and post a short comment asking for a repro if one is missing.

Here is the plain GitHub Actions version using Claude Code's official action:

```yaml
# .github/workflows/triage.yml
# anthropics/claude-code-action@v1 (GA Aug 26, 2025), Claude Code 2.x
name: Triage new issues
on:
  issues:
    types: [opened]

permissions:
  contents: read
  issues: write          # the agent itself holds the write token

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Read issue #${{ github.event.issue.number }}.
            Apply exactly one label from: bug, enhancement, question, needs-repro.
            If it is a bug report with no reproduction steps, comment asking for one.
          claude_args: |
            --allowedTools "Bash(gh issue view:*),Bash(gh issue edit:*),Bash(gh issue comment:*)"
```

And here is the gh-aw version:

```markdown
---
# .github/workflows/triage.md
# gh-aw v0.91.5, compiled with `gh aw compile triage`
on:
  issues:
    types: [opened]

permissions:
  contents: read
  issues: read           # the agent job never gets a write token

engine: claude           # needs ANTHROPIC_API_KEY as a repo secret

tools:
  github:
    toolsets: [issues]

network: defaults        # egress allowlist enforced by the firewall

timeout-minutes: 10

safe-outputs:
  add-labels:
    allowed: [bug, enhancement, question, needs-repro]
    max: 1
  add-comment:
    max: 1
---

# Triage new issues

Read the issue that triggered this run.

Apply exactly one label from the allowed set. If it is a bug report without
reproduction steps, add one comment asking for a minimal repro. Do not
comment otherwise.
```

At first glance they look equivalent. They are not, and the differences are the whole point of the project.

In the first file, Claude Code runs with `issues: write` in its environment. The `--allowedTools` list narrows what it should call, but the token is there, the network is open, and if a prompt-injected issue body convinces the agent to run `gh issue edit --add-label wontfix` on 40 other issues, the only thing between that and your repo is the agent's own judgment and a tool allowlist that matches on command prefixes.

In the second file, the agent's job literally does not have a write token. It can only *request* "add label `bug`" and "post this comment" through a `safeoutputs` MCP tool. Those requests are written to an artifact. A separate job, which never runs the model, reads the artifact, checks that the label is in `allowed`, that there is at most one of each, and only then calls the GitHub API with `issues: write`. A request for label `wontfix` is rejected by deterministic code, not by a model deciding to behave.

## What `gh aw compile` actually generates

Run the compiler and you get `triage.lock.yml` next to `triage.md`. Both get committed. Actions only ever executes the lock file.

```bash
# gh-aw v0.91.5
gh extension install github/gh-aw
gh aw init --engine claude      # .gitattributes, dispatcher skill; skips Copilot-only artifacts
gh aw compile triage            # writes .github/workflows/triage.lock.yml
gh aw run triage                # dispatch a run and print the run URL
gh aw logs triage               # download and summarize tool calls, network, cost
```

The compiler runs five phases: parse and validate the frontmatter against the schema (including an allowlist of permitted `${{ }}` expressions), build jobs, resolve dependencies, pin every action to a commit SHA, and emit YAML. It also runs `actionlint`, `zizmor` and `poutine` over the result. Per the [compilation process docs](https://github.github.com/gh-aw/reference/compilation-process/), the lock file for a workflow like the one above contains this job graph:

```text
# Job graph emitted into triage.lock.yml (gh-aw v0.91.5)
activation  (contents: read)        sanitize event text, check lock freshness
   -> agent (read-only)             run Claude Code behind the firewall
        -> detection (contents: read)   AI scan of the agent's output
             -> safe_outputs (issues: write)  apply labels + comment
                  -> conclusion           summarize, report failures
```

There is also a `pre_activation` job when you use role checks, `stop-after` deadlines or slash-command triggers.

The reason these are separate jobs and not steps is a GitHub Actions constraint: permissions are per job and fixed for the job's lifetime. You cannot drop `issues: write` halfway through a job. So gh-aw puts the model in a job without it, and the code that writes in a job without a model. The docs call this "plan-level trust", and it is the single most important difference from a hand-written workflow.

### The body is runtime, the frontmatter is compile time

One detail that trips people up: the Markdown body is loaded at runtime, so you can edit the instructions on github.com and the next run picks them up without recompiling. The frontmatter (triggers, permissions, tools, network, safe-outputs) is baked into the lock file. Change any of it and you must run `gh aw compile` again and commit the new lock file. The `activation` job checks that the lock file is not stale relative to the source and fails early if it is.

## The four layers gh-aw adds on top of Actions

Everything in this section is something you *could* build by hand in plain Actions. Nobody does, which is why the project exists.

### 1. Safe outputs instead of write tokens

Safe outputs are the typed write operations the agent is allowed to request: `create-issue`, `add-comment`, `add-labels`, `create-pull-request`, `push-to-pull-request-branch`, `update-issue`, `create-discussion`, `create-code-scanning-alert` and many more. Each has limits you declare in frontmatter. `add-labels` takes `allowed`, `blocked`, `max` (default 5 calls) and `max-labels` (default 10 per call). `create-pull-request` takes `title-prefix`, `labels`, `reviewers` and a `protected-files` policy that falls back to opening a review issue instead of a PR if the agent touched files like workflow definitions.

There is also `staged: true` on outputs, which renders a preview of what would have been written without calling the API. That is the safest way to dry-run a new workflow against real events.

### 2. A network firewall around the agent

The Agent Workflow Firewall (AWF) runs the agent in a container on an internal Docker network whose only exit is a Squid proxy with a domain allowlist. `network: defaults` allows certificate, schema, Ubuntu and common package-mirror domains. You widen it with ecosystem names or domains:

```yaml
# gh-aw v0.91.5
network:
  allowed:
    - defaults
    - node                 # npm registry and friends
    - "api.example.com"
  blocked:
    - "cdn.example.com"    # blocked wins over allowed
```

`network: {}` blocks everything. A plain Actions job has unrestricted egress, so an agent that has been talked into `curl`-ing your source tree to an attacker's server just does it. On eligible GitHub-hosted Ubuntu x86_64 KVM runners, you can go further with `sandbox.agent.runtime: cloud-hypervisor` (preview), which puts the agent in a microVM instead of a container.

MCP servers you configure under `tools:` run in their own containers, started by an MCP gateway, so a rogue MCP server is isolated from the agent's filesystem too.

### 3. Threat detection before anything is written

When any safe output is configured, a `detection` job is enabled automatically. It runs a model over the agent's output looking for prompt injection, leaked secrets and malicious patches. It has its own AI credit budget (`max-ai-credits`, default 400) separate from the main agent run. Two defaults deserve attention: `continue-on-error` is `true`, which means a detection warning produces a caution notice rather than blocking safe outputs, and `report-as-issue` is `true`, which maintains an `[aw] Detection Runs` tracking issue. If you want detection to be a hard gate, set it explicitly:

```yaml
# gh-aw v0.91.5
safe-outputs:
  threat-detection:
    enabled: true
    continue-on-error: false   # fail the run instead of warning
  add-comment:
    max: 1
```

### 4. Compile-time hardening

Every action in the lock file is pinned to a SHA with a version comment, and the pins are recorded in `actions-lock.json` (commit it). Expressions are validated against an allowlist, so you cannot accidentally interpolate `${{ github.event.issue.body }}` into a shell step, which is the classic Actions script-injection bug. The compiler even warns when your prose instructions mention a tool or shell command that your tool configuration denies.

## Triggers that plain Actions does not have

gh-aw accepts every normal `on:` event, plus two conveniences that compile down to standard Actions triggers.

**Fuzzy schedules.** Instead of cron, you write `schedule: daily`, `daily on weekdays`, `weekly on friday around 5pm` or `every 2h`. The compiler picks a deterministic, per-workflow minute so that a repository with 30 daily agents does not fire all of them at `0 0 * * *`. The chosen time stays stable across recompiles.

**Slash commands.** `on: /triage` expands to a `slash_command` trigger plus `workflow_dispatch`, so a maintainer can comment `/triage` on an issue or PR to run the workflow. The `pre_activation` job checks the commenter's role before the agent spends a single token.

```markdown
---
# gh-aw v0.91.5
on: /summarize
permissions:
  contents: read
  pull-requests: read
safe-outputs:
  add-comment:
---

Summarize the pull request this command was issued on in five bullet points.
```

## Engines and who pays

The engine is one frontmatter line. Copilot CLI is the default; `claude`, `codex`, `gemini` and `pi` are the other built-ins. Each authenticates differently:

| `engine:` | Auth | Inference billed to |
| --- | --- | --- |
| `copilot` (default) | `copilot-requests: write` or `COPILOT_GITHUB_TOKEN` | Org Copilot AI credits, or the PAT owner's seat |
| `claude` | `ANTHROPIC_API_KEY` or Anthropic WIF | Your Anthropic account |
| `claude` + `model: copilot/<model>` | `copilot-requests: write` | Org Copilot AI credits |
| `codex` | `CODEX_API_KEY` or `OPENAI_API_KEY` | Your OpenAI account |
| `gemini` | `GEMINI_API_KEY` or Google WIF | Your Google account |

Claude subscription OAuth tokens (`CLAUDE_CODE_OAUTH_TOKEN`) are explicitly not supported, so a Pro or Max plan does not cover gh-aw runs. The Claude engine runs Claude Code headless with permission mode `dontAsk`, so anything not pre-approved is denied rather than prompted. On top of inference you pay normal Actions minutes: the docs estimate 10 to 30 seconds for pre-activation, 1 to 15 minutes for the agent job, and roughly 1.5 minutes of runner setup per job. A five-job pipeline is not free even when the model call is cheap, so put `max-ai-credits` and `timeout-minutes` in every workflow.

If you are on the Copilot engine, the token story is covered in detail in [running agentic workflows without a personal access token](/2026/06/github-agentic-workflows-without-a-personal-access-token/).

## When plain Actions plus an agent action is still the right call

gh-aw is the better default for anything that reacts to untrusted input (issues, PR bodies, comments from outside contributors) and writes back to the repo. That is exactly the prompt-injection surface, and the read-only agent plus deterministic write job closes most of it structurally.

A hand-written workflow with `claude-code-action@v1` or Copilot's coding agent still wins in a few cases:

- **The agent needs to iterate on code with tests.** gh-aw can do this (`create-pull-request` plus build steps), but a PR-review or fix-the-build loop where the agent pushes commits repeatedly is simpler as a normal job, which is what the [Claude Code PR review action setup](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/) does.
- **Only trusted people can trigger it.** If the workflow only runs on `workflow_dispatch` by maintainers or on `push` to `main`, the injection threat model is much smaller and the extra jobs are overhead.
- **You need a GA product.** gh-aw is a technical preview with very frequent releases. Five releases shipped between October 5 and 7, 2026 alone, and releases 0.68.4 through 0.71.3 were retired over a billing bug. Pin the extension version (`gh extension install github/gh-aw@v0.91.5`) and the compiled engine version if you run it in production.
- **You want deterministic logic.** The docs are explicit: builds, tests, deployments and anything where the same input must produce the same steps belong in normal Actions. gh-aw is for investigation, triage, review and generation, and you can mix both in one workflow with `steps:` and `jobs:`.

A useful way to frame the choice is the one from [the difference between an AI agent and an AI workflow](/2026/10/what-is-the-difference-between-an-ai-agent-and-an-ai-workflow/): gh-aw is a fixed workflow with an agent in the middle, where the outer shell (trigger, permissions, allowed writes) is code and only the reasoning step is a model. If your automation is genuinely open-ended, a scheduled routine like the one in [this Claude Code issue-triage setup](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) gives the agent more freedom. If it should be narrow and auditable, gh-aw's frontmatter is a better contract than a prompt.

## Gotchas worth knowing before your first run

- **Commit both files.** The `.md` is the source, the `.lock.yml` is what runs. `gh aw init` adds `.gitattributes` entries for compiled lock files, but they still have to be in the commit.
- **Frontmatter edits need a recompile.** Editing `safe-outputs` on github.com without recompiling is caught by the `activation` job's lock-freshness check, not silently applied.
- **`engine:` as a string only accepts built-ins.** `copilot`, `claude`, `codex`, `gemini`, `pi`. Aider, Cursor, OpenCode, Goose and others exist only as unsupported sample definitions you import with `engine: { id: ... }`.
- **The agent never pushes to your branch itself.** It edits a working tree inside the read-only job; code changes go through `create-pull-request` or `push-to-pull-request-branch`, which turn the agent's working-tree diff into a patch applied by the write job.
- **Detection is advisory by default.** See `continue-on-error` above.
- **`gh aw logs` is your observability.** It caches downloads and summarizes tool calls, blocked network requests and token usage per run. The blocked-domain list is the fastest way to find out why an agent "could not install" a package: it hit the firewall.

The short version for a team deciding today: if an agent in CI reads text a stranger wrote and then writes something back to your repository, write it as a gh-aw Markdown file, not a raw workflow. You get a read-only agent, an egress allowlist and typed, capped writes for the cost of one extra compile step. For trusted, code-heavy loops, a plain Actions job with an agent action is still simpler and GA.

## Related

- [How to automate a repository task with GitHub Agentic Workflows without a personal access token](/2026/06/github-agentic-workflows-without-a-personal-access-token/)
- [What is the difference between an AI agent and an AI workflow](/2026/10/what-is-the-difference-between-an-ai-agent-and-an-ai-workflow/)
- [How to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/)
- [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)
- [Information flow control to block prompt injection in agents](/2026/09/information-flow-control-to-block-prompt-injection-in-agents/)

## Sources

- [GitHub Agentic Workflows: How they work](https://github.github.com/gh-aw/introduction/how-they-work/)
- [Security architecture](https://github.github.com/gh-aw/introduction/architecture/)
- [Compilation process](https://github.github.com/gh-aw/reference/compilation-process/)
- [Safe outputs reference](https://github.github.com/gh-aw/reference/safe-outputs/)
- [Network permissions](https://github.github.com/gh-aw/reference/network/)
- [Threat detection](https://github.github.com/gh-aw/reference/threat-detection/)
- [Schedule syntax](https://github.github.com/gh-aw/reference/schedule-syntax/)
- [Using Claude Code with GitHub Agentic Workflows](https://github.github.com/gh-aw/engines/claude/)
- [Billing](https://github.github.com/gh-aw/reference/billing/)
- [GitHub Agentic Workflows are now in technical preview (GitHub changelog, Feb 13, 2026)](https://github.blog/changelog/2026-02-13-github-agentic-workflows-are-now-in-technical-preview/)
- [github/gh-aw releases](https://github.com/github/gh-aw/releases)
