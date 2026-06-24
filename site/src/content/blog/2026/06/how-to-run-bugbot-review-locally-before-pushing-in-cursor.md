---
title: "How to Run a Pre-Push Code Review Locally with Cursor Bugbot's /review"
description: "Cursor 3.7+ lets you run Bugbot before you push with the /review command. Here is how local review works, how the patch ID dedup stops you paying twice, and the one thing it cannot do yet."
pubDate: 2026-06-24
tags:
  - "cursor"
  - "bugbot"
  - "ai-agents"
  - "code-review"
  - "pull-requests"
---

If you use Cursor Bugbot to review pull requests, you already know the loop: open the PR, wait for the bot, read its comments, push a fix, wait again. As of the [June 10, 2026 Bugbot update](https://cursor.com/blog/bugbot-updates-june-2026), you can move that review one step earlier. Inside Cursor 3.7 or later, typing `/review` into the agent input runs Bugbot against your branch locally, before the code ever leaves your machine. The headline trick is that the local run and the eventual PR review share a patch ID, so if you push the exact same diff Bugbot skips the PR review entirely and you are not billed twice. CLI support is still listed as "coming soon," so this is an in-editor command, not yet something you can wire into a git hook. Here is the full picture.

## Why moving the review before the push is worth it

A PR-stage review is the worst place to find a bug you wrote ten minutes ago. By then the branch is pushed, CI is running, maybe a teammate already got the review-requested notification, and the context you had while writing the code has started to drain out of your head. You fix it, force-push, and the whole CI and review cycle restarts.

Running the same review locally collapses that into a single iteration. Bugbot reads your working tree, flags what it finds, and you fix it while the change is still warm, all before the first `git push`. The Bugbot powering this is the same agent that comments on your PRs, now driven by Composer 2.5, which is the model that cut the average review from roughly five minutes to about 90 seconds. Cursor reports that over 90% of Bugbot runs now finish in under three minutes, at roughly 22% lower cost per run, while finding about 10% more bugs (0.62 per default-effort run, up from 0.56). A faster, cheaper review is exactly the kind of thing you want to run more often, which is what a pre-push gate does.

## The three commands

The local review surface is three slash commands you type into the Cursor agent input (the same box you use for agent mode), not the terminal:

```text
# Cursor 3.7+, Bugbot June 2026 update
/review            # runs Bugbot AND Security Review, prompts you to pick which agents
/review-bugbot     # runs Bugbot only
/review-security   # runs Security Review only
```

`/review` is the menu: it offers both the standard bug review and the dedicated Security Review, and lets you choose. If you already know you only want the bug pass, `/review-bugbot` skips the prompt. `/review-security` runs the security-focused agent on its own, which is the one you want before pushing anything that touches auth, input parsing, or a dependency bump.

These are agent commands available "in Cursor 3.7+ and at cursor.com/agents." That last part matters: you can also kick the same review from the web agents surface, not only the desktop editor.

## What `/review-bugbot` actually looks at

By default, `/review-bugbot` reviews your branch changes, meaning every change relative to the base branch, including both committed and uncommitted work in your working tree. That is broader than a PR review, which only sees committed pushed commits. Locally, Bugbot can see the function you just typed but have not staged yet.

That breadth is usually what you want for a pre-push gate, but it can be noisy if you have a large feature branch and only want feedback on the last hour of work. The escape hatch is plain language: because this is an agent command, you can narrow it by asking. Instead of bare `/review-bugbot`, type a scoped instruction:

```text
# Narrow the review to just what you are about to commit
/review-bugbot review only my uncommitted changes
```

The agent honors the constraint and reviews only the uncommitted modifications rather than the full branch diff. There is no flag syntax to memorize here; the natural-language qualifier is the interface.

## The patch ID dedup is the actual headline

The feature that makes local review more than a convenience is deduplication. When you run `/review-bugbot`, Cursor stores the patch ID of the diff it reviewed. A patch ID is a stable hash of the change content itself, independent of commit SHAs, so the same set of edits produces the same patch ID whether it is uncommitted, committed, or rebased.

Later, when Bugbot running on your SCM (GitHub or GitLab) sees an incoming PR whose diff carries a patch ID it has already reviewed, it skips the review and leaves a comment noting it already reviewed that diff. In practice:

1. You finish a change and run `/review-bugbot` locally.
2. Bugbot reviews it, you address the findings, you push.
3. You open the PR. The pushed diff matches the patch ID from step 1.
4. Bugbot recognizes the duplicate, does not re-review, and posts a short comment saying so.

You got the early signal and you were not charged for an identical second review. This is the mechanism that makes "review locally first" economically free rather than a doubling of your review bill. If you amend the diff after the local review (you fix the bugs Bugbot found, which changes the content), the patch ID changes and the PR gets a fresh review, which is correct: the code is no longer the same code.

There is a related setting worth turning on: Bugbot can be configured to only review what is new since its last review, which keeps incremental feedback focused on your latest commits instead of re-flagging the whole branch every time.

## Make the local review match the PR review with BUGBOT.md

The local and remote Bugbot read the same rules, so the more you teach Bugbot, the more your pre-push run looks like the eventual PR verdict. Project rules live in `.cursor/BUGBOT.md` files, and they are hierarchical. The root file is always included, and any nested `.cursor/BUGBOT.md` files along the path to a changed file are pulled in when those files are touched:

```text
project/
  .cursor/BUGBOT.md          # always included, project-wide rules
  backend/
    .cursor/BUGBOT.md        # included when backend files change
    api/
      .cursor/BUGBOT.md      # included when API files change
```

A `BUGBOT.md` is just instructions in Markdown. You write the gates you care about in prose:

```markdown
<!-- backend/api/.cursor/BUGBOT.md -->
# API review rules

- Any new endpoint must validate the request body before use. Flag handlers
  that read `req.body` fields without a schema check as a blocking bug.
- Backend changes under `src/**` that lack a matching test change are a
  blocking bug. New code paths need coverage.
- `TODO` and `FIXME` comments are non-blocking, but auto-resolve if the
  comment references an existing issue number.
- Flag any use of `eval(` or `exec(` as a blocking security bug.
```

Beyond the file-based rules, the Bugbot dashboard holds manual rules and learned rules. Each rule has three fields: a short Name, the Rule content (the instructions Bugbot follows), and optional Scoped paths, a glob like `src/components/**` that limits where the rule applies. Leave the glob empty and the rule covers the whole repo. Learned rules are generated automatically from how your team resolves Bugbot comments on GitHub, and you can seed them by hand too. You can also teach Bugbot inline by commenting `@cursor remember <fact>` on any PR, which saves that fact as a learned rule for future reviews, local ones included.

The payoff: a `/review-bugbot` run on your laptop applies the same rules your PR review would, so a clean local pass is a strong predictor of a clean PR pass. If you have ever wanted the per-repo control that the cloud reviewer gives you, the [effort levels Cursor added to Bugbot in May 2026](/2026/05/cursor-bugbot-effort-levels-pr-review/) and these rule files stack: effort decides how hard it thinks, the rules decide what it cares about.

## The one thing it cannot do yet: a real pre-push hook

Here is the honest limitation. "Pre-push code review" suggests a git `pre-push` hook that blocks the push until review passes. You cannot build that today, because the review runs inside the Cursor agent and CLI support is, in Cursor's own words, "coming soon." There is no `cursor bugbot review` shell command to call from `.git/hooks/pre-push`.

If you try to wire it up anyway, you end up with a stub that cannot actually invoke the reviewer:

```bash
#!/usr/bin/env sh
# .git/hooks/pre-push -- does NOT work yet, June 2026
# There is no Bugbot CLI to call here. Left as a placeholder until
# Cursor ships CLI support (currently "coming soon").
echo "Run /review-bugbot in the Cursor agent input before pushing."
exit 0   # cannot block on a review that has no headless entry point
```

So the pre-push gate is a discipline, not an enforced hook: you run `/review-bugbot` manually before you push, the same way you might run tests manually. Treat it as the default last step on a feature branch. When the CLI lands, this is the piece that turns into a real blocking hook, and a scriptable review also opens the door to the kind of [autonomous PR review you can already run from a GitHub Action with Claude Code](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/). For now, the value is the tight local loop plus the dedup, not enforcement.

## Cost, in real numbers

Cursor's published figures are about speed and relative cost: 3x faster, 22% cheaper per run, 10% more bugs. For absolute dollars, one [third-party analysis of the June release](https://www.digitalapplied.com/blog/cursor-bugbot-90-second-reviews-june-2026-release) estimates a run at roughly 1.00 to 1.50 USD depending on PR size, which works out to around 1.60 to 2.40 USD per bug caught at default effort. Treat that as an external estimate, not a Cursor SLA, but it sets the scale: a local review is cheap enough to run on every branch, and the patch ID dedup means running it locally does not add a second charge when the PR opens with the same diff.

One more operational note: Bugbot respects organizational model block lists with automatic fallback, so if your org disallows a given model, the local review falls back rather than failing. That keeps the local command consistent with whatever governance your team already configured for the cloud reviewer.

## Where this fits in a Cursor workflow

Local `/review` is part of a broader pattern of Cursor unbundling its agents into knobs you control per workflow. It pairs naturally with the [unified PR review Cursor shipped in 3.3](/2026/05/cursor-3-3-build-in-parallel-split-prs/) and with [Cursor 3.9 bundling your rules and agent setup into portable plugins](/2026/06/cursor-3-9-plugins-bundle-skills-rules-mcps-hooks/), so a team can ship the same `BUGBOT.md` gates everywhere. If you are still deciding which agent owns review in your stack, the trade-offs are laid out in [Claude Code vs Cursor vs Copilot agent mode](/2026/06/claude-code-vs-cursor-vs-copilot-agent-mode-where-each-wins/).

The short version: type `/review-bugbot` before you push, fix what it finds, and let the patch ID dedup make the eventual PR review free. The only thing missing is the headless CLI, and that is the next shoe to drop.

## Sources

- [Bugbot is now over 3x faster, 22% cheaper, and finds 10% more bugs (Cursor blog, June 10, 2026)](https://cursor.com/blog/bugbot-updates-june-2026)
- [Bugbot documentation (Cursor Docs)](https://cursor.com/docs/bugbot)
- [Cursor Bugbot 90-second reviews, June 2026 release analysis (Digital Applied)](https://www.digitalapplied.com/blog/cursor-bugbot-90-second-reviews-june-2026-release)
