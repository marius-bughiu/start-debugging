---
title: "Claude Code 2.1.119 Pulls PRs From GitLab, Bitbucket, and GitHub Enterprise"
description: "Claude Code v2.1.119 expands --from-pr beyond github.com. The CLI now accepts GitLab merge-request, Bitbucket pull-request, and GitHub Enterprise PR URLs, and a new prUrlTemplate setting points the footer PR badge at the right code-review host."
pubDate: 2026-04-27
tags:
  - "claude-code"
  - "ai-agents"
  - "gitlab"
  - "bitbucket"
---

The latest Claude Code release, v2.1.119, lands a small but overdue change for non-GitHub teams: `--from-pr` now accepts GitLab merge-request URLs, Bitbucket pull-request URLs, and GitHub Enterprise PR URLs, and a new `prUrlTemplate` setting points the footer PR badge at a custom code-review URL instead of github.com. Until this release, the PR-review flow assumed every code-review host was github.com, which made the feature awkward for any shop on GitLab or Bitbucket Cloud.

## What --from-pr does, and why the host matters

`--from-pr` is the flag for "launch a session against this pull request": you paste a PR URL, Claude Code checks out the head branch and primes the session with the diff and the review thread. It has been the cleanest way to start an agent run targeted at a specific code review since it shipped, but the URL parser was tied to `github.com/owner/repo/pull/<n>`. Any non-GitHub URL fell through the parser and the session lost the review context.

v2.1.119 generalizes the URL handling. The shapes the changelog explicitly calls out are GitLab merge-request URLs, Bitbucket pull-request URLs, and GitHub Enterprise PR URLs:

```bash
claude --from-pr https://github.com/acme/api/pull/482
claude --from-pr https://gitlab.com/acme/api/-/merge_requests/482
claude --from-pr https://bitbucket.org/acme/api/pull-requests/482
claude --from-pr https://github.acme.internal/acme/api/pull/482
```

Same flag, same flow, four different review hosts.

## prUrlTemplate replaces the github.com footer link

Even with `--from-pr` working, one piece of friction remained: the footer badge that surfaces the active PR was pinned to github.com, because the URL was hardcoded into the CLI. v2.1.119 adds a `prUrlTemplate` setting that points that badge at a custom code-review URL instead. The same release also notes that `owner/repo#N` shorthand links in agent output now use your git remote's host instead of always pointing at github.com, so the rewrite is consistent across the surface.

`prUrlTemplate` lives in `~/.claude/settings.json` like other Claude Code config. The new release also persists `/config` settings (theme, editor mode, verbose, and similar) into the same file with project/local/policy override precedence, so an organization can ship `prUrlTemplate` through `~/.claude/settings.policy.json` and stop every developer from setting it by hand.

## Why this matters for .NET shops on GitLab

Most .NET teams that moved off Azure DevOps in the last few years landed on GitHub or self-hosted GitLab, often with a long tail of internal repos that mirror to a GitHub Enterprise instance for OSS interop. Until now, pointing Claude Code at one of those non-GitHub repos meant either:

1. Round-tripping the PR through a temporary clone of a github.com mirror, or
2. Doing the review by pasting the diff into the conversation manually.

With v2.1.119 plus a `prUrlTemplate` baked into the org's policy file, the same `claude --from-pr <url>` flow works across the full mix. The earlier v2.1.113 release that switched the [CLI to a native binary](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) means there is no Node.js runtime to install on the build agents that run automated PR-review jobs either, which makes this rollout an easier sell on tightly managed CI fleets.

If you ship a `~/.claude/settings.policy.json` for your team, this is the week to add the `prUrlTemplate` line. Full release notes for v2.1.119 are in the [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
