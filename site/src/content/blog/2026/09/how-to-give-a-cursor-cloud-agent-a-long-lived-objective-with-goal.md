---
title: "How to Give a Cursor Cloud Agent a Long-Lived Objective with /goal"
description: "Use Cursor's /goal command to keep a cloud agent working toward one finish line across many turns. Covers writing a verifiable objective, pinning a Custom Mode playbook, pairing it with /loop and subscriptions, the CLI's durable goals, and how to stop a goal that ignores Stop."
pubDate: 2026-09-10
template: how-to
tags:
  - "cursor"
  - "ai-agents"
  - "agent-skills"
  - "cloud-agents"
  - "automation"
---

**Short answer:** open a new Cursor chat (a cloud agent if you want it to survive your laptop closing) and type `/goal` followed by an objective that the agent's own output can prove, for example `/goal every test in tests/billing passes 5 runs in a row and CI on this branch is green`. Instead of treating each message as a fresh job, the agent keeps working toward that objective across turns until it is done. Pin a skill as a Custom Mode first if you want it to follow a playbook, add `/loop` or a subscription for recurring check-ins, and archive the run at `cursor.com/agents` if it will not stop, because in-chat Stop only pauses the current turn.

Cursor shipped `/goal` in two steps. The [CLI changelog for August 11, 2026](https://cursor.com/docs/cli/changelog) added "durable goals" with an active or paused status line, and the [August 19, 2026 "Cloud Agents and Cursor Harness Improvements" release](https://cursor.com/changelog/08-19-26) brought it to the agent everywhere, alongside Custom Modes, Subscriptions, and subagents on their own VMs. Both entries say the same thing about availability: `/goal` is rolling out and gated, and if you do not see it, start a new chat. There is no desktop version number to wait for (the last numbered desktop release is Cursor 3.11 from July 10, 2026), so the gate is server-side.

## A message is a job, a goal is a finish line

The [agent overview docs](https://cursor.com/docs/agent/overview) put the distinction in one line: the agent reads each message as a new job. Ask it to "fix the flaky tests" and it fixes what it finds, reports back, and hands control to you. If three tests still flake on the next run, that is your problem to notice and your prompt to write.

A goal changes who decides the work is finished. The objective stays attached to the conversation, and the agent keeps starting new turns against it instead of stopping at the first plausible answer. That is exactly the shape of the changelog's own example, "fix all flaky tests and make CI green": a target that almost never falls in one pass, because fixing one race exposes the next, and "green" is only knowable after a CI run the agent has to wait for.

This is the same primitive that Claude Code added in version 2.1.139 and Codex CLI shipped as Goals earlier in 2026. The concept is identical across the three tools. The details that decide whether a goal actually finishes, especially who judges completion, are not, and Cursor documents far less of them than Anthropic does. More on that below.

## Write the objective like an acceptance test

Cursor does not document how the agent decides a goal is complete. The closest public reference is Claude Code's implementation, where [a separate small model judges the condition after every turn](https://code.claude.com/docs/en/goal) and, critically, "doesn't run commands or read files independently". It only judges what the working agent surfaced in the conversation. Whatever Cursor does internally, writing your objective as if the judge can only read the transcript is the safe assumption, and it produces better goals anyway.

Compare three versions of the same intent:

```text
# Cursor, /goal (rolling out since 2026-08-19)

# Too vague: nothing in the transcript can prove "done"
/goal make the test suite reliable

# Better: measurable, but the agent can satisfy it by deleting tests
/goal every test in tests/billing passes

# Good: one end state, a stated check, and the constraints that matter
/goal `npm test -- tests/billing` exits 0 on five consecutive runs,
the CI workflow on this branch finishes green, no test file is deleted
or marked skip, and no retry wrapper is added. Stop and report after
25 turns if this is not reached.
```

The third version has the three parts that hold up across a long run:

- **One measurable end state.** An exit code, a CI conclusion, a file count, an empty queue.
- **A stated check.** "exits 0 on five consecutive runs" tells the agent what to run and puts the proof in the transcript. For flaky tests, a single green run proves nothing, so the check has to repeat.
- **Constraints.** A goal is an optimizer, and an optimizer takes the cheapest path. The cheapest path to "tests pass" is `it.skip`. Name the shortcuts you forbid.

The last sentence is a budget. Cursor does not expose a documented turn or token cap for goals, so a turn or time clause written into the objective is the only bound you control from the prompt. It is not a hard limit, the agent enforces it on itself, which is why the spend controls in the stopping section below still matter.

## Start the goal in a cloud agent

Local goals in the IDE die with the session: close the lid and the agent stops. For anything that needs to wait on CI, run it as a cloud agent. From the Agents Window, start a new cloud agent on the repository and branch, then send the goal as the first message:

```text
# Cursor cloud agent, new chat, repo: acme/billing, branch: fix/flaky-billing
/goal `npm test -- tests/billing` exits 0 on five consecutive runs,
the "ci" workflow on this branch finishes green, no test file is deleted
or skipped. Open a PR when done. Stop and report after 25 turns.
```

Two pieces of the August releases make cloud goals much more useful than they were a month ago.

First, Subscriptions. Per the [August 19 changelog](https://cursor.com/changelog/08-19-26), cloud agents now automatically subscribe to PRs they create and drive them to completion. When the agent opens the PR and CI starts, it does not need to sit in a polling loop burning turns; it wakes when the PR thread changes, whether that is a check finishing or a reviewer comment. You can also ask it in plain language to "check back in an hour and keep going", which subscribes it to a timer.

Second, startup time. A goal that spans many wake-ups pays the environment boot cost every time the agent resumes on a fresh machine. If your repo takes minutes to install, move that work into a prebuilt environment first; the details are in [cutting Cursor cloud agent startup time with Builds](/2026/08/how-to-cut-cursor-cloud-agent-startup-time-with-builds/).

## Pin a playbook with a Custom Mode

A goal says where to end up. A Custom Mode says how to work on the way there. Custom Modes also shipped on August 19: any skill can be promoted to a mode that stays pinned in the chat, which Cursor describes as an "always on" skill. A normal skill is attached once when invoked; a mode stays in force on every turn, which is what you want when a goal might run 20 turns.

Write the playbook as an ordinary skill. The [skills docs](https://cursor.com/docs/context/skills) load them from `.cursor/skills/` or `.agents/skills/` in the project, and the `icon` and `color` fields exist specifically to style the badge a Custom Mode shows in the chat:

```markdown
<!-- .cursor/skills/flaky-test-hunter/SKILL.md, Cursor (Custom Modes since 2026-08-19) -->
---
name: flaky-test-hunter
description: Playbook for diagnosing and fixing flaky tests in this repo without masking them.
disable-model-invocation: true
icon: beaker
color: orange
---

# Flaky test playbook

1. Reproduce first. Run the suspect file ten times with
   `for i in $(seq 10); do npm test -- <file> || echo FAIL; done`
   and paste the failure count into the conversation before changing code.
2. Classify the flake: shared state, real time, unawaited promise, port or
   file collision, or test order. Say which one and why.
3. Fix the cause, not the symptom. Never add `retry`, `it.skip`,
   `test.todo`, or longer timeouts as the fix.
4. After each fix, rerun the file 10 times and report the new count.
5. Commit each fix separately with the classification in the message.
```

`disable-model-invocation: true` keeps the skill out of ordinary chats so it only applies when you pick it. To activate it, type `/`, highlight `flaky-test-hunter`, and press Option+Enter on macOS or Alt+Enter on Windows (or choose "Use as Mode"). The badge appears, then send the `/goal`. The order matters: set the mode first, so the very first goal turn already follows step 1.

If you already maintain rule files, the [migration from Cursor rules to skills, subagents, and plugins](/2026/08/migrate-cursor-rules-to-skills-subagents-and-plugins/) covers turning them into skills that can double as modes.

## Where /loop fits, and where it does not

The docs suggest pairing a goal with the built-in `/loop` skill "for recurring check-ins while it pursues the objective". `/loop` is older: it shipped in [Cursor 3.5 on May 20, 2026](https://cursor.com/changelog/shared-canvases) and runs a prompt repeatedly on a local schedule until an outcome is reached or you stop it. Give it an interval, or omit one and the agent picks when to wake.

```text
# Cursor 3.5+, local session: goal plus a timed check-in
/goal the "nightly-e2e" workflow passes on main three nights in a row
/loop 2h check the latest nightly-e2e run on main, and if it failed,
diagnose it and push a fix to fix/nightly-e2e
```

The catch is in the word "local". A local `/loop` is tied to the session, so it stops when the IDE closes or the machine sleeps. On a cloud agent, the equivalent is a subscription, either the automatic PR subscription or an explicit "check back in two hours". The practical rule is to use `/loop` when you are at your desk and want a cadence, and a cloud agent with a subscription when the goal has to outlive your working day. If the work is truly recurring rather than goal-shaped (every CI failure, forever), it is not a goal at all; it is an automation, which is what [the `/automate` skill with GitHub triggers](/2026/07/build-a-cursor-automation-with-automate-skill-and-github-triggers/) is for.

## Goals in the Cursor CLI and headless runs

The CLI got goals first. After the August 11 CLI release, `/goal` inside an interactive `agent` session shows an active or paused status line, keeps the goal going across idle periods and headless runs, and pauses it on Ctrl+C.

```bash
# Cursor CLI (changelog 2026-08-11), binary: agent
curl https://cursor.com/install -fsS | bash

cd ~/src/billing
agent
# inside the session:
#   /goal `npm test -- tests/billing` exits 0 on five consecutive runs
#   ...status line shows the goal as active
#   Ctrl+C  -> goal is paused, not cleared
```

"Continues across headless runs" means a goal set in the conversation is still attached when that conversation runs non-interactively, for example after `agent resume`, or in a scripted run that uses the [headless flags](https://cursor.com/docs/cli/headless):

```bash
# Cursor CLI headless (changelog 2026-08-11). Requires CURSOR_API_KEY in CI.
agent -p --force --output-format stream-json \
  "/goal CHANGELOG.md has an entry for every PR merged into main this week"
```

Two warnings for scripted goals. With `--output-format text` nothing prints until the run ends, so a goal that runs 15 turns looks hung in CI logs; `stream-json` shows each step as it happens. And `--force` lets the agent write files without confirmation on every turn of the goal, not just the first, so run it in a disposable checkout. Because the feature is gated per account, confirm `/goal` works interactively before you wire it into a pipeline, otherwise the headless run just treats `/goal ...` as ordinary prompt text.

## Stopping a goal that ignores Stop

This is the part to read before you start a cloud goal on an expensive model. On August 27, 2026 a user reported on the Cursor forum that a [cloud agent running `/goal` ignored explicit stop requests and kept coding for about six hours](https://forum.cursor.com/t/goal-cloud-agent-did-not-stop-continued-for-6-hours-and-burned-tokens/169723). A Cursor staff member confirmed the behaviour: with `/goal`, Stop pauses the current turn but does not always end the goal, so the agent can keep starting new work. The recommended workaround is to archive the run at `cursor.com/agents`, which is more reliable than the Stop button in chat.

So, until that changes:

- **Stop the goal, not the turn.** Archive the agent from `cursor.com/agents` when you want it gone. In the CLI, Ctrl+C pauses; exit the session if you mean it.
- **Write the budget into the objective.** "Stop and report after 25 turns" is not enforced by the harness, but it gives the agent an explicit exit that it reports against.
- **Pick the model deliberately.** The forum report was on an extra-high reasoning model. A goal multiplies per-turn cost by however many turns it takes, so a mid-tier model with a tight objective often finishes cheaper than a frontier model with a vague one.
- **Set a spend ceiling at the team level.** Usage-based limits on the dashboard are the backstop when a prompt-level budget is ignored.

## How Cursor's /goal compares with Claude Code's

If you use both tools, the differences matter more than the shared name. Claude Code's [goal documentation](https://code.claude.com/docs/en/goal) is explicit about mechanics that Cursor has not published yet:

| | Cursor `/goal` | Claude Code `/goal` |
|---|---|---|
| Shipped | CLI 2026-08-11, agent 2026-08-19 (gated) | v2.1.139, May 2026 |
| Who judges completion | Not documented | A separate small fast model after each turn, reading only the transcript |
| Status | CLI status line (active or paused) | `/goal` with no args: condition, elapsed time, turns, tokens, last reason |
| Clear or cancel | Ctrl+C pauses in CLI; archive cloud runs | `/goal clear` (aliases `stop`, `off`, `cancel`) |
| Budget | Only what you write in the objective | Only what you write in the condition |
| Runs without your machine | Yes, as a cloud agent with subscriptions | Via cloud sessions or Routines |
| Playbook pairing | Custom Mode (pinned skill) | Skills, auto mode for unattended tool calls |

The transferable lesson is the one in the objective section: in the one implementation where we can see the judge, it cannot run your tests. Write objectives whose proof lands in the conversation and they will behave in both tools. For a wider view of how the two agents split work, see [Cursor subagents vs Claude Code subagents](/2026/07/cursor-subagents-vs-claude-code-subagents/), and for Claude Code's own delegation options, [subtask vs fork vs background agent](/2026/08/subtask-vs-fork-vs-background-agent-in-claude-code/).

## Gotchas that cost a run

- **Not visible yet.** The rollout is gated. Start a new chat before assuming it is broken; an existing conversation will not pick it up.
- **The agent can "win" dishonestly.** Every forbidden shortcut you forget to name is a shortcut a long goal will eventually find. Test deletion, skipped assertions, loosened timeouts, and `// @ts-ignore` are the usual ones.
- **Subagents multiply cost.** Since August 19, subagents in cloud runs get their own VM with a clean project copy. A goal that fans out to subagents on every turn can burn compute much faster than the turn count suggests.
- **Steering is safe now.** Follow-up messages during a goal no longer cut the agent off mid-action; they wait for the next tool call. Use that to tighten a goal that is drifting rather than stopping and restarting it.
- **Network rules still apply.** A goal that needs to reach a private registry or staging API needs the same egress setup as any cloud agent; if that has to stay on your infrastructure, see [keeping Cursor agent tool execution inside your own network](/2026/09/how-to-keep-cursor-agent-tool-execution-inside-your-own-network/).

A goal is only as good as its finish line. Write one the transcript can prove, fence off the shortcuts, put a turn budget in the sentence, and know where the archive button is before you need it.

### Read next

- [How to Build a Cursor Automation with the /automate Skill and GitHub Triggers](/2026/07/build-a-cursor-automation-with-automate-skill-and-github-triggers/)
- [How to Cut Cursor Cloud Agent Startup Time With Prebuilt Builds](/2026/08/how-to-cut-cursor-cloud-agent-startup-time-with-builds/)
- [Cursor 3.11 Side Chats: Branch a Question Without Derailing the Main Agent](/2026/07/cursor-3-11-side-chats-parallel-agent-threads/)
- [Migrate a Cursor rules file to skills, subagents, and plugins](/2026/08/migrate-cursor-rules-to-skills-subagents-and-plugins/)
- [Auto mode vs manual approval: what each permission mode allows through](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/)

### Sources

- [Cursor changelog: Cloud Agents and Cursor Harness Improvements (August 19, 2026)](https://cursor.com/changelog/08-19-26)
- [Cursor CLI changelog (August 11, 2026: durable goals, sticky skills and custom modes)](https://cursor.com/docs/cli/changelog)
- [Cursor docs: Agent overview, /goal](https://cursor.com/docs/agent/overview)
- [Cursor docs: Agent Skills and Custom Modes](https://cursor.com/docs/context/skills)
- [Cursor docs: Headless CLI](https://cursor.com/docs/cli/headless)
- [Cursor changelog: Shared Canvases and /loop skill (Cursor 3.5)](https://cursor.com/changelog/shared-canvases)
- [Cursor forum: /goal cloud agent did not stop, continued for 6 hours](https://forum.cursor.com/t/goal-cloud-agent-did-not-stop-continued-for-6-hours-and-burned-tokens/169723)
- [Claude Code docs: Keep Claude working toward a goal](https://code.claude.com/docs/en/goal)
