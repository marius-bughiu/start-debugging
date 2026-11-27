---
title: "Copilot Code Review Billing Defaults to the Organization on December 30"
description: "GitHub's November 25, 2026 changelog flips the unset Copilot code review billing choice for licensed members from Member to Organization on December 30. Who is affected, what stays the same, where the setting lives, and a gh script to size the AI credits your org is about to absorb."
pubDate: 2026-11-27
tags:
  - "github-copilot"
  - "code-review"
  - "ai-agents"
  - "billing"
---

GitHub posted a short changelog on November 25, 2026 that will change who pays for a lot of Copilot code reviews: [Copilot code review billing will default to the organization](https://github.blog/changelog/2026-11-25-copilot-code-review-billing-will-default-to-the-organization). If your organization or enterprise on Copilot Business or Copilot Enterprise never saved a billing choice for members with a Copilot license, those reviews move from the member's entitlement to the organization's AI credits starting **December 30, 2026**.

## What actually flips

The setting was added in October as "Choose how members with a Copilot license are billed", with two explicit options: **Member** (use the requesting member's Copilot entitlement, and fail the review if that quota is exhausted) and **Organization** (bill the organization that owns the repository). Until now, an unset value behaved like Member. After December 30, an unset value behaves like Organization.

The fine print from the changelog:

- If you already picked **Member** or **Organization**, nothing changes.
- The separate setting for members **without** a Copilot license is untouched.
- Accounts without AI Credits paid usage enabled, with a billing lock, or with no billable customer get set to **Member** instead, so nobody gets surprise overage they cannot pay.
- If the enterprise manages the setting, only an enterprise owner can choose.

Until the switch, unset settings show **Default (Member)** with a notice. Note that the [configuration docs](https://docs.github.com/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review) already describe **Default** as billing the organization, so trust the changelog's date, not the docs wording, for the next month.

## Why this matters for cost

The upside is real: reviews stop failing when a developer burns through their monthly quota halfway through a release week. The downside is that the organization now absorbs every review, including the automatic ones fired by rulesets on every push. GitHub's [code review concepts page](https://docs.github.com/en/copilot/concepts/agents/code-review) estimates a Balanced review at roughly $0.25 to $5 of AI credits and a Lite review at $0.05 to $1, and Balanced has been the default since September 28. Setting a budget is optional, which means "optional" is the default too.

## Size the exposure before December 30

Billing is not in the REST API (the docs say billing "is not available through the API"), but you can count what your repositories already consume. This sketch counts Copilot reviews on PRs updated in the last 30 days and reads the effort line Copilot writes into each review body:

```bash
#!/usr/bin/env bash
# usage: ./copilot-review-count.sh OWNER/REPO
repo="$1"
since=$(date -u -v-30d +%Y-%m-%d 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%d)

gh pr list -R "$repo" --state all --limit 500 \
  --search "updated:>=$since" --json number --jq '.[].number' |
while read -r pr; do
  gh api "repos/$repo/pulls/$pr/reviews" --paginate \
    --jq '.[] | select(.user.login=="copilot-pull-request-reviewer[bot]") | .body' |
    grep -o 'Review effort:\*\* [A-Za-z]*' || true
done | sort | uniq -c
```

Multiply the Lite and Balanced counts by the per-review ranges above and you have a rough monthly figure for each repository.

## Decide, then save the choice

To keep today's behavior, open the organization's **Settings > Copilot > Code review** and select **Member** next to "Choose how members with a Copilot license are billed". At the enterprise level the same control lives under **AI controls > Copilot > Configure features & clients**, with an extra **Let organizations decide** option. Saving either value, even the one you want after the flip, takes the decision out of the default's hands.

If you choose Organization, pair it with a budget and a deliberate effort level. The [effort precedence chain for API-requested reviews](/2026/10/how-to-request-a-copilot-code-review-from-the-rest-api-and-set-its-effort-level/) decides which rate each review is billed at, and that is now the organization's money.
