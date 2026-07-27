---
title: "Cursor Router Makes Auto a Per-Request Model Decision"
description: "Cursor Router shipped on July 22, 2026. Auto now classifies every request and routes it to a different model, and the Cost, Balance, and Intelligence modes change both the quality you get and how you are billed."
pubDate: 2026-07-27
tags:
  - "cursor"
  - "ai-agents"
  - "developer-tools"
---

Cursor shipped [Cursor Router](https://cursor.com/blog/router) on July 22, 2026, and it quietly changes what the Auto model setting means. Auto used to be one routing policy aimed at keeping token spend down. It is now a decision system that sits in front of every model in your account, classifies each request by task type and complexity, and picks the model for that single request.

## Three modes, three different bills

In the model picker you select Auto, then a mode under "Optimize For". The [docs](https://cursor.com/docs/cursor-router) describe them like this:

- **Cost** uses the previous Auto routing logic. It optimizes token spend and keeps bundled Auto pricing, billed per million tokens.
- **Balance** optimizes for intelligence, speed, and cost, and bills per request at the routed model's rate.
- **Intelligence** routes to the most capable models for harder tasks, at a lower cost than running a single frontier model. Also billed per request.

That per-request billing is the part worth reading twice. Cost is the only mode that keeps the bundled rate. Cursor's own guidance is that Balance and Intelligence average about twice the price of Cost, and up to two to four times depending on the mode.

The trade is real, not marketing. Cursor reports early access customers cutting 30 to 50 percent versus running Opus 4.8 for everything, with per-commit costs of $6.76 on Intelligence and $4.63 on Balance. Intelligence lands near Fable on user satisfaction at roughly 60 percent lower cost for teams, and Balance sits above Opus 4.8 at about 36 percent lower cost.

## The routed model is hidden by default

There is a dashboard setting to display which model Auto routed to at the start of each response. Hidden is the default, and Cursor recommends leaving it hidden.

For day-to-day work that is fine. For anyone trying to reason about agent behavior it is not. When the same prompt produces a clean refactor on Monday and a mediocre one on Tuesday, the difference may be the routed model, and by default nothing in the transcript tells you. If you are evaluating the router before rolling it out to a team, turn the display on first and leave it on through the trial.

## Pin the model when the run has to be reproducible

Routing is great for interactive work and bad for anything you diff against a baseline. For CI runs, eval harnesses, and scripted agent jobs, pin an explicit model instead of inheriting Auto:

```bash
# see the exact model ids this account exposes
agent --list-models

# pin one for a run that has to be repeatable
agent -p "run the failing tests and fix them" \
  --model <id-from-list-models> \
  --output-format json
```

Cursor Router runs across desktop, web, iOS, the CLI, and the SDK. It is on by default for Teams plans, Enterprise admins enable it from the dashboard, and individual plans (Hobby, Pro, Pro+, Ultra) get it a few months after launch. Admins can restrict which modes members may pick, set the default, allow or block specific underlying models, and softly or hard enforce standardizing on Auto.

If your team is already leaning on parallel agent work, such as the [side chats that landed in Cursor 3.11](/2026/07/cursor-3-11-side-chats-parallel-agent-threads/), the router changes the cost shape of all of it at once. Check the mode your admin set before assuming the bill stayed flat.
