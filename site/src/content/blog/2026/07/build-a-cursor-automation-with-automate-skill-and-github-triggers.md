---
title: "How to Build a Cursor Automation with the /automate Skill and GitHub Triggers"
description: "Use Cursor 3.8's /automate skill to spin up a cloud agent that fires on GitHub events. Covers the five GitHub triggers added June 18, 2026, tool config, repo scope, and the Max Mode billing gotcha."
pubDate: 2026-07-13
tags:
  - "cursor"
  - "ai-agents"
  - "automation"
  - "github"
---

You can describe an automation in plain English inside a normal Cursor chat and have it wired up to a GitHub event without ever opening a YAML file. The `/automate` skill, which shipped in Cursor 3.8 on June 18, 2026, reads your description, picks a trigger, writes the agent instructions, and enables the tools it needs. Point it at one of the five GitHub triggers added in the same release ("PR review submitted", "Workflow run completed", "Issue comment", "PR review comment", "Review thread updated") and you get a cloud agent that wakes up on that event, does the work, and posts back. This walks through building one end to end, then covers the config that the skill hides from you and the one billing detail that surprises people.

## Why an in-editor skill beats the dashboard for this

Cursor Automations have existed for a while: always-on cloud agents that run on a schedule or in response to events from GitHub, GitLab, Bitbucket, Slack, Linear, Sentry, PagerDuty, or a raw webhook. You could always build one at `cursor.com/automations` or from the Agents Window by clicking through a five-step form: pick a trigger, write a prompt, toggle tools, choose repository scope, save.

The friction was context switching. You are in the middle of a task, you notice "every time CI fails on this repo, someone has to read the log and guess the cause", and to act on that thought you had to leave your editor, open a web form, and reconstruct the intent from scratch. The `/automate` skill removes that round trip. You stay in the agent session you are already in and say what you want. Cursor configures the automation's triggers, instructions, and tools for you. It is the same underlying automation object, created from where the idea actually occurs.

This mirrors the broader pattern of moving agent configuration into the editor rather than a settings page, the same instinct behind [Cursor 3.9 bundling your agent setup into portable plugins](/2026/06/cursor-3-9-plugins-bundle-skills-rules-mcps-hooks/).

## The scenario: triage a red CI run automatically

Here is a concrete, high-value automation that only became possible with the June triggers. When a GitHub Actions workflow run finishes on a pull request and it failed, a cloud agent reads the failing job's logs, reproduces the likely cause against the PR's code, and leaves a review comment with a diagnosis and a suggested fix. No human has to open the Actions tab.

The trigger you want is **Workflow run completed**, which fires "when a GitHub Actions workflow run finishes on a pull request or branch". Before 3.8 there was no CI-completion trigger at all, so this class of automation was not buildable inside Cursor.

## Invoking /automate

Open any agent chat in Cursor and call the skill by describing the outcome, not the plumbing:

```text
# Cursor 3.8, /automate skill, June 18 2026
/automate When a GitHub Actions workflow run finishes on a pull request
in this repo and it failed, read the failing job logs, find the root cause
in the diff, and post a PR review comment with the diagnosis and a fix.
```

Cursor turns that sentence into a configured automation. It selects the **Workflow run completed** GitHub trigger, drafts the agent instructions from your description, and enables the tools the task implies, in this case PR commenting and the repository scope for the repo you are in. You get a chance to review the generated configuration before it goes live, which matters because the skill is inferring your intent, not reading your mind.

The prompt you write is doing double duty. It is both the natural-language spec that `/automate` parses to choose triggers and tools, and the standing instruction set the cloud agent will follow on every run. Treat it like a small CLAUDE.md for that one job: be explicit about what to skip, what counts as done, and where to post. If you have written repo guidance before, the same discipline applies, and it is worth reading [how to write instructions that actually change model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) before you lean on a one-line description.

## The five GitHub triggers, and what each one is for

The 3.8 release added five GitHub-specific triggers on top of the core source-control set ("Draft opened", "Pull request opened", "Pull request pushed", "Pull request merged", "Push to branch", "Comment added"). The new ones are where the interesting event-driven workflows live:

- **Issue comment** fires "when a comment is made on a non-PR issue". Use it to build a `/fix` or `/investigate` command in your issue tracker: a maintainer comments, the agent picks up the thread and opens a draft PR.
- **PR review comment** fires "when an inline comment is left on a pull request diff". This is the one for "the reviewer left an inline nit, have the agent apply it and push" loops.
- **PR review submitted** fires "when a PR review is submitted". Good for gating: on an approving review, run a final security pass; on a requested-changes review, summarize the asks into a checklist.
- **Review thread updated** fires "when a review thread on a pull request is marked resolved or unresolved". Useful for keeping a status comment or a Slack message in sync with how many threads are still open.
- **Workflow run completed** fires "when a GitHub Actions workflow run finishes on a pull request or branch", the trigger from the scenario above.

