---
title: "Copilot Code Review vs Cursor Bugbot vs a Claude Code Review Action: Which Catches What"
description: "A September 2026 comparison of GitHub Copilot code review, Cursor Bugbot, and anthropics/claude-code-action@v1 running the code-review plugin: what each one reads, what it skips, what it costs per review, and which to put on which repo."
pubDate: 2026-09-18
template: vs
tags:
  - "comparison"
  - "code-review"
  - "github-copilot"
  - "cursor"
  - "bugbot"
  - "claude-code"
  - "ai-agents"
  - "pull-requests"
---

**Short answer:** if you want the fewest false positives and full control over the model and prompt, the Claude Code review action (`anthropics/claude-code-action@v1` running the `code-review` plugin) is the strongest bug finder of the three, because it is the only one that re-checks every candidate bug with a separate validation agent before posting. Copilot code review is the cheap default for GitHub orgs already paying for Copilot Business or Enterprise, but it never reviews lockfiles, `tsconfig.json`, or `build.gradle`. Cursor Bugbot wins by default if your code lives on GitLab, Bitbucket, or Azure DevOps, or if you want bugs fixed automatically, not just reported.

Versions in this post: Copilot code review as documented on September 18, 2026 (Lite and Balanced effort, Lite is still the default until September 28), Bugbot on usage-based billing since the May 11, 2026 pricing change, `claude-code-action` v1.0.229 with Claude Code 2.1.276, and API prices for `claude-opus-5`, `claude-sonnet-5`, and `claude-haiku-4-5`.

## The feature matrix

| | Copilot code review | Cursor Bugbot | Claude Code review action |
| :-- | :-- | :-- | :-- |
| Hosts | GitHub, Azure DevOps (preview) | GitHub + GHES, GitLab, Bitbucket, Azure DevOps | GitHub (a separate GitLab CI/CD integration exists) |
| Where it runs | GitHub, with Actions runners for context gathering | Cursor's cloud | Your Actions runner, your API key |
| Model choice | None, "model switching is not supported" | Effort: Low / Default / High / Smart | Any model ID, plus per-agent choices in the prompt |
| Default focus | Bugs, security, and style inconsistencies | Bugs, security, code quality | Only high-signal bugs and `CLAUDE.md` violations |
| False-positive filter | Opaque | Opaque, plus learned rules | Explicit validation subagent per finding |
| Rules file | `copilot-instructions.md`, `*.instructions.md`, `AGENTS.md`, `.github/skills` | `.cursor/BUGBOT.md` (nested), team, learned and manual rules | `CLAUDE.md` (nested) plus your workflow prompt |
| Re-review on push | Opt-in (`review_on_push`) | Default, incremental since last review | Plugin skips PRs it already commented on |
| Fixes | "Fix with Copilot" hands off to the cloud agent | Autofix spawns a cloud agent | Committable suggestion blocks for small fixes |
| Can approve | Yes, preview, off by default | No | No |
| Merge gate | Approval (if enabled) | `Cursor Bugbot` check, `failure` only if configured | Whatever your workflow does |
| Typical cost per review | $0.05-$1 Lite, $0.25-$5 Balanced, plus Actions minutes | $1.00-$1.50 average run | API tokens plus Actions minutes |

Every row in that table traces to vendor docs linked at the bottom. What it cannot tell you is how many real bugs each finds on your code, and nobody has published a fair head-to-head. I did not run one for this post either. The last section gives you a script to run your own.

## What each one actually does when a PR opens

The architectural differences explain most of the "which catches what" question, so it is worth being precise.

**Copilot code review** is a purpose-built GitHub feature. It reads the diff, gathers "full project context" through GitHub Actions jobs, pulls in your custom instructions, `AGENTS.md`, agent skills from the **head** branch, and read-only MCP context, then leaves a `COMMENTED` review from `copilot-pull-request-reviewer[bot]` with inline comments authored by `Copilot`. Lite effort is described as fast feedback "on common issues such as bugs, security vulnerabilities, and style inconsistencies". Balanced routes the PR to a higher-reasoning model. You never learn which model, and you cannot change it.

**Cursor Bugbot** is a Cursor-hosted agent connected through your SCM integration. It reviews on every PR update, but by default only the changes since its previous review. It reads existing PR comments (top-level and inline) as context to avoid duplicates, merges team rules, every `.cursor/BUGBOT.md` on the path to a changed file, and learned rules into one rules block, and publishes a `Cursor Bugbot` check. Your regular `.cursor/rules/*.mdc` files are **not** applied to Bugbot runs, which surprises teams that assume their editor rules carry over.

