---
title: "How to Stop Claude Code From Writing Outside the Repo With permissions.blockWritesOutsideWorkingDirectories"
description: "Set permissions.blockWritesOutsideWorkingDirectories to true and Claude Code 2.1.314+ makes Write, Edit and NotebookEdit refuse any path outside the working directories in every permission mode, bypassPermissions included. What it refuses, what stays writable, why allow rules cannot open it, how /add-dir and additionalDirectories do, what it does to worktrees, and how to pair it with the Bash sandbox so shell commands are fenced too."
pubDate: 2026-11-17
template: "how-to"
tags:
  - "claude-code"
  - "ai-agents"
  - "permissions"
  - "sandboxing"
  - "security"
---

**Short answer:** add `"blockWritesOutsideWorkingDirectories": true` under `permissions` in any Claude Code settings file. From Claude Code v2.1.314 (released October 30, 2026) the `Write`, `Edit` and `NotebookEdit` tools then refuse every path outside the session's working directories, in every permission mode including `bypassPermissions`. No allow rule can open a hole in it; the only way through is to make the directory a working directory with `/add-dir`, `--add-dir` or `additionalDirectories` in user or managed settings. The key does not touch shell commands, MCP tools or hook programs, so turn on the Bash sandbox if you want `cat > ~/.bashrc` fenced as well. The current release at the time of writing is 2.1.326.

## Why "the agent only edits the repo" is not true by default

Most people picture a coding agent as something that edits files in the project it was started in. Claude Code's permission model does not actually draw that line for writes. What happens when Claude decides to write `~/.zshrc`, `/etc/hosts` or a sibling repository depends on your mode:

