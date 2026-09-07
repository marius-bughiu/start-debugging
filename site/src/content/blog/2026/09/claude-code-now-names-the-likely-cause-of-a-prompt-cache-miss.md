---
title: "Claude Code Now Names the Likely Cause of a Prompt Cache Miss"
description: "Claude Code 2.1.260 adds a likely-cause diagnosis to the Prompt cache (main) line in /usage and to the prompt_cache status line object. Instead of just counting misses, it tells you whether the tool set changed, the system prompt changed, or the TTL expired."
pubDate: 2026-09-07
tags:
  - "claude-code"
  - "ai-agents"
  - "prompt-caching"
  - "token-cost"
---

Claude Code 2.1.260 shipped a diagnostic that closes a long-standing gap in cost debugging: when the prompt cache misses, it now tells you why. Version 2.1.251 had already added a `Prompt cache (main)` line to the Session block in `/usage`, but that line only counted misses. Knowing you paid for three full re-reads of a 300k-token conversation does not tell you what to stop doing. As of 2.1.260, the line names a likely cause, for example `likely cause: tool definitions changed`.

## Why a miss is expensive and invisible

Claude Code re-sends the entire conversation on every turn, so caching is what keeps a long session affordable. The API matches on the request prefix, and the match is exact: a change anywhere in the prefix recomputes everything after it. There is no per-file or per-segment caching. That is why the [prompt caching docs](https://code.claude.com/docs/en/prompt-caching) list a specific set of actions that invalidate the cache, including switching models, connecting or disconnecting an MCP server when tool search is not deferring its tools, denying an entire tool with a bare `Bash` deny rule, and upgrading Claude Code itself.

The problem is that most of these are invisible. A stdio MCP server whose process quietly exits, or an HTTP session that expires, changes your tool definitions mid-session with no message in the transcript. You see one slow turn and a bill.

Claude Code counts a request as a miss when it re-processed more than 5% and at least 2,000 tokens of what it could have read from cache, with no compaction or tool-result clearing to account for the shortfall. Compaction-driven rebuilds get counted separately as expected rebuilds, which keeps the miss count honest.

## Reading the cause from a status line

The interesting part for anyone who scripts their status line is that the diagnosis is structured, not just prose. The `prompt_cache` object gained `last_miss_cause` and `miss_causes` in 2.1.260. The `causes` array holds names such as `tools_changed`, `system_prompt_changed`, `ttl_expired_5m`, or `likely_server_side`, and two of them carry counts: `tools_changed` comes with `tools_added` and `tools_removed`, and `system_prompt_changed` comes with `system_char_delta`.

```bash
#!/bin/bash
input=$(cat)
cause=$(echo "$input" | jq -r '.prompt_cache.last_miss_cause.causes[0] // empty')
ratio=$(echo "$input" | jq -r '.prompt_cache.hit_ratio // 0')
printf "cache %.0f%%" "$(echo "$ratio * 100" | bc -l)"
[ -n "$cause" ] && printf " | last miss: %s" "$cause"
```

`last_miss_cause` is `null` until the session's first miss, and again whenever Claude Code cannot identify a cause, so guard the read. `miss_causes` is the aggregate: a session that shows `tools_changed` five times has a flapping MCP server, not a one-off.

The counts come from the cache token fields in the API response, so the whole thing works on Bedrock, Google Cloud's Agent Platform, and through a gateway. It covers the main conversation only, not subagents, and `/clear` resets it.

The same release also added a `/diff` panel that opens beside the conversation in fullscreen and tracks uncommitted changes as Claude edits. If you are following the release train, [2.1.261 added /skill-doctor](/2026/09/claude-code-2-1-261-skill-doctor-finds-skills-that-only-cost-context/) the next day. Full notes are in the [v2.1.260 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.260), and the field reference is in the [status line docs](https://code.claude.com/docs/en/statusline#prompt-cache-fields).