**The Claude Code review action** is the one you can open up and read. The official `code-review` plugin in `anthropics/claude-code` is a Markdown prompt that orchestrates subagents:

1. A Haiku agent checks whether to skip: closed PR, draft, trivial or automated change, or a PR Claude has already commented on.
2. A Haiku agent collects the relevant `CLAUDE.md` paths, and a Sonnet agent summarizes the change.
3. Four review agents run in parallel: two Sonnet agents audit `CLAUDE.md` compliance, two Opus agents hunt bugs in the changed code only.
4. Every candidate bug gets its own **validation subagent** (Opus for logic issues, Sonnet for `CLAUDE.md` violations). Anything not confirmed is dropped.
5. Survivors are posted as inline comments, with a committable suggestion only when applying it fully fixes the issue.

The prompt says it outright: "If you are not certain an issue is real, do not flag it." Style, "potential issues that depend on specific inputs or state", and anything a linter catches are excluded by design. That is why I call it the best bug finder: not because its model is magic, but because it is the only one of the three with a verification pass you can inspect, tighten, or loosen.

## Which catches what

This is where the tools actually diverge, and the table above understates it.

**Dependency and build-config changes.** Copilot code review excludes a long list of files entirely, including `package-lock.json`, `yarn.lock`, `requirements.txt`, `go.sum`, `Cargo.lock`, `pubspec.lock`, `tsconfig.json`, `jest.config.js`, `next.config.js`, `build.gradle`, and `build.gradle.kts`. A PR that downgrades a TypeScript `strict` flag or adds an unvetted Gradle plugin gets no Copilot comment on those lines. Bugbot documents no such exclusion list, and Cursor's own rule examples include a license scan that triggers when `package.json`, `pnpm-lock.yaml`, `go.mod`, or `Cargo.toml` change. The Claude action reviews whatever is in the diff, subject to its "linters will catch it" exclusion.

**Style and consistency nits.** Copilot at Lite effort flags them. The Claude plugin deliberately does not, unless a `CLAUDE.md` rule makes them a rule. If your team wants a reviewer that nags about naming, Copilot is the one that will.

**Bugs that need context outside the diff.** All three read beyond the diff, but differently. Copilot's context gathering runs as Actions jobs, and if Actions is unavailable or the org disabled GitHub-hosted runners, reviews "fall back to a more limited review" without failing. The Claude action works on a real checkout, and the plugin's second Opus agent looks for security and logic problems in the introduced code. Bugbot on High effort "spends more time reasoning", and Cursor's May 2026 numbers say High finds 35% more bugs than Default while the resolution rate stays at 80%.

**Pre-existing bugs.** The plugin explicitly filters out issues not introduced by the PR. If you want those reported, that is a feature of Anthropic's separate managed **Code Review** service (Team and Enterprise, research preview), which tags them with a purple "Pre-existing" severity. It averages $15-25 per review and about 20 minutes, which is a different price class from everything else here.

**PRs opened by agents.** Copilot now reviews bot-authored PRs, including ones from the Copilot cloud agent, with usage billed to the human co-author or the org. The Claude action refuses bot actors unless you list them in `allowed_bots`, which is a sane default that you must remember to change if Dependabot or your own agent opens PRs.

## When to pick Copilot code review

- Your org is on Copilot Business or Enterprise and you want coverage on every repo today with zero YAML. Automatic review is a ruleset rule (`copilot_code_review`), so it scales by API across hundreds of repos.
- You need the cheapest per-review price. GitHub's own estimate is $0.05 to $1 of AI credits at Lite and $0.25 to $5 at Balanced, plus Actions minutes.
- You want the reviewer to count as an approver on low-risk paths. [Copilot approvals](/2026/09/copilot-code-review-can-now-approve-pull-requests/) (preview, off by default) only count when every changed file matches your glob list.
- Contributors without Copilot seats should still get reviews. Business and Enterprise can enable that, billed to the org.

Budget for the [September 28 switch from Lite to Balanced](/2026/08/copilot-code-review-defaults-to-balanced-on-september-28/) if you have not pinned the effort level.

## When to pick Cursor Bugbot

