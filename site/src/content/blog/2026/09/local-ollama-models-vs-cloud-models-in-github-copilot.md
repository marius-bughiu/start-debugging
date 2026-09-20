---
title: "Local Ollama Models vs Cloud Models in GitHub Copilot: What You Give Up"
description: "BYOK lets you point GitHub Copilot at a local Ollama model in VS Code, the Copilot CLI, and the Copilot app. You keep chat and agent mode. You lose inline completions, semantic search, embeddings, /delegate, and roughly 20 points of SWE-bench. Here is the exact trade."
pubDate: 2026-09-20
template: vs
tags:
  - "comparison"
  - "github-copilot"
  - "ollama"
  - "llm"
  - "ai-agents"
  - "byok"
  - "local-llm"
---

**Short answer:** run a local Ollama model in Copilot when the constraint is data egress or air-gapped work, not when the constraint is cost. BYOK covers chat and agent mode only, so your `Tab` key goes back to a GitHub-hosted model no matter what you configure, and the best models you can actually fit on a developer laptop sit about 20 points below frontier models on agentic coding benchmarks. If you are staying on cloud models anyway, a local Ollama model is still worth wiring up as the offline fallback for the days the provider has an incident.

Versions in this post: BYOK went GA in VS Code 1.117 on April 22, 2026, landed in the Copilot CLI on April 7, 2026, and in the GitHub Copilot app on June 23, 2026. Local model numbers are for `qwen3-coder:30b` (30B total parameters, 3.3B active) as published on the Ollama library, and Copilot billing is the AI credits model that all plans moved to on June 1, 2026.

## The feature matrix

| | Local Ollama model (BYOK) | GitHub-hosted cloud model |
| :-- | :-- | :-- |
| Chat and agent mode | Yes, if the model does tool calling | Yes |
| Inline code completions | No, BYOK does not apply | Yes, and they cost no AI credits |
| Next edit suggestions | No | Yes, and they cost no AI credits |
| Semantic search / `#codebase` | No, needs embeddings on GitHub's service | Yes |
| MCP servers | Yes, they run client-side | Yes |
| GitHub MCP server, GitHub code search | Only if you also sign in to GitHub | Yes |
| `/delegate` to the cloud agent | No, that runs on GitHub's servers | Yes |
| Copilot code review on a PR | No, server-side feature | Yes |
| Copilot CLI sub-agents (`explore`, `task`, `code-review`) | Yes, they inherit the provider config | Yes |
| Vision | Only if the model supports it | Yes |
| Context window | Whatever you can afford in VRAM | 128k and up |
| Where the API key lives | Client-side only, stored locally | Not applicable |
| Telemetry to GitHub | Off with `COPILOT_OFFLINE=true` | On |
| Marginal cost per token | Electricity | AI credits from your plan allowance |
| Who can turn it off | Enterprise or org policy | Enterprise or org policy |

The two rows that decide this for most people are the completions row and the semantic search row. Everything else is negotiable.

## What "BYOK" actually covers, in GitHub's words

The VS Code documentation is unusually blunt about the boundary: "Some features still require a GitHub account: semantic search, inline suggestions (code completions), and features that rely on embeddings. BYOK applies to the chat experience and utility tasks only."

Read that carefully, because it is narrower than the marketing. "Utility tasks" means the small background calls VS Code makes for you: commit message generation, PR descriptions, chat title generation, intent detection. Those route through your BYOK model, and you can steer them separately with `chat.utilityModel` and `chat.utilitySmallModel`, or turn the routing off with `chat.byokUtilityModelDefault`.

What does not route through your model is the thing you touch most often. Inline completions and next edit suggestions are a separate service with its own models, its own latency budget, and its own proxy. Point Copilot at `qwen3-coder:30b` and every chat turn is local, while every keystroke-triggered ghost text suggestion still leaves your machine. If your reason for going local is "no source code may leave this network", BYOK alone does not get you there. You have to disable completions too, which means paying for a Copilot seat and using maybe a third of it.

