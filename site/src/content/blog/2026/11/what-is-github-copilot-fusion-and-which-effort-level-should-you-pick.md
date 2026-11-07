---
title: "What Is GitHub Copilot Fusion and Which Effort Level Should You Pick?"
description: "Copilot Fusion, generally available since October 28, 2026, is a runtime model router that picks a model and an execution pattern (Single, Cascade, or Critique) per prompt. Here is how the three patterns work, what Fusion Standard, High, and Max cost you in AI credits, how to lock the effort level with managed-settings.json, and the gotchas the docs bury."
pubDate: 2026-11-07
template: "how-to"
tags:
  - "github-copilot"
  - "llm"
  - "ai-agents"
  - "model-routing"
  - "copilot-fusion"
---

**Short answer:** [GitHub Copilot Fusion](https://docs.github.com/copilot/concepts/models/copilot-fusion), generally available since [October 28, 2026](https://github.blog/changelog/2026-10-28-route-and-orchestrate-models-with-github-copilot-fusion), is an entry in the model picker that replaces "pick a model" with "pick an effort level". For every prompt it chooses a model pool and one of three execution patterns: **Single** (one model answers), **Cascade** (a cheap model drafts, a judge accepts or escalates), or **Critique** (one model drafts, several models critique in parallel, the drafter revises). Use **Fusion Standard** for everyday work, **Fusion High** for multi-file bug fixes, and **Fusion Max** only when you would otherwise reach for the most expensive frontier model. It is GA in VS Code 1.144.0+, Copilot CLI 1.0.104-3+, the GitHub Copilot app 1.1.33-4+, and JetBrains IDEs. It is not available to the cloud agent.

Fusion is the GA merge of two things that existed separately before: Copilot's auto model selection and Project HydraFusion, the multi-model orchestration research preview GitHub [announced on September 4, 2026](https://github.blog/ai-and-ml/github-copilot/project-hydrafusion-frontier-quality-via-multi-model-orchestration/). If you had `auto`, `HydraFusion`, or `HydraFusion Max` selected, your client moves you to the matching Fusion effort level automatically. If you did not, nothing changes until you open the picker.

## Why a router instead of a model picker

Picking a model per task is a cost decision you make before you know how hard the task is. A one-line rename on a frontier model wastes credits. A gnarly concurrency bug on a fast model wastes your time, because you will re-prompt three times and then switch models anyway.

A router moves that decision to runtime, after the prompt is visible. That idea is not new. What Fusion adds over plain "auto" routing is the HydraFusion part: for some prompts it does not pick one model, it runs a small pipeline of models and returns one answer. That is the part that changes cost and latency in ways you should understand before you turn on Max for a whole team.

## The three execution patterns

The [Fusion concept doc](https://docs.github.com/copilot/concepts/models/copilot-fusion) defines three patterns. Fusion chooses one per prompt, so a single session can mix them.

**Single.** One model completes the task. This is what auto model selection always did. It is the cheapest pattern and the default for straightforward prompts.

**Cascade.** An efficient model drafts a solution. A judge inspects the draft and either accepts it or escalates to a stronger model. When the cheap draft is good enough, you pay roughly the cheap model's price plus the judge. When it is not, you pay for the draft, the judge, and the strong model. Cascade wins on workloads where most prompts are easy and a few are hard, which describes most real repositories.

**Critique.** One model drafts. Multiple models critique the draft independently and in parallel. Their feedback is aggregated, and the drafting model revises once. In the HydraFusion preview, the critic was read-only and from a different model family than the drafter. That is the same reasoning behind the cross-model review VS Code shipped earlier in the year (see [the Rubber Duck review in VS Code 1.135](/2026/09/vscode-1-135-rubber-duck-cross-model-review/)): models from different families make different mistakes, so they catch each other's blind spots better than a model reviewing itself.

Two details from the docs matter for how this behaves in practice:

- Fusion tries to keep the main conversation on the same model so you keep benefiting from cached prompt tokens. Helper models, such as the critics, get only the context they need, not your whole transcript. Model switches happen "along natural cache boundaries and large changes in conversation complexity".
- You never see intermediate drafts. You see the final response. To find out which models were involved, hover over the effort-level name under the response.

## Standard vs High vs Max

The effort level is not a model. It is a bias on which pool and which patterns Fusion is allowed to use.

| Effort level | What it optimizes | Use it for | Plans |
|---|---|---|---|
| Fusion Standard | Cost, quality, and latency balanced. Selects one model per task. | Everyday coding, chat, small edits | All plans, including Free and Student |
| Fusion High | Orchestration with moderate token savings | A complex bug, a change across several files | Pro+, Max, Business, Enterprise |
| Fusion Max | Frontier capability, still token-aware | The hardest reasoning tasks | Pro+, Max, Business, Enterprise |
| Fusion Fast | Speed | Not selectable. Used only by VS Code inline chat | All plans |

A practical rule follows from the doc's own wording. Standard "selects one model for each task", so it behaves like the old auto routing and stays cheap and predictable. High and Max are the levels where Cascade and Critique kick in, which means more model calls, more latency, and more credits per task. The concept doc says so directly: because High and Max can use more than one model for a task, a task "may consume more AI credits than it would with Fusion Standard".

So the decision tree is short:

1. Start every session on **Standard**.
2. Switch to **High** for a specific task when you would otherwise have re-prompted twice, or when the change touches several files and a second opinion is cheaper than a broken PR.
3. Reserve **Max** for tasks where you would have hand-picked the top frontier model. Max leans on frontier models, and the [admin doc](https://docs.github.com/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-availability-of-default-models#configuring-models-available-for-copilot-fusion) notes that if an admin disables any model Max requires, Max disappears from the picker entirely.

### What the benchmark numbers actually say

GitHub's changelog claims that on the Artificial Analysis Coding Agent Index, Fusion Max scored 60, "within two points of Claude Code with Opus 5.5 Max", using about half the average API cost and half the tokens per task, and about 40% less time. The earlier HydraFusion post reported controlled offline results against Claude Opus 5: +4.9 points on TerminalBench 2.1 at 67% lower estimated cost, -1.5 points on DeepSWE at 36% lower cost, and -0.1 points on GitHub's internal CheckpointBench at 65% lower cost.

Read those as vendor-reported numbers, not independent measurements, and notice the shape: Fusion is not claiming to beat the best single model on quality. It claims to land close to it for a fraction of the cost. That is exactly the trade Cascade is designed for. If your workload is dominated by tasks that only the strongest model can solve, the savings shrink, because Cascade escalates more often and you pay for the draft as well.

## How billing works

There is no separate Fusion fee. Every model Fusion calls is billed at that model's standard rate in [AI credits](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing). A Critique run with one drafter and three critics is four models' worth of tokens, even though you only see one answer. Helper models receive trimmed context, which keeps that from being 4x, but it is not 1x either.

Through **November 30, 2026**, paid Copilot plans get a 30% discount on model costs when the request goes through Fusion. If you are trying to measure what Fusion costs your team, either measure after December 1 or remember to add the discount back when you extrapolate. The [Copilot app's OpenTelemetry export](/2026/10/how-to-export-github-copilot-app-agent-sessions-to-an-opentelemetry-backend/) is the most direct way to see per-session token usage while you evaluate it.

## Turning it on

For an individual developer it is a picker change and nothing else:

- **VS Code** (1.144.0+): open the model picker in the chat view, select **Copilot Fusion**, then choose Standard, High, or Max.
- **GitHub Copilot app** (1.1.33-4+): same, from the model picker in a session.
- **Copilot CLI** (1.0.104-3+): run `/model` in an interactive session and select Copilot Fusion with an effort level. Run `/update` first if the entry is missing.
- **JetBrains IDEs**: Fusion appears in the model picker, but the `fusionTier` managed setting below is not supported there yet.

If Copilot Fusion does not appear at all, the most likely reason is policy: Fusion only uses models your enterprise and organization policies allow, and if none of its pool is available to you, the entry is hidden.

### Locking the default for a team with managed-settings.json

Enterprise admins set defaults through `managed-settings.json` (see [Getting started with enterprise-managed settings](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/use-managed-settings/get-started) for where the file goes). Two keys control Fusion, documented in the [managed settings reference](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings#fusiontier):

- `model`: the default model for new conversations. `"fusion"` makes Copilot Fusion the default.
- `fusionTier`: the default effort level when the model is `fusion`. Accepted values, from most to least restrictive: `"standard"`, `"high"`, `"max"`, `"unmanaged"`. It does not select the model by itself.

This `managed-settings.json` makes Fusion the default and locks every user on Standard (`fusionTier` needs Copilot CLI 1.0.104-3+, VS Code 1.144.0+, or Copilot app 1.1.33-4+):

```json
{
  "model": "fusion",
  "fusionTier": "standard"
}
```

Any `fusionTier` value other than `"unmanaged"` locks the effort level against user and repository overrides. That is usually too strict for a whole enterprise. The `overridable` form, in the enterprise-level file, sets a default that enterprise teams can change:

```json
{
  "model": "fusion",
  "fusionTier": { "overridable": "standard" }
}
```

An enterprise team settings file can then raise its own default, for example for a platform team that does a lot of cross-cutting refactors:

```json
{
  "fusionTier": "high"
}
```

If the team file does not set `fusionTier`, the enterprise default applies. Users can still pick a different model per conversation, because `model` sets a default, not a restriction. To actually restrict which models are reachable, use the model availability policies instead: enterprise **AI controls** > **Copilot** > **Configure Copilot Fusion models**.

Two older keys are worth knowing so you do not mix them up. `"model": "auto"` still exists and pairs with `autoTier` (`"efficiency"`, `"balance"`, `"intelligence"`), which is the old auto routing without HydraFusion's multi-model patterns. And `model` was originally documented as `permissions.model`. Clients still read the nested key when the top-level one is absent, but new configs should use the top-level `model`.

## Gotchas the docs mention once

**A discarded draft does not undo its edits.** This is the one that bites agent sessions. In Cascade, the draft model may already have edited files in your workspace before the judge rejects the draft and escalates. Fusion does not roll those edits back automatically. The final answer from the stronger model may assume a clean tree that is not clean. Review the diff before you commit, and do not run Fusion High or Max in agent mode without a clean working tree or a checkpoint. If you run agents unattended, pair this with [local sandboxing](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/) so a stray draft cannot touch anything outside the workspace.

**Fusion does not start subagents.** Fusion and subagents are separate mechanisms. Fusion's Critique models are not subagents, and selecting Fusion will not make an agent delegate work. If you want delegation, configure custom agents explicitly.

**The context window shown is the smallest one in the pool.** Fusion has no context window of its own. The value the client displays is a conservative figure based on the smallest limit among the models it may use. If you are used to a 1M-token model, Fusion may report less, and compaction will kick in earlier. For why that matters in long sessions, see [what a context window is and how agents stretch it](/2026/10/what-is-a-context-window-and-how-do-agents-stretch-it-in-2026/).

**The pool changes without notice.** The doc says plainly that the execution patterns and the model pool may change over time, and it does not publish the model list. Do not build an evaluation that assumes a fixed model behind "Fusion High". Pin a specific model when you need reproducible results, for example in a benchmark or a regression test for a prompt.

**The cloud agent ignores it.** The managed settings table marks `fusionTier` as unsupported for Copilot in the cloud, both the sandbox and the GitHub Actions variant, and for JetBrains. The cloud agent uses whatever model it is configured with.

**Local models only join at Standard.** In public preview, Fusion can route to local models (MAI Code 1.1 Flash on Windows, or Qwen3.8 Flash Next via a provider such as Ollama as `qwen3.8-flash-next-local`), but only at Fusion Standard. Turn on **Local model auto routing** in the Copilot app's Experimental settings, or start Copilot CLI with `--experimental` (or run `/experimental on`). The trade-offs of mixing local and cloud models are the same ones covered in [local Ollama models vs cloud models in GitHub Copilot](/2026/09/local-ollama-models-vs-cloud-models-in-github-copilot/).

## When not to use Fusion

Fusion is the right default for interactive work where you care about the answer, not about which model produced it. It is the wrong choice when:

- You need **reproducibility**: evals, prompt regression tests, or a review bot whose behavior you want stable across weeks. Pin a model.
- You need a **known cost ceiling per call**: Max can fan out to several frontier models on one prompt. A fixed model has a predictable price per token.
- You run in the **cloud agent** or a client that does not support it yet.
- Your workflow relies on **a specific model's quirks**, such as a prompt tuned for one model's tool-calling style. Fusion may route that prompt elsewhere.

For everything else, Standard as the default and High on demand is the setting most teams will end up with. Max is a scalpel, not a default, and the managed-settings `overridable` form lets you encode exactly that policy.

## Read next

- [Rubber Duck: cross-model review in VS Code 1.135](/2026/09/vscode-1-135-rubber-duck-cross-model-review/)
- [Local Ollama models vs cloud models in GitHub Copilot](/2026/09/local-ollama-models-vs-cloud-models-in-github-copilot/)
- [How to export GitHub Copilot app agent sessions to an OpenTelemetry backend](/2026/10/how-to-export-github-copilot-app-agent-sessions-to-an-opentelemetry-backend/)
- [How to request a Copilot code review from the REST API and set its effort level](/2026/10/how-to-request-a-copilot-code-review-from-the-rest-api-and-set-its-effort-level/)
- [What is a context window and how do agents stretch it in 2026](/2026/10/what-is-a-context-window-and-how-do-agents-stretch-it-in-2026/)

## Sources

- [Route and orchestrate models with GitHub Copilot Fusion](https://github.blog/changelog/2026-10-28-route-and-orchestrate-models-with-github-copilot-fusion) (GitHub Changelog, October 28, 2026)
- [About GitHub Copilot Fusion](https://docs.github.com/copilot/concepts/models/copilot-fusion) (GitHub Docs)
- [Enterprise managed settings: model, fusionTier, autoTier](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings#fusiontier) (GitHub Docs)
- [Manage availability of default models: Copilot Fusion](https://docs.github.com/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-availability-of-default-models#configuring-models-available-for-copilot-fusion) (GitHub Docs)
- [Project HydraFusion: frontier quality via multi-model orchestration](https://github.blog/ai-and-ml/github-copilot/project-hydrafusion-frontier-quality-via-multi-model-orchestration/) (GitHub Blog, September 4, 2026)
- [Models and pricing for GitHub Copilot](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) (GitHub Docs)
