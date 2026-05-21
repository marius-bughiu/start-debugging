---
title: "Fix: GitHub Copilot Ignores Repository Custom Instructions in VS Code"
description: "Copilot Chat reads your .github/copilot-instructions.md fine, but Agent mode and *.instructions.md files often look ignored. Here is the actual checklist: settings, file locations, applyTo globs, and how to prove the file made it into context."
pubDate: 2026-05-21
tags:
  - "github-copilot"
  - "ai-agents"
  - "agent-skills"
  - "vscode"
  - "copilot-instructions"
---

The fastest way to confirm GitHub Copilot is ignoring your `copilot-instructions.md` is to put a sentinel string at the top of the file like `INSTRUCTIONS_LOADED_SENTINEL_2026_05` and ask Copilot Chat "what string is at the top of my instructions file". If it answers back with the sentinel, the file is in context and your problem is wording or scope. If it does not, you are in one of three buckets: the wrong VS Code setting is disabled, the file is in the wrong location for the mode you are using (Ask vs Edit vs Agent), or you are relying on `applyTo` globs on a `.instructions.md` file that VS Code is not auto-attaching. This post walks the four checks that resolve almost every "Copilot ignored my instructions" thread on the [microsoft/vscode](https://github.com/microsoft/vscode) and [microsoft/vscode-copilot-release](https://github.com/microsoft/vscode-copilot-release) trackers as of May 2026.

Pin the moving parts: VS Code 1.106.x stable, GitHub Copilot Chat extension 1.375+, and the `chat.*` settings family that replaced the older `github.copilot.chat.codeGeneration.*` keys during the 2026 Q1 customization overhaul. If you are on an older Copilot extension, half of what follows will not apply. Update first.

## Why this is suddenly confusing in 2026

Through most of 2025 there was exactly one file to worry about: `.github/copilot-instructions.md`. It was global to the workspace, always on, and toggled by a single setting. Then VS Code shipped three overlapping mechanisms on top of it:

1. **Workspace instructions**: still `.github/copilot-instructions.md`, always attached when enabled.
2. **File-scoped instructions**: `*.instructions.md` files with YAML frontmatter and an `applyTo` glob, auto-attached when the matched file is in the chat context.
3. **Agent root files**: `AGENTS.md` (and now `CLAUDE.md`) read by Agent mode at workspace root, gated by their own settings.

Each one has a separate enable flag, a separate discovery rule, and a separate place where it shows up in the chat references panel. When users say "Copilot ignores my instructions" they usually mean one of those three pipelines is silently disabled, not that the global feature is broken. The fix is mechanical, but only if you know which pipeline you are debugging.

## Check 1: Is the workspace file feature on at all

The repo-level instructions file lives at `.github/copilot-instructions.md`. There is no other supported location. Not `docs/copilot-instructions.md`, not the repo root.

The feature is gated by:

```jsonc
// .vscode/settings.json or your user settings
{
  // VS Code 1.106.x, Copilot Chat 1.375+
  "github.copilot.chat.codeGeneration.useInstructionFiles": true
}
```

This key has been enabled by default since the [VS Code v0.22 Copilot release](https://github.blog/changelog/2024-10-29-multi-file-editing-code-review-custom-instructions-and-more-for-github-copilot-in-vs-code-october-release-v0-22/) in October 2024, but two things commonly flip it off:

- A workspace `.vscode/settings.json` pulled in from a template repo that explicitly sets it to `false`.
- A managed device policy in enterprise installs that ships a defaults file.

Open the Command Palette, run **Preferences: Open User Settings (JSON)**, then **Preferences: Open Workspace Settings (JSON)**, and grep both files for `useInstructionFiles`. If it is set to `false` anywhere, that wins.

While you are in settings, confirm the modern equivalents are also on. These three are the new world in VS Code 1.106:

```jsonc
{
  "chat.useAgentsMdFile": true,
  "chat.useClaudeMdFile": true,
  "chat.instructionsFilesLocations": {
    ".github/instructions": true
  }
}
```

`chat.instructionsFilesLocations` is a map of directory paths to booleans. VS Code searches every enabled directory recursively for `*.instructions.md` files. The default value already includes `.github/instructions`, but if you tried to be clever and put instructions in `prompts/` or `.copilot/` you need to add that path here or VS Code will not see it.

## Check 2: Open the diagnostics view and read what actually loaded

This is the step almost nobody does, and it is the one that resolves the most threads.

Right-click anywhere in the **Chat** view and pick **Diagnostics** (also reachable via Command Palette as **Chat: Show Chat Diagnostics**). You get a panel that lists every instruction file VS Code discovered, where it discovered it, whether it is enabled, and what error blocked it if any. Common things you will see:

- `copilot-instructions.md` listed but `enabled: false` because `useInstructionFiles` is off in a workspace settings file you forgot about.
- A `.instructions.md` file listed with **"applyTo did not match"** as the reason it was not attached. This is almost always a glob mistake (see Check 3).
- A duplicate-name entry pointing at a global user-profile instructions file overriding the workspace one.
- A YAML parse error on the frontmatter quietly skipping the file entirely.

If your file is not in the diagnostics list at all, VS Code did not find it on disk. Check the path character by character. The folder is `.github/`, dot-prefixed, and the filename is `copilot-instructions.md`, hyphenated, lowercased, plural "instructions". A surprisingly common bug is `copilot-instruction.md` (singular).

## Check 3: applyTo globs are not what they look like

This is the bug that ate three days of an [open issue thread](https://github.com/microsoft/vscode/issues/249531). The `applyTo` field on a `*.instructions.md` file is a glob that VS Code matches against the **files attached to the chat request**, not against the file you happen to be editing in Ask mode and not against anything in Agent mode without explicit context.

A working file-scoped instruction looks like:

```markdown
---
name: TypeScript test conventions
description: How to write Vitest unit tests in this repo
applyTo: "**/*.test.ts,**/*.spec.ts"
---

When writing or modifying tests in this repo:

- Use `describe`/`it`, never `test()`.
- Mock the network with `msw`, not `vi.fn()`.
- Assert with `expect(...).toMatchInlineSnapshot()` for response shapes.
```

The trap: `applyTo` accepts a comma-separated list of globs (not an array), the patterns are matched with the standard VS Code glob matcher, and you have to actually attach the file you are working on for the rule to fire. In Ask mode this happens automatically when you have the file open and your prompt references "this file". In Agent mode it happens when the agent's own file-read tool attaches the file. In neither case does it happen because you opened a tab.

Two common applyTo mistakes:

- Writing `applyTo: "*.ts"`. VS Code's glob matcher does not expand `*.ts` to "any file with .ts anywhere in the tree". You want `**/*.ts`.
- Writing `applyTo: "**//*.md"` from one of the linked issue threads, where the double slash silently breaks the match.

If you want a `.instructions.md` to behave like the global `copilot-instructions.md` (always on, no file scoping), simply omit `applyTo`. The file then becomes "manual attach only" but you can also drag it into the chat input or reference it with `#file:filename.instructions.md` to force-load it for one turn.

## Check 4: Agent mode and AGENTS.md / CLAUDE.md, the silent third channel

The thing that confused the most users in early May 2026 was: **Agent mode does not consume `copilot-instructions.md` the same way Ask mode does.**

There is a [closed-as-not-planned issue](https://github.com/microsoft/vscode/issues/279045) where a user on VS Code 1.106.2 with Copilot Chat 1.375.0 reported that `copilot-instructions.md` was not appearing in the references list of agent runs, despite the setting being enabled. The maintainers requested more info and closed it, but the underlying behavior is now documented: Agent mode preferentially reads `AGENTS.md` (and `CLAUDE.md` if `chat.useClaudeMdFile` is on) from the workspace root, and treats `copilot-instructions.md` more like a low-priority fallback. The model is not guaranteed to keep your `copilot-instructions.md` in context across a long agent loop with tool calls.

If you are running Agent mode and you actually need your conventions to survive a multi-turn run, do one of:

1. Move them into a workspace-root `AGENTS.md`. Same content, different filename, different priority.
2. Use `chat.useNestedAgentsMdFiles` if you have monorepo packages and want a per-package `AGENTS.md`.
3. Split the content into Agent Skills under `.github/skills/<skill>/SKILL.md`. These load on-demand based on the skill description and survive long agent loops better because they are attached as named tools, not as preamble. We covered the format in [how to give a Copilot Agent Skill access to your repo conventions](/2026/05/how-to-give-a-copilot-agent-skill-access-to-your-repo-conventions/).

The other side of this is that Agent mode in 2026 will read **both** `AGENTS.md` and `CLAUDE.md` if both exist and both flags are on. If your repo has shipped a `CLAUDE.md` for Claude Code (the format covered in [how to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/)) you may be getting double-context which sounds great but actually competes for the same token budget. Pick one.

## The "Used references" panel lies sometimes

One last sharp edge. Maintainers acknowledge that the **"Used references"** section in the chat response is not 100% reliable: a [recently flagged issue](https://github.com/microsoft/vscode/issues/279045) showed `copilot-instructions.md` not appearing in references even when it was loaded into context. Diagnostics are authoritative; the references chip strip is best-effort UI.

This is why the sentinel-string check from the opening paragraph is the only test that actually proves the file made it in:

```markdown
INSTRUCTIONS_LOADED_SENTINEL_2026_05

(rest of your instructions)
```

Then ask Copilot Chat:

> What is the string on the first line of my repository's custom instructions file?

If you get the sentinel back, your instructions are in. If you do not, work back through Checks 1 to 4.

## Things that look like a bug but are not

Three behaviors that show up in bug reports but turn out to be working as designed:

- **Inline completions ignore the file.** `copilot-instructions.md` is read by Copilot **Chat** (Ask, Edit, Agent) and by code-review features. The ghost-text inline-completion model does not consume it. If you want inline completions to follow conventions, you need [a Copilot Agent Skill](/2026/05/how-to-give-a-copilot-agent-skill-access-to-your-repo-conventions/) or to bring your own model setup as covered in [GitHub Copilot's BYOK story across Anthropic, Ollama, and Foundry Local](/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).
- **Copilot generates code that violates the rule.** Loading the file does not guarantee compliance. The model still chooses; the instructions are a strong nudge, not a constraint. The author of [microsoft/vscode#280033](https://github.com/microsoft/vscode/issues/280033) opened a bug under exactly this misunderstanding, then closed it themselves once they realized the file was being read.
- **Copilot Code Review on github.com does not pick up the file.** Web-based PR review has stricter context limits than the IDE, and per the [Microsoft Q&A entry](https://learn.microsoft.com/en-us/answers/questions/5832308/github-copilot-code-review-on-github-com-seems-to) does not consistently consume the full instructions file. Use Copilot Chat in the IDE for the review pass, or rely on a Copilot Agent Skill that ships review conventions as a named skill.

## A working `.github/copilot-instructions.md` you can copy

Minimal, no frontmatter, no scoping, always on in Ask and Edit mode. Use this as a baseline and confirm it loads before adding any `*.instructions.md` files alongside it.

```markdown
INSTRUCTIONS_LOADED_SENTINEL_2026_05

# Repository conventions for this project

## Stack
- .NET 11, C# 14, EF Core 11, xUnit.
- Frontend: TypeScript 5.x, React 19, Vitest.

## Coding rules
- Use file-scoped namespaces. Never block namespaces.
- Prefer `record` over `class` for DTOs.
- Wrap all database access in `await using var tx = ...` blocks.
- Migrations live under `src/Infrastructure/Migrations/`, one class per change, non-empty `Down()`.

## Testing rules
- Tests use xUnit with `Shouldly`, never `Assert.*`.
- React tests use Vitest + Testing Library. No Enzyme.
- Snapshot tests must use inline snapshots, not file snapshots.

## What not to do
- Do not introduce AutoMapper. Hand-write mappers.
- Do not introduce MediatR. Call services directly.
- Do not add a logging framework. We use `ILogger<T>` only.
```

Push it, open VS Code, sanity-check via Diagnostics, ask the sentinel question. If Copilot quotes the sentinel back, the pipeline works and you can layer file-scoped `.instructions.md` files on top of it with `applyTo` globs.

## Related

- [How to give a Copilot Agent Skill access to your repo conventions](/2026/05/how-to-give-a-copilot-agent-skill-access-to-your-repo-conventions/)
- [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/)
- [Agent Skills land in Visual Studio 2026 18.5](/2026/04/visual-studio-2026-copilot-agent-skills/)
- [GitHub Copilot's BYOK story across Anthropic, Ollama, and Foundry Local](/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/)
- [How to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/)

## Sources

- [Use custom instructions in VS Code (official docs)](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)
- [Adding repository custom instructions for GitHub Copilot (GitHub Docs)](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot)
- [microsoft/vscode issue #279045: copilot-instructions.md no longer included in chat context automatically](https://github.com/microsoft/vscode/issues/279045)
- [microsoft/vscode issue #249531: Using instruction files with applyTo](https://github.com/microsoft/vscode/issues/249531)
- [microsoft/vscode-copilot-release issue #12770: .instructions.md Files Not Respected in VS Code Chat/Agent Mode](https://github.com/microsoft/vscode-copilot-release/issues/12770)
- [VS Code v0.22 Copilot Chat release notes (custom instructions default-on)](https://github.blog/changelog/2024-10-29-multi-file-editing-code-review-custom-instructions-and-more-for-github-copilot-in-vs-code-october-release-v0-22/)