- Your repos are on GitLab, Bitbucket, Azure DevOps, or GitHub Enterprise Server. Bugbot is the only one of the three that covers all of them with one configuration.
- You want the loop closed. Autofix spawns a Cursor cloud agent that pushes to a new branch or to the PR branch (capped at 3 attempts per PR), billed as cloud agent usage.
- You want review before the PR exists. [`/review-bugbot` runs the same reviewer locally](/2026/06/how-to-run-bugbot-review-locally-before-pushing-in-cursor/) in Cursor 3.7+ and the Cursor CLI, and a matching patch ID makes the later PR review skip itself.
- You want numbers. Enterprise teams get an analytics endpoint with per-review `cost_cents`, `bugs_found`, severity, and `resolution_status`.

That last one also gives you a dry-run mode, which is the cleanest way to trial Bugbot on real PRs without posting anything:

```bash
# Bugbot API, September 2026. Requires an Enterprise API key with admin:* scope.
# Dry runs are billed like normal reviews but post nothing to the PR.
curl --request POST \
  --url https://api.cursor.com/bugbot/review \
  -u "$CURSOR_API_KEY:" \
  --header 'Content-Type: application/json' \
  --data '{"prUrl": "https://github.com/your-org/your-repo/pull/42", "dryRun": true}'

# Then read the findings (title, description, file/line) back:
curl --get https://api.cursor.com/analytics/team/bugbot-reviews \
  -u "$CURSOR_API_KEY:" \
  --data-urlencode 'dryRun=true' \
  --data-urlencode 'repo=github.com/your-org/your-repo' \
  --data-urlencode 'prNumber=42'
```

## When to pick the Claude Code review action

- You want to choose the model, the prompt, and the trigger, and read exactly what the reviewer was told.
- You route inference through AWS Bedrock, Google Vertex AI, or Microsoft Foundry for data residency. The action supports all three; Copilot and Bugbot do not give you that choice, and Anthropic's managed Code Review is not available with Zero Data Retention.
- You want the reviewer to enforce the same `CLAUDE.md` your developers' Claude Code sessions already follow.
- You are fine paying token prices directly: Opus 5 is $5 / $25 per million input/output tokens, Sonnet 5 $2 / $10, Haiku 4.5 $1 / $5.

The workflow from the Claude Code docs is short:

```yaml
# .github/workflows/claude-review.yml
# anthropics/claude-code-action v1 (v1.0.229), Claude Code 2.1.276
name: Code Review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: read
      id-token: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 1
      - uses: anthropics/claude-code-action@v1
        id: review
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          plugin_marketplaces: "https://github.com/anthropics/claude-code.git"
          plugins: "code-review@claude-code-plugins"
          prompt: "/code-review:code-review --comment ${{ github.repository }}/pull/${{ github.event.pull_request.number }}"
          claude_args: '--allowedTools "mcp__github_inline_comment__create_inline_comment"'
      # Log what this review cost, from the SDK result message.
      - if: always() && steps.review.outputs.execution_file != ''
        run: jq '.[] | select(.type == "result") | .total_cost_usd' "${{ steps.review.outputs.execution_file }}"
```

Keep the `--allowedTools` line even though the plugin's frontmatter names the same tool: the action only starts the inline-comment MCP server when `claude_args` names it. The `write` access the comments need comes from the Claude GitHub App token that `id-token: write` lets the action mint, not from the `permissions` block.

The last step is the one most teams skip. The action exposes an `execution_file` output, and the final `result` message in it carries `total_cost_usd`. Log it for two weeks and you have your own per-review price instead of a guess. The plugin hard-codes `haiku`, `sonnet`, and `opus` as agent aliases, which currently resolve to the latest models, so to trade quality for cost you fork the plugin's `commands/code-review.md` into your own repo's `.claude/skills/` and change the agent lines. That is also where you would add a `REVIEW.md`-style severity section; the local `/code-review` command and this plugin read `CLAUDE.md`, not `REVIEW.md`.

For a hand-rolled prompt instead of the plugin, model routing by path, and the `pull_request_target` trap, see [how to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/).

## The gotchas that pick for you

**Your SCM host.** If it is not GitHub, the choice is Bugbot, or Copilot on Azure DevOps in preview, or wiring Claude Code into GitLab CI yourself.

**Fork PRs.** GitHub withholds secrets from `pull_request` runs triggered by forks, so the Claude action simply does not review them. Copilot and Bugbot run as GitHub Apps on their own infrastructure and do not depend on your Actions secrets, which is why open-source maintainers usually end up with one of them.

