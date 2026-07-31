---
title: "Copilot Code Review Now Reads Your .github/skills Folder"
description: "Agent skills and MCP servers in GitHub Copilot code review went GA on 2026-07-29. Here is where the files live, why skills load from the head branch, and why every MCP tool call in a review is read-only."
pubDate: 2026-07-31
tags:
  - "github-copilot"
  - "agent-skills"
  - "mcp"
  - "code-review"
  - "ai-agents"
---

On 2026-07-29 GitHub flipped [agent skills and MCP support in Copilot code review](https://github.blog/changelog/2026-07-29-copilot-code-review-agent-skills-and-mcp-now-generally-available/) to generally available for Copilot Pro, Pro+, Business, and Enterprise. Until now the reviewer read your diff and your custom instructions and that was the whole context window. It can now pull in the same skill folders your coding agent uses, plus read-only context from MCP servers.

That closes the most annoying gap in automated review: the bot could tell you a `null` check was missing, but it had no idea your team requires every EF Core migration to ship a non-empty `Down()`, and no way to look up whether the issue this PR closes was already reverted last sprint.

## Skills are folders, and the reviewer picks them itself

A skill is a directory under `.github/skills` with a `SKILL.md` inside. Copilot matches the task against each skill's `description` and loads only what looks relevant, so a review-focused skill wants a directory name and description that read like review work.

```md
---
name: ef-core-migration-review
description: Review EF Core migrations for a non-empty Down(), no data loss on column drops, and an explicit index name. Use when the diff touches Migrations/.
---

## What to flag

- A `Down()` method with only `// no-op` or an empty body. Every migration must be reversible.
- `DropColumn` without a preceding data copy. Comment with the backfill snippet from `references/backfill.md`.
- `CreateIndex` without an explicit `name:` argument.
```

The detail worth knowing: Copilot code review reads instructions and skills from the **head branch**, not the base branch. Edit a skill and open a PR, and that same PR gets reviewed by the edited skill. You can iterate on review rules without merging them first, which is the opposite of how most CI-based lint config behaves.

## MCP is on by default, and read-only by design

MCP servers for review are configured in repository settings under Copilot > MCP servers, using the same JSON the cloud agent consumes. The GitHub and Playwright servers are already enabled.

```json
{
  "mcpServers": {
    "issue-tracker": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer $COPILOT_MCP_TRACKER_TOKEN" },
      "tools": ["search_issues", "get_issue"]
    }
  }
}
```

Tokens go under repository settings > Secrets and variables > Agents, referenced as `$COPILOT_MCP_*`. Every MCP tool call made during a review is limited to read-only, which is the right call: a reviewer that can post to your issue tracker is a reviewer that can be prompt-injected by a pull request body. Note that `"tools": ["*"]` is still accepted, and GitHub's own guidance is to allowlist specific tools instead, because the agent uses them autonomously with no approval step.

If you would rather keep MCP scoped to the cloud agent only, the repository setting "Allow Copilot to use MCP tools when reviewing pull requests" is on by default and can be turned off. Review comments that leaned on a skill or an MCP tool now carry attribution, so you can tell which rule produced which nit.

If your repo still has a `.github/prompts/` folder, this is the push to finish [migrating those prompt files to agent skills](/2026/07/migrate-copilot-prompt-files-to-agent-skills/): the same `SKILL.md` now feeds the IDE, the cloud agent, and the reviewer.
