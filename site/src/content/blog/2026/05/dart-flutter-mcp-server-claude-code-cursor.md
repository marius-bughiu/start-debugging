---
title: "The Dart and Flutter MCP server: one command to give Claude Code your running Flutter app"
description: "Dart 3.12 ships dart mcp-server, the official MCP bridge into the Dart and Flutter toolchain. Register it once in Claude Code, Cursor, or Codex CLI and your agent gets hot reload, pub.dev search, and live widget introspection without copy-pasting a DTD URI."
pubDate: 2026-05-28
tags:
  - "dart"
  - "flutter"
  - "mcp"
  - "claude-code"
  - "ai-agents"
---

At Google I/O 2026 (May 19-20), the Dart team announced Dart 3.12 alongside something quieter but more useful day to day: the official `dart mcp-server`. It ships in the SDK from Dart 3.9 onward and lets any MCP-compatible coding agent (Claude Code, Cursor, Gemini CLI, Codex CLI, GitHub Copilot in VS Code) drive your running Flutter app without you ever copy-pasting a Dart Tooling Daemon URI again. The status is still "experimental" in the [official docs](https://docs.flutter.dev/ai/mcp-server), but the install path is stable across clients and worth wiring up now.

The friction it removes is real. Before this, telling an agent to "fix this red text in the widget tree" meant running the app, opening DevTools, copying the DTD connection URI, pasting it into a tool prompt, and praying the agent did not lose it on the next turn. Now the MCP server discovers the DTD on its own and the agent just calls `hot_reload`.

## What the server actually exposes

Per the Dart and Flutter MCP server docs, the tools fall into four buckets:

- **Project**: analyze and fix errors via the analysis server, resolve symbols, fetch package docs, search pub.dev, edit `pubspec.yaml`, format with `dart format`.
- **Test**: run tests, parse failures, surface stack traces in the agent's context.
- **Runtime**: connect to a running app over DTD, list widgets, inspect state, take a screenshot of the render tree.
- **Hot reload**: triggered automatically after the agent's edit, no manual step.

Every tool returns Dart-aware results. `analyze_files` returns the same diagnostics as the analysis server, not a regex over compiler output. `pub_search` queries pub.dev with the same scoring the website uses. `get_runtime_errors` pulls live exceptions out of the running app, including the widget that threw.

## Wire it into Claude Code

One command, from inside the Flutter project root:

```bash
claude mcp add --transport stdio dart -- dart mcp-server
```

That registers `dart` as a stdio MCP server in your current Claude Code workspace. The server discovers the active DTD from the workspace root, so as long as `flutter run` is alive in another terminal, `hot_reload` and `take_screenshot` light up automatically.

For Cursor, drop this into `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "dart": {
      "command": "dart",
      "args": ["mcp-server"]
    }
  }
}
```

For Codex CLI, the SDK still has a roots-detection gap on some shells, so pass the fallback flag:

```bash
codex mcp add dart -- dart mcp-server --force-roots-fallback
```

VS Code Copilot users do not need any of this. Set `dart.mcpServer: true` in settings (Dart Code v3.116 or newer) and the extension wires the same binary in automatically.

## The one gotcha worth knowing

The MCP server is per-Dart-SDK. If you have multiple Flutter channels installed and your agent picks up `master` while your project is on `stable`, tool calls will succeed but talk to the wrong analysis server, and you will get confusing "symbol not found" responses for code that compiles fine. Pin the binary explicitly on multi-channel machines:

```bash
claude mcp add --transport stdio dart -- /path/to/flutter/bin/dart mcp-server
```

A second gotcha: the server expects a single workspace root. If you open a melos monorepo and let the agent roam across packages, hot reload still targets whichever app you started with `flutter run`. Pass `--force-roots-fallback` to make the server use the client-advertised roots instead of guessing.

For the broader changelog see our earlier post on [Dart 3.12 private named parameters and initializing formals](/2026/05/dart-3-12-private-named-parameters-initializing-formals/). The MCP server is the quietest piece of that release and probably the one that changes your loop the most.
