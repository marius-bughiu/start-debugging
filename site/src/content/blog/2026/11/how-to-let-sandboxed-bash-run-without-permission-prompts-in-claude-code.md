---
title: "How to Let Sandboxed Bash Run Without Permission Prompts in Claude Code With sandbox.autoAllowBashIfSandboxed"
description: "Claude Code 2.1.324/2.1.325 flipped sandbox.autoAllowBashIfSandboxed to false, so sandboxed Bash commands prompt again. How to turn auto-allow mode back on with /sandbox or settings.json, what still prompts (deny and content-scoped ask rules, critical rm paths, env-prefix forms, plan mode, unknown hosts), how to keep the sandbox strict enough to trust, and how to pin the setting for an organization."
pubDate: 2026-11-21
template: "how-to"
tags:
  - "claude-code"
  - "ai-agents"
  - "sandboxing"
  - "permissions"
  - "managed-settings"
  - "security"
---

**Short answer:** set `"autoAllowBashIfSandboxed": true` under `sandbox` (next to `"enabled": true`) in a Claude Code settings file, or open `/sandbox`, go to the **Mode** tab and pick **auto-allow**. Claude Code then approves a Bash command with no prompt whenever that command actually runs inside the OS sandbox (Seatbelt on macOS, bubblewrap on Linux and WSL2). The key defaulted to `true` until Claude Code v2.1.324/v2.1.325 (both published November 13, 2026); since then sandboxed commands go through the regular permission flow unless you opt back in. Deny rules, content-scoped ask rules such as `Bash(git push *)`, dangerous `rm` targets, plan mode and anything that runs outside the sandbox still prompt or get blocked. The current release at the time of writing is 2.1.330 (November 20, 2026).

## Why sandboxed commands started prompting again

The sandbox has two jobs. It fences what a Bash command can touch (filesystem writes, network hosts), and in auto-allow mode it doubles as the approval: if the OS is going to stop `npm test` from writing outside the repo or calling an unknown host, there is less reason to ask you before it runs.

For most of the sandbox's life, turning it on also turned on auto-allow. The [settings reference](https://code.claude.com/docs/en/settings-reference) now documents `sandbox.autoAllowBashIfSandboxed` as a boolean with default `false` and notes the default used to be `true` before v2.1.324. The [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) lists the change under 2.1.325 as sandboxed Bash commands now following "the normal permission flow by default". Both versions shipped on the same day, so if you updated around November 13, 2026, the symptom is the same: a session that used to run `pnpm install`, `pytest` and `cargo build` silently now asks for each one.

