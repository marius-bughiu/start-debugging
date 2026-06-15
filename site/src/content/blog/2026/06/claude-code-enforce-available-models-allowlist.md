---
title: "Claude Code 2.1.175 Closes the availableModels Loophole with enforceAvailableModels"
description: "For months availableModels restricted the model picker but left the Default option wide open. Claude Code 2.1.175 adds enforceAvailableModels so admins can finally pin a strict model allowlist."
pubDate: 2026-06-15
tags:
  - "claude-code"
  - "ai-agents"
  - "governance"
---

If your organization standardized on `availableModels` to control which Claude models developers can run, there has been a quiet hole in that fence the whole time. The allowlist governed `/model`, the `--model` flag, `ANTHROPIC_MODEL`, subagents, and advisor overrides, but it never touched the one option every picker shows: Default. A developer could pick Default and land on whatever the system default is for their tier, sailing right past your curated list. Claude Code 2.1.175, shipped on 2026-06-12, finally closes that gap with a new managed setting: `enforceAvailableModels`.

## Why Default was the leak

`availableModels` was always an allowlist for *named* models. The Default entry is special. It is not a model alias, it resolves to the runtime default for the account tier (Opus 4.8 on the Anthropic API for Max and pay-as-you-go, Sonnet 4.6 on subscription seats, and so on). Because Default sidesteps the named list, an admin who set this:

```json
{
  "availableModels": ["claude-sonnet-4-5", "haiku"]
}
```

still could not stop a user from selecting Default and getting the newest tier model. For teams pinning a specific version for cost or compliance reasons, that was a real bypass, not a theoretical one.

## What enforceAvailableModels actually does

Set it to `true` in managed or policy settings alongside a non-empty `availableModels` list. When the tier default is not in the allowlist, Default now resolves to the first allowed entry instead of the tier default.

```json
{
  "model": "claude-sonnet-4-5",
  "availableModels": ["claude-sonnet-4-5", "haiku"],
  "enforceAvailableModels": true,
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5"
  }
}
```

The two settings cover different scopes. `enforceAvailableModels` makes Default obey the allowlist, while the `env` block pins which version a permitted alias like `sonnet` resolves to. One caveat worth memorizing: an empty `availableModels: []` never engages enforcement, so users keep their tier Default no matter what `enforceAvailableModels` says.

## The 2.1.176 hardening pass

A day later, 2.1.176 sealed two adjacent edges. Alias model picks can no longer be redirected to a blocked model through `ANTHROPIC_DEFAULT_*_MODEL` environment variables, and `/fast` now refuses to toggle when the switch would land on a model outside the allowlist.

Just as important is the merge behavior. When `availableModels` is set in managed or policy settings, that value replaces the merged result entirely. Entries added in user or project settings cannot widen it, and `enforceAvailableModels` is replaced the same way. As of 2.1.175 this is the only way to enforce a strict allowlist; earlier versions merged the managed list with lower-precedence entries, which meant a developer could quietly append to it.

If you run Claude Code across a team and you care about which models actually execute, upgrade to 2.1.175 or later and pair `availableModels` with `enforceAvailableModels`. The full precedence rules are in the [model configuration docs](https://code.claude.com/docs/en/model-config).
