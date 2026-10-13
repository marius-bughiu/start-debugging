---
title: "Azure MCP Server 3.0 rejects unknown parameters and creates resources secure by default"
description: "Azure MCP Server 3.0.0 shipped on October 12, 2026. Tool calls with unknown parameters now fail, options like subscription and tenant were removed from many tools, new Storage accounts disable Shared Key auth, and the server speaks the stateless MCP 2026-07-28 protocol."
pubDate: 2026-10-13
tags:
  - "mcp"
  - "azure"
  - "dotnet"
  - "ai-agents"
---

[Azure MCP Server 3.0.0](https://github.com/microsoft/mcp/releases/tag/Azure.Mcp.Server-3.0.0) went out on October 12, 2026, after 50 beta builds. The headline is a pile of new namespaces (`azurebackup`, `resiliency`, `sreagent`, `azureterraform`, `advisor`, `iothub`), but the part that can break a working setup today is quieter: the tool contracts got stricter, and resources the server creates are locked down by default.

## Unknown parameters are now an error

In 2.x, a tool silently ignored options it did not use. 3.0 removes unused parameters such as `subscription`, `resource-group`, `tenant`, `auth-method`, `user` and `sender-name` from tools across almost every namespace (Key Vault, Storage, SQL, Redis, Service Bus, AKS and more), and then rejects any call that still passes them. Custom retry policy options are gone too; the Azure SDK retry defaults apply.

That matters if you drive `azmcp` from scripts, or if you saved prompts and agent instructions that tell the model to always pass a subscription. A call that worked on 2.x like this:

```bash
azmcp keyvault secret get --subscription 00000000-0000-0000-0000-000000000000 \
  --vault my-vault --secret db-password --retry-max-retries 5
```

now fails validation on 3.0: `keyvault secret get` takes only `--vault` and an optional `--secret`, and the global `--retry-*` options no longer exist. Drop them and check the [command reference](https://github.com/microsoft/mcp/blob/release/azure/3.x/servers/Azure.Mcp.Server/docs/azmcp-commands.md) for what each tool actually takes. A few result payloads were also normalized to named objects (`{ servers }`, `{ results }`, `{ guidance }`), so parsers that read the old shapes need a look.

Two more renames to catch: `monitor healthmodels entity get` became `list` and `get`, and the server code moved from `Azure.Mcp.Core.*` to `Microsoft.Mcp.Core.*`. Logger categories follow namespaces, so a `Logging:LogLevel:Azure.Mcp.Core` entry in your config stops matching anything.

## Secure-by-default resource creation

When an agent creates resources through the server, the defaults changed:

- Storage accounts disable Shared Key authentication (HTTPS, TLS 1.2 and no anonymous blob access stay on).
- Event Hubs namespaces disable local authentication.
- NFS file shares default to `RootSquash` with encrypted transit.
- `compute vm create` and `compute vmss create` require `--image`; the `Win2019Datacenter` and `Ubuntu2004` aliases were removed.

If downstream code connects with an account key or a SAS signed by one, it will get a 403 against a freshly created account. That is the point: use Entra ID and `DefaultAzureCredential`.

The MySQL and PostgreSQL `database query` tools changed in the other direction. They are now marked destructive, no longer filter statements by SQL verb, and rely on the signed-in user's database permissions. Run the server with `--read-only` or use a read-only database login if the agent should only look.

## Stateless protocol and structured output

3.0 moves to the MCP `2026-07-28` stateless protocol and keeps backward compatibility for clients on `2025-11-25`. If you have not followed that revision, I covered what disappears (no `initialize` handshake, no `Mcp-Session-Id`) in [stateful vs stateless MCP servers](/2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away/).

Tools can now also return `outputSchema` and `structuredContent`, opt in with a flag. With .NET 10's `dnx`, the `mcp.json` entry looks like this:

```json
{
  "mcpServers": {
    "azure-mcp-server": {
      "command": "dnx",
      "args": [
        "Azure.Mcp", "--version", "3.0.0", "--yes", "--",
        "azmcp", "server", "start",
        "--read-only",
        "--structured-output-mode", "compact"
      ],
      "type": "stdio"
    }
  }
}
```

`compact` sends short text in `content` and the full result in `structuredContent`; `duplicated` sends the full result in both. Only enable it if your client understands those fields.

## Smaller fixes worth the upgrade

Log messages and exceptions that leaked to stdout (and could corrupt JSON-RPC output) now go to stderr, not-found errors return 404 instead of 500, and the npm wrapper no longer edits the calling project's `package.json` when it auto-installs a platform package. Pin `Azure.Mcp` 3.0.0 or `@azure/mcp@3.0.0` explicitly rather than `@latest` until your scripts and prompts are clean.
