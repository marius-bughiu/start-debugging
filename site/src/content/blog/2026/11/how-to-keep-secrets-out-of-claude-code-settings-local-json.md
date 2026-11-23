---
title: "How to Keep Secrets Out of .claude/settings.local.json When \"Don't Ask Again\" Saves a Token as an Allow Rule"
description: "Choosing \"Yes, and don't ask again\" on a Bash command with an inline token used to write that token into .claude/settings.local.json as an allow rule. What Claude Code 2.1.323 changed, how to find and clean rules that already hold a credential, how to tell if the file is tracked by git, and a tested PreToolUse hook that stops Claude from inlining tokens in the first place."
pubDate: 2026-11-23
template: "how-to"
tags:
  - "claude-code"
  - "ai-agents"
  - "permissions"
  - "security"
  - "secrets"
  - "hooks"
---

**Short answer:** update to Claude Code 2.1.323 or later (published November 12, 2026). Since that release, "Yes, and don't ask again" keeps an allow rule that looks like it holds a secret for the current session only and never writes it to `.claude/settings.local.json`; the same applies when the local file is tracked by git. That fixes new approvals, not old ones: grep every `.claude/settings.local.json` on your machine for tokens, rotate anything you find, replace the rule with a token-free one such as `Bash(gh api *)`, and add a `PreToolUse` hook that blocks Bash commands carrying a literal credential so Claude reads it from an environment variable instead. The current release at the time of writing is 2.1.330 (November 20, 2026).

## How a token ends up in an allow rule

The flow is ordinary. You ask Claude to check why the last CI run failed. It has no signed-in CLI for the job, so it builds a `curl` call and, because your token is sitting in the conversation or in a file it just read, it inlines it:

```bash
curl -H "Authorization: Bearer ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" \
  https://api.github.com/repos/acme/web/actions/runs
```

The permission prompt shows the command, you pick "Yes, and don't ask again" because you expect to run it again, and Claude Code saves an allow rule. The [permissions docs](https://code.claude.com/docs/en/permissions) are explicit about where: a Bash approval is saved "permanently per repository and command" to `.claude/settings.local.json` at the root of the git repository (resolved through worktrees to the main checkout). On a build before 2.1.323 the file ends up like this:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test)",
      "Bash(curl -H \"Authorization: Bearer ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\" https://api.github.com/repos/acme/web/actions/runs)"
    ]
  }
}
```

That is a plaintext credential in a JSON file that nothing treats as a secret store. The behaviour was reported in August 2025 as [anthropics/claude-code#5544](https://github.com/anthropics/claude-code/issues/5544), which asked for credentials to be "sanitized, redacted, or excluded from the auto-approval list"; the issue was closed by the inactivity bot in January 2026 before a fix shipped. Backup tools copy it, dotfile sync scripts pick it up, a teammate pairing on your machine opens it, and a coding agent in a later session can read it like any other project file. If the file is tracked by git, it leaves your machine on the next push.

The rule is also nearly useless as a rule. It matches that exact string with that exact token, so the next time Claude calls a different endpoint, or the token rotates, you get prompted again and probably click "don't ask again" a second time, adding a second copy.

## What Claude Code 2.1.323 changed

The [2.1.323 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) has three entries that matter here:

- "Changed 'don't ask again' so an allow rule that looks like it holds a secret, or would be saved to a `settings.local.json` that git tracks, lasts for the session only and isn't saved."
- "Fixed `.claude/settings.local.json` not being ignored globally when the folder became a git repository later, or on a new machine."
- "Added a start-up warning for Bash allow rules with a `*` in a variable's value, such as `Bash(PORT=* npm run dev)`."

The first one is the direct fix. After updating, the approval still works for the rest of the session, so you are not prompted again for the same command today, but nothing is written to disk. Two consequences are worth knowing before you file a bug:

1. **The prompt comes back next session.** That is intended. If you find yourself approving the same token-bearing command every day, the command is the problem, not the prompt. The sections below show how to rewrite it.
2. **"Looks like it holds a secret" is a heuristic.** The changelog does not publish the detection rules. A GitHub `ghp_` token or an `sk-ant-` key has an obvious shape; a 32-character hex string from an internal service, or a password inside a `postgres://user:pass@host` URL, may not. Treat the change as a safety net, not as a guarantee that every saved rule is clean.

