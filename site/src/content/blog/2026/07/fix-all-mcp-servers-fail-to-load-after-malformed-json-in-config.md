---
title: "Fix: all MCP servers fail to load after one malformed-JSON syntax error in the config"
description: "One trailing comma or unescaped Windows path in your MCP config makes every server vanish, not just the broken one. Validate the JSON, fix the five usual suspects, restart."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "mcp"
  - "claude-code"
  - "ai-agents"
---

If every one of your MCP servers disappeared at once after you edited the config to add a new one, the config file is not valid JSON. A single trailing comma, an unescaped backslash in a Windows path, or a `//` comment invalidates the whole document, so the client cannot read any server entry, including the ones that worked yesterday. Validate the file (`python -m json.tool < config.json`), fix the syntax, and fully restart the app.

The rest of this post is the full triage. It is tested against Claude Code 2.1.x, Claude Desktop 1.x, and Cursor 3.11, all of which load MCP servers from a plain JSON file and all of which fail the same way. The behavior is not version-dependent: JSON has no partial-parse mode, so a syntax error anywhere in the file takes down every server defined in it.

## The error in context

The symptom is that `/mcp` in Claude Code shows an empty list, `claude mcp list` returns nothing (or omits the servers you just added), and Claude Desktop shows no tools and no error dialog at all. Nothing tells you the file failed to parse. That silence is the trap: you assume the new server is misconfigured and start debugging its `command`, when in fact the parser never got far enough to read a single entry.

Run the file through any JSON parser and you see the real error. With Python:

```bash
# Works on any OS with Python 3.x installed
python -m json.tool < claude_desktop_config.json
```

```
Expecting property name enclosed in double quotes: line 8 column 3 (char 142)
```

Or with Node, which ships the same parser the MCP clients use:

```bash
# Node 18+; the message points at the byte offset of the first bad token
node -e "JSON.parse(require('fs').readFileSync('.mcp.json','utf8'))"
```

```
SyntaxError: Expected ',' or '}' after property value in JSON at position 142
```

That byte offset is the whole answer. Everything after it, including every server you thought was fine, is unreachable.

## Why one typo takes down every server

MCP clients store all their server definitions in a single JSON object under one `mcpServers` key:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] }
  }
}
```

JSON is parsed as one atomic document. There is no line-by-line recovery and no "skip the bad entry and keep going." The moment the parser hits an illegal token it throws, and the client is left with no config object to iterate, so it registers zero servers. This is different from a runtime failure, where one server's `command` binary is missing or the process crashes on boot. In that case the JSON parses fine, the other servers load normally, and only the broken one shows as failed. If **all** of them vanished together, suspect the file, not the servers.

Knowing which failure mode you are in saves the most time. A runtime crash gives you an error against a named server (see [MCP error -32000: Connection closed](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/) for that path). A parse error gives you nothing but an empty list.

## Where the config file actually lives

Editing the wrong file produces the same empty-list symptom, so confirm the path before you touch anything.

**Claude Desktop** reads one file:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Claude Code** has three scopes, documented in the [MCP reference](https://code.claude.com/docs/en/mcp):

| Scope | Stored in | Loads in |
| --- | --- | --- |
| Local (default) | `~/.claude.json` | Current project only |
| Project | `.mcp.json` in the project root | Current project, shared via git |
| User | `~/.claude.json` | All your projects |

A syntax error in `~/.claude.json` is the worst case: it can knock out your local- and user-scoped servers across every project at once, because they all live in that one file.

**Cursor** reads two files, both using the same `mcpServers` key:

- Global: `~/.cursor/mcp.json`
- Project: `.cursor/mcp.json`

If you edited `.cursor/mcp.json` but Cursor is loading the global one, or vice versa, the change looks like it did nothing. Check both.

## The five syntax errors that cause this

In order of how often they bite, here is what actually breaks the parse.

### 1. A trailing comma

JSON forbids a comma after the last element of an object or array. Every other language you write all day allows it, so the muscle memory is wrong.

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] },   // <- kills the whole file
  }
}
```

Delete the comma after the last server entry. This is the number-one cause, and it usually appears exactly when you add a second or third server and comma-terminate every line out of habit.

### 2. An unescaped backslash in a Windows path

`\` is the JSON escape character, so `"C:\Users\me\data"` contains three invalid escape sequences (`\U`, `\m`, `\d`). The parser rejects the string.

```json
// Broken: \U is not a valid JSON escape
"args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\Users\me\data"]

// Fix A: double every backslash
"args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\me\\data"]

// Fix B (simpler): use forward slashes, which Windows accepts
"args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/me/data"]
```

Forward slashes are the better habit because they survive a copy-paste without silently re-breaking. This is a Windows-only failure, and it overlaps with the `cmd /c` wrapping that Windows also needs for `npx`; if you are chasing Windows-specific MCP breakage, [MCP servers stop working after a Claude Desktop update on Windows](/2026/06/fix-mcp-servers-stop-working-after-claude-desktop-update-on-windows/) covers the adjacent path-moved trap.

### 3. Comments

JSON has no comments. A `//` note or a `/* ... */` block that you pasted from a tutorial (many of which use JSONC) fails the parse.

