---
title: "How to Set the Reasoning Level for a GitHub Copilot Cloud Agent Per Task"
description: "Since August 3, 2026 you can pick a reasoning level next to the model when you start a Copilot cloud agent task. The Agent Tasks REST API has no equivalent parameter, so scripted dispatch cannot set it. Here is where the control exists, which levels each model exposes, what lands on the wire, and how to pin a default instead."
pubDate: 2026-08-19
tags:
  - "github-copilot"
  - "ai-agents"
  - "llm"
  - "cost-control"
  - "copilot-cli"
---

On August 3, 2026 GitHub shipped a second dropdown next to the model picker for Copilot cloud agent: a reasoning level you choose per task, for models that support configurable reasoning. It is available on every paid plan that includes the cloud agent (Pro, Pro+, Business, Enterprise, and Max). The important detail, and the reason this post exists, is that the control lives in the task-start UI only. The Agent Tasks REST API at `X-GitHub-Api-Version: 2026-03-10` accepts `prompt`, `model`, `custom_agent`, `create_pull_request`, `base_ref`, and `head_ref`, and nothing that maps to reasoning effort. If you dispatch tasks from a script, you cannot set the level for that run. What you can do is set it locally in Copilot CLI, where the flag is verifiable end to end, and pin a default for a repository.

Everything below was checked against Copilot CLI 1.0.80 (published August 14, 2026), installed from the `@github/copilot` npm package, plus the GitHub docs and changelog entries linked at the end.

## Where the dropdown actually appears

Model selection, and therefore reasoning level, only shows up on the entry points that render a picker. Per GitHub's docs, those are: assigning an issue to Copilot on github.com, mentioning `@copilot` in a pull request comment on github.com, starting a task from the agents tab or the agents panel, GitHub Mobile, and the Raycast launcher. Anywhere else, the docs are explicit that `Auto` is used automatically, which also means no reasoning level of your choosing.

The flow on the agents page is: pick a repository, type the prompt, optionally choose a base branch and a custom agent, then use the dropdown to select the model. If that model supports configurable reasoning, a second dropdown appears for the level. Choose it before you submit, because there is no way to change the level of a run that is already queued.

