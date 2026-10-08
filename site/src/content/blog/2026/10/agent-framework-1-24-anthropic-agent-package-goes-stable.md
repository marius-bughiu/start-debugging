---
title: "Agent Framework 1.24: The Anthropic Agent Package Is Stable, Except for Beta Services"
description: "Microsoft.Agents.AI.Anthropic 1.24.0 drops the preview suffix and depends on Anthropic 12.53.0. Agents built from IAnthropicClient are now stable API, while the client.Beta extensions are marked experimental under MAAIANTHROPIC001, which extension-method calls do not trigger."
pubDate: 2026-10-08
tags:
  - "agent-framework"
  - "dotnet"
  - "anthropic"
  - "ai-agents"
---

Microsoft Agent Framework [dotnet-1.24.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.24.0) shipped on October 7, 2026, and one line in the changelog matters more than the rest if you run Claude-backed agents in .NET: [PR #9111](https://github.com/microsoft/agent-framework/pull/9111), "Stabilize Anthropic agent package". Until last week, `Microsoft.Agents.AI.Anthropic` only existed as preview builds (the last one was `1.23.0-preview.260928.1`). On NuGet it is now plain `1.24.0`, published alongside the rest of the framework.

## What stable actually covers

The package has two extension classes, and they did not get the same treatment.

`AnthropicClientExtensions`, which hangs `AsAIAgent` off `IAnthropicClient`, is now shipped public API. The PR adds `PublicAPI.Shipped.txt` baselines for every target framework the package builds for (`net10.0`, `net9.0`, `net8.0`, `netstandard2.0`, `net472`), so package validation will flag breaking changes from here on. The dependency also moved from `Anthropic` 12.45.0 to 12.53.0, the official Anthropic C# SDK, which is itself GA.

`AnthropicBetaServiceExtensions`, the `AsAIAgent` overloads on `IBetaService` (what you get from `client.Beta`), is the exception. The whole class is now marked `[Experimental("MAAIANTHROPIC001")]`, with a doc note that it "may change in non-major releases as the underlying beta services evolve". The reasoning in [issue #9110](https://github.com/microsoft/agent-framework/issues/9110) is straightforward: the Anthropic SDK is GA, but its beta surface is not, and Agent Framework does not want to promise a compatibility contract that its upstream does not.

## What changes in your code

If you build agents from the regular client, nothing changes except the package version:

```xml
<PackageReference Include="Microsoft.Agents.AI.Anthropic" Version="1.24.0" />
```

```csharp
using Anthropic;
using Microsoft.Agents.AI;

AnthropicClient client = new() { ApiKey = Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY") };

ChatClientAgent agent = client.AsAIAgent(
    model: "claude-sonnet-5-5",
    instructions: "You review C# pull requests and answer in short bullet points.",
    name: "reviewer");

Console.WriteLine(await agent.RunAsync("Is `async void` ever fine in an ASP.NET Core handler?"));
```

The beta path is where it gets subtle. I compile-checked it on SDK 10.0.302 against the 1.24.0 package. First, the overloads live in the `Anthropic.Services` namespace, so `client.Beta.AsAIAgent(...)` does not resolve until you add that `using`. Second, the attribute sits on the class, not on the methods, and C# only reports a class-level `[Experimental]` when the type name appears in your code. Extension-method syntax never names the type, so this compiles cleanly with no diagnostic:

```csharp
using Anthropic.Services;

ChatClientAgent agent = client.Beta.AsAIAgent(
    model: "claude-sonnet-5-5",
    instructions: "You create PowerPoint presentations.",
    tools: [pptxSkill.AsAITool()]);
```

Name the class directly, as in a static call or when you tune the shared default token budget, and you get an error, because `[Experimental]` diagnostics are errors by default:

```csharp
AnthropicBetaServiceExtensions.DefaultMaxTokens = 8000;
```

```text
error MAAIANTHROPIC001: 'Anthropic.Services.AnthropicBetaServiceExtensions' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.
```

The framework's own skills sample suppresses it at the top of the file with `#pragma warning disable MAAIANTHROPIC001`. If beta features are part of your design rather than an experiment, suppress it once for the project:

```xml
<PropertyGroup>
  <NoWarn>$(NoWarn);MAAIANTHROPIC001</NoWarn>
</PropertyGroup>
```

## Why the split is the right call

Pinning a preview package in production is a common reason to keep Claude agents out of Agent Framework and wire `IChatClient` by hand instead (the tradeoffs are in my [Anthropic SDK vs Microsoft.Extensions.AI comparison](/2026/06/anthropic-sdk-vs-microsoft-extensions-ai-for-calling-claude-from-dotnet/)). That excuse is gone for the stable path. Just do not treat the diagnostic as an audit. Because the extension call shape slips past it, a clean build does not mean you are off the beta surface: grep for `client.Beta` and `IBetaService` to find the call sites that can break on a minor Agent Framework or Anthropic SDK bump.

The rest of 1.24.0 is hardening: `LocalCodeAct` capability validation, rejecting sensitive identifiers in declarative agents, and binding MCP approval headers to the approved invocation. If you skipped 1.23, start with its [function middleware change](/2026/10/agent-framework-1-23-function-middleware-can-now-swap-the-tool/) before upgrading.
