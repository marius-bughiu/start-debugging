---
title: "How to Reduce the Number of MCP Tools Claude Loads to Avoid the Tool-Use Limit"
description: "Five MCP servers can burn 55k tokens and wreck tool-selection accuracy before Claude does any work. How to fix it in Claude Code 2.1.x with ENABLE_TOOL_SEARCH and alwaysLoad, on the raw API with the tool search tool and defer_loading, and on the MCP connector with mcp_toolset. Anchored to claude-opus-4-7, claude-sonnet-4-6, and the 20251119 tool search variants."
pubDate: 2026-05-25
tags:
  - "mcp"
  - "claude-code"
  - "ai-agents"
  - "anthropic-sdk"
  - "tool-use"
---

If you have wired five MCP servers into Claude and selection has gone mushy, the model picks the wrong tool, or you are staring at a "too many tools" warning, the problem is almost never the servers. It is that every tool definition gets loaded into context up front. A typical multi-server setup (GitHub, Slack, Sentry, Grafana, Splunk) is about 58 tools and roughly 55,000 tokens of definitions before you type a single character. There is no single hard cap to dodge so much as two compounding limits: context bloat, and the fact that tool-selection accuracy falls off a cliff once you cross 30 to 50 available tools. The fix in 2026 is the same idea everywhere, with three different switches depending on where you run: defer the tool definitions and load them on demand.

The short version. In Claude Code 2.1.x this is already on: tool search defers all MCP tool definitions and discovers them when a task needs them, controlled by the `ENABLE_TOOL_SEARCH` environment variable. On the raw Messages API you add a tool search tool (`tool_search_tool_regex_20251119` or `tool_search_tool_bm25_20251119`) and mark tools with `defer_loading: true`. For remote servers via the MCP connector you set `default_config.defer_loading: true` inside an `mcp_toolset`. And the bluntest lever of all, which still beats every clever config, is to simply not connect servers you are not using this session. This post covers all four, with exact settings, on `claude-opus-4-7` and `claude-sonnet-4-6`.

## What "the tool-use limit" actually is

There is no error literally named "tool-use limit," which is why the question is confusing. Three separate things hide behind that phrase.

The first is **context cost**. Each tool definition (name, description, every argument name, and every argument description) is serialized into the system prompt prefix. Anthropic's own measurement for a five-server setup is about 55,000 tokens consumed before the conversation starts. On a 200,000 token window that is more than a quarter of your budget spent on tools the model may never call.

The second is **selection accuracy**, and this is the one people misdiagnose as "the model got dumber." Per Anthropic's advanced tool use writeup, Claude's ability to pick the right tool degrades significantly past 30 to 50 tools. With the tool search tool enabled, internal evals moved Opus 4 from 49% to 74%, and Opus 4.5 from 79.5% to 88.1%, on the same tasks. Fewer visible tools is not just cheaper, it is measurably more correct.

