---
title: "Fix: a Windows path in your agent config silently turns into a tab, a newline, or a Chinese character"
description: "Folder names starting with t, b, n, r or u make a Windows path parse cleanly as JSON and still resolve wrong. Use forward slashes or double every backslash."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "mcp"
  - "claude-code"
  - "ai-agents"
  - "windows"
  - "json"
---

If an MCP server or agent config on Windows fails with `Cannot find module` or `ENOENT` pointing at a path that looks almost correct, the JSON parser probably ate a backslash. `\t`, `\n`, `\r`, `\b`, `\f` and `\u` plus four hex digits are all legal JSON escapes, so `"C:\srv\tools\agent.js"` parses without complaint and resolves to `C:\srv` + a TAB + `ools\agent.js`. Double every backslash, or switch the whole path to forward slashes.

This is the quiet half of the Windows-path problem. Verified against Node 24.14.1, Python 3.14, Claude Code 2.1.x reading `.mcp.json`, and Claude Desktop 1.x reading `claude_desktop_config.json`. The behavior is not client-specific: every one of them hands the file to a strict [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259) parser, and RFC 8259 is what decides which of your backslashes survive.

## The failure, in context

The config validates. `claude mcp list` shows the server. The server then dies immediately, and the log looks like this:

```
Error: Cannot find module 'C:\srv	ools\agent.js'
    at Function._resolveFilename (node:internal/modules/cjs/loader:1459:15)
```

Look at the gap between `C:\srv` and `ools`. That is not indentation, it is a literal U+0009 tab character where `\t` used to be, and the `t` of `tools` is gone with it. Terminals render it as whitespace, GitHub renders it as whitespace, and your eye reads it as a formatting quirk in the error message rather than as the bug.

The `\u` variant is louder to look at and stranger to explain:

```
Error: Cannot find module 'C:\dev龜\server.js'
```

Nobody typed a Chinese character. The config said `C:\dev\uface\server.js`.

Whatever the mangled character is, the symptom is the same shape: a path that is one character short and one character wrong, in a config file that passes `python -m json.tool` without a word of complaint. That silence is what separates this from the case where [one malformed-JSON syntax error takes down every MCP server at once](/2026/07/fix-all-mcp-servers-fail-to-load-after-malformed-json-in-config/). There, the parser refuses the file and every server vanishes. Here, the parser accepts the file, the other servers are fine, and exactly one server is broken with a plausible-looking path.

## Why the file parses and the path still breaks

