---
title: "LLM-as-Judge vs Rule-Based Evals for a Coding Agent: Which Should You Use?"
description: "Rule-based checks are your floor and they are non-negotiable; LLM-as-judge is the ceiling you add when code quality, not just correctness, is what you ship. Here is the decision, with cost, latency, and the SWE-bench gap that proves why."
pubDate: 2026-06-12
template: vs
tags:
  - "comparison"
  - "ai-agents"
  - "llm"
  - "evals"
  - "llm-as-judge"
  - "anthropic-sdk"
---

If you are evaluating a coding agent in 2026, the question is rarely "LLM-as-judge or rule-based evals?" It is "which one do I reach for first, and where does the other one stop earning its keep?" The short answer: rule-based checks (unit tests, linters, schema validators, AST queries) are your floor and they are non-negotiable. They are fast, deterministic, free to run, and they catch the failures that matter most. LLM-as-judge is the ceiling you bolt on top when "the tests pass" is no longer a sufficient definition of "good." Reach for rule-based when the task has a verifiable answer. Add an LLM judge when you need to grade taste: readability, blast radius, whether the agent solved the problem or deleted the assertion that exposed it.

This post makes the call concretely, with a feature matrix, a cost-and-latency comparison on `claude-sonnet-4-6` as the judge, and the SWE-bench evidence that explains why neither approach alone is enough. Versions referenced: Anthropic SDK 0.42, `claude-sonnet-4-6` (judge) and `claude-opus-4-7` (golden labels), Python 3.11, pytest 8.3, ruff 0.8. The pattern carries to any provider.

## The two approaches at a glance

| Dimension | Rule-based evals | LLM-as-judge |
| --------------------------- | ------------------------------------ | ------------------------------------ |
| What it answers | "Did the code solve the problem?" | "Is the code readable, safe, minimal?" |
| Determinism | Total: same input, same verdict | Probabilistic: scores drift ~0.3-0.5 |
| Cost per task | ~0 (CPU only) | ~$0.001-0.02 per judge call |
| Latency per task | Milliseconds to seconds | 1-5 seconds per dimension |
| Catches "passed by cheating" | No | Yes |
| Catches broken syntax / tests | Yes | Indirectly, unreliably |
| Setup cost | Write asserts once | Rubric + calibration against humans |
| Failure mode | Brittle: misses semantic regressions | Noisy: position, verbosity, self-pref bias |
| CI gating | Trivial, exit code | Needs a threshold and a baseline |
| Scales to | Anything with a verifiable check | Anything you can describe in a rubric |

The table is the whole argument in miniature. Rule-based wins on cost, speed, and determinism. LLM-as-judge wins on coverage of the things you cannot express as an assertion. They are not competitors; they grade different questions.

## Why "the tests pass" is the floor and not the ceiling

The cleanest evidence that rule-based checks alone are insufficient is the gap between SWE-bench Verified and SWE-bench Pro. As of June 2026, top models clear 80 percent and up on Verified (Claude Fable 5 leads the public Verified board, with GPT-5.3 Codex and Claude Opus 4.5 close behind). The same class of model, run on SWE-bench Pro with standardized scaffolding on contamination-resistant tasks, lands closer to 46-59 percent depending on the harness. Claude Opus 4.5 scores 80.9 percent on Verified and 45.9 percent on Pro.

That delta is almost entirely the distance between "a unit test went green" and "the change is actually correct and well-built." A coding agent on a real task does five things: read the right files, understand the constraint, write a patch, run the tests, and stop. Unit tests grade exactly one of them: the patch, against the cases you thought to write. They are silent on the rest. In production you hit failure modes that rule-based checks wave straight through:

- The agent passed the test by hard-coding the expected output.
- The patch works but introduces a circular import that breaks an unrelated module at runtime.
- The agent rewrote half the file when a three-line change would do.
- The fix is buried under a `try/except: pass` that swallows the next real bug.
- The code is correct and the commit message is "fix bug".

None of those are catchable by an assertion you can write in advance, because each one is a way of being wrong that you did not anticipate. That is the gap LLM-as-judge exists to close. Anthropic's own 2026 guidance for agentic eval is explicit about the split: use deterministic checks for correctness, use an LLM rubric for everything else.

## When to pick rule-based evals

Reach for rule-based checks first, always, and in these cases reach for them exclusively:

- **The task has a verifiable answer.** "Fix the null deref so `load_widget({})` returns an empty config" has a test that either passes or does not. A `pytest -x` run is a better, cheaper, more trustworthy judge than any model. Do not pay for a judgment you can compute.
- **You are gating CI on every commit.** Rule-based checks are deterministic and free, so they can run on all of them. A flaky LLM score that drifts 0.4 between identical runs cannot gate a build without a tolerance band, and a tolerance band is just admitting the signal is noisy. Put `ruff check`, `mypy`, and the test suite on the hot path.
- **You need a hard floor that never regresses silently.** Schema validators, type checkers, and `ast-grep` queries ("no bare `except:`", "no new `print()` in `src/`") express invariants. Encode them once and they hold forever at zero marginal cost.
- **Volume is high and budget is real.** At 10,000 agent runs a night, a judge call per run is a line item. A test run is electricity.

