---
title: "A Coordinator Agent Plus Worker Agents for Multi-Day Projects"
description: "A coding agent loses its context every session, so a project that runs for days needs its memory in the repository. Make the coordinator a small script and a JSON ledger, run every worker as a fresh `claude -p` session in its own git worktree with a hard scope and budget, and have the coordinator verify and merge the work itself. Tested with a stub worker; flags pinned to Claude Code 2.1.310."
pubDate: 2026-11-02
template: how-to
tags:
  - "ai-agents"
  - "claude-code"
  - "subagents"
  - "automation"
  - "patterns"
  - "headless"
---

**Short answer:** for a project that runs for days, don't make the coordinator a long-lived LLM conversation. Make it a small script that owns three files in the repo: `agents/plan.md` (the goal, written once with a human), `agents/tasks.json` (a ledger of small tasks, each with a file scope, dependencies and a verify command), and `agents/progress.md` (an append-only log). On each scheduled tick the script claims the next runnable task. It starts one fresh worker (`claude -p` in Claude Code 2.1.310, `claude-sonnet-5-5` via the `sonnet` alias) in its own git worktree, with a turn cap, a dollar cap and a JSON report schema. Then it **checks the work itself**: diff inside the scope, clean tree, verify command exits 0. It merges or retries, and commits the ledger. The model does the coding. Plain code holds the memory, the scheduling and the judgement of "done".

## Why the coordinator should not be a model

The usual first try is to give one strong model a big goal, tell it to spawn subagents, and let it run. That works for an afternoon. Over three days it breaks in predictable ways, and Anthropic's own write-up on [effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) lists most of them. The agent tries to one-shot the whole thing and runs out of context with a feature half done. A later session sees a lot of progress and declares the job finished. A feature gets marked complete because a unit test passed, even though it never worked end to end.

Every one of those failures is a model judging its own state. The coordinator's job is mostly bookkeeping: what is left, what is in flight, what failed and why, how much money went out today. Bookkeeping is what a 150-line script does perfectly and a context window does badly. So the split in this post is:

- **Planner** (a model, run rarely, with a human): turns the goal into `plan.md` and a first `tasks.json`.
- **Coordinator** (a script, run every 30 minutes by cron or launchd): picks a task, starts a worker, verifies, merges, logs.
- **Workers** (a model, one fresh session per task): read the plan, do one task inside its scope, commit, report.

This is still the orchestrator-worker pattern Anthropic describes in [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system). The difference is that the orchestrator's memory lives in git instead of a context window. That same post makes two points worth keeping in mind. Multi-agent runs used about 15x the tokens of a chat. And "most coding tasks involve fewer truly parallelizable tasks than research". So the default below runs one worker at a time and leaves parallelism as an option.

## The state that carries across days

The scenario I'll use: moving an Express 4 API of about 60 route files to Express 5 and a new validation layer. That is too big for one session, and the slices split cleanly by router.

The ledger is JSON on purpose. The harness article says Anthropic settled on JSON for the feature list because the model "is less likely to inappropriately change or overwrite JSON files compared to Markdown files". In this design the workers aren't allowed to touch it at all, and the coordinator enforces that (more below).

```json
{
  "tasks": [
    {
      "id": "T-01",
      "description": "Upgrade express to 5.x in package.json and fix the app bootstrap in src/app.js",
      "scope": ["package.json", "package-lock.json", "src/app.js"],
      "verify": "npm test -- --run src/app.test.js",
      "status": "todo"
    },
    {
      "id": "T-02",
      "description": "Port src/routes/users/* to Express 5 path syntax and the zod validators in src/validation/users.js",
      "scope": ["src/routes/users/*", "src/validation/users.js", "test/routes/users/*"],
      "verify": "npm test -- --run test/routes/users",
      "depends_on": ["T-01"],
      "status": "todo",
      "model": "sonnet"
    }
  ],
  "runs": [],
  "inbox": []
}
```

Four fields do the real work:

