---
title: "How to Auto-Fix a Failing GitHub Action with Fix with Copilot"
description: "When a GitHub Actions job goes red, the Fix with Copilot button hands the failure to the Copilot cloud agent: it reads the logs, pushes a fix to your branch, and tags you for review. Here is where the button lives, the May 18 / June 4 2026 rollout, the Approve and run workflows gotcha that stalls re-runs, how billing works per session, and when to reach for the REST API instead."
pubDate: 2026-06-22
tags:
  - "github-copilot"
  - "ai-agents"
  - "github-actions"
  - "ci-cd"
  - "automation"
---

A red X on a GitHub Actions run used to mean opening the logs, scrolling to the failing step, reproducing it locally, and pushing a fix. As of mid-2026 there is a one-click shortcut: when a job fails, a **Fix with Copilot** button appears on the workflow run logs page. Click it and GitHub's Copilot cloud agent investigates the failure in its own hosted environment, pushes a fix to the branch, and tags you for review when it is done. This post covers exactly where the button lives, who can use it after the two-stage 2026 rollout, the re-run gotcha that quietly stalls the whole loop, how it bills, and when you should skip the button entirely and dispatch the agent from the API.

The feature shipped in two waves. It [landed for Copilot Business and Copilot Enterprise on May 18, 2026](https://github.blog/changelog/2026-05-18-one-click-fixes-for-failing-actions-with-copilot-cloud-agent/), then [opened to Copilot Pro, Pro+, and Max on June 4, 2026](https://github.blog/changelog/2026-06-04-fix-with-copilot-for-failing-actions-now-in-pro-pro-and-max/). It rides on the same Copilot coding agent that powers issue assignment and the cloud agent panel, so the model that does the work is the one your org has selected at dispatch time (the coding agent supports `claude-sonnet-4.6`, `claude-opus-4.6`, `gpt-5.3-codex`, and `gpt-5.4`, among others).

## What "Fix with Copilot" actually does

The button is not a linter quick-fix or an inline suggestion. It is a full delegation to the cloud agent, and it runs three steps in order:

1. **Investigate the failure.** The agent reads the failed job's logs, the workflow definition, and the relevant source. This is the same context-gathering a coding-agent session does, scoped to the failed run.
2. **Push a fix to your branch.** It does the work in its own cloud-based development environment, then commits the change to the branch the run was on (or opens a pull request from a fresh branch, depending on where the failure occurred).
3. **Tag you for review.** When it finishes it requests your review, so the change never lands silently. You approve, request changes, or close it like any other PR.

The sweet spot is exactly the work you least want to do by hand: a flaky or genuinely broken test, a linter or formatter failure, a dependency bump that needs a one-line call-site change, a misconfigured matrix entry, a missing environment variable in the workflow YAML. These are mechanical, well-bounded, and reproducible from the logs alone, which is precisely what the agent is good at.

## Where the button is, and the policy that gates it

The button shows up on the **workflow run logs page** of a failed run, which is the page you reach by clicking into a red check from a PR or from the **Actions** tab. You do not configure anything per repository to make it appear; if your account has Copilot coding agent access, GitHub surfaces it on eligible failures.

The one prerequisite is the coding agent itself. On **Business and Enterprise**, an organization or enterprise admin has to enable the Copilot coding agent policy before anyone on the org sees the button. That is the same toggle that controls issue-assigned agent tasks and the cloud agent panel, so if your team already assigns issues to Copilot, you are done. On **Pro, Pro+, and Max**, the agent is available to you directly and no admin step stands in the way.

If you have the right plan and the button is still missing, the failure is usually not eligible: the agent needs a branch it can write to and a repository where the coding agent is permitted. Pull requests from forks, for example, do not get a writable branch, so the button will not help there.

## The re-run gotcha that stalls the whole loop

This is the single most common way the flow appears broken when it is working as designed. **GitHub Actions do not run automatically on commits that the Copilot agent pushes.** This is a deliberate safety property, not a bug: bot-authored pushes are prevented from triggering workflows so an agent cannot kick off an infinite fix-fail-fix loop, and so untrusted automation cannot spend your Actions minutes unattended.

The practical effect is that after Copilot pushes its fix, your CI sits there showing the old red state. The checks you actually care about, the ones that would prove the fix worked, never start on their own. To run them you open the pull request and click **Approve and run workflows** in the merge box. Only then does CI re-execute against the agent's commit and turn green (or red, telling you the fix missed).

Build this into your habit: **Fix with Copilot, then review the diff, then Approve and run workflows, then read the re-run.** If you skip the approve step you will conclude the agent did nothing useful, when in fact the fix is sitting on the branch waiting for a human to let CI confirm it. This is the same guardrail that governs the [Agent Tasks REST API trigger](/2026/06/trigger-github-copilot-coding-agent-task-from-rest-api/), where the agent's PR also needs a human to release the workflows.

## A concrete walkthrough: a failing test job

Say your `test` job goes red because a refactor renamed `getUser()` to `fetchUser()` but one test still calls the old name. The run log shows the classic:

```text
FAIL  src/user.test.ts
  ● user service › returns the active user
    TypeError: getUser is not a function
      12 |   it("returns the active user", async () => {
    > 13 |     const u = await getUser(1);
         |               ^
Tests:       1 failed, 24 passed, 25 total
```

Open the failed run, click **Fix with Copilot**, and the agent spins up. A minute or two later you get a review request on a small PR:

```diff
--- a/src/user.test.ts
+++ b/src/user.test.ts
@@ -10,7 +10,7 @@ describe("user service", () => {
   it("returns the active user", async () => {
-    const u = await getUser(1);
+    const u = await fetchUser(1);
     expect(u.active).toBe(true);
   });
```

The diff is exactly what you would have typed. Now click **Approve and run workflows** so the `test` job re-runs against the new commit. When it comes back green, merge. The whole round trip is two clicks and one read of the diff, and you never left the browser. That is the entire value proposition: hand off the mechanical fix, keep your attention on the work you actually care about.

## Steering the agent before you click

You are not stuck with whatever the model guesses in isolation. The cloud agent reads your repository's custom instructions, so the same `.github/copilot-instructions.md` (and path-scoped `.github/instructions/*.instructions.md` files) that shape Copilot in your editor also shape the fix it writes here. If your project insists on a specific test runner, a formatting style, or "never touch the generated files in `src/gen/`," put that in the instructions file and the agent will respect it. (If those instructions seem to be ignored, the usual culprits are in [why Copilot ignores repository custom instructions](/2026/05/fix-github-copilot-ignores-repository-custom-instructions-in-vs-code/).)

What you cannot do from the button is type a freeform prompt. **Fix with Copilot** dispatches with an implicit "make this run pass" instruction and the failure context. When you need to say something more specific, such as "fix this by reverting the dependency, do not patch the call sites," that is your signal to drop down to one of the programmatic paths below.

## When to skip the button and dispatch from the API

The button is the right tool for an interactive, one-off failure you are looking at. It is the wrong tool for anything you want to systematize. Two alternatives cover that:

**The Agent Tasks REST API.** A `POST` to `/agents/repos/{owner}/{repo}/tasks` with a freeform `prompt` and a `base_ref` dispatches the same cloud agent with full control over the instruction. This is how you fan a fix out across many repositories, or wire "a failing nightly build files and fixes itself" into a scheduled job. The mechanics, the `X-GitHub-Api-Version: 2026-03-10` header, and the user-to-server token gotcha are covered in [triggering a Copilot coding agent task from the REST API](/2026/06/trigger-github-copilot-coding-agent-task-from-rest-api/).

**A GitHub Agentic Workflow.** If you want the fix loop to live in the repo as code rather than a button someone remembers to press, a `gh-aw` workflow can watch for `workflow_run` failures and dispatch the agent automatically, now running on the built-in `GITHUB_TOKEN` with no PAT to rotate, as described in [GitHub Agentic Workflows without a personal access token](/2026/06/github-agentic-workflows-without-a-personal-access-token/). This is the natural home for the older do-it-yourself pattern of "open an issue on CI failure and assign it to Copilot," except you no longer hand-roll the GraphQL assignment call.

The decision is about repeatability. One red run in front of you: click the button. A class of failures you want handled the same way every time: codify it. The same scheduling instinct that drives [a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) applies here, just pointed at the Copilot cloud agent instead of a local CLI.

## What it costs and what it will not fix

Each Copilot coding agent session counts as **one premium request**, regardless of how many tool calls and commits the agent makes inside that session. [GitHub confirmed the one-request-per-session model](https://github.com/orgs/community/discussions/165798) when it stopped billing the agent's autonomous tool calls separately, so a Fix with Copilot run is priced like a single prompt. Plans ship a monthly allotment of premium requests (Pro historically included 300), and 2026 is moving the underlying meter toward usage-based GitHub AI Credits, so check your current plan's allowance rather than assuming a fixed cap. Either way the cost model is "one fix attempt, one unit," which makes the button cheap for the small failures it targets.

The limits are the limits of the model, not the button. The agent shines on the bounded, reproducible failures listed above and struggles with the rest: a bug whose root cause is several files and a data-flow away from the failing assertion, a flaky test that fails for an environmental reason the logs do not show, an outage in a service the job depends on, or anything that needs product judgment rather than a mechanical correction. Because the model is non-deterministic, the same failure can produce a good fix on one attempt and a wrong one on the next, which is exactly why the agent requests review instead of pushing straight to `main`. Treat the fix as a draft from a fast junior, not a verified patch: read the diff, then let CI prove it with **Approve and run workflows**.

For the bigger picture of how this agent fits next to the others you might run in CI, see [where Claude Code, Cursor, and Copilot agent mode each win](/2026/06/claude-code-vs-cursor-vs-copilot-agent-mode-where-each-wins/) and [running Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/). The button is the lowest-friction door into a much larger set of agent-in-CI patterns, and it is the right place to start because it costs you nothing but a click to see whether the agent can carry the boring half of your red builds.

Sources: [Fix with Copilot for failing Actions now in Pro, Pro+, and Max](https://github.blog/changelog/2026-06-04-fix-with-copilot-for-failing-actions-now-in-pro-pro-and-max/), [One-click fixes for failing Actions with Copilot cloud agent](https://github.blog/changelog/2026-05-18-one-click-fixes-for-failing-actions-with-copilot-cloud-agent/), and the [GitHub community discussion on per-session premium request billing](https://github.com/orgs/community/discussions/165798).
