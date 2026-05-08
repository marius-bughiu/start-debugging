---
title: "How to Write a Claude Code Subagent That Runs Browser Tests"
description: "Build a project-scoped Claude Code subagent that drives Playwright in a real browser, scoped to its own MCP server so the main session never sees the 25 browser_* tools. Covers the .claude/agents/browser-tester.md frontmatter, mcpServers inline definition, allowed tool list, isolation: worktree, the Playwright Test Agents init flow, and the Sonnet-vs-Haiku model choice."
pubDate: 2026-05-08
tags:
  - "claude-code"
  - "ai-agents"
  - "agent-skills"
  - "mcp"
  - "playwright"
  - "browser-testing"
---

A specialised subagent for browser testing is the cleanest way to keep the 25 `browser_*` Playwright MCP tools from polluting your main Claude Code session, and to give the agent a focused system prompt that knows the difference between "click the button labelled Save" and "wait for the network idle event". This post walks through writing one as a `.claude/agents/browser-tester.md` file with an inline `mcpServers` definition for `@playwright/mcp@latest`, an `isolation: worktree` setting so failed tests do not pollute your working tree, and a `model: claude-sonnet-4-6` choice that holds up against the harder selectors. Versions in this post are Claude Code 2.1.x, Playwright 1.56.x, and the MCP spec dated `2026-03-26`.

The short answer: drop a Markdown file with YAML frontmatter into `.claude/agents/`, list `playwright` under `mcpServers` as an inline `stdio` server pointed at `npx @playwright/mcp@latest`, restrict `tools:` to `Read, Bash, mcp__playwright__*`, and set `isolation: worktree` so the subagent runs in a temporary git worktree. Once the file is on disk, restart Claude Code, then say "Use the browser-tester agent to verify the login flow on staging" and the main session delegates without ever loading the browser tools itself.

## Why a subagent instead of a top-level Playwright MCP