The Copilot CLI draws a slightly different line. There, GitHub authentication becomes optional once you configure a provider, and the docs list what breaks without it: `/delegate` (it hands the session to the Copilot cloud agent, which runs on GitHub's servers), the GitHub MCP server (it needs a token to call GitHub APIs), and GitHub code search (it queries GitHub's index). Everything else, including the built-in `explore`, `task`, and `code-review` sub-agents, inherits your provider configuration and runs against your local model.

## Wiring a local model into VS Code

The built-in Ollama provider is deprecated. The docs are explicit: "For local Ollama models, install the official Ollama extension from the Ollama publisher on the Visual Studio Marketplace instead", and if you already configured the built-in provider you should "install the extension and remove the built-in provider configuration to keep using Ollama models without interruption."

For anything that is not a first-party provider, VS Code now uses a `chatLanguageModels.json` file rather than a `settings.json` key. Run **Chat: Manage Language Models** from the Command Palette, pick **Custom Endpoint**, and you get a file shaped like this:

```jsonc
// VS Code 1.117+, chatLanguageModels.json
// apiType is one of: "chat-completions", "responses", "messages"
[
  {
    "name": "Local Ollama",
    "vendor": "customendpoint",
    "apiType": "chat-completions",
    "models": [
      {
        "id": "qwen3-coder:30b",
        "name": "Qwen3 Coder 30B (local)",
        "url": "http://localhost:11434/v1/chat/completions",
        "toolCalling": true,
        "vision": false,
        "maxInputTokens": 120000,
        "maxOutputTokens": 8192
      }
    ]
  }
]
```

Two properties here are load-bearing.

`toolCalling` is the gate for agent mode. If a model does not declare tool calling, VS Code will not show it in the picker when you are using agents at all. Declaring `true` on a model that fakes tool calling badly is worse than declaring `false`, because you get an agent that reads files, decides to edit one, and then emits the edit as prose in the chat panel.

`maxInputTokens` and `maxOutputTokens` are not hints. VS Code treats their sum as the model's total context window, and uses that sum to render the context usage meter in the Chat view. Set them to numbers your Ollama server can actually honour, which brings us to the part that quietly breaks most first attempts.

## The measurement that decides it: context window per gigabyte

Copilot's own guidance for BYOK models is "a context window of at least 128k tokens" for good results. Ollama's default is nowhere near that, and it scales with your hardware rather than with your config file:

| Available VRAM | Ollama default context length |
| :-- | :-- |
| Under 24 GB | 4k tokens |
| 24 GB to 48 GB | 32k tokens |
| 48 GB and above | 256k tokens |

Ollama's own documentation recommends at least 64,000 tokens for "tasks requiring large context like web search and coding tools". On a 16 GB laptop the default is 4k. An agent-mode turn with a system prompt, a handful of MCP tool schemas, three file reads, and a terminal transcript blows past 4k before the model has written a line, and the failure mode is not an error. It is a model that has silently forgotten the instruction you gave it four tool calls ago.

Fix it at the server, not in the client:

```bash
# Ollama, September 2026. Raise the server-wide default before VS Code connects.
OLLAMA_CONTEXT_LENGTH=128000 ollama serve

# Then confirm the model is actually on the GPU and not spilling to CPU.
ollama ps
```

If `ollama ps` shows a CPU split, you have asked for more context than the card holds, and throughput collapses from "usable" to "go get a coffee". The published sizing for the 30B variant is 19 GB at `q4_K_M` with its 256k window, 32 GB at `q8_0`, and 61 GB at `fp16`. That 19 GB figure is why a 24 GB card is the practical floor for agentic work and a 16 GB card is a chat toy.

The quality gap is the other measurement, and it is larger than the marketing suggests. On the SWE-bench Verified leaderboard snapshot from September 4, 2026, the top entries are Claude Opus 5 at 96.0% and Claude Mythos 5 at 95.5%, while the best open-weight entries are Inkling at 77.6% and Kimi K2.5 at 76.8%. Note what those open-weight leaders are: datacenter-scale models. They are open weights, not laptop weights. Nothing in the 7B to 30B range that fits on a developer machine is anywhere near those numbers, so the real gap between `qwen3-coder:30b` and the model behind the Copilot picker is wider than the 20 points that leaderboard row implies.

