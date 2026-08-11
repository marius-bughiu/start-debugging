---
title: "Migrate Off the Archived MCP Reference Servers (GitHub, Postgres, Slack)"
description: "The GitHub, Postgres, and Slack MCP servers from modelcontextprotocol/servers were archived in 2025 and their npm packages are deprecated. They pin SDK 1.0.1, which cannot negotiate past protocol 2024-11-05. Here is the audit script, the current replacement for each, and the two pointers in the archive README that are themselves stale."
pubDate: 2026-08-11
updatedDate: 2026-08-11
template: migration
tags:
  - "migration"
  - "mcp"
  - "ai-agents"
  - "llm"
  - "claude-code"
---

If your `mcp.json` still has a line reading `npx -y @modelcontextprotocol/server-postgres`, you are running a server whose last release was published on December 4, 2024 and which npm has marked deprecated. The same is true of `server-github` (last published April 8, 2025) and `server-slack` (April 25, 2025). All three were moved out of `modelcontextprotocol/servers` into the read-only [`servers-archived`](https://github.com/modelcontextprotocol/servers-archived) repository, which itself has had no commit since May 28, 2025. Budget about thirty minutes per server. Nothing crashes today, but these servers pin `@modelcontextprotocol/sdk@1.0.1`, which caps protocol negotiation at revision `2024-11-05` and therefore cannot do structured tool output, elicitation, or tool annotations. Two of the replacements the archive README points at are stale too, so do not follow it blindly.

## What actually got archived, and what did not

Anthropic split the reference server repo in 2025. Seven servers stayed in `modelcontextprotocol/servers` and are still shipping: `everything`, `fetch`, `filesystem`, `git`, `memory`, `sequentialthinking`, and `time`. As a sanity check, `@modelcontextprotocol/server-filesystem` is on `2026.7.10` and carries no deprecation flag.

Fourteen went to `servers-archived` under a warning the README states in capitals: "NO SECURITY GUARANTEES ARE PROVIDED FOR THESE ARCHIVED SERVERS. These servers are no longer maintained. No security updates or bug fixes will be provided. Use at your own risk."

The three that show up most often in real configs, and what to move to:

| Archived package | Last published | Replacement | Status of replacement |
| ---------------- | -------------- | ----------- | --------------------- |
| `@modelcontextprotocol/server-github` | 2025-04-08 | [github/github-mcp-server](https://github.com/github/github-mcp-server) | v1.9.0, released 2026-08-10 |
| `@modelcontextprotocol/server-postgres` | 2024-12-04 | no official successor | pick from third parties, see below |
| `@modelcontextprotocol/server-slack` | 2025-04-25 | `https://mcp.slack.com/mcp` | GA since 2026-02-17 |
| `@modelcontextprotocol/server-gitlab` | 2025-04-25 | `https://gitlab.com/api/v4/mcp` | GitLab Duo beta, Premium and Ultimate |
| `@modelcontextprotocol/server-puppeteer` | 2025-05-12 | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | active, last push 2026-08-09 |
| `@modelcontextprotocol/server-redis` | 2025-04-25 | [redis/mcp-redis](https://github.com/redis/mcp-redis) | active, last push 2026-08-05 |
| `@modelcontextprotocol/server-sentry` | archived | `https://mcp.sentry.dev/mcp` | hosted, returns 401 without auth |
| `@modelcontextprotocol/server-aws-kb-retrieval` | archived | [awslabs/mcp](https://github.com/awslabs/mcp) | active, last push 2026-08-11 |

Severity is not uniform. Swapping GitHub is a strict upgrade. Swapping Postgres is a decision, because there is no vendor-blessed answer. Swapping Slack changes your auth model from a bot token in an env var to an OAuth user token, which is the one that will surprise your security review.

## Why "it still works" is not a reason to stay

The deprecation notice is the boring argument. The protocol version is the real one.

`@modelcontextprotocol/server-postgres@0.6.2` declares exactly two dependencies: `pg` and `@modelcontextprotocol/sdk@1.0.1`. That SDK is a hard pin, not a caret range. Install it and inspect what versions it can speak:

```bash
# verified 2026-08-11
npm install --no-save @modelcontextprotocol/server-postgres@0.6.2
# npm warn deprecated @modelcontextprotocol/server-postgres@0.6.2:
#   Package no longer supported. Contact Support at https://www.npmjs.com/support for more info.

grep -o "20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]" \
  node_modules/@modelcontextprotocol/sdk/dist/types.js | sort -u
# 2024-10-07
# 2024-11-05
```

Now the same constant in the current SDK, `@modelcontextprotocol/sdk@1.30.0`:

```js
// node_modules/@modelcontextprotocol/sdk/dist/esm/types.js, SDK 1.30.0
export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'
];
```

A modern client and an archived server will still shake hands, because `2024-11-05` is in both lists. What they negotiate down to is a protocol revision from before tool annotations and resource links (`2025-03-26`), before structured tool output and elicitation (`2025-06-18`), and before icons, URL-mode elicitation, and experimental tasks (`2025-11-25`). Grep the two SDK builds for `outputSchema` and `elicitation` and you get 29 hits in 1.30.0 and zero in 1.0.1.

The practical effect: an archived server can only ever hand your model a blob of text. It cannot declare an `outputSchema` so the client parses a typed result, cannot mark a tool read-only with an annotation so a permission gate can auto-approve it, and cannot ask the user a follow-up question mid-call. If you have been wondering why your Postgres tool results arrive as an unparsed string while your other servers return structured content, this is why.

## Pre-flight

Before touching anything:

- Know where your configs live. Claude Code reads `.mcp.json` at the project root plus `~/.claude.json`; Claude Desktop on Windows reads `%APPDATA%\Claude\claude_desktop_config.json`; Cursor reads `.cursor/mcp.json`; VS Code reads `.vscode/mcp.json` and uses a `servers` key rather than `mcpServers`.
- Commit the current config. Every step below is a JSON edit you may want to revert.
- Have credentials ready. The GitHub server wants a PAT or an OAuth login, Slack requires an OAuth consent flow that an admin may have to approve, and the Postgres replacements want a DSN.
- Check whether anything else consumes these servers. A CI job or a [scheduled agent run](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) has its own config file that nobody edits interactively.

## Migration steps

1. **Audit every config for archived servers.** Save this as `audit-archived-mcp.mjs` and point it at each config file. It matches both the npm package names and the old `mcp/*` Docker images, and exits non-zero on a hit so you can wire it into CI.

   ```js
   // audit-archived-mcp.mjs, Node 20+
   // run: node audit-archived-mcp.mjs .mcp.json .cursor/mcp.json
   import { readFileSync } from "node:fs";

   const ARCHIVED = {
     "@modelcontextprotocol/server-github": "github/github-mcp-server",
     "@modelcontextprotocol/server-postgres": "bytebase/dbhub or crystaldba/postgres-mcp",
     "@modelcontextprotocol/server-slack": "https://mcp.slack.com/mcp or korotovsky/slack-mcp-server",
     "@modelcontextprotocol/server-gitlab": "https://gitlab.com/api/v4/mcp",
     "@modelcontextprotocol/server-puppeteer": "microsoft/playwright-mcp",
     "@modelcontextprotocol/server-redis": "redis/mcp-redis",
     "@modelcontextprotocol/server-sentry": "https://mcp.sentry.dev/mcp",
     "@modelcontextprotocol/server-sqlite": "bytebase/dbhub in sqlite mode",
     "@modelcontextprotocol/server-aws-kb-retrieval": "awslabs/mcp",
   };
   const DOCKER = /^mcp\/(github|postgres|slack|gitlab|puppeteer|redis|sentry|sqlite)$/;

   let findings = 0;
   for (const path of process.argv.slice(2)) {
     let cfg;
     try { cfg = JSON.parse(readFileSync(path, "utf8")); }
     catch (err) { console.error(`skip ${path}: ${err.message}`); continue; }
     const servers = cfg.mcpServers ?? cfg.servers ?? {};
     for (const [name, def] of Object.entries(servers)) {
       const args = def.args ?? [];
       const hit = args.find((a) => ARCHIVED[a]) ?? args.find((a) => DOCKER.test(a));
       if (!hit) continue;
       findings++;
       console.log(`${path}: "${name}" runs archived ${hit}\n  -> ${ARCHIVED[hit] ?? "vendor server"}`);
     }
   }
   console.log(findings ? `${findings} archived server(s)` : "no archived MCP servers found");
   process.exit(findings ? 1 : 0);
   ```

   Verify: run it against a config you know is clean and confirm it prints "no archived MCP servers found" and exits 0.

2. **Replace the GitHub server.** This is the easy one, because GitHub took over development outright. The archived README says so directly: "Development for this project has been moved to GitHub in the http://github.com/github/github-mcp-server repo." Prefer the hosted remote so you stop pinning a binary version:

   ```json
   {
     "mcpServers": {
       "github": {
         "type": "http",
         "url": "https://api.githubcopilot.com/mcp/",
         "headers": { "Authorization": "Bearer ${input:github_pat}" }
       }
     }
   }
   ```

   If policy requires a local process, run the container instead of npx: `ghcr.io/github/github-mcp-server:1.9.0`. Either way, set `GITHUB_TOOLSETS` to the subset you actually use (`repos,issues,pull_requests` covers most work) and add `GITHUB_READ_ONLY=1` if the agent has no business writing. The old server exposed everything unconditionally, which is one of the reasons it blew through [the tool-use limit](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/).

   Verify: restart the client and confirm the GitHub tools list is non-empty and shorter than before. If tools appear but every call comes back empty, you are hitting the [silent PAT failure](/2026/05/fix-github-mcp-server-tool-calls-fail-silently-without-pat/).

3. **Choose a Postgres replacement deliberately.** There is no official one, and the archived server set a low bar: a single `query` tool wrapped in a `READ ONLY` transaction. Two credible options as of August 2026. [bytebase/dbhub](https://github.com/bytebase/dbhub) is the actively maintained one (last push 2026-08-08, 3,327 stars) and covers Postgres, MySQL, MariaDB, SQL Server, and SQLite behind one DSN:

   ```bash
   # DBHub, verified 2026-08-11
   npx @bytebase/dbhub@latest --transport stdio \
     --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"
   ```

   [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp) has the richer feature set (index tuning, EXPLAIN-plan simulation, health checks) but its last push was 2026-01-22, so you are choosing capability over maintenance velocity. Decide which of those two risks you would rather carry, and write the reason in a comment next to the config entry.

   Verify: ask the agent to list tables, then ask it to run an `UPDATE`. The second should be refused if you configured read-only mode.

4. **Move Slack to the hosted official server.** Slack shipped its own MCP server and made it generally available on February 17, 2026 at `https://mcp.slack.com/mcp`, over JSON-RPC 2.0 on Streamable HTTP with OAuth 2.0 user tokens. It is not read-only: it searches messages, files, users, channels, and emoji, reads threads, posts messages, adds reactions, and creates canvases. Scopes are per-tool, so `search_messages` against private channels needs `search:read.private`, `search:read.im`, and `search:read.mpim` on top of `search:read.public`.

   ```json
   {
     "mcpServers": {
       "slack": { "type": "http", "url": "https://mcp.slack.com/mcp" }
     }
   }
   ```

   The token model is the migration, not the URL. The archived server used a bot token in `SLACK_BOT_TOKEN`, so it saw whatever the bot was invited to. The official server acts as the signed-in user and honours that user's permissions, which means results differ per operator and your workspace admin may need to approve the app first.

   Verify: run `tools/list` through your client's inspector rather than trusting any blog post, including this one. Slack publishes tool definitions at runtime and has changed names and optional fields since the limited release.

5. **Delete the dead entries and re-run the audit.** Remove the old blocks entirely rather than commenting them out, since most clients will happily parse and start a server you thought was disabled. Re-run step 1 across every config path from the pre-flight list and require exit code 0.

## Verification pass

After all three swaps, work through this:

- Every client starts with no error banner. On Claude Code, `/mcp` should list each server as connected.
- Tool counts are sane. If your total tool count jumped, you enabled toolsets you do not need.
- One real query per server: open a PR listing, run a `SELECT`, search Slack for a term you know exists.
- Structured output actually arrives. Call a tool that declares an `outputSchema` and confirm the client shows a parsed object rather than a JSON string. This is the thing you migrated for.
- CI is green. If you added the audit script as a check, confirm it fails on a deliberately reintroduced archived entry.

## Rollback

Rollback is trivial and that is the trap. The archived packages are deprecated, not unpublished, so `npx -y @modelcontextprotocol/server-postgres` will keep resolving to `0.6.2` indefinitely and reverting the JSON restores the old behaviour in seconds. Treat that as an emergency lever with a deadline attached, not as a supported configuration. Deprecated packages do get unpublished eventually, and when that happens your agent fails at startup in whatever unattended run notices last.

## Gotchas worth knowing before you start

**Two pointers in the archive README are stale.** It says the Slack server is "Now maintained by Zencoder" and links [zencoderai/slack-mcp-server](https://github.com/zencoderai/slack-mcp-server). That fork's last push was July 16, 2025 and it has 75 stars, so following the README's advice moves you from one unmaintained server to another. The live community option is [korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server), last push July 16, 2026, 1,779 stars, if you need self-hosting instead of the hosted Slack endpoint. The Postgres entry lists no replacement at all.

**Registry search is literal substring matching.** The official registry does carry the GitHub server, but you have to spell the query the way the name is spelled:

```bash
# 0 results
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=github%20mcp%20server"
# finds io.github.github/github-mcp-server, version 1.9.0
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=github-mcp-server"
```

Two more things to expect from that API. Results include every published version, so `io.github.github/github-mcp-server` came back 51 times in one response and you have to filter on `_meta["io.modelcontextprotocol.registry/official"].isLatest`. And a generic query is close to useless for picking a replacement: `search=postgres` returns 73 entries, dominated by repeated versions of servers from publishers nobody has heard of, with no official Postgres server anywhere in the list. Slack's hosted server is not registered at all, so `search=slack.com` returns nothing. The registry is a lookup table once you know the name, not a discovery tool for finding who owns a category.

**The deprecation warning is invisible in normal operation.** `npm install` prints it, but MCP clients run `npx -y`, and whatever npx writes goes to stderr, where clients either swallow it or misreport it. If your client surfaces it at all, it will probably look like a [server startup error rather than a warning](/2026/07/fix-claude-code-misreads-mcp-server-stderr-as-error/).

**Do not migrate the Git server by mistake.** `servers-archived` contains a `git` directory, but `@modelcontextprotocol/server-git` is also a live server in the maintained repo. The archived copy is a historical snapshot from before the split.

## Related

- [MCP stdio vs HTTP vs SSE transport: which should you choose](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) covers the tradeoff you are making when you move GitHub and Slack from a local process to a hosted endpoint.
- [Migrate an MCP server from SSE to streamable HTTP](/2026/07/migrate-an-mcp-server-from-sse-to-streamable-http/) is the equivalent checklist if you maintain a server rather than just consume one.
- [GitHub's MCP server went stateless and deleted its Redis session store](/2026/07/github-mcp-server-goes-stateless-redis-session-store/) explains why the hosted endpoint is a reasonable default now.
- [How to reduce the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/) is the follow-up work once the replacements are in, since the modern servers expose far more tools than the archived ones did.
- [Claude Code skills vs subagents vs MCP servers](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/) is worth a read before you replace an archived server at all. Some of them should not be replaced with anything.

## Sources

- [modelcontextprotocol/servers-archived](https://github.com/modelcontextprotocol/servers-archived), the archive repository and its security warning.
- [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers), the seven still-maintained reference servers.
- [MCP specification 2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog), for what the newer protocol revisions added.
- [github/github-mcp-server](https://github.com/github/github-mcp-server), for the remote URL, toolsets, and read-only flag.
- [Slack: Real-Time Search API and MCP server now generally available](https://slack.com/blog/news/mcp-real-time-search-api-now-available) and the [Slack MCP server overview](https://docs.slack.dev/ai/slack-mcp-server/) for the endpoint, transport, and scopes.
- [GitLab MCP server documentation](https://docs.gitlab.com/user/model_context_protocol/mcp_server/) for the Duo endpoint and tier requirements.
- [Official MCP Registry](https://registry.modelcontextprotocol.io/), queried on August 11, 2026 for the figures quoted above.
