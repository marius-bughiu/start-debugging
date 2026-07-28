---
title: "How to Run a Background Coding Agent That Auto-Commits and Opens a Draft PR When It Finishes"
description: "Two ways to make a coding agent land its own work: Claude Code 2.1.198+ background sessions commit, push, and open a draft PR from their worktree with no config, or wrap any agent CLI in a git worktree plus gh pr create --draft. Covers the worktree guardrails, the subagent-vs-session distinction, the GITHUB_TOKEN trigger trap, and why there is still no off switch."
pubDate: 2026-07-28
tags:
  - "claude-code"
  - "ai-agents"
  - "automation"
  - "github-actions"
  - "llm"
---

There are two ways to get a coding agent to finish the job instead of handing you a pile of uncommitted edits. The built-in route: as of Claude Code 2.1.198 (July 1, 2026), a background session that isolated its changes in a git worktree commits, pushes its own branch, and opens a draft pull request without stopping to ask. The portable route, which works with any agent CLI and inside CI: run the agent in a `git worktree`, then let a wrapper script do the commit, push, and `gh pr create --draft`. This post builds both, then covers the guardrails, the trigger trap that makes your CI skip the PR the agent just opened, and the off switch that does not exist yet.

## Why the last mile is where autonomous runs die

An agent that edits files and stops is only half an automation. Somebody still has to notice it finished, read the diff in a terminal, write a commit message, pick a branch name, push, and open a PR. That is five minutes of human attention per run, which is fine once and intolerable at ten runs a day. Worse, it is stateful attention: the diff sits in a working copy that blocks whatever else you wanted to do in that checkout.

The fix has two halves, and they are separable. **Isolation** means the agent's edits go somewhere that is not your working copy, so a long run never blocks you. **Landing** means the agent converts its own work into a reviewable artifact. Isolation without landing gives you a pile of orphan worktrees. Landing without isolation gives you an agent committing on top of your half-finished work. You want both, and the draft state is what makes the combination safe: the plumbing between "agent finished" and "I can review a real PR" disappears, but nothing merges without a human.

## Route 1: let Claude Code land it

Start a background session from your shell:

```bash
# Claude Code 2.1.198+ (behaviour), 2.1.220 current as of July 25, 2026
claude --bg "Migrate the auth module off the deprecated session helper, run the tests"
```

You get back your prompt immediately. The session runs in a daemon-managed worker, and you watch it with `claude agents` (or press `←` on an empty prompt in an interactive session to background the current conversation and open agent view). `/bg` and `/background` move a running conversation into the background; `/fork` copies it into a new one.

Every background session starts in your working directory, but before it edits a file, Claude moves it into an isolated worktree under `.claude/worktrees/`. Parallel sessions read the same checkout and each writes to its own. It skips that move in three cases: the session is already inside a linked worktree, the working directory is not a git repository and no `WorktreeCreate` hook is configured, or the write lands outside the working directory.

That isolation step is the trigger for everything else. A session that isolated its own changes commits, pushes its branch, and opens a draft PR when it finishes code work. A session editing a checkout it did not isolate itself still asks before committing or switching branches. The behavior is not "agents now push"; it is "agents clean up after themselves in the sandbox they created."

The guardrails are worth stating precisely, because they are the reason this is tolerable as a default. It never pushes to `main` or `master`. It never force-pushes and never merges. It skips the pull request when you told it not to open one, or when the repository has no remote. In agent view, a session that opened a PR grows a `#1234` label at the right edge of its row, color-coded by state: yellow while checks or review are pending or checks failed, green when checks pass and nothing is blocking, purple when merged, grey for draft or closed. Since the PR starts as a draft, expect grey first.

Two settings shape the behavior. `worktree.baseRef` decides what the branch forks from:

```json
// .claude/settings.json
{
  "worktree": {
    "baseRef": "fresh"
  }
}
```

