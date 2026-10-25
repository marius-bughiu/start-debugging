---
title: "Fix: Claude Code hooks fail with \"Plugin directory does not exist\""
description: "A plugin hook fails with \"Failed to run: Plugin directory does not exist\" when the directory your session loaded the plugin from is gone: an update past the 14-day orphan window, a claude.ai sync that moved the folder to .trash, or a --plugin-dir you moved. Run /reload-plugins, read its summary line, and know which cases need a restart. Checked against Claude Code 2.1.310."
pubDate: 2026-10-25
template: error-page
tags:
  - "errors"
  - "claude-code"
  - "ai-agents"
  - "hooks"
  - "plugins"
  - "agent-security"
---

**Short answer:** the message means the hook command is fine but the folder your running session loaded the plugin from has been deleted or moved. Type `/reload-plugins` at the prompt, even though the error tells you to reinstall: the reload points every hook at the plugin's current directory. Then read the reload's summary, not the transcript, because Claude Code prints this error only once per session for each hook event and command. If the plugin was synced from claude.ai and you are on anything older than Claude Code v2.1.295, the reload may not help, so update and start a new process with `claude --continue`. Everything below was checked against Claude Code 2.1.310, the current release on 2026-10-25.

## The exact error and what it is telling you

The full notice looks like this, with the event name in front:

```text
PreToolUse hook error
Failed to run: Plugin directory does not exist: /Users/you/.claude/plugins/cache/acme-tools/guard/1.4.0 (guard@acme-tools — run /plugin to reinstall)
```

Three parts matter:

- **The event** (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, ...). It tells you which of the plugin's hooks just failed to run.
- **The path**. This is the directory the session resolved `${CLAUDE_PLUGIN_ROOT}` to when it loaded the plugin, at startup or at the last `/reload-plugins`. It is not necessarily where the plugin lives now.
- **The plugin id** (`guard@acme-tools`). The part after `@` tells you the plugin's origin, and the origin decides which fix works: a marketplace name, `synced` for a claude.ai plugin, or `inline` for `--plugin-dir`.

Do not confuse it with `Plugin directory not found at path: <path>`. That one appears in the **Errors** tab of `/plugin`, not as a hook notice, and means a marketplace entry with a relative `source` path points at a folder that does not exist inside the marketplace. It is a broken marketplace, not a stale session.

## Why this one is dangerous: the hook fails open

When Claude Code cannot start a plugin hook because its directory is gone, it shows the notice and carries on. The tool call runs. The prompt goes to the model. Nothing blocks.

