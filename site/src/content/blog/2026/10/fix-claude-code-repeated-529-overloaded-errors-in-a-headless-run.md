---
title: "Fix: \"API Error: Repeated 529 Overloaded errors\" ends a long headless Claude Code run"
description: "A claude -p run on Opus with an API key gives up after three consecutive 529s, about 1.5 seconds of backoff, no matter what CLAUDE_CODE_MAX_RETRIES says. Add --fallback-model, set CLAUDE_CODE_RETRY_WATCHDOG=1 with a max wait, or widen the 529 backoff with the OVERLOADED_RETRY delay variables. Checked against Claude Code 2.1.309."
pubDate: 2026-10-23
template: error-page
tags:
  - "errors"
  - "claude-code"
  - "ai-agents"
  - "llm"
  - "headless"
  - "ci"
---

If a long `claude -p` job dies with `API Error: Repeated 529 Overloaded errors`, raising `CLAUDE_CODE_MAX_RETRIES` will not help: on an Opus or Fable model with an API key, Claude Code stops at the **third consecutive 529**, which with the default 500 ms base delay is about 1.5 seconds of backoff. Pick one of three fixes. Pass `--fallback-model sonnet` so the third 529 switches models instead of failing. Set `CLAUDE_CODE_RETRY_WATCHDOG=1` (plus `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS`) so an unattended run waits out the overload. Or, on 2.1.292 and later, raise `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS` and `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS` so the retries you do get are spread over minutes instead of seconds. Everything below was checked against Claude Code 2.1.309 (the current release on October 23, 2026), its [error reference](https://code.claude.com/docs/en/errors) and [environment variable reference](https://code.claude.com/docs/en/env-vars), and the retry code in the 2.1.309 CLI bundle.

## The error in context

```text
API Error: Repeated 529 Overloaded errors. The API is at capacity
```

The rest of the line says the condition is usually temporary and points you to `status.claude.com`.

In an interactive session you would see the spinner count `Retrying in Ns · attempt x/y`, maybe a hint like `Opus is experiencing high load, please use /model to switch to Sonnet`, and you would just switch. In a headless run nobody is watching. The run prints the message as its result, exits non-zero, and the nightly refactor, the issue triage cron, or the CI review step is simply gone. With `--output-format json` the final `result` message carries `"is_error": true` and `"api_error_status": 529`.

Two facts frame the fix. A 529 is not your rate limit: the [error reference](https://code.claude.com/docs/en/errors) says it "is not your usage limit and doesn't count against your quota". It means the API is at capacity for that model across all users. And capacity is tracked per model, so a different model often answers while the first one is overloaded.

## Why the run gives up so quickly

Claude Code's documented default is 10 retries with exponential backoff. That is true for most transient errors, but 529 has its own rule. The env-var reference puts it plainly: "with an API key on an Opus model, it stops at the third `529` and shows Repeated 529 Overloaded errors. If you set a fallback model, Claude Code switches to that model rather than showing the error."

The 2.1.309 bundle shows the full condition. Claude Code counts consecutive 529s when any of these is true:

- you configured a fallback model, or
- you are not on a claude.ai subscription login (so: API key, Bedrock, Vertex, Foundry, a gateway) and the model is an Opus, Fable or Mythos model.

When the counter reaches 3, it either throws a fallback switch (if a fallback model is set) or ends the request with `Repeated 529 Overloaded errors`. The only things that skip the early stop are a sandboxed build and `CLAUDE_CODE_RETRY_WATCHDOG`. `CLAUDE_CODE_MAX_RETRIES` is never consulted on that path, which is why people set it to 15 and see no change.

Now the timing. The backoff helper in 2.1.309 computes `min(cap, base * 2^(attempt - 1))` and adds up to 25% proportional jitter. With the defaults (base 500 ms, cap 32000 ms) the waits after the first two 529s are about 0.5 s and 1 s. An overload that lasts ten seconds is enough to kill a run that had been working for an hour.

Sonnet and Haiku on an API key, and any model on a subscription login, do not hit the three-strike rule. They get the normal retry budget, but with the default delays that budget still covers only about 2.5 to 3.5 minutes:

| Retry | Default delay (base 500, cap 32000) | Tuned delay (base 4000, cap 64000) |
| --- | --- | --- |
| 1 | 0.5 s | 4 s |
| 2 | 1 s | 8 s |
| 3 | 2 s | 16 s |
| 4 | 4 s | 32 s |
| 5 | 8 s | 64 s |
| 6 | 16 s | 64 s |
| 7 to 10 | 32 s each | 64 s each |
| **Total for 10 retries** | **about 160 s (+ up to 25%)** | **about 444 s (+ up to 25%)** |

## Minimal repro

You can't make the API overload on demand, but you can reproduce the decision path. This is the shape of a job that fails during a capacity event:

```bash
# Claude Code 2.1.309, ANTHROPIC_API_KEY set, no subscription login
export CLAUDE_CODE_MAX_RETRIES=15   # looks like it should help; it doesn't for Opus 529s

claude --bare -p "Upgrade every package in this repo and fix the build" \
  --model opus \
  --permission-mode acceptEdits \
  --output-format json > result.json
echo "exit: $?"
jq '{is_error, api_error_status, result}' result.json
```

During an overload, `result.json` ends with `is_error: true`, `api_error_status: 529`, and the error string above, after three attempts. Everything the agent did before the failure is still in the session transcript, which matters for the recovery step at the end.

## Fix 1: give the run a fallback model

This is the fix I reach for first, because it keeps the job moving instead of making it wait. Capacity is per model, so when Opus is overloaded, Sonnet usually is not.

```bash
# Claude Code 2.1.309
claude --bare -p "Upgrade every package in this repo and fix the build" \
  --model opus \
  --fallback-model sonnet,haiku \
  --permission-mode acceptEdits \
  --output-format json
```

Per the [model configuration docs](https://code.claude.com/docs/en/model-config), `--fallback-model` takes a comma-separated chain, tried in order, capped at three models after duplicates are removed. To make it permanent for a repo or a machine, put it in settings:

```json
{
  "model": "opus",
  "fallbackModel": ["sonnet", "haiku"]
}
```

Details that matter for long runs:

- **The switch lasts for the current turn only.** The next user message tries the primary model again. A `claude -p` invocation is usually one long turn, so in practice the rest of that run stays on the fallback.
- **Subagents use the chain too**, from 2.1.247. Before that, a 529 that the chain would have covered ended the subagent.
- **Compaction will not fall back to a smaller context window.** If every fallback has a smaller window than the primary, compaction surfaces the original error. Keep at least one fallback with the same window size if your runs compact.
- **`availableModels` filters the chain.** If your managed settings restrict models, entries outside the allowlist are silently dropped, and you may end up with no fallback at all. See [enforcing an availableModels allowlist](/2026/06/claude-code-enforce-available-models-allowlist/) for how that list is applied.
- **Nothing confirms the chain at startup**, and `/status` does not show it. The first sign that it works is the switch notice when it happens. In a pipeline, check the stream for it rather than trusting the flag.

Setting a fallback also turns on the three-strike counter for every model, including Sonnet on a subscription. That is what you want: three quick 529s, then switch.

## Fix 2: let an unattended run wait it out

If the job must run on one specific model (an eval harness comparing models, for example), switching is wrong. Use the retry watchdog, which the docs describe as meant "for unattended sessions such as eval harnesses, CI jobs, or remote workers":

```bash
# Claude Code 2.1.309 (watchdog: 2.1.186+, MAX_WAIT: 2.1.295+)
export CLAUDE_CODE_RETRY_WATCHDOG=1
export CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS=1800000   # give up after 30 min per request

claude --bare -p "Run the eval suite in evals/ and write report.md" \
  --model opus \
  --output-format json
```

With the watchdog on:

- `429` and `529` capacity errors are retried indefinitely instead of failing after `CLAUDE_CODE_MAX_RETRIES` attempts, and the three-strike rule is skipped.
- The backoff goes up to 5 minutes between attempts, or until the reset time when the response carries one.
- On 2.1.199 and later, other transient errors (5xx, timeouts, dropped connections) get a default budget of 300 retries, roughly three hours, and the cap of 15 on an explicit `CLAUDE_CODE_MAX_RETRIES` goes away.
- A `429` that reports a spend limit or exhausted credits still fails at once (since 2.1.239). The watchdog does not hide a billing problem.

Always pair it with `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS`. Without it, the wait has no limit, and a CI job will sit there until the runner's own timeout kills it, which is the worst outcome: you burn runner minutes and get no clean error. Thirty minutes per request is a sensible ceiling for a nightly job, five to ten for a PR check.

If you also set a fallback model, the fallback still wins: the bundle checks the three-strike fallback before the watchdog. So `--fallback-model` plus the watchdog means "switch after three 529s, then wait patiently on the fallback if it is overloaded too", which is a good default for scheduled jobs.

## Fix 3: spread the normal retries over a longer window

When you want neither a model switch nor an open-ended wait, keep the normal retry budget and stretch the 529 backoff. Two variables control it:

| Variable | Default | Allowed range | Requires |
| --- | --- | --- | --- |
| `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS` | 500 | 500 to 32000 | 2.1.292 |
| `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS` | 32000 | 32000 to 64000 | 2.1.296 |

```bash
# Claude Code 2.1.309, Sonnet on an API key (no three-strike rule)
export CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS=4000
export CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS=64000
export CLAUDE_CODE_MAX_RETRIES=15

claude --bare -p "Triage the open issues labelled needs-triage" \
  --model sonnet \
  --output-format json
```

With base 4000 and cap 64000, ten retries span about 7.5 minutes and fifteen about 12.5 minutes. That rides out most short capacity dips without letting the job hang.

Three things trip people up here:

- **Out-of-range values are ignored silently.** The docs say any value outside the range, or not in plain digits, is treated as unset. `4000ms`, `4_000`, or `100000` all fall back to the defaults.
- **These variables do nothing when the watchdog is on**, and nothing for requests sent in fast mode. Fast mode has its own rate-limit handling.
- **On Opus or Fable with an API key, they only stretch the three strikes.** With base 32000 and cap 64000 the three-strike window becomes about 96 seconds instead of 1.5. That helps, but it is still three attempts. Combine this fix with Fix 1 or Fix 2 for Opus.

## Make the settings stick in CI

Exporting variables in a shell is easy to lose. Put them in the job definition. In GitHub Actions:

```yaml
# .github/workflows/nightly-agent.yml, Claude Code 2.1.309
jobs:
  agent:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_RETRY_WATCHDOG: "1"
      CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: "1800000"
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @anthropic-ai/claude-code@2.1.309
      - run: |
          claude --version
          claude --bare -p "$(cat .github/prompts/nightly.md)" \
            --model opus --fallback-model sonnet \
            --permission-mode acceptEdits \
            --output-format json > result.json
```

Keep `timeout-minutes` above `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` plus the expected run time, or the runner kills the job before Claude Code can report a clean error. Pin the CLI version: the overload variables need 2.1.292 and 2.1.296, and an unpinned install on an old image gives you defaults without any warning. Print `claude --version` so the log shows which one ran.

Outside CI, the `env` block in `.claude/settings.json` (or `~/.claude/settings.json` for a whole machine) does the same for every session, interactive or not:

```json
{
  "env": {
    "CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS": "4000",
    "CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS": "64000"
  },
  "fallbackModel": ["sonnet"]
}
```

## Resume instead of restarting when it still fails

Even with all of the above, a run can still end on a 529 when the max wait runs out. The work done so far is in the session transcript, so resume it rather than starting over. A small wrapper does this for scheduled jobs:

```bash
#!/usr/bin/env bash
# Claude Code 2.1.309, jq 1.7
set -uo pipefail
prompt="$1"
out=$(claude --bare -p "$prompt" --model opus --fallback-model sonnet --output-format json)

for attempt in 1 2 3; do
  status=$(jq -r '.api_error_status // empty' <<<"$out")
  [[ "$status" != "529" ]] && break
  session=$(jq -r '.session_id' <<<"$out")
  echo "529 on attempt $attempt, resuming $session in 5 minutes" >&2
  sleep 300
  out=$(claude --bare -p "continue" --resume "$session" \
        --model opus --fallback-model sonnet --output-format json)
done

jq -r '.result' <<<"$out"
jq -e '.is_error | not' <<<"$out" > /dev/null
```

The [headless docs](https://code.claude.com/docs/en/headless) confirm that `--resume` accepts the session ID from the JSON output, from any directory on the same machine. In a CI runner that is a fresh VM per job, the transcript disappears with the VM, so this outer loop belongs inside one job, not across jobs. If you stream with `--output-format stream-json --verbose`, each retry also emits a `system/api_retry` event with `attempt`, `max_retries`, `retry_delay_ms`, `error_status` and `error: "overloaded"`, which is the cleanest way to log how close a run came to failing. For how to consume that stream, see [streaming nested subagent output from a headless run](/2026/07/stream-nested-subagent-output-from-a-headless-claude-code-run/).

## Gotchas that look like the same problem

- **`429 rate_limit_error` is a different error.** It is your organization's limit, it does count against quota, and the fix is caching and pacing, not a fallback. A fallback chain never switches on rate-limit errors. The API-side fix is in [fixing rate_limit_error in a long agent loop](/2026/05/fix-rate-limit-error-on-claude-sonnet-4-6-in-a-long-agent-loop/).
- **`Opus is experiencing high load, please use /model to switch to Sonnet`** is the interactive version of the same condition. `/model sonnet` works in a `-p` prompt too, but a fallback chain is the scripted answer.
- **A huge `retry-after` ends the request immediately.** In 2.1.309, without the watchdog, if the server asks for a wait longer than 60 seconds (or 1.25 times your max delay, whichever is larger), Claude Code fails instead of sleeping. The watchdog removes that limit.
- **Your subscription session works, the CI key does not.** That is the three-strike rule applying only to API-key Opus traffic. The same prompt on the same model behaves differently on a laptop logged in to claude.ai and on a runner with `ANTHROPIC_API_KEY`.
- **`Request timed out` or `Streaming response ended` after a long wait.** Those are timeouts, controlled by `API_TIMEOUT_MS` and the stream watchdog variables, not by the overload settings.

## Related

- [How to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/) sets up the job the CI snippet above hardens.
- [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) is the cron-style run where a silent 529 hurts most.
- [Migrating to Manual permission mode without breaking headless runs](/2026/08/migrate-to-manual-permission-mode-without-breaking-headless-runs/) covers the other default that changes how `-p` jobs fail.
- [Fix: rate_limit_error on Claude Sonnet 4.6 in a long agent loop](/2026/05/fix-rate-limit-error-on-claude-sonnet-4-6-in-a-long-agent-loop/) handles the 429 side if you call the API directly.

## Sources

- [Claude Code error reference](https://code.claude.com/docs/en/errors), "Repeated 529 Overloaded errors" and "Tune retry behavior".
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars), `CLAUDE_CODE_MAX_RETRIES`, `CLAUDE_CODE_RETRY_WATCHDOG*`, `CLAUDE_CODE_OVERLOADED_RETRY_*`.
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config), "Fallback model chains".
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless), exit codes, `system/api_retry` events and `--resume`.
- [Claude status page](https://status.claude.com) for live capacity notices.
- Claude Code 2.1.309 CLI bundle (`@anthropic-ai/claude-code-darwin-arm64`), read for the three-strike constant, the models it applies to, the backoff formula with 25% jitter, and the 60-second `retry-after` ceiling.
