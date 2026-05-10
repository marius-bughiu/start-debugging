---
title: "How to Pipe Cursor's Context to an Aider Session for Multi-Agent Refactors"
description: "Cursor is the best place to plan a refactor. Aider is the best place to execute it from a terminal with cheap models and atomic git commits. This guide shows the exact pipe: dump the Cursor chat to markdown, hand it to Aider as a read-only context file, and run an architect/editor split that finishes the work."
pubDate: 2026-05-10
tags:
  - "cursor"
  - "ai-agents"
  - "llm"
  - "claude-code"
---

Cursor and Aider solve the same problem from opposite ends. Cursor (0.51 in May 2026) is a graphical editor with a Composer panel that excels at exploring a codebase and arguing about an approach. Aider (0.86) is a terminal pair-programmer that excels at landing the change: it edits files in place, commits each step with a descriptive message, and lets you swap models mid-session with a slash command. The painful part is the seam between them. You spend forty minutes reasoning through a refactor with Cursor, then you have to retype the plan into Aider because there is no first-party "send chat to terminal" button.

There is a clean workaround. Export the Cursor conversation to markdown, hand the file to Aider with `--read`, and let Aider's architect/editor split do the actual edits. The plan you already paid Cursor to produce becomes a cached, read-only context block in Aider, and the cheap editor model writes the diffs. This post walks through the exact commands, with version numbers in every code block.

## Why the seam matters more than the tools

Both tools call the same models. Cursor uses Claude Sonnet 4.6 (`claude-sonnet-4-6`) and GPT-5 under the hood; Aider's leaderboard tracks 70+ models including `claude-opus-4-7`, `claude-sonnet-4-6`, and the OpenAI o-series. The difference is workflow.

Cursor wants you in its UI. Composer's strength is the way it pulls in symbols you have not opened, follows imports, and lets you scroll through a long reasoning trace while the agent searches your codebase. That trace is the artifact. By the time Cursor has decided how to break a 4000-line `OrderProcessor` into three classes, it has already paid for the context window with hundreds of tool calls and a long chain of "ok now let me look at this other file" messages.

Aider wants you in your terminal. It applies edits to disk, runs your tests with `/run`, commits each meaningful step, and is happy to switch from `claude-opus-4-7` (architect) to `claude-sonnet-4-6` (editor) on the same turn. What Aider is bad at is rebuilding the reasoning Cursor just did. If you start a fresh Aider session with "refactor `OrderProcessor`", you will pay full architect price to rederive a plan you already have.

The pipe is the bridge. Move the plan, not the tools.

## The minimal repro: a refactor you actually want to ship

Imagine a TypeScript repo with a fat `OrderProcessor.ts` that mixes input validation, pricing, payment routing, and persistence. You opened Cursor, used Composer in agent mode to explore the file, asked it to propose a split, and after a few rounds it produced a plan with file names, method signatures, and a migration order.

You want to keep the plan, close Cursor, and run the actual edits from a terminal under git. The pipe has four steps.

### Step 1: Get the Cursor conversation onto disk

