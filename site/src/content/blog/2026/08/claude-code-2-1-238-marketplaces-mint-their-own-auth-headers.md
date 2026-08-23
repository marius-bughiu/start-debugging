---
title: "Claude Code 2.1.238 Lets a Plugin Marketplace Mint Its Own Auth Headers"
description: "A headersHelper field on url marketplaces and catalog entries runs a local command that prints HTTP headers, so an internal plugin catalog behind S3 or an artifact repo can authenticate with a short-lived token. Here is the schema, the consent prompt, and the header names Claude Code drops."
pubDate: 2026-08-23
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
  - "security"
---

Distributing internal Claude Code plugins has meant hosting a git repository the client can already authenticate to. Claude Code 2.1.238, published to npm on August 20, 2026, removes that constraint: a marketplace can now run a local command that prints HTTP headers, and those headers go out with the catalog fetch and the plugin downloads. I confirmed the schema against the 2.1.239 Windows build (commit `9bf8e95`, built 2026-08-21), where `headersHelper` appears in the marketplace and catalog schemas for the first time. In 2.1.224 the field existed only on MCP server definitions.

## One command, one JSON object of headers

The field sits on a `url` source marketplace alongside the existing static `headers` map:

```json
{
  "source": {
    "source": "url",
    "url": "https://artifacts.internal/claude/marketplace.json",
    "headersHelper": "/usr/local/bin/mint-artifact-token"
  }
}
```

The command prints a JSON object, its output overrides `headers`, and it is re-run on every refresh of that marketplace. Two details bite in practice. It runs from a fixed directory, the Claude config home rather than the session's working directory, so use a bare command resolvable on `PATH` or an absolute path. And its headers are inherited by same-origin archive downloads, which is what makes this useful with the `archive` plugin source: a plain HTTPS zip on S3, GitLab, or nginx, with no git or npm on the client. Pair it with `sha256` on the entry, which is verified on every download and refuses the install on mismatch.

## Per-entry helpers must inline their manifest

A catalog entry can carry its own `headersHelper` that overrides the marketplace's. That one runs only when a user explicitly installs or updates the plugin, never during a catalog browse, and it comes with a rule you will hit immediately if you skip it:

```text
Plugin "internal-tools" sets headersHelper but is not "strict": false. An entry
with headersHelper must inline its full manifest (strict: false, with
commands/agents/hooks/mcpServers declared in the entry) so users can review what
it ships before the command runs
```

Consent has to be informed from the entry alone, before any command executes. At install time you see the destination and the command verbatim: "runs a local command and sends its output as headers to:", followed by the URL and the command line. `claude plugin install -y` accepts that displayed command without the prompt, and is required when stdin is not a TTY.

## Headers you are not allowed to forge

Not every header name survives. Anything declared outside operator-authored managed settings is filtered against a blocklist covering `host`, `cookie`, `forwarded`, `connection`, `transfer-encoding`, `content-length`, `via`, the client-IP family (`x-real-ip`, `true-client-ip`, `cf-connecting-ip` and friends), and the `x-forwarded-`, `x-original-`, and `proxy-` prefixes. Names are lowercased and underscores normalized to hyphens first, so `X_Real_IP` does not slip through. A dropped header logs a warning rather than failing the fetch.

Admins can switch the whole mechanism off with `disableCommandPluginSources` or `allowManagedHooksOnly` in managed settings, in which case the install is refused and the command never runs. This is the same trajectory as [loading plugins from .zip archives in 2.1.128](/2026/05/claude-code-2-1-128-plugin-zip-worktree-fix/): fewer assumptions about what your client can reach. The [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) has the release entry; the [marketplace docs](https://code.claude.com/docs/en/plugin-marketplaces) have not caught up yet.