- **Manual (`default`)**: the edit prompts, like any edit. You can approve it by accident at the end of a long session.
- **`acceptEdits`**: edits are auto-accepted only "for paths in the working directory or additionalDirectories", per the [permission modes docs](https://code.claude.com/docs/en/permission-modes). An edit outside that set still prompts, which is the right behaviour, but it is one keypress away.
- **`auto`**: edits inside the working directory are auto-approved. Edits outside it go to the classifier, which approves anything that looks aligned with your request. "Fix my shell config so `nvm` loads" is a request a classifier will reasonably wave through.
- **`bypassPermissions`**: everything runs. A deny rule such as `Edit(//etc/**)` still blocks, but only for the paths you remembered to list.

The common failure is not malice. It is an agent that decides the cleanest fix for a failing build is to edit `~/.npmrc`, a global git hook, a file in the monorepo next door, or the Claude Code settings file that governs its own permissions. Deny rules for each of those are an open-ended list. `blockWritesOutsideWorkingDirectories` inverts it: one boolean, and the file tools can only write where you started the session plus the directories you explicitly added.

## Turning it on

The key is a boolean, documented in the [settings reference](https://code.claude.com/docs/en/settings-reference#permissions-blockwritesoutsideworkingdirectories):

```json
// ~/.claude/settings.json -- Claude Code 2.1.314 or later
{
  "permissions": {
    "blockWritesOutsideWorkingDirectories": true
  }
}
```

That is the whole configuration. Changes to it need a restart of running sessions to take or lose effect.

### Which files can set it

Unlike `permissions.denyInsteadOfPrompting`, which only user and managed settings can set, this key is honoured from **any** settings file: user, project (`.claude/settings.json`), local (`.claude/settings.local.json`) and managed. That is safe because the setting is one-directional. A `true` in any file the session loads turns the block on, and a `false` is treated exactly like unset. The docs put it plainly: "a repository can turn the block on for itself but can't lift yours."

That gives you three useful placements:

1. **Your user settings**, if you want the fence around every session on your machine.
2. **The repository's `.claude/settings.json`**, committed, if a project wants every contributor's agent to stay inside it. Nobody on the team can switch it off from their own settings while that file says `true`.
3. **Managed settings**, for an organization-wide rule. The key is also on the list of [keys that fail closed](https://code.claude.com/docs/en/managed-settings#keys-that-fail-closed): while Claude Code cannot read the `permissions` object in your managed settings, the block is on regardless.

It can also arrive from a `--settings` value or from a host application that launches Claude Code. If writes are being refused and none of your files mentions the key, that is where to look.

In a [cloud session](https://code.claude.com/docs/en/claude-code-on-the-web) Claude Code might not apply the key at all, because the file tools run inside a container that is already the boundary.

## What a refused write looks like

The quickest check is the one the docs suggest: ask Claude to use the Write tool to create `~/block-test.txt` (assuming your home directory is not a working directory). The tool call fails with a message that names the path and the working directories:

```text
<path> is outside <dirs>; the permissions.blockWritesOutsideWorkingDirectories setting blocks writes outside the working directories. Ask the user to add the directory with /add-dir, or to remove that setting.
```

A shorter variant can also appear:

```text
<path>: Writes outside the working directories are blocked (permissions.blockWritesOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting.
```

Both are tool errors, not prompts. Nothing waits on you, which also makes the key a good companion to [`denyInsteadOfPrompting` for unattended runs](/2026/11/how-to-keep-headless-claude-code-runs-from-stalling-on-permission-prompts/): there is no "approve this one write to `~/.gitconfig`" prompt for a nightly job to stall on, because that write is never on the table. Claude reads the message and either works inside the repo or reports that it needs a directory added.

The [errors reference](https://code.claude.com/docs/en/errors#setting-blocks-writes-outside-the-working-directories) states that this refusal applies "in every permission mode". `bypassPermissions` skips prompts; it does not skip this check.

## What the block refuses and what stays writable

Some of Claude Code's own files stay writable even though they live outside your project, because the product needs them to function:

- plan files
- the session [scratchpad](https://code.claude.com/docs/en/claude-directory#session-scratchpad-directory) directory
- a [background session](https://code.claude.com/docs/en/agent-view)'s `tmp` directory
- `.md` files in this project's [auto memory](https://code.claude.com/docs/en/memory#storage-location) directory

Everything else outside the working directories is refused. On top of that, the block refuses four kinds of writes that might surprise you:

1. **Claude Code settings files, even inside the working directories.** A settings file can lift the block, so letting Claude edit `.claude/settings.json` in the repo would make the whole thing advisory. The refusal reads:

   ```text
   <path>: Writes to Claude Code settings files are blocked while permissions.blockWritesOutsideWorkingDirectories is on, because a settings file can lift that block. While a managed settings folder cannot be resolved, any .json file counts as one.
   ```

   Files passed to `--agents` or `--mcp-config` and the stored copy of server-managed settings count as settings files too. You edit these yourself; `/add-dir` does not help.

2. **Directories that only repository settings add.** If `additionalDirectories` appears only in `.claude/settings.json`, or in `.claude/settings.local.json` while git tracks that file, those directories do not count as working directories for the block. Otherwise a repository could write `"additionalDirectories": ["~"]` and widen your fence to your whole home directory.

3. **A subagent's worktree outside the working directories.** A subagent defined with `isolation: worktree` gets its edits refused when its worktree sits outside the session's working directories.

4. **Auto memory in a directory the repository chose** with `autoMemoryDirectory` in repository settings.

## Letting one directory through

The part that trips people up: **allow rules do not work here.** The docs say it directly: "No allow rule lets Claude's file tools through either block." An `Edit(//tmp/build/**)` allow rule that would normally skip the prompt has no effect on a path the block refuses.

The only way through is to make the directory a working directory:

```bash
# Claude Code 2.1.314+. Start a session that may also write to a shared fixtures repo.
claude --add-dir ../shared-fixtures
```

Inside a running session, `/add-dir ../shared-fixtures` does the same thing. For a directory you want writable in every session, list it in **user or managed** settings:

```json
// ~/.claude/settings.json -- Claude Code 2.1.314+
{
  "permissions": {
    "blockWritesOutsideWorkingDirectories": true,
    "additionalDirectories": ["~/src/shared-fixtures"]
  }
}
```

Putting the same `additionalDirectories` entry in the repository's committed `.claude/settings.json` does **not** open it, for the reason in point 2 above. `/add-dir` also needs the directory to exist, so create it first.

Remember that a working directory is a working directory for everything, not just for the block. Files there become readable without prompts and, in `acceptEdits` or `auto`, editable without prompts. Add the narrowest directory that does the job: `~/src/shared-fixtures`, not `~/src`.

## What it does to worktrees

Turning the key on has one side effect that looks like a bug the first time: Claude Code removes the `EnterWorktree` and `ExitWorktree` tools, or refuses calls to them. A worktree lives outside the current working directory, and switching into it is exactly the kind of move the block exists to stop.

If you rely on worktrees, the [worktrees docs](https://code.claude.com/docs/en/worktrees#claude-has-no-enterworktree-tool) list the ways to keep them:

```bash
# Interactive: start the session inside a fresh worktree, so the worktree IS the working directory
claude --worktree

# Background session: same idea
claude --bg --worktree
```

For background sessions there is a second trap. A background session's edits in your main checkout are refused until it calls `EnterWorktree`, which it no longer has. Besides `--bg --worktree`, you can set `worktree.bgIsolation` to `"none"`, or have Claude create a worktree with `git worktree add` under the directory the session started in, which keeps it inside the fence. For `isolation: worktree` subagents, add the repository's `.claude/worktrees` directory as a working directory (it must exist before `/add-dir` accepts it).

## The gap: Bash, MCP tools and hooks

This is the most important limitation, and it is stated in the key's own docs: it "doesn't limit shell commands, MCP tools, or the programs hooks run." With only this key on, Claude cannot use `Write` on `~/.zshrc`, but it can run:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Whether that runs depends on the normal Bash permission flow: a prompt in Manual mode, the classifier in auto mode, nothing at all in `bypassPermissions`. The same goes for an MCP filesystem server you connected, and for a hook script that writes wherever its author wanted.

To close the shell side, turn on the [Bash sandbox](https://code.claude.com/docs/en/sandboxing). Its default write policy lines up with the block: sandboxed commands can write to the working directory, a per-user temp directory and the directories you added with `--add-dir`, `/add-dir` or `permissions.additionalDirectories`, enforced at the OS level for the command and all its child processes. A combined configuration looks like this:

```json
// ~/.claude/settings.json -- Claude Code 2.1.314+
{
  "permissions": {
    "blockWritesOutsideWorkingDirectories": true
  },
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "filesystem": {
      "allowWrite": ["~/.cache/pnpm"]
    }
  }
}
```

Three details make this pairing hold up:

- **`allowUnsandboxedCommands: false`** removes the escape hatch where a command that fails in the sandbox is retried unsandboxed with your approval. Without it, the shell fence is only as strong as your attention when that retry prompt appears.
- **`sandbox.filesystem.allowWrite`** is how a tool like a package manager gets write access to its cache outside the repo. It applies only to sandboxed shell commands. The file tools still follow the block, so this does not reopen `Write` to `~/.cache`.
- **Path syntax differs.** Sandbox paths use `/tmp/build` for absolute and `~/` for home. Permission rules use `//tmp/build` for absolute and `/path` for project-relative. Mixing them up is a classic way to write a rule that matches nothing; the walkthrough on [why a Write rule is not matched by file permission checks](/2026/08/fix-write-rule-is-not-matched-by-file-permission-checks/) covers the permission-rule side.

The sandbox also keeps its own protected paths, such as `.claude` settings in the launch folder and in added directories, write-denied for sandboxed commands, which closes the "edit the settings file with `sed` instead of `Edit`" route.

MCP tools and hooks have no equivalent switch. Treat them as code you run with your own privileges: review what a filesystem-capable MCP server can reach, and keep hook scripts in a location the agent cannot write to (with the block on, a hook under `~/.claude/hooks/` is outside the repo and therefore off-limits to the file tools).

## Gotchas

**Restart after changing it.** Adding or removing the key does not apply to sessions already running. The docs' instruction for lifting it is "remove the key from every settings file that sets it, then restart Claude Code."

**`false` does nothing.** You cannot override a project's `true` with `false` in your local settings. If you genuinely need to lift a repository's block for one task, that is a conversation about the repository's settings file, not a local override.

**Untracked `settings.local.json` is yours, tracked is the repo's.** `additionalDirectories` in `.claude/settings.local.json` counts only while git reports that file as untracked. In a directory that is not a git repository, Claude Code treats it as repository settings, so put directories you want to keep in your user settings instead.

**Pair it with the read block if you also care about reads.** `permissions.blockReadsOutsideWorkingDirectories` (v2.1.257+) is the sibling key for `Read`, `Grep`, `Glob` and `LSP`. Auto mode even offers to turn it on the first time Claude reads outside the working directories. The write block does not imply the read block.

**Version-gate your fleet.** On a machine running a Claude Code older than 2.1.314 the key is unknown and silently does nothing. Check `claude --version` everywhere you count on it, especially on pinned CI images.

## Related reading

For the bigger picture of what each mode approves before this key gets a say, see [auto mode vs manual approval in Claude Code](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/). The [Claude Code 2.1.251 permission bypass fixes](/2026/08/claude-code-2-1-251-four-ways-around-the-permission-check/) are a good reminder of why a hard boundary beats a long rule list. If secrets on disk are your bigger worry, [`sandbox.credentials` blocks secrets from Bash](/2026/06/claude-code-sandbox-credentials-block-secrets-from-bash/). And if you also run Copilot, the equivalent idea there is [Copilot local sandboxing to restrict what an agent can touch](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/).

## Sources

- [Settings reference: `permissions.blockWritesOutsideWorkingDirectories`](https://code.claude.com/docs/en/settings-reference#permissions-blockwritesoutsideworkingdirectories)
- [Permissions: working directories and the read/write blocks](https://code.claude.com/docs/en/permissions#working-directories)
- [Permission modes: actions no mode auto-approves](https://code.claude.com/docs/en/permission-modes#actions-no-mode-auto-approves)
- [Errors reference: setting blocks writes outside the working directories](https://code.claude.com/docs/en/errors#setting-blocks-writes-outside-the-working-directories)
- [Worktrees: Claude has no `EnterWorktree` tool](https://code.claude.com/docs/en/worktrees#claude-has-no-enterworktree-tool)
- [Sandboxing: configure filesystem writes](https://code.claude.com/docs/en/sandboxing#configure-sandboxing)
- [Claude Code changelog, 2.1.314](https://code.claude.com/docs/en/changelog)