The third is a genuine **hard cap in some clients**. Several editors refuse to send a request past a fixed tool count (GitHub Copilot's VS Code tool picker, for example, stops you above 128 selected tools and tells you to deselect some). The Anthropic API itself supports up to 10,000 tools in a catalog when you use tool search, so the cap you hit depends entirely on the client.

All three are solved by the same move: stop loading every definition up front.

## The mechanism: defer and search

Instead of pushing all definitions into the prefix, you expose one small search tool plus a handful of always-on tools. Every other tool is marked deferred. Claude sees only the names it needs to know it can search, runs a query when a task calls for a capability, and the API returns the three to five most relevant tools as `tool_reference` blocks that expand into full definitions inline. Tool search typically cuts definition overhead by more than 85%, loading only the three to five tools actually needed for a request.

Two important properties. Deferred tools are not in the cached prefix, so the expansion happens inline later in the conversation and your [prompt caching](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/) breakpoints stay intact. And once a tool is discovered, the reference is reused across later turns, so Claude does not re-search for a tool it already pulled in.

## Claude Code: it is already on, tune it with ENABLE_TOOL_SEARCH

In Claude Code 2.1.x, MCP tool search is the default. MCP tool definitions are deferred, only names load at session start, and adding another server has near-zero impact on your startup budget. From your side nothing changes about how tools behave. You can see the effect in the `/mcp` panel, which now shows the tool count next to each connected server.

The behavior is controlled by `ENABLE_TOOL_SEARCH`:

```bash
# Claude Code 2.1.x
# Default (unset): all MCP tools deferred, discovered on demand.
# Threshold mode: load tool schemas up front only if they fit in 10% of the
# context window, defer the overflow.
ENABLE_TOOL_SEARCH=auto claude

# Custom threshold, here 5% of the window before deferral kicks in.
ENABLE_TOOL_SEARCH=auto:5 claude

# Force deferral even on Vertex AI or behind a proxy.
ENABLE_TOOL_SEARCH=true claude

# Old behavior: load every MCP tool up front, no deferral.
ENABLE_TOOL_SEARCH=false claude
```

You can also set it in `settings.json` under the `env` field so it sticks per project. Note the platform caveats: tool search needs a model that supports `tool_reference` blocks (Sonnet 4 and later, or Opus 4 and later, with Haiku unsupported in Claude Code), and Claude Code falls back to loading up front on Vertex AI or when `ANTHROPIC_BASE_URL` points at a non-first-party proxy, because most proxies do not forward `tool_reference` blocks. Setting `ENABLE_TOOL_SEARCH=true` overrides that fallback at the risk of a failed request on an unsupported backend.

### Keep a few tools always visible

Search has a cost: a tool the model needs on literally every turn shouldn't pay a search round-trip each time. Exempt those with `alwaysLoad` on the server (Claude Code v2.1.121+):

```json
// .mcp.json (project root)
// Claude Code 2.1.121+
{
  "mcpServers": {
    "core-tools": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "alwaysLoad": true
    }
  }
}
```

Every tool from `core-tools` then loads at session start regardless of `ENABLE_TOOL_SEARCH`, while your other servers stay deferred. Use it sparingly. Each always-loaded tool is context you do not get back, and `alwaysLoad: true` also blocks startup until that server connects (capped at the 5-second connect timeout). A server author can do the same per tool by setting `"anthropic/alwaysLoad": true` in a tool's `_meta`.

If you would rather kill tool search entirely, deny the tool by name:

```json
// settings.json
{
  "permissions": {
    "deny": ["ToolSearch"]
  }
}
```

### The lever everyone forgets: connect fewer servers

Tool search makes a fat MCP setup affordable, but it does not make an unused server free of risk, and a server you never call is one more prompt-injection surface. The cleanest reduction is to scope servers correctly so they only load where you need them. Claude Code has three scopes:

```bash
# Claude Code 2.1.x
# Loads only in the current project, private to you (default).
claude mcp add --transport http stripe --scope local https://mcp.stripe.com

# Shared with the team via .mcp.json in the repo.
claude mcp add --transport http paypal --scope project https://mcp.paypal.com/mcp

# Available across all your projects.
claude mcp add --transport http hubspot --scope user https://mcp.hubspot.com/anthropic
```

A server you only need in one repo should be `local` or `project`, not `user`, so it does not tag along into every other session. For teams, administrators can fix the allowed set centrally with `allowedMcpServers` and `deniedMcpServers` in a managed `managed-mcp.json`. And `/mcp` lets you check and re-authenticate servers interactively mid-session.

One thing tool search does not touch: tool output. That is a separate budget. Claude Code warns when a single MCP tool result exceeds 10,000 tokens and truncates at a 25,000 token default, tunable with `MAX_MCP_OUTPUT_TOKENS`. Reducing the number of tools loaded and capping how much each one returns are two different dials. If a server you do control returns a wall of JSON, the right move is pagination or the `anthropic/maxResultSizeChars` annotation, not raising the global limit.

## The raw Messages API: the tool search tool

If you call Claude directly, you opt in by adding a search tool to your `tools` array and marking everything else deferred. There are two variants. The regex variant has Claude build a Python `re.search()` pattern; the BM25 variant takes a natural-language query.

```python
# anthropic Python SDK, model claude-opus-4-7
# Tool search variants are dated 20251119.
import anthropic

client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=2048,
    messages=[{"role": "user", "content": "What is the weather in San Francisco?"}],
    tools=[
        # The search tool itself must never be deferred.
        {"type": "tool_search_tool_regex_20251119", "name": "tool_search_tool_regex"},
        {
            "name": "get_weather",
            "description": "Get the weather at a specific location",
            "input_schema": {
                "type": "object",
                "properties": {
                    "location": {"type": "string"},
                    "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
                },
                "required": ["location"],
            },
            "defer_loading": True,  # discovered on demand, not in the prefix
        },
        # ...dozens more deferred tools...
    ],
)
```

When Claude needs a capability it emits a `server_tool_use` block running the search, the API answers with a `tool_search_tool_result` containing `tool_reference` blocks, and those expand into full definitions before Claude calls the real tool. You do not handle the expansion yourself; you only have to ensure every tool that could be discovered has a complete definition in the `tools` array.

A handful of rules keep this working:

- **Never defer the search tool.** And you cannot defer *every* tool: at least one must be non-deferred or the request 400s with "All tools have defer_loading set."
- **Keep your 3 to 5 hottest tools non-deferred.** They are the ones used on most requests; paying a search hop for them is wasted latency.
- **Namespace tool names** by service (`github_`, `slack_`, `jira_`) so a single query surfaces the right group, and put searchable keywords in descriptions, because search matches names, descriptions, argument names, and argument descriptions.
- **The regex variant is case-sensitive Python regex, not English.** Use `(?i)` for case-insensitive matching, keep patterns under 200 characters, and remember Claude tends to use broad patterns like `.*weather.*`. If a tool is not being found, test your assumption with `import re; re.search(...)` against the actual tool name.

Model support on the API is broader than in Claude Code: Sonnet 4.0+, Opus 4.0+, and Haiku 4.5+. The catalog can hold up to 10,000 tools, each search returns the 3 to 5 best matches, and usage shows up as `server_tool_use.tool_search_requests` in the response. The feature shipped in November 2025 under the `advanced-tool-use-2025-11-20` beta; add that beta header if your account still requires it. If you want smarter retrieval than regex or BM25, you can implement a custom search tool that returns `tool_reference` blocks from your own embeddings index, and it slots into the same expansion machinery.

## Remote servers via the MCP connector

When you connect a remote MCP server straight from the Messages API (no separate client), tool reduction lives in the `mcp_toolset` object, behind the `mcp-client-2025-11-20` beta header. You get both deferral and hard enable/disable in one place.

```json
// Messages API, beta header: mcp-client-2025-11-20
// model: claude-opus-4-7
{
  "tools": [
    {
      "type": "mcp_toolset",
      "mcp_server_name": "google-calendar-mcp",
      "default_config": {
        "enabled": false,        // start with everything off
        "defer_loading": true
      },
      "configs": {
        "search_events": { "enabled": true, "defer_loading": false },
        "list_events":   { "enabled": true }
      }
    }
  ]
}
```

That is an allowlist: only `search_events` and `list_events` reach the model at all, `search_events` is loaded up front, `list_events` inherits `defer_loading: true`, and every other tool on the server is disabled. Flip it for a denylist by leaving the default enabled and turning off only the dangerous tools:

```json
// Denylist: keep everything except the destructive tools.
{
  "type": "mcp_toolset",
  "mcp_server_name": "google-calendar-mcp",
  "configs": {
    "delete_all_events":       { "enabled": false },
    "share_calendar_publicly": { "enabled": false }
  }
}
```

`enabled: false` is a stronger statement than deferral. A deferred tool is still discoverable and callable; a disabled tool is gone. Use disabling to remove tools you never want this agent to touch, and deferral for tools that are fine to call but rare. The two compose: the precedence is per-tool `configs`, then `default_config`, then system defaults.

## Gotchas worth knowing before you ship

A few sharp edges that are easy to trip over:

- **All-deferred is a hard error.** On the API you must leave at least one non-deferred tool. In an `mcp_toolset` this is fine because the search tooling sits outside the set, but on a raw `tools` array it 400s.
- **Proxies and Vertex AI silently fall back.** Tool search depends on `tool_reference` blocks surviving the round trip. Custom `ANTHROPIC_BASE_URL` proxies usually strip them, so Claude Code disables tool search there unless you force it. If you run through a gateway, verify it forwards the blocks before relying on deferral.
- **Descriptions get truncated in Claude Code.** Tool descriptions and MCP server instructions are cut at 2KB each. With tool search on, those server instructions are how Claude decides *when* to search for your tools, so put the important keywords first.
- **Reducing tools is not the only context fix.** If your real problem is a sprawling repo rather than a sprawling toolset, the lever is structure, not tool count. See [how to structure a monorepo so Claude Code's context stays small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/), and hand heavy read-many-files work to [a subagent with its own scoped tool list](/2026/05/how-to-write-a-claude-code-subagent-that-runs-browser-tests/) so it never pollutes your main context.
- **A deferred tool that hangs still hangs.** Deferral changes when a definition loads, not whether the server works. If a server connects but exposes nothing, that is a different bug; see [why an MCP server hangs on stdio when launched from Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/).

The mental model that ties it together: tool definitions are context, and context is a budget you spend before the work starts. Deferral pushes that spend to the moment of need, disabling removes it entirely, and scoping keeps it out of sessions where it does not belong. If you are also the one writing the server, fewer and better-described tools beat clever client config every time, which is its own argument for [building a tight MCP server rather than dumping your whole API surface into one](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/).

## Related

- [How to structure a monorepo so Claude Code's context stays small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/)
- [How to write a Claude Code subagent that runs browser tests](/2026/05/how-to-write-a-claude-code-subagent-that-runs-browser-tests/)
- [How to build a custom MCP server in Python with the official SDK](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/)
- [How to add prompt caching to an Anthropic SDK app and measure the hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/)
- [Fix: MCP server stdio hang when launched from Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/)

## Sources

- [Tool search tool, Claude API docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [Introducing advanced tool use on the Claude Developer Platform, Anthropic Engineering](https://www.anthropic.com/engineering/advanced-tool-use)
- [Connect Claude Code to tools via MCP, Claude Code docs](https://code.claude.com/docs/en/mcp)
- [MCP connector, Claude API docs](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)