`"fresh"` is the default and branches from the repository's default branch on the remote, so the agent starts from a clean tree matching `origin`. Claude Code keeps `origin/HEAD` current for this, fetching the default branch if the repo has not been fetched in 24 hours, capped at five seconds, falling back to the cached ref. `"head"` branches from your current local `HEAD` instead, carrying your unpushed commits, which is what you want when the agent has to build on work in progress. It does not accept a branch name; for a specific branch, create the worktree with git yourself.

The other setting turns the whole mechanism off:

```json
// .claude/settings.json
{
  "worktree": {
    "bgIsolation": "none"
  }
}
```

With `bgIsolation` set to `"none"`, background sessions edit your working copy directly. Because the commit-push-PR behavior is downstream of isolation, this is currently the closest thing to a documented off switch. More on that below.

### The distinction that trips people up

"Background agent" and "background subagent" are different things in Claude Code, and only one of them opens PRs.

| | Background session (`claude --bg`, agent view, `/bg`) | Background subagent (`Agent` tool, `isolation: worktree`) |
| --- | --- | --- |
| Scope | Its own session, own transcript, own daemon worker | Runs inside a parent session, reports back to it |
| Worktree | Auto-isolated under `.claude/worktrees/` before first edit | Only with `isolation: worktree` in frontmatter or at spawn |
| On finish | Commits, pushes, opens a draft PR | Returns a report to the parent; worktree stays on disk if it has changes |
| Cleanup | `Ctrl+X` in agent view removes the worktree, `claude rm` keeps a dirty one | Removed automatically if it made no changes |

A subagent with `isolation: worktree` gets an isolated copy of the repo branched from your default branch rather than the parent's `HEAD`, and Claude Code removes the worktree if the subagent made no changes. It does not open a PR. If you fanned out five worktree subagents and are wondering where the five draft PRs are, that is why. Since 2.1.198 subagents also run in the background by default, which makes it easy to conflate the two; [the release that flipped that default](/2026/07/claude-code-2-1-198-subagents-run-in-the-background-by-default/) changed both behaviors at once.

## Route 2: the portable version

The built-in path assumes Claude Code and a local machine with a git remote. In CI, or with any other agent CLI, you write the last mile yourself. It is about 40 lines, and it is worth writing once because you control every decision in it.

```bash
#!/usr/bin/env bash
# agent-run.sh - Claude Code 2.1.220, gh 2.89.0, git 2.53
set -euo pipefail

TASK="$1"
SLUG="$(echo "$TASK" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-' | cut -c1-40)"
BRANCH="agent/$SLUG"
BASE="$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')"
WT="${TMPDIR:-/tmp}/agent-worktrees/$SLUG"

git fetch --quiet origin "$BASE"
git worktree add --quiet -b "$BRANCH" "$WT" "origin/$BASE"

# --bare skips discovery of hooks, plugins, MCP servers, and CLAUDE.md so the
# run is identical on every machine. Pass context back in explicitly.
(
  cd "$WT"
  claude --bare -p "$TASK" \
    --permission-mode acceptEdits \
    --allowedTools "Read,Edit,Write,Grep,Glob,Bash(npm test *),Bash(npm run lint *)" \
    --max-budget-usd 4 \
    --output-format json > "$OLDPWD/agent-result.json"
)

cd "$WT"
if git diff --quiet && git diff --cached --quiet \
   && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "agent produced no changes, not opening a PR"
  cd - >/dev/null && git worktree remove "$WT"
  exit 0
fi

git add -A
git commit -q -m "agent: $TASK"
git push -q -u origin "$BRANCH"
gh pr create --draft --base "$BASE" --head "$BRANCH" \
  --title "agent: $TASK" \
  --body-file <(jq -r '.result' "$OLDPWD/agent-result.json")
```

Four decisions in there matter more than the rest.

**Branch from `origin/$BASE`, not from `HEAD`.** Resolving the default branch through `refs/remotes/origin/HEAD` rather than hardcoding `main` means the script survives a repo that uses `master` or `trunk`, and the explicit `git fetch` means the agent is not silently working from a week-old base. This is the same choice `worktree.baseRef: "fresh"` makes for you in route 1.

