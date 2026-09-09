---
title: "How to Run Shared Agentic Work with GitHub Copilot in Slack"
description: "Since August 21, 2026 mentioning @GitHub in Slack starts a Copilot cloud agent session the whole channel can steer. Here is the setup, the Slack Code channel model, why the pull request comes from an app identity instead of you, what the thread context capture actually exposes, and how the two separate billing meters add up."
pubDate: 2026-09-09
template: how-to
tags:
  - "github-copilot"
  - "ai-agents"
  - "agent-automation"
  - "llm"
  - "cost-control"
---

On August 21, 2026 GitHub put the new Copilot experience for Slack into public preview for organizations on Copilot Business and Copilot Enterprise. Mentioning `@GitHub` in a channel, a thread, or a direct message no longer just posts notifications: it starts a Copilot cloud agent session that investigates, plans, edits code in a cloud sandbox, and opens a pull request. The part worth understanding before you turn it on is that a session started in a shared context is genuinely shared. Copilot spins up a dedicated Slack Code channel, anyone in it can redirect or stop the run, and the resulting pull request is authored by the GitHub app identity rather than by the person who typed the prompt. That last detail is what breaks merge automation if you do not plan for it.

This post covers the Slack path specifically, checked against the GitHub docs for cloud agent integrations, the August 21 changelog, and Slack's own Slack Code announcement. The Microsoft Teams integration shipped the same day and behaves almost identically apart from the code channel, so there is a short section on the difference at the end.

## The three switches that have to be on before anything works

Most first attempts fail at setup rather than at prompting, because the feature depends on settings that live in three different places and none of them is on by default for a fresh org.

1. **The Copilot cloud agent policy**, enabled by an organization or enterprise owner. Without it, `@GitHub` will answer questions and triage issues but refuse to start a coding session.
2. **Cloud sandboxes**, enabled for your Copilot plan. This is a separate toggle from the cloud agent policy and a separate billing product. The agent runs its edits and validation inside the sandbox, so a disabled sandbox means no code changes.
3. **The GitHub app for Slack**, installed or upgraded in the workspace, with your personal GitHub account linked to your Slack user.

The app upgrade matters. Workspaces that installed the GitHub Slack app for notifications years ago are running a version that predates the agent scopes. The October 2025 release that first added coding-agent invocation was explicit that it required new permissions and that teams could keep using the older install for notifications, issue triage, and pull request management without upgrading. If `@GitHub` responds to `/github subscribe` but ignores an agent prompt, an unupgraded install is the first thing to check.

Once the app is in place, connect your account and confirm the wiring:

```text
# GitHub app for Slack, public preview as of 2026-08-21
@GitHub help
```

That lists the commands the current install actually exposes, which is a faster answer than reading the docs for a version you may not have.

## Starting a session and the repository the agent assumes

The prompt is natural language with an explicit repository reference. There is no task subcommand:

```text
@GitHub Add "Hello World" to the README in octo-org/octo-repo on the develop branch
```

Copilot replies with a summary of the changes it plans to make plus links to the artifacts it has created, then continues asynchronously in the sandbox and posts back when it is done.

If you leave the repository out, Slack falls back to a channel default. You can set that deliberately:

```text
# Sets the default repo for the current channel
@GitHub settings
```

Pick the repository in the dialog and save. If you never set one, Copilot silently adopts the repository from your first session in that channel as the channel default. That is a convenience that becomes a hazard in a busy channel where two people work on different services, so set it explicitly in any channel that is not single-repo.

Issue creation works from the same mention and understands hierarchy, which makes Slack a reasonable front door for triage even when you do not want code written:

```text
@GitHub In octo-org/octo-repo, create a feature request to add fuzzy matching to search.

@GitHub In octo-org/octo-repo, open separate issues for adding fuzzy matching to search, paginating results, and caching queries.

@GitHub In octo-org/octo-repo, create an epic to redesign search, with child issues for fuzzy matching, pagination, and caching.
```

Issue creation is bounded by your own repository permissions, not the app's.

## Slack Code: the channel is the session

When you ask for actual work, Copilot creates a dedicated code channel. This is Slack Code, a channel type Slack shipped in late August 2026 specifically for agent sessions, with GitHub Copilot as one of the launch partners alongside Anthropic's Claude, Cognition's Devin, and Vercel's agents. It runs on all Slack plans; access to each agent is bought separately, which is why the Copilot side still requires a Business or Enterprise Copilot plan.

The channel is split into views rather than being a flat message log: the discussion, the agent's plan, line-by-line code diffs rendered with the old line struck through next to the new one, and a live preview of the running output for things like HTML artifacts. Anyone in the channel can add context, redirect the approach, or stop the session mid-task. Slack reports that more than 70 percent of code channels open and close within a single day.

