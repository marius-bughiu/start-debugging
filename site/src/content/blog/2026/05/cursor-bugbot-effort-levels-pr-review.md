---
title: "Cursor Bugbot Adds Default, High, and Custom Effort Levels"
description: "On May 11, 2026, Cursor shipped effort levels for Bugbot. Default finds 0.7 bugs per review, High pushes it to 0.95, and Custom lets you describe in plain English when each mode should kick in."
pubDate: 2026-05-12
tags:
  - "cursor"
  - "bugbot"
  - "ai-agents"
  - "pull-requests"
---

On May 11, 2026, Cursor [shipped effort levels for Bugbot](https://cursor.com/changelog), the PR review agent that comments on pull requests opened against repos it watches. Until now, every review ran the same loop with the same budget. The new release gives Teams admins and Individual users on usage-based billing three knobs: Default, High, and Custom. The numbers Cursor published with the release are worth pinning down before talking about how to configure it.

## Default versus High, in measured bugs per run

Cursor reports two concrete numbers in the [changelog entry](https://cursor.com/changelog):

- **Default** averages **0.7 bugs found per review** and is described as "optimized for efficiency and speed." Over 79% of the issues it flags are resolved before the PR merges, which is the part that matters for signal-to-noise.
- **High** averages **0.95 bugs found per review**. It spends more on reasoning tokens and takes longer per PR.

That is a 36% lift in bugs per run, paid for with extra latency and tokens. Whether the trade is worth it is a question of where your PRs cluster: a repo with a long tail of subtle regressions is a different problem than a repo where most bugs are obvious within ten seconds of reading the diff. Cursor is not making that decision for you, which is the point of the third mode.

## Custom is a natural-language router

Custom mode does not give you a slider or a YAML schema. You write a short instruction, and Bugbot uses it as a routing prompt to pick Default or High per review. The pattern Cursor suggests in the [Bugbot docs](https://docs.cursor.com/en/bugbot) reads more like a triage rule than a config file:

```text
Use High effort for any PR that:
- touches files under src/billing/** or src/auth/**
- changes a database migration (paths matching db/migrations/**)
- modifies a public API surface (anything in src/api/v1/**)

Use Default effort for everything else, including
documentation, tests, and dependency bumps.
```

You paste that into the Bugbot dashboard under your repo's effort setting. On the next PR, Bugbot reads the diff metadata, applies the rule, and picks a mode before the review starts. There is no compile step and no `bugbot.yaml`. If the rule is ambiguous, Bugbot falls back to Default.

## Where to set it

Effort lives at the repository level, not the user level, so a single repo cannot have one engineer on High and another on Default. The setting is in the Bugbot dashboard at `cursor.com/dashboard/bugbot/<repo>`, under "Review effort." Teams admins set it globally for an organization's repos. Individual plan users on usage-based billing see the same panel for their own repos. Flat-rate Individual plans do not get effort selection: that bucket stays on Default.

## Picking a mode without burning the budget

The honest read is that **High is not a "make it smarter" button, it is a "spend more" button**. A 36% lift in bugs per run also implies roughly 36% more tokens billed against your usage cap, and the latency hit shows up most painfully on PRs you want to merge before lunch. Custom is the only mode that lets you keep that bill bounded: write a rule that targets the parts of the codebase where a missed bug actually costs you, and leave the rest on Default. If you cannot articulate that rule in three lines of English, you probably do not need High at all.

The release ships alongside Cursor 3.3's [parallel build and split PR features](/2026/05/cursor-3-3-build-in-parallel-split-prs/), which is the broader pattern: Cursor is unbundling its agents into knobs you can configure per workflow, not one default that has to please everyone.
