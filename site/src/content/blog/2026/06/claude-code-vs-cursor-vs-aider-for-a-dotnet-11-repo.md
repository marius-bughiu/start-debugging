---
title: "Claude Code vs Cursor vs Aider for a .NET 11 Repo in 2026"
description: "For a large .NET 11 / C# 14 solution, Claude Code wins on agent quality and runs anywhere a terminal does. Cursor wins if your team wants a GUI and tab completion, as long as you can live without C# Dev Kit. Aider wins on cost and openness."
pubDate: 2026-06-02
template: vs
tags:
  - "comparison"
  - "ai-agents"
  - "claude-code"
  - "cursor"
  - "dotnet-11"
---

If you maintain a real .NET 11 solution -- a dozen `csproj` files, an EF Core data layer, a couple of ASP.NET Core services, a test project that takes a minute to run -- and you want an AI coding agent to actually work inside it, the choice in mid-2026 comes down to three tools. The short answer: **pick Claude Code if you want the strongest agent and can run a terminal; pick Cursor if your team wants an editor with tab completion and accepts that Microsoft's C# Dev Kit will not load; pick Aider if you want a free, open-source, model-agnostic tool and you only want to pay for API tokens.** My default for a serious multi-project .NET 11 codebase is Claude Code 2.1 running `claude-opus-4-8`, with the C# LSP plugin installed and the build/test commands written into `CLAUDE.md`.

This post is the long version of that call. Everything below is pinned to versions current as of June 2, 2026: Claude Code 2.1.160, Cursor 3.6 (released May 29, 2026), and Aider 0.86.2 (released February 12, 2026). The .NET assumption is `<TargetFramework>net11.0</TargetFramework>` with `<LangVersion>14.0</LangVersion>`.

## The feature matrix

This is the table you came for. Read it top to bottom, then jump to the section for whichever tool the table makes you curious about.

| Feature | Claude Code 2.1 | Cursor 3.6 | Aider 0.86.2 |
| --- | --- | --- | --- |
| Form factor | Terminal CLI + VS Code/JetBrains extension | Full IDE (VS Code fork) | Terminal CLI + basic web UI |
| Tab completion / ghost text | No | Yes (custom Tab model) | No |
| Default coding model | `claude-opus-4-8` | "Auto" / Composer 2.5 | BYO (no default key) |
| Model choice | Claude tier only (Opus 4.8, Sonnet 4.6, Haiku 4.5) | Multi-vendor (Claude, GPT-5.x, Gemini 3.x, Grok, Composer) | Any provider via API key or Ollama |
| C# intelligence | `csharp-ls` plugin (Roslyn-based) | Base OSS C# extension / OmniSharp / DotRush | tree-sitter repo map (no LSP) |
| C# Dev Kit support | N/A (CLI) | No (MS license blocks forks) | N/A |
| Build / test integration | `dotnet build`/`test` as shell calls | Terminal tasks / OSS extension | `--test-cmd`/`--lint-cmd` with auto-fix loop |
| Parallel agents | Subagents + background agents | Parallel agents, `/multitask`, worktrees | One session at a time |
| MCP / skills | Yes (MCP, skills, hooks, slash commands) | Yes (MCP, rules, skills, hooks) | No |
| Context window | 1M tokens (Opus 4.8 / Sonnet 4.6) | Model-dependent | Model-dependent + repo map |
| Pricing model | Flat subscription or API tokens | Subscription + usage-based tokens | API tokens only (tool is free) |
| Open source | No | No | Yes (Apache-2.0) |

The three tools are not really the same kind of thing, and that is the first thing to internalize. Cursor is an editor you live in all day. Claude Code is an agent you delegate tasks to from a terminal. Aider is a git-native pair programmer that sits between the two and costs nothing but tokens.

## When to pick Claude Code

Claude Code 2.1 is the right call when the agent's raw competence on a large, messy solution matters more than having a GUI.