A minimal deterministic gate is the kind of thing you write once and trust:

```python
# rule_based_checks.py
# Python 3.11, pytest 8.3, ruff 0.8
import subprocess
from pathlib import Path

def run_checks(workdir: Path) -> list[dict]:
    results = []

    # 1. Correctness: the regression test must pass.
    tests = subprocess.run(
        ["pytest", "-x", "-q"],
        cwd=workdir, capture_output=True, text=True, timeout=120,
    )
    results.append({"name": "tests_pass", "passed": tests.returncode == 0})

    # 2. Lint: no new style or correctness violations.
    lint = subprocess.run(
        ["ruff", "check", "."],
        cwd=workdir, capture_output=True, text=True,
    )
    results.append({"name": "lint_clean", "passed": lint.returncode == 0})

    # 3. Blast radius: a focused fix should not rewrite the repo.
    diff = subprocess.run(
        ["git", "diff", "--name-only", "HEAD"],
        cwd=workdir, capture_output=True, text=True,
    ).stdout.splitlines()
    results.append({"name": "blast_radius", "passed": len(diff) <= 3})

    return results
```

That runs in seconds, costs nothing, and catches the obvious failures before you spend a single judge token. If any of these fail, you do not need a model to tell you the patch is bad.

## When to pick LLM-as-judge

Add an LLM judge when the thing you care about cannot be reduced to an assertion:

- **You are grading quality, not just correctness.** Readability, idiomatic fit to the surrounding code, whether names match the repo's conventions, whether the diff is minimal. These are real signals about whether you would merge the patch, and there is no `assert` for "this reads well."
- **You are A/B testing a prompt or a system-prompt change.** When you tweak the agent's instructions and want to know if the output got better, a rubric score (or better, a pairwise comparison) is the measurement. The tests pass in both arms; the question is which patch is nicer, and that is a judgment.
- **You need to catch reward hacking.** The single most valuable thing an LLM judge does that a test cannot: notice that the agent passed by deleting the failing assertion, weakening the test, or hard-coding the answer. A test cannot detect that it was gamed. A judge reading the diff can.
- **The acceptable-solution space is wide.** For tasks with many valid answers, a fixed test over-fits to one solution and penalizes good alternatives. A rubric judges the property you actually want ("handles the missing-key case gracefully") instead of one specific implementation.

The judge is a thin wrapper over `client.messages.create` with an explicit rubric in the system block. Cache the rubric so every task after the first reads it at 10 percent of the input price:

```python
# llm_judge.py
# anthropic 0.42, claude-sonnet-4-6 as judge
import os
import anthropic
from pydantic import BaseModel, Field

client = anthropic.Anthropic()
JUDGE_MODEL = os.environ.get("EVAL_JUDGE_MODEL", "claude-sonnet-4-6")
RUBRIC = open("rubric.md").read()

class Score(BaseModel):
    correctness_beyond_tests: int = Field(ge=0, le=5)
    minimal_diff: int = Field(ge=0, le=5)
    code_quality: int = Field(ge=0, le=5)

def judge(prompt: str, diff: str) -> Score:
    resp = client.messages.create(
        model=JUDGE_MODEL,
        max_tokens=600,
        system=[{
            "type": "text",
            "text": RUBRIC,                       # identical every call
            "cache_control": {"type": "ephemeral"},  # 10% input price after first
        }],
        messages=[{
            "role": "user",
            "content": f"## Task\n{prompt}\n\n## Diff\n```\n{diff[:20_000]}\n```",
        }],
    )
    text = resp.content[0].text
    return Score.model_validate_json(text[text.find("{"): text.rfind("}") + 1])
```

The full build, including golden tasks, calibration, pairwise mode, and a CI gate, is in the companion guide on [setting up an LLM-as-judge eval harness for a coding agent](/2026/05/how-to-set-up-an-llm-as-judge-eval-harness-for-a-coding-agent/). For the cache-control breakpoint rules that make the judge affordable at scale, see [how to add prompt caching to an Anthropic SDK app](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/).

## The cost and latency math

This is where the "rule-based first" recommendation stops being a preference and becomes arithmetic. Consider a 30-task eval suite, run on every PR.

Rule-based: each task is a `pytest` plus a `ruff` invocation. Call it 3 seconds of CPU per task, 90 seconds for the suite, $0. It runs on every commit without anyone thinking about budget.

