---
title: "How to Split a Long-Running Task Across Agents with a Cursor Projects Coordinator and Shared Context Files"
description: "A practical setup for Cursor Projects: prepare the repo so every worker starts warm, seed the Project's shared Context with a plan, conventions and a slice ledger, cut the work into disjoint PR-sized slices, and let subscriptions keep it moving. Covers Cursor 3.24, plan and admin gates, and the gotchas of a Context that lives outside git."
pubDate: 2026-10-15
template: how-to
tags:
  - "cursor"
  - "ai-agents"
  - "cloud-agents"
  - "subagents"
  - "automation"
---

**Short answer:** create a Project from the Projects section of Cursor's Agents Window (Cursor 3.24, Projects beta since September 10, 2026), pick the repository and the coordinator's model, and make the first message research only: ask the coordinator to have agents study the codebase and write a plan, a conventions file, a how-to-test file and a slice ledger into the Project's shared Context. Then let it cut the work into slices that touch disjoint files and land as one PR each, review the first few PRs closely, and push every correction into the conventions file so the next worker inherits it. Subscriptions (follow PRs, CI, a schedule) keep the Project moving while you are away.

The reason this needs a recipe at all is that a Project is not "a bigger chat". The coordinator does not write code. Per the [Projects docs](https://cursor.com/docs/agent/projects), it "plans the work, delegates it to agents that write the code, and brings the finished work back to you to check". Every worker it starts is a fresh cloud agent with no memory of the previous one. The only things that carry across workers are the repository and the Project's shared files. If those two are thin, you pay the cold-start cost on every slice, and a migration of a few hundred files becomes a few hundred slightly different interpretations of what you asked for.

## What a Project actually gives you, in Cursor 3.24

Three pieces matter for splitting work, and the [launch post](https://cursor.com/blog/projects) names all of them:

- **The coordinator.** One long-lived conversation you talk to. It creates workers, runs as many in parallel as the work needs, reviews what they return, and stays responsive because it never blocks on a build.
- **Workers.** Cloud agents, each on its own VM with its own clone. When something has to run on your machine, the coordinator starts a local agent instead. Since 3.24 you can also drag an existing local agent onto a Project, and it becomes a worker over Remote Control without losing its conversation.
- **Shared Context.** A set of files that "sync across every cloud and local machine its agents use". The September 14 week release notes made this precise: "Cloud workers that a Project coordinator creates now use the coordinator's Context as their own, so files they save there are visible across the Project."

The recent [release notes](https://cursor.com/docs/release-notes) add a few things that change how you coordinate. The coordinator can switch a worker's model when it messages it. It can rename a worker it reassigns. Since the week of October 5, it can read and message any agent you @-mention to it, and a worker can message its parent coordinator back. In 3.24 it also reports a live status line for the step it is on.

Availability is gated in four places, and you will hit at least one of them on a team account:

1. **Plan.** Projects needs Cloud Agents: Premium and higher, Teams, Enterprise, or a legacy paid plan. Not Free, Plus or legacy Hobby.
2. **Privacy Mode (Legacy)** blocks it, because cloud agents store code in the cloud while they run.
3. **Team switch.** Admins have an **Enable Projects** switch under Team Settings > Chat. When it is off, creating a Project fails with "Projects are disabled for your team."
4. **Enterprise version floor.** Enterprise teams get Projects from Cursor 3.21.9.

## The scenario: one migration, about 180 call sites, four packages

Here is the job I use as the running example. A TypeScript monorepo has a hand-written `apiFetch()` wrapper used in roughly 180 places across `packages/web`, `packages/admin`, `packages/mobile-shared` and `packages/jobs`. The goal is to replace it with a client generated from the OpenAPI spec, then delete the wrapper.

This is exactly the shape the Cursor team calls out: "easy to start and difficult to finish". The first ten call sites are fun. Call sites 60 to 180 are where a single agent loses the thread, a human loses interest, and conventions drift because nobody remembers what was decided about error handling in week one.

## Step 1: make the repository carry the rules a worker cannot ask about

Workers start cold. Anything every worker needs, regardless of which slice it gets, belongs in the repository, because the repository is versioned, reviewed and shared with every tool, not only Cursor. Three files do most of the work.

An `AGENTS.md` at the root with the non-negotiables. Cursor reads it automatically, and so do most other agents, which I covered in [migrating `.cursorrules`, `CLAUDE.md` and Copilot instructions to one AGENTS.md](/2026/09/migrate-cursorrules-claude-md-copilot-instructions-to-one-agents-md/):

```markdown
<!-- AGENTS.md, read by Cursor 3.24 local and cloud agents -->
# Repo rules

- Package manager is pnpm 10. Never run npm or yarn.
- Run `pnpm -F <package> test` and `pnpm -F <package> typecheck` before opening a PR.
- Never edit files under `packages/*/generated/`. Regenerate with `pnpm gen:api`.
- One PR per task. Title format: `<package>: <what changed>`.
- Do not touch `packages/legacy-billing/` under any circumstances.
```

A `.cursor/environment.json` so that a worker's VM is ready to build and test without spending its first ten minutes on installs. The schema is in the [cloud agent setup docs](https://cursor.com/docs/cloud-agent/setup); since the week of October 5, comments and trailing commas are accepted everywhere the file is read:

```jsonc
// .cursor/environment.json, Cursor 3.24 Cloud Agents
{
  "build": {
    "dockerfile": "Dockerfile",
    "context": ".."
  },
  // runs on every worker VM before its first turn
  "install": "pnpm install --frozen-lockfile && pnpm gen:api"
}
```

If a cold start still takes minutes, prebuilt environments help more than anything you can put in a prompt; see [cutting Cursor cloud agent startup time with Builds](/2026/08/how-to-cut-cursor-cloud-agent-startup-time-with-builds/). With dozens of workers, the startup cost is multiplied by the slice count.

And a read-only verifier subagent in `.cursor/agents/`. Cloud agents support [subagents](https://cursor.com/docs/subagents), so each worker can hand its finished slice to a reviewer that cannot edit anything, before the PR reaches the coordinator:

```markdown
---
# .cursor/agents/slice-verifier.md, Cursor 3.24 custom subagent
name: slice-verifier
description: Verifies one migration slice before its PR is opened. Use after finishing a slice.
model: inherit
readonly: true
---

You verify a single slice of the apiFetch -> generated client migration.

1. List every file changed on this branch. Fail if any file is outside the slice's
   file list in the task prompt.
2. Grep the changed files for `apiFetch(`. Fail if any remain.
3. Run the package's typecheck and tests. Fail on any error.
4. Check error handling matches the "Errors" section of conventions.md in the
   Project Context.

Reply with PASS or FAIL and a bullet list of reasons. Do not suggest refactors.
```

`readonly: true` matters. A verifier that can "just fix it" turns into a second implementer, and then two agents are editing the same branch.

## Step 2: create the Project and spend the first turn on research

In the Agents Window, open **Projects** in the sidebar, click **New Project**, name it after the outcome (`apiFetch removal`, not the repo name), pick the repository under **Workspace**, and the coordinator's model under **Model**. Pick a strong planning model for the coordinator. It reads more than it writes, and the coordinator can move individual workers to cheaper models later.

The first message decides how good every later worker is. Do not ask for code yet:

```text
# Cursor 3.24, Projects beta, first message to the coordinator

Goal: replace every call to apiFetch() with the generated client from
packages/api-client, then delete packages/web/src/lib/apiFetch.ts.

Do not change any code yet. First, have agents research and write these
files into the Project's shared Context:

- plan.md: the migration approach, the order of packages, and why.
- conventions.md: exactly how a call site is rewritten, including error
  handling, retries, auth headers and request cancellation. Include one
  before/after example per pattern you find.
- how-to-test.md: the exact commands to build, typecheck and test each
  package, and anything that needs a local machine.
- ledger.md: a table of slices (see format below), all "todo".

Slice rules: each slice touches 5 to 15 call sites in ONE package, no two
slices share a file, and no slice touches packages/legacy-billing.

Ledger columns: slice | package | files | status | worker | PR

Stop when the four files exist and ask me to review conventions.md.
```

Two decisions in that prompt carry most of the weight. The files have fixed names, so every worker prompt can say "read conventions.md and how-to-test.md first" and mean something specific. And the ledger is the coordinator's source of truth, not its conversation history. Cursor has not documented how a Project's thread is compacted over months, so anything the coordinator must not forget belongs in a file, not in a message from three weeks ago.

## Step 3: cut slices that cannot collide

Parallel workers fail in one predictable way: two of them edit the same file, both PRs pass CI on their own, and the second one conflicts. The cure is in the slicing, not in the agents.

Here is what a healthy ledger looks like after the research turn:

```markdown
<!-- ledger.md, Project Context, written by the coordinator -->
| slice | package        | files                                         | status | worker   | PR    |
|-------|----------------|-----------------------------------------------|--------|----------|-------|
| W-01  | web            | src/pages/orders/*.tsx (6 files, 11 calls)    | todo   |          |       |
| W-02  | web            | src/pages/account/*.tsx (4 files, 9 calls)    | todo   |          |       |
| A-01  | admin          | src/users/** (7 files, 14 calls)              | todo   |          |       |
| J-01  | jobs           | src/sync/*.ts (3 files, 8 calls)              | todo   |          |       |
| X-99  | web            | src/lib/apiFetch.ts (delete)                  | blocked: all others merged |  |  |
```

The rules I give the coordinator, and that I check in the ledger before saying go:

- **Disjoint file sets.** No file appears in two slices. Shared helpers get their own slice that runs first.
- **One package per slice.** CI, tests and reviewers stay scoped.
- **Small PRs.** Five to fifteen call sites keeps a PR reviewable in a few minutes, which matters when the Cursor blog's own design-system Project lands 20 to 100 PRs a day.
- **Explicit dependencies.** The deletion slice is `blocked` until everything else is merged.

Then tell the coordinator to start with three slices only, from three different packages. You want to see the conventions applied in three contexts before you scale to twenty parallel workers.

## Step 4: review the first PRs and write every correction into Context

This is the part that turns a Project from "many agents" into "agents that get better". When you review the first three PRs, every comment you would normally leave on a PR goes to the coordinator instead, phrased as a rule:

```text
# Cursor 3.24, follow-up to the coordinator after reviewing W-01, A-01, J-01

Two corrections. Add both to conventions.md under "Errors" and "Cancellation",
then tell the W-01 and A-01 workers to apply them to their open PRs:

1. Do not wrap generated-client calls in try/catch just to rethrow. Let
   ApiError propagate; only catch where the old code showed a toast.
2. Every call inside a React effect must pass the AbortSignal from the
   effect's controller. J-01 is fine because jobs have no effects.

After that, start up to 8 slices in parallel. Keep my review on every PR
until 10 in a row merge without changes from me.
```

That last line is the Cursor team's own migration advice put into a rule the coordinator can follow: review closely early, review less as the fixes hold up. Since the coordinator can message workers directly, it can push the correction to slices already in flight instead of waiting for you to request changes on each PR.

The same loop works for `how-to-test.md`. When one worker figures out that `packages/mobile-shared` tests need `TZ=UTC`, it should write that down, and every later worker gets it for free. That is the docs' own example: "If one agent figures out how to test a service, every future agent can use those instructions."

## Step 5: let subscriptions keep it moving

A migration that runs for two weeks should not need you to say "continue" every morning. Tell the coordinator what to watch and it creates [subscriptions](https://cursor.com/docs/cloud-agent/capabilities); a **Listening** pill appears above the chat input listing them:

```text
# Cursor 3.24, subscriptions for the migration Project

Follow every PR you open in this repo. When CI fails, send the owning worker
back to fix it. When I approve and merge one, mark the slice "merged" in
ledger.md and start the next "todo" slice.

Also, every weekday at 08:00, post a summary in this chat: slices merged
yesterday, slices in review, slices blocked and why.
```

The subscription rules from the docs that bite during long migrations:

- A subscription lasts at most **180 days**. A migration that outlives that needs it re-created.
- Bursts coalesce. Ten CI results landing together can wake the coordinator once, and it re-reads the source before acting, so the ledger must be idempotent to update.
- A CI subscription waits for **every** check on the commit. One check that stays pending, such as a manual approval, holds back the whole result. Finish those with GitHub's `action_required` conclusion instead of leaving them pending.
- Subscriptions need an agent a person owns. Agents running as a service account do not get the subscription tools.

## Gotchas when the Context lives outside git

The shared Context is what makes this work, and it is also the least documented part. Cursor does not say where the files are stored, what format constraints apply, or how large they can get. In [Flavio Copes' walkthrough](https://flaviocopes.com/cursor-projects/), the coordinator saved his product spec as `docs/project-context.md` in the Project pane, which tells you the files are plain markdown you can read. Treat the rest as unknown and plan around it:

- **No history, no review.** Context edits do not go through a PR. If a worker writes a wrong rule into `conventions.md`, every later worker follows it. Skim the conventions file every few days, the same way you skim the ledger.
- **Promote durable rules to the repo.** Once a convention has held for a week, have a worker open a PR that moves it into `AGENTS.md` or a project rule. The Context is scoped to the Project; the repo outlives it.
- **Keep secrets out.** Agents write "what they learn" into Context, which can include connection strings they found in a `.env`. Say in `AGENTS.md` that credentials never go into notes.
- **Moving a worker out of the Project gives it its own Context again.** It stops seeing `conventions.md` from that point on.
- **Placement permissions.** The **Automatically allow Projects to place their work** setting decides whether workers can start on any machine, environment or repository the Project owner can reach without asking. It defaults to off for Enterprise teams and on for everyone else. Check it before you point a Project at a repo with production access.
- **Named self-hosted machines change the repo.** When the coordinator starts a worker on one specific [self-hosted machine](/2026/09/how-to-keep-cursor-agent-tool-execution-inside-your-own-network/), the worker uses the repository registered on that machine, not the Project's. Targeting a pool instead of a machine returns an error.
- **Nesting has a limit.** If a worker that delegates to its own subagents cannot be created, the coordinator now receives the real reason, such as hitting the nesting limit. Keep the tree shallow: coordinator, workers, and one read-only verifier level is enough. I went through the trade-offs in [nested subagent depth](/2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens/).
- **Cost scales with parallelism.** Cloud agents bill at API pricing for the selected model, and the context window size you pick increases usage. Twenty parallel workers on a frontier model is twenty frontier-model bills. Let the coordinator put mechanical slices on a cheaper model once the conventions are stable.
- **No side chats inside a Project.** Projects use threads instead. If you want to ask something without interrupting the coordinator, open a thread on the Project rather than looking for `/side`.

## When a Project is the wrong tool

A Project is for work that outlives a chat: a feature with several PRs, a migration, or a gardening job on a schedule. For a single long objective on one branch, a cloud agent with [a `/goal`](/2026/09/how-to-give-a-cursor-cloud-agent-a-long-lived-objective-with-goal/) is simpler and cheaper, because there is no coordinator layer to pay for. And if the work cannot be cut into slices with disjoint files, parallel workers will spend more time resolving each other's conflicts than writing code. In that case run it as one agent with subagents for research, which is the model I compared in [Cursor subagents vs Claude Code subagents](/2026/07/cursor-subagents-vs-claude-code-subagents/).

The pattern that makes a Project pay off is boring on purpose: rules that never change go in the repo, rules that are still being learned go in Context, the ledger is the source of truth, and every review comment becomes a rule instead of a one-off fix.

### Read next

- [How to give a Cursor cloud agent a long-lived objective with /goal](/2026/09/how-to-give-a-cursor-cloud-agent-a-long-lived-objective-with-goal/)
- [How to cut Cursor cloud agent startup time with prebuilt Builds](/2026/08/how-to-cut-cursor-cloud-agent-startup-time-with-builds/)
- [Migrate .cursorrules, CLAUDE.md and Copilot instructions to one AGENTS.md](/2026/09/migrate-cursorrules-claude-md-copilot-instructions-to-one-agents-md/)
- [Nested subagent depth: when it helps and when it burns tokens](/2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens/)
- [Cursor subagents vs Claude Code subagents](/2026/07/cursor-subagents-vs-claude-code-subagents/)

### Sources

- [Cursor docs: Projects](https://cursor.com/docs/agent/projects)
- [Cursor blog: Introducing Projects (September 10, 2026)](https://cursor.com/blog/projects)
- [Cursor changelog: Projects](https://cursor.com/changelog/projects)
- [Cursor release notes (3.24, weeks of September 14 and October 5)](https://cursor.com/docs/release-notes)
- [Cursor docs: Cloud agent capabilities and subscriptions](https://cursor.com/docs/cloud-agent/capabilities)
- [Cursor docs: Subagents](https://cursor.com/docs/subagents)
- [Cursor docs: Cloud agent setup and environment.json](https://cursor.com/docs/cloud-agent/setup)
