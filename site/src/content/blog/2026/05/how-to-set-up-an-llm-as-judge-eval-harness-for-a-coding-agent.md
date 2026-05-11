---
title: "How to Set Up an LLM-as-Judge Eval Harness for a Coding Agent"
description: "Build a working LLM-as-judge eval harness for a coding agent in Python: golden tasks, deterministic checks, a rubric judge on Claude Sonnet 4.6, calibration against human labels, and a CI gate that fails the build when scores regress."
pubDate: 2026-05-11
tags:
  - "ai-agents"
  - "llm"
  - "claude-code"
  - "anthropic-sdk"
  - "agent-skills"
---

If your coding agent ships changes to a real repo, "did it pass the tests?" is the floor, not the ceiling. The tests answer correctness. They do not catch the agent that solved the bug by deleting the failing assertion, or the refactor that compiles but leaves dead branches everywhere. To catch those you need an LLM-as-judge eval harness: a deterministic set of tasks, a rubric, and a second model that scores the agent's output against that rubric. Done right, the harness runs in CI on every prompt or system-prompt change, blocks regressions before they hit users, and produces numbers you can actually compare across model versions.

This guide builds a working harness in Python against the Anthropic SDK 0.42, using `claude-sonnet-4-6` as the judge and `claude-opus-4-7` for golden-label generation. Pattern carries to any provider. We will cover golden task design, the rubric prompt, calibration against human labels (the step everyone skips), pairwise comparison for A/B'ing prompt changes, and a small CI gate that fails the build when a metric drops more than a configurable threshold.

## Why a unit-test-only harness is not enough

A coding agent for a non-trivial repo does five things on every task: read the right files, understand the constraint, write a patch, run the tests, and stop when done. Unit tests check the patch. They say nothing about the other four. In practice you ship agents and then hit failure modes like:

- The agent passed the test by hard-coding the expected output.
- The patch works but introduces a circular import that breaks unrelated modules at runtime.
- The agent rewrites half the file when a three-line change would do, blowing up the diff.
- The agent silently swallows an exception in a `try/except: pass` block.
- The fix is correct but the commit message is "fix bug".

Anthropic's own guidance for coding and agentic eval is now explicit about this: combine **deterministic checks** (unit tests, schema validators, linters) for correctness with an **LLM rubric** for everything else. Pinggy's writeup on harness engineering calls this the "hybrid norm" and it is what every serious agent shop runs in 2026. The SWE-bench Pro leaderboard agrees: the gap between Verified (>70 percent for top models) and Pro (~23 percent) is almost entirely the gap between "tests pass" and "code is actually good."

The harness below implements that split. Deterministic checks run first as a hard gate; the LLM judge runs second and produces a 1 to 5 score per dimension.

## Versions and what you need installed

```bash
# Python 3.11, anthropic 0.42, pytest 8.3
pip install anthropic==0.42.0 pytest==8.3.0 pydantic==2.9
```

Two environment variables:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export EVAL_JUDGE_MODEL=claude-sonnet-4-6
```

Use Sonnet 4.6 as the judge, not Opus 4.7. The empirical study on LLM-as-judge design choices ([arXiv 2506.13639](https://arxiv.org/html/2506.13639v1)) confirms what you would expect: stronger judges are more reliable, but for a rubric of 1 to 5 across well-defined dimensions, Sonnet hits ~85 percent agreement with human labels at a fraction of the cost. Reserve Opus for generating golden labels and for the highest-stakes pairwise comparisons.

## Anatomy of the harness

Four pieces:

1. A `tasks/` directory of golden tasks, each with an input prompt, the repo state to run against, and a `checks.py` for deterministic asserts.
2. A runner that invokes the agent on each task and captures its trace (diff, files touched, tool calls).
3. A judge that scores the trace against a rubric.
4. A CI gate that compares the aggregate score to a baseline and fails the build on regression.

```
evals/
  tasks/
    fix-null-deref/
      task.yaml         # prompt, repo ref, expected files
      checks.py         # deterministic assertions
      golden.json       # optional reference solution (for pairwise)
    add-rate-limit/
      ...
  rubric.md             # the judge prompt
  run_evals.py          # orchestrator
  baseline.json         # last green score per task
