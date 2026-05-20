---
title: "Fix: Cursor's Apply Button Does Nothing on a Large Diff"
description: "Cursor's Apply silently cancels on big files because the Fast Apply model has an implicit size ceiling. Shrink the edit scope, clean git state, or fall back to a unified diff. Six ranked fixes for Cursor 3.3."
pubDate: 2026-05-20
template: error-page
tags:
  - "errors"
  - "cursor"
  - "ai-agents"
  - "llm"
---

You click `Apply` on a chat suggestion in Cursor, the chat block flashes for half a second, and then a red `X` appears on the filename in the diff tray. No toast, no error log, no partial write. The diff was real, the model spent tokens, and nothing landed. The most common cause is that the file (or the contiguous range Cursor decided to rewrite) is past the implicit ceiling of Cursor's Fast Apply model, and the apply task gets cancelled rather than served. The fix is almost never to change models in the chat panel: it is to shrink the scope of the apply, clean up the anchors in the target file, or skip Apply entirely and paste a unified diff.

This post is the long-form version of that paragraph, with the exact failure modes, the architecture that causes them, and six ranked workarounds. Tested against Cursor 3.3 (released [May 7, 2026](https://cursor.com/changelog/05-07-26)) on Claude Sonnet 4.6 and Claude Opus 4.7 as the chat models.

## The behaviour, verbatim

There are three error shapes that all funnel into the same root cause. If yours looks like any of these, you are on the right page.

Shape 1, the silent cancel. Most common in Cursor 3.x:

```
[apply] cancelled
[file] components/CheckoutPage.tsx -- 0 changes applied
```

There is no popup. The change is marked with a red `X` in the chat code block and on the filename tab in the diff tray. The chat says "Done", which is what makes it so easy to miss.

Shape 2, the legacy hard error. Still reported on older builds and on files past a hard threshold:

```
File is too big to apply (~undefined line limit)
```

That `~undefined line limit` is not a typo on your end. The threshold was [acknowledged as a bug](https://forum.cursor.com/t/apply-button-broken-getting-file-is-too-big-to-apply-undefined-line-limit/22287) back in Cursor 0.42.0 and survives in some 1.x and 2.x builds: the message renders the JavaScript value `undefined` because the limit is read from a config that the renderer cannot resolve.

Shape 3, the "only the first change is highlighted" variant. You asked the agent to edit five functions across three files. The first one shows a colored diff with `Accept` / `Reject` buttons. The other four were written to disk silently, with no diff highlight at all. The [Cursor forum has a long thread on this](https://forum.cursor.com/t/phantom-diff-changes-that-wont-go-away/143325) going back to early 2026 builds on Opus 4.6 and Gemini Pro 3.

All three are the same bug at different stages of evolution. Apply is not chat: it is a separate model running a separate task, and that model has its own context ceiling, its own input format, and its own failure modes.

## Why Apply has its own size limit

Cursor's `Apply` is not "the chat model writes the new file". The chat model emits a sketch -- often with `// ... existing code ...` placeholders -- and a second specialised model, the **Fast Apply** model, merges that sketch into the target file. Cursor's engineering team wrote up the architecture: [a 70b-parameter model trained on the apply task, served with speculative edits via Fireworks](https://fireworks.ai/blog/cursor), hitting roughly 1000 tokens/s and 3500 chars/s on a hot prompt.

That throughput is the entire reason Apply feels instant on small files. It is also why it fails the way it does on large ones. The Fast Apply model takes the full target file plus the sketch as input and emits the new full file as output. Both fit inside a finite context window. When the target file is large, three things happen at the same time:

1. The input prompt approaches the model's context ceiling, leaving less room for output. Cursor's runtime budgets a margin and cancels if the output would not fit.
2. The completion takes longer than the apply task's wall-clock budget. The UI cancels rather than block the editor.
3. The anchors the model needs to align the sketch (function signatures, class names, import blocks) become ambiguous because the file has hundreds of them.

Any one of these trips, the apply is cancelled, and the chat panel still says "Done" because the chat model's job was finished the moment it emitted the sketch.

The official Cursor team has [acknowledged this on the forum](https://forum.cursor.com/t/applying-changes-to-a-large-file-fails/47664): "we want to increase the file size limit for apply", and noted that going from current thresholds to 300k lines or 4.5M tokens will need a switch from full-file rewrite to patch logic. Until that ships, you are working around an architecture decision, not a transient bug.

The practical threshold is fuzzy. Reports cluster around **5,000 lines of TypeScript / JavaScript** as the point where cancellations get common, **2,000 lines of densely-typed C# or Java**, and as low as **1,500 lines of YAML** when the file has a lot of repeated anchors. Files over 50,000 lines fail almost every time. There is no documented hard number because the limit is a function of token count, not lines, and token density varies per language.

## A minimal repro

Open a fresh file `bigfile.ts` in a Cursor 3.3 workspace. Generate 6,000 lines of trivial function declarations:

```typescript
// Cursor 3.3, Claude Sonnet 4.6 as chat model

// Generated as: for (let i=0;i<6000;i++) console.log(`export function fn${i}() { return ${i}; }`)
export function fn0() { return 0; }
export function fn1() { return 1; }
// ... 5,998 more ...
export function fn5999() { return 5999; }
```

In the chat panel, type:

> Rename every `fnN` to `handlerN` in this file.

The chat model will emit a diff that looks correct in the code block. Click `Apply`. On most machines the result is the silent cancel: red `X`, "0 changes applied". The chat model's diff fit comfortably inside its own context window. The Fast Apply model could not.

Now try the same thing on a 200-line file. It works instantly. Same chat model, same prompt, same diff structure. The only variable is the size of the target file.

## Fix, ranked

The fixes are ordered by how often they resolve the report on the Cursor forum, not by how clever they are.

### 1. Shrink the apply scope

The most reliable workaround is to never let Apply see the whole file. In the chat, ask the agent to target a specific function or block by name instead of "this file":

> Rewrite the `processCheckout` function in `CheckoutPage.tsx`. Do not touch anything else.

When the chat model emits a sketch that points at a single function, Cursor's apply task narrows to that function plus a small surrounding window. The Fast Apply model sees a much smaller input and finishes inside its budget. This is the single biggest win and it costs nothing.

For sweeping renames across a large file, do them function by function in separate apply calls. Cursor 3.3's [Build in Parallel](/2026/05/cursor-3-3-build-in-parallel-split-prs/) feature was designed for exactly this pattern -- sub-agents work on independent slices of a plan concurrently, and each slice's apply stays small.

### 2. Clean the git state before applying

The Fast Apply model uses a Myers-style diff against the on-disk file as one of its alignment signals. If the file has uncommitted changes that conflict with the sketch's anchors, the model cancels rather than risk a wrong merge.

Before a large apply, run:

```bash
# git 2.45, no Cursor flags involved
git status
git add -p   # stage clean hunks
git stash -u # stash the rest
```

Apply. Pop the stash afterwards. This alone fixes the "phantom diff" variant in roughly one report in three, because the phantom diffs are usually leftover hunks from a previous cancelled apply that never cleaned up.

### 3. Ask for a unified diff and apply it manually

If Apply keeps failing, take it out of the loop. In the chat, prompt:

> Output the change as a unified diff against the current file. Do not apply.

The chat model will emit a `diff --git` block. Save it to `change.patch` and apply with the system tool:

```bash
# git 2.45 / GNU patch 2.7
git apply --3way change.patch
```

This bypasses the Fast Apply model entirely. You lose the inline `Accept` / `Reject` UI, but you get a real `git diff` to review before commit. For files over 5,000 lines this is often faster end to end than fighting Apply.

For repetitive search-and-replace renames, ask the agent for a `sed` script instead:

```bash
# sed (GNU sed 4.9)
sed -i 's/\bfn\([0-9]\+\)\b/handler\1/g' bigfile.ts
```

This is the workaround the Cursor team [explicitly recommends on the forum thread](https://forum.cursor.com/t/applying-changes-to-a-large-file-fails/47664) for files over 50k lines.

### 4. Reload the window, then retry once

If Apply silently cancels and the chat panel does not show a `Retry` button, the apply task queue may be stuck. The cheapest fix is a window reload:

```
Ctrl+Shift+P -> Developer: Reload Window
```

This clears the apply queue and forces Cursor to re-establish its connection to the Fast Apply endpoint. About one in five "Apply does nothing" reports on the forum are resolved by a reload alone, and it costs you five seconds. Try it before anything more invasive.

### 5. Disable file-watcher extensions during the apply

If you have Prettier, ESLint, dprint, or any other extension configured to run on save, they can race with Apply. The apply writes the new file content, the formatter runs, the file mutates again, and Cursor's diff overlay refuses to reconcile. The visible result: the apply "did nothing" because the formatter immediately overwrote it.

In Cursor's settings, temporarily flip `editor.formatOnSave` to `false` for a large apply, or disable the offending extension via `Ctrl+Shift+X`. Re-enable both after the change lands and run the formatter manually. The Cursor team has not [documented this on the apply page](https://docs.cursor.com/), but it is the second most common cause of phantom cancellations in user reports.

### 6. Refactor anchor points if the file is structurally hostile

If your file has a hundred functions called `handler` overloaded by argument shape, or fifty Razor components with identical `@page` directives, or a YAML pipeline with twenty `- name: deploy` entries in a row, the Fast Apply model cannot anchor the sketch to a unique location. It will cancel rather than guess.

This is the only fix that touches your code rather than your workflow. Rename the duplicates to unique identifiers, or split the file. As a rule of thumb, if `grep -c '^function' bigfile.ts` returns a number larger than the file is lines wide divided by 30, the anchor density is the problem. Once the anchors are unique, Apply works at sizes it previously cancelled on.

## Variants you might be hitting instead

A few cancellations look like the Apply ceiling but are not:

- **`MCP server disconnected` warnings in the same session**. Unrelated. That is the MCP transport, not the apply task. See [why Claude Code reports MCP server disconnected inside WSL](/2026/05/fix-claude-code-reports-mcp-server-disconnected-inside-wsl/) -- the same diagnosis applies to Cursor's MCP integration.
- **`Context window exceeded` errors during a long chat**. That is the chat model running out of conversation context, not Apply running out of file context. The [Aider context window post](/2026/05/fix-context-window-exceeded-during-an-aider-refactor/) covers the chat-side fix.
- **The chat panel says "rate limited"**. The chat model hit a tokens-per-minute ceiling. Apply will work again on its next attempt once the rate limit clears.
- **The apply works but a different file is modified**. The chat model misidentified the target. Pin the path explicitly in the next prompt and the next apply targets the right file.

If you are not on Cursor 3.x yet and the messages look different, the underlying architecture is the same -- Fast Apply has been Cursor's apply backend since Cursor 0.40 -- but the UI hints have changed every few releases. Update Cursor first if the buttons you see in this post do not match yours.

## Related

- [Cursor 3.3 adds Build in Parallel, Split PRs, and a unified PR review](/2026/05/cursor-3-3-build-in-parallel-split-prs/)
- [Cursor ships a TypeScript SDK that turns its coding agent into a library](/2026/05/cursor-typescript-sdk-programmatic-coding-agents/)
- [How to pipe Cursor's context to an Aider session for multi-agent refactors](/2026/05/how-to-pipe-cursors-context-to-an-aider-session-for-multi-agent-refactors/)
- [Fix: Context Window Exceeded During an Aider Refactor](/2026/05/fix-context-window-exceeded-during-an-aider-refactor/)
- [How to structure a monorepo so Claude Code's context stays small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/)

## Sources

- [Cursor: How we built Fast Apply using the Speculative Decoding API (Fireworks)](https://fireworks.ai/blog/cursor)
- [Cursor forum: Applying changes to a large file fails](https://forum.cursor.com/t/applying-changes-to-a-large-file-fails/47664)
- [Cursor forum: Apply button broken, "File is too big to apply (~undefined line limit)"](https://forum.cursor.com/t/apply-button-broken-getting-file-is-too-big-to-apply-undefined-line-limit/22287)
- [Cursor forum: Phantom Diff Changes That Wont Go Away](https://forum.cursor.com/t/phantom-diff-changes-that-wont-go-away/143325)
- [Cursor 3.3 release notes (May 7, 2026)](https://cursor.com/changelog/05-07-26)