- **`scope`** is a list of globs, and it is the most important field. It is how two tasks avoid colliding. It is also how the coordinator catches a worker that "helpfully" refactors a shared helper. If a task honestly needs a file outside its scope, that is a planning bug. The worker should report `blocked` so the scope gets fixed, rather than quietly widening it.
- **`verify`** is a shell command the coordinator runs, not the worker. "Done" means this exits 0 on the worker's branch. If you can't write a verify command for a task, the task is too vague to hand to an unattended agent.
- **`depends_on`** keeps the order honest without needing a model to reason about order.
- **`model`** lets you send a mechanical slice to Haiku and a gnarly one to Opus. My [Haiku vs Sonnet vs Opus comparison for subagents](/2026/10/claude-haiku-5-5-vs-sonnet-5-5-vs-opus-5-5-for-coding-agent-subagents/) covers where each one pays off.

`plan.md` is prose: the goal, the non-goals, the conventions (for example "validators live in `src/validation/<router>.js`, one zod schema per handler"), and how to run the tests. `progress.md` is a one-line-per-event log that the coordinator appends to and every worker reads. Between them, a worker that remembers nothing can get oriented in a few thousand tokens.

## Writing the plan with a human in the loop

Run the planner interactively, once, on your strongest model, and review what it writes before anything runs unattended:

```bash
# Claude Code 2.1.310, interactive planning session
claude --model opus
```

```text
Read the codebase and write agents/plan.md and agents/tasks.json for this goal:
migrate from Express 4 to Express 5 and replace the hand-rolled validation in
src/middleware/validate.js with zod schemas.

Rules for tasks.json:
- Each task must be finishable in one session of under 80 turns.
- Give each task a scope (file globs). Two tasks with no dependency between them must
  never share a file.
- Give each task a verify command that exits 0 only when the task is really done.
  Prefer the narrowest test path that proves it.
- Use depends_on for real ordering constraints only.
Do not change any source files in this session.
```

Then read every task. The two things to check are overlapping scopes and verify commands that would pass on an untouched repo (`npm test` with zero matching tests exits 0 in some runners). Commit the three files plus `agents/worker-rules.md`, a short file of hard rules that gets appended to every worker's system prompt. Add `.worktrees/`, `agents/.lock` and `agents/*.tmp` to `.gitignore`.

## The coordinator script

