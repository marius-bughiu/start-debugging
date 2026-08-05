---
title: "Voz para texto ao vivo em C# com Foundry Local: um modelo de 0,67 GB e nenhuma chamada à nuvem"
description: "O blog do .NET publicou um exemplo de transcrição ao vivo do microfone em 2026-08-04 usando Foundry Local e nemotron-speech-streaming-en-0.6b. Aqui está a API de sessão, a armadilha de contrapressão com PCM e qual pacote NuGet escolher."
pubDate: 2026-08-05
tags:
  - "dotnet"
  - "csharp"
  - "ai"
  - "foundry-local"
  - "speech-to-text"
lang: "pt-br"
translationOf: "2026/08/foundry-local-live-speech-to-text-in-csharp"
translatedBy: "claude"
translationDate: 2026-08-05
---

Bruno Capuano publicou [Beyond Chat: live Speech-to-Text with Foundry Local and C#](https://devblogs.microsoft.com/dotnet/foundry-local-live-speech-to-text-csharp/) no blog do .NET em 2026-08-04. É um aplicativo de console que lê o seu microfone e imprime a transcrição enquanto você fala, sem nenhuma chamada de rede e sem cobrança por token. O ponto interessante não é a demonstração, e sim que o reconhecimento de fala em streaming agora é um simples stream assíncrono no SDK do Foundry Local.

## A sessão é a API inteira

O Foundry Local expõe a transcrição ao vivo através de um cliente de áudio pendurado em um modelo carregado. Não existe `IChatClient` aqui: esta é a superfície nativa do SDK, não o [Microsoft.Extensions.AI](/2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai/).

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

Depois você envia PCM bruto de 16 bits em mono a 16 kHz com `session.AppendAsync(chunk)` e lê os resultados de `session.GetStream()`:

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

`IsFinal` é um marcador de estado da transcrição, não um encerrador do stream. Trate como "este trecho não será mais revisado" e continue lendo.

## A armadilha: o callback do NAudio é síncrono

A captura do microfone usa `NAudio.WaveInEvent`, e o handler do evento `DataAvailable` é síncrono enquanto `AppendAsync` não é. Disparar `AppendAsync` de dentro do handler gera chamadas ilimitadas do tipo dispare e esqueça, que ignoram a contrapressão do SDK. O exemplo direciona o áudio por um canal limitado:

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

Descartar o trecho mais antigo de 100 ms sob pressão é a escolha certa para legendagem ao vivo. Bloquear o callback de áudio não é.

## Qual pacote, qual modelo

No Windows, instale `Microsoft.AI.Foundry.Local.WinML`, que passa pelo runtime do Windows ML para uma aceleração de hardware mais ampla. Nas demais plataformas, `Microsoft.AI.Foundry.Local`. A superfície da API é a mesma nos dois casos. Adicione `NAudio` para a captura e observe que `WaveInEvent` funciona apenas no Windows, então o exemplo cai para PCM sintético em outros sistemas. A documentação lista o SDK do .NET 9.0 ou posterior como piso; o exemplo do blog tem como alvo o .NET 10.

O modelo em inglês `nemotron-speech-streaming-en-0.6b` foi quantizado de 2,47 GB para 0,67 GB e roda mais rápido que tempo real na CPU. Se você precisa de mais do que inglês, troque o alias por `nvidia-nemotron-3.5-asr-streaming-multilingual-0.6b` e defina `session.Settings.Language = "auto"`.

Encerre com `session.StopAsync()` e `model.UnloadAsync()`, e use `model.RemoveFromCacheAsync()` quando quiser o espaço em disco de volta. O passo a passo completo está no [guia do Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry-local/how-to/how-to-live-transcribe-audio).
