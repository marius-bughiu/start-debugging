---
title: "How to Trigger a GitHub Copilot Coding Agent Task from the Agent Tasks REST API"
description: "POST a prompt to /agents/repos/{owner}/{repo}/tasks and Copilot's cloud agent spins up, writes code, and opens a PR. Here is the exact request, the X-GitHub-Api-Version: 2026-03-10 header, the user-to-server token gotcha that breaks GitHub App installs, a polling loop over the eight task states, and a fan-out script that dispatches the same migration across many repos."
pubDate: 2026-06-21
tags:
  - "github-copilot"
  - "ai-agents"
  - "rest-api"
  - "automation"
  - "ci-cd"
---

You can now hand GitHub's Copilot cloud agent a task without ever opening the web UI or assigning an issue. As of June 4, 2026, the Agent Tasks REST API is in public preview for Copilot Pro, Pro+, and Max (it landed for Business and Enterprise on May 13, 2026). One `POST` to `/agents/repos/{owner}/{repo}/tasks` with a `prompt` body, and the agent spins up in its own cloud environment, makes and validates changes, and opens a pull request you can review like any other. This post shows the exact request, the headers that actually matter, the token type that silently breaks automation, and a polling loop you can drop into a script or a GitHub Action.

Everything below uses API version `2026-03-10` (the value of the `X-GitHub-Api-Version` header for the `agents/*` endpoints) against `api.github.com`. The agent supports several models at dispatch time, including `claude-sonnet-4.6`, `claude-opus-4.6`, `gpt-5.3-codex`, and `gpt-5.4`. The endpoints are in public preview and the shapes can change, so pin the version header and do not assume the response schema is frozen.

## Why a REST trigger changes what you can build

