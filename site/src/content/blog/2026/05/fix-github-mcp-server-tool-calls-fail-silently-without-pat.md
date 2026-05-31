---
title: "Fix: GitHub MCP server tool calls fail silently when the PAT isn't passed"
description: "GitHub MCP tools show up but every call returns empty or 'Bad credentials'? The token is unset. Put the PAT in the env block, verify with curl, done."
pubDate: 2026-05-31
template: error-page
tags:
  - "errors"
  - "mcp"
  - "claude-code"
  - "cursor"
  - "github"
---

# Fix: GitHub MCP server tool calls fail silently when the PAT isn't passed

The GitHub MCP server connects, the tools appear in Claude Code or Cursor, but every call comes back empty or with `Bad credentials`. Nine times out of ten the `GITHUB_PERSONAL_ACCESS_TOKEN` is unset at runtime: a `-e GITHUB_PERSONAL_ACCESS_TOKEN` Docker flag that inherits nothing from a GUI launched app, a token sitting in the wrong config field, or a fine grained PAT missing the one permission the tool needs. Put the literal token in the `env` block of your MCP config, confirm it with a single `curl` against `/user`, and the calls start returning data. Everything below is tested with Claude Code 2.x and the official server image `ghcr.io/github/github-mcp-server` over stdio, plus the remote endpoint at `https://api.githubcopilot.com/mcp/` (streamable HTTP, MCP spec revision 2025-03-26).

## What the failure actually looks like

The confusing part is that nothing throws. The server process starts, the MCP handshake succeeds, and the client lists the GitHub toolset like normal. Then you ask the agent to "list my open PRs" and you get one of these:

```
Error: Bad credentials (status 401)
```

or, worse, an empty result with no error at all:

```
(no output)
```

The empty case is the one that wastes an afternoon. The GitHub REST API returned a `401`, the MCP server wrapped it as a tool error, and the client rendered the swallowed error as a blank result. From the chat UI it looks like the tool ran and found nothing, when in reality it never authenticated.

## Why the token ends up empty

There are only a handful of root causes, and they all reduce to "the process that calls GitHub never saw a valid token."

- **Docker forwards a variable that does not exist.** The flag `-e GITHUB_PERSONAL_ACCESS_TOKEN` with no `=value` tells Docker to copy the variable from the environment Docker itself runs in. If that environment does not export it, Docker forwards an empty value and the server boots unauthenticated.
- **GUI launch does not inherit your shell.** Claude Desktop or Cursor started from the Start menu, Dock, or Finder does not read your `.zshrc` or `.bashrc`. An `export GITHUB_PERSONAL_ACCESS_TOKEN=...` there is invisible to the spawned MCP process.
- **The token is in the wrong field.** Pasting the PAT into a comment, into `args`, or into the URL instead of the `env` block or the `Authorization` header means the server never receives it.
- **Fine grained PAT missing a permission.** The token is real and authenticates, but it lacks the specific permission a tool needs, so only some calls `401`. This reads as intermittent silent failure.
- **Expired or revoked PAT, or unauthorized SSO.** Fine grained tokens expire (one year maximum), and a token used against an SSO protected org must be explicitly authorized for that org first.

The empty string variant deserves its own callout because it is the most deceptive: a config with `"GITHUB_PERSONAL_ACCESS_TOKEN": ""` starts the server in an unauthenticated state where public, read only calls still work. So `search_repositories` against a public repo returns data, while anything touching a private repo `401`s. That is why it feels like the server is "half working."

## Confirm the token before touching any config

Do not guess. A fine grained or classic PAT either authenticates or it does not, and one request settles it:

```bash
# Works for both classic and fine-grained PATs
curl -s -H "Authorization: Bearer ghp_your_token_here" \
  https://api.github.com/user
```

A good token returns your user object (`"login": "your-handle"`). A bad one returns:

```json
{
  "message": "Bad credentials",
  "documentation_url": "https://docs.github.com/rest"
}
```

If `curl` returns `Bad credentials`, the problem is the token itself (expired, revoked, mistyped), not the MCP wiring. Mint a new one before going further. If `curl` succeeds but the agent still fails, the token is fine and the problem is how the config passes it.

## Fix 1: put the token in the env block (local Docker server)

This is the canonical fix and it removes the dependency on inherited shell environment entirely. In Claude Code, the config lives in `.mcp.json` at the project root (or run `claude mcp add`):

```json
// .mcp.json - Claude Code 2.x, github-mcp-server stdio mode
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

The two pieces work together. The `env` block sets the variable in the environment of the process Claude Code spawns (the `docker` command). The `-e GITHUB_PERSONAL_ACCESS_TOKEN` flag then forwards that variable into the container. Drop the `env` block and rely on the bare `-e` flag, and you are back to "hope the host exported it."

If you would rather keep it on one line, the inline form passes the value directly into the container and skips the `env` block:

```bash
# Claude Code 2.x - inline value, no env block needed
claude mcp add github -- docker run -i --rm \
  -e GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your_token_here \
  ghcr.io/github/github-mcp-server
