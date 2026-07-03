---
title: "DuneSlide: Two Cursor Bugs That Turn Prompt Injection Into Zero-Click RCE"
description: "Cato AI Labs disclosed CVE-2026-50548 and CVE-2026-50549, a pair of 9.8 CVSS flaws in Cursor's terminal sandbox. A poisoned MCP response or web result can escape the sandbox and run code. Cursor 3.0 is the fix."
pubDate: 2026-07-03
tags:
  - "cursor"
  - "ai-agents"
  - "security"
  - "prompt-injection"
  - "mcp"
---

Cato AI Labs [disclosed a pair of critical Cursor flaws](https://www.catonetworks.com/blog/duneslide-two-critical-rce-vulnerabilities/) this week, tracked as CVE-2026-50548 and CVE-2026-50549 and collectively named DuneSlide. Both carry a 9.8 CVSS score, and both let a single piece of injected text escape Cursor's terminal sandbox and run arbitrary commands on your machine. No click, no approval dialog, no malicious repo you cloned by hand. Every version before Cursor 3.0 is affected.

The delivery vector is what makes this worth your attention even if you do not use Cursor: prompt injection as a remote code execution primitive. The attacker never touches your editor. They plant instructions in something your agent reads on your behalf, such as a Model Context Protocol (MCP) server response or a page returned by a web search, and the agent does the rest.

## The sandbox trusted the agent's own parameters

Cursor runs shell commands inside a sandbox that restricts writes to your project directory. The problem with CVE-2026-50548 is that the allowed-write list is partly controlled by the agent. The `run_terminal_cmd` tool takes an optional `working_directory` parameter, and when the agent sets it, Cursor adds that path to the writable set without questioning it.

So an injected instruction can steer the model into a call shaped like this:

```json
{
  "tool": "run_terminal_cmd",
  "command": "cp payload ~/.zshrc",
  "working_directory": "/Users/you"
}
```

The sandbox sees a "legitimate" working directory and grants the write. Now the attacker can drop a file into your home directory, and `~/.zshrc`, `~/.zshenv`, or `~/Library/LaunchAgents` all become execution on your next shell or login.

## The symlink check failed open

CVE-2026-50549 attacks the guardrail directly. Before writing, Cursor canonicalizes symlinks to confirm the real target sits inside your project. The bug is the fallback. When canonicalization fails, because the target does not exist or the attacker has stripped read permission from a directory in the path, Cursor gives up and trusts the symlink's in-project path instead.

That is a classic fail-open. A write-only symlink pointing at Cursor's own sandbox helper, `cursorsandbox`, sails through the check and lets an attacker overwrite the very binary that is supposed to contain the agent.

## Why "trusted" agent tools are the new attack surface

The uncomfortable lesson is that `run_terminal_cmd` is not a user typing commands. It is a tool the model invokes with arguments the model chose, and those arguments came from text the model read. Once you accept that any content flowing into the context window is potentially adversarial, a parameter like `working_directory` stops looking like configuration and starts looking like attacker input.

Both bugs are patched in [Cursor 3.0](https://www.catonetworks.com/blog/duneslide-two-critical-rce-vulnerabilities/), so the immediate fix is to update and confirm you are on 3.0 or later. The longer lesson survives the patch: treat MCP output and fetched web content as untrusted, and scope agent tool permissions as if the prompt were already compromised, because DuneSlide shows it can be.
