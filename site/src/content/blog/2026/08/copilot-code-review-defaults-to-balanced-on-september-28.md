---
title: "Copilot Code Review Defaults to Balanced Effort on September 28"
description: "GitHub's August 27 and August 28, 2026 changelogs remove the 20,000 line review cap, start reviewing bot-authored PRs, and flip the default review effort from Lite to Balanced on September 28. All three push AI credit consumption up in the same month."
pubDate: 2026-08-31
tags:
  - "github-copilot"
  - "code-review"
  - "ai-agents"
  - "devops"
---

GitHub published two changelog entries in as many days that, read together, change both what Copilot code review looks at and what it costs. On August 27, 2026 the review size cap disappeared and bot-authored pull requests became reviewable. On August 28, 2026 GitHub announced that on **September 28, 2026** the default review effort level flips from Lite to Balanced. Nothing in either announcement is opt-in.

## Three multipliers landing in one month

The August 27 entry, [Copilot code review: resolution reasons and expanded capabilities](https://github.blog/changelog/2026-08-27-copilot-code-review-resolution-reasons-and-expanded-capabilities/), removed the ceiling that used to stop a review at 300 files or 20,000 lines of code. Big refactors and generated-code PRs that Copilot silently skipped now get reviewed in full. The same entry made pull requests authored by bots eligible for automatic review, explicitly including the Copilot cloud agent, so agent-opened PRs are now reviewed by the reviewer instead of walking straight into a human queue.

Then the [policies and billing entry](https://github.blog/changelog/2026-08-28-upcoming-changes-to-github-copilot-policies-and-billing/) changes the default effort. GitHub's own docs are blunt about the tradeoff: Lite is a "standard review", Balanced does "deeper analysis of complex logic, security-sensitive code, and cross-service changes", and Balanced reviews "use more AI credits, and may consume marginally more GitHub Actions minutes."

More PRs reviewed, larger diffs per review, and a deeper model pass on each one. If you budgeted AI credits off July's invoice, September will not match it.

## Pin Lite before September 28 if you want today's behaviour

The effort level lives at both org and repo scope, and the repo setting wins. Settings, then Copilot, then Code review, under "Code, planning, and automation". Setting it explicitly to Lite before September 28 keeps current behaviour; leaving it untouched opts you into Balanced.

Worth auditing at the same time: the `review_on_push` flag in your rulesets. It re-reviews on every push, so it multiplies against the deeper default rather than adding to it. The rule type is `copilot_code_review`, so you can inspect it without clicking through every repo:

```bash
gh api /repos/OWNER/REPO/rulesets --jq '.[].id' \
  | xargs -I{} gh api /repos/OWNER/REPO/rulesets/{} \
      --jq '.rules[] | select(.type=="copilot_code_review")'
```

A rule that fires on every push looks like this:

```json
{
  "type": "copilot_code_review",
  "parameters": {
    "review_on_push": true,
    "review_draft_pull_requests": true
  }
}
```

On a branch where people push six times before requesting review, `review_on_push` plus `review_draft_pull_requests` is six Balanced reviews of a diff nobody has looked at yet.

## Resolution reasons finally make the comments measurable

The one unambiguously good change: resolving a Copilot review comment now takes a reason from a dropdown next to "Resolve conversation". The options are **Addressed**, **Won't fix**, and **Incorrect**. That third value is the one that matters, because it is the first time the false-positive rate of automated review is a number you can pull rather than a feeling your senior engineers have. Before you turn Balanced loose across every repo, spend a sprint tagging on Lite and see what the ratio actually is.

Two other dates from the same entry: new Business and Enterprise seat assignments require payment before access starting September 1, 2026, existing customers see upfront seat charges from October 1, 2026, and the unified Copilot experience arriving September 28 extends chat data retention from 28 days to the lifetime of the account. That last one is on by default and opting out costs you Copilot Chat on github.com and mobile entirely, so it is a compliance review, not a preference toggle.

For the review context side of the same product, see [Copilot code review now reads your .github/skills folder](/2026/07/copilot-code-review-agent-skills-and-mcp-ga/).
