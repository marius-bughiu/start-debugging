---
title: "Auto Mode vs Manual Approval in Claude Code: What Each Mode Actually Allows Through"
description: "Manual gates every tool call on you. Auto mode gates them on a classifier with 32 built-in block rules. The mode that surprises people is neither: acceptEdits auto-approves rm, mv, and sed, not just file edits. Measured on Claude Code 2.1.123."
pubDate: 2026-08-04
template: vs
tags:
  - "comparison"
  - "claude-code"
  - "ai-agents"
  - "security"
  - "permissions"
---

If you are deciding between leaving Claude Code in Manual mode and switching to auto mode, here is the call: **use auto mode for long tasks inside a repository whose remotes are already configured, and keep Manual (`default`) for work where reading each proposed action is the point.** The mode you should almost certainly stop using as a permanent default is `acceptEdits`, because it does not just auto-approve file edits: it auto-approves `rm`, `rmdir`, `mv`, `cp`, and `sed` as Bash commands too. Everything below is pinned to the six modes Claude Code exposes today (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`), with every behavioural claim either quoted from the [permission modes reference](https://code.claude.com/docs/en/permission-modes) or measured locally on **Claude Code 2.1.123 on Windows 11**.

## The six modes, and the one line that separates them

The mode sets the baseline for what runs without a prompt. Rules layer on top and apply in every mode.

| Mode                | Runs without asking                                            | Blast radius if the model is wrong                    |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `default` (Manual)  | Reads and the built-in read-only Bash set                       | Nothing. You clicked it                               |
| `acceptEdits`       | Reads, file edits in cwd, plus `mkdir` `touch` `rm` `rmdir` `mv` `cp` `sed` | Any file under your working directory                 |
| `plan`              | Reads, plus classifier-approved commands when auto mode is available | Nothing writes to your source                         |
| `auto`              | Everything the classifier does not block                        | Whatever 32 built-in block rules miss                 |
| `dontAsk`           | Only your `permissions.allow` rules and read-only Bash          | Exactly what you pre-approved                         |
| `bypassPermissions` | Everything, including writes to `.git` and `.claude`            | Your machine                                          |

`Shift+Tab` cycles `default` to `acceptEdits` to `plan`. The other three are opt-in: `auto` appears once your account meets its requirements, `bypassPermissions` only appears after you start the session with `--permission-mode bypassPermissions` or `--dangerously-skip-permissions`, and `dontAsk` never appears in the cycle at all. You set that one with the flag:

```bash
# Claude Code 2.1.123 - all six values are valid for --permission-mode
claude --permission-mode dontAsk
```

The mode named "Manual" in the UI is still `default` in every config file, hook payload, and SDK call. That rename [landed in v2.1.200](/2026/07/claude-code-2-1-200-renames-default-permission-mode-to-manual/) and `manual` is accepted as an alias, but `default` is the value to check into a shared repo.

## What "asks" turns into when nobody is there

Every mode table in the docs is written for an interactive session, where a gated action produces a prompt. In [non-interactive mode](https://code.claude.com/docs/en/headless) there is nobody to prompt, so "asks" becomes "denies" and the denial lands in the `permission_denials` array of the JSON result. That makes the modes measurable.

Each row below is a fresh git repository, one prompt, `--max-turns 4`, on Claude Code 2.1.123:

```bash
# the harness for every row: fresh repo, one settings.json, one prompt
claude -p "Use the Write tool to create the file src/new.txt containing exactly: ok" \
  --permission-mode "$MODE" --max-turns 4 --output-format json
```

| Probe                                            | Mode          | `permission_denials` | On disk afterwards |
| ------------------------------------------------ | ------------- | -------------------- | ------------------ |
| `Write src/new.txt`                              | `default`     | `Write`              | absent             |
| `Write src/new.txt`                              | `acceptEdits` | empty                | created            |
| `Write src/new.txt`                              | `plan`        | empty                | absent             |
| `Write src/new.txt`                              | `dontAsk`     | `Write`              | absent             |
| `Write src/new.txt`, with `allow: ["Edit(**)"]`  | `dontAsk`     | empty                | created            |
| `mkdir sub`                                      | `default`     | `Bash`               | absent             |
| `mkdir sub`                                      | `acceptEdits` | empty                | created            |
| `node -e "console.log(1+1)"`                     | `acceptEdits` | `Bash`               | n/a                |
| `ls src`                                         | `default`     | empty                | command ran        |
| `ls src`                                         | `dontAsk`     | empty                | command ran        |
| `Write src/new.txt`, `allow` and `ask` both `Edit(**)` | `acceptEdits` | `Write`        | absent             |
| `Write .claude/probe.json`, with `allow: ["Edit(**)"]` | `acceptEdits` | `Write`              | absent             |

Five things in that table are worth stopping on.

**`plan` mode records no denial.** The file was not written, but `permission_denials` came back empty and the run reported success. Plan mode steers the model rather than gating a tool call, so the block never reaches the permission layer. If you are scripting a check on `permission_denials` to decide whether a run was constrained, plan mode will look identical to a clean run.

**`dontAsk` is `default` with the prompt replaced by a denial.** The Write call was refused with an explicit "denied by the permission mode" message, and the identical run with one `Edit(**)` allow rule succeeded. That is the whole mode: your allowlist, the built-in read-only Bash set, and nothing else. It is the right choice for CI, because the session can never stall waiting for input.

**`acceptEdits` covers `mkdir` but not `node -e`.** The filesystem command set is fixed: `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, and `sed`, plus safe wrappers such as `timeout`, `nice`, and `nohup` and env prefixes such as `LANG=C`. With the [PowerShell tool](https://code.claude.com/docs/en/tools-reference) enabled it also covers `Set-Content`, `Add-Content`, `Clear-Content`, and `Remove-Item`. Anything else, including an inline interpreter call, still gates.

**An `ask` rule outranks both your allow rule and the mode.** Adding `Edit(**)` to `ask` while it was also in `allow`, with `acceptEdits` active, produced a `Write` denial. Rules evaluate deny, then ask, then allow, and specificity does not break the tie. This is the mechanism behind the `Bash(git push *)` recipe further down: an explicit `ask` rule is the one thing that reliably prompts in every mode, including `auto` and `bypassPermissions`. The mirror image is that `ls src` ran with no denial in both `default` and `dontAsk`, because the built-in read-only Bash set is exempt in every mode and is not configurable.

**An allow rule does not open a protected path.** The last row is the important one. With `acceptEdits` active *and* `Edit(**)` in the allow list, writing `.claude/probe.json` was still denied. That is by design: the protected-path check runs before Claude Code evaluates allow rules from settings, so no `Edit(.claude/**)` entry anywhere in your settings chain changes the outcome.

## The protected paths, and which mode ignores them

Writes to a fixed set of paths are never auto-approved outside `bypassPermissions`:

| Mode                     | Protected-path writes                      |
| ------------------------ | ------------------------------------------ |
| `default`, `acceptEdits` | Prompted                                   |
| `plan`                   | Prompted, or classifier-routed during planning with auto mode available |
| `auto`                   | Routed to the classifier                   |
| `dontAsk`                | Denied                                     |
| `bypassPermissions`      | Allowed                                    |

The list is the configuration that decides what runs next time: `.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`, and `.claude` (except `.claude/worktrees`), plus files including `.gitconfig`, `.bashrc`, `.zshrc`, `.envrc`, `.npmrc`, `.pre-commit-config.yaml`, `.mcp.json`, and `.claude.json`. An agent that can rewrite `.envrc` or `.pre-commit-config.yaml` can arrange for arbitrary code to run the next time you `cd` into the directory or commit, which is why this check sits above your own allow rules rather than beside them.

Note that this is a *path* check, not a tool check. If you have been trying to protect paths with `Write(...)` rules, read [why a Write path rule is accepted and then never consulted](/2026/08/fix-write-rule-is-not-matched-by-file-permission-checks/) first, because that rule has never fired in any mode.

## What auto mode actually blocks, printed from your own install

The interesting thing about auto mode is that its rule list is not a marketing page. It is data you can print:

```bash
# Claude Code 2.1.123 - prints the built-in classifier rules as JSON, no network call
claude auto-mode defaults

# the same lists with your settings merged in
claude auto-mode config
```

On 2.1.123 that returns **32 `soft_deny` rules, 8 `allow` rules, 5 `environment` slots, and an empty `hard_deny` list**. The labels give you the shape of the threat model without reading all of it:

```text
soft_deny: Git Destructive, Git Push to Default Branch, Code from External,
  Cloud Storage Mass Delete, Production Deploy, Remote Shell Writes,
  Production Reads, Blind Apply, Logging/Audit Tampering, Permission Grant,
  TLS/Auth Weaken, Security Weaken, Create Unsafe Agents, Interfere With Others,
  Modify Shared Resources, Irreversible Local Destruction, Create RCE Surface,
  Expose Local Services, Credential Leakage, Credential Exploration,
  Data Exfiltration, Exfil Scouting, Sandbox Network Callback,
  Trusting Guessed External Services, Create Public Surface,
  Untrusted Code Integration, Unauthorized Persistence, Self-Modification,
  Memory Poisoning, External System Writes, Content Integrity / Impersonation,
  Real-World Transactions

allow: Test Artifacts, Local Operations, Read-Only Operations,
  Declared Dependencies, Toolchain Bootstrap, Standard Credentials,
  Git Push to Working Branch, Memory Directory
```

Two version-specific details in that output. The `environment` section prints only the five trust slots (trusted repo, source control, trusted internal domains, trusted cloud buckets, key internal services) because 2.1.123 predates v2.1.195, which added the context and sensitivity slots. And `hard_deny` is empty on this build, so every default rule is a *soft* block that explicit user intent can clear. Current releases ship a built-in data-exfiltration rule in `hard_deny`, which nothing overrides. If you are deciding how much to trust auto mode, run the command on the version you actually have rather than reading the current docs.

The rules are prose, not patterns. The `Git Destructive` entry, for example, blocks force pushes and remote history rewrites, and explicitly clears `git commit --amend` when it is a message-only reword of a commit the agent created in this session. That is the same intent-based distinction Anthropic shipped when [auto mode stopped running destructive git and IaC commands](/2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands/), now visible as the literal rule text.

## The three things auto mode allows that people assume it blocks

Reading the block list is the easy half. The `allow` list is where the surprises are.

**Pushing to any branch of your repository, including the default branch.** Since v2.1.211 this is allowed by default. The push's *content* is still checked, so a force push or a commit carrying a secret is blocked, but "auto mode will stop it from pushing to main" has not been true for several releases. A branch whose name marks it as a deploy target, such as `production` or `gh-pages`, is judged on its own terms.

**Reading `.env` and sending those credentials to their matching API.** The `Standard Credentials` allow rule covers exactly that: using a key for the service it belongs to is normal work. Sending it anywhere else hits `Credential Leakage`.

**Installing whatever your lock file declares.** `Declared Dependencies` and `Toolchain Bootstrap` are allowed, so `npm ci` runs unattended and executes whatever install scripts your dependency tree contains. Auto mode's classifier is not a supply-chain gate.

If you want a hard checkpoint on any of these while keeping auto mode on everything else, the mechanism is a content-scoped `ask` rule, which is evaluated before the classifier and always prompts:

```json
// ~/.claude/settings.json - forces a prompt even in auto and bypassPermissions
{
  "permissions": {
    "ask": ["Bash(git push *)", "Bash(gh pr create *)"]
  }
}
```

## How a tool call is actually resolved in auto mode

The decision order is fixed, and the first matching step wins:

1. Your `allow`, `ask`, and `deny` rules resolve immediately. Protected-path writes route to the classifier even when an allow rule matches.
2. Read-only actions and file edits in your working directory are auto-approved, except protected paths.
3. Everything else goes to the classifier.
4. If the classifier blocks, Claude gets the reason and tries something else.

Step 1 has a consequence people miss: **entering auto mode drops your broad allow rules.** Blanket `Bash(*)` or `PowerShell(*)`, wildcarded interpreters like `Bash(python*)`, package-manager run commands, and `Agent` allow rules are all suspended while auto mode is active, and restored when you leave. Narrow rules like `Bash(npm test)` carry over, which is its own gap: the classifier never sees a command an allow rule already approved. Closing it takes one setting:

```json
// ~/.claude/settings.json - requires Claude Code 2.1.193 or later
{
  "autoMode": { "classifyAllShell": true }
}
```

That trades latency for coverage, since every shell command now waits on a classifier round trip. Worth it on a machine with production credentials in the environment; not worth it on a scratch repo.

Two more properties of the classifier are worth internalising. It runs on Claude Sonnet 5 by default rather than your `/model` selection, and its calls count against your token usage. And it sees your messages, the tool calls, and your `CLAUDE.md` content, but **tool results are stripped**, so a hostile string in a file or a fetched web page cannot address the classifier directly. That is a meaningfully different posture from `bypassPermissions`, which the docs describe plainly: it "offers no protection against prompt injection or unintended actions."

## Boundaries you type are not rules

You can tell Claude "do not push until I have reviewed this" and the classifier will honour it, because it re-reads your messages on every check. That is genuinely useful and it is also the most fragile control in the system: the boundary lives in the transcript, so [context compaction](https://code.claude.com/docs/en/costs) can remove the message that stated it, and the boundary goes with it. A `permissions.ask` or `permissions.deny` rule is the durable version of the same instruction.

The same distinction applies to `CLAUDE.md`. The classifier does read it, so a line like "never force push" steers both Claude and the classifier. But instructions shape what the model *tries*, and only rules change what the harness *allows*. That gap is the whole reason [a CLAUDE.md that changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) is a separate skill from writing permission rules.

## When auto mode gives up

Denials are not silent. Each one shows a notification and lands in `/permissions` under **Recently denied**, where pressing `r` marks it for retry with a manual approval. If the classifier blocks 3 actions in a row, or 20 in total, auto mode pauses and Claude Code goes back to prompting. Neither threshold is configurable.

In headless mode with `-p`, repeated blocks abort the session instead, because there is no prompt to fall back to. If you run [a background agent that commits and opens a draft PR](/2026/07/run-a-background-coding-agent-that-auto-commits-and-opens-a-draft-pr/) under auto mode, budget for that failure path: a run against unfamiliar infrastructure can die three denials in, having done half the work. The fix is usually not a looser mode but `autoMode.environment` entries naming the registry, bucket, or source-control org the classifier keeps treating as external.

## The gotcha that picks for you

Three constraints override preference entirely.

**`bypassPermissions` cannot be entered mid-session.** You either started with it enabled or you did not, and on Linux and macOS Claude Code refuses to start in that mode as root or under `sudo` unless it detects a recognised sandbox. That is deliberate: the mode is for disposable containers, not for a shell you happen to be in.

**Auto mode has a model floor.** On the Anthropic API and Claude Platform on AWS it needs Opus 4.6 or later, Sonnet 4.6 or later, or Fable 5. On Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, and signed-in Claude apps gateway sessions, only Sonnet 5, Opus 4.7 or later, and Fable 5 qualify. Sonnet 4.5, Opus 4.5, and every Haiku are out on all providers. "Auto mode is unavailable" is a requirements failure, not an outage.

**A repository cannot grant itself auto mode.** Claude Code v2.1.142 and later ignore `defaultMode: "auto"` in `.claude/settings.json` and `.claude/settings.local.json`. It only takes effect from `~/.claude/settings.json` or managed settings. If you set it in the project file and the session starts in Manual with no error, that is why.

## The recommendation, with the context behind it

**Use auto mode as your working default** on a repo you already own, with `autoMode.environment` filled in for your source-control org and internal services. You get 32 categories of blocking that a human clicking "yes" at speed does not provide, plus a classifier that cannot be addressed by hostile file contents.

**Keep Manual for sensitive work**, meaning anything where reading the exact command is the point: infrastructure, migrations, a repo you just cloned. Manual is not "safer" in the abstract; it is safer exactly in proportion to how carefully you read the prompts.

**Use `dontAsk` in CI**, never `bypassPermissions`. A CI job with a pre-declared allowlist that fails closed is strictly better than one that cannot say no.

**Stop leaving `acceptEdits` on as a permanent default.** It is the right mode for a review-the-diff-afterwards loop and the wrong one to forget about, because its Bash set includes `rm` and `sed`, and unlike auto mode nothing is scoring the blast radius of the specific call.

**Treat `bypassPermissions` as a container-only mode.** If your reason for wanting it is prompt fatigue, auto mode is the answer; if it is that the classifier keeps blocking something, `autoMode.environment` is the answer.

## Related

- [Why a `Write(src/**)` permission rule never matches](/2026/08/fix-write-rule-is-not-matched-by-file-permission-checks/) covers the rule syntax that layers on top of every mode here, including the path anchors and the deny-then-ask-then-allow precedence.
- [Claude Code 2.1.200 renames the default permission mode to Manual](/2026/07/claude-code-2-1-200-renames-default-permission-mode-to-manual/) is the release that split the UI label from the config value.
- [Auto mode stops running destructive git and IaC commands](/2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands/) is where several of the `soft_deny` rules above first shipped.
- [Locking down a coding agent's network egress with a host allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/) is the OS-level layer underneath all of this, and the only one that survives an arbitrary subprocess.
- [Gating Cursor SDK tool calls with auto-review and permissions.json](/2026/06/gate-cursor-sdk-tool-calls-with-auto-review-and-permissions-json/) shows how a different agent models the same auto-versus-manual tradeoff.

## Sources

- [Choose a permission mode](https://code.claude.com/docs/en/permission-modes), Claude Code documentation: the mode table, the `acceptEdits` filesystem command set, the protected-path matrix, the classifier decision order, and the fallback thresholds.
- [Configure auto mode](https://code.claude.com/docs/en/auto-mode-config), Claude Code documentation: `autoMode.environment`, the four-tier `hard_deny` / `soft_deny` / `allow` / intent precedence, `classifyAllShell`, and the `claude auto-mode` subcommands.
- [Configure permissions](https://code.claude.com/docs/en/permissions), Claude Code documentation: rule precedence, the built-in read-only Bash set, and how permissions interact with sandboxing.
- Rule counts, rule labels, and every row of the headless probe table measured locally on Claude Code 2.1.123 (Windows 11) with `claude auto-mode defaults` and `claude -p --output-format json`.
