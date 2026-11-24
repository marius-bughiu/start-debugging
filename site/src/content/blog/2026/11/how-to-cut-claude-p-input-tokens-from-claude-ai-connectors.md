---
title: "How to Cut claude -p Input Tokens When claude.ai Connectors Add Hundreds of Thousands of Tokens to Every Headless Call"
description: "On a claude.ai subscription login, every connector on your account rides along into each claude -p call. With tool search on, that costs a few thousand tokens. Pass --tools without ToolSearch and the full definitions load upfront: one reported health check went from 2,854 to 429,388 input tokens. How to drop the connectors with ENABLE_CLAUDEAI_MCP_SERVERS=false, disableClaudeAiConnectors or --strict-mcp-config, keep the MCP servers you need, and add a token ceiling so the next auto-loaded feature cannot silently come back. Claude Code 2.1.331."
pubDate: 2026-11-24
template: "how-to"
tags:
  - "claude-code"
  - "mcp"
  - "ai-agents"
  - "headless"
  - "token-usage"
  - "automation"
---

**Short answer:** if your script runs `claude -p` on a claude.ai subscription login, Claude Code fetches every connector on your claude.ai account (Slack, Gmail, Drive, Linear, whatever you connected) and adds their tools to each call. Turn that off for the script with `ENABLE_CLAUDEAI_MCP_SERVERS=false claude -p ...`, or with `"disableClaudeAiConnectors": true` in a settings file. If the call needs no MCP servers at all, add `--strict-mcp-config` instead, which loads only the servers you pass with `--mcp-config`. The really large numbers, hundreds of thousands of tokens, come from one specific trap: a `--tools` list that leaves out `ToolSearch`, which makes every MCP tool definition load upfront instead of being deferred. Everything below is checked against the docs and the Claude Code 2.1.331 binary, the current release on 2026-11-24.

## Where 429,388 tokens came from