```

Cursor uses the same JSON shape in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global). Claude Desktop uses `claude_desktop_config.json`. The `env` block is the part that matters in all three.

## Fix 2: use the remote server and skip the PAT plumbing

GitHub hosts the server at `https://api.githubcopilot.com/mcp/`, which means no Docker daemon and no local token forwarding. You authenticate with the `Authorization` header (a PAT) or, in clients that support it, OAuth:

```json
// .mcp.json - remote GitHub MCP server, streamable HTTP
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ghp_your_token_here"
      }
    }
  }
}
```

This collapses an entire class of failure: there is no container environment to misconfigure, and the token lives in exactly one place. If your client supports OAuth for this server, prefer it. OAuth tokens are scoped and refreshed automatically, so you never copy a long lived PAT into a file at all. For a deeper walk through MCP client configuration in both editors, the [Flutter MCP server walkthrough](/2026/05/dart-flutter-mcp-server-claude-code-cursor/) covers the stdio versus HTTP transport choice in detail.

## Fix 3: grant the PAT the permission the tool needs

If `curl` authenticates but specific tools still `401`, the token is under scoped. The mapping depends on the token type.

For a **fine grained PAT**, grant repository permissions explicitly:

- **Metadata: Read only** (mandatory, every call needs it)
- **Contents: Read and write** (file reads, commits)
- **Issues: Read and write** (create, comment, label)
- **Pull requests: Read and write** (open, review, merge)

For a **classic PAT**, the broad `repo` scope covers private repository contents, issues, and pull requests in one switch. Add `read:org` if you call organization level tools.

Two scoping mistakes account for most of the "only some tools work" reports: selecting "Public repositories only" on a fine grained token while pointing it at a private repo, and forgetting that a fine grained token only reaches repositories you explicitly added to its access list.

## Make the silent error loud

The reason this costs an afternoon is that the `401` never reaches the chat window. Surface it before you start changing things.

In Claude Code, launch with MCP debugging so the server stderr is printed:

```bash
claude --mcp-debug
```

In Claude Desktop, read the per server log directly:

```bash
# macOS
tail -f ~/Library/Logs/Claude/mcp-server-github.log

# Windows
# %APPDATA%\Claude\logs\mcp-server-github.log
```

A misconfigured token shows up immediately as a `401` or an authentication warning at startup. Once you can see the real error, the fix is whichever of the three above matches it. If your tool calls are failing in a different way, with a schema or argument complaint rather than an auth error, that is a separate problem covered in [why Anthropic tool calls reject your arguments](/2026/05/fix-tool-call-arguments-did-not-match-schema-in-anthropic-tool-use/).

## Lookalikes that land on this page by mistake

A few failures look identical from the chat window but have nothing to do with the PAT:

- **Docker is not running.** The container never starts, so the server registers as failed rather than silent. The client marks the GitHub server with an error state instead of listing its tools.
- **The server hits the model's tool budget mid task.** Tools stop firing partway through a long run. That is the [tool use limit, not an auth failure](/2026/05/fix-claude-reached-its-tool-use-limit-for-this-turn/), and it resolves differently.
- **Too many MCP servers loaded at once.** If the GitHub tools never appear in the first place, you may be over the client's tool count, which is its own fix.
- **Rate limiting.** A valid token that suddenly returns errors under heavy automation is hitting GitHub's secondary rate limits, returning `403`, not `401`. The distinction is in the log line.

If you are wiring GitHub into a scheduled agent rather than an interactive session, the same `env` block rule applies, and the [recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) shows the full automation setup end to end, including where the token has to live so a headless run can see it.

## The one rule that prevents all of this

Set the token in the `env` block of the MCP config, or in the `Authorization` header for the remote server, and never rely on an exported shell variable being inherited by a GUI launched editor. Verify it once with `curl https://api.github.com/user` so you know the token itself is good before you debug the plumbing. Those two habits turn a silent, intermittent failure into a thirty second check.

## Sources

- [github/github-mcp-server](https://github.com/github/github-mcp-server) - the official server, Docker image, and configuration reference.
- [Using the GitHub MCP server](https://docs.github.com/en/copilot/customizing-copilot/using-model-context-protocol/using-the-github-mcp-server) - GitHub's own setup and PAT guidance.
- [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) - fine grained versus classic scopes and expiry.
- [Claude Code MCP documentation](https://docs.claude.com/en/docs/claude-code/mcp) - `.mcp.json`, `claude mcp add`, and `--mcp-debug`.
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification) - the streamable HTTP transport (revision 2025-03-26).