2.1.327 (November 17, 2026) adds a related guard on the other end: "Claude is now told not to commit files that likely contain secrets". It changes what Claude does with `git add`, not what the permission dialog saves.

Check your version with `claude --version` and update with `claude update` (or your package manager) before doing the cleanup below, otherwise the next approval can undo it.

## Is your local settings file tracked by git?

The [settings docs](https://code.claude.com/docs/en/settings) describe the intended setup: the first time Claude Code writes `.claude/settings.local.json` in a git repository that does not already ignore it, it adds `**/.claude/settings.local.json` to your global git excludes file. That file is `core.excludesFile` when your global config sets it, otherwise `$XDG_CONFIG_HOME/git/ignore`, or `~/.config/git/ignore` when `XDG_CONFIG_HOME` is unset.

The catch is that an ignore rule does nothing for a file that is already tracked. If someone committed the file by hand, or it was created before Claude Code started managing the excludes file, git keeps tracking it no matter what the global ignore says. You can see both facts with two commands:

```bash
# git 2.54. Which ignore rule would apply to the file?
git check-ignore -v --no-index .claude/settings.local.json
# /Users/you/.config/git/ignore:1:**/.claude/settings.local.json	.claude/settings.local.json

# Is it tracked anyway? Exit code 0 means yes.
git ls-files --error-unmatch .claude/settings.local.json && echo "TRACKED"

# Has it ever been committed, on any branch?
git log --all --oneline -- .claude/settings.local.json
```

Note the `--no-index` on `check-ignore`. Without it, git skips tracked files entirely and exits with 1, which reads as "not ignored" and sends you looking in the wrong place. In a scratch repository where the file had been force-added, the first command printed the global rule above while `git ls-files --error-unmatch` still reported the file as tracked.

A tracked local file also changes how Claude Code treats it. The docs note that the file's allow rules skip the [workspace trust](https://code.claude.com/docs/en/permissions) step only "while the file stays untracked"; once git tracks it, it goes through trust like the committed `.claude/settings.json`. Since 2.1.323, "don't ask again" will not save to it at all.

To stop tracking it without deleting your local copy:

```bash
git rm --cached .claude/settings.local.json
git commit -m "Stop tracking personal Claude Code settings"
```

If `git log --all` showed earlier commits, the token is in history. Rotate it first. Rewriting history with `git filter-repo --path .claude/settings.local.json --invert-paths` is worth doing for hygiene, but anyone who cloned or forked before the rewrite still has the old objects, and a pushed secret has to be assumed compromised.

## Find the rules that already hold a credential

The 2.1.323 change does not touch files written before it. This script walks a directory tree, checks every `.claude/settings.local.json` and `.claude/settings.json`, prints the line number and a truncated match for anything that looks like a credential, and flags files that git tracks:

```bash
#!/usr/bin/env bash
# audit-allow-rules.sh -- bash 3.2+ / 5.x, git 2.x, macOS or Linux
# Usage: ./audit-allow-rules.sh [root]   (defaults to $HOME)
set -euo pipefail
ROOT="${1:-$HOME}"
PATTERN='gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9_-]{32,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|[Aa]uthorization: *([Bb]earer|[Bb]asic|[Tt]oken) +[A-Za-z0-9._~+/=-]{16,}|(TOKEN|SECRET|PASSWORD|API_KEY)=[^ "$]{12,}'

find "$ROOT" \( -name node_modules -o -name .git \) -prune -o \
  \( -path '*/.claude/settings.local.json' -o -path '*/.claude/settings.json' \) -type f -print 2>/dev/null |
while IFS= read -r file; do
  if grep -Eq "$PATTERN" "$file"; then
    echo "== $file"
    grep -Eno "$PATTERN" "$file" | sed -E 's/(:[^:]{0,12})[^:]*$/\1.../'
    dir="$(dirname "$(dirname "$file")")"
    if git -C "$dir" ls-files --error-unmatch ".claude/$(basename "$file")" >/dev/null 2>&1; then
      echo "   TRACKED BY GIT in $dir: rotate the credential, then remove it from history"
    fi
  fi
done
```

Run against a scratch repository containing the example file from the top of this post, after force-adding it to git, it printed:

```text
== t/repo/.claude/settings.local.json
5:Authorization: Bearer ghp_...
   TRACKED BY GIT in t/repo: rotate the credential, then remove it from history
```

The `sed` step deliberately cuts each match after a dozen characters so the audit output itself does not become another copy of the secret in your terminal scrollback or CI logs. Extend `PATTERN` with the prefixes your own services use; the list above only covers common public formats.

Two other places deserve the same grep, because the token passed through them too:

- **`~/.claude/settings.json`**, if you ever moved a rule to user scope by hand or through `/permissions`.
- **Session transcripts** under `~/.claude/projects/`. Every tool call, including the command text, is stored there as JSON lines. Deleting the allow rule does not remove the token from the transcript of the session that ran it. `grep -rlE 'ghp_[A-Za-z0-9]{36}' ~/.claude/projects` finds them; delete the affected `.jsonl` files or let `cleanupPeriodDays` age them out.

## Replace the rule with one that holds no secret

Once the token is rotated and the rule deleted, give Claude a way to do the same job without ever seeing the credential. In order of preference:

**Use a CLI that is already signed in.** For GitHub, `gh` stores its token in the OS keychain. `gh api repos/acme/web/actions/runs` does what the `curl` did, and the rule you approve is token-free:

```json
{
  "permissions": {
    "allow": ["Bash(gh api *)", "Bash(gh run view *)"]
  }
}
```

The same pattern applies to `aws` with SSO profiles, `gcloud`, `az`, `kubectl` with an exec credential plugin, and `op run` from 1Password. The agent calls the tool; the tool finds the credential.

**Reference the variable, never its value.** When there is no CLI, export the token in the shell that launches Claude Code and teach Claude to use it by name:

```bash
curl -H "Authorization: Bearer $INTERNAL_API_TOKEN" https://ci.internal.example/api/runs
```

Permission rules match the command text before the shell expands it, so an approval of this command stores `$INTERNAL_API_TOKEN` literally, not the value. Do not move the token into the `env` block of a settings file to make this work: that is the same plaintext JSON file you just cleaned.

**Wrap it in a script.** A small `scripts/ci-runs.sh` that reads the token from the environment or a keychain call, with a rule like `Bash(./scripts/ci-runs.sh *)`, keeps both the token and the URL construction out of the command line. This is also the easiest version to allow in a shared `.claude/settings.json`, because the rule is identical for everyone.

**Keep the value out of Claude's reach entirely.** If a prompt-injected session should not be able to read the token at all, a variable in the environment is not enough, since Claude can `echo` it. [Moving the token into a credential gateway or sandbox injection](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/) solves that, and the [`sandbox.credentials` setting](/2026/06/claude-code-sandbox-credentials-block-secrets-from-bash/) stops sandboxed Bash from reading credential files and secret environment variables.

Add one line to `CLAUDE.md` so Claude picks the safe form on its own: "Never put tokens, keys or passwords in a command; read them from environment variables such as `$GITHUB_TOKEN` or use a signed-in CLI."

## Block inline credentials with a PreToolUse hook

An instruction in `CLAUDE.md` is a request. A hook is enforcement. This `PreToolUse` hook reads the Bash command from the hook's JSON input and exits with code 2 when it finds a literal credential, which blocks the call and sends the stderr message back to Claude so it retries with a variable:

```python
#!/usr/bin/env python3
# .claude/hooks/block-inline-secrets.py -- Python 3.9+, Claude Code 2.1.323+
# PreToolUse hook for Bash: refuse commands that carry a literal credential.
import json, re, sys

PATTERNS = [
    r"\bgh[pousr]_[A-Za-z0-9]{36,}\b",          # GitHub classic tokens
    r"\bgithub_pat_[A-Za-z0-9_]{60,}\b",        # GitHub fine-grained PATs
    r"\bsk-ant-[A-Za-z0-9_-]{20,}",             # Anthropic API keys
    r"\bsk-(proj-)?[A-Za-z0-9_-]{32,}",         # OpenAI-style keys
    r"\bxox[abpr]-[A-Za-z0-9-]{10,}",           # Slack tokens
    r"\bAKIA[0-9A-Z]{16}\b",                    # AWS access key IDs
    r"(?i)authorization:\s*(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{16,}",
    r"(?i)\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)=['\"]?[^\s'\"$]{12,}",
]

event = json.load(sys.stdin)
command = event.get("tool_input", {}).get("command", "")

for pattern in PATTERNS:
    if re.search(pattern, command):
        print(
            "Blocked: this command contains a literal credential. "
            "Read it from an environment variable instead (for example "
            "\"$GITHUB_TOKEN\") or use a CLI that is already signed in.",
            file=sys.stderr,
        )
        sys.exit(2)

sys.exit(0)
```

Register it for the Bash tool in `.claude/settings.json` so the whole team gets it:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/block-inline-secrets.py"
          }
        ]
      }
    ]
  }
}
```

Feeding the script hook-shaped JSON for five commands gave these exit codes:

| Command | Exit |
| :- | :- |
| `curl -H "Authorization: Bearer ghp_aaaa...` (36 chars) | 2 (blocked) |
| `curl -H "Authorization: Bearer $GITHUB_TOKEN" ...` | 0 |
| `GITHUB_TOKEN=ghp_aaaa... gh api user` | 2 (blocked) |
| `gh api user` | 0 |
| `psql postgres://u:p@h/db` | 0 (not caught) |

