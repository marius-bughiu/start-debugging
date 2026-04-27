---
title: "How to Schedule a Recurring Claude Code Task That Triages GitHub Issues"
description: "Three ways to put Claude Code on a schedule that triages GitHub issues unattended in 2026: cloud Routines (the new /schedule), the claude-code-action v1 with cron + issues.opened, and the session-scoped /loop. Includes a runnable Routine prompt, a complete GitHub Actions YAML, jitter and identity gotchas, and when to pick which."
pubDate: 2026-04-27
tags:
  - "claude-code"
  - "ai-agents"
  - "github-actions"
  - "automation"
  - "anthropic-sdk"
---

A scheduled triage pass over a GitHub backlog is one of the most useful things you can ask a coding agent to do, and it is also the easiest to get wrong. As of April 2026 there are three different "schedule a Claude Code task" primitives, they live in different runtimes, and they have very different failure modes. This post walks through all three for the same job, "every weekday morning at 8am, label and route every new issue in my repo," using **Claude Code v2.1.x**, the **`anthropics/claude-code-action@v1`** GitHub Action, and the **routines research preview** that Anthropic shipped on [April 14, 2026](https://claude.com/blog/introducing-routines-in-claude-code). The model is `claude-sonnet-4-6` for the triage prompt and `claude-opus-4-7` for the dedupe pass.

The short answer: use a **cloud Routine** with both a schedule trigger and a GitHub `issues.opened` trigger if your account has Claude Code on the web enabled. Fall back to a **GitHub Actions schedule + workflow_dispatch + issues.opened** workflow if you need it on Bedrock, Vertex, or your own runners. Use **`/loop`** only for ad-hoc polling while a session is open, never for unattended triage.

## Why the three options exist, and which to pick

Anthropic deliberately ships three different schedulers because the tradeoffs are real. The official [scheduling docs](https://code.claude.com/docs/en/scheduled-tasks) put them on one page:

| Capability                  | Routines (cloud)         | GitHub Actions          | `/loop` (session)         |
| :-------------------------- | :----------------------- | :---------------------- | :------------------------ |
| Where it runs               | Anthropic infrastructure | GitHub-hosted runner    | Your terminal             |
| Survives a closed laptop    | Yes                      | Yes                     | No                        |
| Triggered by `issue.opened` | Yes (native)             | Yes (workflow event)    | No                        |
| Local file access           | No (fresh clone)         | Yes (checkout)          | Yes (current cwd)         |
| Minimum interval            | 1 hour                   | 5 minutes (cron quirk)  | 1 minute                  |
| Auto-expires                | No                       | No                      | 7 days                    |
| Permission prompts          | None (autonomous)        | None (`claude_args`)    | Inherited from session    |
| Plan requirement            | Pro / Max / Team / Ent.  | Any plan with API key   | Local CLI                 |

For "triage every new issue and run a daily sweep," the cloud routine is the right primitive. It has a native GitHub trigger so you do not have to wire up `actions/checkout`, the prompt is editable from the web UI without a PR, and the runs do not consume any of your GitHub Actions minutes. The only reason to skip it is if your org runs Claude through AWS Bedrock or Google Vertex AI, in which case the cloud routines are not yet available and you fall back to the action.

## The triage routine, end to end

A routine is "a saved Claude Code configuration: a prompt, one or more repositories, and a set of connectors, packaged once and run automatically." Every run is an autonomous Claude Code cloud session, with no permission prompts, that clones your repo from the default branch and writes any code changes to a `claude/`-prefixed branch by default.

Create one from inside any Claude Code session:

```text
# Claude Code 2.1.x
/schedule weekdays at 8am triage new GitHub issues in marius-bughiu/start-debugging
```

`/schedule` walks you through the same form the [web UI at claude.ai/code/routines](https://claude.ai/code/routines) shows: name, prompt, repositories, environment, connectors, and triggers. Everything you set on the CLI is editable on the web, and the same routine shows up on Desktop, web, and CLI immediately. One important constraint: `/schedule` only attaches **schedule** triggers. To add the `issues.opened` GitHub trigger that makes triage near-instant, edit the routine on the web after creation.

### The prompt

A routine runs with no human in the loop, so the prompt has to be self-contained. The Anthropic team's own example phrasing in the [routines docs](https://code.claude.com/docs/en/web-scheduled-tasks) is "applies labels, assigns owners based on the area of code referenced, and posts a summary to Slack so the team starts the day with a groomed queue." Concretely:

```markdown
# Routine prompt: daily-issue-triage
# Model: claude-sonnet-4-6
# Repos: marius-bughiu/start-debugging

You are the issue triage bot for this repository. Every run, do the following.

1. List every issue opened or updated since the last successful run of this
   routine, using `gh issue list --search "updated:>=YYYY-MM-DD"` with the
   timestamp of the previous run from the routine's session history. If you
   cannot find a previous run, scope to the last 24 hours.

2. For each issue, classify it as exactly one of: bug, feature, docs,
   question, support, spam. Apply that label with `gh issue edit`.

3. Assess priority as one of: p0, p1, p2, p3. Apply that label too.
   p0 only when the issue describes a production-affecting regression
   with a reproducer.

4. Look up the touched code area. Use `gh search code --repo` and `rg`
   against the cloned working copy to find the most likely owner via
   the `CODEOWNERS` file. Assign that user. If there is no CODEOWNERS
   match, leave it unassigned and apply the `needs-triage` label.

5. Run a duplicate check. Use `gh issue list --search "<title keywords>
   in:title is:open"` to find similar open issues. If you find one with
   high confidence, post a comment on the new issue: "This looks like
   a duplicate of #N. Closing in favor of that thread; please reopen
   if I got it wrong." and then `gh issue close`.

6. Post a single Slack message to #engineering-triage via the connector
   summarizing what you did: counts per label, p0 issues by number, and
   any issue that you could not classify with confidence above 0.7.

Do not push any commits. Do not modify code. The only writes this routine
performs are GitHub label/assign/comment/close calls and one Slack message.
```

Two non-obvious details worth pinning down:

- **The "previous run timestamp" trick.** Routines are stateless across runs. Every session is a fresh clone. To avoid double-labeling the same issue twice, the prompt has to derive the cutoff from somewhere durable. Either (a) use the routine's GitHub identity to apply a `triaged-YYYY-MM-DD` label and skip anything with that label, or (b) read the timestamp out of the previous Slack summary message via the connector. Both are reliable. Asking the model to "remember when you last ran" is not.
- **The autonomous-mode rules.** Routines run with no permission prompts. The session can run shell commands, use any tool from any included connector, and call `gh`. Treat the prompt the way you would treat a service account's policy: spell out exactly what writes are allowed.

### The triggers

In the routine's edit form, attach two triggers:

1. **Schedule, weekdays at 08:00.** Times are in your local zone and converted to UTC server-side, so a US-Pacific schedule and a CET schedule both fire at the same wall-clock time wherever the cloud session lands. Routines add a deterministic stagger of up to a few minutes per account, so do not set the schedule to `0 8` if exact timing matters, set it to `:03` or `:07`.
2. **GitHub event, `issues.opened`.** This makes the routine fire within seconds of every new issue, in addition to the 8am sweep. The two are not redundant: the schedule trigger catches everything that lands while the GitHub App is paused or behind on the per-account hourly cap, and the event trigger keeps fresh issues from sitting cold for a workday.

To attach the `issues.opened` trigger, the [Claude GitHub App](https://github.com/apps/claude) has to be installed on the repository. `/web-setup` from the CLI grants clone access only and does not enable webhook delivery, so installing the app from the web UI is required.

### The custom cron expression

The schedule presets are hourly, daily, weekdays, and weekly. For anything else, pick the closest preset in the form, then drop into the CLI:

```text
/schedule update
```

Walk through the prompts to the schedule section and supply a custom 5-field cron expression. The only hard rule is that the **minimum interval is one hour**; an expression like `*/15 * * * *` is rejected at save time. If you genuinely need a tighter cadence, that is a signal you want the GitHub Actions path or the event trigger, not the schedule trigger.

## The GitHub Actions fallback

If your team is on Bedrock or Vertex, or you simply prefer the audit trail of an Actions run log, the same job runs as a workflow with `claude-code-action@v1`. The action went GA on August 26, 2025 and the v1 surface is unified around two inputs: a `prompt` and a `claude_args` string that passes any flag straight through to the Claude Code CLI. The full upgrade table from the beta surface lives in the [GitHub Actions docs](https://code.claude.com/docs/en/github-actions#breaking-changes-reference).

```yaml
# .github/workflows/issue-triage.yml
# claude-code-action v1, claude-sonnet-4-6, schedule + issues.opened + manual
name: Issue triage

on:
  schedule:
    - cron: "3 8 * * 1-5"  # weekdays 08:03 UTC, off the :00 boundary
  issues:
    types: [opened]
  workflow_dispatch:        # manual run from the Actions tab

permissions:
  contents: read
  issues: write
  pull-requests: read
  id-token: write

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
            REPO: ${{ github.repository }}
            EVENT: ${{ github.event_name }}
            ISSUE: ${{ github.event.issue.number }}

            On a schedule run, list open issues updated in the last 24 hours
            and triage each one. On an `issues.opened` event, triage only
            the single issue ${{ github.event.issue.number }}.

            For each issue:
            1. Classify as bug / feature / docs / question / support / spam.
            2. Assess priority p0 / p1 / p2 / p3.
            3. Apply both labels with `gh issue edit`.
            4. Resolve the touched area via CODEOWNERS and assign the owner,
               or apply `needs-triage` if no match.
            5. Search for duplicates by title keywords. Comment and close
               only if confidence is high.

            Do not edit code. Do not push. Only GitHub label / assign /
            comment / close calls are allowed.
          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 12
            --allowedTools "Bash(gh:*),Read,Grep"
```

Three things this workflow gets right that a hand-rolled cron does not. **`workflow_dispatch`** alongside `schedule` puts a "Run workflow" button in the Actions tab so you can test without waiting for 8am. **`--allowedTools "Bash(gh:*),Read,Grep"`** uses the same gating as the local CLI; without it, the action would have `Edit` and `Write` access too. **The `:03` minute** sidesteps the wide non-deterministic delay GitHub Actions adds to free-tier cron triggers during peak hours. This is essentially the [issue triage example](https://github.com/anthropics/claude-code-action/blob/main/docs/solutions.md) from the action's solutions guide, with a schedule trigger and a tighter tool allowlist.

## When `/loop` is the right primitive

`/loop` is the third option and it is the one to reach for the **least** for triage work. The [scheduled-tasks docs](https://code.claude.com/docs/en/scheduled-tasks) spell out the constraints:

- Tasks fire only while Claude Code is running and idle. Closing the terminal stops them.
- Recurring tasks expire 7 days after creation.
- A session can hold up to 50 scheduled tasks at once.
- Cron is honored at one-minute granularity, with up to 10% jitter capped at 15 minutes.

The right use for `/loop` is to babysit a triage routine you are still tuning, not to run the triage itself. Inside an open session pointed at the repo:

```text
/loop 30m check the last 5 runs of the daily-issue-triage routine on
claude.ai/code/routines and tell me which ones produced label edits
that look wrong. Skip silently if nothing has changed.
```

Claude converts `30m` to a cron expression, schedules the prompt under a generated 8-character ID, and re-fires it between your turns until you press `Esc` or seven days elapse. That is genuinely useful for a "is the routine drifting?" feedback loop while a human stays at the keyboard. It is the wrong shape for "run forever, unattended."

## Gotchas worth knowing before the first run

A few things will bite you on the first scheduled run if you do not plan for them.

**Identity.** Routines belong to your individual claude.ai account, and anything the routine does through your connected GitHub identity appears as you. For an open-source repo, install the routine under a dedicated bot account, or use the GitHub Actions path with a separate [Claude GitHub App](https://github.com/anthropics/claude-code-action) bot install.

**Daily run cap.** Routines have a per-plan daily cap (Pro 5, Max 15, Team and Enterprise 25). Each `issues.opened` event is one run, so a repo that gets 30 issues a day caps out before lunch unless you enable extra usage in billing. The schedule-only routine and the GitHub Actions path both sidestep this; the latter bills against API tokens instead.

**Branch-push safety.** A routine can only push to `claude/`-prefixed branches by default. The triage prompt above does not push at all, but extending it to open a fix PR means either accepting the prefix or enabling **Allow unrestricted branch pushes** per repo. Do not flip that switch absent-mindedly.

**The `experimental-cc-routine-2026-04-01` beta header.** The `/fire` endpoint that backs the API trigger ships under that header today. Anthropic keeps the two most recent dated versions working when they break, so build the header into a constant and rotate at version flips, not into every webhook.

**Stagger and no catch-up.** Both runtimes add a deterministic offset (up to 10% of period for routines, much wider for free-tier Actions during peak), and neither replays missed fires. The `schedule + issues.opened` combo handles the catch-up gap better than schedule alone because the event trigger covers the dead zone.

## Related reading

- The full Claude Code release that opened up `--from-pr` to GitLab and Bitbucket pairs nicely with cloud routines: see [Claude Code 2.1.119: PRs from GitLab, Bitbucket, and GHE](/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/).
- If you want the routine to read from a `.NET` business system as it triages, expose it through MCP first. The walkthrough is in [How to build a custom MCP server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/).
- For the GitHub-Copilot-shaped equivalent, the agent-skills version is in [Visual Studio 2026 Copilot agent skills](/2026/04/visual-studio-2026-copilot-agent-skills/).
- For C# devs building agent runners on the Microsoft side rather than the Anthropic side, [Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) is the production-ready entry point.
- And on bring-your-own-key economics if you would rather pay for tokens against a different model, see [GitHub Copilot in VS Code with BYOK Anthropic, Ollama, and Foundry Local](/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

Routines are still in research preview, so the exact UI and the `/fire` beta header will move. The model that any of this targets, though, is stable: a self-contained prompt, scoped tool access, deterministic triggers, and an audit trail per run. That is the part to design carefully. The runtime is the part you can swap.