Two operational rules follow from this design and both surprise people:

- **One channel holds one task.** You do not queue a second unrelated request into the same code channel. Start a new mention for a new task and you get a new channel.
- **Once a code channel exists, steer the session from inside it.** Replying in the original thread is where the request began, not where the run lives. This is a real behavioural difference from the 2025 integration, where the session had no home of its own and everything happened inline in the thread.

When the run finishes, Slack asks whether to archive the channel. Archived code channels stay viewable and searchable, so the channel doubles as the audit trail for the change. That is genuinely useful when someone asks in three months why a particular refactor happened: the prompt, the plan, the diff, and the human objections are all in one place, which is more than you get from a pull request description written by an agent.

One caveat from hands-on use: inline comments left on a diff inside a code channel feed into the agent's next turn as input, but they are not persisted as durable review comments. If you want a comment to survive, put it on the pull request on GitHub.

## The pull request is not yours, and rulesets notice

This is the part that quietly breaks merge automation. In a direct message, Copilot acts with your personal account's permissions. In a shared context, a group thread or a channel, Copilot creates artifacts including pull requests under **the app's identity**.

The consequence GitHub documents plainly: because these pull requests are not attributed to a person, if the repository already requires at least one approval through a ruleset, one more approval is required before merging. A repository configured for a single review now needs two on Copilot-authored pull requests from Slack. Repository administrators can also deliberately require an additional human approval specifically for any pull request attributed to Copilot, on top of existing review rules.

Check what your target repository requires before you point a channel at it:

```bash
# gh 2.x, GitHub REST API version 2022-11-28
gh api \
  -H "Accept: application/vnd.github+json" \
  /repos/octo-org/octo-repo/rulesets \
  --jq '.[] | {id, name, enforcement}'

# Then inspect the pull_request rule on the ruleset you care about
gh api /repos/octo-org/octo-repo/rulesets/RULESET_ID \
  --jq '.rules[] | select(.type=="pull_request") | .parameters'
```

The field to read is `required_approving_review_count`. If it is `1`, expect Slack-originated pull requests to sit at one-of-two until a second human signs off. If your team runs an auto-merge action keyed on a single approval, it will never fire on these, and the symptom looks like the agent producing dead pull requests rather than a policy doing exactly what it was told.

Two more permission facts worth writing into your runbook:

- Only users with **write** access to a repository can trigger Copilot to make changes. Any conversation participant can add input regardless of access, which is the whole point of the shared model, but they cannot originate the change.
- Guest members and outside collaborators cannot start or steer sessions at all. In workspaces with contractors in shared channels this is the behaviour you want, but it does mean the person who spotted the bug may not be the person who can ask for the fix.

## Everything above the mention becomes context

The security note in GitHub's documentation is short and easy to skim past: when you mention Copilot in a thread, **Copilot cloud agent captures the entire thread as context** for your request. Not the message you wrote, the thread.

In an incident channel that is often exactly right, since the stack traces, the customer report, and the failed deploy link are the context that makes the request answerable. In a thread where somebody pasted a production connection string, a customer's email address, or an unredacted log, it is a data flow you did not intend and did not review. The mitigation GitHub recommends is blunt and correct: send a direct message instead when you want to limit the context.

Treat the mention as the trust boundary. Anything visible in the thread above your `@GitHub` line is input to a model that will then act with write access to a repository, which is the same class of exposure covered in [information-flow control for AI agents](/2026/09/information-flow-control-to-block-prompt-injection-in-agents/). A thread is a channel an attacker can write to. Somebody who can post in a shared incident channel can seed instructions in it, and the agent that reads the thread has no way to tell a colleague's suggestion from a planted one.

## Two meters, and only one of them is the credits you already track

Copilot usage from Slack counts against your existing Copilot entitlements and can be managed with Copilot cloud agent budgets. AI credits are the familiar meter, priced at $0.01 per credit.

The cloud sandbox is billed separately, and this is the line people miss. Per GitHub's billing documentation, sandbox sessions meter on three axes:

| Meter | Rate | What it tracks |
| --- | --- | --- |
| Compute | $0.000024 per compute-second | Wall-clock time the sandbox is running (not metered while stopped) |
| Memory | $0.000003 per GiB-second | Memory **allocated** to the session, not memory in use |
| Storage | $0.005 per GiB-month | Snapshot storage from when a sandbox stops until it is deleted |

A one-hour session with 4 GiB allocated costs about $0.086 of compute plus about $0.043 of memory, so roughly $0.13 before snapshot storage or any AI credits. That is small per run and not small at all when a channel of fifteen engineers discovers it can ask for a fix without leaving Slack.

