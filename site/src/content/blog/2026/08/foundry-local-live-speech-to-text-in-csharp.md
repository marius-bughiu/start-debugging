---
title: "Live Speech-to-Text in C# with Foundry Local: A 0.67 GB Model and No Cloud Call"
description: "The .NET blog shipped a live microphone transcription sample on August 4, 2026 using Foundry Local and nemotron-speech-streaming-en-0.6b. Here is the session API, the PCM backpressure trap, and which NuGet package to pick."
pubDate: 2026-08-05
tags:
  - "dotnet"
  - "csharp"
  - "ai"
  - "foundry-local"
  - "speech-to-text"
---

Bruno Capuano published [Beyond Chat: live Speech-to-Text with Foundry Local and C#](https://devblogs.microsoft.com/dotnet/foundry-local-live-speech-to-text-csharp/) on the .NET blog on August 4, 2026. It is a console app that reads your microphone and prints transcription as you speak, with no network call and no per-token bill. The interesting part is not the demo, it is that streaming ASR is now a plain async stream in the Foundry Local SDK.

## The session is the whole API

Foundry Local exposes live transcription through an audio client hanging off a loaded model. There is no `IChatClient` here: this is the native SDK surface, not [Microsoft.Extensions.AI](/2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai/).

```csharp
var config = new Configuration { AppName = "transcriber" };
await FoundryLocalManager.CreateAsync(config, logger);
var mgr = FoundryLocalManager.Instance;

await mgr.DownloadAndRegisterEpsAsync();

var catalog = await mgr.GetCatalogAsync();
var model = await catalog.GetModelAsync("nemotron-speech-streaming-en-0.6b")
            ?? throw new InvalidOperationException("Model not in catalog");

await model.DownloadAsync(p => Console.Write($"\r{p:F2}%"));
await model.LoadAsync();

var audioClient = await model.GetAudioClientAsync();
var session = audioClient.CreateLiveTranscriptionSession();
session.Settings.SampleRate = 16000;
session.Settings.Channels = 1;
session.Settings.Language = "en";

await session.StartAsync();
```

You then push raw 16-bit mono PCM at 16 kHz with `session.AppendAsync(chunk)` and read results off `session.GetStream()`:

```csharp
await foreach (var result in session.GetStream())
{
    var text = result.Content?[0]?.Text;
    if (result.IsFinal)
        Console.WriteLine($"\n[FINAL] {text}");
    else if (!string.IsNullOrEmpty(text))
        Console.Write(text);
}
```

`IsFinal` is a transcript-state marker, not a stream terminator. Treat it as "this span will not be revised again" and keep reading.

## The trap: NAudio's callback is synchronous

Microphone capture uses `NAudio.WaveInEvent`, and its `DataAvailable` event handler is synchronous while `AppendAsync` is not. Firing `AppendAsync` from the handler gives you unbounded fire-and-forget calls that ignore SDK backpressure. The sample routes audio through a bounded channel instead:

```csharp
var audioChannel = Channel.CreateBounded<byte[]>(
    new BoundedChannelOptions(50) { FullMode = BoundedChannelFullMode.DropOldest });

var appendTask = Task.Run(async () =>
{
    await foreach (var chunk in audioChannel.Reader.ReadAllAsync())
        await session.AppendAsync(chunk);
});

waveIn.DataAvailable += (s, e) =>
{
    var buffer = new byte[e.BytesRecorded];
    Buffer.BlockCopy(e.Buffer, 0, buffer, 0, e.BytesRecorded);
    audioChannel.Writer.TryWrite(buffer);
};
```

Dropping the oldest 100 ms chunk under pressure is the right call for live captioning. Blocking the audio callback is not.

## Which package, which model

On Windows, install `Microsoft.AI.Foundry.Local.WinML`, which routes through the Windows ML runtime for broader hardware acceleration. Everywhere else, `Microsoft.AI.Foundry.Local`. Same API surface either way. Add `NAudio` for capture, and note that `WaveInEvent` is Windows-only, so the sample falls back to synthetic PCM elsewhere. The docs list .NET 9.0 SDK or later as the floor; the blog sample targets .NET 10.

The English model `nemotron-speech-streaming-en-0.6b` was quantized from 2.47 GB down to 0.67 GB and runs faster than real time on CPU. If you need more than English, swap the alias for `nvidia-nemotron-3.5-asr-streaming-multilingual-0.6b` and set `session.Settings.Language = "auto"`.

Finish with `session.StopAsync()` and `model.UnloadAsync()`, and use `model.RemoveFromCacheAsync()` when you want the disk back. Full walkthrough in the [Microsoft Learn how-to](https://learn.microsoft.com/en-us/azure/foundry-local/how-to/how-to-live-transcribe-audio).