Cursor does not yet ship a built-in "Export to markdown" command, only a "Share read-only copy" link in [its docs](https://cursor.com/docs/agent/chat/export). For a local file, you need a community tool. Two work well as of May 2026.

The first option is `cursor-chat-export`, a Python CLI that reads Cursor's SQLite chat database directly. It was archived in June 2025 but still functions because Cursor has not changed the schema since:

```bash
# cursor-chat-export, last updated June 2025
git clone https://github.com/somogyijanos/cursor-chat-export.git
cd cursor-chat-export
pip install -r requirements.txt

# Discover all chats in your Cursor workspaces
./chat.py discover --search-text "OrderProcessor"

# Export the latest chat in the current workspace
./chat.py export --latest-tab --output-dir ./.cursor-exports
```

The second option, more actively maintained, is `cursor-history` (the `chi` command). On any platform with Node 20+ installed:

```bash
# cursor-history 0.4.x, May 2026
npm install -g cursor-history

# Interactive picker, scoped to the current workspace
cd ~/projects/orders-service
chi --select
# Cursor asks which chat, then dumps it to ./<title>.md
```

Both produce a single markdown file with the user prompts, the assistant responses, and the inline code blocks. That file is your plan.

If you want to skip the third-party install, the fully manual fallback is documented in the [Cursor community guide](https://forum.cursor.com/t/guide-5-steps-exporting-chats-prompts-from-cursor/2825): open `%APPDATA%\Cursor\User\workspaceStorage\<hash>\state.vscdb` on Windows (or `~/Library/Application Support/Cursor/User/workspaceStorage/...` on macOS), point `datasette` at it, and SQL out the `aichat.prompts` rows. It works, but it is one of those things you do once to prove you understood the storage layout, then never again.

### Step 2: Trim the export to the actual plan

The raw export contains every "let me look at this file" detour Cursor took. Aider does not need that. Open the markdown in any editor and keep three sections:

1. The **target state**: the new file structure, class names, and method signatures.
2. The **migration order**: which file moves first, what depends on what.
3. The **constraints**: tests that must keep passing, public APIs that cannot break, perf or memory invariants.

Drop everything else, including Cursor's tool-call traces, the file contents it read back to itself, and any "great question, here is my plan" preamble. You want a markdown file under 500 lines that reads like a senior engineer's design doc. Save it as `REFACTOR-PLAN.md` at the repo root.

A trimmed plan looks like this:

```md
# OrderProcessor refactor plan

## Target structure
- src/orders/validation/OrderValidator.ts -> all input validation
- src/orders/pricing/Pricing.ts            -> tax, discount, totals
- src/orders/payments/PaymentRouter.ts     -> Stripe vs internal split
- src/orders/persistence/OrderRepository.ts -> only DB I/O
- src/orders/OrderProcessor.ts             -> thin orchestrator

## Migration order
1. Extract OrderValidator first, no behaviour change.
2. Extract OrderRepository next, hide ORM behind an interface.
3. Pricing and PaymentRouter can land in parallel.
4. Slim OrderProcessor last, route through the new collaborators.

## Constraints
- All tests in src/orders/__tests__ must stay green at every step.
- Public API of OrderProcessor.process() must not change shape.
- No new npm dependencies.
```

### Step 3: Launch Aider with the plan as read-only context

This is the actual pipe. Aider has two flags that matter here, both documented in the [options reference](https://aider.chat/docs/config/options.html):

- `--file <path>` adds a file aider can both read **and** edit.
- `--read <path>` adds a file aider can read but not modify, and which is eligible for prompt caching.

You want the plan as `--read`, the source files as `--file`, and architect mode on:

```bash
# Aider 0.86, May 2026
aider \
  --architect \
  --model anthropic/claude-opus-4-7 \
  --editor-model anthropic/claude-sonnet-4-6 \
  --read REFACTOR-PLAN.md \
  --read CONVENTIONS.md \
  --file src/orders/OrderProcessor.ts \
  --file src/orders/__tests__/OrderProcessor.test.ts \
  --cache-prompts
```

What this command says:

- `--architect` switches Aider to the two-pass mode where the architect plans and the editor writes diffs. This is documented in [Aider's chat modes](https://aider.chat/docs/usage/modes.html). It costs noticeably less than running Opus end-to-end and produces fewer broken patches on multi-file refactors.
- `--model` picks the architect: `claude-opus-4-7` for high-quality reasoning.
- `--editor-model` picks the cheaper, faster diff writer. `claude-sonnet-4-6` is a strong default; if cost is the priority, `claude-haiku-4-5-20251001` works for straightforward edits.
- `--read REFACTOR-PLAN.md` makes the Cursor plan a permanent, cached part of the context. Aider will not edit it, and the [conventions doc](https://aider.chat/docs/usage/conventions.html) explicitly recommends `--read` for this use because of caching.
- `--cache-prompts` turns on Anthropic prompt caching so the plan and conventions are not re-billed on every turn.

Inside the session, the first thing you type is short:

```text
Read REFACTOR-PLAN.md. Execute step 1 only:
extract OrderValidator. Keep all tests green.
Commit when done.
```

Aider's architect (Opus) reads the plan, decides which methods to lift, and emits a proposal. The editor (Sonnet) turns the proposal into a search-replace block that touches `OrderProcessor.ts` and the new `OrderValidator.ts`. Aider runs your test command if you have `--auto-test` on, then commits with a generated message like `refactor: extract OrderValidator from OrderProcessor`.

After step 1 lands, you do not need to re-explain anything. The plan is still in context, the conversation history shows what step 1 did, and you say "now do step 2". Repeat until the migration is done.

### Step 4: Add and drop files as the plan moves

Aider's [in-chat commands](https://aider.chat/docs/usage.html) let you keep the working set small, which keeps token cost low and the editor model focused.

```text
> /add src/orders/persistence/OrderRepository.ts
> /add src/orders/OrderProcessor.ts
> /drop src/orders/validation/OrderValidator.ts
> Now do step 2 from the plan.
```

`/add` brings a file into the editable set, `/drop` removes one, and `/read` adds a read-only file mid-session if you forgot one at startup. `/tokens` shows the live context size, which matters because once you cross the model's window you start losing the cached plan.

If at any point the architect's output drifts from the plan, point at it: "step 2 in REFACTOR-PLAN.md says hide the ORM behind an interface, your proposal exposes the EF Core context directly". Aider will re-read the cached plan and correct itself. That ability to anchor on a stable, read-only document is the whole reason this pipe is worth setting up.

## Where the cost actually goes

Two cost saves stack here. The architect/editor split is the obvious one. Anthropic's [own architect post](https://aider.chat/2024/09/26/architect.html) measured 30 to 50 percent cost reductions on multi-file edits versus running the architect model alone, because the editor sees a much shorter context (just the proposal plus the file it has to edit, not the full repo map).

The less obvious save is prompt caching. Sonnet 4.6 and Opus 4.7 both honour cached prefixes. With `--cache-prompts` and a stable `--read REFACTOR-PLAN.md`, every turn after the first one bills the plan at the cached rate, which is roughly a tenth of the input rate. If your plan is 8000 tokens (a real number for a substantive refactor doc), that one flag saves you most of the planning cost across a 20-turn refactor session. The matching pattern for Anthropic apps is the same one we walked through in [adding prompt caching to an Anthropic SDK app](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/), just applied through Aider's CLI flags instead of raw API calls.

## Gotchas that show up on a real refactor

**The Cursor export is not idempotent.** If you re-run `chi --select` after Cursor has updated the conversation in the background, you will get a different file, and Aider's prompt cache will miss. Export once, freeze the file, commit it under `.cursor-exports/` if you want a permanent record.

**`--read` is not a system prompt.** Aider treats the read-only file as part of the context, not as instructions. If your plan needs to be authoritative ("never break this public API"), state that constraint inside `REFACTOR-PLAN.md` in plain language. The architect model respects in-context constraints far better than it respects implicit ones.

**Architect mode is slower per turn.** Two API calls per user message means roughly double the latency. On a small two-file change, code mode (`--chat-mode code` or just `aider` without `--architect`) is faster and cheaper. Reserve architect mode for refactors that touch four or more files or where the plan involves a non-trivial design decision.

**Mid-session model swaps work.** If the editor starts producing broken diffs on a tricky file, type `/editor-model anthropic/claude-opus-4-7` to promote Opus into the editor seat for one turn, fix the file, then `/editor-model anthropic/claude-sonnet-4-6` to drop back. This is one of the patterns Aider's [usage docs](https://aider.chat/docs/usage.html) call out.

**The git story is yours to design.** Aider commits per turn by default. On a long refactor, that produces a clean linear history that some teams want to squash before merging and others want to preserve. Set `--no-auto-commits` if you want to commit manually, and `--dirty-commits` if you want Aider to commit only when files change.

**Cursor's plan can be wrong.** A multi-agent pipe is not a guarantee of correctness, only a guarantee that the plan reaches Aider intact. Read the trimmed `REFACTOR-PLAN.md` like you would read a junior engineer's design doc, and edit it before launching Aider. Five minutes of editing here saves an hour of fixing diffs later.

## When this pipe beats a single agent

A single Claude Code or Cursor session can also do the whole refactor. The pipe wins when at least one of these is true:

- The plan was expensive to produce. You explored the codebase for thirty minutes inside Cursor before you knew what you wanted to do. Throwing that conversation away is wasteful.
- The execution should be reproducible. Aider's per-step commits make it easy to bisect when a refactor breaks a test three steps later. A Cursor Composer session gives you one big diff.
- You want a cheaper model on edits. Cursor bills the same model for the whole conversation. Aider's architect/editor split lets you put Opus on the plan and Sonnet on the diff, which is a meaningful save on a long session.
- You want to script it. Aider can be invoked headlessly with `--message` and a script. Once the pipe works interactively, you can wrap it in a shell or CI step. The same pattern applies to [running Claude Code in a GitHub Action](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/) for autonomous PR review, or to scheduling agents for repeated work like the recurring [Claude Code triage tasks](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) we wrote about previously.

For one-off two-file changes, the pipe is overkill. Use whichever single tool is already in front of you.

## Related

- [How to write a Claude Code subagent that runs browser tests](/2026/05/how-to-write-a-claude-code-subagent-that-runs-browser-tests/)
- [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/)
- [Cursor ships a TypeScript SDK that turns its coding agent into a library](/2026/05/cursor-typescript-sdk-programmatic-coding-agents/)
- [How to add prompt caching to an Anthropic SDK app and measure the hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/)
- [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)

## Source links

- [Aider chat modes (architect, code, ask)](https://aider.chat/docs/usage/modes.html)
- [Aider in-chat commands and `--read` flag](https://aider.chat/docs/usage.html)
- [Aider conventions and `--read` for cached files](https://aider.chat/docs/usage/conventions.html)
- [Aider architect/editor announcement](https://aider.chat/2024/09/26/architect.html)
- [Cursor share-and-export documentation](https://cursor.com/docs/agent/chat/export)
- [`cursor-chat-export` community tool](https://github.com/somogyijanos/cursor-chat-export)
- [Cursor forum guide to manual chat extraction](https://forum.cursor.com/t/guide-5-steps-exporting-chats-prompts-from-cursor/2825)