```

Keep tasks small and self-contained. Ten focused tasks beat a hundred ad-hoc ones. The trap is grading on noise: if your tasks are flaky, your judge scores are flaky, and you cannot tell a real regression from a re-run.

## Step 1: a deterministic task

A `task.yaml` describes the inputs and the deterministic floor:

```yaml
# evals/tasks/fix-null-deref/task.yaml
id: fix-null-deref
repo: https://github.com/example/widget-api
revision: main
prompt: |
  In src/widgets/loader.py, the function load_widget crashes
  with AttributeError when the input dict is missing the
  "config" key. Add a fallback that returns an empty WidgetConfig.
  Add a regression test in tests/test_loader.py.
expected_files_touched:
  - src/widgets/loader.py
  - tests/test_loader.py
max_files_touched: 3
```

The `checks.py` runs after the agent finishes and returns a list of pass/fail dicts:

```python
# evals/tasks/fix-null-deref/checks.py
import subprocess
from pathlib import Path

def run_checks(workdir: Path) -> list[dict]:
    results = []

    proc = subprocess.run(
        ["pytest", "tests/test_loader.py", "-x", "-q"],
        cwd=workdir, capture_output=True, text=True, timeout=120,
    )
    results.append({
        "name": "regression_test_passes",
        "passed": proc.returncode == 0,
        "detail": proc.stdout[-500:],
    })

    diff = subprocess.run(
        ["git", "diff", "--name-only", "HEAD"],
        cwd=workdir, capture_output=True, text=True,
    ).stdout.splitlines()
    results.append({
        "name": "blast_radius",
        "passed": len(diff) <= 3,
        "detail": f"touched {len(diff)} files: {diff}",
    })

    return results
```

These are the cheap checks. They run in seconds and they catch the obvious failures (tests broken, diff too large) before you spend a judge token. If any "hard" check fails, the task is marked failed and the judge is skipped. That is the deterministic floor everyone agrees on.

## Step 2: capture the agent trace

For Claude Code, the trace is in the JSONL session log. For a custom Anthropic SDK agent, capture it yourself. The judge needs four things: the original prompt, the unified diff, the list of tool calls, and the final assistant message. Keep it small. A judge fed 50k tokens of raw tool output will average everything to 3 and miss the actual signal.

```python
# evals/run_evals.py (partial)
import subprocess
from pathlib import Path

def capture_trace(workdir: Path, prompt: str, assistant_msg: str) -> dict:
    diff = subprocess.run(
        ["git", "diff", "HEAD"],
        cwd=workdir, capture_output=True, text=True,
    ).stdout

    files_touched = subprocess.run(
        ["git", "diff", "--name-only", "HEAD"],
        cwd=workdir, capture_output=True, text=True,
    ).stdout.splitlines()

    return {
        "prompt": prompt,
        "diff": diff[:20_000],  # cap the diff size
        "files_touched": files_touched,
        "final_message": assistant_msg[:4_000],
    }
```

## Step 3: the rubric

This is the part that separates a real harness from "we asked Claude to grade itself." Without an explicit rubric, the judge defaults to "this looks fine" for almost any output. Confident AI's guide and Arize's LLM-as-judge primer both converge on the same advice: name the dimensions, define each score, and give the judge an out for "cannot tell from the trace."

```markdown
# evals/rubric.md

You are grading a coding agent's patch against a task. Return a JSON object
with four scores from 1 (worst) to 5 (best), and a short reason for each.
Use 0 if the trace does not contain enough information to score that
dimension. Do not invent details that are not in the trace.

Dimensions:

1. correctness_beyond_tests
   - 5: the patch fully solves the stated problem with no hidden side effects.
   - 3: the patch solves the visible problem but has one questionable choice
     (e.g. broad exception swallow, removed an unrelated assertion).
   - 1: the patch passes tests by deleting or weakening the test.

2. minimal_diff
   - 5: change is tightly scoped to the requested behaviour.
   - 3: includes one or two unrelated edits (formatting, renames).
   - 1: rewrites large sections of unrelated code.

3. code_quality
   - 5: idiomatic for the repo, no dead code, names match surrounding style.
   - 3: works but slightly off (inconsistent naming, redundant branches).
   - 1: clearly degrades the file (deep nesting, magic numbers, leaked locals).