- **You have a big multi-project solution and want the agent to navigate it itself.** Claude Code reads the codebase through agentic search rather than a pre-built embeddings index, backed by the 1M-token context window on `claude-opus-4-8` and `claude-sonnet-4-6`. There is no "wait for indexing" step when you `git pull` a branch with 400 changed files. For C# symbol accuracy, install the Anthropic-verified C# LSP plugin, which wraps the Roslyn-based `csharp-ls` language server and explicitly supports .NET Core, .NET Framework, and multi-project solutions:

  ```bash
  # Claude Code 2.1.160, .NET SDK 6.0+ required for csharp-ls
  dotnet tool install --global csharp-ls
  # then add the C# LSP plugin from the Claude Code plugin marketplace
  ```

- **You want to script the agent into CI or a scheduled job.** The headless form, `claude -p`, pipes cleanly and pairs with the GitHub Actions integration. That is how you wire up autonomous PR review or a nightly issue-triage routine, and it is a class of automation neither Cursor nor Aider targets as directly.

- **You want parallel work without losing the plot.** Claude Code's subagents and background agents let you fan a task out across isolated contexts. If you have not seen how far this goes, [its dynamic workflows can spread a single prompt across up to 1,000 subagents](/2026/05/claude-code-dynamic-workflows-opus-4-8/), each with its own model and tool set.

The thing that makes or breaks Claude Code on a .NET repo is `CLAUDE.md`. Because build and test are ordinary shell calls (`dotnet build`, `dotnet test`, `dotnet format`), the agent only knows your conventions if you write them down. A two-line file that says "run `dotnet test tests/Unit` before claiming a fix works" changes behavior far more than people expect. I wrote a whole piece on [how to make a CLAUDE.md that actually changes what the model does](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) rather than being decorative.

Cost is the honest downside. On a Claude Pro subscription ($20/month, billed monthly, or $17/month annually) Claude Code is bundled and you do not meter tokens. But if you run it against the Anthropic API pay-as-you-go, `claude-opus-4-8` is $5 per million input tokens and $25 per million output tokens, and Claude Code defaults Opus to "high" effort, so a long autonomous loop can run up a bill. The Max plans ($100/month for 5x, $200/month for 20x) exist precisely because heavy users hit the Pro ceiling.

## When to pick Cursor

Cursor 3.6 is the pick when your developers want to live in an editor, see inline diffs, and get tab completion, and when the team would rather click than type CLI flags.

- **You value flow-state autocomplete.** Cursor's custom Tab model predicting your next multi-line edit is still the feature people switch for. Neither Claude Code nor Aider offers ghost-text completion at all. If half your day is small edits, that compounds.

- **You want to pick the model per task.** Cursor is genuinely multi-vendor: Claude (through Opus 4.8 and Sonnet 4.6), the GPT-5.x and Codex line, Gemini 3.x, Grok, and Cursor's own Composer 2.5, with an "Auto" router that balances cost and capability. If your shop is not committed to Anthropic, that flexibility is real.

- **You want parallel agents with a visual workspace.** Cursor 3.0 introduced an Agents Window that runs many agents in parallel across worktrees, the cloud, and remote SSH, with a tiled layout to watch them. The 3.6 "auto-review" run mode lets longer autonomous runs proceed with fewer approval clicks. Cursor has been [shipping multi-repo cloud agent environments](/2026/05/cursor-3-4-multi-repo-cloud-agent-environments/) aggressively this year, and there is now [a TypeScript SDK that exposes the same agent as a library](/2026/05/cursor-typescript-sdk-programmatic-coding-agents/).

Pricing is subscription-plus-usage. Pro is $20/month and bundles roughly $20 of model usage plus Auto and Composer usage; Pro+ is $60/month, Ultra is $200/month. Teams seats are $32/month billed annually ($40 monthly). Once the included usage is spent, on-demand token charges accrue in arrears, and with heavy parallel-agent use that can move faster than you expect.

There is one .NET-specific catch serious enough that it has its own section below. Read it before you standardize a .NET team on Cursor.

## When to pick Aider

Aider 0.86.2 is the pick when you want an open-source, model-agnostic tool, you are comfortable in a terminal, and you want to pay for nothing but the tokens you actually use.