That check ran the script directly with Python, not inside a live Claude Code session, so it confirms the pattern matching and exit codes rather than the end-to-end hook wiring. The last row is the honest limit: credentials embedded in connection URLs, or in formats with no recognizable prefix, pass through. Add patterns for your own formats, and accept that a regex hook narrows the problem rather than closing it.

Because the hook blocks the call before the permission dialog appears, there is never a prompt with a token in it, so there is never a "don't ask again" to click. That also covers machines still on a pre-2.1.323 build. If you want the hook to keep working when Python is missing or the script crashes, read [how to make a Claude Code hook fail closed](/2026/10/how-to-make-a-claude-code-hook-fail-closed-with-onfailure-block/); a guard that fails open on error is a guard that disappears exactly when it breaks.

One interaction to know: a hook that exits 2 denies the call regardless of allow rules, but the reverse is not true. A hook that returns "allow" cannot override a deny or ask rule, which is covered in [why a PreToolUse allow is still blocked by a deny rule](/2026/09/fix-pretooluse-hook-allow-still-blocked-by-deny-rule/).

## For teams: stop local allow rules from accumulating

On a managed fleet you can go further. Claude Code merges `permissions.allow` across scopes unless the organization sets `allowManagedPermissionRulesOnly` in managed settings, in which case only managed rules count and "don't ask again" has nothing to persist into. That is a heavy switch, since every legitimate command then needs a managed rule or a prompt, so most teams are better served by shipping the hook above in managed settings and keeping local rules.

