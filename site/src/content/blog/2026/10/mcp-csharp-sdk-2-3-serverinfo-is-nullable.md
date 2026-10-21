---
title: "MCP C# SDK 2.3: McpClient.ServerInfo is now nullable, and your build may notice"
description: "ModelContextProtocol 2.3.0, released October 20, 2026, changes McpClient.ServerInfo from Implementation to Implementation? because 2026-07-28 servers may omit their identity from server/discover. Here is why, what breaks under warnings-as-errors, and the one-line fix."
pubDate: 2026-10-21
tags:
  - "mcp"
  - "dotnet"
  - "csharp"
  - "ai-agents"
---

The [MCP C# SDK 2.3.0](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.3.0) shipped on October 20, 2026, and it carries one change that a minor version normally would not: `McpClient.ServerInfo` is now annotated `Implementation?` instead of `Implementation`. The CLR signature is identical, so nothing breaks at runtime or for already-compiled callers. What breaks is any project with `<Nullable>enable</Nullable>` and `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` that dereferences the property directly.

## Why a connected server can have no identity

Under the `2026-07-28` protocol revision, the handshake is `server/discover` rather than the legacy `initialize`. In discovery, the `io.modelcontextprotocol/serverInfo` metadata is optional. A server can answer discovery, advertise its tools, and serve calls without ever saying who it is.

Before 2.3.0, the SDK did not model that. Connecting to such a server succeeded, but reading `ServerInfo` afterwards threw `InvalidOperationException`, the same exception you get when the client is not connected at all. A perfectly valid server looked like a broken connection. [PR #1903](https://github.com/modelcontextprotocol/csharp-sdk/pull/1903) fixed it by returning `null` instead:

```csharp
public override Implementation? ServerInfo => _serverCapabilities is null
    ? throw new InvalidOperationException("The client is not connected.")
    : _serverInfo;
```

Three rules come out of that:

- Not connected yet: still throws `InvalidOperationException`.
- Connected over `2026-07-28` and the server omitted its identity: `null`.
- Connected over legacy `initialize`: never `null`, because that path still requires `serverInfo`.

Malformed metadata still fails the connection with a `JsonException`, so `null` really means "not provided", not "garbage".

## The fix in client code

Code like this now raises CS8602 on the `.Name` access:

```csharp
await using var client = await McpClient.CreateAsync(transport);

logger.LogInformation("Connected to {Server} {Version}",
    client.ServerInfo.Name, client.ServerInfo.Version);
```

Handle the null case explicitly:

```csharp
await using var client = await McpClient.CreateAsync(transport);

var name = client.ServerInfo?.Name ?? "Unknown server";
var version = client.ServerInfo?.Version ?? "n/a";

logger.LogInformation("Connected to {Server} {Version}", name, version);
```

Resist the `!` operator. It silences the warning and brings back a `NullReferenceException` the first time someone points your client at a discovery-only server. The release notes are also blunt that this self-reported identity "must not be used for security decisions". If your code gates tool access on `ServerInfo.Name`, that was already wrong, and a `null` here is a good moment to replace it with configuration you control.

## The rest of 2.3.0

The release is mostly interop and reliability work worth picking up anyway:

- `McpClientOptions.TimeProvider` lets tests drive client timeouts with `FakeTimeProvider` instead of real waits. OAuth is now excluded from the short `DiscoverProbeTimeout` budget but still bound by `InitializationTimeout`.
- Tools, prompts and resources are listed in registration order (#1924), so `tools/list` output is stable across runs.
- Modern Streamable HTTP responses wait for the first protocol message before sending headers. A handler that stays silent for a long time may now need progress notifications or a longer HTTP timeout.
- Stdio clients close the server's stdin before waiting for a graceful exit, and legacy SSE POST responses are disposed deterministically.
- Streamable HTTP 400 responses include the JSON parse error, which makes malformed client payloads much faster to debug.

Upgrading is a package bump:

```bash
dotnet add package ModelContextProtocol --version 2.3.0
```

If you are still on 1.x, do the [1.x to 2.x migration](/2026/09/migrate-mcp-csharp-sdk-1-x-to-2-0-without-breaking-old-clients/) first, then build with warnings as errors and let the compiler show you every `ServerInfo` dereference.