- **You want zero tool cost and full model freedom.** Aider is Apache-2.0 and BYO-API-key. It runs against Anthropic, OpenAI, Gemini, DeepSeek, Grok, OpenRouter, or a local model through Ollama. There is no subscription floor: a quiet week costs you nothing.

- **You want git-native discipline.** Aider auto-commits each change with a sensible message, so every AI edit is a revertible commit. For a .NET repo where you want a clean, bisectable history of what the agent did, that is a genuine workflow advantage.

- **You want to keep token cost down on a big repo.** Instead of stuffing whole files into context, Aider builds a repo map with tree-sitter: a ranked, concise outline of the important classes and signatures across the codebase. C# is a first-class supported language for both the repo map and the linter, so it will surface your `.cs` types without loading every file. You control the budget with `--map-tokens`.

Wiring Aider into a .NET 11 build is a one-liner of configuration:

```bash
# Aider 0.86.2, .NET 11 solution
aider --model sonnet \
      --test-cmd "dotnet build && dotnet test" \
      --auto-test \
      --lint-cmd "csharp: dotnet format --verify-no-changes"
```

With `--auto-test`, Aider runs the command after each edit and, on a non-zero exit, feeds the compiler or test output back to the model and tries to fix it. That closes a real loop on a typed language like C#.

Aider's own polyglot leaderboard (225 Exercism exercises) is the cleanest public signal of edit quality: `gpt-5` at high effort tops it at 88.0% for about $29 of API spend per full run, with `gpt-5` medium close behind at 86.7% for roughly $18, which it recommends as the best cost/quality balance. The honest limitations: no GUI, no autocomplete, and you manage context yourself by adding and dropping files. If you push too much in, you hit the same wall everyone does, which is why [context window exceeded errors during an Aider refactor](/2026/05/fix-context-window-exceeded-during-an-aider-refactor/) are a known failure mode with a known fix.

## The benchmark, and why you should not trust a single number

Comparison posts love a SWE-bench Verified leaderboard. I am going to disappoint you on purpose, because the honest answer is more useful.

The verified-from-Anthropic coding numbers are: Opus 4.6 scored 80.8% on SWE-bench Verified in March 2026, and Opus 4.7 scored 87.6% in April 2026. For Opus 4.8, Anthropic's launch material leads with agentic and computer-use results (84% on Online-Mind2Web) rather than a headline SWE-bench number in the article text; the widely-circulated 88.6% figure for Opus 4.8 comes from third-party aggregators, not the primary source, so treat it as unconfirmed.

More important than any one percentage is the scaffold caveat, which is widely reported and matters here: **the same base model can swing 15 or more points on SWE-bench Verified depending on the agent harness around it.** Cursor, Claude Code, and Aider all running Sonnet 4.6 are three different scores, because the prompt, the context selection, the edit format, and the retry loop differ. A cross-tool table that holds the model constant is still not apples-to-apples, because the scaffold is the product.

So the practical read is: pick the tool whose harness fits your workflow, then pick the best model it will run. All three can run Claude Sonnet 4.6 or better, so the model is rarely the differentiator. Form factor is, and for .NET specifically, the next section is.

## The gotcha that picks for you: C# Dev Kit licensing

If you are choosing for a .NET team, this single fact may decide it. Microsoft's C# Dev Kit -- the modern bundle that gives VS Code its solution explorer, solution-aware build and test, and the integrated test runner UI -- is **license-restricted to official Microsoft products**: VS Code, vscode.dev, and GitHub Codespaces. It will not legally or technically run in Cursor, because Cursor is a VS Code fork, not an official Microsoft product.

That does not leave Cursor blind to C#. The base open-source C# extension (the Roslyn-based LSP host) installs fine and gives you IntelliSense, go-to-definition, refactoring, and formatting. .NET developers on Cursor typically fall back to that, to OmniSharp, or to a third-party extension like DotRush for solution and test workflows. But you lose the Dev Kit's polished solution tree and integrated test explorer, and build/test tend to run through `dotnet` CLI tasks rather than a first-class UI.

Weigh it honestly:

