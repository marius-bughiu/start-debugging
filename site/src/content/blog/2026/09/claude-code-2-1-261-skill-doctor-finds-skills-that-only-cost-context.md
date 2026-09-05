---
title: "Claude Code 2.1.261 Adds /skill-doctor: Find the Skills That Only Cost You Context"
description: "A skill's body loads on demand, but its name and description sit in a listing that is always in the prompt, capped at 1% of the context window. Claude Code 2.1.261 adds /skill-doctor to say which loaded skills never get used and what each one costs, so you can prune them before the budget starts evicting the skills you do use."
pubDate: 2026-09-05
tags:
  - "claude-code"
  - "agent-skills"
  - "ai-agents"
  - "context-window"
---

Claude Code 2.1.261 shipped on September 4 with a small command that answers a question most people with a full `~/.claude/skills` directory have never been able to answer: `/skill-doctor` shows which loaded skills go unused and what they cost in context, so you can prune them. The command is not in the [commands reference](https://code.claude.com/docs/en/commands) yet, but the mechanism it reports on is documented, and it is worth understanding before you read the output.

## A skill you never invoke is not free

The usual mental model is that skills are cheap because they load lazily. That is half true. The body of a `SKILL.md` only enters the conversation when the skill is invoked. The name and description do not: Claude Code loads a listing of every skill name and description into context so the model knows what is available.

That listing has a fixed budget. Per the [skills docs](https://code.claude.com/docs/en/skills), it "scales at 1% of the model's context window", and each entry's combined description text is capped at 1,536 characters regardless. When the listing overflows the budget, Claude Code starts dropping descriptions, beginning with the skills you invoke least.

So an unused skill costs more than its own tokens. It competes for a shared budget with the skills you rely on, and a trimmed description loses exactly the keywords the model needs to match your request. The result is a skill that silently stops triggering, with no error to explain why. `/doctor` already estimated the listing's total cost and its biggest contributors; 2.1.261 splits the per-skill, used-versus-unused view into its own report.

## Turning the report into settings

Once you know which entries are dead weight, `skillOverrides` in `.claude/settings.json` changes visibility without touching a shared repo's `SKILL.md`:

```json
{
  "skillOverrides": {
    "legacy-context": "name-only",
    "deploy": "user-invocable-only",
    "old-migration-helper": "off"
  }
}
```

`"name-only"` keeps the skill listed but drops its description, freeing budget. `"user-invocable-only"` hides it from the model while leaving `/deploy` typeable. `"off"` hides it from both. For a skill you own, the frontmatter equivalent is `disable-model-invocation: true`, which removes the description from context entirely. Note that plugin skills ignore `skillOverrides`; manage those through `/plugin`.

If the report says every skill earns its place, raise the ceiling instead of cutting: `skillListingBudgetFraction` takes a fraction (`0.02` for 2%), `SLASH_COMMAND_TOOL_CHAR_BUDGET` takes a fixed character count, and `skillListingMaxDescChars` moves the 1,536-character per-entry cap. Then confirm with the Skills row in `/context`, which since v2.1.196 reports the listing size after the budget is applied rather than the full text.

The same release adds two other context dials worth knowing: `bashOutputMaxChars` and `taskOutputMaxChars` raise how much command and background-task output Claude receives inline before it spills to a file, up to 128K characters, and `--append-subagent-system-prompt-file` reads a subagent system prompt from a file when it is too large for the command line. If you are still catching up on the release train, [2.1.259 added managedMcpServers](/2026/09/claude-code-2-1-259-managed-mcp-servers-without-mdm/) two days earlier.

Full details in the [Claude Code changelog](https://code.claude.com/docs/en/changelog).