Because the agent runs in the cloud with its own checkout, an inline-comment automation can actually apply the change and push a commit, not just reply. That is the difference between a bot that acknowledges feedback and one that resolves it. If you have wired up cross-tool workflows before, this slots in next to [assigning a Jira ticket to a Cursor cloud agent and getting a PR back](/2026/05/how-to-assign-a-jira-ticket-to-a-cursor-cloud-agent-and-get-a-pr-back/): same cloud-agent execution model, different entry point.

## The config /automate fills in for you

Even though the skill writes the configuration, you should know what it is setting so you can correct it. Every automation has four other knobs beyond the trigger and prompt.

**Tools.** Automations expose a fixed menu of capabilities you toggle per job. Pull request creation is enabled by default. The rest you opt into: PR commenting and reviews, requesting reviewers, sending Slack messages, reading Slack channels, and connecting MCP servers so the agent can reach your own systems. There is also a persistent memory tool, written to a `MEMORIES.md` the agent maintains across runs, so a triage bot gradually learns which failures are known-flaky. For the CI-triage scenario, you want PR commenting on and PR creation off, since it should comment, not open a competing PR.

**Repository scope.** Three options: **No repository** (for pure Slack or notification jobs that never touch code), **Single repository**, or a **Multi-repo environment** for automations that span services. The `/automate` skill defaults to the repo you invoked it from, which is usually right but worth confirming for anything cross-cutting.

**Model.** Automations always run as cloud agents in **Max Mode**, and you pick which model backs them. This is the same execution surface as an interactive cloud agent, so the observability tooling carries over: you can trace what the automation's agent actually did with [Cursor cloud agent hooks](/2026/07/observe-cursor-cloud-agent-prompts-thinking-subagents-with-hooks/) like `beforeSubmitPrompt` and `afterAgentResponse`.

**Permissions.** An automation is **Private**, **Team Visible**, or **Team Owned**. This is not just visibility, it decides billing attribution: team-owned automations bill to the shared team pool, while private and team-visible ones bill to whoever created them. On a team, a shared CI-triage bot should be Team Owned so it does not quietly drain one person's usage.

## When the trigger is time, not an event

Not every automation is event-driven. If you want the same agent to sweep open PRs every morning instead of reacting to CI, switch the trigger to a schedule. Cursor supports preset intervals and custom cron expressions:

```text
# Standard 5-field cron: minute hour day-of-month month day-of-week
# Weekdays at 09:00 in the automation's configured timezone
0 9 * * 1-5
```

Scheduled runs respect their start time but can be delayed under load, so do not build anything that assumes second-level precision. For a schedule-first, GitHub-adjacent job like issue triage, the design tradeoffs are close to what a cron'd agent looks like in another tool, covered in [scheduling a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/).

## Gotchas worth knowing before you ship one

**Max Mode billing is the big one.** Every automation runs as a cloud agent in Max Mode and is billed on cloud-agent usage. A chatty trigger, say **PR review comment** on a busy repo, can fire dozens of times a day, each a full Max Mode run. Scope the trigger tightly (branch filters, "failed only" logic in the prompt) and prefer Team Owned billing so the cost lands in the right pocket.

**Automations are not version-controlled.** Unlike a GitHub Actions workflow that lives in `.github/workflows` and travels with the repo, a Cursor automation is an account or team object managed in the dashboard and the Agents Window. There is no file in your tree to review in a PR. If auditability matters, document each automation's prompt somewhere in-repo by hand. This is the main structural difference from a token-free GitHub-native approach like [GitHub Agentic Workflows](/2026/06/github-agentic-workflows-without-a-personal-access-token/), where the workflow definition is a committed file.

**The prompt is the whole spec.** `/automate` infers triggers and tools from your sentence, so a vague description produces a vaguely scoped automation. If it picks the wrong trigger or over-enables tools, edit the generated config rather than re-describing. Say what "done" means and what to ignore, the same way you would tune any standing agent instruction.

**Computer use is on by default.** In 3.8, cloud agents kicked off by automations can use their own computer to produce demos or artifacts, and the tool is enabled by default. You do not have to use it, but be aware it is available, since asking the agent to "attach a screenshot of the passing build" will actually work.

**Event triggers need the integration connected.** The GitHub triggers only fire if your GitHub integration is authorized for the repo. A silent no-fire is almost always a missing or under-scoped connection, not a bug in the automation.

Once one automation is running well, the pattern compounds: a triage bot on CI failures, a nit-applier on review comments, a nightly PR sweep, each a single `/automate` sentence. For the heavier "agent as a library you call from code" version of this, Cursor's [TypeScript SDK turns the coding agent into something you script directly](/2026/05/cursor-typescript-sdk-programmatic-coding-agents/), which is the right tool when you have outgrown declarative triggers.

Sources: [Cursor Automations docs](https://cursor.com/docs/cloud-agent/automations), [Improvements to Cursor Automations (June 18, 2026 changelog)](https://cursor.com/changelog/06-18-26), and the [Cursor Automations announcement](https://cursor.com/blog/automations).