LLM-as-judge: each task sends a trace (prompt plus a capped 20k-character diff, roughly 6k input tokens) and gets back ~400 output tokens. With the rubric cached, you pay full price on the first call's rubric (~1.5k tokens) and 10 percent thereafter. On `claude-sonnet-4-6` at roughly $3 per million input and $15 per million output, a single judged task lands around $0.024 uncached input plus output, and meaningfully less with the cache hit on the rubric. A 30-task suite is in the low tens of cents per run, and 1-5 seconds of wall-clock per task because you are waiting on a model, not a CPU. Multiply by every PR and every prompt iteration and it is a real, if not enormous, line item.

The takeaway is not "judges are expensive." A few cents per eval run is cheap insurance against shipping a regression. The takeaway is that the cost profile tells you where each belongs: rule-based on the hot path of every commit, LLM-as-judge as a second stage that runs after the deterministic floor passes, and only then. Never pay a judge to tell you a patch that fails its own tests is bad. Gate first, judge second.

```python
# orchestration: cheap gate, then the judge only if it passes
checks = run_checks(workdir)
if not all(c["passed"] for c in checks):
    record(task_id, status="failed", reason="deterministic floor")
    # do NOT call the judge: it has nothing to add and costs money
else:
    score = judge(prompt, diff)   # the ceiling, only when the floor holds
    record(task_id, status="judged", score=score)
```

## The gotchas that pick for you

A few realities override preference and make the decision for you.

**LLM judges are biased, and you have to budget for it.** The 2026 literature names five: position bias (judges favor whatever they see first), verbosity bias (they prefer the longer answer), self-preference (a model rates its own family's output higher), format bias, and calibration drift over time. The mitigations are real work: run pairwise comparisons twice with the order swapped and count a flip as a tie; add an explicit conciseness criterion to the rubric; do not judge a model with itself; and re-calibrate against a 200-500 example human-labeled set whenever you change the judge model, flagging for review when correlation drops below Pearson r of about 0.7. If you cannot commit to calibration, your judge scores are vibes, and a deterministic check is strictly better than a vibe.

**Rule-based checks are brittle in the other direction.** They only catch what you encoded. The first time an agent finds a novel way to be wrong that no assertion covers, the suite goes green and ships the regression. That is not an argument against rule-based checks; it is the argument for adding a judge as a second layer once the tasks that matter most are not fully expressible as tests.

**Determinism is a feature, not a nicety, when you gate CI.** A build gate has to give the same answer for the same diff. Rule-based checks do that natively. An LLM judge needs a baseline, a regression threshold (we use 0.3), and tolerance for the score moving under you when the model is updated. If your gate must be reproducible to the bit, keep the model out of the blocking path and run it as a reported metric instead.

## The recommendation, restated

Build rule-based first and treat it as mandatory: tests, linters, type checks, schema validators, and a blast-radius cap. That is your floor, it is deterministic, it is free, and it gates every commit. Then, and only for the tasks where "correct" and "good" diverge, add an LLM-as-judge layer on `claude-sonnet-4-6` with an explicit, calibrated rubric, run it after the floor passes, and use it to catch the failures no assertion can express: reward hacking, sprawling diffs, and code that compiles but degrades the repo. The qualifying axis is simple. If the property you care about has a verifiable answer, write the check. If it requires taste, hire the judge. Most serious agent shops in 2026 run both, in that order, for exactly that reason.

If you are deciding how to parallelize the eval runs themselves, [Claude subagents vs OpenAI Assistants for parallelizable work](/2026/06/claude-subagents-vs-openai-assistants-for-parallel-work/) covers the orchestration tradeoffs, and [running Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/) shows where the gate actually fires in CI.

## Related reading

- [How to set up an LLM-as-judge eval harness for a coding agent](/2026/05/how-to-set-up-an-llm-as-judge-eval-harness-for-a-coding-agent/)
- [How to add prompt caching to an Anthropic SDK app and measure the hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/)
- [How to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/)
- [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)
- [Claude subagents vs OpenAI Assistants for parallelizable work](/2026/06/claude-subagents-vs-openai-assistants-for-parallel-work/)

## Sources

- [SWE-bench leaderboards (Verified and Pro)](https://www.swebench.com/)
- [SWE-bench Pro public leaderboard, Scale SEAL](https://labs.scale.com/leaderboard/swe_bench_pro_public)
- [An empirical study of LLM-as-a-judge design choices](https://arxiv.org/html/2506.13639v1)
- [Evaluating LLM-judge bias: detect, measure, fix (2026)](https://futureagi.com/blog/evaluating-llm-judge-bias-mitigation-2026/)
- [Position bias in rubric-based LLM-as-a-judge](https://arxiv.org/pdf/2602.02219)
- [Anthropic prompt caching docs](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
