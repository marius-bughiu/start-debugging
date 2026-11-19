---
title: "How to Turn On Code Mode in Claude Code With CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 (and Block It Org-Wide)"
description: "Code Mode, added in Claude Code v2.1.323, lets Claude write JavaScript that calls Bash, Edit and MCP tools in one step through a tool named REPL. How to turn it on in your shell or ~/.claude/settings.json, why project settings cannot, how to block it for an organization with a managed-settings env value of 0, what the requirements are, how permission rules and PreToolUse hooks see calls made from code, and the resume and hook gotchas."
pubDate: 2026-11-19
template: "how-to"
tags:
  - "claude-code"
  - "ai-agents"
  - "mcp"
  - "hooks"
  - "managed-settings"
  - "permissions"
---

**Short answer:** start Claude Code v2.1.323 or later with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` in your shell, or put that variable in the `env` block of `~/.claude/settings.json`, then pick **Yes, turn on Code Mode** at the one-time prompt. To keep it off for everyone in an organization, set the same variable to `"0"` in managed settings; a `0` anywhere wins over a `1` anywhere, and nothing in managed settings can turn it on for users. Code Mode is experimental, only works in an interactive terminal session against the Anthropic API with Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.2, and a session started in Code Mode can only be resumed with Code Mode still on. The current release at the time of writing is 2.1.328 (November 19, 2026).

## What Code Mode changes about tool calls

Without Code Mode, the model asks for one tool call (`Bash`, `Read`, `Edit`, an MCP tool), gets the full result back into context, decides, and asks for the next one. Every intermediate result costs a round trip and a slab of input tokens, even when the model only needed one line of it.

Code Mode, which shipped in [Claude Code 2.1.323 on November 12, 2026](https://code.claude.com/docs/en/changelog), flips that. The changelog describes it as "an experimental opt-in in which Claude writes JavaScript to call its tools". Claude writes a script, Claude Code runs it in your session, and only the value the script returns comes back to the model. The [Code Mode docs](https://code.claude.com/docs/en/code-mode) give this example for "raise the retry limit":

```javascript
// Claude Code 2.1.323+, Code Mode script as Claude writes it (from the official docs)
const files = await $`rg -l "function retryPolicy" src`.text();
const target = files.trim().split("\n")[0];
await edit(target, "maxAttempts: 3", "maxAttempts: 5");
({ edited: target, tests: $`npm test -- retryPolicy`.nothrow() });
```

Three tool calls (a search, an edit, a test run) happen in one model step. The `$` tagged template runs shell commands, `edit()` and `write()` wrap the file tools, and the last expression is what Claude reads. The tool that executes these scripts is called `REPL`, which matters later for hooks and deny rules.

This is the same idea Cloudflare called [Code Mode](https://blog.cloudflare.com/code-mode/) in September 2025 and Anthropic's engineering team described in [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp): models are better at writing code against an API than at chaining dozens of discrete tool calls, and filtering data inside the script keeps it out of the context window. Anthropic's article cites one workflow dropping from 150,000 to 2,000 tokens. That number is from their example, not a measurement of Claude Code's feature; the Claude Code docs make no token-savings claim, and the 2.1.328 changelog only mentions shorter tool descriptions and better prompt caching for Code Mode sessions with MCP servers. Treat savings as workload-dependent.

The docs recommend it for three shapes of work: a change repeated across many files, a search whose results need filtering before Claude reads them, and independent commands that can run in parallel. For a one-file fix, there is nothing to batch.

## Check the requirements before you flip the variable

Code Mode has a longer list of preconditions than most Claude Code settings, and if one fails the session just starts without it. From the [requirements section](https://code.claude.com/docs/en/code-mode#requirements):

- **Version**: v2.1.323 or later on either release channel. If `claude update` on `stable` does not reach it yet, wait or switch to `latest`.
- **Account**: a Claude subscription or Console account talking directly to the Anthropic API. Not Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, Claude Platform on AWS, an LLM gateway, or a custom `ANTHROPIC_BASE_URL`.
- **Organization**: not on the HIPAA configuration or zero data retention.
- **Model**: Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.2.
- **Surface**: an interactive `claude` in a terminal, native build. Not `claude -p`, the Agent SDK, the VS Code panel, the Desktop app, or cloud sessions.
- **Windows**: Git for Windows installed; shell commands in scripts run in Git Bash.
- **Settings that block it**: `apiKeyHelper` (or `ANTHROPIC_AUTH_TOKEN`, or auth headers in `ANTHROPIC_CUSTOM_HEADERS`), OpenTelemetry export (`CLAUDE_CODE_ENABLE_TELEMETRY`), and `DISABLE_TELEMETRY`, because Code Mode needs feature flags downloaded from Anthropic.
- **Agent teams**: need v2.1.326 or later, and teammates only run in Code Mode in the in-process display mode.

The headless restriction is the one that surprises people running scheduled agents. If your automation is built on `claude -p` (as in [keeping headless Claude Code runs from stalling on permission prompts](/2026/11/how-to-keep-headless-claude-code-runs-from-stalling-on-permission-prompts/)), Code Mode does not apply to it at all.

## Turn on Code Mode for one session or every session

For a one-off try, set the variable on the command line:

```bash
# Claude Code 2.1.323+, macOS / Linux / WSL
claude --version          # must print 2.1.323 or later
CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude
```

```powershell
# Claude Code 2.1.323+, Windows PowerShell (Git for Windows required)
$env:CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = "1"
claude
```

To make it the default for every new session, put it in your **user** settings:

```json
// ~/.claude/settings.json (Claude Code 2.1.323+)
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE": "1"
  }
}
```

The first time, Claude Code asks you to confirm. Pick **Yes, turn on Code Mode**; it restarts and prints this near the top of the session:

```text
Code Mode (experimental) is on · this session can be resumed only with Code Mode on
```

If you instead see `Code Mode (experimental) isn't available` followed by a reason, run `/status`; the same reason appears there. The [troubleshooting table](https://code.claude.com/docs/en/code-mode#code-mode-doesnt-start) maps each reason to a fix. The common ones: `it only works directly with the Anthropic API` (remove the gateway or provider settings), `it doesn't work with an API key helper`, `OpenTelemetry is on`, `it only works with Opus 5.5, Sonnet 5.5 and later models` (start with `--model opus`), and `couldn't save your answer` (make `~/.claude.json` writable, since that is where the confirmation is stored).

