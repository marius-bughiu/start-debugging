---
title: "Copilot Dynamic Workflows vs /fleet vs GitHub Agentic Workflows: Which Multi-Agent Option to Reach For"
description: "Use /fleet for a one-off parallel task in your terminal, a dynamic workflow when the same multi-agent process has to run the same way twice, and GitHub Agentic Workflows when that process runs unattended on repository events. Compared on Copilot CLI 1.0.103 and gh-aw v0.93.6: who plans the split, limits, resume, permissions, write safety and billing."
pubDate: 2026-10-26
template: vs
tags:
  - "comparison"
  - "github-copilot"
  - "ai-agents"
  - "copilot-cli"
  - "dynamic-workflows"
  - "agentic-workflows"
  - "subagents"
---

**Short answer:** pick by who writes the plan and where it runs. `/fleet` lets Copilot split a task into parallel subagents on the fly, which is right for a one-off job you are watching. A dynamic workflow puts the split in code (`defineWorkflow` in `.github/extensions/<name>/extension.mjs`), so it is the winner for anything you will run more than once. GitHub Agentic Workflows (gh-aw) is not a third orchestrator. It is the guardrail layer you wrap around either of the other two when the run fires from an issue, a PR or a schedule with nobody watching. Everything below is checked against Copilot CLI 1.0.103 (October 22, 2026) and gh-aw v0.93.6 (October 26, 2026). Dynamic workflows are in public preview and gh-aw is a technical preview. `/fleet` has been available to all users since Copilot CLI 0.0.411 in February.

## Three answers to the same "use more than one agent" question

GitHub now ships three ways to put several agents on one job, and their names overlap enough to confuse anyone. GitHub's own [dynamic workflows concepts page](https://docs.github.com/en/copilot/concepts/agents/dynamic-workflows) says the main difference is "how work is planned and controlled, not simply how many agents are used." That is the right lens, and it extends cleanly to gh-aw:

- **`/fleet`**: the main Copilot agent reads your prompt, decides whether it can be divided, and acts as orchestrator for subagents that each get their own context window. Copilot picks the split every time.
- **Dynamic workflow**: a JavaScript program decides the steps, which of them go to an agent, what runs in parallel, and what happens with each result. Agents only make the judgment calls.
- **GitHub Agentic Workflows**: a Markdown file compiled into a hardened GitHub Actions `.lock.yml`. The agent job is read-only and firewalled, and writes are applied by separate jobs through `safe-outputs`. Since gh-aw v0.91.0 the Copilot engine can call a dynamic workflow from inside that job.

So the first two are orchestration models, and the third is a runtime and a security boundary. Comparing all three as peers is what makes the choice look harder than it is.

## Feature matrix

| | `/fleet` (CLI 1.0.103) | Dynamic workflow (CLI 1.0.103, preview) | gh-aw (v0.93.6, technical preview) |
| --- | --- | --- | --- |
| Who decides the split | Copilot, per run | Your code | Whatever runs inside: a prompt, or a dynamic workflow |
| Same steps every run | No | Yes (agent answers can still vary) | Yes for the shell, depends on the body |
| Where it runs | Copilot CLI or the Copilot app | CLI, app, SDK host, any CI step | GitHub Actions only |
| How you start it | `/fleet <prompt>`, `copilot --fleet -p` | Ask by name, `copilot workflow run <name>`, slash command, SDK | `on:` triggers, `schedule: daily`, `on: /command` |
| Structured output | Prose summary per subtask | JSON validated against a schema | Typed `safe-outputs` requests |
| Limits | Session AI credit limit only | Concurrency, total agents, timeout, AI credits per run | `timeout-minutes`, `max-ai-credits`, safe-output caps |
| Pause and resume | No | Yes, journaled steps replay | No, one shot per job |
| Write access | Whatever the session grants | Session grants, plus the extension's own Node.js code | Agent job has no write token |
| Billing | AI credits | AI credits, token-based plans only | AI credits plus Actions minutes |

If you read one row, read the first. Every other row follows from who owns the plan.

## When `/fleet` is the right call

