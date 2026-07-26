---
title: "How to Lock Down a Coding Agent's Network Egress With a Strict Host Allowlist"
description: "Claude Code, Cursor, and the GitHub Copilot coding agent all ship host allowlists for outbound traffic, and all three default to something looser than you want. The exact settings keys, a policy you can copy, and the four surfaces the allowlist does not cover."
pubDate: 2026-07-26
tags:
  - "ai-agents"
  - "claude-code"
  - "cursor"
  - "github-copilot"
  - "security"
  - "mcp"
---

An agent that can read your repository and reach the open internet has everything it needs to exfiltrate it. Every mainstream coding agent now ships a host allowlist for outbound traffic: Claude Code has `sandbox.network.allowedDomains` (with fail-closed `strictAllowlist` as of v2.1.219, July 2026), Cursor has `networkPolicy` in `.cursor/sandbox.json` (since 2.5, February 2026), and the GitHub Copilot coding agent has a firewall with a recommended allowlist you can extend or replace. This post covers the exact keys for each, a starting policy narrow enough to be worth having, and the four execution surfaces that slip past the allowlist entirely.

## Why egress, and not just file permissions

Most people harden the filesystem first, because that is the part you can picture: the agent overwrites `~/.bashrc`, the agent deletes a directory. Egress is the half that matters more once the agent is unattended, and the reasoning is short. Read access is the default almost everywhere. Claude Code's sandbox, for example, grants "read access to the entire computer, except certain denied directories," which by default includes `~/.aws/credentials` and `~/.ssh/`. If the agent can read a secret and open a socket to a host of its choosing, the secret is gone. Blocking the read side is worth doing, and [the `sandbox.credentials` block added in v2.1.187](/2026/06/claude-code-sandbox-credentials-block-secrets-from-bash/) is how you do it, but the egress policy is what turns a read into a non-event.

The threat is not a hypothetical malicious model. It is prompt injection, and it has already landed. The [DuneSlide pair of Cursor CVEs](/2026/07/cursor-duneslide-prompt-injection-sandbox-escape-rce/) turned a poisoned MCP response or web search result into code execution. In that class of attack, the attacker controls what the agent runs but not what the network lets out. The allowlist is the layer that stays honest when the prompt layer does not.

## Claude Code: sandbox.network

Claude Code's Bash sandbox runs on macOS, Linux, and WSL2 (native Windows is unsupported), and enforces two independent layers: filesystem isolation and network isolation. Network isolation works through a proxy that runs outside the sandbox. On Linux the sandboxed process has its network namespace removed entirely, so there is no path out except the proxy; on macOS the Seatbelt profile permits only a single localhost port.

The important default: **no domains are pre-allowed**. The first time a command needs a host, Claude Code prompts. As of v2.1.191, answering yes allows that host for the rest of the session.

A prompt is fine when you are sitting there. For anything unattended, a prompt nobody answers is a hang. That is what `strictAllowlist` fixes:

```json
// ~/.claude/settings.json, Claude Code v2.1.219 or later
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "network": {
      "strictAllowlist": true,
      "allowedDomains": [
        "registry.npmjs.org",
        "*.npmjs.org",
        "api.github.com",
        "codeload.github.com",
        "objects.githubusercontent.com"
      ],
      "deniedDomains": ["gist.github.com", "gist.githubusercontent.com"]
    }
  }
}
```

Four keys are doing the work:

- `strictAllowlist` (v2.1.219+) blocks non-allowed domains instead of prompting. Before this shipped, only managed deployments could fail closed, via `allowManagedDomainsOnly`.
- `failIfUnavailable` makes a missing `bubblewrap` or `socat` on Linux stop Claude Code from starting. Without it, the default behavior is a warning followed by running commands **unsandboxed**, which is exactly the silent downgrade you do not want in CI.
- `allowedDomains` supports wildcards. `WebFetch` allow rules also pre-allow domains for the sandbox, so an existing `WebFetch(domain:example.com)` rule widens egress whether you meant it to or not.
- `deniedDomains` blocks a host even when a broader wildcard in `allowedDomains` would permit it. Deny wins.

That last pair is the one to internalize. Allowing `*.github.com` in a repository that has any secret in it also allows `gist.github.com`, and creating a gist is a one-line POST. The explicit deny above is not paranoia, it is closing the most convenient hole in the most commonly allowed wildcard.

On Linux, install the optional seccomp filter (`npm install -g @anthropic-ai/sandbox-runtime`) if `/sandbox` lists it as missing. It is what blocks Unix domain sockets, and without it the network namespace is not the only way out.

### For an organization, not just a laptop

Array keys such as `allowedDomains` merge across settings scopes, which means a developer can append to your managed policy. To pin the network policy to the managed values only:

```json
// managed settings, deployed via MDM or server-managed settings
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "network": {
      "allowManagedDomainsOnly": true,
      "allowedDomains": ["registry.npmjs.org", "api.github.com"]
    }
  }
}
```

`allowManagedDomainsOnly` makes non-allowed domains block automatically and honors only `allowedDomains` and `WebFetch(domain:...)` rules from managed settings. `allowUnsandboxedCommands: false` disables the `dangerouslyDisableSandbox` escape hatch, so a command that fails under the sandbox cannot be retried outside it.

