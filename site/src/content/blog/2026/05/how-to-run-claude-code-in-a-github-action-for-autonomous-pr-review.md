---
title: "How to Run Claude Code in a GitHub Action for Autonomous PR Review"
description: "Wire up anthropics/claude-code-action@v1 so every pull request gets an autonomous Claude Code review with no @claude trigger. Includes the v1 YAML, claude_args for claude-sonnet-4-6 vs claude-opus-4-7, inline-comment tooling, path filters, REVIEW.md, and the choice between the self-hosted action and the managed Code Review research preview."
pubDate: 2026-05-01
tags:
  - "claude-code"
  - "ai-agents"
  - "github-actions"
  - "automation"
  - "anthropic-sdk"
---

A pull request opens, GitHub Actions wakes up, Claude Code reads the diff in the context of the rest of the repo, posts inline comments on the lines it does not like, and writes a summary. No human typed `@claude`. That is the workflow this post wires up end to end with `anthropics/claude-code-action@v1` (the GA version released August 26, 2025), `claude-sonnet-4-6` for the review pass, and an optional `claude-opus-4-7` upgrade for security-sensitive paths. As of May 2026 there are two ways to do this and they are not interchangeable, so the post starts with the choice and then walks the self-hosted Action path that works for every plan.

The short answer: use `anthropics/claude-code-action@v1` triggered on `pull_request: [opened, synchronize]` with a prompt and `--allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"`. Skip `@claude` mention gating. If your org has a Team or Enterprise plan and does not run Zero Data Retention, the [managed Code Review research preview](https://code.claude.com/docs/en/code-review) is the lower-friction alternative for the same job.

## Two primitives, two cost models, one decision

Anthropic ships two separate "Claude reviews your PR" products in 2026. They look similar from the outside and behave very differently:

| Capability                       | claude-code-action@v1                   | Managed Code Review (preview)              |
| :------------------------------- | :-------------------------------------- | :----------------------------------------- |
| Where it runs                    | Your GitHub Actions runners             | Anthropic infrastructure                   |
| What you wire up                 | A workflow YAML in `.github/workflows/` | Toggle in `claude.ai/admin-settings`       |
| Trigger surface                  | Any GitHub event you can write          | Per-repo dropdown: opened, every push, manual |
| Model                            | `--model claude-sonnet-4-6` or any ID   | Multi-agent fleet, model not user-selectable |
| Inline comments on diff lines    | Via the `mcp__github_inline_comment` MCP server | Native, with severity markers              |
| Cost                             | API tokens plus your Actions minutes    | $15-25 per review, billed as extra usage   |
| Plan requirement                 | Any plan with an API key                | Team or Enterprise, non-ZDR only           |
| Available on Bedrock / Vertex    | Yes (`use_bedrock: true`, `use_vertex: true`) | No                                       |
| Custom prompt                    | Free text in the `prompt` input         | `CLAUDE.md` plus `REVIEW.md`               |

The managed product is the right answer when it is available to you. It runs a fleet of specialized agents in parallel and runs a verification step before posting a finding, which keeps false positives down. The trade is that you cannot pin a model, and pricing scales with PR size in a way that one $25 review on a 2000-line refactor can shock a manager who expected token-rate billing.

The Action is the right answer when you want full control of the prompt, want to use Bedrock or Vertex for data residency, want to gate on path filters or branch names, or are not on a Team or Enterprise plan. Everything below is the Action path.

## The minimum viable autonomous review workflow

Start in any repo where you are an admin. From a terminal with [Claude Code 2.x](https://code.claude.com/docs/en/setup) installed:

```text
# Claude Code 2.x
claude
/install-github-app
```

The slash command walks you through installing the [Claude GitHub App](https://github.com/apps/claude) on the repo and storing `ANTHROPIC_API_KEY` as a repo secret. It only works for direct Anthropic API users. For Bedrock or Vertex you wire OIDC by hand, which the [GitHub Actions docs](https://code.claude.com/docs/en/github-actions) cover under "Using with AWS Bedrock & Google Vertex AI."

Drop this into `.github/workflows/claude-review.yml`:

```yaml
# claude-code-action v1 (GA Aug 26, 2025), Claude Code 2.x
name: Claude Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 1

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            REPO: ${{ github.repository }}
            PR NUMBER: ${{ github.event.pull_request.number }}

            Review the diff for correctness, security, and obvious bugs.
            Focus on logic errors, unhandled error paths, missing input
            validation, and tests that do not actually exercise the new
            behavior. Skip style nits. Post inline comments on the lines
            you have something concrete to say about, then a one-paragraph
            summary as a top-level PR comment.

          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 8
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

That is the whole thing. No `@claude` trigger gating, no `if:` conditional on comment body, no `mode: agent`. The Action's [v1 release](https://code.claude.com/docs/en/github-actions) auto-detects automation mode whenever you provide a `prompt` input on a non-comment event, so you do not write the conditional yourself anymore. The `permissions` block grants exactly what the prompt needs: read the repo, write PR comments, and (for OIDC against cloud providers) mint an ID token.

A few things in this YAML matter and are easy to get wrong.

`actions/checkout@v6` with `fetch-depth: 1`. The Action reads the diff from the PR via `gh`, but the prompt also lets it open files in the working directory to verify a finding before posting. Without checkout, every "look at the surrounding code" turn fails and Claude either guesses or times out.

`--allowedTools "mcp__github_inline_comment__create_inline_comment,..."`. The Action ships an MCP server that wraps GitHub's review API. Without this allowlist, Claude has no way to attach a comment to a specific line. It will fall back to one big top-level PR comment, which is half the value. The `Bash(gh pr ...)` entries are scoped to read the diff and post the summary comment.

`--max-turns 8`. Conversation budget. Eight is enough for the model to read the diff, open three or four files for context, and post comments. Bumping it higher is rarely the win it looks like; if reviews are timing out, narrow the path filter or switch the model, do not spend more turns.

## v1 broke a lot of beta workflows

If you are coming from `claude-code-action@beta`, your old YAML does not run. The v1 [breaking changes table](https://code.claude.com/docs/en/github-actions#breaking-changes-reference) is the migration cheat sheet:

| Beta input            | v1 equivalent                          |
| :-------------------- | :------------------------------------- |
| `mode: tag` / `agent` | Removed, auto-detected from the event  |
| `direct_prompt`       | `prompt`                               |
| `override_prompt`     | `prompt` with GitHub variables         |
| `custom_instructions` | `claude_args: --append-system-prompt`  |
| `max_turns: "10"`     | `claude_args: --max-turns 10`          |
| `model: ...`          | `claude_args: --model ...`             |
| `allowed_tools: ...`  | `claude_args: --allowedTools ...`      |
| `claude_env: ...`     | `settings` JSON format                 |

The pattern is clear: every CLI-shaped setting collapsed into `claude_args`, and everything that used to disambiguate "is this the comment-trigger flow or the automation flow" got removed because v1 figures it out from the event. The migration is mechanical, but the order matters. If you leave `mode: tag` in place, v1 fails closed with a config error rather than silently running the wrong path.

## Picking the model: Sonnet 4.6 is the default for a reason

The Action defaults to `claude-sonnet-4-6` when `--model` is not set, and that is the right default for PR review. Sonnet 4.6 is faster, cheaper per token, and well-calibrated for the "scan a diff, find the obvious bugs" loop that PR review actually is. Opus 4.7 is the upgrade you reach for when the diff touches authentication, encryption, payment flows, or anything where a missed bug costs more than a $5 review.

The cleanest pattern is two workflows. Sonnet 4.6 on every PR, Opus 4.7 only when the path filter says it is worth the spend:

```yaml
# Opus 4.7 review for security-critical paths only
on:
  pull_request:
    types: [opened, synchronize]
    paths:
      - "src/auth/**"
      - "src/billing/**"
      - "src/api/middleware/**"

jobs:
  review-opus:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 1 }

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Treat this diff as security-sensitive. Flag any changes to
            authentication, session handling, secret storage, or trust
            boundaries. Cite a file:line for every claim about behavior,
            do not infer from naming.
          claude_args: |
            --model claude-opus-4-7
            --max-turns 12
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr diff:*),Bash(gh pr view:*),Bash(gh pr comment:*)"
```

The same trick works in reverse: gate the Sonnet workflow on `paths-ignore: ["docs/**", "*.md", "src/gen/**"]` so docs-only PRs do not eat tokens.

## Adding inline comments and progress tracking

The MCP server `mcp__github_inline_comment__create_inline_comment` is the piece that takes Claude from "writes a long PR comment" to "lands suggestions on specific diff lines." It is allowlisted via `--allowedTools` and that is all the wiring needed. The model decides when to call it.

For larger reviews where you want a visible signal that the run is alive, the Action ships a `track_progress` input. Set `track_progress: true` and the Action posts a tracking comment with checkboxes, ticks them off as Claude completes each part of the review, and marks done at the end. The full pattern from the [official `pr-review-comprehensive.yml` example](https://github.com/anthropics/claude-code-action/tree/main/examples) is:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    track_progress: true
    prompt: |
      REPO: ${{ github.repository }}
      PR NUMBER: ${{ github.event.pull_request.number }}

      Comprehensive review covering: code quality, security, performance,
      test coverage, documentation. Inline comments for specific issues,
      one top-level summary at the end.
    claude_args: |
      --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*)"
```

`track_progress` is the closest thing v1 has to the old beta `mode: agent` UX, and it is the right choice when reviews routinely take more than a minute or two and the PR author wants to know it is running.

## Calibrating what the reviewer flags

A workflow that comments on every variable name and every missing comma will be muted within a week. Two files in the repo root govern what the model takes seriously: `CLAUDE.md` for general behavior, and (for the managed Code Review preview only) `REVIEW.md` for review-specific rules. The Action does not auto-load `REVIEW.md`, but it reads `CLAUDE.md` the same way a local Claude Code session does, and a tight `CLAUDE.md` plus a tight `prompt` covers the same ground.

The rules that actually move review quality are concrete, repo-specific, and short:

```markdown
# CLAUDE.md (excerpt)

## What "important" means here
Reserve "important" for findings that would break behavior in
production, leak data, or block a rollback: incorrect logic,
unscoped database queries, PII in logs, migrations that are not
backward compatible. Style and naming are nits at most.

## Cap the nits
Report at most five nits per review. If you found more, say
"plus N similar items" in the summary.

## Do not report
- Anything CI already enforces (lint, format, type errors)
- Generated files under `src/gen/` and any `*.lock`
- Test-only code that intentionally violates production rules

## Always check
- New API routes have an integration test
- Log lines do not include user IDs or request bodies
- Database queries are scoped to the caller's tenant
```

Pasting roughly this content into the `prompt` input also works and has the advantage that the rules version with the workflow file. Either way, the lever that matters is "say no to nit volume out loud," because Sonnet's default review voice is more thorough than most teams want.

## Forks, secrets, and the `pull_request_target` trap

The default `on: pull_request` event runs in the context of the PR's head branch. For PRs from forks, that means the workflow runs without access to repo secrets, including `ANTHROPIC_API_KEY`. The fix that looks obvious is to switch to `pull_request_target`, which runs in the context of the base branch and has secrets. Do not do this for autonomous Claude review, because `pull_request_target` checks out base branch code by default and that means you are reviewing the wrong tree, and if you change the checkout to fetch the head ref you are running model-driven tooling against attacker-controlled code with secrets in scope.

The supportable patterns are: leave `on: pull_request` and accept that fork PRs do not get reviewed (use the managed Code Review preview if you need to cover them), or run a manual workflow that maintainers trigger on a fork PR after they have eyeballed the diff. The full [security guidance](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md) is worth reading once before you ship this anywhere outside a private repo.

## When to reach for Bedrock or Vertex instead

If your org runs through AWS Bedrock or Google Vertex AI, the Action supports both with `use_bedrock: true` or `use_vertex: true` plus an OIDC-authenticated step before the Action runs. The model ID format changes (Bedrock uses the regional prefix form, for example `us.anthropic.claude-sonnet-4-6`), and the cloud-providers docs walk through the IAM and Workload Identity Federation setup. The trigger and prompt patterns above are unchanged. The same approach is documented for Microsoft Foundry. The only Anthropic-managed product that does not support these paths is the Code Review research preview, which is one of the reasons the self-hosted Action stays useful even after the managed preview goes GA.

## Related

- [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)
- [How to build a custom MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/)
- [How to add prompt caching to an Anthropic SDK app and measure the hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/)
- [Claude Code 2.1.119: review pull requests from GitLab and Bitbucket](/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/)
- [GitHub Copilot's coding agent on dotnet/runtime: ten months of data](/2026/03/copilot-coding-agent-dotnet-runtime-ten-months-data/)

## Sources

- [Claude Code GitHub Actions docs](https://code.claude.com/docs/en/github-actions)
- [Claude Code Code Review (research preview) docs](https://code.claude.com/docs/en/code-review)
- [`anthropics/claude-code-action` on GitHub](https://github.com/anthropics/claude-code-action)
- [`pr-review-comprehensive.yml` example](https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-comprehensive.yml)
- [`pr-review-filtered-paths.yml` example](https://github.com/anthropics/claude-code-action/blob/main/examples/pr-review-filtered-paths.yml)
