---
title: "Export Claude Code Conversations to PDF With jsonl-to-pdf"
description: "A practical guide to turning the JSONL files Claude Code writes under ~/.claude/projects/ into shareable PDFs using jsonl-to-pdf, with sub-agent nesting, secret redaction, compact and dark themes, and CI-friendly batch recipes."
pubDate: 2026-04-29
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
  - "pdf"
---

Every conversation you have with Claude Code lives as a `.jsonl` file deep inside `~/.claude/projects/`, one line per turn, full fidelity, no rendering. `jsonl-to-pdf` is a small CLI that turns those files into PDFs you can read in a reader, attach to a pull request, drop in a Slack thread, or print on actual paper. The fastest way to try it on your latest session is `npx jsonl-to-pdf`, which opens an interactive picker, asks whether to include sub-agent conversations, and writes a titled PDF to the current directory.

This post walks through where the JSONL files come from, what the PDF actually contains (sub-agents nested inline, thinking blocks, tool calls and results, image attachments), the flags worth knowing for sharing externally (`--compact`, `--redact`, `--no-thinking`, `--subagents-mode appendix`, `--dark`), and a few CI and automation recipes. The version covered is `jsonl-to-pdf` 0.1.0 against Claude Code 2.1.x. The repository is on [GitHub](https://github.com/marius-bughiu/jsonl-to-pdf), and the package is on [npm](https://www.npmjs.com/package/jsonl-to-pdf).

## Where Claude Code keeps your conversations

Claude Code writes one JSONL file per session at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. The `<encoded-cwd>` segment is the working directory the session ran in, with path separators flattened to `-`. So `C:\S\my-app` on Windows becomes `C--S-my-app`, and `/Users/marius/work` on macOS or Linux becomes `-Users-marius-work`. Each line is a JSON object: a user turn, an assistant turn, a tool call, a tool result, a thinking block, or session metadata such as `cwd`, `gitBranch`, `aiTitle`, and `permissionMode`.

Sub-agent conversations (sessions spawned by the main agent through the `Task`/`Agent` tool) live in a sibling directory: `<session-id>/subagents/<sub-session-id>.jsonl`. They are full sessions in their own right, with their own JSONL streams, parented back to a tool call in the main file by ID. This nesting is recursive in practice: a sub-agent that spawns its own sub-agent leaves a third file alongside the second.

That layout matters because nothing in the Claude Code UI surfaces it directly. If you need to do anything with a session after the conversation closes (archive it, share it, audit it), you find it on disk first. The CLI does the lookup for you with `jsonl-to-pdf list`, but the path encoding is worth knowing in case you grep for a specific session by hand. The recent [Claude Code 2.1.119 PR-from-URL change](/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/) keeps adding more session metadata into those files, so the JSONL is increasingly the canonical record of what an agent run actually did.

## Quick start: npx jsonl-to-pdf

The zero-install path runs `jsonl-to-pdf` straight from npm without touching your `package.json`:

```bash
# Node
npx jsonl-to-pdf

# Bun
bunx jsonl-to-pdf

# pnpm
pnpm dlx jsonl-to-pdf
```

That drops you into an interactive picker that walks the local Claude Code projects directory, lists every session newest first with title, age, and size, and asks whether to include sub-agent conversations. Pick a session, answer the question, and the CLI writes a PDF named after the session title in your current working directory:

```
$ jsonl-to-pdf
◆ Project   C:\S\my-app
◆ Session   Refactor the billing module to use Stripe webhooks  · 2h ago · 412KB
◆ Include sub-agent conversations? › Yes

✓ Wrote refactor-the-billing-module-to-use-stripe-webhooks.pdf
```

If you already know the file path, `convert` takes it as a positional argument and skips the picker:

```bash
jsonl-to-pdf convert ~/.claude/projects/C--S-my-app/abc-123.jsonl
```

Both forms accept the same flags. The interactive picker is the right entry point when you are converting an ad-hoc session; the `convert` form is the right entry point when you are scripting against a known file (CI artifact upload, automation hook, archival sweep).

To install globally instead, `npm i -g jsonl-to-pdf` or `bun i -g jsonl-to-pdf` puts both `jsonl-to-pdf` and the shorter `j2pdf` alias on your `PATH`. Node 18 or newer is required.

## What ends up in the PDF

Out of the box, the PDF preserves the **full fidelity** of the session, not just the visible chat:

- Every user prompt and assistant response, in order.
- *Thinking* blocks (the model's internal reasoning when extended thinking is on). Helpful when reviewing how the agent decided what to do.
- Every tool call, with its full input. A `Bash` call shows its command, an `Edit` call shows the diff, an MCP call shows its arguments.
- Every tool result, including full bash stdout/stderr. Long outputs wrap, they do not get cut.
- Image attachments, embedded inline at the point in the conversation where they were attached.
- **Sub-agents** rendered nested at the right place. When the main agent spawned a `Task` or `Agent`, that whole sub-conversation appears indented at the tool call that started it. Sub-agents that spawn sub-agents render the same way, recursively.

Code blocks are rendered with monospace font, syntax-aware line wrapping, and page-break logic that does not tear in the middle of a token. Sections include light navigational chrome (page numbers, the session title in the header) without leaning into design for its own sake. The default theme is light; `--dark` switches to a dark theme that looks better on a screen and worse on paper.

That fidelity is the whole point. PDFs of agent sessions are most useful when the reader can see exactly what the model saw, exactly what it ran, and exactly what came back. A summarised export reads like a postmortem; a full export reads like a transcript.

## Sub-agents inline or as an appendix

The default rendering is **inline**: every sub-agent conversation appears at the position of the tool call that spawned it, indented and visually grouped so the parent flow is easy to follow. That is the right default for debugging, where you want to see the side trip in context.

`--subagents-mode appendix` switches to a different layout: the main conversation reads top to bottom uninterrupted, and the sub-agent conversations move to the back of the document with anchors back to the tool call that spawned each one. That is the right mode for code-review-style reading, where the parent conversation is the story and the sub-agent threads are the supporting evidence:

```bash
# inline (default)
jsonl-to-pdf convert session.jsonl

# appendix
jsonl-to-pdf convert session.jsonl --subagents-mode appendix

# omit sub-agents entirely
jsonl-to-pdf convert session.jsonl --no-subagents
```

The third option, `--no-subagents`, is for cases where the sub-agent conversations are noise (often: long Explore-style searches that do not affect the eventual change). The PDF then contains only the main agent's flow.

## Compact and redact: making a session safe to share

Two flags handle the "I want to share this externally" case.

`--compact` strips the session down to its essentials. Thinking blocks are hidden, and any tool I/O longer than ~30 lines is trimmed with a clear "[N lines omitted]" marker. The result reads like the chat would, without the deep trace. Useful for handing the conversation to a teammate who only cares about the outcome.

`--no-thinking` is a finer cut: it hides only the assistant's thinking blocks, leaves tool calls and results intact. Helpful when the trace matters but the internal reasoning is too verbose to print.

`--redact` runs every string in the document through a set of regular expressions that match the common secret formats: AWS access and secret keys, GitHub personal access tokens (classic and fine-grained), Anthropic and OpenAI API keys, `Bearer` headers, Slack tokens, and PEM-encoded private keys. Each match is replaced with `[redacted:<kind>]` so the reader can tell what kind of secret was there without seeing the value. The full pattern list is in [src/utils/redact.ts](https://github.com/marius-bughiu/jsonl-to-pdf/blob/main/src/utils/redact.ts) on the project's GitHub.

```bash
# safe to email
jsonl-to-pdf convert session.jsonl --compact --redact

# safe to share, full fidelity
jsonl-to-pdf convert session.jsonl --redact
```

Use `--redact` whenever the destination is outside your trust boundary. Even when you are sure the session never touched a key, the cost of the flag is roughly free and the cost of being wrong is one rotated production credential.

## Recipes

A few patterns that come up often.

**Batch-convert your last week.** Every session newer than a date, one PDF each, written next to where you ran the command:

```bash
jsonl-to-pdf list --json |
  jq -r '.[] | select(.modifiedAt > "2026-04-22") | .filePath' |
  while read f; do jsonl-to-pdf convert "$f"; done
```

`jsonl-to-pdf list --json` prints one record per session with `sessionId`, `projectPath`, `filePath`, `sizeBytes`, and `modifiedAt`, so any filter you can express in `jq` works.

**Attach the active session as a CI artifact.** Useful in any pipeline where a Claude Code run produced the change, and you want the conversation archived alongside the build output:

```yaml
- run: npx -y jsonl-to-pdf convert "$CLAUDE_SESSION_FILE" -o session.pdf --redact
- uses: actions/upload-artifact@v4
  with:
    name: claude-session
    path: session.pdf
```

**Pipe to a printer or PDF reader.** The `-o -` form writes the PDF to stdout, which is useful for piping into `lp`, `lpr`, or whatever your platform's print binary is, or into a one-off PDF reader without leaving a file on disk:

```bash
jsonl-to-pdf convert session.jsonl -o - | lp
```

**List every session the CLI can see.** No PDF, just the index:

```bash
jsonl-to-pdf list
```

The output is human-readable by default and `--json` for machine-readable. The agent-tooling sweet spot for this is scripting; the [recurring Claude Code triage post](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) has a longer example of the same pattern (a scheduled job consuming `list --json`).

## Standalone binaries when you do not want a Node toolchain

The GitHub Releases page ships single-file binaries built with `bun build --compile`, one per OS and architecture, no Node runtime required. Useful on build agents that are not allowed to install a Node toolchain, or on locked-down developer workstations where global npm installs are blocked:

```bash
# macOS / Linux
curl -fsSL https://github.com/marius-bughiu/jsonl-to-pdf/releases/latest/download/install.sh | sh
```

On Windows, download `jsonl-to-pdf-win-x64.exe` from the latest release and put it on your `PATH`. The binary takes the same flags as the npm install: `convert`, `list`, `--compact`, `--redact`, `--dark`, all of it.

## Why a PDF specifically, and not "open in browser"

A few reasons the PDF format earns its keep over an HTML view that exists in the roadmap.

- **Archive.** Local Claude Code session files get rotated, garbage-collected, or simply forgotten. A PDF is a frozen, self-contained snapshot you can put in a project folder, an issue, or a backup.
- **Share.** Most code-review and chat tools accept a PDF attachment cleanly. Pasting a 400KB JSONL in a Slack thread is a worse experience than dropping a PDF.
- **Review.** Reading agent work the way you read code review (at a desk, on a flight, on paper) is a different mode of attention than scrolling a chat. PDFs survive that move.
- **Audit.** A signed, deterministic export is a record of what was actually said and run. Internal compliance teams can mark up a PDF; they cannot mark up a JSONL.
- **Onboard.** A real session is far better study material for a junior than a generic tutorial. A PDF makes that handoff a one-attachment problem.

## Roadmap, briefly

The 0.1.0 release covers Claude Code only. The roadmap on the project's GitHub commits to adapters for Aider, OpenAI Codex CLI, Cursor Compose, and Gemini CLI, all of which write some flavour of JSONL or JSON-Lines transcript. Beyond format coverage:

- HTML output for inline web sharing, and a small static viewer.
- Syntax highlighting for code blocks via Shiki tokens.
- A table of contents with page numbers (current builds use PDF outlines/bookmarks).
- Filtering flags: `--turns 5..15`, `--only assistant`, `--exclude-tool Bash`, for the cases where the full transcript is too much.

If you write a CLAUDE.md and a hook to keep your sessions on rails (the [CLAUDE.md playbook](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) covers that), `jsonl-to-pdf` is the matching artefact: a way to walk away from a session with something durable to point at. The repo is at [github.com/marius-bughiu/jsonl-to-pdf](https://github.com/marius-bughiu/jsonl-to-pdf).
