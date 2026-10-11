---
title: "How to Define a GitHub Copilot CLI Dynamic Workflow and Run It From CI"
description: "Write a Copilot dynamic workflow with defineWorkflow in .github/extensions/<name>/extension.mjs, then run it headless with copilot workflow run in GitHub Actions. Verified on Copilot CLI 1.0.95 and @github/copilot-sdk 1.0.19: the --experimental flag, project-extension trust, flag order, exit codes, result files and permissions."
pubDate: 2026-10-11
template: how-to
tags:
  - "github-copilot"
  - "ai-agents"
  - "copilot-cli"
  - "dynamic-workflows"
  - "github-actions"
  - "ci"
---

**Short answer:** a dynamic workflow is a JavaScript module at `.github/extensions/<name>/extension.mjs` that calls `defineWorkflow({ meta, run })` from `@github/copilot-sdk/extension` and registers the handle with `joinSession({ workflows: [...] })`. In CI you run it with `copilot --experimental --allow-tool=read workflow run <name> --args @input.json --silent --output-format json`, with `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true` set so the CLI loads extensions from the untrusted checkout. Exit code `0` means the run completed. `1` means it paused, hit a limit, was cancelled or threw. `2` means the workflow was not found or the arguments failed validation. Everything below was run against Copilot CLI 1.0.95 and `@github/copilot-sdk` 1.0.19 (October 10, 2026). The feature is in public preview, so both the flags and the API carry an `@experimental` tag.

## What a dynamic workflow gives you that `copilot -p` does not

GitHub [shipped dynamic workflows on October 1, 2026](https://github.blog/changelog/2026-10-01-dynamic-workflows-in-copilot-cli-and-the-copilot-app/) for Copilot CLI, the Copilot app and the Copilot SDK. A workflow is a program, not a prompt. Your code decides the steps, which of them hand work to an agent, what runs in parallel, and what happens with each result. The agents only do the judgment calls.

If you have been running `copilot -p "review this diff" --allow-all-tools` in a GitHub Actions step, you already know where that breaks down. The model decides how far to go, the output is prose you have to scrape, and a 20-file diff either gets skimmed or eats your whole budget. A workflow fixes all three. You fan out one subagent per file, ask each one for JSON that matches a schema, run a second agent to check every finding, and return a single structured object that the next job step can read with `jq`.

It also differs from `/fleet`. With `/fleet` Copilot decides how to split the work. With a workflow you decide, and the split is the same on every run. That repeatability is why workflows make sense in CI and `/fleet` mostly does not. The [AI agent vs AI workflow](/2026/10/what-is-the-difference-between-an-ai-agent-and-an-ai-workflow/) distinction applies directly: a dynamic workflow is a workflow that calls agents, not an agent that happens to follow steps.

## Where the file lives and how the CLI finds it

Workflows are carried by Copilot CLI extensions. The CLI scans two places for subdirectories that contain an `extension.mjs` file:

- `.github/extensions/<name>/extension.mjs` in the repository (project extensions, shared with the team)
- `~/.copilot/extensions/<name>/extension.mjs` (personal extensions)

The entry file has to be an ES module named exactly `extension.mjs`. You do not `npm install` the SDK. The CLI forks each extension as a Node.js child process and resolves `@github/copilot-sdk` for it automatically. That also means the CI runner needs nothing beyond the `@github/copilot` package.

## A workflow that reviews the files a PR changed

Here is a complete workflow. It lists the files changed since a base ref, reviews each one with its own subagent, has a second subagent confirm or reject each finding, and returns only the confirmed findings as JSON.

```js
// .github/extensions/pr-review/extension.mjs
// Copilot CLI 1.0.95, @github/copilot-sdk 1.0.19 (resolved by the CLI, not installed)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";

const exec = promisify(execFile);

const FINDINGS = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["line", "severity", "summary"],
        properties: {
          line: { type: "integer" },
          severity: { enum: ["high", "medium", "low"] },
          summary: { type: "string" },
        },
      },
    },
  },
};

const VERDICT = {
  type: "object",
  required: ["real"],
  properties: { real: { type: "boolean" }, reason: { type: "string" } },
};

const prReview = defineWorkflow({
  meta: {
    name: "pr-review",
    description:
      "Review files changed since a base ref and verify each finding. " +
      "args: { base: string, maxFiles?: integer }",
    phases: [{ title: "Diff" }, { title: "Review" }],
    argsSchema: {
      type: "object",
      required: ["base"],
      properties: {
        base: { type: "string" },
        maxFiles: { type: "integer" },
      },
    },
    limits: { maxConcurrentSubagents: 4, timeoutSeconds: 1200 },
  },

  run: async (ctx) => {
    const { base, maxFiles = 20 } = ctx.args;

    ctx.phase("Diff");
    // Plain code, journaled under a key that includes the input.
    const files = await ctx.step(`diff-v1:${base}`, async () => {
      const { stdout } = await exec(
        "git", ["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`],
        { signal: ctx.signal },
      );
      return stdout.split("\n").filter((f) => /\.(ts|js|py|cs)$/.test(f));
    });

    const picked = files.slice(0, maxFiles);
    if (files.length > picked.length) {
      ctx.log(`Skipped ${files.length - picked.length} files over maxFiles=${maxFiles}`);
    }
    if (picked.length === 0) return { reviewed: 0, findings: [] };

    ctx.phase("Review");
    const perFile = await ctx.pipeline(
      picked,
      // Stage 1: one reviewer per file, structured output.
      (_prev, file) =>
        ctx.agent(
          `Read ${file}. Report only defects that would cause wrong behaviour ` +
          `or a crash. Ignore style. Return an empty list if there are none.`,
          { label: `review:${file}`, schema: FINDINGS },
        ),
      // Stage 2: a fresh agent checks each finding against the code.
      async (review, file) => {
        if (!review) return [];
        const verdicts = await ctx.parallel(
          review.findings.map((f, i) => () =>
            ctx.agent(
              `In ${file} near line ${f.line}, a reviewer claims: "${f.summary}". ` +
              `Read the code and decide whether this is a real defect.`,
              { label: `verify:${file}:${i}`, schema: VERDICT },
            ),
          ),
        );
        return review.findings
          .filter((_, i) => verdicts[i]?.real === true)
          .map((f) => ({ file, ...f }));
      },
    );

    const findings = perFile.filter((v) => v !== null).flat();
    return { reviewed: picked.length, findings };
  },
});