- **Claude Code** sidesteps the issue entirely. It is a CLI and runs `dotnet` commands directly; with the `csharp-ls` plugin you get Roslyn-grade symbol intelligence without any Dev Kit dependency.
- **Aider** also sidesteps it. There is no IDE, so there is no extension license to violate; it leans on tree-sitter and your `--test-cmd`.
- **Cursor** is the only one of the three where this is a live constraint. For many teams the base C# extension is fine. For a team that depends on the Dev Kit test explorer and solution management, it is a deal-breaker, and you should know that before the migration, not after.

This is the kind of platform constraint that overrides preference, which is exactly why it belongs in the decision.

## The recommendation, restated with the full context

For a large, multi-project .NET 11 / C# 14 solution in mid-2026:

- **Default to Claude Code 2.1** running `claude-opus-4-8` (or `claude-sonnet-4-6` to control cost), with the C# LSP plugin installed and your build, test, and lint commands written into `CLAUDE.md`. It has the strongest agent on a messy solution, the cleanest CI story through `claude -p`, no indexing wait, and no Dev Kit licensing problem. Put it on a Pro or Max subscription so token cost is predictable.
- **Choose Cursor 3.6** if your team's productivity is built on living in an editor with tab completion and visual diffs, and you have confirmed the base OSS C# extension or DotRush covers what you need without C# Dev Kit. Its multi-model routing and parallel agents are excellent; just go in with eyes open on the licensing gap and the usage-based bill.
- **Choose Aider 0.86.2** if you want an open-source, model-agnostic, git-native tool with no subscription floor, you are happy in a terminal, and you want to pay only for the API tokens you burn. Its repo map and `--auto-test` loop make it punch well above its (nonexistent) price.

The tools are converging on the same agent loop but make different bets on form factor and lock-in. Match the bet to your team, not to the leaderboard.

## Related reading

- [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/)
- [Claude Code's dynamic workflows fan a single prompt out to up to 1,000 subagents](/2026/05/claude-code-dynamic-workflows-opus-4-8/)
- [How to pipe Cursor's context to an Aider session for multi-agent refactors](/2026/05/how-to-pipe-cursors-context-to-an-aider-session-for-multi-agent-refactors/)
- [Cursor 3.4 adds multi-repo environments for cloud agents](/2026/05/cursor-3-4-multi-repo-cloud-agent-environments/)
- [Fix: context window exceeded during an Aider refactor](/2026/05/fix-context-window-exceeded-during-an-aider-refactor/)

## Sources

- Claude Code changelog and overview, [code.claude.com/docs/en/changelog](https://code.claude.com/docs/en/changelog) and [code.claude.com/docs/en/overview](https://code.claude.com/docs/en/overview)
- Claude model overview and pricing, [platform.claude.com/docs/en/about-claude/models/overview](https://platform.claude.com/docs/en/about-claude/models/overview) and [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- "Introducing Claude Opus 4.8," [anthropic.com/news/claude-opus-4-8](https://www.anthropic.com/news/claude-opus-4-8)
- Claude Code C# LSP plugin, [claude.com/plugins/csharp-lsp](https://claude.com/plugins/csharp-lsp)
- Cursor changelog and models/pricing, [cursor.com/changelog](https://cursor.com/changelog) and [cursor.com/docs/models-and-pricing](https://cursor.com/docs/models-and-pricing)
- "Announcing C# Dev Kit for Visual Studio Code," [devblogs.microsoft.com](https://devblogs.microsoft.com/visualstudio/announcing-csharp-dev-kit-for-visual-studio-code/), plus the Cursor forum thread on the Dev Kit license, [forum.cursor.com](https://forum.cursor.com/t/the-c-dev-kit-extension/76226)
- Aider docs: repo map, languages, and lint/test, [aider.chat/docs/repomap.html](https://aider.chat/docs/repomap.html), [aider.chat/docs/languages.html](https://aider.chat/docs/languages.html), [aider.chat/docs/usage/lint-test.html](https://aider.chat/docs/usage/lint-test.html); leaderboard at [aider.chat/docs/leaderboards](https://aider.chat/docs/leaderboards/)