The naive setup, documented in [Simon Willison's TIL](https://til.simonwillison.net/claude-code/playwright-mcp-claude-code), is to run `claude mcp add playwright npx '@playwright/mcp@latest'` and let the main session see all 25 tools (`browser_navigate`, `browser_click`, `browser_type`, `browser_take_screenshot`, `browser_snapshot`, `browser_console_messages`, `browser_tab_*`, and the rest). That works, but it has three costs that compound on a long session:

1. **Context tax**. Every tool description ships with the model on every turn. The Playwright MCP server registers around 25 tools whose JSON schemas alone are several thousand tokens. On a session that is mostly editing C# or TypeScript, those tokens are dead weight.
2. **No specialised system prompt**. The main session does not know that `browser_snapshot` returns an accessibility tree that is usually faster to reason over than `browser_take_screenshot`. You either repeat that hint in `CLAUDE.md` or you accept worse tool selection. (See [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) for why "usually faster" is not a strong enough hint to fight tool description bias.)
3. **Permission blur**. Browser automation can navigate to arbitrary URLs and submit forms. Scoping that to a single named agent makes the audit story simple: only the `browser-tester` agent ever called `browser_navigate`.

The official Claude Code [Create custom subagents](https://code.claude.com/docs/en/sub-agents) docs cover the mechanics. The relevant trick is buried in the `mcpServers` section: when you define a server inline inside an agent file, the server is connected when the subagent starts and disconnected when it finishes. The parent conversation never sees its tools. That is exactly the property you want for a heavyweight MCP like Playwright.

## The minimum viable browser-tester agent

Save this as `.claude/agents/browser-tester.md` in the repo root. It is the smallest file that compiles, runs Playwright in headed mode, and is invoked automatically when the user asks for a browser-driven verification.

```markdown
---
name: browser-tester
description: Verifies user flows in a real Chromium browser using Playwright. Use proactively after any change to a route, form, or auth flow, or when the user asks to confirm a UI works end to end.
model: claude-sonnet-4-6
isolation: worktree
tools:
  - Read
  - Glob
  - Grep
  - Bash
  - mcp__playwright__browser_navigate
  - mcp__playwright__browser_click
  - mcp__playwright__browser_type
  - mcp__playwright__browser_press_key
  - mcp__playwright__browser_snapshot
  - mcp__playwright__browser_take_screenshot
  - mcp__playwright__browser_console_messages
  - mcp__playwright__browser_select_option
  - mcp__playwright__browser_handle_dialog
  - mcp__playwright__browser_wait_for
  - mcp__playwright__browser_tab_list
  - mcp__playwright__browser_tab_new
  - mcp__playwright__browser_tab_close
mcpServers:
  - playwright:
      type: stdio
      command: npx
      args: ["-y", "@playwright/mcp@latest"]
color: purple
---

You are a browser test runner. You verify that a real user flow works in
Chromium against the URL provided in the prompt.

## Operating rules

- Always start with `browser_snapshot` on the target URL. The snapshot
  is an accessibility tree and is usually enough to find the element
  you need. Only fall back to `browser_take_screenshot` when the
  snapshot is ambiguous or the layout itself is the assertion.
- Reference elements by their `ref` attribute from the snapshot.
  Never invent CSS selectors.
- Read `browser_console_messages` after every navigation and before
  reporting success. A clean flow with red errors in the console is
  not a passing flow. Surface any error-level message in your final
  report.
- After typing into a form, press Tab or click outside the field
  before submitting, so blur-based validation has a chance to fire.
- For flows behind auth, expect a `STAGING_USER` and `STAGING_PASS`
  in the prompt. Never log credentials.
- When asked to write a Playwright test file, place it under
  `tests/e2e/` and use the project's existing `playwright.config.ts`.

## Output format

End every run with:

1. A one-line PASS or FAIL verdict.
2. The URLs you navigated through, in order.
3. Any console errors, verbatim.
4. The path to a screenshot (if you took one) and to any test file
   you wrote.
```

A few fields are doing real work here.

`isolation: worktree` is the field that earns its keep on long-running test sessions. From the [subagents docs](https://code.claude.com/docs/en/sub-agents): "Set to `worktree` to run the subagent in a temporary git worktree, giving it an isolated copy of the repository. The worktree is automatically cleaned up if the subagent makes no changes." That means if the agent decides to write a `tests/e2e/login.spec.ts` to capture the flow, you get the file back; if it just navigates and screenshots, the worktree is deleted. The main session keeps a clean working tree either way.

`tools:` is an allowlist. Listing each `mcp__playwright__browser_*` tool individually feels verbose, but the alternative (omit `tools` and let the agent inherit everything) drags Read, Edit, Write, every other MCP server, and the full Bash surface into the subagent's context window. With an explicit list, the agent cannot accidentally `git push` after a flaky test, and it cannot read files outside the repo. There is no glob form for MCP tool names as of Claude Code 2.1.x; you list them.

`mcpServers` is the inline form. The string-reference form (`mcpServers: ["playwright"]`) reuses an already-configured server from `.mcp.json`, sharing the parent connection. The inline `stdio` form spawns a fresh `npx` process per subagent invocation. Inline costs you the cold start of `@playwright/mcp@latest` (one to two seconds, plus Chromium launch on first use) and buys you the property that the parent conversation cannot accidentally invoke `browser_navigate`.

`model: claude-sonnet-4-6`. Sonnet is the right pick here. Browser automation looks like it should be a Haiku task ("just click the button") but in practice the snapshot-to-action loop is full of subtle reasoning: which button on a page with three "Save" labels, which retry strategy when the URL redirects through SSO, when to give up on a flaky modal. Haiku 4.5 is fast enough to be tempting but loses ground on selector disambiguation. Opus 4.7 is overkill unless your tests assert against complex visual layouts. (For more on this trade-off, see [Prompt caching on Claude Sonnet 4.6 vs Claude Opus 4.7](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/).)

## What happens on first invocation

Restart Claude Code (subagents are loaded at session start unless you create them through the `/agents` interactive command), then prompt the main session:

```text
Use the browser-tester agent to confirm that signing in at
https://staging.example.com with STAGING_USER=qa@example.com and
STAGING_PASS=$STAGING_PASS lands on /dashboard with no console errors.
```

Three things happen, in order:

1. **The main session decides to delegate.** It matches the prompt against the `description` field of every available agent. The phrase "use the browser-tester agent" is an explicit handle, but the description's "Use proactively after any change to a route, form, or auth flow" also makes it match implicitly when, for example, you finish editing an auth route and ask "is the login still working?". The Agent tool call itself is a single message in the parent context, so the parent does not see the rest of the run.
2. **The subagent boots its MCP server.** Claude Code spawns `npx -y @playwright/mcp@latest` as a stdio child process. On first run this downloads the package and (separately) Chromium via `npx playwright install chromium` if it has not already been installed. This is the moment the cold start pays its bill. On subsequent runs in the same machine, both are cached.
3. **The subagent runs in a fresh worktree.** Because of `isolation: worktree`, Claude Code creates a temporary git worktree at something like `../start-debugging-browser-tester-9f3b/` and the subagent's working directory is set there. Any `Bash` calls run in that worktree. The cleanup at the end (worktree removed if no commits) is automatic.

The agent then does the actual run: `browser_navigate` to the staging URL, `browser_snapshot` to see the form, `browser_type` into the email and password fields by `ref`, `browser_click` on the submit button, `browser_wait_for` on the dashboard URL, `browser_console_messages` for the final assertion. Total turn count is usually four to seven on a happy path.

## Adding the Playwright Test Agents on top

Microsoft's official [Playwright Test Agents](https://playwright.dev/docs/test-agents) ship three pre-built subagents (Planner, Generator, Healer) that build on the same mechanism. The init command lays them down as Claude Code subagent files for you:

```bash
# Playwright 1.56.x
npx playwright init-agents --loop=claude
```

This creates `.github/agents/` plus `specs/` and `tests/` scaffolding, and writes three subagent files that Claude Code picks up the next session. The split is:

- **Planner**: explores the live app and produces a Markdown test plan in `specs/`.
- **Generator**: turns the plan into Playwright Test files under `tests/`.
- **Healer**: runs the suite and proposes patches when tests fail.

The custom `browser-tester` agent above is complementary, not redundant. The Playwright Test Agents are designed for the test authoring loop (plan -> generate -> run -> heal). The single-file `browser-tester` is for ad-hoc verification of a flow that does not yet have a test, or for a Claude Code session that wants to check a deployment without touching the test suite. They share the same Playwright MCP server underneath, so running both does not multiply Chromium installs.

If you do install the Playwright Test Agents, treat the generated files as the source of truth and add your custom agent alongside them. Do not edit the generated files directly: the docs note that agent definitions "should be regenerated whenever Playwright is updated", and your edits will be lost.

## Gotchas worth knowing before you ship this

**Subagents do not pick up file edits without a session restart.** This is in the docs but it bites everyone. If you tweak `browser-tester.md` in your editor, your current session keeps using the old version. The `/agents` interactive command is the only path that takes effect immediately, because it reloads the agent through Claude Code's own loader.

**`acceptEdits` does not extend to MCP tool calls.** The `permissionMode` field controls file edits and Bash commands. MCP tools are gated separately through your usual `permissions.allow` settings. If you want the subagent to run end to end without permission prompts on `browser_navigate` calls to your staging domain, add an explicit allow rule in `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__playwright__browser_navigate(https://staging.example.com/*)",
      "mcp__playwright__browser_navigate(https://staging.example.com)"
    ]
  }
}
```

The argument-pattern form is supported for MCP tools the same way it is for `Bash(...)` rules.

**Plugin subagents lose `mcpServers` and `permissionMode`.** If you want to distribute this agent as part of a Claude Code plugin, the docs are explicit: "for security reasons, plugin subagents do not support the `hooks`, `mcpServers`, or `permissionMode` frontmatter fields". The agent file works fine in `.claude/agents/` or `~/.claude/agents/`, but if you bundle it in a plugin, the `mcpServers` block is silently dropped and the agent will not have a Playwright server to talk to. The workaround is to register the Playwright MCP server in the consumer's `.mcp.json` and have the agent reference it by name (`mcpServers: ["playwright"]`) instead of inline. That loses the "parent context never sees these tools" property, but plugins cannot have it both ways.

**Subagents cannot spawn other subagents.** A `browser-tester` agent that decides mid-run to delegate the screenshot diff to a `visual-diff` agent will fail. The `Agent` tool is only available to top-level sessions or to agents started via `claude --agent`. For multi-stage pipelines (plan, run, diff, report), structure them as separate top-level invocations from the main session, not as nested subagents.

**Worktree isolation interacts badly with absolute paths.** If your test harness reads from a path like `/etc/staging-config.json` baked into your repo at `./config/staging.json`, and the agent runs with `isolation: worktree`, the worktree path is different from the parent path. Anything that hardcodes the repo path breaks. Either pass the path through the prompt, or drop `isolation: worktree` and trust the agent's tool allowlist to keep it from clobbering files. (You can also use `additionalDirectories` in the parent's permission settings to grant read access to a sibling directory, which the [permissions docs](https://code.claude.com/docs/en/permissions) describe in more detail.)

**Headed vs headless.** `@playwright/mcp@latest` defaults to headed Chromium in 2026. On a CI runner without a display, that fails fast. Pass `--headless` through the args:

```yaml
mcpServers:
  - playwright:
      type: stdio
      command: npx
      args: ["-y", "@playwright/mcp@latest", "--headless"]
```

You can also pin the package version (`@playwright/mcp@0.0.x`) to avoid the next breaking change landing mid-week, the same hygiene rule that applies to any `@latest` MCP server.

## Where this slots into a larger automation story

A `browser-tester` subagent is one node in a wider graph. The same machinery underpins [scheduling a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/), where a cron'd top-level session uses agents like `browser-tester` to verify the bug reports it triages. It is also the natural pair for [running Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/): the PR review session can delegate to `browser-tester` for any change that touches a route or a form, and the worktree isolation means the review job does not leak browser state into the runner. If you are building MCP servers for the rest of your testing surface, the same patterns apply: see [How to build an MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) for the symmetrical "I want my CLI as a tool" path, and [How to build a custom MCP server in Python](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) if your test harness is already in Python.

The single best test that the agent is set up correctly is the most boring one: ask the main session "what tools do you have?" and confirm `browser_navigate` is not in the list. If it is not, the subagent's MCP server is correctly scoped, and the main session is back to its lean tool surface. If it is, drop the `claude mcp add playwright` registration from `~/.claude.json` and let the agent file own the server end to end.

Source links: [Create custom subagents (Claude Code docs)](https://code.claude.com/docs/en/sub-agents), [Playwright Test Agents](https://playwright.dev/docs/test-agents), [Playwright MCP server](https://github.com/microsoft/playwright-mcp), [Simon Willison: Using Playwright MCP with Claude Code](https://til.simonwillison.net/claude-code/playwright-mcp-claude-code), [MCP specification 2026-03-26](https://modelcontextprotocol.io/specification/2026-03-26).
