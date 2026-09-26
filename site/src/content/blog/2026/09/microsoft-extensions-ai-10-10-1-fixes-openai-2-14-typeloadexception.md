---
title: "Microsoft.Extensions.AI.OpenAI 10.10.1 Fixes the OpenAI 2.14 TypeLoadException"
description: "OpenAI 2.14.0 renamed GlobalMcpToolCallApprovalPolicy, which broke every tool-carrying Responses call through Microsoft.Extensions.AI.OpenAI 10.10.0. Version 10.10.1 moves to OpenAI 2.14.0 and also picks up the null reasoning status fix for OpenAI-compatible endpoints."
pubDate: 2026-09-26
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "openai"
  - "csharp"
---

`Microsoft.Extensions.AI.OpenAI` 10.10.1 hit NuGet on September 25, 2026, and the [release notes](https://github.com/dotnet/extensions/releases/tag/v10.10.1) are one line: "Upgrade OpenAI SDK to 2.14.0". That line hides a runtime crash. If your app references `Microsoft.Extensions.AI.OpenAI` 10.10.0 and anything in the graph pulled `OpenAI` up to 2.14.0 (a Dependabot bump, a direct reference, another package), every Responses API call that carries a tool has been dying with a `TypeLoadException` since September 15.

## A renamed experimental type, bound at JIT time

`OpenAI` 2.14.0 shipped on September 15. Among its changes, the experimental struct `OpenAI.Responses.GlobalMcpToolCallApprovalPolicy` became `DefaultMcpToolCallApprovalPolicy`, and the `GlobalPolicy` property on `McpToolCallApprovalPolicy` became `DefaultPolicy`. Experimental APIs (`OPENAI001`) are allowed to break, but `Microsoft.Extensions.AI.OpenAI` 10.10.0 was compiled against the old name inside `OpenAIResponsesChatClient.ToResponseTool`, the method that maps every `AITool` to a Responses tool.

The 10.10.0 nuspec declares `OpenAI` with a minimum of `2.13.0`, so NuGet happily resolves 2.14.0 when something else asks for it. Nothing fails at build time. The first call through a tool-carrying `ChatOptions` fails when the JIT compiles `ToResponseTool`:

```text
System.TypeLoadException: Could not load type 'OpenAI.Responses.GlobalMcpToolCallApprovalPolicy'
from assembly 'OpenAI, Version=2.14.0.0, Culture=neutral, PublicKeyToken=b4187f3e65366280'.
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.ToResponseTool(AITool tool, ChatOptions options, ToolSearchLookup toolSearchLookup)
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.AsCreateResponseOptions(...)
   at Microsoft.Extensions.AI.OpenAIResponsesChatClient.GetStreamingResponseAsync(...)
```

It does not matter whether you use MCP. The method references the type, so a plain `AIFunction` triggers it too. [Issue #7760](https://github.com/dotnet/extensions/issues/7760) reported it with `Microsoft.Agents.AI.OpenAI` 1.21.0 on .NET 10.

## Why staying on OpenAI 2.13.0 was not a clean workaround

Pinning `OpenAI` back to 2.13.0 avoids the crash, but 2.13.0 has its own bug: `ReasoningResponseItem` deserialization calls `ToReasoningStatus()` on a JSON `null`. Third-party OpenAI-compatible backends that serialize a reasoning item as `"status": null` instead of omitting it tear down the whole SSE stream with `ArgumentOutOfRangeException: Unknown ReasoningStatus value`. OpenAI 2.14.0 added the null guard. So for a week you had to pick which bug you wanted.

[PR #7761](https://github.com/dotnet/extensions/pull/7761) resolves both: it bumps to `OpenAI` 2.14.0, maps `HostedMcpServerToolAlwaysRequireApprovalMode` and `HostedMcpServerToolNeverRequireApprovalMode` onto `DefaultMcpToolCallApprovalPolicy`, and adds a streaming regression test for the null `status` case.

## The upgrade

Move both packages together. `Microsoft.Extensions.AI.OpenAI` 10.10.1 now requires `OpenAI` 2.14.0, so if you pinned 2.13.0 as a workaround, drop that pin or you will get an `NU1605` downgrade error:

```xml
<ItemGroup>
  <PackageReference Include="Microsoft.Extensions.AI.OpenAI" Version="10.10.1" />
  <PackageReference Include="OpenAI" Version="2.14.0" />
</ItemGroup>
```

Then check what actually resolved, since agent frameworks and SDK wrappers often bring these in transitively:

```bash
dotnet list package --include-transitive | grep -E "OpenAI|Extensions.AI"
```

If you touch the MCP approval types directly in your own code, the rename applies to you as well:

```csharp
#pragma warning disable OPENAI001
var policy = new McpToolCallApprovalPolicy(DefaultMcpToolCallApprovalPolicy.NeverRequireApproval);
var mode = policy.DefaultPolicy; // was policy.GlobalPolicy in OpenAI 2.13.0
#pragma warning restore OPENAI001
```

The broader lesson: a library's minimum-version dependency on a package with experimental APIs is effectively an open range for breaking changes. If you run a Responses-based agent in production, a smoke test that sends one tool-carrying request after every dependency bump would have caught this in CI instead of at runtime. For the rest of what changed in this release line, see the earlier write-up on [Microsoft.Extensions.AI 10.10 failing unscored evaluation metrics](/2026/09/microsoft-extensions-ai-10-10-fails-closed-on-unscored-evaluation-metrics/).
