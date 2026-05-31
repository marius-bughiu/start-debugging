---
title: "Claude Code's Dynamic Workflows Fan a Single Prompt Out to Up to 1,000 Subagents"
description: "Anthropic shipped Opus 4.8 on May 28, 2026 with Dynamic Workflows, a research preview in Claude Code that writes a JavaScript orchestration script to run tens to hundreds of subagents in parallel, capped at 1,000 per run."
pubDate: 2026-05-31
tags:
  - "claude-code"
  - "ai-agents"
  - "opus-4-8"
---

Anthropic released Claude Opus 4.8 on May 28, 2026, and the headline for anyone living in a terminal is not the benchmark bump. It is Dynamic Workflows: a research preview inside Claude Code that turns a single natural-language request into a script that orchestrates tens to hundreds of subagents in parallel, capped at 1,000 agents per run. This is the difference between asking one agent to grind through a task in a loop and having Claude write a program that decomposes the task, fans it out, and verifies the results before reporting back.

## A workflow is a script, not a chat loop

The mechanism is the interesting part. When you ask for something large ("audit every controller for missing authorization checks" or "migrate this 200k-line codebase off Newtonsoft.Json"), Claude writes a JavaScript orchestration script and a runtime executes it in the background. You are not babysitting a single context window that slowly fills up. The script spawns fresh subagents, each with its own context, and collects their structured output.

The shape of the generated script is roughly this:

```javascript
export const meta = {
  name: 'audit-authz',
  description: 'Find controllers missing [Authorize] and verify each finding',
  phases: [{ title: 'Scan' }, { title: 'Verify' }],
};

// Fan out: one finder per area, then adversarially verify each hit
const findings = await pipeline(
  AREAS,
  area => agent(`Scan ${area} for actions missing authorization`, {
    phase: 'Scan',
    schema: FINDINGS_SCHEMA,
  }),
  review => parallel(review.findings.map(f => () =>
    agent(`Try to refute: ${f.title}. Is this really unprotected?`, {
      phase: 'Verify',
      schema: VERDICT_SCHEMA,
    }).then(v => ({ ...f, verdict: v }))
  ))
);

return findings.flat().filter(f => f.verdict?.isReal);
```

The patterns Anthropic leans on are visible here: parallel fan-out, then adversarial verification where separate agents are prompted to refute each finding before it survives. Output is validated against a JSON schema so the orchestrator gets typed data back instead of prose it has to parse.

## What it costs you, and when it triggers

The obvious risk is cost. A run that legitimately spins up hundreds of agents burns tokens fast, which is exactly why the 1,000-agent cap exists as a runaway backstop. Claude Code shows you the script and the rough plan before the first workflow fires and asks you to confirm.

There are two ways in. You can describe the objective directly and let Claude decide a workflow is warranted, or you can turn on the `ultracode` effort setting so it reaches for orchestration automatically on substantial tasks. Opus 4.8 also ships a cheaper Fast mode (about 2x the standard rate for roughly 2.5x the speed), which makes the many-small-agents pattern less punishing than it would have been on earlier releases.

Dynamic Workflows is a research preview, so treat the API surface as unstable and watch your usage. But the model underneath is sound: stop iterating one agent against a growing transcript, and start writing programs that coordinate many short-lived ones. Full details are in the [Opus 4.8 announcement](https://www.anthropic.com/news) and the [Claude Code changelog](https://code.claude.com/docs/en/changelog).