RFC 8259 section 7 allows exactly nine escape sequences inside a string: `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, and `\uXXXX` with four hexadecimal digits. Anything else after a backslash is a parse error.

That gives Windows paths two very different fates depending on the first letter of the next path segment:

- `C:\Users\me\srv.js` starts a `\U` sequence. `\U` is not on the list (JSON escapes are lowercase only), so the parser throws `Bad escaped character` and you get a loud, findable error.
- `C:\srv\tools\agent.js` starts a `\t` sequence. `\t` is on the list. The parser produces a tab and moves on.

Run both through the same parser and the asymmetry is obvious:

```js
// Node 24.14.1; identical results on any Node 18+ and on Python 3.14's json module
JSON.parse(String.raw`"C:\\srv\Tools\\a.js"`)   // THROWS: Bad escaped character
JSON.parse(String.raw`"C:\\srv\tools\\a.js"`)   // OK -> "C:\srv<TAB>ools\a.js"
JSON.parse(String.raw`"C:\\dev\UFACE\\a.js"`)   // THROWS: Bad escaped character
JSON.parse(String.raw`"C:\\dev\uface\\a.js"`)   // OK -> "C:\dev龜\a.js"
```

Windows filesystems are case-insensitive, so `C:\Tools` and `C:\tools` are the same directory. JSON escapes are case-sensitive, so one of them crashes at parse time and the other quietly corrupts your config. Which failure you get depends on how you happened to capitalise a folder name.

### The segment names that bite

Every one of these is a real directory name that starts a valid escape:

| Path segment | Escape | Result |
| --- | --- | --- |
| `\bin`, `\build`, `\backup` | `\b` | U+0008 backspace |
| `\fonts`, `\flutter`, `\frontend` | `\f` | U+000C form feed |
| `\node_modules`, `\nuget`, `\net11` | `\n` | U+000A line feed |
| `\repos`, `\runtime`, `\resources` | `\r` | U+000D carriage return |
| `\tools`, `\temp`, `\target`, `\test` | `\t` | U+0009 tab |
| `\uface`, `\ubeef`, `\uc0de` | `\uXXXX` | one arbitrary BMP character |

`\node_modules` is the worst of them, because a line feed in the middle of a path turns a one-line error message into a two-line one and every log viewer you own will present it as two unrelated events.

The `\u` row needs four hexadecimal digits (`0-9`, `a-f`, `A-F`) immediately after the `u`, which is rarer in real folder names but not impossible in hash-named or content-addressed directories. When it does hit, the result looks like a mojibake bug rather than an escaping bug.

### Why the mangled character is so often East Asian

Of the 65,536 code points in the Basic Multilingual Plane, 20,992 are CJK Unified Ideographs (U+4E00 to U+9FFF) and 11,172 are Hangul syllables (U+AC00 to U+D7A3). Together that is just under half the plane. A `\uXXXX` escape formed by accident from a folder name is effectively a uniform draw from the BMP, so close to a coin flip says the character you get is Chinese or Korean. `\uface` lands on U+FACE, a CJK compatibility ideograph. `\ubeef` lands on U+BEEF, a Hangul syllable. Neither is a sign that anything Unicode-related is misconfigured; they are just the two biggest blocks in the address space.

## Minimal repro

Save this as `.mcp.json` in a scratch directory. Note that the author already fixed the first and third backslashes and missed the middle one, which is exactly how this happens in practice: you hit a parse error, you double the backslashes the error pointed at, you restart, the file parses, you stop.

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["C:\\srv\tools\\agent.js"]
    }
  }
}
```

Validate it the way you would validate any config:

```bash
# Python 3.14 - exits 0, prints the reformatted document
python -m json.tool < .mcp.json
```

It passes. Now look at what the parser actually produced:

```js
// Node 24.14.1 - print every string in the config with control chars made visible
const cfg = JSON.parse(require('fs').readFileSync('.mcp.json', 'utf8'));
JSON.stringify(cfg, (k, v) => {
  if (typeof v === 'string' && /[\x00-\x1f\u0080-\uffff]/.test(v)) {
    console.log('suspect', k + ':', JSON.stringify(v));
  }
  return v;
});
// suspect 0: "C:\\srv\tools\\agent.js"
```

`JSON.stringify` re-escapes the tab back to `\t`, which is why the output looks like the input. The `/[\x00-\x1f\u0080-\uffff]/` test is the part that matters: no legitimate Windows path in an agent config contains a control character, so any hit is a bug.

## The fix, in order of preference

**1. Use forward slashes for the whole path.** Win32 file APIs normalise `/` to `\` for drive-letter paths, so `C:/srv/tools/agent.js` opens the same file, and there is not a single backslash left for JSON to interpret.

```json
{
  "mcpServers": {
    "local": { "command": "node", "args": ["C:/srv/tools/agent.js"] }
  }
}
```

This is the recommendation because it removes the failure mode rather than escaping around it. It also survives being copied into a YAML workflow, a `.env` file, or a Python script without further edits.

**2. Double every backslash, and verify rather than eyeball.** If you must keep Windows-style separators, `\\` is the correct escape for a literal backslash. The rule is every backslash, not just the ones the parser complained about.

```json
{
  "mcpServers": {
    "local": { "command": "node", "args": ["C:\\srv\\tools\\agent.js"] }
  }
}
```

Then run the control-character scan above. A parse check alone does not prove this fix worked, which is the whole point of the post.

**3. Keep absolute paths out of the file entirely.** Claude Code expands environment variables in `.mcp.json` in `command`, `args`, `env`, `url`, and `headers`, using `${VAR}` and `${VAR:-default}` syntax. A variable's value is not re-parsed as JSON, so nothing in it can be mangled.

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["${AGENT_ROOT:-./tools}/agent.js"]
    }
  }
}
```

