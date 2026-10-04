---
title: "The security tracker"
description: "Security for .NET, Flutter, and coding-agent users in one place: authentication, CVE patches, serialization and supply-chain risks, secrets, and locking down AI agents."
tagline: "The patches, configs, and guardrails worth acting on."
pubDate: 2026-09-27
updatedDate: 2026-10-04
indexTags:
  - "security"
  - "prompt-injection"
  - "jwt"
  - "authentication"
  - "cryptography"
---

This pillar collects everything on the site about **security**: authentication in ASP.NET Core, the CVE patches worth upgrading for, serialization and supply-chain risks, keeping secrets out of logs and prompts, and the guardrails a coding agent needs before you let it run unattended.

## What to read first

For web apps, [JWT vs cookie authentication](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) settles the model, and [validating a JWT's issuer, audience, and lifetime](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) is the config people get wrong. On the data side, [migrating off BinaryFormatter](/2026/09/migrate-off-binaryformatter-after-its-removal-in-modern-dotnet/) removes the classic deserialization hole, and [redacting sensitive values from logs](/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/) keeps PII out of your sinks. For the supply chain, [the NuGet signing-certificate rotation](/2026/09/microsoft-nuget-author-signing-certificate-rotation-nu3034/) and [Flutter 3.47.1 blocking plugin-registrant injection](/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/) are the recent ones to act on.

For coding agents, start with [a strict network egress allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/) and [a credential gateway](/2026/09/keep-api-keys-out-of-agent-context-with-a-credential-gateway/) so the agent never holds a real key; [a disposable VM or container](/2026/09/run-coding-agents-in-disposable-vms-and-containers/) keeps it off your host. [Information-flow control](/2026/09/information-flow-control-to-block-prompt-injection-in-agents/) is the structural answer to prompt injection, and [the four permission-check bypasses closed in Claude Code 2.1.251](/2026/08/claude-code-2-1-251-four-ways-around-the-permission-check/) show why version pinning matters.

## What's on this page

The list below auto-collects posts tagged with any of: `security`, `prompt-injection`, `jwt`, `authentication`, `cryptography`. Newest first.

Companion pillars: [the ASP.NET Core 11 cheat sheet](/pillars/aspnetcore-11-cheat-sheet/) and [the coding agents tracker](/pillars/coding-agents-tracker/).