This is the same shape of control that [Cursor's Bugbot exposes as effort levels on a pull request review](/2026/05/cursor-bugbot-effort-levels-pr-review/): a per-invocation quality-versus-cost dial rather than an account setting.

## Which levels each model exposes

GitHub's documentation says "some models support configurable reasoning levels" without naming them. The CLI does name them, and it ships a per-model capability table you can read. The `--effort` flag on 1.0.80 declares its full range:

```text
# Copilot CLI 1.0.80
--effort, --reasoning-effort <level>  Set the reasoning effort level (choices:
                                      "none", "minimal", "low", "medium",
                                      "high", "xhigh", "max")
```

Seven values exist in total, but no single model accepts all seven. This is the catalog as shipped in 1.0.80, read out of the CLI bundle's model capability map:

| Model | Supported reasoning levels |
| --- | --- |
| `claude-sonnet-5`, `claude-opus-5`, `claude-opus-4.8`, `claude-opus-4.7` | low, medium, high, xhigh, max |
| `claude-sonnet-4.6`, `claude-opus-4.6` | low, medium, high, max |
| `claude-sonnet-4.5`, `claude-opus-4.5`, `claude-haiku-4.5` | low, medium, high |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | low, medium, high, xhigh, max |
| `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex` | low, medium, high, xhigh |
| `gpt-5-mini` | low, medium, high |
| `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash` | minimal, low, medium, high |
| `gemini-3.1-pro-preview`, `grok-4.5` | low, medium, high |
| `kimi-k3` | low, high, max |
| `kimi-k2.7-code` | low, medium, high, max |

Two things are worth noticing. The Claude 4.6 pair jumps straight from `high` to `max` with no `xhigh` in between, so a script that walks the levels in a fixed order will skip a rung on some models and hit an unsupported value on others. And `minimal` only exists on the Gemini Flash models, where it landed in CLI 1.0.69.

This is the CLI's catalog, not a published contract for the cloud agent. GitHub does not document the cloud list, and the picker there only renders the levels the selected model supports, so treat the table as the best available reference rather than a guarantee.

## What the level does on the wire

The level is not a prompt hint. It becomes a field on the model request. I pointed the CLI at a local capture proxy using its BYOK provider settings and ran a single turn with `--effort high` against the OpenAI Responses wire format:

```bash
# Copilot CLI 1.0.80, capture proxy on 127.0.0.1:8799
COPILOT_OFFLINE=true \
COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:8799 \
COPILOT_PROVIDER_TYPE=openai \
COPILOT_PROVIDER_WIRE_API=responses \
COPILOT_MODEL=gpt-5.4 \
COPILOT_PROVIDER_WIRE_MODEL=probe-model \
copilot -p "say hi" --effort high --allow-all-tools
```

The captured request body, with `messages` and `tools` stripped:

```json
{
  "model": "probe-model",
  "stream": true,
  "reasoning": { "effort": "high" },
  "include": ["reasoning.encrypted_content"],
  "max_output_tokens": 128000,
  "text": { "verbosity": "low" },
  "prompt_cache_key": "25eddad4edc5a78a9e5f9f8fd9494070",
  "parallel_tool_calls": true,
  "store": false
}
```

Run the same command with no `--effort` and the `reasoning` object disappears entirely. That is deliberate: CLI 1.0.77 added "allow reasoning effort to be omitted so the server can select the default." So "no level" is not the same as `low`, and it is not the same as `none` either. Omitting it hands the decision to the model catalog's default, which is what the cloud agent does when you never touch the second dropdown.

## The REST API gap, and what it means for automation

If you dispatch cloud agent tasks programmatically, as in [triggering a Copilot coding agent task from the Agent Tasks REST API](/2026/06/trigger-github-copilot-coding-agent-task-from-rest-api/), the body you can send is:

```bash
# Agent Tasks REST API, public preview, X-GitHub-Api-Version: 2026-03-10
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  -H "Authorization: Bearer $GH_USER_TOKEN" \
  https://api.github.com/agents/repos/OWNER/REPO/tasks \
  -d '{
    "prompt": "Migrate the auth middleware to the new token format.",
    "model": "claude-opus-4.7",
    "base_ref": "main",
    "create_pull_request": true
  }'
```

`model` is there. Reasoning level is not. Adding a `reasoning_effort` or `effort` key does not fail loudly, it simply is not part of the documented schema, so do not build on it.

The CLI's own cloud delegation has the same shape. Its delegate command posts to `/agents/swe/v1/jobs/{owner}/{repo}` with a `problem_statement`, a `pull_request` block carrying `base_ref` and `head_ref`, a `body_suffix`, and `event_type: "cli_delegate_command"`. No model, no effort. Whatever level you have configured in your local session does not travel with the delegated job.

The practical consequence: if a task genuinely needs deep reasoning, and it matters enough to pay for, start it from the agents page by hand and pick the level. Scripted dispatch gets the model's default. That is the same tradeoff you weigh when [choosing between Cursor cloud agents and the Copilot coding agent for background PRs](/2026/07/cursor-cloud-agents-vs-github-copilot-coding-agent-for-background-prs/), just at a finer grain.

## Setting the level where you can script it

Locally, Copilot CLI gives you four scopes, and they are the ones to reach for in CI or a wrapper script.

**Per invocation**, with the flag verified above. `--effort` is a shorthand alias for `--reasoning-effort`, added in 1.0.10:

```bash
copilot -p "Find the race in the connection pool and write a failing test." \
  --model claude-opus-4.7 --effort xhigh --allow-all-tools
```

**Per session**, from inside the CLI. `/model` became session-scoped by default in 1.0.80, with `/config model` setting the default for future sessions:

```text
/model --session claude-opus-4.7    change the model for this session only
/config model claude-opus-4.7       set the default for future sessions
```

**Per subagent**, which is the only place a stored effort level is documented. `copilot help config` describes `subagents.agents.<agent-name>` as accepting `model`, `effortLevel`, and `contextTier`, each of which can be the literal string `inherit` to take the parent session's effective value:

```json
{
  "subagents": {
    "agents": {
      "security-review": { "model": "claude-opus-4.7", "effortLevel": "xhigh" },
      "code-review": { "model": "claude-sonnet-5", "effortLevel": "inherit" }
    }
  }
}
```

That is the shape worth copying: a cheap default for the session, and one expensive reviewer that always runs at high effort no matter what the parent picked. Plan mode has its own persisted pair, `planModel` and `planEffortLevel`, so you can plan expensively and implement cheaply.

**Per repository**, by writing the CLI's repo settings file. `/model --repo <id>` writes `.github/copilot/settings.json`, and `/model --local <id>` writes the git-ignored `.github/copilot/settings.local.json` for a personal override. The top-level `effortLevel` key is a recognized user setting: put a deliberately bogus key alongside it and 1.0.80 names only the bogus one in its unknown-key warning. Note that this is a Copilot CLI settings file. GitHub does not document the cloud agent reading it, so do not assume a repo-pinned level applies to a task you start from the agents page.

## What it costs

Higher levels cost more because reasoning tokens are output tokens. GitHub's own framing is that a higher level "consumes more tokens, and therefore more credits," and the docs tutorial on optimizing AI usage says to use the regular level by default and raise it only for harder tasks. The CLI reflects this directly: its token summary renders reasoning tokens as a parenthetical on the output token count, and `/usage` shows AI credits for the session alongside the input, output, and cached token breakdown.

If you are going to run at `xhigh` or `max` unattended, cap the run. Copilot CLI takes `--max-ai-credits` at launch and `/limits set max-ai-credits <credits>` mid-session, with a floor of 30 credits. It is a soft cap by construction, since credit usage is only known after a model call returns, so one call can overshoot before the next is blocked. The details of that mechanism are in the writeup on [per-session AI credit spend limits in the Copilot CLI and SDK](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/).

## Gotchas

**The flag does not validate against the model.** The picker hides levels a model does not support, but `--effort` only validates against the global list of seven. Running `--effort max` with `gpt-5.4`, which tops out at `xhigh` in the catalog above, put `"effort": "max"` on the wire in my capture without a warning. The provider decides what to do with it. Only a value outside the seven is rejected locally:

```text
error: option '--effort, --reasoning-effort <level>' argument 'bogus' is invalid.
Allowed choices are none, minimal, low, medium, high, xhigh, max.
```

**There is no environment variable.** `copilot help environment` on 1.0.80 lists `COPILOT_MODEL` but nothing for effort, and github/copilot-cli#2559 asking for `COPILOT_MODEL_EFFORT` is still open. In a container or CI job you have to pass the flag or write a settings file.

**Custom agent frontmatter does not carry it.** A `.agent.md` file in `.github/agents/` supports `model`, but I tried `reasoningEffort`, `reasoning_effort`, and `reasoning-effort` in the frontmatter on 1.0.80, ran each against the capture proxy, and none of them put a `reasoning` object on the wire. github/copilot-cli#2904, which asks for exactly this, is open. Configure subagent effort through `subagents.agents.<name>.effortLevel` instead.

**A BYOK provider drops the persisted level.** In the same probe, setting `"effortLevel": "max"` in the user settings file produced no `reasoning` field at all when a custom provider base URL was configured, while `--effort` still applied. If you route Copilot CLI through your own endpoint, pass the flag explicitly.

**Auto mode can move underneath you.** If `continueOnAutoMode` is set, a rate limit can switch the session to auto mode and pick a different model, and 1.0.36 shipped a fix so that switching to a model which does not support the configured effort no longer errors. It silently lands on something the new model accepts.

## Picking a level without guessing

The honest heuristic is narrower than the marketing one. Leave the level unset for routine work: edits scoped to a file or two, mechanical refactors, "explain this function," dependency bumps. That omits the field entirely and lets the catalog default apply, which is what the model was tuned for.

Raise it when the task's cost of being wrong exceeds the cost of the tokens: a security review over a diff you are about to ship, a root-cause hunt where the agent has already failed once at the default, a multi-file migration where a wrong early decision propagates. Those are the cases where a cloud agent run at `xhigh` beats three runs at the default, and they are also the cases worth starting by hand from the agents page so you can actually set the level.

For everything in between, the more useful lever is usually model choice rather than effort. Moving from a Flash-class model to a frontier model changes more than moving one rung on the same model, and it is the one knob the REST API does expose. If you are wiring the CLI into a .NET host rather than driving it from a shell, the same flags surface through the SDK described in [running Copilot CLI as an AIAgent behind the Agent Framework provider](/2026/08/agent-framework-github-copilot-provider-copilot-cli-as-aiagent/).

## Sources

- [Customize the reasoning level for Copilot cloud agent](https://github.blog/changelog/2026-08-03-customize-the-reasoning-level-for-copilot-cloud-agent/), GitHub Changelog, August 3, 2026.
- [Changing the AI model for GitHub Copilot cloud agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/changing-the-ai-model), GitHub Docs, for the supported entry points and the second dropdown.
- [REST API endpoints for agent tasks](https://docs.github.com/en/rest/agent-tasks/agent-tasks), GitHub Docs, for the full request body of the start-a-task endpoint.
- [Optimizing your AI usage to maximize efficiency and reduce cost](https://docs.github.com/en/copilot/tutorials/optimize-ai-usage), GitHub Docs, for the credits guidance.
- [github/copilot-cli changelog](https://github.com/github/copilot-cli/blob/main/changelog.md), for the 1.0.77 omit-by-default change, the 1.0.69 `minimal` level, the 1.0.66 subagent effort settings, and the 1.0.10 `--effort` alias.
- Flag choices, model capability table, and wire payloads verified against `@github/copilot` 1.0.80.