await joinSession({ workflows: [prReview] });
```

A few API details explain why the code looks the way it does. They all come from the `workflows.md` file and `dist/workflow.d.ts` that ship inside the SDK package.

**`ctx.step(key, producer)` is the durable boundary.** The result is journaled under `key`, so a resumed run replays the value instead of running `git diff` again. The key is the only identity. If you change what the producer does, change the key (`diff-v1` to `diff-v2`), or a resume returns the stale value.

**`ctx.agent` returns `null` on ordinary failure, it does not throw.** A subagent that errors, returns nothing, or produces JSON that still fails the schema after one automatic retry resolves to `null`. That is why stage 2 starts with `if (!review) return [];`. Hard failures, such as reaching a limit, do throw and end the run.

**Identical calls are memoized into one subagent.** Every `ctx.agent` call is journaled by its prompt plus options. Two calls with the same prompt and options share one result, even when they run concurrently. The unique `label` per file and per finding is what keeps them independent.

**`schema` is a structural subset of JSON Schema.** Only `type`, `required`, `enum`, `const`, nested `properties`/`items` and `anyOf`/`oneOf`/`allOf` are checked. `pattern`, `minLength`, numeric ranges and `additionalProperties` are accepted and then ignored. Do not rely on them to sanitize output.

**`pipeline` has no barrier between stages.** File A can be in verification while file B is still under review. Use `parallel` between stages only when a stage needs every earlier result at once, for example to deduplicate across files. Also keep `ctx.phase()` calls at the top level. Phase is a single run-wide value, so setting it inside concurrent stages races.

**`meta.limits` should come from a cost you know.** The SDK docs say it plainly: a guessed ceiling stops a healthy run partway through after it has already spent credits. Concurrency is safe to cap because extra agents just queue. `maxTotalSubagents`, `timeoutSeconds` and `maxAiCredits` stop the run with `failure.type: "workflow_limit_reached"`. The `maxAiCredits` ceiling is soft because usage is reported after the fact. For per-session credit ceilings outside workflows, see [AI credit session limits in Copilot CLI and the SDK](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/).

## Running it locally before you touch CI

From the repository root:

```bash
# Copilot CLI 1.0.95
copilot --experimental --allow-tool=read workflow run pr-review --args '{"base":"origin/main"}'
```

`copilot workflow run --help` documents four options of its own: `--args <json|@path>`, `--result-file <path>`, `-s/--silent` and `--output-format text|json`. Everything else is a global option and has to come **before** the `workflow` subcommand. I tried it the other way round and the parser rejects it:

```text
$ copilot --experimental workflow run hello --allow-tool=read --args '{"who":"b"}'
error: unexpected argument '--allow-tool' found
```

The same applies to `--model`, `--allow-url` and `--add-dir`. GitHub's docs list them as shared options for `workflow run`, which is true, but only in the global position.

Two things trip you up on a first run:

1. **Without `--experimental` the command fails** with `Error executing dynamic workflow "pr-review": Error: extensions are not configured for session ...` and exit code `1`. Passing `--experimental` once writes `"experimental": true` to `$COPILOT_HOME/settings.json`, so your laptop "just works" afterwards. A fresh CI runner has no such file, so always pass the flag there.
2. **An untrusted folder hides project extensions.** You get `Project extensions are excluded because the working folder is not trusted. Trust the folder or set GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true for this invocation.` followed by `Dynamic workflow "pr-review" was not found.` and exit code `2`. Locally you trust the folder once. In CI you set the environment variable.

## The GitHub Actions job

```yaml
# .github/workflows/copilot-pr-review.yml
# Copilot CLI 1.0.95, dynamic workflows public preview (October 2026)
name: Copilot PR review

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  copilot-requests: write

