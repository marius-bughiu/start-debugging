---
title: "GitHub Copilot Drops Claude Sonnet 4 From Every Surface"
description: "GitHub deprecated claude-sonnet-4 on May 6, 2026 across Copilot Chat, inline edits, ask and agent modes, and code completions. Recommended migration target is Claude Sonnet 4.6. What to grep for in your repo before the next pinned model selection silently breaks."
pubDate: 2026-05-10
tags:
  - "github-copilot"
  - "ai-agents"
  - "claude"
---

GitHub [removed Claude Sonnet 4 from every Copilot surface on May 6, 2026](https://github.blog/changelog/2026-05-07-claude-sonnet-4-deprecated/). Not just the model picker in Chat. The deprecation covers Copilot Chat, inline edits, ask mode, agent mode, and code completions. The recommended migration target is Claude Sonnet 4.6 (`claude-sonnet-4-6`).

The changelog itself is two short paragraphs. The interesting part is what it does not say.

## What the announcement actually covers

Verbatim from the post: "We have deprecated the following model across all GitHub Copilot experiences (including Copilot Chat, inline edits, ask and agent modes, and code completions) on May 6, 2026."

That is the full list of named surfaces. Copilot CLI is not enumerated. Custom instructions are not enumerated. Whether requests pinned to `claude-sonnet-4` get auto-routed to a successor or fail outright is not stated. "Please update your workflows and integrations to use supported models" is the only migration guidance offered.

If you are running Sonnet 4 anywhere it was selectable, treat it as removed and plan accordingly. Do not assume an auto-route is in place.

## Where Sonnet 4 hides in a typical repo

The model selector in the IDE picks one place. The pinned model in your repo configuration picks another, and that is the one that quietly stops working. Three locations to grep before you ship the next change:

```bash
# 1. VS Code workspace and user settings
grep -R "claude-sonnet-4" .vscode/ "$HOME/.config/Code/User/settings.json" 2>/dev/null

# 2. Copilot custom agent / skill manifests
grep -R "claude-sonnet-4" .github/copilot/ .github/agents/ 2>/dev/null

# 3. Workflow files that invoke Copilot CLI or the Copilot agent
grep -R "claude-sonnet-4" .github/workflows/
```

The string to look for is the literal model id `claude-sonnet-4`. Not `claude-sonnet-4-5`, not `claude-sonnet-4-6`, both of which are still supported. A find-and-replace with a word boundary is the safe move:

```bash
# Replace only the bare id, leave 4-5 and 4-6 alone
git ls-files | xargs sed -i 's/\bclaude-sonnet-4\b/claude-sonnet-4-6/g'
```

In a Copilot agent skill or custom instruction file, the change usually looks like this:

```yaml
# .github/copilot/agents/review.yml
- name: code-review
-   model: claude-sonnet-4
+   model: claude-sonnet-4-6
    instructions: |
      Review the diff against the project conventions.
```

## Why Sonnet 4.6 is the right default, not Opus 4.7

Sonnet 4.6 is the same family, similar latency profile, and noticeably stronger on the long-context and agent-loop benchmarks Sonnet 4 was tuned against. For PR review, inline edits, and agent-mode loops where you fire a lot of cheap calls, Sonnet 4.6 is the drop-in. Reach for [Claude Opus 4.7 only on the work that justifies the spend](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/), like security-critical diffs or hard refactors.

If you maintain a Copilot rollout for a team, send the announcement link, run the grep, and update the pinned model in the same PR. Quiet deprecations that "just work most of the time because nobody pinned the id" are the ones that bite you on a Tuesday morning when one engineer's pipeline is suddenly the only red build.
