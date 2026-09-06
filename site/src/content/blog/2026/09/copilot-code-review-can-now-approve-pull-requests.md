---
title: "Copilot Code Review Can Now Approve Pull Requests"
description: "GitHub's September 1, 2026 changelog lets Copilot submit an approving review that satisfies a repository's required-approval rule. It is off by default, scoped by file globs, and dismissed on new commits. Here is what actually changes in your branch protection."
pubDate: 2026-09-06
tags:
  - "github-copilot"
  - "code-review"
  - "ai-agents"
  - "devops"
---

On September 1, 2026 GitHub shipped the change that moves Copilot code review from commentary to authority: [Copilot code review can now approve pull requests](https://github.blog/changelog/2026-09-01-copilot-code-review-can-now-approve-pull-requests/). It is in public preview for Copilot Pro, Pro+, Max, Business, and Enterprise.

Two separate things landed here, and conflating them is how teams get surprised.

## An assessment is not an approval

Every Copilot review now ends its overview comment with an approval assessment: Copilot's judgment on whether the PR is ready to approve. That part is on for everyone and changes nothing mechanically. It is a sentence in a comment, and it does not touch your merge requirements.

The second thing is the actual approving review, submitted by `copilot-pull-request-reviewer[bot]`, which counts toward a repository's required-approvals rule exactly the way a teammate's approval does. That is **off by default** and has to be turned on by an admin at the enterprise, organization, or repository level.

If you have a repository with "Require 1 approval" in a branch ruleset and you enable this, you have not added a reviewer. You have made the human one optional.

## Scope it with globs before you enable it

The repository-level setting takes a list of file globs, one per line, and only counts a Copilot approval "on pull requests where every changed file matches one of the globs". The word doing the work is *every*. A PR that touches `docs/setup.md` and `src/Payments/Charge.cs` gets no countable approval if your glob list is documentation-only. That is the correct default posture: start with the paths where a wrong approval is cheap.

Approvals are also dismissed when new commits are pushed, the same as a human approval that a repository has configured to dismiss stale reviews. So the failure mode is not a stale sign-off riding along after a force push.

## Automatic review is a ruleset rule, and it is scriptable

The approval toggle lives in settings, but whether Copilot reviews at all is a branch ruleset rule (`copilot_code_review`), so it can be created from the API instead of clicked:

```bash
gh api repos/OWNER/REPO/rulesets --method POST --input - <<'JSON'
{
  "name": "copilot-review-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    {
      "type": "copilot_code_review",
      "parameters": {
        "review_on_push": true,
        "review_draft_pull_requests": false
      }
    }
  ]
}
JSON
```

Pair that with an audit query, because GitHub does not hand you a dashboard for this. Approvals are ordinary reviews, so you can count them:

```bash
gh api "repos/OWNER/REPO/pulls/123/reviews" \
  --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]") | {state, submitted_at}'
```

Run that across merged PRs and you get the number that matters: how many merges cleared their approval bar without a person looking. Turning `review_on_push` on also multiplies premium request consumption, which stacks with the [review effort default flipping from Lite to Balanced on September 28](/2026/08/copilot-code-review-defaults-to-balanced-on-september-28/).

Enable it on generated files and docs first. Widen it when you have the audit numbers, not before.
