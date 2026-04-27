---
title: "How to Build a Custom MCP Server in TypeScript That Wraps a CLI"
description: "Step-by-step guide to wrapping any command-line tool as a Model Context Protocol server using the TypeScript SDK 1.29. Covers the stdout trap, child_process patterns, error propagation, and a full working git server."
pubDate: 2026-04-24
tags:
  - "mcp"
  - "ai-agents"
  - "typescript"
  - "claude-code"
---

The fastest way to give an AI agent access to a command-line tool is to wrap it as a Model Context Protocol (MCP) server. The agent calls a typed tool, your server shells out to the CLI, captures the output, and returns it as a structured response -- no REST API, no SDK bindings, no webhooks required.

This guide builds that wrapper from scratch using `@modelcontextprotocol/sdk` 1.29.0 and Node 18+. By the end you will have a working `git-mcp` server that exposes `git log` and `git diff` as callable tools, wired to Claude Desktop via stdio transport. Every gotcha that breaks CLI wrappers in production is covered.

## Why "wrap the CLI" is the right first move

Most internal tooling exists only as a CLI: deployment scripts, database migration runners, audit log exporters, image processing pipelines. They have no API, no gRPC surface, nothing an agent can call directly. Wrapping them as MCP tools takes 50-100 lines of TypeScript and produces a discoverable, schema-validated interface that any MCP-compatible client can use, including Claude Code, Claude Desktop, Cursor, and any client that speaks the [MCP spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26).

The alternative -- embedding the CLI call inside a system prompt or tool description -- is fragile. Arguments get mangled, error handling disappears, and the agent cannot tell a timeout from a bad flag. A proper MCP server fixes all of that.

## Project setup

You need Node.js 18 or later. Create the project directory and install dependencies:

```bash
mkdir git-mcp
cd git-mcp
npm init -y
npm install @modelcontextprotocol/sdk@1.29.0 zod@3
npm install -D @types/node typescript
```

Add two fields to `package.json` and a build script. The `"type": "module"` field tells Node to treat `.js` files as ES modules, which the SDK requires:

```json
{
  "type": "module",
  "bin": {
    "git-mcp": "./build/index.js"
  },
  "scripts": {
    "build": "tsc && chmod +x build/index.js"
  },
  "files": ["build"]
}
```

Create `tsconfig.json` at the project root:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

Create the source file:

```bash
mkdir src
touch src/index.ts
```

## The stdout trap that kills every MCP stdio server

Before writing a single line of business logic, engrave this rule: **never call `console.log()` inside a stdio MCP server**.

When you run your server under stdio transport, the MCP client communicates with it over `stdin`/`stdout` using JSON-RPC messages. Any bytes you write to `stdout` outside the JSON-RPC protocol corrupt the message stream. The client will see malformed JSON, fail to parse a response, and disconnect -- usually with a cryptic "MCP server disconnected" error that points nowhere near your innocent-looking debug statement.

```typescript
// @modelcontextprotocol/sdk 1.29.0, MCP spec 2025-03-26

// Bad -- corrupts the JSON-RPC stream
console.log("Running git log...");

// Good -- stderr is not part of the stdio transport
console.error("Running git log...");
```

Use `console.error()` for every diagnostic line. It writes to `stderr`, which the MCP client either ignores or surfaces separately. This is not an edge case -- it trips up almost every first-time MCP server author.

## The CLI runner

Add a typed helper that spawns a subprocess, collects stdout and stderr, and resolves with a structured result. Using `spawn` instead of `exec` avoids the 1 MB default buffer cap that `exec` imposes:

```typescript
// src/index.ts
// @modelcontextprotocol/sdk 1.29.0, Node 18+

import { spawn } from "child_process";

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 30_000
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn(command, args, {
      cwd,
      shell: false, // never pass shell: true with untrusted input
      timeout: timeoutMs,
    });

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}
```

Two points worth noting:

- `shell: false` is not optional if any part of the arguments comes from the LLM. With `shell: true` an argument like `--format=%H; rm -rf /` becomes a shell injection. Always pass arguments as an array and let `spawn` handle escaping.
- The timeout propagates via the Node `child_process` timeout option, which sends `SIGTERM` after the deadline. Add a `SIGKILL` fallback if the CLI ignores `SIGTERM`.

## Registering the tools

Now wire up two `git` tools. The first, `git_log`, returns the last N commits for a repo. The second, `git_diff`, returns the unstaged diff:

```typescript
// src/index.ts (continued)
// @modelcontextprotocol/sdk 1.29.0

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "git-mcp",
  version: "1.0.0",
});

server.registerTool(
  "git_log",
  {
    description:
      "Return the last N commits for a git repository. " +
      "Includes hash, author, date, and subject line.",
    inputSchema: {
      repo: z.string().describe("Absolute path to the git repository root"),
      count: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(20)
        .describe("Number of commits to return"),
    },
  },
  async ({ repo, count }) => {
    const result = await runCli(
      "git",
      ["log", `--max-count=${count}`, "--pretty=format:%H|%an|%ad|%s", "--date=iso"],
      repo
    );

    if (result.exitCode !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `git log failed (exit ${result.exitCode}):\n${result.stderr}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: result.stdout || "(no commits)" }],
    };
  }
);

