---
title: "Claude Code 2.1.251 Closes Four Ways Around the Permission Check"
description: "A symlink swapped after the check, deny rules that stopped applying through a symlinked search path, a marketplace command pointing outside its plugin, and a workflow script read before approval. Four fixes in one release, all the same bug."
pubDate: 2026-08-29
tags:
  - "claude-code"
  - "ai-agents"
  - "security"
  - "devops"
---

Claude Code 2.1.251 shipped on August 28, 2026 with a changelog long enough to bury the interesting part. Four of its fixes share one shape: something reached a file that the permission check had not approved. Read them together and they stop looking like four bugs and start looking like one class.

## The check passed, then the path changed

The headline fix is a textbook time-of-check-to-time-of-use race. Per the changelog, file tools "following a symlink swapped inside the working directory after the permission check" could "read or write outside the approved location." You approve an edit to `src/config.ts`, the path resolves, the check says yes — and between that yes and the write, the entry becomes a symlink pointing somewhere else.

The part worth internalizing is who gets to do the swapping. A `postinstall` script, a file watcher, a dev server, a test harness, or the agent's own previous Bash command all run while the session is open. The working directory is not a quiet place, and it was never a trusted one.

Grep and Glob had the read-side version of the same hole: `Read(...)` deny rules were not applied to files reached through a symlinked search path. A deny rule on `secrets/**` held for a direct read and quietly stopped holding when the same file was matched through a symlink pointing into it.

## Two paths that came from config, not from you

The other two came in through files that ship with a repository. Plugin commands declared in a marketplace entry could point outside the plugin directory; those paths are now rejected with an explicit path-traversal error. And the Workflow tool read a `scriptPath` outside what the session was allowed to read *before* the permission check ran — then quoted the contents back in its error message, which turns a blocked read into a successful one.

## The same release keeps tightening settings

Half a dozen other changes in 2.1.251 point the same direction, all treating a cloned repository as untrusted input:

- Project settings can no longer switch on detailed beta tracing or raw API body logging. That was your request bodies.
- `ANTHROPIC_CUSTOM_HEADERS` from managed or project settings now needs approval when it sets a credential, org/tenant, routing, or API-behavior header such as `Authorization` or `Host`.
- Project-level `.claude/settings.json` `env` no longer sets `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR`, or `TMPDIR`/`TMP`/`TEMP` — set those in your shell, user, or managed settings.
- Bash permission checks stopped auto-approving assignments of an arithmetic expression to an integer shell variable (`OPTIND=1/0`, `RANDOM=2+2`), which had been slipping through as harmless.
- Server-managed settings that terminate sandbox TLS, proxy sandbox traffic, inject credentials, or otherwise weaken sandbox isolation now require approval before they apply.

None of these is a dramatic exploit on its own. Together they close the gap between "the permission system said no" and "the file stayed unread."

## Upgrading

`claude update`, or reinstall from npm. Two same-week notes: 2.1.250 landed the same day and is bug fixes only, and 2.1.248 (August 27) added `--restricted` — equivalently `CLAUDE_CODE_RESTRICTED=1` — which strips the tools that run commands or code, drops `WebFetch` unless you name it in `--tools`, keeps file tools inside the working directory, refuses `bypassPermissions`, and ignores user, project, and local settings files entirely. That flag and this week's fixes are the same argument from two directions: the settings and paths a repository hands you are input, not configuration.

The marketplace fix in particular lands one week after 2.1.238 gave catalogs real reach, [letting a plugin marketplace mint its own auth headers](/2026/08/claude-code-2-1-238-marketplaces-mint-their-own-auth-headers/) — the more a marketplace entry can do, the more the directory boundary around it has to hold.