Until this API shipped, kicking off the Copilot coding agent meant a human action: assign an issue to Copilot, or type a prompt into the agents panel. That is fine for one-off work and useless for automation. The REST trigger turns the agent into a dispatchable worker. The three use cases GitHub calls out in the [June 4 changelog](https://github.blog/changelog/2026-06-04-agent-tasks-rest-api-now-available-for-copilot-pro-pro-and-max/) are the obvious ones: fan a refactor or dependency bump out across dozens of repositories from a loop, wire "scaffold a new service" into your internal developer portal so a button press opens a ready-to-review PR, and schedule a weekly job that drafts the release notes and the version bump.

The mental model is a job queue. You enqueue a task with a natural-language prompt and a base branch, you get back a task `id` and a `state` of `queued`, and you poll until the agent reaches a terminal state. The work itself runs in a GitHub Actions environment on GitHub's side, so your script does nothing but dispatch and watch. If you have already wired up [a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/), this is the same scheduling instinct pointed at Copilot's hosted agent instead of a local CLI.

## The one request that starts a task

Here is the minimal call. It dispatches a task against `main` and lets the agent open a pull request when it is done.

```bash
# GitHub Agent Tasks REST API, public preview, X-GitHub-Api-Version: 2026-03-10
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  -H "Authorization: Bearer $GH_USER_TOKEN" \
  https://api.github.com/agents/repos/OWNER/REPO/tasks \
  -d '{
    "prompt": "Replace every direct call to fetch() in src/ with the new ApiClient wrapper, keep behaviour identical, and add a test for the error path.",
    "base_ref": "main",
    "create_pull_request": true
  }'
```

The request body has one required field and a handful of optional ones:

- `prompt` (string, required): the task description. Treat this like the prompt you would give a careful junior engineer who cannot ask you a follow-up question. Name the files, name the constraints, and tell it what "done" looks like.
- `base_ref` (string, optional): the branch the agent starts from. Defaults to the repository's default branch if omitted, but set it explicitly so a script reading from config is never surprised.
- `head_ref` (string, optional): the branch the agent commits onto. Leave it unset and the agent picks a fresh branch name.
- `create_pull_request` (boolean, optional, default `false`): whether the agent opens a PR at the end. If you set this to `false` you get a branch with commits and no PR, which is handy when a later step in your automation opens the PR with its own template.
- `model` (string, optional): which model runs the task. Omit it to use the account default. Cheaper, faster models cost fewer premium requests per task, so for low-complexity mechanical edits it is worth dropping down a tier; save `claude-opus-4.6` or `gpt-5.4` for tasks where reasoning depth actually changes the diff.

A successful dispatch returns the task object immediately, before any work has happened:

```json
{
  "id": "f3a9c2e1-7b44-4d0a-9c2f-1e8b6d4a0f21",
  "state": "queued",
  "created_at": "2026-06-21T09:14:02Z",
  "updated_at": "2026-06-21T09:14:02Z"
}
```

Grab the `id`. That is the handle for everything else.

## The token gotcha that breaks GitHub App automation

This is the detail that will cost you an afternoon if you skip it. The Agent Tasks API **only accepts user-to-server tokens**. Concretely:

- A classic or fine-grained personal access token works.
- An OAuth app token works.
- A GitHub App **user-to-server** token (the one you get after a user authorizes your App) works.
- A GitHub App **installation access token** does **not** work. This is the server-to-server token most bots use, and it returns an auth error against these endpoints.

If your automation runs as a GitHub App, you cannot use the installation token you would normally mint for `contents` or `pull_requests`. You need a token that carries a user identity, because every task is attributed to a real account and counts against that account's Copilot entitlement. The same constraint is why this differs from the no-token GitHub Actions flow I covered in [automating a repository task with GitHub Agentic Workflows without a personal access token](/2026/06/github-agentic-workflows-without-a-personal-access-token/): Agentic Workflows let the built-in `GITHUB_TOKEN` drive Copilot inside an Action, but the Agent Tasks API is a direct dispatch and wants a user token.

For a fine-grained PAT, grant the **"Agent tasks"** repository permission: read is enough for the `GET` endpoints, read and write is required for the `POST` that starts a task. Scope it to only the repositories you intend to dispatch against. Store it as a secret, never inline it, and rotate it on the same cadence as any other write-capable credential.

## Polling the eight task states

Once the task is `queued`, you watch it move through its lifecycle. The `state` field is an enum with eight values:

| State | Meaning |
| --- | --- |
| `queued` | Accepted, waiting for a runner. |
| `in_progress` | The agent is actively working. |
| `completed` | Finished successfully; a PR or branch exists. |
| `failed` | The agent errored out. |
| `idle` | Spun up but not currently doing work. |
| `waiting_for_user` | Blocked on input, for example a question or a permission. |
| `timed_out` | Exceeded its time budget. |
| `cancelled` | Stopped by a user or another caller. |

The terminal states are `completed`, `failed`, `timed_out`, and `cancelled`. `waiting_for_user` is the sneaky one: it is not terminal, but a headless script has no human to answer, so you should treat it as "needs attention" and stop polling rather than spinning forever.

Fetch a single task by id with the repo-scoped endpoint:

```bash
# Poll one task by id
curl -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  -H "Authorization: Bearer $GH_USER_TOKEN" \
  https://api.github.com/agents/repos/OWNER/REPO/tasks/$TASK_ID
```

There is also `GET /agents/tasks/{task_id}` to fetch a task without knowing its repo, `GET /agents/repos/{owner}/{repo}/tasks` to list a repository's tasks, and `GET /agents/tasks` to list every task you have started across all repos. The last one is what you want for a dashboard.

Here is a self-contained poller in Python that dispatches a task and waits for a terminal state, backing off so you do not hammer the API:

```python
# Python 3.11, GitHub Agent Tasks REST API (public preview), api version 2026-03-10
import os, time, requests

API = "https://api.github.com"
OWNER, REPO = "acme", "billing-service"
HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    "Authorization": f"Bearer {os.environ['GH_USER_TOKEN']}",
}
TERMINAL = {"completed", "failed", "timed_out", "cancelled"}
STOP = TERMINAL | {"waiting_for_user"}  # waiting_for_user needs a human

def start_task(prompt: str, base_ref: str = "main") -> str:
    r = requests.post(
        f"{API}/agents/repos/{OWNER}/{REPO}/tasks",
        headers=HEADERS,
        json={"prompt": prompt, "base_ref": base_ref, "create_pull_request": True},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["id"]

def wait(task_id: str, every: int = 15, cap: int = 1800) -> dict:
    deadline = time.monotonic() + cap
    while time.monotonic() < deadline:
        r = requests.get(
            f"{API}/agents/repos/{OWNER}/{REPO}/tasks/{task_id}",
            headers=HEADERS, timeout=30,
        )
        r.raise_for_status()
        task = r.json()
        if task["state"] in STOP:
            return task
        time.sleep(every)
    raise TimeoutError(f"task {task_id} did not finish within {cap}s")

if __name__ == "__main__":
    tid = start_task("Bump the lockfile to resolve the CVE in the http client and run the test suite.")
    final = wait(tid)
    print(f"task {tid} ended in state: {final['state']}")
```

A few things worth knowing about that loop. Always send a request timeout (`timeout=30` here) so a hung connection cannot wedge the whole job. Keep the poll interval at 15 seconds or more; the agent runs for minutes, not milliseconds, and a one-second loop just burns rate limit. And give the wait a hard ceiling (`cap=1800`, thirty minutes) so a stuck task never blocks your pipeline indefinitely. If you are dispatching from inside CI, this is the same defensive posture you would apply to any long-running [scheduled LLM job where the queue can back up](/2026/06/hangfire-vs-quartz-net-vs-ihostedservice-for-scheduled-llm-jobs/).

## Finding the pull request the agent opened

When a task with `create_pull_request: true` reaches `completed`, the agent has pushed a branch and opened a PR. The task object carries `artifacts` and `sessions` arrays that describe what it produced and the steps it took. In practice the fastest way to surface the PR in automation is to list pull requests filtered by the head branch the agent used, or to read the linked resources on the completed task. If you let the agent pick its own `head_ref`, list the repo's open PRs and match on the one created at the task's `updated_at`:

```bash
# Find the PR the agent just opened
curl -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GH_USER_TOKEN" \
  "https://api.github.com/repos/OWNER/REPO/pulls?state=open&sort=created&direction=desc&per_page=5"
```

From there it is an ordinary pull request. Your existing required checks, branch protection, and review rules all apply, which is the whole point: the agent does not get to merge anything, it just gets you to a reviewable diff. If you have a downstream reviewer agent, this is a clean handoff point, the same way [a Cursor cloud agent hands a Jira ticket back as a PR](/2026/05/how-to-assign-a-jira-ticket-to-a-cursor-cloud-agent-and-get-a-pr-back/) for a human to land.

## Fanning a migration out across many repos

The dispatch-and-poll shape is what makes the "fan out a refactor across repositories" use case real. Because each task is independent and runs on GitHub's infrastructure, you can dispatch many at once and collect the PRs as they land. Here is the skeleton:

```python
# Fan out the same task across repos, then wait on all of them
REPOS = ["acme/web", "acme/api", "acme/worker", "acme/admin"]
PROMPT = ("Migrate the logging calls from the deprecated log4x API to the new "
          "structured Logger.forContext() pattern. Do not change log levels.")

dispatched = []
for full in REPOS:
    owner, repo = full.split("/")
    r = requests.post(
        f"{API}/agents/repos/{owner}/{repo}/tasks",
        headers=HEADERS,
        json={"prompt": PROMPT, "base_ref": "main", "create_pull_request": True},
        timeout=30,
    )
    r.raise_for_status()
    dispatched.append((full, r.json()["id"]))
    print(f"dispatched {full} -> {r.json()['id']}")

# Poll each to a terminal state (sequential here; parallelise with a thread pool).
for full, tid in dispatched:
    owner, repo = full.split("/")
    # reuse wait() with the right OWNER/REPO, omitted for brevity
```

Two things keep this from going wrong at scale. First, every task consumes premium requests against the dispatching user's Copilot plan, so a hundred-repo fan-out is a hundred agent runs you are paying for; meter it and pick a cheaper `model` for mechanical edits. Second, dispatch is not idempotent. If your script retries a failed `POST` blindly, you can start the same task twice and get two competing PRs. Record the returned task `id` before you retry anything, and check the repo's existing tasks with `GET /agents/repos/{owner}/{repo}/tasks` before dispatching a duplicate.

## Where this fits, and where it does not

Reach for the Agent Tasks API when you want to dispatch work programmatically and review the result as a PR: portal-driven scaffolding, scheduled maintenance, cross-repo migrations, anything where a human still approves the merge. Do not reach for it when you need the agent to answer interactively or iterate in a tight loop with a developer, that is what the in-IDE and web experiences are for, and do not reach for it from a pure server-to-server bot, because the installation-token restriction will stop you cold.

The endpoints are in public preview, so wrap your client in a thin layer you can update when the response schema shifts, and keep the `X-GitHub-Api-Version: 2026-03-10` header pinned so a future default version change does not silently alter behaviour. The hard parts are the two you would not guess from the happy-path docs: use a user-to-server token, and treat `waiting_for_user` as a stop condition. Get those right and the rest is a job queue you already know how to operate.

## Related reading

- [How to automate a repository task with GitHub Agentic Workflows without a personal access token](/2026/06/github-agentic-workflows-without-a-personal-access-token/)
- [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)
- [How to assign a Jira ticket to a Cursor cloud agent and get a PR back](/2026/05/how-to-assign-a-jira-ticket-to-a-cursor-cloud-agent-and-get-a-pr-back/)
- [Hangfire vs Quartz.NET vs IHostedService for scheduled LLM jobs](/2026/06/hangfire-vs-quartz-net-vs-ihostedservice-for-scheduled-llm-jobs/)

## Sources

- [Agent tasks REST API now available for Copilot Pro, Pro+, and Max - GitHub Changelog, June 4, 2026](https://github.blog/changelog/2026-06-04-agent-tasks-rest-api-now-available-for-copilot-pro-pro-and-max/)
- [Start Copilot cloud agent tasks via the REST API - GitHub Changelog, May 13, 2026](https://github.blog/changelog/2026-05-13-start-copilot-cloud-agent-tasks-via-the-rest-api/)
- [REST API endpoints for agent tasks - GitHub Docs](https://docs.github.com/en/rest/agent-tasks/agent-tasks)
- [Using Copilot cloud agent via the API - GitHub Docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api)