If prompts are the reason people click "don't ask again" on everything, reduce the prompts instead. [Letting sandboxed Bash run without prompts](/2026/11/how-to-let-sandboxed-bash-run-without-permission-prompts-in-claude-code/) removes most of them for commands the OS sandbox already contains, without saving any rule at all.

## Quick checklist

- Run `claude --version`; anything below 2.1.323 still saves secret-looking rules.
- Run the audit script over `$HOME`, then grep `~/.claude/projects` for the same tokens.
- For every hit: rotate the credential, delete the rule, delete or age out the transcript.
- `git ls-files --error-unmatch .claude/settings.local.json` in each repository; `git rm --cached` anything tracked.
- Replace token-bearing rules with signed-in CLIs, `$VARIABLE` references or wrapper scripts.
- Ship the `PreToolUse` hook in `.claude/settings.json` or managed settings.

## Related

- [How to keep API keys out of a coding agent's context with a credential gateway](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/)
- [Claude Code 2.1.187 stops the sandbox from reading your AWS keys](/2026/06/claude-code-sandbox-credentials-block-secrets-from-bash/)
- [Fail-closed vs fail-open hooks for coding agent guardrails](/2026/10/fail-closed-vs-fail-open-hooks-for-coding-agent-guardrails/)
- [Fix: a PreToolUse hook returns "allow" but a deny rule still blocks the tool call](/2026/09/fix-pretooluse-hook-allow-still-blocked-by-deny-rule/)

## Sources

- [Claude Code changelog (2.1.323, 2.1.327)](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Claude Code docs: Permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code docs: Settings](https://code.claude.com/docs/en/settings)
- [Claude Code docs: Hooks reference](https://code.claude.com/docs/en/hooks)
- [anthropics/claude-code#5544: approved bash commands containing credentials are stored as plain text in settings.local.json](https://github.com/anthropics/claude-code/issues/5544)
- [`@anthropic-ai/claude-code` release dates on npm](https://www.npmjs.com/package/@anthropic-ai/claude-code?activeTab=versions)
- [git-check-ignore documentation](https://git-scm.com/docs/git-check-ignore)
