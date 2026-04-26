---
title: "GitHub Copilot Chat BYOK Goes GA in VS Code: Anthropic, Ollama, Foundry Local"
description: "GitHub Copilot for VS Code shipped Bring Your Own Key on April 22, 2026. Wire your own Anthropic, OpenAI, Gemini, OpenRouter, or Azure account into Chat, or point at a local Ollama or Foundry Local model. Billing skips the Copilot quota and goes straight to the provider."
pubDate: 2026-04-26
tags:
  - "github-copilot"
  - "vscode"
  - "ai-agents"
  - "ollama"
---

[GitHub shipped BYOK GA for Copilot Chat in VS Code on April 22, 2026](https://github.blog/changelog/2026-04-22-bring-your-own-language-model-key-in-vs-code-now-available/). The short version: you can now plug your own Anthropic, OpenAI, Gemini, OpenRouter, or Azure key into the Copilot Chat UI and have requests billed by the provider instead of consuming Copilot quota. Local models work too, through Ollama or Foundry Local. The feature is GA for Copilot Business and Enterprise, and it covers Chat, plan agents, and custom agents -- not inline completions.

## Why this changes the calculus on Copilot pricing

Until this release, Copilot Chat ran on Microsoft's hosted model pool and every request counted against your seat's monthly allowance. That made it awkward to do exploratory agent work on cheap fast models, or to use a frontier model your org already has a contract for. With BYOK, your organization's existing Anthropic or Azure OpenAI bill absorbs the cost and the Copilot seat remains for what it does best: code completions, which still run on the GitHub-hosted models. Per the release notes: "BYOK does not apply to code completions" and "usage doesn't consume GitHub Copilot quota allocations."

The other unlock is local. Until now, running Copilot Chat against an air-gapped Ollama instance or against Foundry Local on a developer laptop was a research project. The feature is now first-class.

## Wiring up a provider

Open the Chat view, click the model picker, and run **Manage Models** (or invoke `Chat: Manage Language Models` from the Command Palette). VS Code opens the Language Models editor where you pick a provider, paste a key, and select a model. Models appear in the chat picker immediately.

For OpenAI-compatible endpoints that aren't on the built-in list (think LiteLLM gateways, on-prem inference proxies, or Azure OpenAI deployments fronted by a custom URL), the equivalent `settings.json` entry is:

```jsonc
{
  "github.copilot.chat.customOAIModels": {
    "claude-sonnet-4-6-via-litellm": {
      "name": "claude-sonnet-4-6",
      "url": "https://gateway.internal/v1/chat/completions",
      "toolCalling": true,
      "vision": false,
      "thinking": false,
      "maxInputTokens": 200000,
      "maxOutputTokens": 16384
    }
  },
  "inlineChat.defaultModel": "claude-sonnet-4-6-via-litellm"
}
```

The key still lives in the secure store, not in `settings.json`. The setting just describes the model shape so VS Code knows what capabilities to enable in the picker (tool calling, vision, extended thinking).

For Ollama, point the provider at `http://localhost:11434` and a tag like `qwen2.5-coder:14b` or `phi-4:14b`. For Foundry Local, the OpenAI-compatible endpoint defaults to `http://localhost:5273/v1` once `foundry service start` is running.

## What this means for .NET-shop tooling

Two practical follow-ups for teams that already standardized on Copilot:

1. The `github.copilot.chat.customOAIModels` setting is per-user in `settings.json`, but it is a normal VS Code setting -- it can ship inside a `.vscode/settings.json` template in a repo or a [Dev Container](https://code.visualstudio.com/docs/devcontainers/containers) image. That means a `dotnet new` template can pre-wire a default model for the whole team.
2. Org admins can disable BYOK from Copilot policy settings on github.com if compliance requires that all traffic stay on the GitHub-hosted models. If you need this off for regulated workloads, flip it before the rollout reaches your seats; the policy activates automatically by default for Business and Enterprise tenants.

If you have been waiting to try [Visual Studio 2026's Copilot agent skills](/2026/04/visual-studio-2026-copilot-agent-skills/) story without committing your whole team to GitHub-hosted billing, this is the unlock. Same agent surface, your bill, your model.
