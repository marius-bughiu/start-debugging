---
title: "How to Let Aider Edit Files Outside the Git Repository"
description: "Aider is git-first by default. To edit files outside the repo, pass them on the command line, use /read for reference docs, drop --no-git for unversioned dirs, or symlink. Five working patterns with exact flags."
pubDate: 2026-05-26
tags:
  - "ai-agents"
  - "aider"
  - "llm"
  - "claude-code"
  - "anthropic-sdk"
---

Aider treats your git repo as the universe. The repo map indexes it, the auto-commit logic versions it, and the `/add` command refuses anything outside it. That works beautifully until the file you need to touch lives at `~/.config/nvim/init.lua`, or in a sibling repo, or in `/etc`. Then `/add /etc/nginx/nginx.conf` returns "outside the git repo", and you stare at the prompt wondering whether you have to copy the file in, edit it, and copy it back. You don't. There are five clean ways to let aider read or edit files outside the current git repository, and which one is right depends on whether the file should be edited, just read for context, or whether the whole directory should drop git integration entirely.

Tested against aider `0.86.0`, Claude Sonnet 4.6 (`claude-sonnet-4-6`) and Claude Opus 4.7 (`claude-opus-4-7`), and the [aider git integration docs](https://aider.chat/docs/git.html) and [options reference](https://aider.chat/docs/config/options.html).

## TL;DR

1. **Pass external paths on the CLI**: `aider ~/file.md src/api.py`. Aider accepts absolute paths and home-directory shortcuts at launch time, even if they live outside the current repo.
2. **Use `/read` (or `--read FILE`) for reference docs**: read-only files can live anywhere on the filesystem, including a different repo. Use this for conventions files, design docs, and "show me this and rewrite my code to match it".
3. **Drop `--no-git`** when the working directory is not a repo at all. Aider edits files in place with no commits, no repo map, no git history.
4. **Symlink into the repo** when you need full edit access to one file that lives elsewhere. Aider will follow the symlink and the changes land on the real file.
5. **Run aider from a parent directory** that contains both repos when you need to edit across two sibling projects. The repo map gets bigger; the cross-repo edits get much simpler.

The "right" choice depends on three questions: do you want aider to **edit** the file or just **read** it, is the destination **versioned** in any git repo, and is this a **one-off** or a permanent setup.

## Why aider is git-first by default

Aider is "AI pair programming in your terminal" and it leans hard on git for safety. Every edit is auto-committed with a message prefixed by `aider:`, `/undo` reverts the last commit, dirty files are pre-committed before aider rewrites them, and the repo map walks the working tree to figure out which symbols exist. The [git integration docs](https://aider.chat/docs/git.html) describe this as a deliberate choice: the model can rewrite half your codebase, and you should be one `git reset` away from undoing it.

The downside is that the safety rails fight you the moment you wander outside the working tree. Inside the chat, `/add ../sibling-repo/foo.py` returns "is not in the git repository". This is intentional; the [`/add` command](https://aider.chat/docs/usage/commands.html) only adds files aider can version. But there are several escape hatches the docs do not always surface in one place.

## Approach 1: pass external paths at launch

The simplest, least-documented trick is that the CLI is more permissive than the in-chat `/add`. When you invoke aider, any path you list as a positional argument is added to the chat, regardless of whether it lives inside the current repo:

```bash
# aider 0.86.0
cd ~/projects/api-server
aider src/auth.py ~/.config/myapp/settings.toml ../shared-types/user.ts
```

All three files are now in the editing context. `src/auth.py` is inside the git repo and will be auto-committed on edit. The other two are outside; aider will still rewrite them on disk, it just will not version those changes. The same trick works for `--file`:

```bash
aider --file src/auth.py --file ~/.config/myapp/settings.toml
```

This is documented in [issue #865](https://github.com/Aider-AI/aider/issues/865) as the canonical workaround: files outside the repo can be added when invoking aider, but `/add` rejects them in-chat. The team marked the inconsistency as a bug and partially closed it, but the asymmetry still exists in 0.86: at-launch is permissive, mid-session `/add` is strict.

So if you know up front which external files you need, list them on the command line. If you discover one mid-session, the cleanest move is to `/exit` and relaunch with the new path appended, rather than fighting `/add`.

## Approach 2: `/read` and `--read` for reference docs

If you do not need aider to **edit** the file, you do not need to bring it into the editable set at all. Aider has a separate read-only channel:

```bash
# at launch
aider --read CONVENTIONS.md --read ~/notes/architecture.md src/api.py

# or mid-session
> /read-only ~/notes/architecture.md
> /read-only ../sibling-repo/openapi.yaml
```

The [`/read-only` command](https://aider.chat/docs/usage/commands.html) and the `--read` flag both accept absolute paths and `~` expansion. The file is loaded into context, the model can quote from it and reason about it, but aider will refuse to write to it. This is the right tool for:

- Conventions files that live in `~/.config/aider/conventions/python.md`.
- An OpenAPI spec or schema definition that lives in a different repo you do not want to clone in.
- A `git diff` you generated outside of aider so the model can review your manual changes.
- A long design doc you want the model to follow without burning edit-format tokens on it.

Two practical wins from `/read-only`. First, read-only files become eligible for [prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) on Anthropic, because they do not change between turns. A 30k-token conventions file goes from 30k input tokens per turn to roughly 3k cached tokens per turn, which is a real cost difference if you are running aider all day. The [Anthropic SDK prompt caching guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) covers the ergonomics; aider wires it up automatically for `--read` files.

Second, read-only files do not count toward the editable context the way `/add`-ed files do, so a 1k-line architecture doc is much less likely to push you into [a context-window blowup](/2026/05/fix-context-window-exceeded-during-an-aider-refactor/).

You can also pin a list in `.aider.conf.yml`:

```yaml
# .aider.conf.yml at the repo root
read:
  - CONVENTIONS.md
  - ~/notes/architecture.md
  - ../shared-types/openapi.yaml
```

Aider loads these on every launch. There is a known wrinkle here: with `--subtree-only`, [aider resolves the `read` paths relative to the current subtree](https://github.com/Aider-AI/aider/issues/3754), not the git root. If you start aider in `repo/services/api/` with a `read: CONVENTIONS.md` line and the file is actually at `repo/CONVENTIONS.md`, the load fails silently. Use absolute paths or `~`-expanded paths in the config to dodge that bug.

## Approach 3: `--no-git` for unversioned directories

The previous two approaches still assume you launched aider from inside a git repo. If the directory is not a repo at all (a homedir config tree, a scratch directory, a mounted volume), aider will offer to `git init` it for you. If you refuse, you have to launch with `--no-git`:

```bash
cd ~/.config/nvim
aider --no-git init.lua plugins/lsp.lua
```

The [`--no-git` flag](https://aider.chat/docs/config/options.html) completely disables git integration. Aider will not init a repo, will not auto-commit, will not run `/undo`, and the [repo map is also disabled in this mode](https://github.com/Aider-AI/aider/issues/3371). That last part matters: with no repo map, aider has no idea what other symbols exist in the directory, so it cannot suggest "you also need to edit `keymaps.lua`" on its own. You have to add every file you want it to edit explicitly.

For pure config-file edits ("rename this option in `init.lua`") this is fine. For anything that needs cross-file awareness, this is the wrong tool. Use approach 1 or 5 instead.

`--no-git` also means you should run your own backup. The aider docs are explicit: "You should ensure you are keeping sensible backups of the files you are working with." A quick `cp init.lua init.lua.bak` before a non-trivial session is cheap insurance.

## Approach 4: symlinks for one external file in an otherwise normal repo

Sometimes the constraint is narrow: 99% of the work is in a regular repo, but there is one file outside it that aider needs to edit alongside everything else. Auto-commits, the repo map, `/undo`, all of it should work for the in-repo files. You just want this one outside file to be reachable as if it were inside.

A symlink works:

```bash
# Linux/macOS
cd ~/projects/api-server
ln -s ~/.config/myapp/settings.toml ./external-settings.toml
git update-index --skip-worktree external-settings.toml  # optional, hides from git

# Windows (PowerShell, run as admin or with dev mode on)
New-Item -ItemType SymbolicLink -Path .\external-settings.toml -Target $HOME\.config\myapp\settings.toml
```

Aider resolves the symlink, edits the underlying real file, and `git diff` shows changes to the symlink target on disk. The auto-commit happens on the symlink path inside the repo, not the real file, so the git history shows "I edited `external-settings.toml`" even though the real change landed in `~/.config/`. That is a tradeoff: clean reproducibility for the model, slightly fuzzy git history for the human. For one-off cross-boundary edits, it is usually worth it.

Use `--skip-worktree` or add the symlink to `.gitignore` if you do not want it committed to the project.

## Approach 5: run aider from a parent directory for sibling-repo edits

If you find yourself constantly editing two sibling repos together (a TypeScript SDK and the API that consumes it, a Flutter app and a shared Dart package, a frontend and a generated client), the most ergonomic move is to launch aider from their common parent:

```bash
cd ~/projects   # contains both api-server/ and api-client/
aider api-server/src/users.ts api-client/src/generated.ts
```

If `~/projects` is itself not a git repo, aider will offer to init one. Refuse, or accept and add `.git` to your dotfile ignore list. With `--no-git` this approach still works for cross-repo edits, just without auto-commits.

The catch is the repo map. With both repos visible, aider sees the union of their files and the map can balloon. Cap it explicitly:

```bash
aider --map-tokens 2048 api-server/src/users.ts api-client/src/generated.ts
```

The default is already 1024, but it scales up to ~8k tokens when no files are added; pinning a hard cap keeps you out of context-blowup territory. This is the same trick that helps when [you are structuring a monorepo for Claude Code's context budget](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/) and the same trick that resolves [most aider context-window errors](/2026/05/fix-context-window-exceeded-during-an-aider-refactor/).

## Gotchas worth knowing

**`/add` rejects but the CLI accepts.** This is still surprising after 0.86. If you need an external file mid-session, the cleanest path is `/exit` plus a relaunch with the new path appended. Trying to argue with `/add` will only get you "is not in the git repository".

**`--subtree-only` is not the answer.** It is tempting to read `--subtree-only` as "only edit my subtree, ignore everything else". What it actually does is restrict the repo map and edit scope to the current subtree of an *existing* git repo. It does not let you edit files outside the repo; if anything, it tightens the boundary further. Use it when you want to run aider in `repo/services/api/` without indexing `repo/legacy/` or `repo/docs/`.

**Auto-commits never touch external files.** Even when aider successfully edits a file outside the repo, the auto-commit only includes the in-repo changes. The external file is edited in place with no git record. If you care about a trail for those edits, either move the file into a repo (even an ad-hoc `git init` in `~/.config/`) or run `cp` snapshots before each session.

**Read-only beats editable for big files.** If a doc is over a few hundred lines, default to `/read-only`. The model can still propose edits and tell you to apply them, and you avoid the prompt-cache invalidation and edit-format token cost that come with marking a file as editable.

**`.aiderignore` controls which files inside the repo aider can see.** This is the opposite problem of this post, and the answer is also documented in [the git integration page](https://aider.chat/docs/git.html). If you have files inside the repo you want to keep out of the chat, a `.aiderignore` file works just like `.gitignore`.

## Related

- [Fix: Context Window Exceeded During an Aider Refactor](/2026/05/fix-context-window-exceeded-during-an-aider-refactor/) — the long-form fix for the failure mode you hit when you add too many external files.
- [How to pipe Cursor's context to an Aider session for multi-agent refactors](/2026/05/how-to-pipe-cursors-context-to-an-aider-session-for-multi-agent-refactors/) — a cross-tool pattern that leans heavily on `/read-only`.
- [How to structure a monorepo so Claude Code's context stays small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/) — same repo-map cap idea, different agent.
- [How to add prompt caching to an Anthropic SDK app and measure the hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/) — why `--read` is the cheap option, with numbers.
- [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) — the equivalent of an aider conventions file, in Claude Code land.

## Sources

- [Aider git integration docs](https://aider.chat/docs/git.html)
- [Aider CLI options reference](https://aider.chat/docs/config/options.html)
- [Aider in-chat commands](https://aider.chat/docs/usage/commands.html)
- [Aider conventions docs](https://aider.chat/docs/usage/conventions.html)
- [Issue #865: files outside of a repo can be added when invoking aider](https://github.com/Aider-AI/aider/issues/865)
- [Issue #3371: Can I add files when running --no-git?](https://github.com/Aider-AI/aider/issues/3371)
- [Issue #3754: `read` filelist resolves relative to current subtree](https://github.com/Aider-AI/aider/issues/3754)
- [Anthropic prompt caching guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