If the variable is unset and has no default, Claude Code still loads the config, reports a missing-variable warning in `claude mcp list`, and passes the literal `${VAR}` text through. That warning is a much better failure than a silent tab. This is also what makes a config portable across a team; see [distributing a team MCP config across Cursor cloud agents and the IDE](/2026/07/distribute-team-mcp-config-across-cursor-cloud-agents-and-ide/) for the wider pattern.

**4. Set `cwd` and use relative paths.** For a stdio server that lives inside the repository, `"cwd": "."` plus `"args": ["tools/agent.js"]` sidesteps drive letters entirely and works identically on a colleague's Mac.

## Detecting it before the server dies

Pick whichever runtime is already on the machine. All three answer the same question: after parsing, does any string in this config contain a character no path should contain?

```powershell
# Windows PowerShell 5.1 or 7.x, run from the directory holding the config
$json = Get-Content .\.mcp.json -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 20 -Compress
if ($json -match '(?<!\\)\\[bfnrtu]') { 'SUSPECT' } else { 'clean' }
```

The round trip is the trick. `ConvertTo-Json` re-escapes whatever the parse produced, so a real tab comes back as `\t` with one backslash while a correctly written path comes back as `\\t` with two. The negative lookbehind is the only thing separating those two cases, and it is also why the naive version of this check, `-match '\\[bfnrtu]'`, flags every valid Windows config.

```bash
# Python 3.14
python -c "
import json
def walk(o):
    if isinstance(o, dict):
        for v in o.values(): yield from walk(v)
    elif isinstance(o, list):
        for v in o: yield from walk(v)
    elif isinstance(o, str): yield o
bad = [s for s in walk(json.load(open('.mcp.json'))) if any(not 32 <= ord(c) <= 126 for c in s)]
print(bad or 'clean')
"
```

```bash
# Node 18+
node -e "
const flat = o => o && typeof o === 'object' ? Object.values(o).flatMap(flat) : [o];
const suspect = v => typeof v === 'string' &&
  [...v].some(c => c.codePointAt(0) < 32 || c.codePointAt(0) > 126);
const bad = flat(JSON.parse(require('fs').readFileSync('.mcp.json', 'utf8'))).filter(suspect);
console.log(bad.length ? bad.map(v => JSON.stringify(v)) : 'clean');
"
```

The Python and Node versions inspect the parsed values rather than a re-serialized string, so they need no lookbehind: they simply assert that every character of every string is printable ASCII. They do flag a genuinely non-ASCII path (a username with an accent, say), which is the right tradeoff, because that path is worth a second look on Windows anyway.

If you would rather look at bytes directly, `Get-Content .\.mcp.json -Raw | Format-Hex` shows the raw file, but remember the raw file is fine. The corruption exists only after parsing, which is why every one of the checks above parses first and inspects second.

## Gotchas and lookalikes

**Forward slashes are not universal on Windows.** They work for drive-letter paths through the Win32 file APIs, but three cases still require backslashes: UNC paths (`\\server\share`), extended-length paths (`\\?\C:\...`), and anything handed to `cmd.exe` as an argument, where `/` starts a switch. If your `command` is `cmd` or `cmd.exe`, keep backslashes and double them.

**Your editor is hiding the evidence.** VS Code and Cursor render a tab inside a JSON string as whitespace and a `\uXXXX` result as the glyph. A JSON file with the bug looks identical to a JSON file without it unless you turn on `editor.renderControlCharacters`. Git is more honest: `git diff` on the config shows the escape sequence as literal text.

**A path that looks right in the error but still fails** is the backspace case. `\b` emits U+0008, and many terminals honour it by moving the cursor back one column, so `C:\srv\bin\a.js` prints as `C:\srin\a.js` or as `C:\srvin\a.js` depending on the emulator. Copy the error text into an editor before you trust it.

