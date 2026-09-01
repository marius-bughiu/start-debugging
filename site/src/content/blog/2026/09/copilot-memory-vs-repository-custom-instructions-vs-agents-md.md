---
title: "Copilot Memory vs Repository Custom Instructions vs AGENTS.md: Which One the Model Actually Reads"
description: "Instructions files are deterministic and always sent. AGENTS.md sits at the bottom of the documented repository precedence list. Copilot Memory is a separate store Copilot writes for itself, read by only three surfaces, and it is not in the precedence list at all. Here is the support matrix and the rule for deciding where each convention belongs."
pubDate: 2026-09-01
template: vs
tags:
  - "comparison"
  - "github-copilot"
  - "ai-agents"
  - "agent-skills"
  - "copilot-instructions"
  - "llm"
---

If you have `.github/copilot-instructions.md`, an `AGENTS.md`, a couple of `*.instructions.md` files, and Copilot Memory switched on, you have four systems competing to steer the same model, and only three of them are deterministic. The short version: put hard rules in `.github/copilot-instructions.md`, put per-path rules in `.github/instructions/*.instructions.md`, keep `AGENTS.md` only if you also run Claude Code or Codex against the same repo, and treat Copilot Memory as a cache you audit rather than a config file you author. Memory does not appear anywhere in GitHub's documented precedence list, expires after 28 days of disuse, and is read by exactly three Copilot surfaces.

