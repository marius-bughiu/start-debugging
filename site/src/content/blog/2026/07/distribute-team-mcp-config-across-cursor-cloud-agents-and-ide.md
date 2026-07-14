---
title: "How to Distribute a Team MCP Server Config Across Cursor Cloud Agents and the IDE"
description: "Commit .cursor/mcp.json for the IDE, register shared servers under Dashboard > Integrations & MCP for cloud agents, and keep secrets out of git with ${env:...}. The full two-surface setup for Cursor 3.11 (July 2026), including why the repo file alone does not reach cloud agents."
pubDate: 2026-07-14
tags:
  - "cursor"
  - "mcp"
  - "ai-agents"
  - "cloud-agents"
---

If your team has three developers running Cursor locally and a fleet of cloud agents opening PRs overnight, you have two completely separate places MCP servers get configured, and getting them to agree is the whole problem. A committed `.cursor/mcp.json` reaches every teammate's IDE the moment they pull, but it does not automatically reach the cloud agents at `cursor.com/agents`. Those draw from a team-level list an admin registers in the dashboard. Get this wrong and you end up with an agent that has the GitHub MCP server locally but loses it the second it runs in the cloud, or a secret API key checked into git because someone pasted it into the wrong file. This walks through both surfaces on Cursor 3.11 (released July 10, 2026), against the MCP spec revision `2026-03-26`, so your servers show up in the same shape everywhere and no key ever touches a commit.

## The two surfaces, and why one file cannot cover both

Cursor reads MCP configuration from two file locations for the IDE:

- `.cursor/mcp.json` in the project root: project-specific, and the one you commit.
- `~/.cursor/mcp.json` in the home directory: global, per-developer, never in git.