**This is not the same as a config the client cannot read at all.** If every server disappeared rather than one, you have a genuine syntax error, and [the malformed-JSON triage](/2026/07/fix-all-mcp-servers-fail-to-load-after-malformed-json-in-config/) is the right page. If the server starts and then drops, look at [MCP error -32000 in Claude Code](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/) instead. If the config used to work and stopped after an update, the file may simply have moved: [MCP servers stop working after a Claude Desktop update on Windows](/2026/06/fix-mcp-servers-stop-working-after-claude-desktop-update-on-windows/) covers the relocated config path.

**The same trap exists outside JSON.** YAML double-quoted scalars implement the same escape set plus more, so `path: "C:\tools\agent.js"` in a GitHub Actions workflow behaves identically; YAML single-quoted scalars do not process escapes at all and are the safe choice. TOML basic strings escape the same way, and TOML literal strings (single quotes) do not. Python source is the noisiest of the family: `"C:\Users\me"` raises `SyntaxError: (unicode error) 'unicodeescape' codec can't decode bytes in position 2-3: truncated \UXXXXXXXX escape`, which at least tells you what happened. `r"C:\Users\me"` fixes it.

**WSL changes the path, not the rule.** A server configured from inside WSL uses `/mnt/c/...` and has no backslashes to escape, but a Windows-side client launching a WSL command still passes a Windows path in `args`. If the server is unreachable rather than mis-pathed, [Claude Code reporting MCP server disconnected inside WSL](/2026/05/fix-claude-code-reports-mcp-server-disconnected-inside-wsl/) is the closer match.

## The habit worth keeping

Treat "the config parses" as necessary but not sufficient. A JSON parser's job is to tell you the document is well-formed; it has no opinion about whether the string it just built is a path you could open. On Windows the two questions come apart precisely when a folder name starts with `b`, `f`, `n`, `r`, `t`, or a `u` followed by four hex digits, which is a large fraction of the directory names any developer actually uses. Write paths with forward slashes, keep absolute paths in environment variables, and run a control-character scan as part of whatever check already runs before you restart the client.

## Related

- [Fix: all MCP servers fail to load after one malformed-JSON syntax error in the config](/2026/07/fix-all-mcp-servers-fail-to-load-after-malformed-json-in-config/) is the loud version of this bug, where the parser rejects the file and every server disappears at once.
- [Fix: MCP error -32000: Connection closed in Claude Code](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/) is the triage once you have proved the path is correct and the process is still dying on launch.
- [Fix: MCP servers stop working after a Claude Desktop update on Windows](/2026/06/fix-mcp-servers-stop-working-after-claude-desktop-update-on-windows/) covers the other Windows-specific way a working config stops being read.
- [Fix: Claude Code reports "MCP server disconnected" inside WSL](/2026/05/fix-claude-code-reports-mcp-server-disconnected-inside-wsl/) is the closer match when the path is fine but the server is unreachable across the WSL boundary.
- [How to distribute a team MCP server config across Cursor cloud agents and the IDE](/2026/07/distribute-team-mcp-config-across-cursor-cloud-agents-and-ide/) shows the variable-driven config layout that keeps absolute Windows paths out of the file entirely.

## Sources

- [RFC 8259, The JavaScript Object Notation (JSON) Data Interchange Format, section 7](https://www.rfc-editor.org/rfc/rfc8259) - the nine legal escape sequences and the four-hex-digit `\u` rule.
- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp) - `.mcp.json` locations, scopes, and the `${VAR}` / `${VAR:-default}` expansion rules including the missing-variable warning behavior.
- [Naming Files, Paths, and Namespaces, Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file) - forward-slash normalisation and the UNC and `\\?\` exceptions.
- [Unicode 16.0 code charts](https://www.unicode.org/charts/) - the CJK Unified Ideographs and Hangul Syllables block ranges used in the probability estimate above.
- [JSON.parse should SyntaxError on invalid escape sequences, nodejs/node issue #41828](https://github.com/nodejs/node/issues/41828) - discussion of exactly which escapes V8 accepts and rejects.