4. communication
   - 5: final message clearly states what was changed and why, in <5 lines.
   - 3: states what but not why, or buries it in 20 lines of narration.
   - 1: empty, off-topic, or claims work that is not in the diff.

Output schema:
{
  "correctness_beyond_tests": {"score": 1-5 or 0, "reason": "..."},
  "minimal_diff":            {"score": 1-5 or 0, "reason": "..."},
  "code_quality":            {"score": 1-5 or 0, "reason": "..."},
  "communication":           {"score": 1-5 or 0, "reason": "..."}
}
```

Two non-obvious rules in there. First, "use 0 if you cannot tell" is critical. Without it, the judge fills in plausible scores from nothing and your aggregate moves around for reasons that are not your agent's behaviour. Second, "do not invent details that are not in the trace" cuts the hallucinated reasons judges produce when you ask for free-form justification.

## Step 4: the judge call

A thin wrapper around `client.messages.create` with `response_format`-style coercion via Pydantic. The judge model gets the rubric as the system prompt and the trace as the user message:

```python
# evals/run_evals.py
import json, os
from pathlib import Path
import anthropic
from pydantic import BaseModel, Field

client = anthropic.Anthropic()
RUBRIC = Path("evals/rubric.md").read_text()
JUDGE_MODEL = os.environ.get("EVAL_JUDGE_MODEL", "claude-sonnet-4-6")

class DimensionScore(BaseModel):
    score: int = Field(ge=0, le=5)
    reason: str

class RubricScore(BaseModel):
    correctness_beyond_tests: DimensionScore
    minimal_diff:             DimensionScore
    code_quality:             DimensionScore
    communication:            DimensionScore