To see what Claude actually ran, press `Ctrl+O` to open the transcript viewer. Each script is a collapsed **Code** row; the normal conversation view only shows the resulting tool calls, such as an edit's diff.

### Why the project `.claude/settings.json` cannot turn it on

You might try committing the `env` block above to `.claude/settings.json` so the whole team gets Code Mode. It will not work, by design: Claude Code [ignores this variable in a project's settings files](https://code.claude.com/docs/en/settings-reference#variables-claude-code-ignores-in-env). A repository you clone cannot switch your agent into a mode where it runs generated JavaScript. To turn it on, the docs point only at your shell environment and your user settings; a `0` can also come from managed settings or a `--settings` file.

## Turn Code Mode off again

Remove the variable from the shell and from `~/.claude/settings.json` and start a new session. Or keep it and set it to `0`. The rule is asymmetric: a `0` in one place keeps Code Mode off even if another place says `1`. That means a stray `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0` exported in an old `.zshrc` silently beats the `1` in your settings file, which is the first thing to check when Code Mode refuses to appear and there is no "isn't available" line at all.

## Block Code Mode for an organization with managed settings

Administrators use the same variable with the value `"0"` in [managed settings](https://code.claude.com/docs/en/managed-settings):

```json
// managed-settings.json (Claude Code 2.1.323+)
// macOS:   /Library/Application Support/ClaudeCode/managed-settings.json
// Linux:   /etc/claude-code/managed-settings.json
// Windows: C:\Program Files\ClaudeCode\managed-settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE": "0"
  }
}
```

The same JSON works when you deliver managed settings through server-managed settings or MDM rather than a file. Three behaviors to know before you roll it out:

1. **It is not retroactive for live sessions.** Anyone already in a Code Mode session stays in it until they exit or restart Claude Code.
2. **It strands existing Code Mode sessions.** After the restart, users start without Code Mode and cannot resume their Code Mode sessions while the `0` is in place. Tell people to finish or abandon those sessions first.
3. **It is a one-way switch.** The docs are explicit: "You can't turn on Code Mode for your users from managed settings." Managed settings can only forbid it; each user still has to opt in from their own shell or user settings.

Users who hit the block see the reason `your organization's settings don't allow it`. As of 2.1.327, the same managed setting is also the documented way to keep Code Mode off when an installed mod hooks tool calls; Code Mode used to refuse to start in that case on its own.

There is a second, blunter lever. The troubleshooting entry for `this launch's tool options` says Code Mode will not start if `REPL` is in `--disallowedTools` or in your `deny` rules. A `"deny": ["REPL"]` permission rule therefore also prevents it, but it reads as a tool policy rather than a feature switch, and the environment variable is the one the docs document for organizations. Use the env value; reach for the deny rule only if your policy tooling manages permission rules and not `env`.

## How permission rules and hooks see calls made from code

This is the part that matters if you already have guardrails. According to the [permission checks section](https://code.claude.com/docs/en/code-mode#permission-checks), each tool call inside a script still goes through your `deny` and `ask` rules and your `PreToolUse` hooks **under the tool's usual name**, such as `Bash` or `mcp__github__create_issue`. A `deny` on `Bash(git push:*)` still applies when the push comes from a script's `$` shell helper.

Two caveats:

- **Compound commands reach hooks joined.** A `git push` run in a folder named `app` can arrive at your hook as `cd 'app' && git push`. If your hook does a naive prefix match on the command string, it misses that. Split on `&&`, `;` and `|` the way Bash rules do.
- **Auto mode reviews the script, not each call.** The auto mode classifier looks at the JavaScript before it runs and does not see values computed at run time, such as a path pulled out of `rg` output. If a call must never happen, enforce it with a rule or hook, not with the classifier. If you are unsure how auto mode differs from the modes that prompt, see [auto mode vs manual approval](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/).

If you want to inspect the script itself, match `REPL` in a `PreToolUse` hook and read the JavaScript from `tool_input.code`:

```json
// ~/.claude/settings.json (Claude Code 2.1.323+)
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "REPL",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/check-code-mode-script.sh", "timeout": 10 }
        ]
      }
    ]
  }
}
```

```bash
#!/usr/bin/env bash
# ~/.claude/hooks/check-code-mode-script.sh
# Claude Code 2.1.323+, requires jq. Refuses Code Mode scripts that mention .env files.
input="$(cat)"
code="$(jq -r '.tool_input.code // empty' <<<"$input")"

if grep -q '\.env' <<<"$code"; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Code Mode scripts may not read or write .env files"
    }
  }'
  exit 0
fi
exit 0
```

This is a coarse text check (a script can build the path at run time, exactly the gap the classifier has), so keep it as an extra layer on top of per-tool rules, and use the [Bash sandbox](https://code.claude.com/docs/en/sandboxing) for limits that do not depend on command text at all. That advice is not new to Code Mode; Bash rules have always matched text.

### Hook timeouts now refuse calls

In Code Mode a `PreToolUse` hook that does not return a decision **refuses** the call, even if you never set `onFailure`. Claude reports `the hook failed` when your hook could not start, was killed, exited with 126, 127 or above 128, or returned invalid output, and `the hook did not finish` when it timed out. The timeout behavior extends to every tool call in the session once Claude has run any code. If a slow hook (one that calls a network service, say) starts refusing calls after you enable Code Mode, raise its `timeout`, or set `"onFailure": "continue"` if failing open is acceptable. The trade-off is the one covered in [making a Claude Code hook fail closed with onFailure: block](/2026/10/how-to-make-a-claude-code-hook-fail-closed-with-onfailure-block/) and [fail-closed vs fail-open hooks](/2026/10/fail-closed-vs-fail-open-hooks-for-coding-agent-guardrails/), except that Code Mode picks fail-closed for you.

### UserPromptSubmit hooks and script output

The docs page still says `UserPromptSubmit` hooks run on background script output (with `source` set to `poll_event`) and can withhold it. The 2.1.328 changelog changed that: Code Mode "no longer run[s] UserPromptSubmit hooks, managed ones included, on scripts' output", and redaction should move to a `PostToolUse` hook that returns `updatedToolOutput`. If you rely on a `UserPromptSubmit` hook to scrub secrets from what Claude reads, it stopped covering script output in 2.1.328. Move that logic to `PostToolUse`.

## Resuming, long-running scripts and other gotchas

- **Resume needs the flag.** Keep `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` set for `claude --continue` and `claude --resume`. With it off, Claude Code refuses to resume a Code Mode session. Sessions started without Code Mode always resume without it, even with the variable set.
- **The ten-minute wall.** When Claude waits for a script, the script stops after ten minutes, and time you spend at a permission prompt counts. A long test suite in a prompting mode can hit this. For background scripts (up to two hours), start the session in auto or `bypassPermissions` mode; switching modes mid-session with `Shift+Tab` or picking the session from the `--resume` list can put you back in waiting mode.
- **The countdown prompt.** In auto mode, if Claude starts a second script while the first is running, the first loses its classifier review and you get prompts like `Claude Code will automatically block this request in 1:59`. Miss the countdown and that call, plus later countdown calls, are refused until you send a message.
- **Features you lose.** No Remote Control, no Claude in Chrome, no computer use, no moving the session to Desktop or to a background session, and `/fork` cannot start a background copy.
- **MCP servers that connect late.** Before 2.1.328, a script in auto or bypass mode could fail to call an MCP server that connected while the previous script ran; 2.1.328 fixed that, and Claude is now told when a server is still connecting and when the server list changes. If you build MCP servers (for example by [wrapping a CLI in a TypeScript MCP server](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/)), stay on 2.1.328 or later before judging how they behave under Code Mode.
- **It is still experimental.** The docs say it "may change or be removed in any release". Every release from 2.1.325 to 2.1.328 carried Code Mode fixes or behavior changes. Pin a version in CI-like environments and read the changelog before upgrading.

None of the snippets above were executed for this article: the local Claude Code install available while writing is older than 2.1.323 and Code Mode cannot be enabled on it. The configuration and hook formats come from the Code Mode, settings and hooks documentation and the changelog entries linked below.

## Sources

- [Run tool calls from code with Code Mode](https://code.claude.com/docs/en/code-mode), Claude Code docs
- [Claude Code changelog](https://code.claude.com/docs/en/changelog), entries 2.1.323 through 2.1.328
- [Variables Claude Code ignores in `env`](https://code.claude.com/docs/en/settings-reference#variables-claude-code-ignores-in-env)
- [Managed settings](https://code.claude.com/docs/en/managed-settings) and [hooks reference](https://code.claude.com/docs/en/hooks)
- [Code execution with MCP: building more efficient agents](https://www.anthropic.com/engineering/code-execution-with-mcp), Anthropic Engineering
- [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/), Cloudflare
