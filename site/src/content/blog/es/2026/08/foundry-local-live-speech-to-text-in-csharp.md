---
title: "Voz a texto en vivo en C# con Foundry Local: un modelo de 0.67 GB y ninguna llamada a la nube"
description: "El blog de .NET publicó un ejemplo de transcripción en vivo desde el micrófono el 2026-08-04 usando Foundry Local y nemotron-speech-streaming-en-0.6b. Aquí está la API de sesión, la trampa de contrapresión con PCM y qué paquete NuGet elegir."
pubDate: 2026-08-05
tags:
  - "dotnet"
  - "csharp"
  - "ai"
  - "foundry-local"
  - "speech-to-text"
lang: "es"
translationOf: "2026/08/foundry-local-live-speech-to-text-in-csharp"
translatedBy: "claude"
translationDate: 2026-08-05
---

Bruno Capuano publicó [Beyond Chat: live Speech-to-Text with Foundry Local and C#](https://devblogs.microsoft.com/dotnet/foundry-local-live-speech-to-text-csharp/) en el blog de .NET el 2026-08-04. Es una aplicación de consola que lee tu micrófono e imprime la transcripción mientras hablas, sin ninguna llamada de red y sin factura por token. Lo interesante no es la demo, sino que el reconocimiento de voz en streaming ahora es un simple stream asíncrono dentro del SDK de Foundry Local.

## La sesión es toda la API

Foundry Local expone la transcripción en vivo a través de un cliente de audio que cuelga de un modelo cargado. Aquí no hay `IChatClient`: esta es la superficie nativa del SDK, no [Microsoft.Extensions.AI](/2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai/).

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

Luego envías PCM crudo de 16 bits en mono a 16 kHz con `session.AppendAsync(chunk)` y lees los resultados desde `session.GetStream()`:

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

`IsFinal` es un marcador de estado de la transcripción, no un terminador del stream. Interprétalo como "este fragmento ya no se va a revisar" y sigue leyendo.

## La trampa: el callback de NAudio es síncrono

La captura del micrófono usa `NAudio.WaveInEvent`, y su manejador del evento `DataAvailable` es síncrono mientras que `AppendAsync` no lo es. Disparar `AppendAsync` desde el manejador te deja llamadas sin límite del tipo dispara y olvida que ignoran la contrapresión del SDK. El ejemplo enruta el audio por un canal acotado:

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

Descartar el fragmento más antiguo de 100 ms bajo presión es la decisión correcta para subtitulado en vivo. Bloquear el callback de audio no lo es.

## Qué paquete y qué modelo

En Windows, instala `Microsoft.AI.Foundry.Local.WinML`, que pasa por el runtime de Windows ML para una aceleración por hardware más amplia. En el resto de plataformas, `Microsoft.AI.Foundry.Local`. La superficie de la API es la misma en ambos casos. Agrega `NAudio` para la captura, y ten en cuenta que `WaveInEvent` solo funciona en Windows, así que el ejemplo recurre a PCM sintético en otras plataformas. La documentación indica el SDK de .NET 9.0 o posterior como mínimo; el ejemplo del blog apunta a .NET 10.

El modelo en inglés `nemotron-speech-streaming-en-0.6b` fue cuantizado de 2.47 GB a 0.67 GB y corre más rápido que en tiempo real sobre CPU. Si necesitas más que inglés, cambia el alias por `nvidia-nemotron-3.5-asr-streaming-multilingual-0.6b` y define `session.Settings.Language = "auto"`.

Termina con `session.StopAsync()` y `model.UnloadAsync()`, y usa `model.RemoveFromCacheAsync()` cuando quieras recuperar el espacio en disco. El recorrido completo está en la [guía de Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry-local/how-to/how-to-live-transcribe-audio).
