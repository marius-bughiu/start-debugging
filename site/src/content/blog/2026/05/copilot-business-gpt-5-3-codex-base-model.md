---
title: "GPT-5.3-Codex Becomes the Copilot Business and Enterprise Base Model"
description: "On May 17, 2026 GitHub flipped the default Copilot model on Business and Enterprise plans from GPT-4.1 to GPT-5.3-Codex. GPT-4.1 stays free until June 1, then it falls under usage-based billing. Here is what changes for pinned models in your repo and CI."
pubDate: 2026-05-18
tags:
  - "github-copilot"
  - "ai-agents"
  - "openai"
---

GitHub started rolling [GPT-5.3-Codex as the new base model for Copilot Business and Enterprise plans on May 17, 2026](https://github.blog/changelog/2026-05-17-gpt-5-3-codex-is-now-the-base-model-for-copilot-business-and-enterprise/). It replaces GPT-4.1 as the default for the entire plan tier, and it is GitHub and OpenAI's first long-term support model on Copilot: the LTS window guarantees the model stays selectable through 2027-02-04.

Individual seats (Copilot Pro, Pro+, Free) are not affected. The change only flips the default for Business and Enterprise.

## What "base model" actually controls

Base model is the one Copilot uses when a request does not pin a specific model. Anywhere you wrote `model: gpt-4.1` in a Copilot config, that is unchanged for now. Anywhere you let Copilot pick, the answer just changed from GPT-4.1 to GPT-5.3-Codex.

GPT-5.3-Codex has a 1x premium request multiplier, the same as GPT-4.1, so the per-request cost on Business and Enterprise SKUs does not move with this swap. Inline completions, Chat without a pinned model, and the cloud agent's `auto` selection all flip together.

## What changes for repos pinning the old default

Two places to scan before 2026-06-01. After that date, requests still pinned to `gpt-4.1` start billing under the usage-based meter instead of being included.

```bash
# 1. Workflow files that pin a Copilot model
grep -RE "model:\s*gpt-4\.1" .github/ 2>/dev/null

# 2. Copilot agent and Chat custom instructions
grep -R "gpt-4.1" .copilot/ .github/copilot-instructions.md 2>/dev/null
```

If the project's CI runs Copilot CLI or Copilot cloud agent tasks against a pinned GPT-4.1, there are two options: bump the pin to `gpt-5.3-codex`, or accept the line-item charge from June 1 forward. A YAML pin for the new default looks the same shape:

```yaml
# .github/workflows/copilot-review.yml
- uses: github/copilot-action@v1
  with:
    model: gpt-5.3-codex
    effort: high
```

## Why GitHub picked a Codex variant for the LTS slot

GPT-5.3-Codex is the code-tuned sibling in the GPT-5.3 family. GitHub's stated metric in the rollout post was code survival rate, the share of accepted suggestions that are still in the file after subsequent edits and PR merges. The changelog reports a significantly higher rate among Business and Enterprise customers in the rollout cohort against GPT-4.1, which is the rationale for designating it the LTS base instead of the generalist GPT-5.3.

The LTS designation matters more than the model swap itself. GitHub deprecates models on a rolling basis with little notice. [Claude Sonnet 4 was removed from every Copilot surface eleven days earlier](/2026/05/copilot-deprecates-claude-sonnet-4-may-2026/) with a two-paragraph changelog and no migration window. The Codex LTS commitment is GitHub's first dated availability guarantee on a Copilot model, and the rest of the lineup does not get one.

GPT-4.1 access continues at no extra charge until 2026-06-01. After that, the meter starts.
