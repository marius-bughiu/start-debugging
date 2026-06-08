---
title: "Claude Code's Security-Guidance Plugin Reviews Its Own Diffs Before You Commit"
description: "Anthropic shipped a free security-guidance plugin for Claude Code that scans the agent's own edits for vulnerabilities in three layers, from a no-cost pattern match to an agentic review on commit."
pubDate: 2026-06-08
tags:
  - "claude-code"
  - "ai-agents"
  - "security"
---

Anthropic shipped a free [security-guidance plugin](https://code.claude.com/docs/en/security-guidance) for Claude Code in late May 2026 that does something most AI coding setups skip: it makes the agent review its own diffs for vulnerabilities while it works, then fix what it finds in the same session. The pitch is simple. The cheapest security bug to fix is the one that never reaches the pull request, and a separate reviewer with no investment in the original approach catches more than the model that wrote the code.

## Three layers, only one of which costs tokens

The plugin runs at three points, each at a different depth.

The first fires on every `Edit`, `Write`, or `NotebookEdit`. It is a deterministic string match with no model call, so it adds zero usage cost. It flags risky constructs the moment they land:

- Dynamic execution: `eval(`, `new Function`, `os.system`, `child_process.exec`
- Unsafe deserialization: `pickle`
- DOM injection: `dangerouslySetInnerHTML`, `.innerHTML =`, `document.write`
- Edits under `.github/workflows/`, which can quietly grant repo-level permissions

Each warning fires once per pattern per file per session, so it does not flood the conversation.

The second layer runs at the end of each turn. The plugin diffs everything that changed in the working tree, including Bash and subagent edits, and hands it to a separate Claude review focused on security. This is where the string match cannot reach: authorization bypass, insecure direct object references, SSRF, weak cryptography. It runs in the background, covers up to 30 changed files, and fires at most three times in a row.

The third layer triggers when Claude runs `git commit` or `git push` through its Bash tool. This one is agentic: it reads callers, sanitizers, and related files to decide whether a finding is real before reporting it, which keeps false positives down on code that looks dangerous in isolation but is safe in context. It is capped at 20 reviews per rolling hour. Commits you run from your own shell are not reviewed.

Both model-backed layers default to Claude Opus 4.7 as the reviewer.

## Install and extend

You need Claude Code 2.1.144 or later and Python 3.8 on your `PATH`. Install from the official marketplace:

```text
/plugin install security-guidance@claude-plugins-official
/reload-plugins
```

The per-edit layer is extensible without touching the model. Drop a `.claude/security-patterns.yaml` in your repo and add your own rules:

```yaml
patterns:
  - rule_name: tenant_unfiltered_query
    regex: "\\.objects\\.all\\(\\)"
    paths: ["**/src/tenants/**"]
    reminder: "Multi-tenant code must filter by org_id."
```

None of the three layers block writes or commits. Findings reach the writing Claude as instructions, and the reviewer can still miss things. Treat it as one layer of defense in depth: it sits in-session, ahead of `/security-review` on demand and full Code Review on the PR. For the exact hook events and env-var toggles, the [plugin docs](https://code.claude.com/docs/en/security-guidance) lay it all out.
