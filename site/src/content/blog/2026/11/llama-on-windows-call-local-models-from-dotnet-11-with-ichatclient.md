---
title: "Llama on Windows: call local models from .NET 11 through IChatClient on localhost:9931"
description: "Hugging Face and the llama.cpp team shipped Llama, a Windows 11 tray app that downloads GGUF models and serves them over an OpenAI-compatible API on localhost:9931. Here is how a .NET 11 file-based app talks to it with Microsoft.Extensions.AI 11.0.0, tools included."
pubDate: 2026-11-24
tags:
  - "dotnet-11"
  - "ai"
  - "microsoft-extensions-ai"
  - "local-models"
---

On November 23, 2026 the .NET team published [Run local models in your .NET apps with Llama on Windows](https://devblogs.microsoft.com/dotnet/local-models-dotnet-llama-windows/), the written follow-up to the Llama announcement in the .NET Conf 2026 keynote. Llama is a Windows 11 tray app built by the Hugging Face and llama.cpp teams. It is written in .NET 10 and WinUI 3, it is open source ([ggml-org/Llama-Windows](https://github.com/ggml-org/Llama-Windows)), and it manages a llama.cpp server for you. For .NET developers the interesting part is not the tray UI, it is the endpoint it leaves running.

## What Llama actually runs

From the tray you browse a hardware-filtered model catalog or search the Hugging Face Hub, download a quantized GGUF build (the walkthrough uses Gemma 4 E4B, `Q4_0`), and chat in the browser or through an `Alt+Space` overlay. Models land in the standard Hugging Face cache, so the `llama` CLI and other tools see the same files.

Behind that, Llama exposes a llama.cpp server at `http://localhost:9931` with OpenAI-shaped endpoints: `/v1/chat/completions`, `/v1/models`, plus embeddings and structured output per the [Llama API docs](https://llama.app/docs/api). Models load on the first request and unload after five idle minutes (configurable), so a client never has to manage memory. No API key is required.

Install it from the Microsoft Store:

```bash
winget install 9PPPSM6Q21Q6 --source msstore
```

## Pointing IChatClient at localhost

Because the server speaks the OpenAI wire format, the existing `Microsoft.Extensions.AI.OpenAI` adapter works unchanged. You only swap the endpoint. The official sample is a .NET 11 file-based app, so there is no `.csproj`:

```csharp
#!/usr/bin/env dotnet
#:package Microsoft.Extensions.AI@11.0.0
#:package Microsoft.Extensions.AI.OpenAI@11.0.0

using System.ClientModel;
using System.ComponentModel;
using Microsoft.Extensions.AI;
using OpenAI;

var endpoint = Environment.GetEnvironmentVariable("LLAMA_ENDPOINT")
    ?? "http://localhost:9931/v1";
var model = args.Length > 0 ? args[0] : "ggml-org/gemma-4-E4B-it-GGUF:Q4_0";

// The OpenAI client insists on a key, Llama ignores it.
IChatClient client = new OpenAIClient(
        new ApiKeyCredential("no-key-required"),
        new OpenAIClientOptions { Endpoint = new Uri(endpoint) })
    .GetChatClient(model)
    .AsIChatClient()
    .AsBuilder()
    .UseFunctionInvocation()
    .Build();

var options = new ChatOptions
{
    Tools = [AIFunctionFactory.Create(GetMachineName)]
};

await foreach (var update in client.GetStreamingResponseAsync(
    "Which machine am I on? Use your tool.", options))
{
    Console.Write(update.Text);
}

[Description("Gets the name of the computer the user is chatting from.")]
static string GetMachineName() => Environment.MachineName;
```

Run it with `dotnet run llama-chat.cs`, or pass a model ID copied from the tray: `dotnet run llama-chat.cs -- ggml-org/gemma-4-E4B-it-GGUF:Q4_0`. The full sample in [luisquintanilla/llama-windows-dotnet](https://github.com/luisquintanilla/llama-windows-dotnet) also calls `GET /v1/models` first, which doubles as a "is Llama running?" probe, and reads the extra `status` field Llama adds to each model entry to report whether it is loaded.

This snippet was not executed for this post; it is adapted from the Microsoft sample, which was written against Windows 11 and SDK 11.

## Where it breaks

Tool calling depends on the model, not on the client. `UseFunctionInvocation()` will happily advertise tools, but a small quantized model may ignore them. The blog post's advice is to move to a larger model or one whose Hugging Face card lists tool support. Expect the first response to be slow too, since that request triggers the model load.

It is also Windows 11 only. On macOS or Linux, the same `IChatClient` code works against any OpenAI-compatible local server (plain `llama-server`, Ollama, Foundry Local), you just change `LLAMA_ENDPOINT`.

## Why the abstraction matters here

The payoff is that the chat loop depends only on `IChatClient`. A local Llama endpoint can be the cheap first hop and a cloud model the fallback, using the routing and failover clients covered in [Microsoft.Extensions.AI 10.9 Ships Routing and Failover Chat Clients](/2026/08/microsoft-extensions-ai-10-9-routing-and-failover-chat-clients/). Swapping providers is a constructor change, not a rewrite, and with Llama the local side of that pair is now a Store install instead of a hand-maintained llama.cpp build.