That covers the editor. Cloud agents are a third thing. When an agent runs at `cursor.com/agents`, it boots a fresh VM and pulls MCP servers from your team configuration and the MCP dropdown, not from the repo file that your IDE happens to read. The official [Cursor MCP docs](https://cursor.com/docs/mcp) are explicit that team admins configure shared servers under **Dashboard > Integrations & MCP**, and that "these servers are available to Cloud Agents." So the mental model is:

- **IDE distribution** = the committed `.cursor/mcp.json`.
- **Cloud agent distribution** = the team MCP list in the dashboard.

You need both, and you want them to describe the same servers so behavior does not drift between "I ran it locally" and "the cloud agent ran it." The rest of this is how to author each surface once and keep them in sync.

## Author the committed project file first

Start with `.cursor/mcp.json` because it is the source of truth your team reviews in PRs. The root key is `mcpServers`, and each entry is either a stdio server (Cursor launches a local process) or a remote server (Cursor connects to a URL).

```json
// .cursor/mcp.json -- committed to the repo, Cursor 3.11, MCP spec 2026-03-26
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_MCP_PAT}"
      }
    },
    "internal-api": {
      "url": "https://mcp.internal.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:INTERNAL_MCP_TOKEN}"
      }
    }
  }
}
```

Two server shapes are on display here. The `github` entry is stdio: `type` is `"stdio"`, `command` is the executable (`npx`, `python`, `docker`, `uvx`), `args` is the argument array, and `env` carries process environment variables. The `internal-api` entry is remote: it has a `url` (HTTP or Streamable HTTP endpoint) and a `headers` object instead of a command. If you are unsure which transport a given server should use, the tradeoffs are laid out in [MCP stdio vs HTTP vs SSE transport](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/); the short version is stdio for a process one client launches locally, Streamable HTTP for anything remote or shared.

The critical detail for a team file is that neither entry contains a literal secret. Both use `${env:...}` interpolation, which Cursor resolves in the `command`, `args`, `env`, `url`, and `headers` fields. That is what makes the file safe to commit.

## Keep every secret out of the committed file

`${env:GITHUB_MCP_PAT}` tells Cursor to read the `GITHUB_MCP_PAT` environment variable at launch and substitute it in. The token lives in each developer's shell or Cursor's own secrets store, never in the JSON. This is the single most common way teams leak a key: they get the server working by pasting the raw token into `env`, then commit the file without stripping it back out. If you have ever seen GitHub MCP tools appear but every call return "Bad credentials," the mirror image of that bug (an unset token) is covered in [GitHub MCP server tool calls fail silently when the PAT isn't passed](/2026/05/fix-github-mcp-server-tool-calls-fail-silently-without-pat/); the fix there and the discipline here are the same coin.

Cursor also supports a few other interpolation tokens that make a shared file portable across machines:

- `${userHome}` -- the developer's home directory.
- `${workspaceFolder}` -- the project root, so `${workspaceFolder}/tools/mcp_server.py` resolves per checkout.
- `${workspaceFolderBasename}` -- the project root's directory name.
- `${pathSeparator}` (or `${/}`) -- the OS path separator, for Windows/Unix portability.

So a stdio server that ships as a script inside the repo can be referenced without hardcoding anyone's absolute path:

```json
// .cursor/mcp.json -- a repo-local stdio server, path resolved per checkout
{
  "mcpServers": {
    "repo-tools": {
      "type": "stdio",
      "command": "python",
      "args": ["${workspaceFolder}/tools/mcp_server.py"],
      "env": { "LOG_LEVEL": "info" }
    }
  }
}
```

For local developers, the tokens themselves go in the shell profile or in Cursor's **Settings > Secrets** tab, which is the recommended place rather than a plaintext dotfile. Document the required variable names in your README so a new teammate knows which secrets to set before the servers will connect.

## Register the same servers for cloud agents

Now the second surface. A committed `.cursor/mcp.json` gives every teammate the servers in their editor, but a cloud agent at `cursor.com/agents` will not have them until they exist in the team configuration. An admin adds them once under **Dashboard > Integrations & MCP**. Both transports work there: stdio servers run inside the cloud VM and can receive `env`, and remote HTTP servers connect out, with OAuth supported for servers that need it.

Registering a server in the dashboard does not force it onto everyone. Per the docs, selecting **Add to Team Marketplace** under **Team MCP Servers** "links the server to the Default team marketplace without interrupting Cloud Agent access," and "linking an MCP server to a marketplace does not install or enable it for everyone." Teammates still install it from the Customize page. So the flow is: the admin registers and marketplaces the server, cloud agents get it as an available option, and humans opt in from Customize when they want it in their own IDE on top of the repo file.

For per-run control, an agent picks which registered servers are active through the **MCP dropdown** at `cursor.com/agents`. That is how you keep a background PR agent scoped to, say, the GitHub and Sentry servers without also handing it a database-write server it has no business touching.

### Secrets for stdio servers in the cloud VM

A stdio server registered for cloud agents runs as a real process inside the agent's VM, which means it needs its dependencies present and its environment variables set before it can start. Cursor's `.cursor/environment.json` handles the VM setup: an idempotent `install` script for dependencies, `start` and `terminals` for long-running processes, and an `env` block for environment variables the remote environment needs. If your stdio MCP server needs `npx` and a Python runtime, put the install in `environment.json` so the server can actually boot when the agent selects it:

```json
// .cursor/environment.json -- cloud agent VM setup, Cursor 3.11
{
  "install": "npm ci && pip install -r tools/requirements.txt",
  "env": {
    "LOG_LEVEL": "info"
  }
}
```

Secret values for cloud agents come from the dashboard secrets rather than a committed file, for the same reason as locally: nothing sensitive belongs in git. The environment setup story for cloud agents, including snapshots and multi-repo runs, expanded significantly in [Cursor 3.4's multi-repo cloud agent environments](/2026/05/cursor-3-4-multi-repo-cloud-agent-environments/), and `environment.json` is where that configuration lives.

## A concrete two-surface rollout

Here is the minimal end-to-end sequence for a team adding a GitHub MCP server and one internal HTTP server so both the IDE and cloud agents have them:

1. Author `.cursor/mcp.json` in the repo with both servers, using `${env:...}` for every credential. Commit it in a PR your team reviews.
2. Add the two servers under **Dashboard > Integrations & MCP**, using the same names and the same transports. For the stdio GitHub server, set its `env` secret in the dashboard; for the internal HTTP server, configure the header token or OAuth there.
3. Select **Add to Team Marketplace** for each so teammates can install them in their own IDEs on top of the repo file.
4. Add `.cursor/environment.json` with an `install` step so any stdio server has its runtime in the cloud VM.
5. Document the required local environment variables (`GITHUB_MCP_PAT`, `INTERNAL_MCP_TOKEN`) in the README so a fresh clone connects on the first try.
6. In a cloud agent run, open the **MCP dropdown** and confirm both servers appear and are enabled.

After that, a developer who clones the repo gets the servers in their editor as soon as they set their local secrets, and a cloud agent gets them from the team list the moment it boots. The names and transports match, so a tool call behaves the same in both places.

## Gotchas that bite teams

**The repo file does not reach cloud agents on its own.** This is the number one surprise. Committing `.cursor/mcp.json` is necessary for the IDE and useful as documentation, but a cloud agent will not read secrets or servers out of it the way your editor does. If an agent "loses" a server the moment it runs in the cloud, the server was never registered in the dashboard. Register it under Integrations & MCP.

**Global config does not distribute.** `~/.cursor/mcp.json` is per-developer and lives outside the repo, so anything you put there reaches exactly one machine. Use it only for personal, everywhere-useful servers (a local filesystem server, a scratch tool). Team servers belong in the committed project file plus the dashboard, never in the global file, or your teammates simply will not have them.

**Bundling is a different mechanism.** Cursor 3.9 introduced plugins that package skills, rules, MCP servers, commands, and hooks as one versioned, portable unit. That is a distribution strategy of its own and can carry MCP servers along with the rest of an agent setup; see [Cursor 3.9's portable plugins](/2026/06/cursor-3-9-plugins-bundle-skills-rules-mcps-hooks/). Plugins and the raw `mcp.json` approach solve overlapping problems, so pick one as your primary channel rather than half-configuring both and wondering which one a given server came from.

**Too many servers degrade tool selection.** Every MCP server you distribute adds its tools to the agent's context, and past a handful the model spends tokens and accuracy just picking among them. If you are pushing five or more servers to the whole team, scope them per project or trim the tool surface; the mechanics of that, including deferred loading, are in [reducing the number of MCP tools an agent loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/). A shared config that enables everything for everyone is the fastest way to a slow, distractible agent.

**Names must match across surfaces.** If the repo file calls a server `github` and the dashboard calls it `github-mcp`, the two configurations describe different servers as far as your team's mental model is concerned, and a prompt that references one by name will not find the other. Keep the keys identical.

The pattern that holds up is boring on purpose: one committed `.cursor/mcp.json` with `${env:...}` placeholders for the IDE, the same servers registered under Integrations & MCP for cloud agents, secrets in each surface's own store, and `environment.json` making sure stdio servers can boot in the VM. Author it once, review it in a PR, and every developer and every background agent works from the same list. The official reference for the config fields and interpolation tokens is the [Cursor MCP documentation](https://cursor.com/docs/mcp), and the cloud-side behavior is in the [Cloud Agents docs](https://cursor.com/docs/cloud-agent).
