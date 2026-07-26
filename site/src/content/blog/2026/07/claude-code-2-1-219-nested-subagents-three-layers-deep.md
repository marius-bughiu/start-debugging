---
title: "Claude Code 2.1.219 Reopens Nested Subagents, Three Layers Deep"
description: "Version 2.1.219 raises the default subagent spawn depth from 1 to 3, adds a workflowSizeGuideline settings key, and ships a fail-closed sandbox network allowlist."
pubDate: 2026-07-26
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
---

The last two weeks of Claude Code releases have been a tug of war over how much rope an agent fleet gets. Version 2.1.213 took nesting away entirely. Version 2.1.219, which landed on July 24, 2026, hands it back with a number attached: subagents can now spawn their own subagents up to depth 3 by default, up from 1.

## The default flipped twice in two weeks

The [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) line is blunt: "Subagents can now spawn nested subagents up to depth 3 by default (was 1); set CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1 to disable nesting".

The history is worth tracking, because the behavior has moved three times. From v2.1.172 through v2.1.216, subagents nested up to five layers deep and the limit was not configurable. Then 2.1.213 [put hard caps on runaway subagent fleets](/2026/07/claude-code-2-1-213-caps-runaway-subagent-fleets/) and dropped the default to depth 1, meaning a subagent could not delegate at all: ask it to spin up helpers and it did the work itself. 2.1.219 settles on 3.

The knob is unchanged, only its default moved. To go back to flat, single-layer delegation, pin it in `settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1"
  }
}
```

Depth 3 is a deliberate number rather than a round one. It is exactly what a review fan-out needs: your main conversation spawns a reviewer, the reviewer spawns one verifier per finding, and each verifier can still delegate a focused lookup. At depth 1 that shape collapsed into a single subagent doing everything sequentially in one context window.

## A size guideline as the counterweight

Reopening nesting without a brake would just recreate the problem 2.1.213 fixed, so the same release adds one. Dynamic workflows now default to a medium size guideline, aiming for fewer than 15 agents, and the guideline is no longer a `/config` toggle only. There is a settings key for it:

```json
{
  "workflowSizeGuideline": "medium"
}
```

Set it in any settings file and the `/config` row hides itself. The running-workflow status line now prints the current size too, so you can see which guideline a workflow is operating under while it runs. Note that this is advisory: it shapes how many agents the model aims to spawn, not a hard ceiling. The real ceilings are still the concurrency and per-session subagent limits.

## Fail-closed network allowlists

The other change worth wiring up today is `sandbox.network.strictAllowlist`. By default, the sandbox prompts the first time a command needs a domain you have not allowed. Managed deployments could already block instead of prompting via `allowManagedDomainsOnly`. Now any settings file can be fail-closed:

```json
{
  "sandbox": {
    "enabled": true,
    "network": {
      "strictAllowlist": true,
      "allowedDomains": ["github.com", "*.npmjs.org"]
    }
  }
}
```

For unattended runs, this is the setting you want. A prompt nobody answers is a hang, and with nesting back on there are more processes that can hit one.

Also in 2.1.219: Claude Opus 5 (`claude-opus-5`) is the default Opus model with 1M context and fast mode at $10/$50 per Mtok, and Opus 4.7 dropped out of fast mode entirely.