This is the whole coordinator. It runs one tick and exits, so a crash costs you at most one tick. I ran it against a scratch repo with a stub `claude` binary that simulates a good worker, a worker that edits the ledger, and a worker that hits its turn limit. The flags are the ones in the current [CLI reference](https://code.claude.com/docs/en/cli-reference).

```python
#!/usr/bin/env python3
# agents/coordinator.py -- Python 3.12, Claude Code 2.1.310 (`claude -p`), git 2.50
import datetime as dt, fcntl, fnmatch, json, os, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENTS = ROOT / "agents"
LEDGER, PROGRESS = AGENTS / "tasks.json", AGENTS / "progress.md"
CLAUDE = os.environ.get("CLAUDE_BIN", "claude")
DAILY_BUDGET_USD = float(os.environ.get("DAILY_BUDGET_USD", "40"))
TASK_BUDGET_USD, MAX_ATTEMPTS, LEASE_MIN, WORKER_TIMEOUT_MIN = "6.00", 3, 90, 60

REPORT_SCHEMA = json.dumps({
    "type": "object",
    "properties": {
        "status": {"enum": ["done", "blocked"]},
        "summary": {"type": "string"},
        "follow_ups": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["status", "summary"],
})

def now(): return dt.datetime.now(dt.timezone.utc)
def load(): return json.loads(LEDGER.read_text())

def save(ledger):
    tmp = LEDGER.with_suffix(".tmp")
    tmp.write_text(json.dumps(ledger, indent=2) + "\n")
    tmp.replace(LEDGER)  # atomic: a crash never leaves half a ledger

def log(line):
    with PROGRESS.open("a") as f:
        f.write(f"- {now():%Y-%m-%d %H:%M} {line}\n")

def git(*args, cwd=ROOT):
    return subprocess.run(["git", *args], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout

def spent_today(ledger):
    today = now().date().isoformat()
    return sum(r["cost_usd"] for r in ledger["runs"] if r["at"].startswith(today))

def next_task(ledger):
    for t in ledger["tasks"]:  # a dead worker's claim expires with its lease
        if t["status"] == "claimed" and dt.datetime.fromisoformat(t["lease_until"]) < now():
            t["status"] = "todo"
    done = {t["id"] for t in ledger["tasks"] if t["status"] == "done"}
    return next((t for t in ledger["tasks"]
                 if t["status"] == "todo" and set(t.get("depends_on", [])) <= done), None)

def worker_prompt(t):
    retry = f"\nThe previous attempt failed: {t['last_failure']}\n" if t.get("last_failure") else ""
    return f"""You are one worker on a multi-day project. You remember nothing from earlier sessions.
Read agents/plan.md, then the last 40 lines of agents/progress.md.

Your task, and only this task:
  id: {t['id']}
  goal: {t['description']}
  you may change only files matching: {', '.join(t['scope'])}
  done means this command exits 0: {t['verify']}
{retry}
Commit on the current branch with messages starting "{t['id']}:".
Never edit anything under agents/. If the task cannot be finished inside
that scope, stop and report status "blocked" with the reason."""

def run_worker(t):
    branch, wt = f"agent/{t['id']}", ROOT / ".worktrees" / t["id"]
    if wt.exists():  # leftover from a worker that died mid-run
        git("worktree", "remove", "--force", str(wt))
    git("worktree", "add", "-B", branch, str(wt), "main")
    cmd = [CLAUDE, "-p", worker_prompt(t),
           "--output-format", "json", "--json-schema", REPORT_SCHEMA,
           "--model", t.get("model", "sonnet"),
           "--max-turns", "80", "--max-budget-usd", TASK_BUDGET_USD,
           "--permission-mode", "acceptEdits",
           "--allowedTools", "Read,Edit,Write,Grep,Glob,"
               "Bash(npm test *),Bash(npm run lint *),"
               "Bash(git status *),Bash(git diff *),Bash(git add *),Bash(git commit *)",
           "--append-system-prompt-file", str(wt / "agents" / "worker-rules.md")]
    try:
        p = subprocess.run(cmd, cwd=wt, capture_output=True, text=True,
                           timeout=WORKER_TIMEOUT_MIN * 60)
        code, out = p.returncode, json.loads(p.stdout or "{}")
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        code, out = -1, {"result": type(e).__name__}
    return wt, branch, code, out

def verify(t, wt):
    """The coordinator checks the work itself. The worker's report is a claim, not proof."""
    changed = git("diff", "--name-only", "main...HEAD", cwd=wt).split()
    if not changed:
        return "no commits on the branch"
    outside = [f for f in changed if not any(fnmatch.fnmatch(f, g) for g in t["scope"])]
    if outside:
        return f"changed files outside scope: {outside}"
    if git("status", "--porcelain", cwd=wt).strip():
        return "uncommitted changes left in the worktree"
    r = subprocess.run(t["verify"], shell=True, cwd=wt, capture_output=True, text=True)
    return None if r.returncode == 0 else f"`{t['verify']}` exited {r.returncode}: {r.stdout[-400:]}{r.stderr[-400:]}"

def tick():
    ledger = load()
    if (spent := spent_today(ledger)) >= DAILY_BUDGET_USD:
        print(f"daily budget reached (${spent:.2f}), idle until tomorrow"); return
    t = next_task(ledger)
    if t is None:
        print("nothing runnable: all done, blocked, or waiting on a dependency")
        save(ledger); return
    t.update(status="claimed", attempts=t.get("attempts", 0) + 1,
             lease_until=(now() + dt.timedelta(minutes=LEASE_MIN)).isoformat())
    save(ledger)

    wt, branch, code, out = run_worker(t)
    report = out.get("structured_output") or {}
    ledger["runs"].append({"task": t["id"], "at": now().isoformat(), "exit": code,
                           "cost_usd": out.get("total_cost_usd", 0.0),
                           "session_id": out.get("session_id")})
    failure = (f"worker exited {code}: {str(out.get('result', ''))[:300]}" if code != 0
               else "worker reported blocked: " + report.get("summary", "") if report.get("status") == "blocked"
               else verify(t, wt))

    if failure is None:
        try:
            git("merge", "--no-ff", branch, "-m", f"{t['id']}: {t['description']}")
        except subprocess.CalledProcessError:
            git("merge", "--abort")
            failure = "merge conflict with main"
    if failure is None:
        t.update(status="done", last_failure=None)
        ledger["inbox"].extend(report.get("follow_ups", []))
        log(f"{t['id']} done: {report.get('summary', '')}")
    else:
        retry = t["attempts"] < MAX_ATTEMPTS and report.get("status") != "blocked"
        t.update(status="todo" if retry else "blocked", last_failure=failure)
        log(f"{t['id']} attempt {t['attempts']} failed -> {t['status']}: {failure}")
    git("worktree", "remove", "--force", str(wt))
    save(ledger)
    git("add", "agents/tasks.json", "agents/progress.md")
    git("commit", "-m", f"coordinator: {t['id']} -> {t['status']}")

if __name__ == "__main__":
    with open(AGENTS / ".lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.exit(0)  # previous tick still running
        tick()
```

The stub run produced the log you want to wake up to (attempt-2 lines trimmed):

```text
- 2026-11-02 10:10 T-01 done: added a
- 2026-11-02 10:10 T-02 attempt 1 failed -> todo: changed files outside scope: ['agents/tasks.json']
- 2026-11-02 10:10 T-02 attempt 3 failed -> blocked: changed files outside scope: ['agents/tasks.json']
- 2026-11-02 10:10 T-03 attempt 1 failed -> todo: worker exited 1: Reached max turns
- 2026-11-02 10:10 T-03 attempt 3 failed -> blocked: worker exited 1: Reached max turns
```

Schedule it and walk away:

```bash
# crontab -e, every 30 minutes; flock inside the script skips a tick if one is still running
*/30 * * * * cd ~/src/api && ANTHROPIC_API_KEY=... /usr/bin/python3 agents/coordinator.py >> agents/coordinator.log 2>&1
```

## Why each worker flag is there

**`-p` with a fresh session per task.** I deliberately don't pass `--resume`. A fresh session that reads `plan.md`, the tail of `progress.md` and `last_failure` starts with a few thousand relevant tokens. A resumed session starts with the whole failed attempt, including the reasoning that led it astray. The [headless docs](https://code.claude.com/docs/en/headless) also note that a resumed run's `total_cost_usd` includes the earlier runs' spend, which would double-count in the ledger. I keep the `session_id` only so I can open a failed run's transcript later.

**`--json-schema` with `--output-format json`.** The report lands in `structured_output`, already validated, so the coordinator never parses prose. If the worker produces no valid structured output, the field is missing. The code treats that as "no report" and falls through to verification instead of crashing.

**`--max-turns` and `--max-budget-usd`.** These are the per-task fuses, and both are print-mode only. The docs warn that spend can pass the budget cap before the run stops, and that subagent spend counts toward it. So `DAILY_BUDGET_USD` in the coordinator is the real ceiling, computed from what each run reported. If you see `max turns` failures often, your tasks are too big. Split them in the ledger rather than raising the cap.

**`--permission-mode acceptEdits` plus a narrow `--allowedTools`.** Since 2.1.302, a `-p` run with no mode set starts in Manual mode and denies anything that would need approval, so an unattended worker needs an explicit policy. File edits are auto-approved. Bash is limited to tests, lint, and the git verbs the worker needs to commit. No `git push`, no `rm`, no network tools. Mind the space before `*`: the CLI reference points out that `Bash(git diff*)` would also match `git diff-index`. If you want the worker fully sandboxed rather than allowlisted, run the whole coordinator inside a container, as in [running coding agents in disposable VMs and containers](/2026/09/run-coding-agents-in-disposable-vms-and-containers/).

**A git worktree per task.** The worker never touches your main checkout. A dead worker leaves a directory the next tick deletes. And `git diff main...HEAD` inside the worktree is exactly the set of changes the worker made, which is what makes the scope check trivial.

## The four checks that stop early victory

The worker's `status: "done"` is never enough on its own. A task only merges when all four of these hold:

1. **There is at least one commit.** A worker that "finished" without committing did nothing the coordinator can merge.
2. **Every changed file matches the task's scope.** This is the check that caught the stub editing `agents/tasks.json`. In real runs it catches drive-by refactors of shared utilities. Those are the main cause of merge conflicts between slices, and of a slice breaking a test that belongs to another slice.
3. **The worktree is clean.** Uncommitted edits usually mean the worker ran out of turns mid-change and then reported success anyway.
4. **The verify command exits 0, run by the coordinator.** The model doesn't get to decide what "passing" means. Anthropic's harness article found that giving the agent real end-to-end testing tools "dramatically improved performance". The same logic applies here: the stronger and more end to end your verify command is, the less you rely on the model's honesty.

When a check fails, the reason goes into `last_failure` and into the next worker's prompt. Retries become targeted ("`npm test -- --run test/routes/users` exited 1: expected 422, got 400") instead of starting from scratch.

## Gotchas once it has been running for a while

**Blocked tasks pile up silently.** A task at `blocked` stops its dependents, and the script just prints "nothing runnable". Read `progress.md` once a day. Most blocks are scope mistakes: fix the globs, reset `status` to `todo` and `attempts` to 0, commit. The `inbox` array collects the workers' `follow_ups`. Triage it in the same pass and promote the good ones to real tasks.

**Corrections belong in `plan.md`, not in a retry prompt.** If two workers in a row put validators in the wrong folder, the fix is a line in the conventions section, which every future worker reads. The same rule applies to [writing a CLAUDE.md that actually changes behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/): put the rule where every session will see it.

**The lease must outlive the worker.** `LEASE_MIN` (90) is longer than `WORKER_TIMEOUT_MIN` (60) on purpose. If the timeout fires, Python kills the process. The headless docs say a killed run leaves the in-progress turn unfinished with no result recorded. The coordinator records exit `-1` and retries. If the whole machine dies instead, the claim stays `claimed` until the lease expires and the next tick puts it back in the queue.

**Overloaded errors look like task failures.** A worker that dies on repeated 529s burns an attempt for a reason that has nothing to do with the task. Either keep the CLI's own retries generous ([the 529 fix for headless runs](/2026/10/fix-claude-code-repeated-529-overloaded-errors-in-a-headless-run/) lists the variables), or check `result` for overload errors and requeue without counting the attempt. [Retry and backoff for long agent loops](/2026/11/retry-and-backoff-for-long-agent-loops-under-overloaded-and-rate-limit-errors/) has the classification.

**Parallel workers are a scope problem first.** To run two workers at once, start two coordinator processes with separate lock files, each claiming only tasks whose scopes don't overlap with any task currently `claimed`. Disjoint scopes make the merges conflict-free. Without them you have just built a merge-conflict generator. Start with one worker and add a second only when the ledger shows long chains of independent tasks.

**Hooks and MCP servers still load.** Without `--bare`, a `-p` run picks up the project's `.claude/settings.json` hooks and `.mcp.json` servers with no trust dialog. That is usually what you want, because your guardrail hooks run for workers too. But it also means a worker can reach every MCP tool your settings allow, so audit those settings once before the first unattended night. [Fail-closed vs fail-open hooks](/2026/10/fail-closed-vs-fail-open-hooks-for-coding-agent-guardrails/) covers which guardrails should block when they break.

## When a hosted coordinator is the better choice

If your team already lives in Cursor, its Projects feature gives you a managed version of this: a coordinator model, shared Context files and subscriptions. [Splitting a long-running task with a Cursor Projects coordinator](/2026/10/split-a-long-running-task-across-agents-with-a-cursor-projects-coordinator/) walks through it. The script approach wins when you want the state in git, auditable line by line, running on your own machine or CI, with any agent CLI that has a print mode and structured output. Swapping `claude -p` for another CLI only changes `run_worker`.

## Related

- [Side chats vs subagents: when to branch and when to delegate](/2026/09/side-chats-vs-subagents-when-to-branch-and-when-to-delegate/), the within-session version of the same decision.
- [Nested subagent depth: when it helps and when it burns tokens](/2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens/), on why workers here don't spawn their own workers.
- [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/), for the scheduling side.
- [Run a background coding agent that auto-commits and opens a draft PR](/2026/07/run-a-background-coding-agent-that-auto-commits-and-opens-a-draft-pr/), if you'd rather merge through PR review than locally.

## Sources

- Anthropic Engineering, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (November 26, 2025), and the linked [autonomous-coding quickstart](https://github.com/anthropics/claude-quickstarts/tree/main/autonomous-coding).
- Anthropic Engineering, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (June 13, 2025).
- Claude Code docs, [Run Claude Code programmatically (headless)](https://code.claude.com/docs/en/headless).
- Claude Code docs, [CLI reference](https://code.claude.com/docs/en/cli-reference).
- Git documentation, [git-worktree](https://git-scm.com/docs/git-worktree).
