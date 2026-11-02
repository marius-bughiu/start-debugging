---
title: "Fix: all MCP servers fail to load after one malformed-JSON syntax error in the config"
description: "Validate the MCP config file when several servers disappear after an edit. Check JSON syntax, client-specific schemas, scope and encoding without assuming every client fails alike."
updatedDate: 2026-11-02
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "mcp"
  - "claude-code"
  - "ai-agents"
---

If several MCP servers disappear immediately after a configuration edit, validate the file you changed before debugging each server. A syntax error can prevent a strict JSON parser from producing any configuration object. That is a strong lead, not proof that every missing server shares the same cause.

> **Correction — November 2, 2026:** Removed unsupported cross-client/version testing claims and the unpublished MCP reference. Corrected the broken syntax examples and the distinction between valid JSON, valid client configuration and a running server. The JSON examples were checked locally with Node and Python; client reload behavior was not reproduced.

## Check the file the client actually uses

For Claude Code's ordinary MCP scopes, the [official configuration documentation](https://code.claude.com/docs/en/mcp#mcp-installation-scopes) describes:

| Scope | File | Availability |
| --- | --- | --- |
| Local | Project-specific entries within `~/.claude.json` | You, in that project |
| Project | `.mcp.json` in the project | Shared project configuration, subject to approval/trust |
| User | `~/.claude.json` | Your projects |

For duplicate names, local takes precedence over project, then user; managed policies can override normal configuration. A project config that has not been approved is different from a file that cannot be parsed.

[Cursor's MCP documentation](https://cursor.com/docs/mcp) lists `.cursor/mcp.json` for a project and `~/.cursor/mcp.json` globally. Claude Desktop's [local-server setup guide](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers) describes opening its configuration through the app's developer settings. Its documented manual paths include `%APPDATA%\Claude\claude_desktop_config.json` on Windows and `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS.

MCP itself does not mandate these file names, schemas or reload behavior. A syntax error in one source does not necessarily disable servers supplied by another scope, plugin or managed configuration.

## Validate without printing the entire configuration

From the directory containing a Claude Code project config:

```bash
node -e "JSON.parse(require('fs').readFileSync('.mcp.json','utf8')); console.log('JSON syntax OK')"
```

Or, for the ordinary syntax examples below:

```bash
python3 -m json.tool .mcp.json > /dev/null
```

The Node command prints its success message only after parsing the complete file. Python exits nonzero on the malformed examples. Error wording and offsets vary; an offset is not necessarily a byte offset for Unicode input.

A strict parser is a useful portability check. If a client explicitly supports JSONC or another extension, follow that client's documented grammar rather than assuming its parser behaves identically to `JSON.parse`.

## Recognize the common syntax errors

These are intentionally **invalid** snippets. They belong in a test fixture, not a working config.

A trailing comma:

```text
{"mcpServers": {"demo": {"command": "node", "args": ["server.mjs"]},}}
```

A comment in strict JSON:

```text
{"mcpServers": { /* note */ "demo": {"command": "node"}}}
```

A single-quoted key:

```text
{'mcpServers': {}}
```

A missing comma:

```text
{"command": "node" "args": ["server.mjs"]}
```

An unescaped Windows path:

```text
{"args": ["C:\Users\me\server.mjs"]}
```

In a valid JSON string, double the backslashes. Here is a complete example with no comments or trailing commas:

```json
{
  "mcpServers": {
    "demo": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\me\\server.mjs"]
    }
  }
}
```

Keys and string delimiters must use straight double quotes (`"`), not typographic quotation marks (`“` and `”`). Keep explanatory comments outside the JSON unless the client documents support for them. Adding an arbitrary `_comment` field may satisfy the parser while violating the client's schema.

The [JSON standard](https://www.rfc-editor.org/rfc/rfc8259) defines the syntax; it does not define MCP client settings.

## A successful parse is only the first check

Fix the first reported syntax error and rerun validation. If parsing then succeeds, the syntax check is complete; there is no hidden later syntax error that the same parser skipped. Semantic problems can still remain. For example, `{"mcpServers": []}` is valid JSON but is not the expected object of named server entries.

Next verify the expected object shape, field types, executable or URL, and required variables. An existing file path does not guarantee execute permission, and a syntactically valid URL does not guarantee an HTTP MCP endpoint.

Save the file in the encoding the client expects, normally UTF-8. PowerShell encoding defaults differ between Windows PowerShell and modern PowerShell; do not assume every `Set-Content` invocation writes UTF-16. Inspect the actual file if encoding is in doubt.

## Reload and confirm the effective configuration

Use the client's documented reload or restart flow after saving. A reconnect action retries a server connection; it should not be assumed to reload every configuration source. For Claude Code, starting a fresh session is a straightforward way to load the edited project configuration, then inspect:

```bash
claude mcp get demo
claude mcp list
```

Also check `/mcp` in the session that will use the server. If only one server fails after the file parses, read its launch or connection error. If all entries from this file remain missing, check scope, approval, managed policy and the file location before changing server code.

A process failure belongs in [MCP connection-closed troubleshooting](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/); a process that runs but never completes discovery belongs in [the stdio guide](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/). JSON syntax, client configuration and protocol operation are separate checks.