That gap shows up in a specific place. Short, well-scoped edits are fine locally. Long-horizon agent loops are where small models degrade: they re-read the same file, call a tool with arguments that do not match the schema, declare success without running the test, or loop on a check they cannot satisfy. Budget for more supervision, not less.

## When to pick a local Ollama model

- **Source code genuinely cannot leave the network.** This is the case BYOK was built for. Set `COPILOT_OFFLINE=true` in the Copilot CLI: it stops the CLI contacting GitHub's servers and disables all telemetry, so the only outbound traffic is to your provider. GitHub's caveat is worth repeating: "Offline mode only guarantees full network isolation if your provider is also local or within the same isolated environment." Offline mode plus a hosted provider is not air-gapped, it is just quieter.
- **You are on a plane, a train, or a bad hotel network.** A local model that answers in three seconds beats a frontier model that times out. Configure both, keep them both in the picker, and switch per session.
- **The task is mechanical and high-volume.** Renaming across a directory, writing boilerplate tests for pure functions, summarising a log file. These do not need 96% on SWE-bench, and running them locally keeps AI credits for the work that does.
- **You want a provider-outage fallback.** This is the underrated one. Ten minutes of setup buys you a picker entry that still works when a provider status page goes yellow.

## When to stay on cloud models

- **You use inline completions.** They are the single highest-frequency Copilot surface, they are excluded from BYOK by design, and since the June 1, 2026 move to usage-based billing, code completions and next edit suggestions do not consume AI credits at all. Copilot Business is $19 per user per month with 1,900 AI credits included. If you are paying for the seat, the completions are already bought and paid for, and going local does not refund them.
- **Your workflow leans on `#codebase` or semantic search.** Those run on embeddings computed by GitHub's service. There is no BYOK equivalent, and a local model will happily answer a "where is X handled?" question by guessing from the three files it can see.
- **You delegate work to the cloud agent.** `/delegate`, Copilot code review on pull requests, and the coding agent are server-side features. Enterprise BYOK covers Copilot Chat, the Copilot CLI, and IDEs. It does not turn the PR review bot into something that calls your Ollama box.
- **The task is a long agentic run on an unfamiliar codebase.** This is exactly where the benchmark gap converts into wall-clock time you spend re-prompting.

## The gotcha that picks for you

Three things override preference entirely.

**Your admin may have already decided.** Local BYOK in IDEs can be disabled by an enterprise or organization policy, and enterprise owners control the "Enable custom models" policy that delegates the same power to org owners. Check the policy before you spend an afternoon on quantization maths.

**Key handling differs between the two BYOK flavours, and it matters for compliance reviews.** Local BYOK keys are handled client-side only and stored locally. Enterprise BYOK is configured server-side by the enterprise owner. If your security review asks "where does the key live", those are two different answers with two different threat models.

**A model without tool calling and streaming is not a Copilot model.** The Copilot CLI requires both, and returns an error rather than degrading. That is the right behaviour, and it is worth knowing about up front: the CLI does not silently fall back to a GitHub-hosted model when your provider configuration is wrong, it tells you the configuration is wrong. Many small local tags advertise tool calling and implement it poorly, so test with a real agent task before you commit a team config.

## Setting up the Copilot CLI against Ollama

The CLI is configured entirely with environment variables, which makes it the easiest surface to script:

```bash
# GitHub Copilot CLI, BYOK since 2026-04-07.
# Ollama exposes an OpenAI-compatible API, so the default provider type works.
export COPILOT_PROVIDER_BASE_URL="http://localhost:11434/v1"
export COPILOT_PROVIDER_TYPE="openai"
export COPILOT_PROVIDER_MODEL_ID="qwen3-coder:30b"
export COPILOT_MODEL="qwen3-coder:30b"
export COPILOT_PROVIDER_MAX_PROMPT_TOKENS="120000"
export COPILOT_PROVIDER_MAX_OUTPUT_TOKENS="8192"

# No API key needed for a local provider.
# Air-gap the GitHub side as well: no telemetry, no calls to github.com.
export COPILOT_OFFLINE="true"

copilot
```