Pinning the moving parts, because every claim below is version dependent: GitHub Copilot Memory in public preview as of the [March 4, 2026 changelog](https://github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default-for-pro-and-pro-users-in-public-preview/) with user-level preferences added [May 15, 2026](https://github.blog/changelog/2026-05-15-copilot-memory-supports-user-preferences-for-pro-pro-users/), VS Code 1.135 for the local memory tool, and the GitHub Copilot custom instructions docs as of the September 2026 revision.

## The matrix that answers the question

| | `.github/copilot-instructions.md` | `.github/instructions/*.instructions.md` | `AGENTS.md` | Copilot Memory | VS Code memory tool |
| --- | --- | --- | --- | --- | --- |
| Who writes it | You | You | You | Copilot | Copilot (or you, by asking) |
| Deterministic | Yes | Yes, when `applyTo` matches | Yes | No | No |
| In the documented precedence list | Yes (rank 2b) | Yes (rank 2a) | Yes (rank 2c, lowest of the repo tier) | No | No |
| Scope | Whole repo | Glob-matched files | Nearest file in the directory tree | Repo facts + per-user preferences | User / repo / session |
| Where it lives | Git | Git | Git | GitHub servers | Local disk |
| Expires | Never | Never | Never | 28 days unused | On clear (session scope: end of chat) |
| Read by GitHub.com Copilot Chat | Yes | No | No | No | No |
| Read by Copilot cloud agent | Yes | Yes | Yes | Yes | No |
| Read by Copilot code review | Yes | Yes | Yes (GitHub.com only) | Repo facts only | No |
| Read by Copilot CLI | Yes | Yes | Yes | Yes | No |
| Read by Copilot Chat in VS Code | Yes | Yes | Yes | No | Yes |
| Cross-vendor | No | No | Yes | No | No |

Two rows in that table cause most of the confusion in real repos, so they are worth stating plainly. Copilot Chat on github.com reads *only* the repo-wide file: not your `applyTo` globs, not your `AGENTS.md`. And Copilot Memory is invisible to every IDE surface, because VS Code ships its own unrelated memory implementation that stores files on your laptop.

## Instructions files are configuration, memory is an inference

The mental model that fixes this: instructions files are a config file that ships with the repository, and Copilot Memory is a knowledge base the model builds about the repository. GitHub is explicit about the intent in the [Copilot Memory concept doc](https://docs.github.com/en/copilot/concepts/agents/copilot-memory): the goal is to reduce "the need for regular, manual maintenance of custom instruction files" by letting Copilot discover facts on its own.

That is a real benefit, and it is also the reason you should not push a rule you care about into Memory. Memory entries are created only in response to Copilot activity, only by users who have Memory enabled, and repository-level facts only by users with write access. You cannot open a pull request that adds a memory. You cannot review one in a diff. Two engineers on the same repo can get different behavior if one of them has the org policy off.

Instructions files are the opposite in every respect. They are text in git, they show up in code review, they are identical for everyone who clones the repo, and they are sent with the request rather than retrieved by relevance.

## The documented precedence order, and the hole in it

GitHub publishes an explicit order in [About customizing GitHub Copilot responses](https://docs.github.com/en/copilot/concepts/prompting/response-customization), highest first:

1. Personal instructions
2. Repository custom instructions
   1. Path-specific instructions in any applicable `.github/instructions/**/*.instructions.md` file
   2. Repository-wide instructions in `.github/copilot-instructions.md`
   3. Agent instructions (for example, `AGENTS.md`)
3. Organization custom instructions

Note where `AGENTS.md` lands: below both Copilot-native instruction files. If you write "prefer 4-space indentation" in `AGENTS.md` and "prefer tabs" in `.github/copilot-instructions.md`, the documented winner is tabs. This surprises teams who adopted `AGENTS.md` as the single source of truth after the cross-vendor push, because in Claude Code and Codex it *is* the top-level file, while in Copilot it is the fallback.

The hole: Copilot Memory is not on that list. GitHub documents no precedence between a stored memory and an instruction file. In practice the instruction files are prompt content and memories are retrieved facts injected alongside them, so a direct contradiction is resolved by the model rather than by a rule. That is exactly the situation you want to avoid, which is why "do not let Memory hold anything you would argue about in code review" is the practical guidance.

The precedence list also carries a caveat worth internalizing: "all sets of relevant instructions are provided to Copilot." Nothing is dropped. Precedence is a hint to the model about which line to follow, not a filter that removes the loser from the prompt. Conflicting instructions cost you tokens *and* consistency.

## When to reach for each one

**Use `.github/copilot-instructions.md`** for the rules that are true everywhere in the repo and that you would enforce in review: the package manager, the test command, the error-handling convention, the fact that migrations live in one folder. It is the only file every Copilot surface reads, including github.com Chat and Copilot code review in VS Code. Keep it short. It is sent with every request.

**Use `.github/instructions/NAME.instructions.md`** when the rule is true only sometimes. The `applyTo` frontmatter is a comma-separated glob list:

`.github/instructions/ef-migrations.instructions.md`, verified against the GitHub Copilot docs revision of September 2026:

```md
---
applyTo: "src/Infrastructure/Migrations/**/*.cs"
excludeAgent: "code-review"
---

Every migration must implement a non-empty `Down()`.
Never edit a migration that has already shipped: add a new one.
```

Two mechanics that bite here. First, if you omit `applyTo`, the file is not applied automatically at all. Second, `excludeAgent` accepts `code-review` or `cloud-agent` and lets you keep an authoring rule out of the reviewer's prompt, which is the cleanest way to stop Copilot code review from leaving comments about a convention that only matters while writing.

**Use `AGENTS.md`** when more than one vendor's agent runs against the repo. That is its whole reason to exist. Copilot supports one or more `AGENTS.md` files stored anywhere in the tree, and per the [repository instructions how-to](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions), "the nearest `AGENTS.md` file in the directory tree will take precedence." For a monorepo that is genuinely useful: `services/billing/AGENTS.md` beats the root file when Copilot is working in `services/billing`. In VS Code that nesting is behind `chat.useNestedAgentsMdFiles` and is still flagged experimental, so do not build your whole convention layer on it yet.

`CLAUDE.md` and `GEMINI.md` are also accepted, but only as a single file at the repository root, with one exception: Copilot CLI and VS Code additionally read `.claude/CLAUDE.md`, and VS Code reads `~/.claude/CLAUDE.md` for personal instructions. If you already maintain a `CLAUDE.md`, [the patterns that make it change model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) transfer directly.

**Use Copilot Memory** for the long tail you were never going to write down. Which service owns which table. That two config files must stay in sync. That a build step needs a flag on Windows. GitHub's own example in the concept doc is the cross-surface handoff: if the cloud agent discovers how the repo handles database connections, code review can later flag inconsistent patterns using that same fact.

## What Memory actually stores, and for how long

Memory has two kinds of entries with different rules.

Repository-level facts are stored with citations that point at the code supporting them. Before using a fact, Copilot re-checks those citations against the current branch and uses only validated facts. That validation step is what makes Memory tolerable: a fact captured from a pull request that was closed without merging cannot change behavior unless the current codebase still substantiates it. Repository owners can review and delete these under repository Settings, Copilot, Memory.

User-level preferences are stored with citations that may include direct user quotes, and they follow the user across repositories rather than sticking to the repo. Copilot CLI applies both repo facts and the initiating user's preferences. Copilot code review applies repository-level facts only, and never user preferences, which is correct: your commit-message taste should not shape a review comment on someone else's PR.

Anything unused is deleted after 28 days, with the timer resetting each time an entry is validated and used. Memory is enabled per user, not per repository. It is on by default on individual plans; on Copilot Business and Copilot Enterprise an administrator must enable the policy before individual users can opt out of it. On those plans, preferences are owned by the billing entity, and a user holding licenses from multiple places must select a default billing entity before any user-level preferences are generated at all. If your enterprise users report that Memory "does nothing," check that setting before filing anything.

## VS Code's memory tool is a different product with the same name

This trips people up constantly, so: the memory in [VS Code agents](https://code.visualstudio.com/docs/agents/run/memory) is not Copilot Memory. It is a built-in agent tool, in preview, toggled by `chat.tools.memory.enabled`, storing files locally on your machine in three scopes.

| Scope | Path | Across sessions | Across workspaces |
| --- | --- | --- | --- |
| User | `/memories/` | Yes | Yes |
| Repository | `/memories/repo/` | Yes | No |
| Session | `/memories/session/` | No | No |

The one number to remember: only the first 200 lines of user memory are automatically loaded into the agent's context at the start of every session. Everything beyond that is retrieved on demand or not at all. The Plan agent uses session scope to persist `plan.md` for the current conversation.

Management is coarse. `Chat: Show Memory Files` lists everything across scopes, `Chat: Clear All Memory Files` wipes all of it, and deleting an individual file is not supported yet. The documented workaround is to ask the agent to update a specific memory file. If you want per-project rules that survive a `Clear All`, they belong in an instructions file, not in memory.

## Proving what actually loaded

Do not guess. Each surface exposes the loaded set.

In VS Code, right-click in the Chat view and select **Diagnostics** to open the chat customization diagnostics view, which lists every loaded instruction file and any parse errors. The References section of a chat response also names the instruction files used for that turn.

In Copilot CLI, run `/instructions` to list the instruction files discovered for the session and toggle individual files on or off. This is the fastest way to answer "is my `AGENTS.md` even in scope from this working directory," because the CLI discovers instruction files from the repository root, the current working directory, intermediate directories, and directories nested in the path of the file it is working on.

For the surfaces with no introspection, the sentinel trick still works. Put a line like `INSTRUCTIONS_SENTINEL_2026_09` at the top of the file and ask Copilot to repeat it. The same checklist in [why Copilot ignores repository custom instructions in VS Code](/2026/05/fix-github-copilot-ignores-repository-custom-instructions-in-vs-code/) applies to every file type discussed here.

Two settings-level gotchas worth checking while you are in there. `chat.instructionsFilesLocations` defaults to `.github/instructions`, so an `*.instructions.md` file anywhere else is invisible until you add its folder. And `chat.includeApplyingInstructions` gates pattern-based instructions entirely, so a correct `applyTo` glob still does nothing when that setting is off.

```jsonc
// VS Code 1.135 settings.json
{
  "chat.useAgentsMdFile": true,
  "chat.useNestedAgentsMdFiles": false, // experimental as of 1.135
  "chat.useClaudeMdFile": true,
  "chat.includeApplyingInstructions": true,
  "chat.instructionsFilesLocations": {
    ".github/instructions": true,
    "docs/agent-rules": true
  },
  "chat.tools.memory.enabled": true,
  "github.copilot.chat.organizationInstructions.enabled": true
}
```

## The gotchas that decide it for you

**Copilot code review reads instructions from the head branch.** When merging `my-feature-branch` into `main`, Copilot uses the instructions and skills from your changes, not from the base. That means you can test an instructions change in the same pull request that introduces it, which is a genuinely good property and one Memory cannot offer.

**Copilot CLI defines no precedence between instruction files.** The CLI docs are blunt: it combines all applicable user-level, repository, and agent instructions, de-duplicates identical copies, and "does not define a general precedence order between these files." If you rely on `.github/copilot-instructions.md` beating `AGENTS.md`, that assumption holds on github.com and does not hold in the CLI.

**`@` file references are not universal.** In `.github/copilot-instructions.md`, `AGENTS.md`, and `CLAUDE.md`, Copilot CLI expands `@relative/path` inline and follows references recursively. It does *not* expand references in `GEMINI.md` or in `*.instructions.md` files, and absolute paths or `~/` paths are never loaded. If you are keeping a thin root file that points at deeper docs, that split matters.

**Set `COPILOT_HOME`** if you want the CLI to read user-level instructions from somewhere other than `$HOME/.copilot`, for example in a container image shared by a team.

## The recommendation

Author your conventions as files. `.github/copilot-instructions.md` for what is always true, `.github/instructions/*.instructions.md` with tight `applyTo` globs for what is sometimes true, and `AGENTS.md` only when a second vendor's agent needs the same rules. When all three exist, remember that `AGENTS.md` loses on github.com and has no defined ranking in the CLI, so do not let it hold anything that contradicts the Copilot-native files.

Leave Copilot Memory on, and audit it. Repo Settings, Copilot, Memory once a sprint takes two minutes and catches the fact captured from an abandoned branch before it shapes a review comment. When a memory turns out to encode something you actually want enforced, that is your signal to promote it into an instructions file where it can be reviewed, versioned, and relied upon. Memory is how the agent notices your conventions. Instructions files are how you commit to them.

If your always-true file is getting long enough that you are tempted to paginate it, the rule has probably outgrown instructions entirely and belongs in a skill: see [how to give a Copilot Agent Skill access to your repo conventions](/2026/05/how-to-give-a-copilot-agent-skill-access-to-your-repo-conventions/) for where that line sits.

## Related

- [Fix: GitHub Copilot ignores repository custom instructions in VS Code](/2026/05/fix-github-copilot-ignores-repository-custom-instructions-in-vs-code/)
- [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/)
- [Migrate Copilot prompt files to Agent Skills](/2026/07/migrate-copilot-prompt-files-to-agent-skills/)
- [Claude Code skills vs subagents vs MCP servers: when to build each](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/)
- [How to structure a monorepo so Claude Code's context stays small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/)

## Sources

- [About GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory), GitHub Docs
- [About customizing GitHub Copilot responses](https://docs.github.com/en/copilot/concepts/prompting/response-customization), GitHub Docs, precedence list
- [Custom instructions support](https://docs.github.com/en/copilot/reference/custom-instructions-support), GitHub Docs, per-surface matrix
- [Adding repository custom instructions for GitHub Copilot](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions), GitHub Docs
- [Adding custom instructions for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions), GitHub Docs
- [Memory in VS Code agents](https://code.visualstudio.com/docs/agents/run/memory), VS Code docs
- [Use custom instructions in VS Code](https://code.visualstudio.com/docs/agent-customization/custom-instructions), VS Code docs
- [Copilot Memory now on by default for Pro and Pro+ users in public preview](https://github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default-for-pro-and-pro-users-in-public-preview/), GitHub Changelog
- [Copilot Memory supports user preferences for Pro, Pro+ users](https://github.blog/changelog/2026-05-15-copilot-memory-supports-user-preferences-for-pro-pro-users/), GitHub Changelog