`/fleet` is the fastest path from "this is obviously parallel" to agents working on it. There is nothing to write. The typical flow from [the `/fleet` how-to](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/speed-up-task-completion) is plan mode first, then fleet:

```text
# Copilot CLI 1.0.103, interactive session
# Shift+Tab into plan mode, iterate on the plan, then:
/fleet Implement the plan. Use the @test-writer agent to add tests for each component.
```

Then `/tasks` lists the subagents. `Enter` shows a subtask's details and summary, `x` kills one, `r` clears finished ones.

The same thing works without an interactive session:

```bash
# Copilot CLI 1.0.103
copilot --fleet -p "Refactor the utils package and update everything that calls it" --allow-tool write
```

Reach for it when:

- **The task is a one-off.** A refactor across six packages that you will never do again in that shape. Writing a workflow for it is wasted effort.
- **You do not know the split yet.** Copilot is decent at spotting independent subtasks in a plan. If you cannot write the decomposition down yourself, let it try.
- **You are there to steer.** In interactive mode fleet can stop and ask you questions. That is a feature at your desk and a liability in automation.

What you give up is predictability. Two runs of the same `/fleet` prompt can divide the work differently, launch a different number of subagents and spend a very different number of credits. GitHub's docs warn that fleet "may cause more GitHub AI Credits to be consumed" and that inherently sequential work gets no benefit. The only ceiling is the per-session AI credit limit, covered in [setting AI credit session limits in Copilot CLI and the SDK](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/).

## When a dynamic workflow is the right call

The moment you catch yourself pasting the same `/fleet` prompt a second time, write a workflow instead. The decomposition becomes code you can review, diff and version, and the agents get a narrower job each. A small sweep that finds call sites of a deprecated API, one agent per directory, looks like this:

```js
// .github/extensions/api-sweep/extension.mjs
// Copilot CLI 1.0.103, @github/copilot-sdk resolved by the CLI (not installed)
import { readdir } from "node:fs/promises";
import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";

const HITS = {
  type: "object",
  required: ["hits"],
  properties: {
    hits: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "line", "replacement"],
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          replacement: { type: "string" },
        },
      },
    },
  },
};

const sweep = defineWorkflow({
  meta: {
    name: "api-sweep",
    description: "Find calls to a deprecated API per top-level directory. args: { api: string }",
    argsSchema: { type: "object", required: ["api"], properties: { api: { type: "string" } } },
    limits: { maxConcurrentSubagents: 4, maxTotalSubagents: 40, timeoutSeconds: 1800 },
  },
  run: async (ctx) => {
    const { api } = ctx.args;
    // Deterministic step, journaled so a resume does not redo it.
    const dirs = await ctx.step("dirs-v1", async () =>
      (await readdir("src", { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => `src/${d.name}`),
    );
    const results = await ctx.parallel(
      dirs.map((dir) => () =>
        ctx.agent(
          `List every call to ${api} under ${dir} and the replacement it needs. ` +
          `Return an empty list if there are none.`,
          { label: `sweep:${dir}`, schema: HITS },
        ),
      ),
    );
    // ctx.agent resolves to null on ordinary failure instead of throwing.
    return { hits: results.filter(Boolean).flatMap((r) => r.hits) };
  },
});

await joinSession({ workflows: [sweep] });
```

Run it by name from a session ("run the api-sweep dynamic workflow for `HttpClientFactory.Legacy`") or straight from the shell:

```bash
# Copilot CLI 1.0.103; global flags go before the subcommand
copilot --experimental --allow-tool=read workflow run api-sweep \
  --args '{"api":"HttpClientFactory.Legacy"}' --result-file hits.json
```

Pick a dynamic workflow when:

- **The process repeats.** Release checks, PR review fan-outs, codebase sweeps. The docs list these use cases themselves.
- **Later steps need the output.** `schema` gives you JSON that the next stage, or `jq` in a CI step, can read. Since CLI 1.0.101, supported models return that structured output natively instead of being re-prompted until it parses.
- **You need a budget you can trust.** `meta.limits` caps concurrent agents, total agents, active running time and AI credits for the run. A user's `workflows.defaultLimits.*` settings fill in anything the workflow leaves out, and a limit named in the prompt overrides both. The credit cap is approximate because usage is reported after the fact.
- **The run is long enough to be interrupted.** Paused or limit-stopped runs keep their journal. `/workflows` lists them, you resume one, and completed `ctx.step` and agent results replay instead of being bought twice.

