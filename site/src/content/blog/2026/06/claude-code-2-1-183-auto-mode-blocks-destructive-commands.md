---
title: "Claude Code 2.1.183 Stops Auto Mode From Running Destructive Git and IaC Commands"
description: "Claude Code v2.1.183 (June 19, 2026) blocks git reset --hard, git clean -fd, and terraform/pulumi/cdk destroy in auto mode unless you asked for them, closing the agentic loophole where one bad turn nukes uncommitted work."
pubDate: 2026-06-19
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
---

Claude Code v2.1.183 shipped on June 19, 2026, and the headline change is a guardrail that should have existed the day auto mode did: the agent can no longer run a handful of irreversible commands on its own initiative. If you did not explicitly ask for `git reset --hard`, the model is not allowed to decide it needs one mid-task.

## The failure mode this closes

Auto mode (formerly the YOLO-flavored "just do it" path) lets the agent execute shell commands without a per-command approval prompt. That is exactly what you want for a loop of `dotnet build`, `dotnet test`, and edits. It is exactly what you do not want when the model, trying to "get back to a clean state" after a confused refactor, reaches for `git reset --hard` and wipes an hour of uncommitted work, or runs `terraform destroy` against the wrong stack.

The new release draws a line: destructive, hard-to-undo commands are blocked in auto mode unless the request that triggered them explicitly named that action. The blocked set in 2.1.183:

```bash
# Blocked in auto mode unless you asked for them
git reset --hard
git checkout -- .
git clean -fd
git stash drop

# Blocked for commits the agent did not make this session
git commit --amend

# Blocked unless a specific stack is named
terraform destroy
pulumi destroy
cdk destroy
```

The distinction is intent, not a blanket ban. If your prompt says "reset the working tree with `git reset --hard`," the agent runs it. If it independently concludes a reset is the move, it stops and tells you instead. Same with infrastructure: `terraform destroy` targeting a specific stack you named is allowed; a bare `destroy` is not.

## Why amend gets special treatment

The `git commit --amend` rule is the subtle one. Amending a commit the agent itself made earlier in the session is fine, that is normal iterate-on-your-own-work behavior. Amending a commit it did not create rewrites history it does not own, which can quietly clobber a teammate's commit or your pre-session work. The classifier now checks authorship within the session before allowing it.

This pairs naturally with the earlier safety work: [v2.1.169's `--safe-mode`](/2026/06/claude-code-2-1-169-safe-mode-and-cd/) gives you a clean baseline to debug against, and now auto mode itself refuses to be the thing that loses your data. If you genuinely need the agent to run one of these unprompted, the move is to say so in the prompt, or drop out of auto mode for that step and approve it by hand.

## The rest of the release

2.1.183 also adds deprecation warnings when you request a model that has been superseded (surfaced on stderr in print mode and in agent frontmatter), a new `attribution.sessionUrl` setting to keep claude.ai session links out of your commits and PRs, and `/config --help` to list the shorthand keys. Bug fixes cover WebSearch returning empty in subagents, fullscreen TUI corruption on Windows Terminal, and turns completing silently when only a thinking block was produced.

Full notes are on the [v2.1.183 changelog](https://code.claude.com/docs/en/changelog).
