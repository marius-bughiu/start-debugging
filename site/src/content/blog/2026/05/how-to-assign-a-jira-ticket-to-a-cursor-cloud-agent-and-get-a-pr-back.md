---
title: "How to Assign a Jira Ticket to a Cursor Cloud Agent and Get a PR Back"
description: "Step-by-step guide to the Cursor in Jira integration (launched May 19, 2026): install the Marketplace app, assign a ticket to @Cursor, wire repository access and automation rules, and read the PR the cloud agent links back."
pubDate: 2026-05-27
tags:
  - "cursor"
  - "ai-agents"
  - "jira"
  - "cloud-agents"
  - "automation"
---

On May 19, 2026, Cursor and Atlassian shipped [Cursor in Jira](https://www.atlassian.com/blog/company-news/cursor-in-jira), and the day after, Cursor 3.5 followed with multi-repo and no-repo automations on top of the same plumbing. Together they turn the answer to "can my Jira ticket open a PR by itself?" from "build a webhook" to "install an app and assign it." The flow is now: triage in Jira, assign to `@Cursor`, wait for the linked PR, review. This post walks the full path: install the Marketplace app, wire repository access, assign a single ticket as a smoke test, and then promote the same flow to an automation rule that picks up everything tagged `agent-eligible`.

## TL;DR

Install the Cursor agent from the Atlassian Marketplace, grant it access to the GitHub repository the ticket should land in, and either assign the ticket to `@Cursor` or `@Cursor`-mention in a comment. The cloud agent reads the summary, description, and any Rovo-enriched context from the Teamwork Graph, opens a branch, pushes commits, opens a pull request, and links the PR back to the Jira issue. Cursor 3.5's automation rules let you skip the manual `@Cursor` step entirely by routing tickets that match a JQL filter. The whole loop assumes you are on a paid Jira Cloud plan and that Cursor has GitHub or GitLab access to the target repository.

## Why this was painful before May 2026

The pre-May approach to "Jira ticket to PR" usually meant one of three things. You wrote a Jira webhook that fired on `issue_updated`, parsed the payload, and called the Cursor [Automations webhook trigger](https://cursor.com/docs/cloud-agent/automations) with a hand-rolled prompt built from the ticket fields. Or you wired n8n or Zapier between Jira and Cursor, which got you a UI but left you owning auth, retries, and the prompt template. Or you skipped Cursor entirely and used the [Atlassian MCP server inside the IDE](https://www.atlassian.com/blog/company-news/cursor-in-jira), which works for one developer at a desk but does not run unattended.

Each route worked, but none of them let a non-developer triage a backlog. The Cursor in Jira integration moves the assignment step onto a UI a product manager already uses, and Cursor 3.5's automation rules move the "obvious tickets" out of the queue entirely.

## What gets installed and where

The Cursor agent is an Atlassian Marketplace app. On a paid Jira Cloud subscription, go to Apps -> Explore more apps, search for "Cursor agent", and install it. The install grants Jira-side OAuth scopes (read issues, write comments, read user mentions). It does not grant Cursor any repository access yet, which is the next step and the most common place to get stuck.

Cursor itself authenticates to your code host on its end, through the existing [Cursor cloud agent setup](https://cursor.com/docs/cloud-agent). For GitHub, that means installing the Cursor GitHub App on the org or the specific repository you want the agent to write to. For GitLab, the equivalent OAuth flow. If the cloud agent does not see the repository, it will leave a comment on the Jira issue saying it has no eligible repository, and you will spend ten minutes assuming the integration is broken.

Two things to check before the first assignment:

1. The Cursor GitHub App has read and write access on the repository the agent will commit to. "Read" is enough to plan, "write" is required to push the branch and open the PR.
2. The Jira project has at least one team member who is also a Cursor user on the same paid plan. Assignments fan out under that user's seat for billing.

## A minimal first run, no automation rules

The simplest end-to-end smoke test is a one-line ticket. Create a Jira issue in any project where the Cursor app is enabled, and fill in just two fields:

- Summary: `Add a CONTRIBUTING.md with a one-paragraph intro and a "Running tests" section.`
- Description: `Target repository: github.com/acme/api. Use the existing voice in README.md.`

Now do one of two things to start the agent run.

**Option 1: Assign the work item.** Open the assignee picker on the issue and pick `@Cursor`. The picker treats the agent as a real assignee. As soon as you save, Cursor leaves a comment on the issue saying it is starting work, and a new cloud agent run appears in the Cursor dashboard tied to that issue key.

**Option 2: Mention in a comment.** Leave the assignee unchanged and post a comment that reads `@Cursor please pick this up, the description has everything you need.` This is the right path when the issue already has a human assignee who is supervising. The agent run starts on the comment, not on the issue itself, and the same status updates appear inline.

Both paths produce the same end state, which is the part Atlassian leaned on hardest in the launch post: "When it opens a pull request, it will be automatically linked back to Jira." That linking uses the same Smart Links infrastructure Atlassian already runs for GitHub and Bitbucket, so the PR shows up under Development on the issue's right rail with title, status, and CI state.

## What the agent actually reads

The launch post is worth quoting on this point, because it is the difference between "the agent ignored half my ticket" and "the agent followed it":

> "Use Rovo to enrich your task with context from across Atlassian's Teamwork Graph, then assign to Cursor so it has more context with less manual effort."

Internal Atlassian tests measured "a 44% improvement in answer quality and used 48% fewer tokens" when Rovo enrichment ran first. Concretely, that means the agent does not just see the summary and description fields. It sees:

- The issue's parent epic and any linked tickets (`relates to`, `blocks`).
- Attached design docs in Confluence that Rovo has indexed.
- Comments on the issue, in order.
- The components and labels, which it uses to narrow which directory in the repo to touch.

If you want a higher-quality first pass, run Rovo's "Enrich" action before assigning, or add a comment that points at the relevant Confluence page. If you skip enrichment and your description is two sentences, the agent will pick a reasonable interpretation but it will not be the only reasonable interpretation.

## Wiring repository access for a multi-repo monorepo

If your "Jira project" maps to one Cursor [cloud agent environment](/2026/05/cursor-3-4-multi-repo-cloud-agent-environments/), you are done after the GitHub App install. If the project spans multiple repos, you need to tell Cursor which environment to use per ticket.

The mechanism is the same multi-repo environment definition that shipped in Cursor 3.4. Define an environment that lists every repository the agent might need:

```json
// cursor.environment.json, Cursor 3.4 or later
{
  "name": "acme-jira-default",
  "repositories": [
    { "url": "github.com/acme/api", "branch": "main" },
    { "url": "github.com/acme/shared-types", "branch": "main" }
  ],
  "dockerfile": "./infra/agent.Dockerfile",
  "default_branch_strategy": "feature/jira-{issue_key}"
}
```

The `default_branch_strategy` token is the one that makes the Jira link readable: every PR the agent opens for issue `PROJ-1234` will live on `feature/jira-PROJ-1234`, which is easy to spot in `git branch -a` and easy to filter in the GitHub UI.

To bind that environment to a Jira project, open the Cursor dashboard, go to Integrations -> Jira, and map each Jira project key to one environment. Without that mapping, Cursor picks the first environment that contains a repository it has access to, which is fine for a single-repo team and unpredictable for anyone else.

## Promoting the flow to an automation rule

Manual assignment is the right starting point, but it does not scale. Cursor 3.5 added "Multi-repo & No-repo Automations" precisely so the same trigger can run without a human pressing assign. The Atlassian-side rule lives in Jira's automation engine, not in Cursor.

Create a Jira automation with these three steps:

1. **Trigger**: Issue created OR Issue updated, with a JQL filter such as `project = PROJ AND labels = agent-eligible AND status = "To Do"`.
2. **Condition**: `assignee is empty`. This stops the rule from stealing tickets that a human has already picked up.
3. **Action**: `Assign issue to @Cursor`.

That is the entire rule. There is no second step that calls a webhook, because the assignment itself is the trigger Cursor watches for. The first time a ticket lands with the `agent-eligible` label and an empty assignee, the rule fires, the assignee changes to `@Cursor`, and the cloud agent picks it up.

A practical detail: the JQL filter is where you encode your team's risk tolerance. A safe starting point is to require both a label and a component, so the rule only fires on tickets a human has already curated. Loosen the filter once the agent's PRs are landing without surprises.

## Reading the PR Cursor opens

The PR body the agent opens is templated. It is not magic, and it is worth knowing the shape so reviewers do not skim past the parts that matter. A typical body has four sections:

- **Summary**: One paragraph paraphrasing the Jira description, with the issue key linkified.
- **Plan executed**: A bulleted list of the steps the agent decided on, in order, with the file paths it touched per step.
- **Tests run**: Output of whatever test command the environment's Dockerfile or `cursor.environment.json` defines. If no test command is configured, this section reads "No test command configured", which is your cue to add one.
- **Open questions for the reviewer**: This is the section to actually read. If the agent had to guess about scope, it lists the guesses here, and a one-line comment is enough to either approve the guess or send the agent back to revise.

Two gotchas worth flagging:

The PR's commit messages follow the Conventional Commits format by default. If your repo uses a different style, add a `.cursor/commits.md` file with a short example, and the agent will follow it. There is no flag for this, it is purely convention-by-example.

The PR is opened against the branch listed in your environment's `default_branch` field, not necessarily `main`. If your team uses a `develop` integration branch, set it explicitly on the environment, or the agent will target `main` and you will spend the next twenty minutes rebasing.

## When the agent asks for input

The launch post promised that "When Cursor needs guidance or completes work, it will notify you in Jira." In practice, "needs guidance" maps to one of three states:

1. **Ambiguous scope.** The agent leaves a Jira comment with a numbered list of options and waits. Reply with the number, or with free text. The agent picks up the reply and continues.
2. **Missing repository access.** The agent comments asking which repository to target, and pauses until someone replies with the repository URL or until an admin grants the GitHub App access. This is the failure mode that looks most like the integration is broken, and the fix is always on the GitHub side, not the Jira side.
3. **Test failure on the agent's own branch.** The agent will iterate up to three times on its own to fix the failure, then comment with the failing test output and pause. Read the failure, decide if the test is wrong or the implementation is, and reply accordingly.

The third case is the one that most resembles a real teammate. The agent does not hide failures, but it also does not endlessly retry, which is the right default for a system that bills per token.

## What this does not replace

Cursor in Jira is not a replacement for the [Atlassian MCP server inside the IDE](https://shinzo.ai/blog/how-to-set-up-the-jira-mcp-server-on-cursor). The two solve different problems. The MCP server is for an interactive developer who wants to read Jira issues from their editor and pull ticket context into a Composer session manually. The Marketplace app is for unattended runs that produce PRs without a developer in the loop.

Teams that do parallel work, for example splitting a feature epic across [Cursor 3.3's Build in Parallel subagents](/2026/05/cursor-3-3-build-in-parallel-split-prs/), still want the MCP server installed locally so the human supervisor can read Jira from inside the editor while the cloud agents run in the background. They are complementary, not redundant.

The integration also does not change anything about how Cursor pays for tokens. Each agent run still draws from the assigning user's seat budget on the Pro or Business plan. If you want a separate budget per team or per Jira project, you need separate Cursor organizations, and the Marketplace app needs to be installed once per Jira-Cursor pairing.

## Related on Start Debugging

- [Cursor 3.4 adds multi-repo environments and faster Dockerfile builds for cloud agents](/2026/05/cursor-3-4-multi-repo-cloud-agent-environments/)
- [Cursor 3.3 adds Build in Parallel, Split PRs, and a unified PR review](/2026/05/cursor-3-3-build-in-parallel-split-prs/)
- [Cursor's TypeScript SDK turns coding agents into programmable building blocks](/2026/05/cursor-typescript-sdk-programmatic-coding-agents/)
- [How to write a Claude Code subagent that runs browser tests](/2026/05/how-to-write-a-claude-code-subagent-that-runs-browser-tests/)
- [How to give a Copilot Agent Skill access to your repo conventions](/2026/05/how-to-give-a-copilot-agent-skill-access-to-your-repo-conventions/)

## Sources

- [Introducing Cursor in Jira, Atlassian, May 19, 2026](https://www.atlassian.com/blog/company-news/cursor-in-jira)
- [Cursor Automations docs](https://cursor.com/docs/cloud-agent/automations)
- [Cursor changelog, May 2026 entries](https://cursor.com/changelog)
- [Build agents that run automatically, Cursor blog, March 5, 2026](https://cursor.com/blog/automations)
