---
title: "How to Scaffold, Eval and Replay a Cursor Agent SDK PR Bot"
description: "Use agent-sdk init, agent-sdk eval and agent-sdk github replay (@grok/agent-sdk 0.6.0) to build a pull request review bot, pin its behavior with evals, and test it against real PRs without pushing a commit."
pubDate: 2026-11-13
template: how-to
tags:
  - "cursor"
  - "ai-agents"
  - "cursor-agent-sdk"
  - "evals"
  - "github"
  - "typescript"
---

**Short answer:** install the CLI with `npm install -g @grok/agent-sdk` (version 0.6.0, Node 22.13 or newer), run `agent-sdk init ./pr-bot --template security-reviewer`, and start it with `agent-sdk dev`. Write cases in `evals/*.eval.ts` with `defineEval` and run them with `agent-sdk eval --dir . --tag smoke`. To test against a real pull request without pushing anything, run `agent-sdk github replay https://github.com/acme/api/pull/12 --dir . --action opened` while the bot is serving, or add `--dry-run --fixtures-dir fixtures/github` to save the signed webhook payloads as fixtures instead. Guard every write tool with `ctx.session.purpose === "eval"` so evals never post a review.

Cursor shipped the Agent SDK as generally available on [October 20, 2026](https://cursor.com/changelog/agent-sdk). It is a different product from the in-process `@cursor/sdk` agent library: an Agent SDK project is a folder of Markdown and TypeScript (instructions, tools, channels) that the `agent-sdk` CLI serves locally and deploys to Cursor hosting. The three commands in this post are the inner loop for any GitHub-driven bot: `init` gives you a working project, `eval` locks the behavior you care about, and `github replay` feeds the bot a real PR on demand.

## The package name is @grok/agent-sdk, not @cursor/agent-sdk

The launch changelog tells you to run `npx @cursor/agent-sdk init ./my-bot`. That package does not exist: `npm view @cursor/agent-sdk` returns `E404` as of November 13, 2026. The SDK is published as [`@grok/agent-sdk`](https://www.npmjs.com/package/@grok/agent-sdk), whose `package.json` describes it as "Build, test, and deploy agents as code on Cursor's agent harness" and points its repository at `github.com/cursor/cursor`. Cursor's own [quickstart](https://cursor.com/docs/agent-sdk/quickstart) and every import path in the docs use `@grok/agent-sdk`. The package exposes two binaries, `agent-sdk` and the older `bdk` alias, from the same entry point.

```bash
# @grok/agent-sdk 0.6.0, Node >= 22.13 (from the package's "engines" field)
npm install -g @grok/agent-sdk
agent-sdk --version
agent-sdk login          # or export CURSOR_API_KEY for CI
```

Credentials are resolved in this order: `--api-key`, `CURSOR_API_KEY`, `CURSOR_API_KEY_FILE`, `CURSOR_SERVICE_ACCOUNT_KEY`, then whatever `agent-sdk login` stored. Model turns, including every eval turn, need one of these.

## Scaffold the bot with agent-sdk init

`agent-sdk init` with no directory prints the setup guide. With a directory it writes any missing scaffold files, runs `npm install`, and tries to put `agent-sdk` on your `PATH`. On a TTY it also asks the template's questions and starts login if needed.

```bash
# @grok/agent-sdk 0.6.0
agent-sdk init ./pr-bot --template security-reviewer --var repos=acme/api,acme/web
cd pr-bot
agent-sdk validate     # exits 1 on error-severity diagnostics
agent-sdk info         # prints what the CLI discovered: tools, channels, skills
agent-sdk dev          # serve --dev on 127.0.0.1:3000 with the playground
```

`--template` accepts `agentic-owners`, `agents-md`, `code-wiki`, `demo`, `security-help`, `security-reviewer`, `thermo-quality-review`, `thermo-review`, `triage-jira` and `triage-linear` (`triage` is an alias for `triage-linear`). `--var id=value` answers a template question without prompting, which is what you want in a script. The `security-reviewer` template ships an `init.json` with one question, `repos`, and the answer is written into `bot/lib/repos.ts` as a JSON array. Add `--dry-run` to list the files without writing them.

If you already have a Cursor Automation doing this job, `agent-sdk init --from automation:<url-or-uuid>` converts it into a project folder instead of starting from a template. Generated files never overwrite existing paths, but the `npm install` that follows can run lifecycle scripts from an existing `package.json`, so do not point it at a directory you have not read.

The `security-reviewer` template in 0.6.0 produces this layout:

```text
pr-bot/
  bot/
    agent.ts
    instructions.md        # the system prompt
    channels/github.ts     # which GitHub events start a session
    lib/repos.ts           # plain helpers, not discovered as tools
    tools/post_findings.ts # one file = one tool
  evals/
    evals.config.ts
    review.eval.ts
  init.json
  package.json
  tsconfig.json
```

Everything under `bot/tools/` becomes a tool the model can call, and `bot/lib/` is ordinary code the tools import. If you are coming from a hand-written agent loop, this split is the main mental shift, and the [migration guide from a custom TypeScript loop to the Cursor SDK](/2026/08/migrate-a-custom-typescript-agent-loop-to-the-cursor-sdk/) covers the same idea for the in-process SDK.

## Wire the GitHub channel

The channel decides which events become sessions and what the agent sees. The template uses `cursorAccount`, which reuses the GitHub connection on your Cursor account, so there is no GitHub App, webhook URL or PAT to set up for github.com:

```ts
// bot/channels/github.ts -- @grok/agent-sdk 0.6.0
import { defaultGitHubPullRequestDispatch, githubChannel } from "@grok/agent-sdk/channels/github";
import { REPOS, watches } from "../lib/repos.js";

export default githubChannel({
  cursorAccount: { repos: REPOS },
  deliverReplies: false,          // the tool posts the review, not the channel
  onComment: () => null,          // ignore comments
  onPullRequest: (ctx, pr) => {
    if (!watches(ctx.repository.fullName) || pr.draft) return null;
    const dispatch = defaultGitHubPullRequestDispatch(ctx, pr);
    if (dispatch === null) return null;
    return {
      auth: dispatch.auth,
      context: ["Read pr/diff.patch."],
      async workspaceFiles() {
        const octokit = await ctx.github.getOctokit();
        const pull = { owner: ctx.repository.owner, repo: ctx.repository.name, pull_number: pr.number };
        const [meta, diff] = await Promise.all([
          octokit.rest.pulls.get(pull),
          octokit.rest.pulls.get({ ...pull, mediaType: { format: "diff" } }),
        ]);
        return {
          "pr/diff.patch": typeof diff.data === "string" ? diff.data.slice(0, 150_000) : "",
          "pr/head.sha": meta.data.head.sha,
        };
      },
    };
  },
});
```

Hooks return `{ auth }`, `{ task }` or `null`, and the full set is `onPullRequest`, `onComment`, `onIssue`, `onCheckSuite`, `onCheckRun`, `onWorkflowRun`, `onStatus` and a catch-all `onEvent`. All repos in one channel must share one owner. `workspaceFiles` is the important part for evals: the agent reads `pr/diff.patch` from its workspace, so an eval can supply that file directly instead of calling GitHub.

## Make the write tool eval-safe before you write a single eval

Evals run your real tools. The [evals guide](https://cursor.com/docs/agent-sdk/evals) is blunt about it, and the mechanism is a session field rather than an environment variable: eval sessions carry `purpose: "eval"`. Check it at the exact point where the tool would touch the outside world, and return a result that still describes the decision:

```ts
// bot/tools/post_findings.ts -- @grok/agent-sdk 0.6.0, zod 4
import { parseGitHubPrContinuationKey } from "@grok/agent-sdk/channels/github";
import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";

const finding = z.object({
  severity: z.enum(["high", "medium", "low"]),
  file: z.string().min(1),
  line: z.number().int().positive(),
  title: z.string().min(1).max(160),
});

export default defineTool({
  description: "Post the security review on this session's pull request. Call once. Empty findings = CLEAN.",
  inputSchema: z.object({ findings: z.array(finding) }),
  async execute({ findings }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { posted: false, reason: "eval", count: findings.length };
    }
    const ref = parseGitHubPrContinuationKey(ctx.session.continuationKey ?? "");
    if (ref === undefined) throw new Error("post_findings requires a GitHub pull request session");
    const octokit = await ctx.host.github.getOctokit();
    const res = await octokit.rest.pulls.createReview({
      owner: ref.owner, repo: ref.repo, pull_number: ref.number,
      event: "COMMENT",
      body: findings.length === 0 ? "**Verdict:** CLEAN" : findings.map(f => `- ${f.severity} ${f.file}:${f.line} ${f.title}`).join("\n"),
    });
    return { posted: true, url: res.data.html_url };
  },
});
```

The tool call still lands in the trajectory with its input, so an eval can assert that the agent decided to post and what it would have posted. That is the property you want: the eval tests the model's decision, not GitHub's API. The same pattern belongs in any tool that approves, merges, comments or pushes. If you also want a human-in-the-loop gate on those tools at runtime, the [auto-review and permissions.json post](/2026/06/gate-cursor-sdk-tool-calls-with-auto-review-and-permissions-json/) covers that layer for the Cursor SDK.

## Write evals that pin the decisions you care about

An eval file lives at `evals/**/*.eval.{ts,js}` and default-exports `defineEval`. Each case sends a fixed input and asserts on what happened: which tools ran, which did not, and what the reply looks like. A single file can hold several cases:

```ts
// evals/review.eval.ts -- @grok/agent-sdk 0.6.0
import { defineEval, includes } from "@grok/agent-sdk/evals";

const OPENED = [
  "GitHub pull request trigger: acme/api#12",
  "Action: opened",
  "PR: https://github.com/acme/api/pull/12",
  "Read pr/diff.patch.",
].join("\n");

export default defineEval({
  tags: ["smoke"],
  cases: [
    {
      id: "xss",
      description: "Unescaped query reflection is posted as a finding.",
      async test(t) {
        await t.send(OPENED, {
          workspaceFiles: {
            "pr/diff.patch": [
              "diff --git a/app/routes/search.ts b/app/routes/search.ts",
              "+res.send(`<h1>Results for ${req.query.q}</h1>`);",
            ].join("\n"),
          },
        });
        t.succeeded();
        t.calledTool("post_findings");
        t.check(t.reply, includes(/xss|cross-site|injection/i));
      },
    },
    {
      id: "docs-only",
      description: "A README change is posted as clean.",
      async test(t) {
        await t.send(OPENED, {
          workspaceFiles: { "pr/diff.patch": "diff --git a/README.md b/README.md\n+# API" },
        });
        t.succeeded();
        t.calledTool("post_findings");
        t.check(t.reply, includes(/clean|no findings/i));
      },
    },
  ],
});
```

The assertion surface in 0.6.0 is small and worth memorizing:

- `t.succeeded()`, `t.calledTool(name)`, `t.notCalledTool(name)` check the whole conversation.
- `const turn = await t.send(...)` returns a turn, and `turn.calledTool(...)`, `turn.usedNoTools()` and `turn.message` check only that turn. Several `t.send` calls in one case share a session, which is how you test a follow-up question.
- `t.check(value, matcher)` takes `includes(regex)`, `equals`, `matches(zodSchema)`, `satisfies`, or a similarity matcher, all exported from `@grok/agent-sdk/evals`.
- `t.judge.factuality("...").atLeast(0.8)` hands the reply to a judge model when correctness depends on meaning. Run `agent-sdk eval --strict` if a scored case below its soft threshold should fail the run.

For a "never approve" rule, `t.notCalledTool("approve_pr")` is a deterministic check and should beat a judge every time. Reach for the judge only for prose quality, and read [LLM-as-judge vs rule-based evals](/2026/06/llm-as-judge-vs-rule-based-evals-for-a-coding-agent/) before you let a judge gate merges.

Concurrency is set per project:

```ts
// evals/evals.config.ts -- @grok/agent-sdk 0.6.0
import { defineEvalConfig } from "@grok/agent-sdk/evals";

export default defineEvalConfig({ maxConcurrency: 10 });
```

Run the loop locally. Without `--url` the CLI starts an ephemeral local server for the run:

```bash
agent-sdk eval --dir . --list          # discovered cases
agent-sdk eval --dir . xss             # one case while iterating
agent-sdk eval --dir . --tag smoke     # the smoke set before review
```

Each run writes `evals/<case-id>.json` under the project state directory (or under `--artifacts <dir>`), with the input, every assertion, the tool calls and the final text. When a case fails, that file is the first thing to open. Exit codes are scriptable: `1` for failed cases, `2` for invalid options or a filter that matched nothing.

### Running evals in CI

The CI invocation from the docs produces JUnit for the test UI plus a JSON summary:

```yaml
# .github/workflows/bot-evals.yml -- @grok/agent-sdk 0.6.0
name: bot-evals
on: [pull_request]
jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: |
          mkdir -p reports
          npx agent-sdk eval --dir . --tag smoke --json --no-stream \
            --junit reports/evals.xml --artifacts reports/evals > reports/evals.json
        env:
          CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
```

Run `--tag smoke` on pull requests and the full suite on a schedule. Evals call the real model, so every case costs a model turn; the smoke tag is what keeps the PR check cheap. Setting `CI` (to anything other than `0`) also disables the CLI's update check, which keeps logs quiet.

## Replay a real pull request with agent-sdk github replay

Evals use synthetic inputs. Replay closes the gap with reality: it reads a pull request you have read access to, synthesizes the webhook payloads GitHub would have sent, signs them, and posts them to every matching channel in your project. The bot must already be serving, so keep `agent-sdk dev` running in another terminal.

```bash
# @grok/agent-sdk 0.6.0, with `agent-sdk dev` running
agent-sdk github replay https://github.com/acme/api/pull/12 --dir . --action opened

# Short form, every event the channel listens for, with CI reported as failing
agent-sdk github replay acme/api#12 --dir . --events '*' --conclusion failure

# Simulate a reviewer comment
agent-sdk github replay acme/api#12 --dir . --events issue_comment --comment "/review again"
```

The supported events are `pull_request` (the default), `issue_comment`, `pull_request_review_comment`, `check_run`, `check_suite`, `workflow_run` and `status`, or `'*'` for all of them. `--action`, `--conclusion`, `--comment` and `--context` shape the payload; `--slug` and `--channel` target one agent or channel in a multi-agent project. The signing secret comes from `--secret` or the `GITHUB_WEBHOOK_SECRET` environment variable, which is the same secret the channel verifies, so a replayed delivery goes through the same signature check a real one does.

Because replay goes through the channel, it exercises the parts evals skip: your `onPullRequest` filters, the draft check, `workspaceFiles` fetching the real diff, and the `auth` the dispatch returns. A bug where the bot ignores PRs from forks, or truncates a large diff badly, shows up here and never in an eval that hands the agent a ready-made `pr/diff.patch`. Remember that a replayed session is not an eval session: `purpose` is not `"eval"`, so `post_findings` will really post. Replay against a sandbox repo or a PR you own until the bot behaves.

### Turn a replay into a fixture

Add `--dry-run` to print the payloads without posting, and `--fixtures-dir` to write them to disk:

```bash
agent-sdk github replay https://github.com/acme/api/pull/12 \
  --dir . --events '*' --dry-run --fixtures-dir fixtures/github
```

Commit `fixtures/github/` and load it from evals with the loaders in `@grok/agent-sdk/evals/loaders` (`loadJson`, `loadJsonl`, `loadYaml`). Paths resolve against the project root, not the eval file, so the same path works from any depth:

```ts
// evals/replayed.eval.ts -- @grok/agent-sdk 0.6.0
import { defineEval, includes } from "@grok/agent-sdk/evals";
import { loadJson } from "@grok/agent-sdk/evals/loaders";

// Point this at a payload file written by `github replay --fixtures-dir`.
const payload = await loadJson<{ pull_request: { title: string; html_url: string } }>(
  "fixtures/github/pull_request.json",
);

export default defineEval({
  tags: ["regression"],
  async test(t) {
    await t.send(`PR: ${payload.pull_request.html_url}\nTitle: ${payload.pull_request.title}\nRead pr/diff.patch.`, {
      workspaceFiles: { "pr/diff.patch": "diff --git a/README.md b/README.md\n+# API" },
    });
    t.calledTool("post_findings");
    t.check(t.reply, includes(/clean/i));
  },
});
```

Check the file names `--fixtures-dir` actually wrote before you hard-code the path; the docs do not pin a naming scheme. You can also post a saved payload straight at a running dev server with `curl --data-binary @fixtures/...`, the pattern the [webhooks guide](https://cursor.com/docs/agent-sdk/guides/webhooks) uses for custom channels.

## Gotchas worth knowing up front

- **GitHub Enterprise Server cannot be replayed.** Event pull and `github replay` only reach github.com. For GHES, configure the channel with `api.apiBaseUrl` plus `credentials.token` and `credentials.webhookSecret` as `{ secretName: "..." }`, and test with fixtures captured elsewhere. On Cursor hosting a delivery with a missing or wrong signature gets `401` and never reaches the agent.
- **`agent-sdk validate` rejects literal secrets.** It fails if an SCM webhook secret or GitHub credential is a literal string or a getter. Always use `{ secretName: "NAME" }`, which reads the environment variable locally and the deployment secret when hosted (`agent-sdk secret set <slug> NAME`).
- **Replay is not forwarding.** `agent-sdk github forward` streams live deliveries through `gh webhook forward` and needs repo admin; unset `GITHUB_TOKEN` and `GH_TOKEN` first or deliveries fail with `401`. Replay needs only read access.
- **`onIssue` has no replay event.** The replay list stops at PR, comment, check and status events, so issue-driven triage bots need a hand-built fixture.
- **Tool calls in evals are real.** A tool that reads from GitHub will hit GitHub during an eval. Prefer `workspaceFiles` inputs so evals stay deterministic and do not burn API quota.
- **Two docs, two package names.** If an install script fails with a 404, it is copying the changelog's `@cursor/agent-sdk`. Use `@grok/agent-sdk`.

This walkthrough was assembled from the `@grok/agent-sdk` 0.6.0 package contents (its bundled docs, CLI flag definitions and the `security-reviewer` template) and Cursor's published docs. The commands were not executed for this post, since model turns require a Cursor API key.

## Related

- [How to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/) is the Anthropic-side equivalent of the same bot.
- [Setting up an LLM-as-judge eval harness for a coding agent](/2026/05/how-to-set-up-an-llm-as-judge-eval-harness-for-a-coding-agent/) covers judge calibration in more depth than `t.judge`.
- [Nesting subagents in the Cursor SDK](/2026/06/nest-subagents-in-the-cursor-sdk-reviewer-delegates-to-test-writer/) shows a reviewer delegating to a test writer.
- [Cursor Bugbot effort levels for PR review](/2026/05/cursor-bugbot-effort-levels-pr-review/) is the managed alternative if you do not need a custom bot.

## Sources

- [Agent SDK changelog, October 20, 2026](https://cursor.com/changelog/agent-sdk)
- [Agent SDK CLI reference](https://cursor.com/docs/agent-sdk/reference/cli)
- [Agent SDK evals](https://cursor.com/docs/agent-sdk/evals)
- [Agent SDK GitHub guide](https://cursor.com/docs/agent-sdk/guides/github)
- [Build a PR reviewer quickstart](https://cursor.com/docs/agent-sdk/quickstart)
- [`@grok/agent-sdk` on npm](https://www.npmjs.com/package/@grok/agent-sdk)