The costs are real but small: you write and maintain code, the API is `@experimental`, and workflow execution needs token-based billing. Copilot Pro and Pro+ subscribers still on legacy annual request-based plans cannot run workflows at all. The full CI walkthrough, including exit codes, the `--experimental` flag and project-extension trust, is in [how to define a Copilot CLI dynamic workflow and run it from CI](/2026/10/how-to-define-a-github-copilot-cli-dynamic-workflow-and-run-it-from-ci/).

## When GitHub Agentic Workflows is the right call

A dynamic workflow in a raw `copilot workflow run` step has one weakness: everything around it is your responsibility. The step holds whatever token you gave it, the network is open, and `extension.mjs` runs with the runner's full rights. That is fine for a maintainer-triggered job. It is not fine for a job that reads an issue body written by a stranger.

gh-aw fixes exactly that layer, and since [v0.91.0 (PR #65937)](https://github.com/github/gh-aw/pull/65937) it can host a dynamic workflow inside its agent job. It is off by default, and with current CLI releases you need both settings, per the [gh-aw Copilot engine reference](https://github.github.com/gh-aw/reference/engines/copilot/):

```markdown
---
# .github/workflows/weekly-api-sweep.md
# gh-aw v0.93.6, compile with `gh aw compile weekly-api-sweep`
on:
  schedule: weekly on monday
permissions:
  contents: read
  copilot-requests: write
engine:
  id: copilot
  dynamic-workflows: true
  args: ["--experimental"]
timeout-minutes: 30
safe-outputs:
  create-issue:
    labels: [tech-debt]
    max: 1
---

# Weekly deprecated API sweep

Run the registered dynamic workflow `api-sweep` once with arguments
`{"api":"HttpClientFactory.Legacy"}`. Use the dynamic workflow run tool,
not a task agent or a newly authored workflow.

If it returns any hits, open one issue listing each file, line and
replacement. If it returns none, do nothing.
```

gh-aw then turns on the CLI's `EXTENSIONS` feature, loads project extensions and pre-approves workflow runs. The agent job stays read-only. The issue is created by a separate job that checks the `create-issue` request against `max: 1` and the label list. The compiler also restores `.github/` from a trusted activation snapshot after checkout, so a pull request cannot swap in its own `extension.mjs` and have the agent run it. That last point is the one you would most likely get wrong in a hand-written workflow.

Pick gh-aw when:

- **The trigger is untrusted text.** Issues, PR bodies and comments from outside contributors are the prompt-injection surface. A read-only agent with typed, capped writes closes most of it structurally. The [deep dive on what gh-aw adds over plain Actions](/2026/10/what-is-github-agentic-workflows-and-how-does-it-differ-from-github-actions/) walks through all four layers.
- **Nobody is watching.** Schedules, `on: /triage` slash commands and event triggers belong here, not in a `/fleet` session left open on a laptop.
- **You want the org's credits to pay.** With `copilot-requests: write` the built-in token is enough, so there is no personal access token to rotate. The token change is covered in [running agentic workflows without a PAT](/2026/06/github-agentic-workflows-without-a-personal-access-token/).

## The gotchas that make the choice for you

A few constraints override preference entirely:

- **`--fleet` is interactive or prompt mode only.** In 1.0.103, `copilot --fleet --acp` prints `--fleet is only supported in interactive or prompt mode.`, and `--fleet` with no prompt refuses to start. If your integration speaks ACP, fleet is not an option.
- **A chat agent never starts a workflow by itself.** The docs are explicit: it only creates or runs a dynamic workflow when you ask, or when a skill or slash command tells it to. If you want a workflow to kick in automatically during normal chat, ship a skill or slash command that names it. `/fleet` has no such constraint because you invoke it directly.
- **`copilot workflow run` never prompts.** Any permission not granted up front is denied, in CI and on your laptop. In an interactive session, a subagent's permission request shows up as a normal prompt and the subagent waits. Grant `--allow-tool=read` plus narrow shell patterns before a headless run, not `--allow-all-tools`.
- **No BYOK for workflows inside gh-aw.** gh-aw's docs note that enabling extensions does not make dynamic workflows available with bring-your-own-key. If your gh-aw setup routes the Copilot engine through your own model provider, you are back to a plain prompt in the agent job.
- **gh-aw cannot pause.** A dynamic workflow that calls `ctx.pause()` will stop the job, and the journal is deleted with the runner. Inside gh-aw, design workflows for one shot and put human review in the issue or PR it creates.
- **Preview churn is real.** gh-aw shipped five releases between October 23 and 26 alone. Pin `engine.version` (the gh-aw docs pair it with `checksums-sha256`) and the extension version (`gh extension install github/gh-aw@v0.93.6`) for anything that matters.

## Which one I would reach for

Default to a dynamic workflow. It is the only option of the three that is both repeatable and portable: the same `extension.mjs` runs from your terminal, the Copilot app, an SDK host and a CI step. Use `/fleet` as a sketchpad for one-off parallel work, and treat a fleet prompt you keep reusing as a draft of a workflow you have not written yet. You can even ask Copilot to author the workflow from the plan that fleet just executed. Then, as soon as that workflow needs to run on repository events or on a schedule, wrap it in a gh-aw Markdown file rather than a raw Actions step, because the read-only agent job and the trusted `.github/` restore are exactly the parts nobody remembers to hand-write.

This is the same split as [the difference between an AI agent and an AI workflow](/2026/10/what-is-the-difference-between-an-ai-agent-and-an-ai-workflow/): `/fleet` is an agent deciding how to delegate, a dynamic workflow is a workflow that calls agents, and gh-aw is the sandbox you run that workflow in. Claude Code users will find the middle option familiar from [Claude Code's dynamic workflows](/2026/05/claude-code-dynamic-workflows-opus-4-8/), where the orchestration also lives in a script.

## Related

- [How to define a GitHub Copilot CLI dynamic workflow and run it from CI](/2026/10/how-to-define-a-github-copilot-cli-dynamic-workflow-and-run-it-from-ci/)
- [What is GitHub Agentic Workflows, and how is it different from GitHub Actions?](/2026/10/what-is-github-agentic-workflows-and-how-does-it-differ-from-github-actions/)
- [What is the GitHub Copilot SDK and what can you build with it](/2026/10/what-is-the-github-copilot-sdk-and-what-can-you-build-with-it/)
- [How to turn on Copilot local sandboxing and restrict what an agent can touch](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/)
- [Set AI credit session limits in GitHub Copilot CLI and the SDK](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/)

## Sources

- [Dynamic workflows](https://docs.github.com/en/copilot/concepts/agents/dynamic-workflows) (GitHub Docs, includes the autopilot / fleet / workflow comparison)
- [Using dynamic workflows](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-dynamic-workflows) (GitHub Docs)
- [Delegating and parallelizing work with agents](https://docs.github.com/en/copilot/concepts/agent-capabilities/choosing-and-delegating-agent-work/delegating-and-parallelizing-work-with-agents) and [Speeding up task completion with the `/fleet` command](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/speed-up-task-completion) (GitHub Docs)
- [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md) (1.0.101 native structured output, 0.0.411 fleet for all users)
- [gh-aw Copilot engine reference: dynamic workflows](https://github.github.com/gh-aw/reference/engines/copilot/)
- [Support dynamic workflows in the Copilot CLI engine (gh-aw PR #65937)](https://github.com/github/gh-aw/pull/65937) and [Add dynamic workflow smoke and opt-in engine defaults (gh-aw PR #66195)](https://github.com/github/gh-aw/pull/66195)
- [Dynamic workflows in Copilot CLI and the Copilot app](https://github.blog/changelog/2026-10-01-dynamic-workflows-in-copilot-cli-and-the-copilot-app/) (GitHub Changelog, October 1, 2026)
