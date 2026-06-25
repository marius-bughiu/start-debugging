---
title: "Claude Code 2.1.187 Stops the Sandbox From Reading Your AWS Keys"
description: "The new sandbox.credentials setting in Claude Code v2.1.187 denies reads of credential files and unsets secret env vars before sandboxed Bash commands run. Here is why the default read policy was a hole, and how to close it."
pubDate: 2026-06-25
tags:
  - "claude-code"
  - "ai-agents"
  - "security"
---

Claude Code's Bash sandbox has always had an asymmetry that bites the moment you read the fine print: it locks writes down hard, but reads are wide open. As of v2.1.187, shipped June 24, 2026, there is finally a first-class fix. The new `sandbox.credentials` setting denies reads of specific credential files and strips secret environment variables before any sandboxed command runs.

## Why the default read policy was a hole

The sandbox restricts writes to the working directory and the session temp directory, and routes network traffic through an allowlist proxy. But its default read behavior is "read access to the entire computer, except certain denied directories." That explicitly includes `~/.aws/credentials` and `~/.ssh/`. On top of that, sandboxed Bash commands inherit the parent process environment, so a `GITHUB_TOKEN` or `NPM_TOKEN` exported in your shell is visible to every command Claude runs.

That matters because the network side is not airtight. The built-in proxy makes its allow decision from the client-supplied hostname and does not inspect TLS. Allow a broad domain like `github.com` and a compromised or prompt-injected command has a plausible exfiltration path. Read access to your keys plus a usable egress channel is exactly the combination you do not want in an agent running unattended.

## How sandbox.credentials works

The new block has two arrays, `files` and `envVars`. Listed files are denied for reads inside the sandbox, the same enforcement `filesystem.denyRead` applies, and listed environment variables are unset before each sandboxed command executes.

```json
{
  "sandbox": {
    "enabled": true,
    "credentials": {
      "files": [
        { "path": "~/.aws/credentials", "mode": "deny" },
        { "path": "~/.ssh", "mode": "deny" }
      ],
      "envVars": [
        { "name": "GITHUB_TOKEN", "mode": "deny" },
        { "name": "NPM_TOKEN", "mode": "deny" }
      ]
    }
  }
}
```

Every entry carries `"mode": "deny"`, currently the only supported value. The explicit field keeps the schema open for future modes. File paths follow the same prefix rules as the rest of `sandbox.filesystem.*`: `~/` is your home directory, `/` is absolute, and a bare path is project-relative.

## Why the dedicated block, not just denyRead

You could already deny credential reads with `filesystem.denyRead`. The point of the new block is that it groups file denies with the environment-variable unset and merges across every settings scope. Entries from user, project, and managed settings are combined, and because `deny` is the only mode, any scope can add restrictions but none can remove them.

That makes it a clean lever for managed deployments. Ship `~/.aws` and `~/.ssh` denies plus token unsets from your MDM, and developers cannot widen them locally. It pairs naturally with a locked-down policy: `enabled: true`, `failIfUnavailable: true`, and `allowUnsandboxedCommands: false`.

## Two caveats worth knowing

There is no built-in deny list. Only the files and variables you name are restricted, so an empty config protects nothing. The setting also affects sandboxed Bash commands only. To strip Anthropic and cloud provider credentials from every subprocess regardless of sandboxing, set the `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` environment variable instead.

If you run Claude Code in auto-allow mode against a repo you do not fully trust, this is the setting to add today. Full details are in the [sandboxing docs](https://code.claude.com/docs/en/sandboxing).
