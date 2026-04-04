#!/usr/bin/env node
/*
 * git-push MCP server (zero dependencies)
 *
 * Purpose
 * -------
 * Cowork scheduled tasks run inside an Ubuntu sandbox whose egress proxy
 * blocks github.com, api.github.com, and codeload.github.com. That means
 * `git push` from inside the sandbox always returns HTTP 403 at the proxy.
 *
 * This MCP server is launched by the Cowork MCP client as a native host
 * process (Windows / macOS / Linux - NOT inside the sandbox). It therefore
 * has the user's real network connectivity and Git Credential Manager, so
 * it can actually push to GitHub. The scheduled task invokes its tools
 * over stdio.
 *
 * Protocol
 * --------
 * MCP over stdio = newline-delimited JSON-RPC 2.0 messages on stdin/stdout.
 * Logs go to stderr so they don't corrupt the protocol stream.
 *
 * Tools exposed
 * -------------
 * - git_status : `git status --short` + current branch (sanity check)
 * - git_log    : last N commits (default 5)
 * - git_push   : optional `git pull --rebase`, then `git push`. Returns
 *                the pushed commit hash range.
 *
 * Configuration
 * -------------
 * REPO_ROOT env var points at the repository root. If not set, the server
 * uses the parent directory of this file's grandparent (assumes the layout
 * `<repo>/mcp-servers/git-push/server.js`).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const readline = require("readline");

const SERVER_NAME = "git-push";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";

function log(...args) {
  // All server logs MUST go to stderr. stdout is reserved for JSON-RPC.
  try {
    process.stderr.write("[git-push-mcp] " + args.join(" ") + "\n");
  } catch (_) {}
}

function resolveRepoRoot() {
  if (process.env.REPO_ROOT && process.env.REPO_ROOT.trim()) {
    return path.resolve(process.env.REPO_ROOT.trim());
  }
  // server.js lives at <repo>/mcp-servers/git-push/server.js
  return path.resolve(__dirname, "..", "..");
}

const REPO_ROOT = resolveRepoRoot();

function ensureRepo() {
  const gitDir = path.join(REPO_ROOT, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new Error(
      "REPO_ROOT does not look like a git repo (no .git dir): " + REPO_ROOT
    );
  }
}

function runGit(args, { timeoutMs = 120000 } = {}) {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    code: result.status === null ? -1 : result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    signal: result.signal || null,
    error: result.error ? String(result.error) : null,
  };
}

function currentBranch() {
  const r = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.code !== 0) throw new Error("git rev-parse failed: " + r.stderr);
  return r.stdout;
}

// -------- Tool implementations --------

function toolGitStatus() {
  ensureRepo();
  const branch = currentBranch();
  const status = runGit(["status", "--short", "--branch"]);
  if (status.code !== 0) throw new Error("git status failed: " + status.stderr);
  const ahead = runGit(["rev-list", "--count", "@{u}..HEAD"]);
  const behind = runGit(["rev-list", "--count", "HEAD..@{u}"]);
  const lines = [
    "repo:   " + REPO_ROOT,
    "branch: " + branch,
    "ahead:  " + (ahead.code === 0 ? ahead.stdout : "?"),
    "behind: " + (behind.code === 0 ? behind.stdout : "?"),
    "",
    status.stdout || "(working tree clean)",
  ];
  return lines.join("\n");
}

function toolGitLog({ limit = 5 } = {}) {
  ensureRepo();
  const n = Math.max(1, Math.min(50, Number(limit) || 5));
  const r = runGit(["log", "--oneline", "-n", String(n)]);
  if (r.code !== 0) throw new Error("git log failed: " + r.stderr);
  return r.stdout || "(no commits)";
}

function toolGitPush({ pullRebase = true, branch = null } = {}) {
  ensureRepo();
  const target = branch && String(branch).trim() ? String(branch).trim() : currentBranch();
  const lines = [];
  lines.push("repo:   " + REPO_ROOT);
  lines.push("branch: " + target);

  const before = runGit(["rev-parse", "HEAD"]);
  if (before.code !== 0) throw new Error("git rev-parse HEAD failed: " + before.stderr);

  if (pullRebase) {
    const pull = runGit(["pull", "--rebase", "origin", target], { timeoutMs: 180000 });
    lines.push("");
    lines.push("$ git pull --rebase origin " + target);
    lines.push(pull.stdout);
    if (pull.stderr) lines.push(pull.stderr);
    if (pull.code !== 0) {
      throw new Error(
        "git pull --rebase failed (code " + pull.code + "):\n" +
          (pull.stderr || pull.stdout)
      );
    }
  }

  const push = runGit(["push", "origin", target], { timeoutMs: 180000 });
  lines.push("");
  lines.push("$ git push origin " + target);
  lines.push(push.stdout);
  if (push.stderr) lines.push(push.stderr);
  if (push.code !== 0) {
    throw new Error(
      "git push failed (code " + push.code + "):\n" +
        (push.stderr || push.stdout)
    );
  }

  const after = runGit(["rev-parse", "HEAD"]);
  lines.push("");
  lines.push("before: " + before.stdout);
  lines.push("after:  " + (after.code === 0 ? after.stdout : "?"));

  return lines.join("\n");
}

// -------- MCP protocol glue --------

const TOOLS = [
  {
    name: "git_status",
    description:
      "Report the current branch, ahead/behind counts vs origin, and short working-tree status for the configured repository. Use this as a cheap health check before pushing.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "git_log",
    description:
      "Return the last N commits as `<hash> <subject>` lines (default 5, max 50).",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Number of commits to show (default 5).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "git_push",
    description:
      "Push the current branch to origin. By default runs `git pull --rebase origin <branch>` first to avoid non-fast-forward rejections. Runs as a native host process, so it uses your real network and Git Credential Manager (unlike git inside the Cowork sandbox, which is blocked by the egress proxy). Returns the before/after HEAD hashes.",
    inputSchema: {
      type: "object",
      properties: {
        pullRebase: {
          type: "boolean",
          description: "Run `git pull --rebase` before pushing. Default true.",
        },
        branch: {
          type: "string",
          description: "Override the branch to push. Default is the current HEAD branch.",
        },
      },
      additionalProperties: false,
    },
  },
];

function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  sendMessage({ jsonrpc: "2.0", id, error: err });
}

function handleToolsCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  try {
    let text;
    switch (name) {
      case "git_status":
        text = toolGitStatus();
        break;
      case "git_log":
        text = toolGitLog(args);
        break;
      case "git_push":
        text = toolGitPush(args);
        break;
      default:
        return sendError(id, -32601, "Unknown tool: " + String(name));
    }
    sendResult(id, {
      content: [{ type: "text", text }],
      isError: false,
    });
  } catch (e) {
    log("tool error:", name, String(e && e.message ? e.message : e));
    sendResult(id, {
      content: [{ type: "text", text: String(e && e.message ? e.message : e) }],
      isError: true,
    });
  }
}

function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case "tools/list":
      sendResult(id, { tools: TOOLS });
      return;
    case "tools/call":
      handleToolsCall(id, params);
      return;
    case "ping":
      sendResult(id, {});
      return;
    default:
      if (id !== undefined && id !== null) {
        sendError(id, -32601, "Method not found: " + method);
      }
      return;
  }
}

function handleNotification(msg) {
  // notifications/initialized and similar. No response.
  log("notification:", msg.method);
}

function main() {
  log("starting, repo root =", REPO_ROOT);
  try {
    ensureRepo();
  } catch (e) {
    log("WARNING:", String(e && e.message ? e.message : e));
    // Don't exit — the server still starts so the client can see the error
    // in tool responses instead of a mysterious process crash.
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      log("failed to parse message:", trimmed.slice(0, 200));
      return;
    }
    if (msg.id === undefined || msg.id === null) {
      handleNotification(msg);
    } else {
      handleRequest(msg);
    }
  });
  rl.on("close", () => {
    log("stdin closed, exiting");
    process.exit(0);
  });
}

main();