There is one lockdown that does not exist: `excludedCommands` has no managed-only equivalent. A developer can always append an entry that runs a given command outside the sandbox, and outside the sandbox means outside the egress policy. Keep the managed list as short as you can defend.

If your threat model needs actual traffic inspection rather than hostname filtering, point the sandbox at your own MITM proxy:

```json
{
  "sandbox": {
    "network": { "httpProxyPort": 8080, "socksProxyPort": 8081 }
  }
}
```

Note that Go-based CLIs (`gh`, `gcloud`, `terraform`) can fail TLS verification under Seatbelt on macOS. With a custom CA in play, `enableWeakerNetworkIsolation` is the documented workaround rather than dumping those tools into `excludedCommands`.

## Cursor: .cursor/sandbox.json

Cursor's sandbox config lives in two files: `~/.cursor/sandbox.json` for all workspaces and `<workspace>/.cursor/sandbox.json` for one repo. The network section is a `networkPolicy` object with a default posture and two lists:

```json
// <workspace>/.cursor/sandbox.json, Cursor 2.5 or later
{
  "type": "workspace_readwrite",
  "networkPolicy": {
    "default": "deny",
    "allow": [
      "registry.npmjs.org",
      "*.crates.io",
      "pypi.org",
      "*.pythonhosted.org"
    ],
    "deny": ["*.ngrok.io", "0.0.0.0/0"]
  }
}
```

Pattern syntax accepts exact domains, wildcards, and CIDR notation, which is the one genuinely useful capability Claude Code's hostname-only allowlist lacks. Private address ranges and cloud metadata endpoints are blocked by default, so the classic `169.254.169.254` credential grab is off the table without you configuring anything.

Merge order runs per-user, then per-repo, then team-admin, then Cursor's hardcoded rules, each layer able to tighten but not loosen. Path lists union; network allow lists union too, **unless** a team-admin policy exists, in which case the admin list replaces the union rather than adding to it. Deny lists always union. If you administer a Cursor Enterprise org, that replacement semantics is the reason your admin allowlist has to be complete: it is not additive to what developers already had working.

