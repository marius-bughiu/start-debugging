---
title: "Agent Framework 1.21: LocalCodeAct Stops Handing Your Host Environment to Model-Written Python"
description: "Microsoft Agent Framework .NET 1.21.0 ships Microsoft.Agents.AI.LocalCodeAct 1.21.0-preview.260911.1, which no longer lets the CodeAct Python subprocess inherit the parent environment when Environment is null. On 1.20, generated code could read every host variable, API keys included."
pubDate: 2026-09-13
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "codeact"
  - "security"
---

Microsoft Agent Framework [dotnet-1.21.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.21.0) shipped on September 11, 2026, and one line in its changelog deserves more attention than it will get: "[BREAKING] .NET: Isolate LocalCodeAct subprocess environment" ([PR #8159](https://github.com/microsoft/agent-framework/pull/8159)). If you run `Microsoft.Agents.AI.LocalCodeAct` and never set `LocalCodeActProviderOptions.Environment`, the Python your model writes could read every environment variable of your host process until this release.

## Two docs, one behavior

`LocalCodeAct` is the unsandboxed sibling of the Hyperlight CodeAct provider: the model writes Python, and the package runs it in a child `python` process on the host after an AST validation pass. The package README already promised that the subprocess "does NOT inherit the host environment by default". The XML doc on `Environment` said the opposite: `null` means inherit, pass an empty dictionary for a scrubbed environment. The code followed the XML doc. `ProcessBridge.ConfigureEnvironment` returned early when the dictionary was `null`, so `ProcessStartInfo` kept the full parent environment.

That matters because the validator deliberately allows read-only access to `os.environ`. So this passed validation on 1.20:

```csharp
Environment.SetEnvironmentVariable("FAKE_OPENAI_API_KEY", "sk-leaked-from-host");

var fn = new LocalExecuteCodeFunction("/opt/homebrew/bin/python3.14");
var result = await fn.InvokeAsync(new AIFunctionArguments
{
    ["code"] = "import os\nprint(os.environ.get('FAKE_OPENAI_API_KEY', 'NOT_FOUND'))\nprint(len(os.environ))",
});
```

I ran that exact probe as a .NET 10 file-based app (SDK 10.0.302, macOS, Python 3.14) against both package versions:

```text
1.20.0-preview.260831.1  default options   -> sk-leaked-from-host, 63 variables
1.21.0-preview.260911.1  default options   -> NOT_FOUND, 2 variables
both versions            Environment set   -> NOT_FOUND, 3 variables
```

Whatever `execute_code` prints goes straight back into the model's context. A prompt-injected instruction to "print the environment" was enough to put your OpenAI key, a storage connection string, or `AZURE_CLIENT_SECRET` into the transcript, and from there into any host tool the agent can call.

## What 1.21 does now

`ConfigureEnvironment` now always calls `startInfo.Environment.Clear()` and then copies only what you put in `Environment`. `null` and an empty dictionary behave the same. On Windows, `SYSTEMROOT`, `SYSTEMDRIVE`, `COMSPEC`, `PATHEXT`, `TEMP` and `TMP` are back-filled from the parent if you did not set them, because Python cannot load its standard library without them.

The flip side is that anything your generated code relied on implicitly is gone, including `PATH` and `HOME` on Linux and macOS. If a mounted script or an allowed module needs a variable, pass it explicitly:

```csharp
using Microsoft.Agents.AI.LocalCodeAct;

using var provider = new LocalCodeActProvider("/usr/bin/python3", new LocalCodeActProviderOptions
{
    Environment = new Dictionary<string, string>
    {
        ["LOG_LEVEL"] = "INFO",
        ["TZ"] = "UTC",
    },
});
```

Keep secrets out of that dictionary. If generated code needs an authenticated call, register a host tool that holds the credential and let the Python reach it through `await call_tool(...)`.

## Two related LocalCodeAct changes in the same release

[PR #8239](https://github.com/microsoft/agent-framework/pull/8239) tightens the validator so OS-derived aliases, reflective access, and environment mutation are rejected consistently, and [PR #8289](https://github.com/microsoft/agent-framework/pull/8289) aligns approvals with Hyperlight: if any registered tool is an `ApprovalRequiredAIFunction`, `execute_code` itself requires approval, and `LocalCodeActApprovalMode.AlwaysRequire` forces it for every run.

None of this turns `LocalCodeAct` into a sandbox, and the README still says so in a warning box. It belongs inside a container, VM, or Foundry hosted agent. If you are still deciding whether model-written code is worth that setup at all, I compared the trade-offs in [CodeAct vs a traditional tool-calling loop](/2026/07/codeact-vs-tool-calling-loop-for-agents/). If you already run it, update to `1.21.0-preview.260911.1` and audit what you pass in `Environment`.