For a formatter, that is a cosmetic problem. For a guard plugin it is a security hole. In [anthropics/claude-code#97847](https://github.com/anthropics/claude-code/issues/97847), opened on 2026-09-28 against v2.1.283, the plugin was a secret-redaction plugin with `UserPromptSubmit`, `PreToolUse` and `PostToolUse` hooks. After its folder moved, tool output containing a credential reached the model unredacted, and the only trace was a few hook error lines.

The second trap is that the error is deduplicated. The [troubleshooting docs](https://code.claude.com/docs/en/plugins/troubleshooting#plugin-directory-does-not-exist) say the failure "is shown once per session for each hook event and command." So after the first `PreToolUse hook error`, every later `PreToolUse` call is also skipping the hook, silently. A quiet transcript does not mean the hook recovered.

## The four ways the directory disappears

### 1. A marketplace plugin updated and the old version was swept

Marketplace plugins are copied into a versioned cache directory, and `${CLAUDE_PLUGIN_ROOT}` points at that exact version:

```text
~/.claude/plugins/
  cache/<marketplace>/<plugin>/<version>/   # one dir per installed version
  data/<plugin-id>/                          # ${CLAUDE_PLUGIN_DATA}, survives updates
  marketplaces/<name>/                       # marketplace clones
  synced/                                    # plugins synced from claude.ai
  .trash/                                    # synced plugins the sync removed
  installed_plugins.json
  known_marketplaces.json
```

When a plugin updates, through `claude plugin update` or the background auto-update pass that runs up to ten minutes after your first message, the running session keeps the old path. Per the [plugin loading reference](https://code.claude.com/docs/en/plugins/loading#cleanup-of-previous-versions), Claude Code writes an `.orphaned_at` marker into the previous version directory and deletes it in a background sweep 14 days later, "so a session that already loaded the old version keeps running."

So the normal update path is safe for two weeks. The error shows up when:

- the session is older than 14 days, which happens with long-lived `tmux` sessions, Remote Control hosts and resumed background agents. [tj-agents/core#384](https://github.com/tj-agents/core/issues/384) describes exactly this: every `Stop` hook in a live session failed after an update on 2026-09-22.
- something other than Claude Code cleaned the cache: an `rm -rf ~/.claude/plugins/cache` to "fix" a different problem, a disk-cleanup tool, or a dotfiles sync that does not carry the cache across machines.
- you changed `CLAUDE_CODE_PLUGIN_CACHE_DIR` and removed the old root while sessions were still using it.

The fix is the reload, because the plugin's current version is on disk and the session only needs to switch to it.

### 2. A claude.ai-synced plugin was moved to .trash by another session

Plugins you or your organization turn on in claude.ai load as `<name>@synced`. Each time Claude Code starts in a signed-in terminal, it syncs once in the background into `~/.claude/plugins/synced/`. Before v2.1.295, that sync did not respect running sessions: issue #97847 shows session A loading from `synced/<bucket>/<name>~g2`, session B starting later, installing the new release into `<name>`, and moving `<name>~g2` into `.trash`. Every hook of that plugin in session A then failed. The reporter also found that `/reload-plugins` did not recover the session, three times in a row, and only a new process did.

The [2.1.295 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) has the fix: "Fixed claude.ai-synced plugin hooks failing with 'Plugin directory does not exist' in long-running sessions after another session synced a plugin update." 2.1.299 then removed a related spurious `synced[0] commands path not found` error at startup.

If your error names `@synced`, check the version first:

```bash
# Claude Code 2.1.310 is current as of 2026-10-25; the synced-plugin fix is in 2.1.295
claude --version
claude update
```

Then leave the broken session and resume it in a new process, so the conversation survives:

```bash
claude --continue          # most recent session in this directory
claude --resume <session-id>
```

### 3. A --plugin-dir or local-marketplace plugin moved

Plugins loaded with `--plugin-dir`, from `~/.claude/skills/`, from `CLAUDE_CODE_PLUGIN_DIRS`, or as relative-path plugins in a marketplace you added from a local folder are not copied. They [load in place](https://code.claude.com/docs/en/plugins/loading#in-place-and-copied-plugins), and their hooks receive a `CLAUDE_PLUGIN_ROOT` that points at your source directory. Rename that folder, `git worktree remove` the checkout it lives in, or switch to a branch where it does not exist, and the next hook call fails with this message.

For an `@inline` plugin there is no "current directory" for the reload to find, since the path came from the command line. Put the folder back where the session expects it, or restart with the new path:

```bash
# Claude Code 2.1.310
claude --continue --plugin-dir ./tools/guard-plugin
```

For a local marketplace, restore the folder or fix the entry's `source`, then `/reload-plugins`.

### 4. You deleted the plugin's install by hand

If you removed a version directory and the record in `installed_plugins.json` still points at it, the reload has nothing to switch to. You will see `Plugin "<name>" not cached at <path>` in the `/plugin` **Errors** tab instead of a clean reload. Reinstall in a shell, then reload:

```bash
claude plugin install guard@acme-tools
```

## The fix, step by step

**Step 1: reload.** At the Claude Code prompt:

```text
/reload-plugins
```

It works in the desktop app and in `-p` runs too, as long as you type it yourself (since v2.1.260). Over Remote Control or a relayed Slack message it replies that the command "isn't available over a remote connection in this session."

**Step 2: read the summary line.** The reload prints one line, and that line, not the transcript, tells you whether the hooks recovered:

```text
Reloaded: 4 plugins · 11 skills · 3 agents · 7 hooks · 1 plugin MCP server · 0 plugin LSP servers
```

- `Reloaded:` with no errors line: the hooks no longer point at the missing directory.
- `N errors during load. Run /plugin for details.`: open `/plugin`, go to **Errors**, and fix the message you find there, usually `not cached at` from case 4.
- A line ending in `Run /reload-plugins --force to apply.`: nothing reloaded, so the hooks are still broken. This happens when the reload would add or remove a plugin MCP server and invalidate the prompt cache. Run `/reload-plugins --force` and accept that the next message re-reads the conversation without the cache. A guard that is not running is worse than one cache miss.

**Step 3: prove the hook runs.** Trigger the event on purpose. For a `PreToolUse` guard on `Bash`, ask Claude to run something harmless like `echo hook-check`. For hard proof, start the session with `claude --debug` and look for the hook's exit code in the log under `~/.claude/debug/`, or have the hook append to a file:

```bash
#!/usr/bin/env bash
# scripts/guard.sh in the plugin, Claude Code 2.1.310
# A heartbeat line per run so you can see the hook is alive after a reload
set -euo pipefail
echo "$(date -u +%FT%TZ) guard ran from ${CLAUDE_PLUGIN_ROOT}" >> "${CLAUDE_PLUGIN_DATA}/heartbeat.log"
```

`${CLAUDE_PLUGIN_DATA}` lives at `~/.claude/plugins/data/<plugin-id>/` and survives updates, so the log does not vanish with the old version directory. The path in each line also shows which version the session is running.

## Find stale directories before a hook hits them

The error only appears when a hook fires. You can check ahead of time by comparing the install records with what is on disk. This script lists every recorded `installPath` that is missing, plus every cache version marked as orphaned with its age:

```bash
#!/usr/bin/env bash
# check-plugin-dirs.sh - Claude Code 2.1.310, macOS or Linux, needs jq
set -euo pipefail
root="${CLAUDE_CODE_PLUGIN_CACHE_DIR:-$HOME/.claude/plugins}"
records="$root/installed_plugins.json"

if [[ -f "$records" ]]; then
  # Walk the file for any installPath field so the script does not depend on its nesting
  jq -r '.. | objects | select(has("installPath")) | .installPath' "$records" |
    while read -r p; do
      [[ -d "$p" ]] || echo "MISSING  $p"
    done
fi

now=$(date +%s)
find "$root/cache" -mindepth 4 -maxdepth 4 -name .orphaned_at 2>/dev/null |
  while read -r marker; do
    dir=$(dirname "$marker")
    mtime=$(stat -f %m "$marker" 2>/dev/null || stat -c %Y "$marker")
    echo "ORPHANED $(( (now - mtime) / 86400 ))d  $dir"
  done
```

A `MISSING` line is case 4: reinstall. An `ORPHANED 12d` line is a version some session may still be running, and that session will lose its hooks in about two days. Reload it or restart it before then. `claude plugin list --json` gives the same `installPath` per plugin if you prefer to ask Claude Code instead of reading the file.

## Make a guard fail closed

Reloading fixes the session you noticed. To make sure a missing directory blocks instead of waving actions through, you need the hook to fail closed. Since v2.1.295, a `command` or `http` hook can set `"onFailure": "block"`. The [hooks reference](https://code.claude.com/docs/en/hooks) lists "can't start" as a failure: "a command hook fails to start, for example because the script or executable doesn't exist." In a plugin's `hooks/hooks.json`:

```json
{
  "description": "Block dangerous Bash, fail closed",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash",
            "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/guard.sh"],
            "timeout": 5,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

Two caveats. First, the docs do not say in so many words that the "Plugin directory does not exist" pre-check counts as "can't start", so test it once in a throwaway session: install the plugin, start a session, rename the version directory in another terminal, and ask for a Bash command. If the call is blocked, you are covered. If it runs, treat any hook error notice as a stop signal and reload. Second, `onFailure` does nothing on `Stop`, `SubagentStop`, `TaskCompleted` and `TeammateIdle`, or for `async` hooks. The `Stop` hooks in the tj-agents incident would have failed open either way. The details are in [how to make a Claude Code hook fail closed with onFailure: "block"](/2026/10/how-to-make-a-claude-code-hook-fail-closed-with-onfailure-block/).

## Gotchas that look like the same problem

- **`Stop hook error: Failed with non-blocking status code: /bin/sh: node: command not found`**: the directory exists and the hook ran, but its interpreter is not on the `PATH` of the shell you launched `claude` from. Different fix.
- **A path cut off at a space in stderr**: a shell-form hook uses `${CLAUDE_PLUGIN_ROOT}` without quotes. Use exec form with `args`, as above, or wrap the variable in double quotes. `claude plugin validate` warns about the unquoted form.
- **Hooks that never fire and never error**: often two enabled plugins share a manifest name and only one registers its `hooks.json`. Since v2.1.296 the plugin's details in `/plugin` show a note that begins `Its hooks.json hooks do not run`.
- **Monitors from the same plugin**: `/reload-plugins` switches hooks, MCP servers and LSP servers to the new path, but monitors keep the old one until you restart the session.
- **Writing state into `${CLAUDE_PLUGIN_ROOT}`**: anything a hook saves there disappears with the version directory. Use `${CLAUDE_PLUGIN_DATA}`.

## Related

- [How to make a Claude Code hook fail closed with onFailure: "block"](/2026/10/how-to-make-a-claude-code-hook-fail-closed-with-onfailure-block/) covers the field, the events where it does nothing, and the exit-0 trap.
- [Fix: a PreToolUse hook returns "allow" but a deny rule still blocks the tool call](/2026/09/fix-pretooluse-hook-allow-still-blocked-by-deny-rule/) is the opposite failure, a hook that runs but cannot override a rule.
- [How to package skills and an MCP server as one agent plugin](/2026/08/package-skills-and-an-mcp-server-as-one-agent-plugin/) walks through the plugin layout and the `${CLAUDE_PLUGIN_ROOT}` paths this error is about.
- [Claude Code 2.1.128 loads plugins from .zip archives](/2026/05/claude-code-2-1-128-plugin-zip-worktree-fix/) covers the `--plugin-dir` zip workflow, another session-only plugin source from case 3.
- [Agent Plugins 1.0 vs vendor-specific plugin formats](/2026/08/agent-plugins-1-0-vs-vendor-specific-plugin-formats/) if you ship the same hooks to more than one agent.

## Sources

- [Troubleshoot plugins](https://code.claude.com/docs/en/plugins/troubleshooting#plugin-directory-does-not-exist), "Plugin directory does not exist" and "Plugin directory not found at path".
- [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading), "Find plugins on disk", "Cleanup of previous versions", "Plugins synced from claude.ai" and "When auto-update runs".
- [Plugin commands reference](https://code.claude.com/docs/en/plugins/cli-reference), `/reload-plugins` summary, `--force` and the session-only plugin flags.
- [Plugin manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference#environment-variables), `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}`.
- [Hooks reference](https://code.claude.com/docs/en/hooks), `onFailure`.
- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), 2.1.295 and 2.1.299 entries.
- [anthropics/claude-code#97847](https://github.com/anthropics/claude-code/issues/97847), synced plugin folder moved to `.trash` under an open session.
- [tj-agents/core#384](https://github.com/tj-agents/core/issues/384), `Stop` hooks lost after the 14-day orphan sweep.