The UI surfaces three postures, and they map onto the file directly: user config only (your `allow` list alone), user config with defaults (your list plus Cursor's built-ins), and allow all. "Allow all" is the equivalent of no policy. Pick it only for a workspace with nothing worth stealing in it.

## GitHub Copilot coding agent: the firewall

The Copilot coding agent runs in a GitHub Actions appliance with a firewall in front of it, configured under **Repository settings > Copilot > Internet access** or the same path at the organization level. Cloud agent and code review are configured independently.

The recommended allowlist is on by default and covers OS package repos, container registries (including `ghcr.io`), language registries (`registry.npmjs.com`, `pypi.org`, `crates.io`, `*.pythonhosted.org`), certificate authorities for OCSP and CRL checks, and browser downloads for the Playwright MCP server. Turning it off is supported and is the right call for a repository that builds from a vendored or internal mirror. For everything else, leave it on and add your own entries.

Custom entries come in two shapes:

- **Domain**, written without a scheme: `packages.contoso.corp`. This allows the domain **and all subdomains**, so `prod.packages.contoso.corp` passes while `artifacts.contoso.corp` does not.
- **URL**, with scheme and path: `https://packages.contoso.corp/project-1/`. Traffic is limited to that scheme, host, and path plus descendants. `https://packages.contoso.corp/project-1/tags/latest` passes, `https://packages.contoso.corp/project-2` does not.

Prefer the URL form for internal artifact feeds. A bare domain entry for a shared artifact host hands the agent every project on that host.

When the firewall blocks a request, GitHub writes a warning into the pull request body for a new PR, or a comment on an existing one, showing the blocked address and the command that tried to reach it. That is your allowlist-building feedback loop: run the agent, read the warnings, add the hosts you actually need. It beats guessing, and it beats the alternative of a silent hang.

Since April 2026, organization admins can also control whether repository admins may add custom allowlist entries at all. The default lets each repository decide.

## Agents without a built-in allowlist

Aider, a hand-rolled agent loop, or anything driving a model through an SDK has no egress policy of its own. Wrap the whole process instead. Anthropic publishes the primitives behind the Claude Code sandbox as a standalone package, `@anthropic-ai/sandbox-runtime`, with an `srt` CLI:

```bash
# Sandbox any process. Linux needs bubblewrap, socat, ripgrep.
npm install -g @anthropic-ai/sandbox-runtime
srt --settings ./agent-sandbox.json "aider --yes --model sonnet"
```

```json
// agent-sandbox.json. Deny-by-default: nothing is reachable unless listed.
{
  "network": {
    "allowedDomains": [
      "api.anthropic.com",
      "registry.npmjs.org",
      "*.github.com"
    ],
    "deniedDomains": ["gist.github.com"]
  }
}
```

The default config path is `~/.srt-settings.json`. On Windows this uses the Windows Filtering Platform to block outbound connections from the sandbox account except loopback to the proxy ports, after a one-time `npx @anthropic-ai/sandbox-runtime windows-install`. That is worth knowing, because it is the one path to an enforced egress policy for an agent on native Windows, where the Claude Code Bash sandbox does not run at all.

Wrapping the whole process has a second advantage over the built-in sandbox, and it is the subject of the next section.

## The four surfaces your allowlist does not cover

This is where most policies quietly fail. Every allowlist above covers less than the phrase "the agent's network access" implies.

**1. MCP servers.** GitHub's docs are explicit that the firewall does not apply to MCP servers. The same structural gap exists in Claude Code: the sandbox isolates Bash subprocesses, while stdio MCP servers are launched by the Claude Code process itself rather than through the Bash tool. Your MCP server can reach any host it likes. If you run MCP servers you did not write, that matters more than the rest of this post. Wrapping the entire agent process with `srt` is the way to bring them inside a policy.

**2. Setup steps and pre-agent hooks.** The Copilot firewall does not apply to processes started in configured Copilot setup steps. Dependency installation you moved into setup to make it faster is dependency installation you moved out of the firewall.

**3. Commands you excluded.** `excludedCommands` in Claude Code runs the listed commands outside the sandbox entirely. `docker`, which is incompatible with the sandbox and commonly excluded, can start a container with unrestricted networking. Excluding a command excludes its egress policy too.

**4. TLS itself.** Claude Code's built-in proxy makes its allow decision from the **client-supplied hostname** and, by default, does not terminate or inspect TLS. Code inside the sandbox can use domain fronting to reach a host outside the allowlist. The experimental `network.tlsTerminate` setting (v2.1.199+) makes the proxy terminate TLS, but it exists to support `mask` credential substitution and does not add content filtering. If you need a real guarantee here, the custom proxy path with your own CA installed inside the sandbox is the only answer today. Anthropic describes stronger TLS-aware isolation as an active area of development, which is a fair way of saying it is not there yet.

Add a fifth for completeness: a broad wildcard. `*.github.com` and `*.amazonaws.com` are each a general-purpose upload endpoint wearing a familiar name. The allowlist is only as strong as its narrowest useful entry.

## The policy worth copying

If you take one configuration away, take this shape, and adjust the hosts to your stack:

1. **Fail closed.** `strictAllowlist` in Claude Code, `"default": "deny"` in Cursor, recommended allowlist on in Copilot.
2. **Fail hard when the sandbox is unavailable.** `failIfUnavailable: true`. A warning-and-continue is worse than a crash, because you will not notice it.
3. **Allowlist package registries, not vendors.** `registry.npmjs.org` rather than `*.npmjs.org` if your tooling tolerates it. Never a bare `github.com` in a repo with secrets.
4. **Deny the upload endpoints inside your allows.** Gists, raw content hosts, and object storage under a domain you had to allow anyway.
5. **Strip the credentials too.** Egress control and `sandbox.credentials` are the two halves of the same control. Neither one is sufficient alone.
6. **Build the list from failures, not from imagination.** Run the agent, collect the blocked-host prompts or the PR warnings, add what it genuinely needed, then freeze the list.

The one thing not to do is treat any of this as a boundary strong enough to run untrusted input against without supervision. It is a meaningful reduction in blast radius, enforced by the OS rather than by the model's good judgment, and that is worth a lot. It is not a proof. For unattended runs specifically, pair the egress policy with a disposable environment, which is the same argument for [running Claude Code inside a GitHub Action](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/) rather than on the laptop that holds your production credentials.

## Related

- [Claude Code 2.1.187 Stops the Sandbox From Reading Your AWS Keys](/2026/06/claude-code-sandbox-credentials-block-secrets-from-bash/)
- [Claude Code 2.1.219 Reopens Nested Subagents, Three Layers Deep](/2026/07/claude-code-2-1-219-nested-subagents-three-layers-deep/)
- [DuneSlide: Two Cursor Bugs That Turn Prompt Injection Into Zero-Click RCE](/2026/07/cursor-duneslide-prompt-injection-sandbox-escape-rce/)
- [How to Gate Which Cursor SDK Tool Calls Run Automatically With Auto-Review and permissions.json](/2026/06/gate-cursor-sdk-tool-calls-with-auto-review-and-permissions-json/)
- [How to Run Claude Code in a GitHub Action for Autonomous PR Review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/)

## Sources

- Anthropic, [Configure the sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing) and [Sandbox environments](https://code.claude.com/docs/en/sandbox-environments).
- Anthropic, [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) and the [starter settings examples](https://github.com/anthropics/claude-code/tree/main/examples/settings).
- Cursor, [`sandbox.json` reference](https://cursor.com/docs/reference/sandbox) and the [2.5 changelog](https://cursor.com/changelog/2-5).
- GitHub, [Customizing or disabling the firewall for GitHub Copilot coding agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall) and the [Copilot allowlist reference](https://docs.github.com/en/copilot/reference/copilot-allowlist-reference).
- GitHub Changelog, [Organization firewall settings for Copilot cloud agent](https://github.blog/changelog/2026-04-03-organization-firewall-settings-for-copilot-cloud-agent/).