The case that put this on the map is [anthropics/claude-code#106413](https://github.com/anthropics/claude-code/issues/106413), opened on 2026-10-31. Its author runs `claude -p --output-format json` from a Python program about 20 times a day on a subscription login, no API key. A one-line health check ("reply DAY DESK OK") reported **429,388 input tokens** per call. Adding `--strict-mcp-config` brought the same call down to **2,854**.

The first reading was "the connectors cost 426k on every headless call." A commenter on the issue pushed back with their own numbers on Claude Code 2.1.316 (subscription login, Haiku, "reply OK"), counting input plus cache tokens:

| Flags | Tokens |
|---|---:|
| `claude -p` | ~60k |
| `claude -p --tools ""` | ~276k |
| `claude -p --tools "" --strict-mcp-config` | ~5k |

The original author then confirmed that their program had been passing `--tools ""` on every call all along. So the real mechanism has two parts:

1. **Connectors are loaded into `-p` runs.** The [MCP docs](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claude-ai) say connectors are fetched whenever your active authentication method is a claude.ai subscription login. They list terminal, VS Code, JetBrains and Agent SDK sessions as places where Claude Code fetches them, and they state that "in `claude -p`, Agent SDK, and VS Code sessions, connectors rank above plugin-provided servers". Nothing in the headless docs warns you about this, which is the documentation gap raised in [#38567](https://github.com/anthropics/claude-code/issues/38567).
2. **Tool search normally hides most of the cost.** With tool search on (the default), MCP tools are deferred: Claude sees the tool names and loads a full definition only when it searches for one. In the commenter's plain `claude -p` run, turning the connectors off saved only about 6k tokens. Most of their 60k was their own CLAUDE.md, skills and memory.

The blowup happens when tool search is off. The [Configure tool search](https://code.claude.com/docs/en/mcp#configure-tool-search) section puts it plainly: "If you deny `ToolSearch` or leave it out of `--tools`, MCP tools load upfront instead." `--tools ""` reads like "make this call lighter". In practice it removes `ToolSearch` along with the built-in tools, and every connector's full JSON schema lands in the prompt.

Those are third-party measurements from one Windows machine and one Mac. Your number depends on how many connectors your account has and how big their tool surfaces are. The direction holds, though, and you can measure your own in two minutes (see the last section).

## Which calls are exposed

Your headless calls carry connector definitions in full when **all** of these are true:

- The active auth is a claude.ai subscription login. API keys (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`), third-party providers, and a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` do not fetch connectors at all.
- You have connectors enabled on claude.ai.
- Tool search is off for that call. That happens if you:
  - pass `--tools` with a list that does not include `ToolSearch` (`--tools ""`, `--tools "Read,Grep"`)
  - deny `ToolSearch` in `permissions.deny`
  - set `ENABLE_TOOL_SEARCH=false`
  - set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, which the docs say keeps tool search off even if you set `ENABLE_TOOL_SEARCH` yourself
  - run a model older than Opus 4 / Sonnet 4, or a Microsoft Foundry deployment hosted on Azure, where tool search falls back to upfront loading

If only the first two hold, you still pay something on every call: the deferred tool names, plus the connector fetch at startup. It is small, but in a loop it adds up, and there is no reason for a scripted call that never touches Gmail to carry Gmail's tools.

## Fix 1: drop only the claude.ai connectors

This is the right default for most scripts. It keeps your own MCP servers from `.mcp.json`, `~/.claude.json` and plugins, and removes only what comes from claude.ai.

Per call, with the environment variable:

```bash
# Claude Code 2.1.331, claude.ai subscription login
ENABLE_CLAUDEAI_MCP_SERVERS=false \
  claude -p "Summarize the failing tests in test-output.log" \
  --output-format json
```

Or in Python, where most of these loops live:

```python
# Python 3.12+, Claude Code 2.1.331
import json, os, subprocess

def ask(prompt: str) -> dict:
    env = {**os.environ, "ENABLE_CLAUDEAI_MCP_SERVERS": "false"}
    out = subprocess.run(
        ["claude", "-p", prompt, "--output-format", "json"],
        env=env, capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)
```

For every session on the machine, use the setting instead. It goes in any settings scope, for example `~/.claude/settings.json`:

```json
{
  "disableClaudeAiConnectors": true
}
```

Two properties are worth knowing before you choose between them:

- **The setting is any-source-true.** The docs say `true` in any settings source wins, so a project's `.claude/settings.json` cannot re-enable connectors that your user settings or managed policy turned off. That also means turning it on in user settings affects your interactive sessions, not just the script. If you want connectors interactively but not in the script, use the environment variable or pass the setting only to the script with `--settings '{"disableClaudeAiConnectors": true}'`.
- **It only covers connectors Claude Code fetches itself.** Connectors that a cloud host or the desktop app hands to the session are out of its reach. For a script you launch from a shell, Claude Code is the one fetching, so it applies.

The 2.1.331 binary reports which switch disabled connectors (`env_var` or `setting`), and its schema description for `disableClaudeAiConnectors` adds one detail the docs page does not: when the setting is on, a `claudeai-proxy` server passed explicitly through `--mcp-config` or the SDK's `mcpServers` option does not connect either. The docs page says `--mcp-config` servers are unaffected by `ENABLE_CLAUDEAI_MCP_SERVERS`. If you deliberately route one connector through `--mcp-config`, test it with the env var rather than the setting.

In the issue's follow-up measurements, `ENABLE_CLAUDEAI_MCP_SERVERS=false` alone, still with `--tools ""`, landed on exactly the same 2,854 tokens as `--strict-mcp-config`.

### Dropping just one connector

If the script needs your Linear connector but not the other eleven, deny the rest by name. Connectors show up as `claude.ai <display name>`, which is the string `deniedMcpServers` matches:

```json
{
  "deniedMcpServers": [
    { "serverName": "claude.ai Slack" },
    { "serverName": "claude.ai Gmail" },
    { "serverName": "claude.ai Google Drive" }
  ]
}
```

`deniedMcpServers` is a denylist that blocks a server across all scopes, and the docs also accept URL patterns. Entries that exist only in a project's `.claude/settings.json` or `.claude/settings.local.json` are limited in what they can block, so put this in user settings or pass it to the script with `--settings`. Interactively, `/mcp` can toggle a connector off for the current project only.

## Fix 2: load nothing you did not pass

When a call needs no MCP server, or exactly one, `--strict-mcp-config` is the stricter tool. From the [CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags): it skips the servers configured in `.mcp.json`, `~/.claude.json` or a plugin, and loads the ones you pass with `--mcp-config`. In the issue's measurements it also dropped the claude.ai connectors:

```bash
# Claude Code 2.1.331: no MCP servers at all
claude -p "Classify this log line: $LINE" \
  --output-format json \
  --strict-mcp-config
```

```bash
# Claude Code 2.1.331: exactly one server, nothing else
claude -p "Check today's deploy status" \
  --output-format json \
  --strict-mcp-config \
  --mcp-config ./deploy-status.mcp.json
```

```json
{
  "mcpServers": {
    "deploy-status": {
      "type": "stdio",
      "command": "python",
      "args": ["deploy_status_server.py"]
    }
  }
}
```

The issue author measured that shape too: `--strict-mcp-config --mcp-config <one server>` cost 3,326 tokens against 2,854 without the server, so the +472 was that server's single tool definition and nothing else.

Two things to know:

- **Managed MCP config wins.** If an administrator deployed an enterprise MCP config, 2.1.331 refuses the flag outright: "You cannot use --strict-mcp-config when an enterprise MCP config is present". In that case, use Fix 1.
- **`--mcp-config` waits for servers.** With `-p`, Claude Code waits for pending `--mcp-config` servers to connect before the first turn, up to `MCP_TIMEOUT` (30 seconds by default). A slow server makes every call slow, so keep the one you pass lean.

## Fix 3: keep tool search on when you restrict tools

If you restrict built-in tools to keep a call cheap, add `ToolSearch` to the list, or MCP tools come back in full:

```bash
# Claude Code 2.1.331: built-ins restricted, MCP tools still deferred
claude -p "Find TODOs in src/ and list them" \
  --output-format json \
  --tools "Read,Grep,Glob,ToolSearch"
```

For a call that genuinely needs no tools, `--tools ""` is fine as long as MCP is also gone. Pair it with Fix 1 or Fix 2. The CLI reference also notes that `--tools` "doesn't affect MCP tools" and points at `--disallowedTools "mcp__*"` to deny them. That is a permission rule about calling tools. Do not count on it to reduce what loads into the prompt; removing the servers is the reliable lever.

The same applies to settings that switch tool search off globally. If you set `ENABLE_TOOL_SEARCH=false` because an LLM gateway rejected the `defer_loading` field (covered in the docs under "Tool search through an LLM gateway"), you have also opted every connector into upfront loading. Turn the connectors off on that machine, or use `ENABLE_TOOL_SEARCH=auto:N` so tools load upfront only while their definitions stay under N percent of the context window.

## Why `--bare` is not the answer on a subscription

The headless docs recommend [`--bare`](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode) for scripted calls. It skips hooks, skills, plugins, MCP servers, auto memory and CLAUDE.md, and loads only servers you pass with `--mcp-config`. That would solve the problem, except that "in bare mode, Claude Code never reads OAuth credentials or the system keychain". It needs `ANTHROPIC_API_KEY` or an `apiKeyHelper` passed in `--settings`, which means a separately billed Console account. The issue author ruled that out on purpose.

The docs also say `--bare` "will become the default for `-p` in a future release", with no version or date attached. If you script `claude -p` on a subscription today, pin your Claude Code version in automation and read the changelog before upgrading. When that default flips, your calls will either need explicit flags to keep the subscription login or stop authenticating.

## Going further: the 600-token call

Connectors are the big item, but not the only thing a default `-p` call auto-loads. The issue's leanest row, 600 input tokens for the same health check, stacked these switches on top of `--strict-mcp-config`:

```bash
# Claude Code 2.1.331, subscription login, run from an empty temp directory
cd "$(mktemp -d)"
CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 \
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 \
CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1 \
CLAUDE_CODE_DISABLE_CFC_PROMPT=1 \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
claude -p "Reply OK" \
  --output-format json \
  --tools "" \
  --strict-mcp-config \
  --disable-slash-commands \
  --system-prompt-file ~/prompts/terse.txt
```

What each one removes, per the [environment variable reference](https://code.claude.com/docs/en/env-vars) and CLI reference:

- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`: every CLAUDE.md, user and project, plus auto memory files.
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`: auto memory.
- `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`: the skills and workflows that ship with Claude Code.
- `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`: commit and PR instructions and the git status snapshot.
- `CLAUDE_CODE_DISABLE_CFC_PROMPT=1`: the Claude in Chrome section of the system prompt (2.1.257+).
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`: update checks, telemetry, error reporting and feature-flag fetches. The docs warn that even `0` or `false` disables this traffic, and that flag-gated features become unavailable.
- `--disable-slash-commands`: all skills and commands for the session.
- `--system-prompt-file`: replaces the default system prompt entirely.

Only go this far for calls that are pure text in, text out. A call that edits files or runs commands needs the default system prompt's instructions, and stripping them trades tokens for wrong behaviour. The empty temp directory matters because Claude Code walks up from the working directory looking for CLAUDE.md files; `CLAUDE_CODE_DISABLE_CLAUDE_MDS` covers that, but a clean directory also keeps `.mcp.json` and `.claude/settings.json` from a project out of the call.

## Put a ceiling on it so the next feature cannot sneak back

The most useful idea in the issue thread is not a flag. Every switch above disables one auto-loaded contributor, and a future release can add another one that is on by default. Nothing in the output tells you which contributor added tokens, so the only defence is to measure every call and fail loudly when the input jumps.

The `--output-format json` result carries `usage` with `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`, plus `total_cost_usd`. Sum the three input fields, because a stable connector list becomes a cached prefix and only shows up in the cache counters on repeat calls:

```python
# Python 3.12+, Claude Code 2.1.331
import json, os, subprocess, sys

CEILING = 30_000  # pick ~10x what your normal call costs

def ask(prompt: str, *, extra: list[str] | None = None) -> str:
    env = {**os.environ, "ENABLE_CLAUDEAI_MCP_SERVERS": "false"}
    cmd = ["claude", "-p", prompt, "--output-format", "json", *(extra or [])]
    res = json.loads(subprocess.run(cmd, env=env, capture_output=True,
                                    text=True, check=True).stdout)
    u = res.get("usage", {})
    total_in = (u.get("input_tokens", 0)
                + u.get("cache_read_input_tokens", 0)
                + u.get("cache_creation_input_tokens", 0))
    if total_in > CEILING:
        print(f"token ceiling breached: {total_in} > {CEILING} "
              f"(session {res.get('session_id')})", file=sys.stderr)
    return res["result"]
```

Whether to block or only alert is a judgement call. The issue author alerts once a day and never blocks; a cron job that costs real money per run might reasonably refuse to continue. Either way, an update that quietly adds 50k tokens shows up the same day instead of at the end of the billing period.

Cost is not the only loss. As one reply on the issue pointed out, a cached prefix makes repeat calls much cheaper than the raw count suggests, but a 400k prefix still occupies the context window. A multi-turn headless session starts life near its compaction threshold and gets slower and lossier from the first turn.

## Measure your own baseline first

Before changing anything, find out what your account costs. Run the same trivial prompt three ways and compare:

```bash
# Claude Code 2.1.331
q='Reply with the single word OK.'
sum='.usage | (.input_tokens + .cache_read_input_tokens + .cache_creation_input_tokens)'
claude -p "$q" --output-format json | jq "$sum"
claude -p "$q" --output-format json --tools "" | jq "$sum"
ENABLE_CLAUDEAI_MCP_SERVERS=false claude -p "$q" --output-format json --tools "" | jq "$sum"
```

If the second number is far above the first, your script has the `--tools` trap. If the third is far below the second, connectors are the cause. If all three are high, look at CLAUDE.md files, skills and plugins next. Interactively, `/context` breaks down the same budget by category. The walkthrough on [measuring an agent's fixed token overhead before the first user token](/2026/09/measure-an-agents-fixed-token-overhead-before-the-first-user-token/) covers that for the raw API too.

## Related reading

The same deferral mechanism is explained from the server side in [how to reduce the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/), including `alwaysLoad` and the API's `defer_loading`. If an administrator wants connectors off for a whole team, [managed MCP servers without MDM in Claude Code 2.1.259](/2026/09/claude-code-2-1-259-managed-mcp-servers-without-mdm/) shows the policy route. For the other half of keeping an unattended `-p` job healthy, see [keeping headless Claude Code runs from stalling on permission prompts](/2026/11/how-to-keep-headless-claude-code-runs-from-stalling-on-permission-prompts/) and the end-to-end example of [scheduling a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/).

## Sources

- [anthropics/claude-code#106413: claude.ai connectors add ~426k input tokens to every `claude -p` call](https://github.com/anthropics/claude-code/issues/106413), including the follow-up measurements in its comments
- [anthropics/claude-code#38567: connector availability in `-p` mode is undocumented](https://github.com/anthropics/claude-code/issues/38567)
- [Claude Code docs: Disable claude.ai connectors](https://code.claude.com/docs/en/mcp#disable-claude-ai-connectors)
- [Claude Code docs: Configure tool search](https://code.claude.com/docs/en/mcp#configure-tool-search)
- [Claude Code docs: Use MCP servers from claude.ai](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claude-ai)
- [Claude Code docs: CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags)
- [Claude Code docs: Start faster with bare mode](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)
- [Claude Code docs: Environment variables](https://code.claude.com/docs/en/env-vars)
