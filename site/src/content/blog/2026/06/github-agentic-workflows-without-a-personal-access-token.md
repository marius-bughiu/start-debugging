---
title: "How to Automate a Repository Task with GitHub Agentic Workflows Without a Personal Access Token"
description: "As of the June 11, 2026 change, GitHub Agentic Workflows run on the built-in GITHUB_TOKEN. Add copilot-requests: write, drop the PAT, recompile the lock file, and let safe-outputs apply writes from a privileged step. Full issue-triage example, the token fallback chain, and the two cases where you still need a custom token."
pubDate: 2026-06-20
tags:
  - "ai-agents"
  - "github-copilot"
  - "github-actions"
  - "automation"
  - "agentic-workflows"
---

For most of the last year, the friction in standing up a GitHub Agentic Workflow was not the prompt or the YAML. It was the token. You created a personal access token (PAT), decided how many scopes to give it, stored it as a repository secret, rotated it before it expired, and hoped nobody copied it into a fork. As of the [June 11, 2026 changelog](https://github.blog/changelog/2026-06-11-agentic-workflows-no-longer-need-a-personal-access-token/), that step is gone. Agentic workflows now run on the built-in `GITHUB_TOKEN` that every GitHub Actions job already gets, and Copilot inference is billed to your organization through a single permission flag. This post walks the full setup: a runnable issue-triage workflow, the exact frontmatter, the token fallback chain the engine actually uses, and the two cases where a custom token is still unavoidable.

## What a PAT-free workflow actually looks like

A GitHub Agentic Workflow (the `gh-aw` extension, repo at [github/gh-aw](https://github.com/github/gh-aw)) is a Markdown file in `.github/workflows/` with YAML frontmatter on top and a natural-language prompt in the body. You compile it with `gh aw compile`, which produces a `.lock.yml` GitHub Actions file next to it. Both files get committed. The lock file is what Actions runs; the Markdown is what you edit.

Here is a complete issue-triage workflow that reads a newly opened issue, decides on a label, and posts a comment, with no PAT anywhere:

```markdown
# .github/workflows/triage.md
# gh-aw CLI: latest (gh extension upgrade aw), compiled 2026-06
---
emoji: 🧠
name: Issue Triage
description: Label and comment on newly opened issues
on:
  issues:
    types: [opened]
permissions:
  contents: read
  issues: read
  copilot-requests: write
engine: copilot
strict: true
network:
  allowed: [defaults, github]
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
safe-outputs:
  add-comment:
    max: 1
  update-issue:
    max: 1
---

# Triage this issue

Read the issue title and body. Decide which single label best fits
("bug", "enhancement", "question", or "documentation") and apply it
by updating the issue. Then add one short comment explaining your
reasoning in two sentences. Do not invent labels that do not exist
in the repository.
```

The thing to notice: the agent's own `permissions:` block is read-only for `contents` and `issues`. The only `write` in the whole file is `copilot-requests: write`. The agent never gets a token that can mutate the repository. So how does it apply a label and post a comment? That is the part worth understanding, because it is exactly why the PAT became unnecessary.

## Why the agent can stay read-only: safe-outputs

The `safe-outputs:` block is the mechanism. When you declare `add-comment:` or `update-issue:` there, the compiler splits the job into two phases. The first phase runs the model with the read-only permissions you declared. The model cannot write to GitHub directly. Instead, it emits a structured declaration: "add this comment", "set this label". The second phase is a separate, privileged collection step that the compiler generates for you. That step reads the model's declared outputs and applies them using the job's `GITHUB_TOKEN`, with the write scopes that the safe output requires.

This is the same defense-in-depth idea behind a [preview-confirm-apply file-write tool](/2026/06/claude-code-vs-cursor-vs-copilot-agent-mode-where-each-wins/): the part of the system that decides what to do is deliberately not the part that has permission to do it. A prompt-injected issue body cannot trick the agent into force-pushing to `main`, because the agent has no token that can push. The worst it can do is emit a malformed safe output, which the collection step validates against the `max:` caps and the declared output types before applying anything.

Common safe-output types you will reach for:

- `add-comment` - comment on the triggering issue or PR
- `update-issue` - change labels, title, assignees, or state
- `create-issue` - file a new issue
- `create-pull-request` - open a PR with the agent's changes
- `close-issue` - close the triggering issue
- `dispatch-workflow` - kick off another workflow

Because the writes flow through a privileged step you do not author, you no longer need to hand the agent a broadly scoped PAT "just in case it needs to comment". The built-in token, scoped per job, covers it.

## The copilot-requests permission and where the money goes

The second half of the old PAT problem was inference billing, not repository access. Calling a model from inside a workflow used to mean either a Copilot token tied to a user's personal inference budget or an external provider key. The [`copilot-requests` permission](https://github.github.io/gh-aw/reference/permissions/) replaces both.

Add `copilot-requests: write` to the job permissions and the engine uses the built-in Actions token to authenticate Copilot inference. Per the [authentication reference](https://github.github.com/gh-aw/reference/auth/), tokens are "minted per-run and automatically revoked", so there is no long-lived secret to leak or rotate. In an organization-owned repository, the AI credits the workflow consumes are billed directly to the organization rather than drawn from any individual user's budget.

Two prerequisites, both called out in the changelog:

1. The org policy **"Allow use of Copilot CLI billed to the organization"** must be on. It is enabled by default when the "Copilot CLI" policy is active.
2. You must be on the latest CLI. Run `gh extension upgrade aw` before compiling, because the `copilot-requests` codepath only exists in recent versions.

The feature works across every Copilot plan: Free, Pro, Pro+, Business, and Enterprise. One sharp edge worth knowing: if `copilot-requests: write` is present, the engine ignores any `COPILOT_GITHUB_TOKEN` secret you may have configured for inference. The Actions token takes absolute precedence. If you set the permission and your old token secret in the same workflow expecting the secret to win, it will not.

## Compile, commit, push

Editing the prompt body alone does not require a recompile. Editing the frontmatter does, because the tools, permissions, triggers, and network rules are all baked into the `.lock.yml`. The loop is:

```bash
# gh-aw CLI: latest, 2026-06
gh extension upgrade aw            # get the copilot-requests codepath
gh aw compile triage              # regenerate .github/workflows/triage.lock.yml
git add .github/workflows/triage.md .github/workflows/triage.lock.yml
git commit -m "Add PAT-free issue triage workflow"
git push
```

Both the `.md` and the `.lock.yml` must be committed and pushed. The Markdown file on its own is not a valid Actions workflow; Actions only runs the compiled lock file. A frequent first-run failure is editing the frontmatter, forgetting to recompile, and pushing a stale lock that still references the old PAT secret. If your workflow suddenly asks for a secret you thought you deleted, recompile.

There is a CLI helper for the inverse situation: `gh aw secrets bootstrap` inspects which token secrets (like `GH_AW_GITHUB_TOKEN`) a repository still has and prints the scopes plus copy-pasteable commands. After moving to `copilot-requests`, run it to confirm you can delete the leftover PAT secret cleanly.

## The token fallback chain, in the order the engine checks it

For repository operations (not inference), the engine resolves a token through a fixed chain, documented in the [authentication reference](https://github.github.com/gh-aw/reference/auth/):

```
custom github-token  →  GH_AW_GITHUB_TOKEN  →  GITHUB_TOKEN (default)
```

- A `github-token:` you set explicitly in a tool config wins.
- Otherwise, if a `GH_AW_GITHUB_TOKEN` secret exists, the engine uses it.
- Otherwise, it falls back to the built-in `GITHUB_TOKEN`.

The whole point of the June change is that for single-repo automation, the third link in that chain is now enough. You declare the read scopes the agent needs and the write scopes your safe outputs need, and the per-job `GITHUB_TOKEN` carries both. Nothing earlier in the chain has to exist.

The permission scopes themselves follow GitHub Actions conventions. Each scope (`contents`, `issues`, `pull-requests`, `discussions`, `actions`, `checks`, `deployments`, `packages`, `pages`, `statuses`) defaults to `read`, and you only widen what a safe output requires. Two scopes are special: `copilot-requests` only accepts `write`, and `id-token` only accepts `write` or `none` (`id-token: read` is rejected at compile time, which is a confusing error if you assumed read was the safe default).

## The two cases where you still need a custom token

The built-in token is scoped to the current repository and to the permissions the job declares. That covers most automation, but two situations genuinely outgrow it.

**Cross-repository writes.** If a safe output needs to create an issue or open a PR in a *different* repository, the default `GITHUB_TOKEN` cannot reach it. You need either a `GH_AW_GITHUB_TOKEN` fine-grained PAT scoped to both repos, or a GitHub App:

```bash
# Fine-grained PAT, minimum scopes only
gh aw secrets set GH_AW_GITHUB_TOKEN --value "<your-github-pat>"
```

**Triggering downstream CI.** GitHub deliberately does not let the built-in `GITHUB_TOKEN` trigger further workflow runs (this prevents accidental recursion). So if your agent opens a PR and you want that PR to immediately kick off CI, the PR has to be created with a token that is allowed to trigger workflows. The built-in token is not, by design. A `GH_AW_GITHUB_TOKEN` or a GitHub App token is.

For anything beyond a personal repo, prefer the GitHub App over a PAT. It scopes to specific repositories, mints short-lived tokens, and survives the owner leaving the org:

```yaml
# frontmatter, gh-aw latest 2026-06
tools:
  github:
    github-app:
      client-id: ${{ vars.APP_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
      owner: "my-org"
      repositories: ["repo1", "repo2"]
```

Add `ignore-if-missing: true` if the same workflow runs on forks, where the App secrets will not be present. Without it, fork runs fail trying to mint a token they cannot get.

## How this lines up with the rest of the agent-in-CI landscape

The pattern here, a read-only agent that proposes changes and a privileged step that applies them, is the same shape you see in other CI-resident agents. If you have wired up [Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/), you already split the model run from the comment-posting step; gh-aw just makes that split a first-class `safe-outputs:` declaration instead of hand-written YAML. The triage example above is the agentic-workflow analogue of [scheduling a recurring Claude Code task that triages issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/), with the credential model finally simplified.

The credential lesson generalizes past this one tool. The most common silent failure in agent-in-CI setups remains a token that is present but underscoped, the exact trap behind [GitHub MCP server tool calls failing silently without a PAT](/2026/05/fix-github-mcp-server-tool-calls-fail-silently-without-pat/). The `copilot-requests` model removes the token from your hands entirely, which is strictly fewer things to misconfigure. And if you are choosing between embedding an agent runtime yourself versus declaring one in YAML, the trade-offs mirror those in [the GitHub Copilot SDK GA writeup](/2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp/): the SDK gives you a programmable runtime, agentic workflows give you a declarative, compiled, auditable one.

The short version: upgrade the CLI, add `copilot-requests: write`, let your repository writes flow through `safe-outputs:`, recompile, and delete the PAT secret. Reach for `GH_AW_GITHUB_TOKEN` or a GitHub App only when you cross a repository boundary or need to trigger another workflow. Everything else now runs on the token GitHub already hands every job.

## Sources

- [Agentic workflows no longer need a personal access token - GitHub Changelog, June 11, 2026](https://github.blog/changelog/2026-06-11-agentic-workflows-no-longer-need-a-personal-access-token/)
- [Authentication reference - GitHub Agentic Workflows](https://github.github.com/gh-aw/reference/auth/)
- [Permissions reference - GitHub Agentic Workflows](https://github.github.io/gh-aw/reference/permissions/)
- [github/gh-aw - GitHub Agentic Workflows](https://github.com/github/gh-aw)
