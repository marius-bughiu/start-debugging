---
title: "How to Give Your Coding Agent the Microsoft Agent Framework Builder Skills"
description: "Install agent-framework-builder-dotnet and agent-framework-builder-python into Claude Code, Copilot, Cursor or Codex with gh skill install or npx skills add, pin the version, wire the Learn MCP server, and keep the skill updated."
pubDate: 2026-11-14
template: how-to
tags:
  - "agent-skills"
  - "microsoft-agent-framework"
  - "ai-agents"
  - "claude-code"
  - "github-copilot"
  - "gh-cli"
---

**Short answer:** run `gh skill install microsoft/agent-framework agent-framework-builder-dotnet --agent claude-code --scope user` (swap in `agent-framework-builder-python`, and `cursor`, `codex` or `github-copilot` for your agent), or the cross-agent equivalent `npx skills add microsoft/agent-framework --skill agent-framework-builder-dotnet`. That drops a `SKILL.md` plus nine reference files into your agent's skills folder, and the agent loads them whenever you ask it to build, review or host Agent Framework code. Pin a tag for reproducible installs, add the Microsoft Learn MCP server at `https://learn.microsoft.com/api/mcp` so the skill can look up current APIs, and remember these are development-time skills for your coding agent, not runtime skills for the app you ship.