```json
{
  "mcpServers": {
    // add your servers below   <- illegal, JSON is not JSONC
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
  }
}
```

Strip every comment. If you want to leave a note, park it in an unused string key like `"_comment": "..."`, which is ugly but at least parses.

### 4. Single quotes or smart quotes

JSON strings and keys must use straight double quotes. Single quotes fail outright. Curly "smart" quotes (`"` and `"`) fail too, and they are invisible in most editors, so they are the hardest to spot. They creep in when you copy config out of a chat window, a Word doc, or a blog that ran text through a typographic filter.

```json
// All three of these break the parse
'github': { ... }
"github": { 'command': "npx" }
"github": { "command": "npx" }   <- the quotes here are curly, not straight
```

If validation reports an error on a line that looks correct, retype the quotes by hand rather than trusting your eyes.

### 5. A missing comma between entries

The mirror image of the trailing-comma problem: two adjacent entries with no comma between them.

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }   <- missing comma here
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] }
  }
}
```

The parser reports this as "expected `,` or `}`" at the start of the second entry.

## The fix, step by step

1. **Locate the right file** using the tables above. Do not guess; on Windows especially, `%APPDATA%` and OneDrive-redirected home folders trip people up.

2. **Validate before you restart.** This is the whole game. Pick whichever is already on your machine:

   ```bash
   # Python (any OS)
   python -m json.tool < claude_desktop_config.json

   # Node 18+
   node -e "JSON.parse(require('fs').readFileSync('.mcp.json','utf8'))"

   # jq, if installed
   jq . .mcp.json
   ```

   On Windows PowerShell, `Get-Content .\.mcp.json -Raw | ConvertFrom-Json` does the same and prints the parse error if there is one. A silent success means the file is valid JSON.

3. **Fix the first error, then re-validate.** Parsers stop at the first bad token, so a clean run after one fix does not prove the file is clean; there may be a second error further down. Loop until the validator is silent.

4. **Check the file encoding.** If PowerShell wrote the file with `Set-Content` or `Out-File` without `-Encoding utf8`, it may be UTF-16 with a byte-order mark, which some parsers reject before they read a single character. Re-save as UTF-8 without BOM.

5. **Fully restart the client.** Claude Desktop must be quit from the tray, not just closed to the taskbar. Cursor needs a full Quit and relaunch, not a window reload. Claude Code re-reads `.mcp.json` on the next launch, or you can reconnect in-session with `/mcp`.

6. **Confirm.** Run `claude mcp list` (Claude Code), open the tools menu (Claude Desktop), or open View > Output and select "MCP" from the dropdown (Cursor). All your servers should be back, not just the new one.

## Reading the logs when validation passes but servers are still gone

If the JSON validates cleanly and the servers still do not appear, you are no longer in a parse-error situation; you have a runtime or scope problem. Two quick checks:

- **Claude Desktop logs**, on Windows at `%APPDATA%\Claude\logs\` and on macOS at `~/Library/Logs/Claude/`, contain `mcp.log` plus a per-server `mcp-server-<name>.log`. A parse failure leaves the main log noting it could not read the config; a runtime failure leaves a stack trace in the per-server log.
- **Wrong scope in Claude Code.** A server you added with `--scope local` will not show up when you expected a project server, and vice versa. `claude mcp get <name>` tells you where it is configured.

From there the problem is a specific server, not the file, and the fix depends on the transport and platform. If a stdio server hangs or dies on launch, [the MCP server stdio hang](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/) and the `-32000` triage linked above are the next stops. If you have simply configured too many servers and are hitting tool limits rather than a load failure, see [how to reduce the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/).

## The habit that prevents all of this

Keep the config open in an editor with JSON validation on (VS Code flags every one of the errors above as you type), and run the file through a parser before you restart the app. The five-second `python -m json.tool` check is faster than the restart-and-stare loop it replaces, and it turns a silent, all-servers-gone failure into a message with a line number. Choosing stdio over HTTP does not change this, and neither does the client; the file is JSON, and JSON is all-or-nothing. For the broader picture of which transport to pick once your config parses, [MCP stdio vs HTTP vs SSE transport](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) lays out the tradeoffs.

## Sources

- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp) - config file locations and the three installation scopes.
- [Model Context Protocol specification, 2026-03-26](https://modelcontextprotocol.io/specification/2026-03-26) - the protocol these clients implement.
- [MCP servers in .claude/.mcp.json not loading properly, anthropics/claude-code issue #5037](https://github.com/anthropics/claude-code/issues/5037) - real-world reports of the empty-list symptom.
- [The JSON specification, RFC 8259](https://www.rfc-editor.org/rfc/rfc8259) - the grammar that forbids trailing commas and comments.