**Guard the empty diff.** An agent that decided the task was already done, or that failed to make progress, must not open a PR. The three-part check covers unstaged changes, staged changes, and untracked files; skipping the untracked check is the classic bug, because a run whose only output is a new file looks clean to `git diff`. I verified this check against git 2.53 on a scratch repo: `git diff --quiet` alone reports clean for a run that only added files.

**Cap the spend.** `--max-budget-usd 4` stops the run when it hits the ceiling. If you are fanning work out to subagents, note that `--max-budget-usd` did not stop background subagents until 2.1.214, so a fleet could overshoot the cap on earlier versions.

**Use `--bare` in scripts.** It skips auto-discovery of hooks, skills, plugins, MCP servers, auto memory, and `CLAUDE.md`, so the run does not change behavior because a teammate added a hook in their `~/.claude`. Everything the agent needs comes in through explicit flags: `--append-system-prompt-file`, `--settings`, `--mcp-config`, `--agents`. Anthropic auth has to come from `ANTHROPIC_API_KEY` or an `apiKeyHelper` in the JSON you pass to `--settings`, because bare mode skips OAuth and keychain reads. The docs note `--bare` will become the default for `-p` in a future release, so writing scripts against it now is the forward-compatible choice.

One more thing about `-p` runs and worktrees: a non-interactive run has no exit prompt, so Claude Code does not clean up its worktree. The script above removes it on the no-changes path and deliberately leaves it in place when there is a PR, so you can inspect the tree the agent actually built. Sweep the leftovers with `git worktree remove`, or let Claude Code's periodic sweep handle worktrees it created once they age past `cleanupPeriodDays` (that sweep skips anything holding changed files, untracked files, or unpushed commits).

## The same run as a GitHub Actions job

Wire the same shape into a workflow and you have an issue-to-draft-PR pipeline. The `permissions` block is the part people get wrong:

```yaml
# .github/workflows/agent-task.yml
name: agent task
on:
  issues:
    types: [labeled]

permissions:
  contents: write        # push the branch
  pull-requests: write   # open the PR
  issues: read

jobs:
  run:
    if: github.event.label.name == 'agent'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_token: ${{ secrets.AGENT_APP_TOKEN }}
          branch_prefix: "agent/"
          claude_args: |
            --max-budget-usd 6
            --model claude-sonnet-5
          prompt: |
            Implement the change described in issue #${{ github.event.issue.number }}.
            Run the test suite before you finish.
```

`anthropics/claude-code-action@v1` handles branch creation itself, with `branch_prefix` (default `claude/`), `base_branch`, and `branch_name_template` controlling the naming, and `use_commit_signing` if you need verified commits. If you would rather keep the shell script, drop `claude-code-action` and run `agent-run.sh` in a step with `GH_TOKEN` set. The same permissions apply either way. For the review side of this pipeline rather than the authoring side, [running Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/) covers the inverse workflow.

## Gotchas worth knowing before you ship this

**`GITHUB_TOKEN` will not trigger your CI on the PR it just opened.** This is the one that wastes an afternoon. Per GitHub's own docs, events triggered by `GITHUB_TOKEN` do not create a new workflow run, with `workflow_dispatch` and `repository_dispatch` as the only exceptions. Your agent opens a draft PR, and no checks run, so the PR sits there looking untested. Two fixes: authenticate with a GitHub App installation token or a PAT instead of `GITHUB_TOKEN` (that is the `AGENT_APP_TOKEN` above), or add `ready_for_review` to your CI workflow's `pull_request` types so checks fire when a human promotes the draft.

**Draft PRs are quiet by design.** No one can merge a draft, and marking it ready is what requests reviews from code owners. If your workflows carry `if: github.event.pull_request.draft == false`, they will skip the agent's PR entirely. `gh pr ready <number>` flips it from the CLI.

**The repo-level setting can block PR creation outright.** Settings, Actions, General, Workflow permissions has an "Allow GitHub Actions to create and approve pull requests" checkbox. With it off, `GITHUB_TOKEN` cannot open a PR no matter what your `permissions` block says, and the step fails saying GitHub Actions is not permitted to create or approve pull requests. An App token sidesteps this too.