`copilot help providers` prints setup examples for the other provider types (`azure`, `anthropic`) if you are pointing at a hosted endpoint instead. For Azure OpenAI you also need `COPILOT_PROVIDER_AZURE_API_VERSION` and `COPILOT_PROVIDER_WIRE_MODEL`, since Azure wants the deployment name on the wire rather than the model id.

Keep `COPILOT_PROVIDER_MAX_PROMPT_TOKENS` below whatever you set `OLLAMA_CONTEXT_LENGTH` to. If the client thinks it has more room than the server allocated, you get truncation on the server side with no client-side warning, which looks exactly like a model that cannot follow instructions.

## The recommendation, restated

Pick a local Ollama model when the requirement is "nothing leaves this machine", and accept that you are buying that guarantee with agent quality, context window, and your `Tab` key. Pair it with `COPILOT_OFFLINE=true` in the CLI, raise `OLLAMA_CONTEXT_LENGTH` to at least 64,000 before you connect anything, and spend the VRAM for a 24 GB card if you want agent mode rather than chat.

Stay on GitHub-hosted cloud models for everything else, and treat BYOK as a second entry in the picker rather than a replacement. The completions you already pay for are excluded from BYOK anyway, semantic search has no local equivalent, and the benchmark gap between a 30B laptop model and a frontier model is the difference between supervising an agent and reviewing one. Configure both, keep the local model for the plane and the provider outage, and let the cloud model do the long runs.

## Related

- [GitHub Copilot Chat BYOK goes GA in VS Code: Anthropic, Ollama, Foundry Local](/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/)
- [How to set per-session AI credit spend limits in the Copilot CLI and SDK](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/)
- [Copilot memory vs repository custom instructions vs AGENTS.md](/2026/09/copilot-memory-vs-repository-custom-instructions-vs-agents-md/)
- [Claude Code vs Cursor vs Copilot agent mode: where each wins](/2026/06/claude-code-vs-cursor-vs-copilot-agent-mode-where-each-wins/)
- [Copilot MCP allowlists land in enterprise managed settings](/2026/08/copilot-mcp-allowlists-enterprise-managed-settings/)
- [Live speech-to-text in C# with Foundry Local](/2026/08/foundry-local-live-speech-to-text-in-csharp/)

## Sources

- [AI language models in VS Code (VS Code Docs)](https://code.visualstudio.com/docs/agent-customization/language-models)
- [Use your own language model key in VS Code (VS Code blog, June 18, 2026)](https://code.visualstudio.com/blogs/2026/06/18/byok-vscode)
- [Visual Studio Code 1.117 release notes (April 22, 2026)](https://code.visualstudio.com/updates/v1_117)
- [Bring your own key for GitHub Copilot (GitHub Docs)](https://docs.github.com/en/copilot/concepts/models/bring-your-own-key)
- [Using your own LLM models in GitHub Copilot CLI (GitHub Docs)](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)
- [Copilot CLI now supports BYOK and local models (GitHub Changelog, April 7, 2026)](https://github.blog/changelog/2026-04-07-copilot-cli-now-supports-byok-and-local-models/)
- [GitHub Copilot app support for BYOK (GitHub Changelog, June 23, 2026)](https://github.blog/changelog/2026-06-23-github-copilot-app-support-for-byok/)
- [GitHub Copilot is moving to usage-based billing (The GitHub Blog)](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/)
- [Context length (Ollama Docs)](https://docs.ollama.com/context-length)
- [qwen3-coder (Ollama library)](https://ollama.com/library/qwen3-coder)
- [SWE-bench Verified leaderboard, snapshot of September 4, 2026 (Steel.dev)](https://leaderboard.steel.dev/leaderboards/swe-bench-verified/)