The skills were announced on November 4, 2026 in [Give your coding agent a head start with Microsoft Agent Framework skills for .NET and Python](https://devblogs.microsoft.com/agent-framework/give-your-coding-agent-a-head-start-with-microsoft-agent-framework-skills-for-net-and-python/), and the [Build Agent Framework apps with a coding agent](https://learn.microsoft.com/en-us/agent-framework/get-started/build-with-coding-agents) page on Learn (updated November 10, 2026) documents the install. Everything below was checked on November 14, 2026 with GitHub CLI 2.95.0, the `gh skill` commands (still marked preview), and the skill metadata versions `0.1` (.NET) and `0.3` (Python).

## Why a builder skill beats the model's memory of Agent Framework

Microsoft Agent Framework moved fast between its preview era and the [1.0 release](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/), and it kept moving after: harness agents, declarative YAML workflows, A2A hosting changes, provider packages split out of the core. A coding agent trained on a snapshot of that history produces code that compiles against nothing. Typical symptoms are Semantic Kernel-shaped `Kernel` plumbing in a project that has no Semantic Kernel reference, `ChatCompletionAgent` instead of `ChatClientAgent`, or every `Microsoft.Agents.AI.*` package added "just in case".

The builder skill attacks that at the source. Its entry point says it outright: choose the smallest framework pattern, load only the relevant reference, and "validate against current APIs instead of relying on remembered preview-era syntax". It does not try to be API documentation. Instead it encodes decisions (which of nine build paths fits the task, which defaults to apply) and then sends the agent to Microsoft Learn for signatures.

This is a different thing from the runtime skills an Agent Framework app can load for its own agents, which we covered in [packaging domain expertise as an agent skill in Microsoft Agent Framework](/2026/07/package-domain-expertise-as-an-agent-skill-microsoft-agent-framework/). The builder skill lives on your machine and talks to Claude Code or Copilot. Your shipped app never sees it, and `pip install agent-framework` or a NuGet restore does not install it.

## What actually lands on disk

Both skills live in the `skills/` folder of [microsoft/agent-framework](https://github.com/microsoft/agent-framework/tree/main/skills), deliberately outside `.github/skills`, `.agents/skills` and `.claude/skills` so that agents working inside the Agent Framework repo itself do not load them as project skills. That also means `gh skill` does not confuse them with the 15 repo-internal skills sitting in hidden directories, which it excludes by default and tells you about:

```text
! 15 skill(s) in hidden directories were excluded, use --allow-hidden-dirs to include them
```

An install produces this tree (identical file names for Python):

```text
agent-framework-builder-dotnet/
├── references/
│   ├── agent-builder.md
│   ├── declarative.md
│   ├── evaluation.md
│   ├── extensibility.md
│   ├── harness-agent-builder.md
│   ├── hosting-and-deployment.md
│   ├── integrations.md
│   ├── observability.md
│   └── workflow-builder.md
└── SKILL.md
```

The .NET `SKILL.md` is roughly 1,100 words and the nine references add about 6,650 more. Only the frontmatter `description` is in context until the skill triggers, and the body tells the agent to read only the one reference matching the chosen path, so a typical task pulls in the entry file plus one reference, not all 7,700 words.

The entry file routes work through a table of nine paths: plain agent, harness agent, workflow or orchestration, declarative definition, evaluation, observability, extensibility, integration, and hosting and deployment. The "harness agent" row, for instance, fires when "the product needs an operating loop with todos, modes, memory, approvals, skills, optional file access, background agents, shell, compaction, or repeated execution". Then come the defaults that most often go wrong in generated code:

- add only the narrow packages needed (`Microsoft.Agents.AI` plus one provider package), not every `Microsoft.Agents.AI.*`;
- check whether a package is released, `-preview` or `-alpha` before depending on it;
- suppress `[Experimental]` diagnostics such as `MAAI001` only deliberately and scoped to the code that uses the API;
- read endpoints and keys through `IConfiguration`, user secrets or environment variables, because the framework does not read configuration for you; prefer a specific credential over `DefaultAzureCredential` in production.

The Python skill mirrors this with Python 3.11 or later, installing the narrow distribution instead of the `agent-framework` meta-package, and the reminder that `.env` files are not read automatically.

## Preview before you install

Skills are prompts with file access. `gh skill install` itself prints a warning that skills "may contain prompt injections or malicious scripts", so read it first:

```bash
# GitHub CLI 2.95.0, gh skill (preview)
gh skill preview microsoft/agent-framework agent-framework-builder-dotnet
gh skill preview microsoft/agent-framework agent-framework-builder-python
```

`preview` renders the tree and the `SKILL.md` in the terminal without writing anything. These two skills contain only Markdown, no scripts.

## Install with gh skill install

The synopsis is `gh skill install <repository> [<skill[@version]>] [flags]`, with `gh skill add` and `gh skills add` as aliases. Two flags decide where the files go:

- `--agent` picks the host: `github-copilot`, `claude-code`, `cursor`, `codex`, `gemini-cli` and about 40 more (`gh skill install --help` prints the list).
- `--scope` is `project` (the default, inside the current git repository) or `user` (your home directory, available in every repo).

```bash
# GitHub CLI 2.95.0
# Claude Code, available in every repo on this machine
gh skill install microsoft/agent-framework agent-framework-builder-dotnet \
  --agent claude-code --scope user

# Cursor, only for the current repository (commit it so the team gets it too)
gh skill install microsoft/agent-framework agent-framework-builder-python \
  --agent cursor --scope project

# Codex
gh skill install microsoft/agent-framework agent-framework-builder-dotnet \
  --agent codex --scope user
```

Watch the defaults. Run without `--agent` in a script or CI job and `gh` installs for `github-copilot` at project scope, which is fine for Copilot and silently useless for Claude Code. Interactively it prompts for the host instead.

`--dir <path>` overrides both `--agent` and `--scope`. That is the escape hatch for an agent whose skills folder `gh` does not know, and it is also a convenient way to inspect a skill without touching any real agent configuration:

```bash
gh skill install microsoft/agent-framework agent-framework-builder-dotnet --dir ./skill-inspect
```

After install, `gh skill list` scans every known agent host in both scopes and shows the path, version and source of each skill, which answers "did it land where Claude Code looks?" without guessing paths. For Claude Code the answer is `~/.claude/skills/` at user scope and `.claude/skills/` at project scope.

## Install with npx skills add

The [skills CLI](https://github.com/vercel-labs/skills) does the same job from npm and needs Node.js 22.20 or later:

```bash
# skills CLI, Node.js 22.20+
npx skills add microsoft/agent-framework --skill agent-framework-builder-dotnet

# non-interactive, user-wide, Claude Code only
npx skills add microsoft/agent-framework --skill agent-framework-builder-python \
  -g -a claude-code -y
```

`-g` installs to the user directory, `-a` (repeatable) selects agents, `-y` skips prompts. At project scope it writes a `skills-lock.json` that `npx skills update` and `npx skills check` use later, and it symlinks by default (pass `--copy` for real files). Its per-agent paths are documented in the repo's `docs/agents.md`: Claude Code uses `.claude/skills/` and `~/.claude/skills/`, while Copilot, Cursor and Codex share `.agents/skills/` at project scope. We read the CLI docs for this section but did not run `npx skills` for this post; the `gh` commands were run.

Pick one installer per machine. Both write `SKILL.md` files to the same folders, but each tracks updates with its own metadata (`gh` injects it into the frontmatter, `skills` keeps a lock file), and mixing them makes "which version is this?" harder to answer than it needs to be.

## Pin the version, and know what @main means

Here the docs and reality drift, so check rather than copy. When the skills were announced, the .NET skill existed only on `main`, so every command used `@main`, and the repo README still says the explicit ref "is required until a tagged Agent Framework release includes the skill". The `skills/README.md` warns why: an unqualified install resolves the latest tagged release, and an older tag simply does not contain the skill.

With no version, `gh skill install` resolves the latest tagged release, falling back to the default branch HEAD. On November 14, 2026 that tag was `python-1.26.0`, and it already contained both skills. The installed frontmatter shows exactly what you got:

```yaml
# injected by gh skill install (unqualified), GitHub CLI 2.95.0
metadata:
    github-path: skills/agent-framework-builder-python
    github-ref: refs/tags/python-1.26.0
    github-repo: https://github.com/microsoft/agent-framework
    language: python
    project: agent-framework
    version: "0.3"
```

The same install with `@main` records `github-ref: refs/heads/main`. That is a moving target: `gh skill update` will follow every commit to `main`, unreleased guidance included. For a team, pin:

```bash
# GitHub CLI 2.95.0: three equivalent ways to pin
gh skill install microsoft/agent-framework agent-framework-builder-python@python-1.26.0
gh skill install microsoft/agent-framework agent-framework-builder-python --pin python-1.26.0
gh skill install microsoft/agent-framework agent-framework-builder-dotnet@<commit-sha>

# skills CLI
npx skills add microsoft/agent-framework@python-1.26.0 --skill agent-framework-builder-python
```

One naming oddity: the repo tags Python releases as `python-*` (`python-1.23.0`, `python-1.26.0`), so the .NET skill can legitimately arrive from a `python-*` tag. The tag is a snapshot of the repository, not a statement about which language the skill targets. Pin a full commit SHA if that ambiguity bothers you.

## Updating and removing

```bash
# GitHub CLI 2.95.0
gh skill update --dry-run                      # report only
gh skill update agent-framework-builder-dotnet # compare tree SHA, re-download
gh skill update --unpin agent-framework-builder-python
```

`gh skill update` compares the local tree SHA from the frontmatter against the remote. Pinned skills are skipped with a notice until you pass `--unpin`. `--force` re-downloads even when nothing changed, which restores files you edited, but it does not delete extra files you added to the folder.

There is no `gh skill remove`: the subcommands are `install`, `list`, `preview`, `publish`, `search` and `update`. Delete the folder that `gh skill list` reports. The skills CLI has `npx skills remove agent-framework-builder-dotnet` (add `-g` for user scope).

## Wire up the Learn MCP server the skill expects

The skill tells the agent to treat Microsoft Learn as the source of truth: search with `microsoft_docs_search`, fetch with `microsoft_docs_fetch`, and use `microsoft_code_sample_search` for a current example. Those are tools of the [Microsoft Learn MCP Server](https://learn.microsoft.com/training/support/mcp-get-started), a Streamable HTTP endpoint at `https://learn.microsoft.com/api/mcp`. Without it, the skill still routes decisions correctly, but the agent falls back to its own memory for signatures, which is exactly what the skill is trying to avoid.

For Claude Code:

```bash
# Claude Code 2.x
claude mcp add --transport http microsoft-learn https://learn.microsoft.com/api/mcp --scope user
```

For VS Code with Copilot, add it to `.vscode/mcp.json`:

```json
{
  "servers": {
    "microsoft-learn": {
      "type": "http",
      "url": "https://learn.microsoft.com/api/mcp"
    }
  }
}
```

Opening the URL in a browser returns an error; it only speaks MCP. If MCP is unavailable, the skill allows the equivalent `mslearn search`, `mslearn fetch` and `mslearn code-search` commands, but only from a trusted, already installed `mslearn` CLI. It explicitly tells the agent not to run an unpinned one on the fly, which is a sensible rule to keep even if you edit the skill.

## Making sure the skill actually triggers

There is no slash command. Agents discover the skill from its `description`, which starts "Use this skill when building, modifying, reviewing, evaluating, integrating, or hosting .NET (C#) applications with Microsoft Agent Framework" and lists agents, harness agents, workflows, tools, sessions, middleware and hosting. Prompts that name the framework trigger it reliably: "add a tool-calling Agent Framework agent to this ASP.NET Core API" will; "add an AI endpoint" may not.

Three things to check when it does not fire:

1. **Wrong host folder.** Run `gh skill list --agent claude-code` (or your host). A skill installed for `github-copilot` by a non-interactive run will not show up.
2. **Scope mismatch.** A project-scope install lives under the git root. Opening a subfolder that is its own repository, or a worktree outside the repo, hides it.
3. **Too many competing skills.** A crowded skills folder dilutes matching and costs context. Claude Code's [`/skill-doctor`](/2026/09/claude-code-2-1-261-skill-doctor-finds-skills-that-only-cost-context/) flags skills that load without ever earning their keep.

If you want the agent to use it every time in an Agent Framework repo, say so in `CLAUDE.md` or `AGENTS.md` ("for Agent Framework work, use the agent-framework-builder-dotnet skill"). That is cheaper than the agent guessing.

## When to install it at project scope instead of user scope

User scope is the right default for an individual: one install, every repo. Project scope wins when a team should get the same guidance, at the same pinned version, the moment they clone. Commit the installed folder (for `gh`, the frontmatter carries the source and tree SHA; for `npx skills`, commit `skills-lock.json` too) and review updates as regular diffs. That is the same argument that makes [NuGet packages shipping skills in a `skills/` folder](/2026/11/nuget-packages-can-ship-agent-skills-in-a-skills-folder/) attractive: the guidance version moves with the code, not with whatever happens to be on each developer's laptop.

A skill is also not the only way to deliver this kind of help. If you are still deciding between a skill, a subagent and an MCP server for your own tooling, [our comparison of skills, subagents and MCP servers in Claude Code](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/) walks through the trade-offs. For Agent Framework, Microsoft picked the right split: a small decision-making skill locally, and live docs over MCP.

### Read next

- [Microsoft Agent Framework 1.0: building AI agents in C#](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/)
- [Migrate a Semantic Kernel app to Microsoft Agent Framework 1.0](/2026/07/migrate-a-semantic-kernel-app-to-microsoft-agent-framework-1-0/)
- [Package domain expertise as an agent skill in Microsoft Agent Framework](/2026/07/package-domain-expertise-as-an-agent-skill-microsoft-agent-framework/)
- [NuGet packages can now carry agent skills](/2026/11/nuget-packages-can-ship-agent-skills-in-a-skills-folder/)

### Sources

- [Give your coding agent a head start with Microsoft Agent Framework skills for .NET and Python](https://devblogs.microsoft.com/agent-framework/give-your-coding-agent-a-head-start-with-microsoft-agent-framework-skills-for-net-and-python/) (Agent Framework blog, November 4, 2026)
- [Build Agent Framework apps with a coding agent](https://learn.microsoft.com/en-us/agent-framework/get-started/build-with-coding-agents) (Microsoft Learn)
- [microsoft/agent-framework `skills/` catalog](https://github.com/microsoft/agent-framework/tree/main/skills)
- [`gh skill install` manual](https://cli.github.com/manual/gh_skill_install)
- [vercel-labs/skills CLI](https://github.com/vercel-labs/skills)
- [Microsoft Learn MCP Server setup](https://learn.microsoft.com/training/support/mcp-get-started)
