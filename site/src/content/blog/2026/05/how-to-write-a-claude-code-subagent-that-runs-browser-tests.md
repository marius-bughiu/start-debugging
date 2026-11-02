---
title: "How to Write a Claude Code Subagent That Runs Browser Tests"
description: "Create a Claude Code browser-testing subagent with an inline Playwright MCP server, explicit tools, an isolated browser profile, and evidence-based pass/fail reporting."
updatedDate: 2026-11-02
pubDate: 2026-05-08
tags:
  - "claude-code"
  - "ai-agents"
  - "agent-skills"
  - "mcp"
  - "playwright"
  - "browser-testing"
---

A browser-testing subagent can keep a focused test prompt and Playwright MCP tools separate from the main coding conversation. Define the server inline in the agent file, provide a test URL and expected outcome, and require the agent to report what it actually observed.

> **Correction — November 2, 2026:** Removed an unpublished MCP version, unsupported model-performance comparisons and claims that a worktree or Bash allowlist prevents network/file access. Updated tool names, plugin guidance and browser-profile isolation. The MCP configuration and tool discovery were checked locally; a Claude-driven staging login was not run.

## Define the agent and its MCP server

Save this as `.claude/agents/browser-tester.md`:

```markdown
---
name: browser-tester
description: Verify a specified user flow in a browser and report observed results.
model: inherit
tools:
  - mcp__playwright__browser_navigate
  - mcp__playwright__browser_snapshot
  - mcp__playwright__browser_click
  - mcp__playwright__browser_type
  - mcp__playwright__browser_press_key
  - mcp__playwright__browser_wait_for
  - mcp__playwright__browser_console_messages
  - mcp__playwright__browser_take_screenshot
  - mcp__playwright__browser_tabs
  - mcp__playwright__browser_close
mcpServers:
  - playwright:
      type: stdio
      command: npx
      args: ["-y", "@playwright/mcp@0.0.84", "--headless", "--isolated"]
---

Verify only the flow and environment specified in the task.
Navigate to the supplied URL, then take an accessibility snapshot.
Use current snapshot references for interactions; refresh the snapshot
when the page changes. Never invent a successful result.

Check the expected visible outcome and inspect browser console errors.
Use screenshots when a visual assertion requires them.
Do not submit real purchases, send messages, delete data, or change
production settings unless that exact action was authorized.
Use a dedicated test account or approved test authentication state;
do not include credentials or session tokens in the final report.

Report PASS, FAIL, or BLOCKED, the steps actually performed, the
expected and observed outcome, relevant errors, and any artifact paths.
A blocked login is BLOCKED, not PASS.
```

The example pins **Playwright MCP 0.0.84**, the version inspected for this revision. Update the pin deliberately after checking its flags and tool list. On native Windows, use the documented `cmd /c` wrapper if needed for the `npx` command shim.

The official [subagent documentation](https://code.claude.com/docs/en/sub-agents#scope-mcp-servers-to-a-subagent) distinguishes inline definitions from `mcpServers: ["playwright"]`, which references a server already configured in the parent session. Inline definitions are connected for the subagent and disconnected when it finishes. Project-folder trust and managed MCP restrictions still apply.

An explicit tool list is useful here because this agent only needs browser operations. It does not need Bash, filesystem editing or repository publishing tools to check an existing URL. This is a capability choice, not a claim that Playwright itself is a security boundary.

## Separate browser isolation from repository isolation

The [Playwright MCP documentation](https://github.com/microsoft/playwright-mcp) describes `--headless` for running without a visible browser and `--isolated` for an in-memory browser profile. The latter avoids sharing a persistent profile between invocations. It does not prevent the browser from reaching arbitrary network destinations or make a production account safe for destructive tests.

`isolation: worktree` is a separate Claude Code option for an isolated Git working tree. It does not isolate browser cookies, external services or credentials. Add it when an agent actually needs to modify repository files, then review and incorporate any retained worktree changes; those files are not automatically copied into the main checkout.

Current Claude Code supports whole-server tool entries such as `mcp__playwright__*`, but the explicit list above makes the intended browser surface easier to review. The Playwright package uses `browser_tabs`; the previous `browser_tab_list`, `browser_tab_new` and `browser_tab_close` names were not the inspected tool names.

## Load it and request a concrete check

Restart Claude Code after creating the file, or use the documented `/agents` flow. Confirm the workspace is trusted and the agent loaded. Then request a specific, non-destructive test:

```text
Use browser-tester to open http://127.0.0.1:3000 and verify that the
search form finds the seeded "example" item. Report the visible result
and console errors. Do not create, edit, or delete any records.
```

A prompt is not a shell: writing `$STAGING_PASS` in ordinary chat does not automatically expand an environment variable. Use your approved test-authentication setup, such as a dedicated account or a protected Playwright storage-state file, without pasting production credentials into the task.

If the browser cannot launch, follow the pinned package's installation guidance and inspect its error. Do not assume that starting the MCP process automatically installed the required browser binary. If tools are missing, inspect the subagent's MCP startup/debug logs and the discovered tool list. The parent's answer to “what tools do you have?” is not a definitive configuration test, particularly with deferred tool loading.

## Permissions and plugin packaging

A tool allowlist limits which tools are offered. It is not a substitute for the permissions applied to those tools. In particular, adding Bash would allow shell operations subject to the normal permission system; it would not make the agent read-only or confine filesystem access by itself.

Use the current [permission documentation](https://code.claude.com/docs/en/permissions#mcp) for MCP rules. Do not assume `mcp__playwright__browser_navigate(https://staging.example.com/*)` enforces a hostname boundary. For a required destination restriction, enforce it in a documented hook or in the execution environment and test the policy, including redirects. Playwright's own origin-filter flags explicitly are not a security boundary.

Plugin subagents do not accept the agent-frontmatter `mcpServers`, `hooks` or `permissionMode` fields. Changing the ignored inline block to an ignored string reference is not a workaround. Package the server in the plugin's `.mcp.json` as documented, or keep this as a project/user agent when the inline lifecycle is required.

## Turn an exploratory check into a repeatable test

An agent's observed PASS is useful evidence for that run; it is not durable regression coverage. For repeatable tests, Microsoft's [Playwright Test Agents](https://playwright.dev/docs/test-agents) provide planner, generator and healer workflows:

```bash
npx playwright init-agents --loop=claude
```

Run this in the intended Playwright project and inspect the generated files for that installed version. Do not assume the Claude integration writes the same directory layout as the VS Code integration. Regenerate definitions after a Playwright update as the documentation recommends, and review changes to generated tests and assertions.

The minimum useful report includes the actual route, action, expected result, observed result and failure evidence. A browser that opened successfully, or a server that listed its tools, has not yet demonstrated that the application's login, search or checkout behavior works.