**"Re-review on every push" means different things.** Bugbot re-reviews each push incrementally by default. Copilot reviews once unless the ruleset sets `review_on_push`. The Claude plugin's first step skips any PR Claude has already commented on, so despite `synchronize` in the trigger list, the second push produces no second review. If you want one, delete the old comment or drop that check in a forked copy of the prompt.

**None of them block a merge by default.** Copilot leaves `COMMENTED` reviews. Bugbot's check concludes `neutral` when it finds issues unless your org enables fail-on-unresolved. The managed Claude Code Review check always concludes `neutral`, and the plugin only posts comments. If you want a gate, build it on the check output or the comment counts.

## Run your own bake-off

The honest way to decide is to point all three at the same 20 merged PRs where you already know what the bugs were, then count. This script collects each reviewer's output for one PR:

```bash
#!/usr/bin/env bash
# bakeoff.sh, gh 2.x and jq 1.7. Usage: ./bakeoff.sh OWNER/REPO PR_NUMBER
set -euo pipefail
repo="$1"; pr="$2"
sha=$(gh api "repos/$repo/pulls/$pr" --jq .head.sha)

count_inline() {  # $1 = case-insensitive login pattern
  gh api --paginate "repos/$repo/pulls/$pr/comments" \
    --jq "[.[] | select(.user.login | test(\"$1\"; \"i\"))] | length" \
    | awk '{s+=$1} END {print s+0}'
}

echo "Copilot inline comments: $(count_inline '^copilot')"
echo "Bugbot  inline comments: $(count_inline '^cursor')"
echo "Claude  inline comments: $(count_inline '^claude')"

# Bugbot and managed Claude Code Review both publish a check run.
gh api "repos/$repo/commits/$sha/check-runs" \
  --jq '.check_runs[] | select(.name | test("Bugbot|Claude Code Review"))
        | "\(.name): \(.conclusion)"'
```

Against a real Copilot-reviewed PR in `microsoft/vscode` (#336683) it printed `Copilot inline comments: 6` and zeros for the other two, which confirms the login filters: Copilot's inline comments come from the `Copilot` user, its review from `copilot-pull-request-reviewer[bot]`. Counting comments is only step one. For each comment, record whether it was a real bug, a nit, or wrong. Copilot's resolution reasons (Addressed, Won't fix, Incorrect) and Bugbot's `resolution_status` give you that label for free once the tools are live.

## The recommendation, restated

For a GitHub team that cares most about real bugs per comment, run the Claude Code review action with the `code-review` plugin on repos where a missed bug is expensive, and log `total_cost_usd` so the bill is a number, not a feeling. Keep Copilot code review on Lite as the cheap always-on pass everywhere else, especially on open-source repos with fork PRs, and remember that it will never look at your lockfiles or build scripts. Choose Bugbot instead of both when you are not GitHub-only, or when you want an agent that pushes the fix rather than describing it.

## Related

- [How to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/)
- [How to run a pre-push code review locally with Cursor Bugbot's /review](/2026/06/how-to-run-bugbot-review-locally-before-pushing-in-cursor/)
- [Copilot code review now reads your .github/skills folder](/2026/07/copilot-code-review-agent-skills-and-mcp-ga/)
- [Copilot code review can now approve pull requests](/2026/09/copilot-code-review-can-now-approve-pull-requests/)
- [Claude Code vs Cursor vs Copilot agent mode: where each wins](/2026/06/claude-code-vs-cursor-vs-copilot-agent-mode-where-each-wins/)

## Sources

- [About GitHub Copilot code review (GitHub Docs)](https://docs.github.com/en/copilot/concepts/agents/code-review)
- [Files excluded from GitHub Copilot code review (GitHub Docs)](https://docs.github.com/en/copilot/reference/review-excluded-files)
- [Using GitHub Copilot code review (GitHub Docs)](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review)
- [Bugbot documentation (Cursor Docs)](https://cursor.com/docs/bugbot)
- [Updates to Bugbot for Teams and Individuals (Cursor blog, May 11, 2026)](https://cursor.com/blog/may-2026-bugbot-changes)
- [Claude Code GitHub Actions (Claude Code Docs)](https://code.claude.com/docs/en/github-actions)
- [Code Review (Claude Code Docs)](https://code.claude.com/docs/en/code-review)
- [`code-review` plugin prompt (anthropics/claude-code)](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/commands/code-review.md)
- [`claude-code-action` v1.0.229 release](https://github.com/anthropics/claude-code-action/releases/tag/v1.0.229)
- [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
