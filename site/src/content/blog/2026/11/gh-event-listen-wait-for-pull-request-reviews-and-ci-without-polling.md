---
title: "gh event listen: wait for pull request reviews and CI without polling in GitHub CLI 2.105"
description: "GitHub CLI 2.105.0 adds gh event listen, built on the GitHub Event Streams preview. A script or coding agent can block until a review lands, a check suite completes, or the PR merges, instead of polling gh pr view in a loop."
pubDate: 2026-11-22
tags:
  - "github"
  - "github-cli"
  - "ai-agents"
  - "ci-cd"
---

GitHub CLI [2.105.0](https://github.com/cli/cli/releases/tag/v2.105.0), released on November 18, 2026, adds a `gh event` command group on top of [GitHub Event Streams](https://github.blog/changelog/2026-11-17-github-event-streams-is-now-in-preview), which entered preview a day earlier. The headline command is `gh event listen`: give it a pull request URL and the event types you care about, and it blocks until one of them happens.

## Why polling was the only option before

If you wanted a script or a coding agent to react when a reviewer approves a PR or CI finishes, you had two choices. Either you stood up a webhook receiver with a public endpoint, or you polled `gh pr view` / `gh pr checks` in a `while` loop with a `sleep`. Polling often burns rate-limit budget on responses that say nothing changed. Polling rarely leaves review feedback sitting until the next tick. For agents it is worse: every poll is a tool call, and every tool call costs tokens.

Event Streams removes the endpoint requirement. The CLI creates a subscription, opens a server-sent events stream, and prints each event as one line of CloudEvent JSON. It works from a laptop with no inbound port.

## The five event types

In 2.105.0 the CLI accepts these types for a pull request:

- `com.github.pull_request.review.submitted.v1`: a review was submitted
- `com.github.pull_request.state.changed.v1`: merged, closed, reopened, marked ready, or converted to draft
- `com.github.pull_request.head.changed.v1`: the head branch changed, for example after a push
- `com.github.pull_request.merge_conflict.v1`: the PR has a merge conflict
- `com.github.pull_request.check_suite.status.changed.v1`: a check suite on the head commit completed

## Replacing a polling loop

Before, a typical "wait for a review" step looked like this:

```bash
# Old approach: poll every 60 seconds
until [ "$(gh pr view 123 --json reviews -q '.reviews | length')" -gt 0 ]; do
  sleep 60
done
```

With 2.105.0 it becomes a single blocking call:

```bash
PR=https://github.com/OWNER/REPO/pull/123

# Wait up to 30 minutes for the next review
gh event listen --resource "$PR" \
  --event com.github.pull_request.review.submitted.v1 \
  --timeout 30m

if [ $? -eq 8 ]; then
  echo "No review within 30 minutes"
fi
```

By default the command exits after the first event. `--count N` waits for N events, `--follow` keeps streaming until stopped, and `--timeout` accepts seconds or a duration like `10m`. When the timeout wins, the exit status is `8`, so scripts can branch on it. Status messages go to stderr, so stdout carries only events, and `--jq` or `--template` trim each event down:

```bash
gh event listen --resource "$PR" \
  --event com.github.pull_request.check_suite.status.changed.v1 \
  --jq .data.conclusion
```

## Details that will bite you

The events are thin. Each one carries `data.api_url` pointing at the review, PR, or check suite that changed, and you fetch that URL to learn more. A PR usually has several check suites and each fires its own event, so "wait for CI" means reading `gh pr checks` after each event, not trusting the first `success`.

Events are not replayed. Only changes after the stream attaches are delivered, and anything that happens during a reconnect is lost. The [command source](https://github.com/cli/cli/blob/v2.105.0/pkg/cmd/event/listen/listen.go) tells you to read the PR's current state once the "listening" message appears, even if you read it just before. Subscriptions expire after 24 hours, each account has a cap on how many it can hold, and `gh event subscription list` / `delete` manage them.

Availability is narrow for now: the commands are marked preview, Event Streams requires joining a [waitlist](https://gh.io/event-streams-signup), and only pull requests on github.com are supported, not GitHub Enterprise Server or GHE.com. The examples above follow the 2.105.0 help text and were not run against a live stream for this post.

The CLI also nudges agents toward the new path: `gh pr create`, `gh pr view`, `gh run view`, `gh run watch`, and `gh api` now suggest `gh event listen` instead of polling. If you run headless agents that babysit PRs, pair this with [keeping them from stalling on permission prompts](/2026/11/how-to-keep-headless-claude-code-runs-from-stalling-on-permission-prompts/), and the loop can sleep until GitHub has something to say.