server.registerTool(
  "git_diff",
  {
    description:
      "Return the unstaged diff for a git repository, or the diff for a specific file.",
    inputSchema: {
      repo: z.string().describe("Absolute path to the git repository root"),
      file: z
        .string()
        .optional()
        .describe("Optional relative path to a specific file"),
      staged: z
        .boolean()
        .default(false)
        .describe("If true, show staged (cached) diff instead of unstaged"),
    },
  },
  async ({ repo, file, staged }) => {
    const args = ["diff"];
    if (staged) args.push("--cached");
    if (file) args.push("--", file);

    const result = await runCli("git", args, repo);

    if (result.exitCode !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `git diff failed (exit ${result.exitCode}):\n${result.stderr}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text", text: result.stdout || "(no changes)" },
      ],
    };
  }
);
```

A few things to pay attention to in the tool handlers:

- The `inputSchema` uses Zod schemas directly. The SDK converts them to JSON Schema for the client's tool-call validation. If you pass a plain JSON Schema object instead, you lose the `.default()` and `.optional()` semantics.
- Return `isError: true` alongside the content when the CLI exits with a non-zero code. This tells the client the invocation failed without throwing an exception that would crash the server.
- Keep the `repo` parameter as an absolute path the client must supply. Do not try to infer it from `process.cwd()` -- the server's working directory is wherever the MCP client spawned it, which is almost never the user's repo.

## Connecting the transport and starting the server

Add the main entry point at the bottom of `src/index.ts`:

```typescript
// src/index.ts (continued)
// @modelcontextprotocol/sdk 1.29.0, stdio transport

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("git-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

Build and verify it compiles:

```bash
npm run build
```

## Wiring it to Claude Desktop

Open the Claude Desktop config. On macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`. On Windows: `%AppData%\Claude\claude_desktop_config.json`.

Add your server under `mcpServers`:

```json
{
  "mcpServers": {
    "git-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/git-mcp/build/index.js"]
    }
  }
}
```

Restart Claude Desktop. The hammer icon in the toolbar should appear showing `git_log` and `git_diff` as available tools. You can now ask Claude: "Show me the last 10 commits in /Users/me/projects/myrepo" and it will call `git_log` directly.

To wire it to Claude Code, add the same block to your Claude Code MCP settings (`.claude/settings.json` under `mcpServers`), or run `claude mcp add git-mcp -- node /path/to/build/index.js` from the terminal.

## Gotchas in production CLI wrappers

**Large output truncation.** Some CLIs produce megabytes of output (`git diff` on a large refactor, `ps aux`, a full SQL dump). The MCP spec does not enforce a hard content-size limit, but clients have practical limits. Add a `maxBytes` guard in `runCli` and return a truncation notice:

```typescript
const MAX_BYTES = 512_000; // 500 KB

// after collecting chunks:
const raw = Buffer.concat(chunks);
const text =
  raw.byteLength > MAX_BYTES
    ? raw.slice(0, MAX_BYTES).toString("utf8") + "\n\n[output truncated]"
    : raw.toString("utf8");
```

**Windows PATH lookup.** On Windows, `spawn("git", ...)` with `shell: false` may fail if `git` is not on the PATH that the MCP client inherits. Either use the full path to the executable, or spawn a `cmd.exe /c git ...` wrapper (with proper argument sanitization). Alternatively, resolve the executable path at startup using the `which` npm package and cache the result.

**Timeout on slow operations.** `git log` on a repo with 500,000 commits can take several seconds. Tune `timeoutMs` per tool rather than using a global default. Expose it as an optional parameter if the user's repo size is unpredictable.

**Error messages from stderr.** Many CLIs write usage errors to stderr with exit code 0 (a known bad habit). Check `result.stderr` even when `exitCode === 0` and surface it in the tool response alongside the stdout content.

**No shell globbing.** With `shell: false`, globs like `*.ts` in an argument are not expanded by the shell. If your CLI expects glob expansion, either enumerate the files yourself (using `glob` from npm) or accept only explicit paths in the tool schema.

## Testing without a client

Install `@modelcontextprotocol/inspector` globally to test the server interactively without configuring a full MCP client:

```bash
npm install -g @modelcontextprotocol/inspector
npx @modelcontextprotocol/inspector node build/index.js
```

The inspector opens a browser UI where you can list tools, fill in arguments, and call them directly. It also shows the raw JSON-RPC messages, which makes diagnosing the stdout-corruption problem trivial -- you can see the garbage bytes land in the stream immediately.

## What to expose next

Two tools is a thin slice. The same pattern scales to any CLI your team relies on:

- Expose `git blame`, `git show`, and `git grep` to build a code-archaeology agent.
- Wrap `aws s3 ls` and `aws cloudformation describe-stacks` for an infrastructure-aware agent.
- Expose `sqlite3 :memory: .schema` or `psql \d tablename` to let an agent inspect a database schema before writing queries.
- Wrap a custom internal CLI for deployment, ticket creation, or log export -- things that have lived only in shell scripts because "nobody needed an API for them."

The MCP server does not care what the CLI does. It only needs a well-defined input schema (which Zod gives you in 3 lines) and a handler that runs the binary and returns the output.

If your team uses C# instead of TypeScript, the same pattern is available via the [ModelContextProtocol NuGet package, which we covered when wiring MCP servers on .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/). For a broader look at what MCP looks like when an IDE bundles it directly, [the Azure MCP Server shipping inside Visual Studio 2022 17.14.30](/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) is a useful real-world example of the scale this protocol targets. If you are building autonomous agents that coordinate multiple tools and need a framework beyond raw MCP, [Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) covers the C# side. And for IDE-level agent integration, [agent skills in Visual Studio 2026 18.5](/2026/04/visual-studio-2026-copilot-agent-skills/) show how Copilot auto-discovers skill definitions from your repo's `SKILL.md`.

## Source links

- [MCP TypeScript SDK -- modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26)
- [Official build-server guide -- modelcontextprotocol.io](https://modelcontextprotocol.io/docs/develop/build-server)
- [MCP Inspector -- @modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector)