def judge(trace: dict) -> RubricScore:
    user_msg = (
        f"## Task prompt\n{trace['prompt']}\n\n"
        f"## Files touched\n{trace['files_touched']}\n\n"
        f"## Unified diff\n```\n{trace['diff']}\n```\n\n"
        f"## Agent final message\n{trace['final_message']}\n"
    )

    response = client.messages.create(
        model=JUDGE_MODEL,
        max_tokens=800,
        system=[{
            "type": "text",
            "text": RUBRIC,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{"role": "user", "content": user_msg}],
    )

    text = response.content[0].text
    # The model returns JSON inside the message; extract it.
    start, end = text.find("{"), text.rfind("}") + 1
    return RubricScore.model_validate_json(text[start:end])
```

Two things to notice. The rubric goes in the **system** block with `cache_control`, so every task after the first reads the rubric from cache at 10 percent of the input price. For a 30-task suite this matters. And we run the judge through Pydantic so a malformed response fails loudly instead of poisoning the aggregate with `None` scores. See [how to add prompt caching to an Anthropic SDK app](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/) for the breakpoint placement rules.

## Step 5: calibrate against a golden set

Here is the step that everyone skips and that determines whether your harness is actually measuring anything. Before you trust the judge's scores, label 20 to 30 traces by hand on the same rubric, then run the judge on the same traces, and compute agreement. Aim for 75 to 90 percent agreement on the top-line dimension. Below that, your rubric is ambiguous or your judge model is too weak. The RAND Judge Reliability Harness writeup is the most accessible treatment of this; the threshold around Krippendorff's alpha ~0.8 is the canonical bar for "this measurement instrument is trustworthy."

Practical workflow: dump traces from a recent run, score them yourself in a CSV, then:

```python
def agreement(human_scores: list[int], judge_scores: list[int]) -> float:
    assert len(human_scores) == len(judge_scores)
    matches = sum(1 for h, j in zip(human_scores, judge_scores) if abs(h - j) <= 1)
    return matches / len(human_scores)
```

"Within 1 point" is a more forgiving but still useful agreement metric than strict equality, and it tolerates the natural noise in a 5-point Likert scale.

If agreement is bad, the fix is almost always the rubric, not a bigger judge. Sharpen the per-score definitions until two humans would agree, then re-test.

## Step 6: pairwise mode for prompt changes

Absolute scoring is right for "is this build OK to ship." But when you are tuning a prompt or comparing two model versions, pairwise judgment is more sensitive. Both Arize and Confident AI recommend pairwise for A/B'ing, because relative quality is easier for a model to judge than absolute quality:

```python
def judge_pairwise(trace_a: dict, trace_b: dict) -> dict:
    user_msg = (
        f"Two agents attempted the same task. Pick the better patch.\n\n"
        f"## Task\n{trace_a['prompt']}\n\n"
        f"## Patch A\n```\n{trace_a['diff']}\n```\n\n"
        f"## Patch B\n```\n{trace_b['diff']}\n```\n\n"
        f"Respond with JSON: "
        f'{{"winner": "A"|"B"|"tie", "reason": "..."}}'
    )
    # ... same client.messages.create as above, then parse.
```

Two pitfalls. **Position bias**: judges prefer the first option more often than chance. Run every comparison twice with the order swapped and count a flip as a tie. **Length bias**: judges prefer the longer answer. State explicitly in the prompt that brevity is a positive.

## Step 7: the CI gate

The harness is worthless if no one runs it. Wire it to CI and fail the build when any dimension regresses by more than 0.3 against the stored baseline:

```python
# evals/run_evals.py (orchestrator)
import json, sys
from pathlib import Path

REGRESSION_THRESHOLD = 0.3

def main():
    baseline = json.loads(Path("evals/baseline.json").read_text())
    current = run_all_tasks()  # returns {task_id: {dimension: score}}

    regressions = []
    for task_id, dims in current.items():
        for dim, score in dims.items():
            prev = baseline.get(task_id, {}).get(dim)
            if prev is None:
                continue
            if prev - score > REGRESSION_THRESHOLD:
                regressions.append((task_id, dim, prev, score))

    if regressions:
        print("REGRESSION DETECTED:")
        for r in regressions:
            print(f"  {r[0]}.{r[1]}: {r[2]:.2f} -> {r[3]:.2f}")
        sys.exit(1)

    Path("evals/baseline.json").write_text(json.dumps(current, indent=2))

if __name__ == "__main__":
    main()
```

Run it as a GitHub Action on every PR that touches `prompts/`, `tools/`, or the agent's system prompt. The same pattern carries to scheduled CI ([how to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/) covers the runner setup). For tasks that need a managed scheduler, [scheduling a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) shows the cron piece.

## Gotchas worth budgeting for

A few hard-won lessons that will save a weekend each:

- **Cache the rubric, not the trace.** Traces are unique per task, so they never cache-hit. The rubric is identical for every call, so cache it as the system prompt. The minimum prefix size for Sonnet 4.6 is 2,048 tokens; if your rubric is shorter, pad it with examples until it crosses the threshold or accept that it will not cache.
- **Stable hash your tasks.** Score them by `task_id`, not by index. Reordering the tasks should not invalidate the baseline.
- **Quarantine flaky tasks.** Some tasks legitimately have multiple acceptable solutions and the judge oscillates. Flag a task as flaky if its variance across three reruns is above 1 point, then either tighten its rubric or pull it from the gating set.
- **Don't grade the agent on tasks the agent helped build.** If the same model wrote the golden solution and is being judged against it, you are measuring self-consistency, not capability.
- **Re-calibrate when you change the judge model.** Bumping the judge from Sonnet 4.6 to Opus 4.7 will shift scores by ~0.5 across the board in our experience. Re-run the human-label set and update the baseline.

## Related reading

- [How to add prompt caching to an Anthropic SDK app and measure the hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/)
- [How to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/)
- [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)
- [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/)
- [How to call the Claude API from a .NET 11 minimal API with streaming](/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/)

## Sources

- [Anthropic prompt caching docs](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
- [Rubric-based evaluations and LLM-as-a-judge methodologies](https://medium.com/@adnanmasood/rubric-based-evals-llm-as-a-judge-methodologies-and-empirical-validation-in-domain-context-71936b989e80)
- [An empirical study of LLM-as-a-judge design choices](https://arxiv.org/html/2506.13639v1)
- [Arize: LLM as a Judge primer](https://arize.com/llm-as-a-judge/)
- [Confident AI: scaling evaluation with LLM judges](https://www.confident-ai.com/blog/why-llm-as-a-judge-is-the-best-llm-evaluation-method)
- [RAND Judge Reliability Harness](https://www.rand.org/pubs/tools/TLA4547-1.html)
- [SWE-bench leaderboard](https://www.swebench.com/)