jobs:
  review:
    # Never run repository extension code from forks.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0   # the workflow diffs against the base branch

      - name: Install Copilot CLI
        run: npm install -g @github/copilot@1.0.95

      - name: Run pr-review workflow
        env:
          GITHUB_TOKEN: ${{ github.token }}
          GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: "true"
        run: |
          echo '{"base":"origin/${{ github.base_ref }}","maxFiles":25}' > input.json
          copilot --experimental --allow-tool=read \
            workflow run pr-review \
            --args @input.json \
            --result-file review.json \
            --silent --output-format json > run.jsonl

      - name: Publish findings
        if: success()
        run: |
          jq -r '.findings[] | "- **\(.severity)** `\(.file):\(.line)` \(.summary)"' review.json \
            >> "$GITHUB_STEP_SUMMARY"
          test "$(jq '[.findings[] | select(.severity=="high")] | length' review.json)" -eq 0
```

Authentication follows [Using Copilot CLI in GitHub Actions](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions). With `copilot-requests: write` in the `permissions` block and the organization policy "Allow use of Copilot CLI billed to the organization" enabled (it is on by default where Copilot CLI is enabled), the built-in `GITHUB_TOKEN` is enough. On a personal repository, or when the policy is off, create a fine-grained PAT with the **Copilot Requests** permission and pass it as `COPILOT_GITHUB_TOKEN`. The CLI checks `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`. If you already went through the PAT-to-`GITHUB_TOKEN` move for agentic workflows, [the same token change](/2026/06/github-agentic-workflows-without-a-personal-access-token/) applies here.

Pinning `@github/copilot@1.0.95` matters more than usual. The workflow API is marked experimental, and auto-update is already off in CI (the CLI turns it off when it sees `CI`, `BUILD_NUMBER`, `RUN_ID` or `SYSTEM_COLLECTIONURI`).

### Permissions are granted up front or not at all

`copilot workflow run` never shows a permission prompt. A tool request that your flags do not pre-approve is simply denied. Workflow subagents inherit the grants of the session that started them, so `--allow-tool=read` is what lets the reviewers open files. If a stage needs to run tests, grant a narrow shell pattern such as `--allow-tool='shell(npm test:*)'`, not `--allow-all-tools`.

The extension's own Node.js code is not subject to these prompts. The `execFile("git", ...)` call in `ctx.step` runs with the runner's full rights. That is a good reason to keep the deterministic parts in code and give agents only read access. It is also why the job refuses fork PRs: `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true` tells the CLI to execute whatever `extension.mjs` the checkout contains, and on a fork PR that file belongs to a stranger.

## Exit codes, result files and the JSON record

I checked the documented behaviour against real runs. The exit codes are:

| Exit | Meaning |
|---|---|
| `0` | Completed, and the `--result-file` (if requested) was written |
| `1` | Paused, limit reached, cancelled, or the workflow threw |
| `2` | Workflow not found, or `--args` could not be read, parsed or validated |
| `130` | Interrupted by `SIGINT` or `SIGTERM` |

`--args` are validated against `argsSchema` before the run starts. Passing `{"who":3}` to a workflow that declares `who: { type: "string" }` exits `2` with `Invalid arguments for dynamic workflow "hello".` That makes a schema worth declaring even though it only checks structure.

`--result-file` gets **only** the returned value, and it is not overwritten when a run fails. I pre-seeded `res.json` with `{"stale":true}`, ran a workflow that paused at a checkpoint, and the file still held `{"stale":true}` afterwards with exit code `1`. In CI the file is fresh, but on a self-hosted runner or with a cached workspace, read it only after checking the exit code. The YAML above relies on the default `bash -e` shell to stop the job before the publish step.

With `--silent --output-format json`, stdout carries one final JSONL record:

```json
{"type":"workflow.result","data":{"name":"gate","run":{"runId":"6f1adee2-...","attempt":1,"status":"paused","reason":"Workflow execution paused at a checkpoint","pauseInfo":{"type":"checkpoint","key":"review"}}}}
```

Human-readable lines such as `Dynamic workflow "gate" paused.` still go to stderr even in silent mode, so redirect only stdout into the file you parse. When `--result-file` is set, `data.run.result` is left out of the record and `data.resultFile` appears once the file is written.

## Pauses and resumes do not belong in a CI job

`ctx.pause("review-ready")` is a durable checkpoint. The first attempt stops there, and a later resume reruns the workflow from the top, replays every journaled `ctx.step` and agent result, and continues past the checkpoint. That works well interactively, where `/workflows` lists runs and `R` resumes one, or from an SDK host that calls `session.workflow.resume(runId, { limits })`.

`copilot workflow run` does not support `--resume`, and the journal lives in `$COPILOT_HOME` on a runner that is deleted when the job ends. In a CI workflow, treat `paused` and `workflow_limit_reached` as failures and design for one shot. Put human review in the pull request itself, not in a checkpoint. If you do need resumable runs, host the workflow in a long-lived process with the SDK, which is covered in [what the GitHub Copilot SDK lets you build](/2026/10/what-is-the-github-copilot-sdk-and-what-can-you-build-with-it/).

## Gotchas worth knowing before you ship

- **Plan eligibility.** Workflow execution needs token-based billing. Copilot Pro and Pro+ subscribers on legacy annual plans with request-based billing get JSON-RPC error `-32601` with `data.code: "dynamic_workflows_unavailable"`. A PAT owner on one of those plans breaks the job even if the org is fine.
- **Workflows without agents run without credits.** A workflow that only uses `ctx.step` completes with `AI Credits 0`. That makes a cheap smoke test for the extension wiring in CI: add a no-agent `ping` workflow and run it first.
- **`ctx.args` is `{}` when you omit `--args`, not `undefined`.** Destructuring with defaults is safe, but a missing required field is only caught if `argsSchema` declares it.
- **No nested workflows.** `ctx.workflow(...)` always rejects. Compose with plain functions instead.
- **The 4096 item cap.** `ctx.parallel` and `ctx.pipeline` reject arrays over 4096 items. Keep `maxFiles` far below that anyway.
- **Agentic Workflows may be the better fit.** GitHub recommends [GitHub Agentic Workflows](/2026/10/what-is-github-agentic-workflows-and-how-does-it-differ-from-github-actions/) over calling `copilot` directly in a step because it adds guardrails, and gh-aw is adding dynamic-workflow support to its Copilot engine. Use a raw `copilot workflow run` step when you want the exact control flow in your own repository code and you accept the responsibility that comes with it.

Claude Code users will recognise the shape. It is close to [Claude Code's own dynamic workflows](/2026/05/claude-code-dynamic-workflows-opus-4-8/), where the orchestration also lives in a script and the model fills in the judgment steps. The Copilot version is distinctive because the same `extension.mjs` runs in the terminal, in the Copilot app, from the SDK and from a CI step without changes.

## Sources

- [Dynamic workflows in Copilot CLI and the Copilot app](https://github.blog/changelog/2026-10-01-dynamic-workflows-in-copilot-cli-and-the-copilot-app/) (GitHub Changelog, October 1, 2026)
- [Dynamic workflows concepts](https://docs.github.com/en/copilot/concepts/agents/dynamic-workflows) and [Using dynamic workflows](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-dynamic-workflows) (GitHub Docs)
- [Copilot CLI programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference) (exit codes, JSON record, token precedence)
- [Using Copilot CLI in GitHub Actions](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions)
- [Creating extensions for GitHub Copilot CLI](https://docs.github.com/en/copilot/tutorials/create-an-extension)
- `@github/copilot-sdk` 1.0.19 on npm: `docs/workflows.md`, `docs/extensions.md`, `dist/workflow.d.ts`