**There is no supported way to turn route 1 off.** [Issue #73197](https://github.com/anthropics/claude-code/issues/73197) asks for `backgroundAgents.autoCreatePr: false`, separate knobs for commit, push, and PR, or simply for background agents to honor a `Bash(git push:*)` deny rule. As of 2.1.220 it is open with no such setting shipped. Today your options are `worktree.bgIsolation: "none"` (which removes the isolation that triggers the landing behavior, and with it the parallelism benefit), telling the session in its prompt not to open a PR, or `CLAUDE_CODE_DISABLE_AGENT_VIEW` to switch off background agents and agent view entirely. If your team's policy is propose-only, know that going in.

**A worktree is a fresh checkout, so your `.env` is missing.** A run that needs gitignored local config will fail on the first test command. Add a `.worktreeinclude` at the project root using `.gitignore` syntax; only files that match a pattern and are also gitignored get copied, so tracked files are never duplicated. With a `WorktreeCreate` hook, copy them inside the hook script instead, because `.worktreeinclude` is not processed when a hook replaces the default git logic.

**`Ctrl+X` twice in agent view deletes uncommitted work.** Deleting a session from agent view removes its worktree, including uncommitted changes. Deleting from the shell with `claude rm` keeps a worktree that has uncommitted changes. Neither path removes a worktree holding unpushed commits. Once the session has landed a draft PR the work is on the remote, which is precisely the point: the risk window is the run, not after it.

**Review the diff, not the PR body.** The agent wrote the PR description, so it is a summary of what the agent believes it did. On a run that went sideways, the body is confident and the diff is wrong. Treat the description as a table of contents. If you want to see what the agent was actually reasoning about while it worked, [streaming subagent text out of a headless run](/2026/07/stream-nested-subagent-output-from-a-headless-claude-code-run/) gets you the transcript that the final report papers over.

## Pick a route by where the work starts

If the work starts on your machine and you are already in Claude Code, route 1 is free: `claude --bg`, keep working, review a draft PR later. If it starts from an issue, a webhook, a cron, or anything that has no human at a terminal, route 2 is the one to build, because the same 40 lines work with any agent CLI and give you explicit control over the base branch, the spend cap, and the decision not to open a PR. Hosted options sit alongside both, and [Cursor cloud agents versus the GitHub Copilot coding agent](/2026/07/cursor-cloud-agents-vs-github-copilot-coding-agent-for-background-prs/) covers that trade-off in detail.

Whichever you pick, keep the draft state. An agent that opens a ready-for-review PR is asking your teammates to spend attention on unreviewed machine output, and the first time one gets merged on a Friday you will wish the plumbing had a speed bump in it.

## Related

- [Claude Code 2.1.198 runs subagents in the background by default](/2026/07/claude-code-2-1-198-subagents-run-in-the-background-by-default/)
- [How to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/)
- [Cursor cloud agents vs GitHub Copilot coding agent for background PRs](/2026/07/cursor-cloud-agents-vs-github-copilot-coding-agent-for-background-prs/)
- [Claude Code skills vs subagents vs MCP servers: when to build each](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/)
- [How to stream nested subagent output from a headless Claude Code run](/2026/07/stream-nested-subagent-output-from-a-headless-claude-code-run/)

## Sources

- [Manage multiple agents with agent view](https://code.claude.com/docs/en/agent-view)
- [Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code changelog, versions 2.1.198 through 2.1.220](https://code.claude.com/docs/en/changelog)
- [anthropics/claude-code issue 73197, setting to disable background agents' auto-commit and auto-PR](https://github.com/anthropics/claude-code/issues/73197)
- [anthropics/claude-code-action action.yml inputs](https://github.com/anthropics/claude-code-action/blob/main/action.yml)
- [GitHub Docs: events that trigger workflows](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [GitHub Docs: changing the stage of a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/changing-the-stage-of-a-pull-request)
- [gh pr create manual](https://cli.github.com/manual/gh_pr_create)