Sandbox spend falls outside bundled AI credit budgets, so a budget on credits alone does not cap it. Create a separate product-level or SKU-level budget for sandboxes, and set "Stop usage when budget limit is reached" if you want a hard ceiling rather than an alert. The memory meter is the one to watch, since it charges for allocation rather than usage, and the storage meter runs until snapshots are deleted rather than until the session ends. Archiving a Slack code channel is not the same as deleting the sandbox snapshot.

Sessions are capped at 59 minutes of execution, and the agent works on one branch and opens one pull request per task. Those limits are what keep a runaway session from being an open-ended bill, but they also mean a genuinely large refactor is the wrong shape of request for this surface. If you want per-session spend ceilings on the local side of the same product, the [AI credit session limits in the Copilot CLI and SDK](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/) are the closest equivalent control.

## Teams is the same feature without the code channel

The Microsoft Teams integration shipped on the same day with the same identity model: mention `@GitHub`, sessions run in the same cloud sandbox, and pull requests created in a shared context carry the app identity with the same extra-approval consequence under rulesets. Teams is available on all paid Copilot plans, where the Slack preview is scoped to Business and Enterprise.

What Teams does not have is Slack Code. There is no dedicated channel type with plan, diff, and preview views, so the collaborative surface is the thread itself. If the reason you want this is the multiplayer review experience rather than "start a task from chat," Slack is currently the stronger of the two.

## Where this belongs in an existing agent setup

Slack is a task-origination surface, not a replacement for the ones you already have. It is the right entry point when the context that justifies the work is already in a conversation: an incident thread, a customer report, a flaky test somebody just complained about. It is the wrong entry point for anything scripted, because the mention has no equivalent to the [Agent Tasks REST API's dispatch parameters](/2026/06/trigger-github-copilot-coding-agent-task-from-rest-api/), and no model or reasoning picker either. If you care about which model runs the task, you need one of the surfaces that renders a picker, as covered in [setting the reasoning level per task](/2026/08/how-to-set-the-reasoning-level-for-a-github-copilot-cloud-agent-per-task/).

What the agent knows about your repository still comes from the repository, not from Slack. Custom instructions, `AGENTS.md`, and Copilot memory apply exactly as they do everywhere else, and the precedence rules between them are unchanged; see [which one the model actually reads](/2026/09/copilot-memory-vs-repository-custom-instructions-vs-agents-md/). A weak instruction file does not get better because the prompt arrived from a channel.

The honest framing for a rollout: turn it on for one team, point it at one repository, set the channel default repository explicitly, add the sandbox budget before the first session rather than after the first invoice, and check your ruleset approval count so the first Copilot pull request does not sit unmerged while everyone assumes the agent broke. The multiplayer part is the genuinely new idea here. The rest is the cloud agent you already had, reached from a different door.

## Related

- [How to set the reasoning level for a GitHub Copilot cloud agent per task](/2026/08/how-to-set-the-reasoning-level-for-a-github-copilot-cloud-agent-per-task/)
- [How to trigger a GitHub Copilot coding agent task from the Agent Tasks REST API](/2026/06/trigger-github-copilot-coding-agent-task-from-rest-api/)
- [How to set per-session AI credit spend limits in the Copilot CLI and SDK](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/)
- [Copilot memory vs repository custom instructions vs AGENTS.md](/2026/09/copilot-memory-vs-repository-custom-instructions-vs-agents-md/)
- [Cursor cloud agents vs GitHub Copilot coding agent for background PRs](/2026/07/cursor-cloud-agents-vs-github-copilot-coding-agent-for-background-prs/)

## Sources

- [The new GitHub Copilot experience in Slack](https://github.blog/changelog/2026-08-21-the-new-github-copilot-experience-in-slack/), GitHub Changelog, August 21, 2026.
- [Integrating Copilot cloud agent with Slack](https://docs.github.com/en/copilot/how-tos/copilot-integrations/integrate-cloud-agent-with-slack), GitHub Docs.
- [Shared agentic work with GitHub Copilot in Microsoft Teams](https://github.blog/changelog/2026-08-21-shared-agentic-work-with-github-copilot-in-microsoft-teams/), GitHub Changelog, August 21, 2026.
- [Slack Code: Where Your Team and Agents Build Together](https://slack.com/blog/news/slack-code-channels-for-agents), Slack.
- [Billing for cloud and local sandboxes for GitHub Copilot](https://docs.github.com/en/billing/concepts/product-billing/cloud-and-local-sandboxes), GitHub Docs.
- [About GitHub Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent), GitHub Docs.
- [Using GitHub in Slack](https://docs.github.com/en/integrations/how-tos/slack/use-github-in-slack), GitHub Docs.
- [Work with Copilot coding agent in Slack](https://github.blog/changelog/2025-10-28-work-with-copilot-coding-agent-in-slack/), GitHub Changelog, October 28, 2025.
