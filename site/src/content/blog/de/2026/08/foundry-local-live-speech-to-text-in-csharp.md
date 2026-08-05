---
title: "Live-Spracherkennung in C# mit Foundry Local: ein 0,67-GB-Modell und kein Cloud-Aufruf"
description: "Der .NET-Blog hat am 2026-08-04 ein Beispiel für Live-Transkription vom Mikrofon veröffentlicht, mit Foundry Local und nemotron-speech-streaming-en-0.6b. Hier sind die Session-API, die PCM-Backpressure-Falle und die Frage, welches NuGet-Paket passt."
pubDate: 2026-08-05
tags:
  - "dotnet"
  - "csharp"
  - "ai"
  - "foundry-local"
  - "speech-to-text"
lang: "de"
translationOf: "2026/08/foundry-local-live-speech-to-text-in-csharp"
translatedBy: "claude"
translationDate: 2026-08-05
---

Bruno Capuano hat am 2026-08-04 im .NET-Blog [Beyond Chat: live Speech-to-Text with Foundry Local and C#](https://devblogs.microsoft.com/dotnet/foundry-local-live-speech-to-text-csharp/) veröffentlicht. Es ist eine Konsolenanwendung, die das Mikrofon liest und die Transkription ausgibt, während Sie sprechen, ohne Netzwerkaufruf und ohne Abrechnung pro Token. Interessant ist nicht die Demo, sondern dass Streaming-Spracherkennung im Foundry Local SDK jetzt ein gewöhnlicher asynchroner Stream ist.

## Die Session ist die gesamte API

Foundry Local stellt die Live-Transkription über einen Audio-Client bereit, der an einem geladenen Modell hängt. Ein `IChatClient` kommt hier nicht vor: Das ist die native SDK-Oberfläche, nicht [Microsoft.Extensions.AI](/2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai/).

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

Danach schieben Sie rohes 16-Bit-Mono-PCM mit 16 kHz über `session.AppendAsync(chunk)` hinein und lesen die Ergebnisse aus `session.GetStream()`:

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

`IsFinal` ist eine Zustandsmarkierung des Transkripts, kein Stream-Ende. Verstehen Sie es als "dieser Abschnitt wird nicht mehr überarbeitet" und lesen Sie weiter.

## Die Falle: Der Callback von NAudio ist synchron

Die Mikrofonaufnahme nutzt `NAudio.WaveInEvent`, und dessen Handler für das Ereignis `DataAvailable` ist synchron, `AppendAsync` dagegen nicht. Ein `AppendAsync` direkt aus dem Handler heraus erzeugt unbegrenzte Fire-and-Forget-Aufrufe, die die Backpressure des SDK ignorieren. Das Beispiel leitet das Audio stattdessen über einen begrenzten Channel:

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

Unter Last den ältesten 100-ms-Chunk zu verwerfen, ist für Live-Untertitel die richtige Entscheidung. Den Audio-Callback zu blockieren, ist es nicht.

## Welches Paket, welches Modell

Unter Windows installieren Sie `Microsoft.AI.Foundry.Local.WinML`, das über die Windows-ML-Laufzeit läuft und damit breitere Hardwarebeschleunigung bietet. Überall sonst `Microsoft.AI.Foundry.Local`. Die API-Oberfläche ist in beiden Fällen identisch. Für die Aufnahme kommt `NAudio` dazu, wobei `WaveInEvent` nur unter Windows funktioniert, sodass das Beispiel anderswo auf synthetisches PCM zurückfällt. Die Dokumentation nennt das .NET 9.0 SDK oder neuer als Untergrenze; das Beispiel aus dem Blog zielt auf .NET 10.

Das englische Modell `nemotron-speech-streaming-en-0.6b` wurde von 2,47 GB auf 0,67 GB quantisiert und läuft auf der CPU schneller als in Echtzeit. Wenn Sie mehr als Englisch brauchen, tauschen Sie den Alias gegen `nvidia-nemotron-3.5-asr-streaming-multilingual-0.6b` und setzen `session.Settings.Language = "auto"`.

Zum Schluss `session.StopAsync()` und `model.UnloadAsync()` aufrufen, und `model.RemoveFromCacheAsync()` verwenden, wenn Sie den Speicherplatz zurückhaben wollen. Die vollständige Anleitung steht im [Microsoft-Learn-Artikel](https://learn.microsoft.com/en-us/azure/foundry-local/how-to/how-to-live-transcribe-audio).