Nothing about the sandbox itself got weaker or stronger in that release. Only the approval behaviour changed. The [sandboxing docs](https://code.claude.com/docs/en/sandboxing) name the two behaviours:

- **Auto-allow mode**: Claude Code approves a command automatically, with no prompt, when the command runs inside the sandbox.
- **Regular permissions mode**: every Bash command goes through your normal allow, ask and deny rules and your permission mode, even when it is sandboxed.

Also note what this is not. `/sandbox` is not a permission mode, and auto-allow is unrelated to `auto` permission mode, which sends tool calls to a classifier. You can run auto-allow under the default manual mode, under `acceptEdits`, or under `auto`.

## Turning auto-allow on

### From the `/sandbox` panel

Run `/sandbox` inside a session. The panel has **Mode**, **Overrides** and **Config** tabs (plus **Dependencies** on Linux when `bubblewrap` or `socat` is missing). On **Mode**, select auto-allow. The choice is saved to `.claude/settings.local.json` for the current project only, which is gitignored, so it does not follow you to other repositories and does not reach teammates.

### From settings.json

To make it the default everywhere, put both keys in your user settings:

```json
// ~/.claude/settings.json -- Claude Code 2.1.325 or later
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true
  }
}
```

`autoAllowBashIfSandboxed` does nothing on its own. If `sandbox.enabled` is `false` (the default), no command runs sandboxed, so no command qualifies for auto-allow. The key can be set in any settings scope: user, project (`.claude/settings.json`), local, `--settings` on the command line, or managed settings.

For a headless run, pass the same object inline:

```bash
# Claude Code 2.1.325+, non-interactive run with sandbox auto-allow
claude -p "run the test suite and fix the first failure" \
  --settings '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false}}'
```

One environment variable overrides all of this: per the sandboxing docs, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` turns auto-allow off. If a CI job sets it to scrub credentials from subprocesses, expect regular permissions mode no matter what the settings say.

### Platform requirements

- **macOS** uses Seatbelt. Nothing to install.
- **Linux** uses bubblewrap and needs `bubblewrap` and `socat` (`sudo apt-get install bubblewrap socat` or `sudo dnf install bubblewrap socat`). On Ubuntu, AppArmor can block bubblewrap's user namespaces; the docs include a `/etc/apparmor.d/bwrap` profile.
- **WSL2** behaves like Linux. WSL1 is not supported.
- **Native Windows** runs commands unsandboxed, which means auto-allow never applies there.

If the sandbox cannot start, by default Claude Code continues without it, and again nothing gets auto-allowed. Set `sandbox.failIfUnavailable: true` if you would rather the session refuse to start than quietly fall back to prompting (or, worse, to running unsandboxed under a permissive mode).

## What still prompts in auto-allow mode

Auto-allow removes the generic "Claude wants to run this command" prompt. It does not override every other check. From the sandboxing docs and the 2.1.x changelog:

**Deny rules still win.** A command that matches a `Bash` deny rule is blocked whether or not it would have run sandboxed.

**Content-scoped ask rules still prompt.** `Bash(git push *)` in `permissions.ask` forces a prompt for `git push origin main` even inside the sandbox. A bare `Bash` (or `Bash(*)`) ask rule is the exception: it is skipped for commands that run sandboxed, and still applies to everything else.

```json
// ~/.claude/settings.json -- Claude Code 2.1.325+
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true
  },
  "permissions": {
    "deny": ["Bash(curl *)", "Bash(wget *)"],
    "ask": ["Bash(git push *)", "Bash(npm publish *)", "Bash(terraform apply *)"]
  }
}
```

With that file, `npm test` runs unprompted, `git push` asks, and `curl` is refused. Keep the docs' own caveat in mind: permission rules are enforced by Claude Code's parser, not the OS, so `Bash(curl *)` does not stop `sh -c 'curl ...'` or a Python script that opens a socket. The sandbox's network proxy is what actually stops those.

**Dangerous deletes still prompt.** Since 2.1.116, auto-allow no longer bypasses the safety check for `rm` or `rmdir` aimed at `/`, `$HOME` or other critical system directories.

**Some command shapes go through the regular flow.** The docs list forms such as `FOO=bar npm test`, `make CC=clang` and `eval "ls"`. They still run sandboxed; they just ask first. An allow rule matching the exact command stops the repeat prompt. Earlier releases chipped away at the false positives: 2.1.139 fixed commands with `$VAR` and `$(cmd)` expansions not being auto-approved, and 2.1.292 lets interpreter commands with an env prefix (`FOO=bar python3 app.py`) run unprompted when strict sandbox mode is set in user, managed or `--settings` scope.

**Monitor tool commands are never auto-approved.** 2.1.290 fixed sandboxed Monitor commands skipping the prompt; they now follow your permission rules.

**Plan mode does not auto-allow.** Even a bare `Bash` ask rule applies in plan mode, including to read-only commands.

**Unknown network hosts are a separate decision.** A sandboxed command that connects to a host you have not allowed stays in the sandbox, and the proxy decides based on your permission mode, not on auto-allow: manual and `acceptEdits` prompt, `bypassPermissions` allows, `auto` refuses unless the command declared the host and the classifier approved it, and `dontAsk` refuses. Hosts in `deniedDomains`, or anything outside the list when `network.strictAllowlist` is `true`, are refused in every mode. So auto-allow plus manual mode can still produce a network prompt on the first `pip install` from a new index.

**Commands outside the sandbox get no auto-allow at all.** That covers two cases:

1. Commands matching `sandbox.excludedCommands`. The docs call exclusion "a convenience, not a security boundary", and excluded commands go through the regular permission flow.
2. Commands Claude retries with `dangerouslyDisableSandbox` after they fail in the sandbox. Under manual and `acceptEdits` you get a prompt titled "Bash command (unsandboxed)"; under `auto` the classifier reviews it; under `dontAsk` it is denied; under `bypassPermissions` it just runs. A matching allow rule (say `Bash(curl *)`) also approves the retry without a prompt, unless you added an ask rule for `Bash(dangerouslyDisableSandbox:true)`, which takes precedence.

## Making auto-allow safe enough to trust

Auto-allow is only as good as the fence. If you are going to stop reviewing every command, tighten the sandbox first.

```json
// ~/.claude/settings.json -- Claude Code 2.1.325+, auto-allow with a strict fence
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "excludedCommands": [],
    "filesystem": {
      "allowWrite": ["~/.cache/pip", "~/.npm"],
      "denyRead": ["~/.aws", "~/.ssh"]
    },
    "network": {
      "allowedDomains": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"],
      "strictAllowlist": true
    }
  },
  "permissions": {
    "ask": ["Bash(git push *)"]
  }
}
```

What each piece buys you:

- **`allowUnsandboxedCommands: false`** is what the **Overrides** tab calls strict sandbox mode. Claude Code ignores `dangerouslyDisableSandbox`, so a command that fails in the sandbox stays failed instead of offering an unsandboxed retry. Without it, auto-allow covers the cheap commands and the risky ones arrive as a prompt you can approve on reflex.
- **`failIfUnavailable: true`** prevents a silent downgrade when bubblewrap is missing or a container blocks namespaces.
- **`filesystem.allowWrite`** adds the cache directories your package managers need. By default sandboxed commands can write only to the working directory, a per-user temp directory, and directories added with `--add-dir`, `/add-dir` or `permissions.additionalDirectories`. Protected paths such as `.claude` settings, hooks, skills, `.mcp.json`, `.bashrc`, `.zshrc` and `.gitconfig` stay write-denied even inside writable directories.
- **`filesystem.denyRead`** matters more than people expect: default read access covers most of the machine. For secrets you need masked rather than hidden, see [`sandbox.credentials`](/2026/06/claude-code-sandbox-credentials-block-secrets-from-bash/).
- **`network.allowedDomains` plus `strictAllowlist`** turns the unknown-host prompt into a refusal, which is what you want in an unattended run. The docs warn that broad entries such as `github.com` can become exfiltration paths, and that the proxy does not inspect TLS by default.

Two settings undercut auto-allow and are worth refusing in review. `sandbox.filesystem.disabled: true` keeps network isolation but drops filesystem isolation; the docs warn that with auto-allow a sandboxed command can then write files that later commands run or read and "use them to widen its own access". And `allowUnixSockets` entries such as `/var/run/docker.sock` effectively give the command the host. Docker and `watchman` are both incompatible with the sandbox anyway (use `jest --no-watchman`).

To fence the file tools the same way the sandbox fences the shell, pair this with [`permissions.blockWritesOutsideWorkingDirectories`](/2026/11/how-to-stop-claude-code-writing-outside-the-repo-with-blockwritesoutsideworkingdirectories/), which applies to `Write`, `Edit` and `NotebookEdit` in every permission mode.

## Pinning the behaviour for an organization

The 2.1.325 changelog has a second line that matters to admins: when managed settings turn the sandbox on, "set `sandbox.autoAllowBashIfSandboxed: true` in your highest-ranking managed source" to keep commands running without prompts. Setting it in a lower-ranked managed source, or relying on the old default, now leaves users in regular permissions mode.

The reverse also applies. The sandboxing docs note that while an admin-required sandbox is active, a repository's own settings files can still set `autoAllowBashIfSandboxed`. If your policy is "sandbox on, every command reviewed", set the key explicitly to `false` in managed settings so a cloned repo's `.claude/settings.json` cannot switch auto-allow on:

```json
// managed-settings.json -- Claude Code 2.1.325+, sandbox required, auto-allow pinned
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": false,
    "network": {
      "allowManagedDomainsOnly": true,
      "allowedDomains": ["registry.npmjs.org", "pypi.org"]
    }
  }
}
```

Flip the last boolean to `true` if your policy is the opposite: sandbox required, prompts removed for everything it contains.

## When auto-allow is the wrong tool

Auto-allow answers "should Claude ask before a command the OS has already fenced?" It is not the only way to cut prompts, and sometimes another lever fits better:

- **Allow rules** (`Bash(npm test)`, `Bash(pytest *)`) are precise and work without the sandbox, including on native Windows. They are the right choice when only a handful of commands are noisy, and the fix for the env-prefix forms that still prompt under auto-allow.
- **`auto` permission mode** lets a classifier approve commands that look aligned with your request, sandboxed or not. It covers MCP tools and file edits too, at the cost of a model judgment per call. See [auto mode vs manual approval](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/) for what each mode approves.
- **`bypassPermissions`** removes prompts entirely. Only deny rules and hard blocks remain, and an unsandboxed retry runs with no prompt, so it should never be paired with `allowUnsandboxedCommands: true`.

For unattended jobs the sandbox matters for a second reason. 2.1.326 changed the sandbox to ask before some lines that set environment variables when auto-allow is off, and the changelog notes that "unattended runs can refuse them". A cron'd `claude -p` that worked last week can therefore start failing on `export NODE_ENV=test && npm test` after an update, with no human there to answer. Either turn auto-allow on for that job or add exact allow rules; [keeping headless Claude Code runs from stalling on permission prompts](/2026/11/how-to-keep-headless-claude-code-runs-from-stalling-on-permission-prompts/) covers the general pattern.

## Quick troubleshooting

- **Commands still prompt after enabling it.** Check that `sandbox.enabled` is `true` in the effective settings, that you are not on native Windows, that the Linux **Dependencies** tab is empty, and that `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is not set. Then check whether the prompt is from a content-scoped ask rule, a critical `rm`, an env-prefix form, plan mode, or the network proxy.
- **A command used to run unprompted and now shows "Bash command (unsandboxed)".** It failed in the sandbox and Claude asked to retry outside it. Fix the cause (add a write path or domain) rather than approving; set `allowUnsandboxedCommands: false` to stop the retry offer.
- **Team members see different behaviour.** The `/sandbox` Mode tab writes to `.claude/settings.local.json`, which is per-machine. Put the key in `.claude/settings.json` or managed settings for a shared default.
- **Deny rules seemed to be skipped under auto-allow on older builds.** 2.1.289 fixed deny and ask rules being missed behind environment-variable prefixes and bare assignments. Update before trusting a deny list.

## Related

- [The four permission-check bypasses fixed in Claude Code 2.1.251](/2026/08/claude-code-2-1-251-four-ways-around-the-permission-check/) are a good argument for letting the OS, not a rule parser, be the boundary.
- [Fail-closed vs fail-open hooks](/2026/10/fail-closed-vs-fail-open-hooks-for-coding-agent-guardrails/) covers the hook layer you can add on top of the sandbox.
- [Copilot local sandbox vs cloud sandbox vs dev container](/2026/10/copilot-local-sandbox-vs-cloud-sandbox-vs-dev-container/) compares the equivalent options on the GitHub side.

## Sources

- [Claude Code docs: Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Claude Code docs: Settings reference](https://code.claude.com/docs/en/settings-reference)
- [Claude Code docs: Permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code changelog (2.1.116, 2.1.139, 2.1.289, 2.1.290, 2.1.292, 2.1.325, 2.1.326)](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [`@anthropic-ai/claude-code` release dates on npm](https://www.npmjs.com/package/@anthropic-ai/claude-code?activeTab=versions)
