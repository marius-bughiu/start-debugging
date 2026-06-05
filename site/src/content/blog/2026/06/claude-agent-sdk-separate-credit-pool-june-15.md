---
title: "Claude Agent SDK and claude -p Get Their Own Credit Pool on June 15"
description: "Anthropic is splitting programmatic Claude usage off your subscription on 2026-06-15. Here is what counts as programmatic, the per-plan credit, and how to keep your CI agents from silently stalling."
pubDate: 2026-06-05
tags:
  - "claude-code"
  - "ai-agents"
  - "anthropic"
---

If you run Claude in a pipeline, mark 2026-06-15 on your calendar. Starting that day, Anthropic moves all programmatic Claude usage off your subscription limits and onto a separate, finite monthly credit pool billed at standard API list prices. Interactive chat and the interactive terminal stay exactly as they are. The change only hits the workloads you cannot watch in real time, which is precisely the category most likely to break quietly.

## What counts as "programmatic"

The split is about how Claude is invoked, not which model you call. The following draw from the new credit pool instead of your plan's usage limits:

- The Claude Agent SDK in any scripted or personal project.
- `claude -p`, the non-interactive headless mode of Claude Code.
- Claude Code running inside GitHub Actions.
- Third-party apps that authenticate through the Agent SDK.

Web, desktop, and mobile chat, plus the interactive terminal session you drive by hand, remain on your subscription. So does Claude Cowork. If a human is typing, nothing changes.

## The per-plan credit

Each plan gets a fixed monthly credit, sized roughly to its tier:

| Plan | Monthly credit |
| --- | --- |
| Pro | $20 |
| Max 5x | $100 |
| Max 20x | $200 |
| Team Standard (per seat) | $20 |
| Team Premium (per seat) | $100 |
| Enterprise Premium (per seat) | $200 |

Once that credit is spent, requests either bill at API list rates or get rejected, depending on a "usage credits" overflow toggle in your account settings. A nightly agent loop that comfortably fit under a Max 20x subscription can now run out mid-month, and a CI job that used to "just work" can start returning errors the moment the pool empties.

## Make automation predictable: give it its own key

The cleanest fix is to stop having automation borrow your subscription at all. Point headless workloads at a dedicated API key, so spend is metered, attributable, and isolated from your interactive seat. In GitHub Actions that is a one-line change:

```yaml
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Claude Code headless
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          claude -p "Triage the newest issue and label it" \
            --allowedTools "Bash(gh:*)"
```

With `ANTHROPIC_API_KEY` set, `claude -p` and the Agent SDK authenticate against the API account rather than your subscription credit, so the June 15 pool never enters the picture for that job. You pay list rates either way, but now the bill lives where you can budget for it.

## Before the deadline

Three things are worth doing this week. Claim the one-time credit from the email Anthropic sent (it is a manual action in account settings). Audit what your programmatic usage actually costs at API rates, so you know whether the credit covers a week or a month. Then tell whoever owns your CI that the monthly allowance is now finite, and decide per pipeline whether overflow should bill or hard-fail.

For the authoritative terms, read the [Claude release notes](https://support.claude.com/en/articles/12138966-release-notes) and the [Anthropic newsroom](https://www.anthropic.com/news).
