---
title: "Visual Studio 18.12 makes Bring Your Own Model GA: local and custom models in Agent Mode"
description: "Bring Your Own Model is generally available in Visual Studio 18.12. No GitHub sign-in required, a Custom Endpoint provider for OpenAI-compatible servers like LM Studio and OpenRouter, three API formats, and an admin policy switch."
pubDate: 2026-11-20
tags:
  - "visual-studio"
  - "github-copilot"
  - "ai-agents"
  - "llm"
---

Visual Studio 18.12 promotes Bring Your Own Model (BYOM) from the August preview to general availability. The [announcement](https://devblogs.microsoft.com/visualstudio/bring-your-own-model-is-now-generally-available-in-visual-studio/) from November 11, 2026 is short, but two changes matter more than the GA label: Chat and Agent Mode no longer need a GitHub sign-in when you use your own model, and a new Custom Endpoint provider accepts any OpenAI-compatible server.

## No GitHub account in the loop

With BYOM, Visual Studio talks to your provider directly. The post states that if GitHub is unreachable, your configured models keep working, including local or internally hosted models in air-gapped environments, as long as the endpoint is reachable and its authentication succeeds. Provider connections and Agent Mode both go through Visual Studio's resolved proxy configuration, so a corporate proxy set at the IDE level applies here too.

That makes Agent Mode usable on machines where the Copilot service is blocked but an internal model gateway is allowed.

## Custom Endpoint and the three API formats

The built-in providers are Microsoft Foundry, OpenAI, Anthropic, and Ollama. The new **Custom Endpoint** provider covers everything else that speaks an OpenAI-style API: OpenRouter, an internal gateway, or a local server such as LM Studio. If the endpoint exposes a compatible model listing, Visual Studio fills the model list from it.

When you add a model, you pick its wire format:

- OpenAI-compatible Completions
- OpenAI-compatible Responses
- Anthropic-compatible Messages

Per model you also set context size, maximum output tokens, and whether tool calling and vision are supported. Get tool calling right: Agent Mode is useless with a model that cannot call tools, and claiming support for a model that lacks it produces confusing failures.

You can also keep several named configurations per provider ("Work" and "Personal", or an approved Foundry deployment next to an experimental one), each with its own connection details.

## Wiring up a local model

The setup path is Chat, then the model picker, then **Manage models**, then **Add model provider**. For LM Studio, start its local server first and check that the model listing answers before you point Visual Studio at it. LM Studio serves its OpenAI-compatible API on port 1234 by default:

```bash
# Start LM Studio's local server (default port 1234)
lms server start

# Confirm the OpenAI-compatible model listing responds
curl http://localhost:1234/v1/models
```

Then add a Custom Endpoint with `http://localhost:1234/v1` as the URL, leave the API key empty, choose OpenAI-compatible Completions, and select the model in Agent Mode. The announcement does not give a port or URL, so the values above are LM Studio's defaults, not Visual Studio's; adjust them if you changed the server settings. These steps were not run for this post.

## Limits worth knowing

- **Stable channel only.** [LTSC 18.11](/2026/11/visual-studio-2026-ltsc-18-11-two-years-of-support/) is frozen at the 18.11 feature set, so BYOM GA is not coming to it.
- **Admins can turn it off.** BYOM is controlled by organizational policy. If **Add model provider** is missing, the post says your administrator has probably disabled it.
- **Settings are coarse.** A reader comment on the announcement notes that the stored configuration has no fields for sampling options such as `temperature` or `top_p`, or for custom request headers. The commenter reports a Mistral endpoint rejecting requests with `400 top_p must be 1 when using greedy sampling`. That is one user's report, not confirmed by Microsoft, but if your gateway needs custom headers, test that before you roll this out.

For teams that want Agent Mode on a model they already pay for or host themselves, 18.12 takes GitHub out of that path. Details are in the [Visual Studio announcement](https://devblogs.microsoft.com/visualstudio/bring-your-own-model-is-now-generally-available-in-visual-studio/).
