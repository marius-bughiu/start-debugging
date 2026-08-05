---
title: "Распознавание речи в реальном времени на C# с Foundry Local: модель на 0.67 ГБ и ни одного обращения к облаку"
description: "2026-08-04 в блоге .NET появился пример живой транскрипции с микрофона на Foundry Local и модели nemotron-speech-streaming-en-0.6b. Разбираем API сессии, ловушку с обратным давлением при передаче PCM и выбор пакета NuGet."
pubDate: 2026-08-05
tags:
  - "dotnet"
  - "csharp"
  - "ai"
  - "foundry-local"
  - "speech-to-text"
lang: "ru"
translationOf: "2026/08/foundry-local-live-speech-to-text-in-csharp"
translatedBy: "claude"
translationDate: 2026-08-05
---

2026-08-04 Бруно Капуано опубликовал в блоге .NET статью [Beyond Chat: live Speech-to-Text with Foundry Local and C#](https://devblogs.microsoft.com/dotnet/foundry-local-live-speech-to-text-csharp/). Это консольное приложение, которое читает микрофон и печатает транскрипцию по мере того, как вы говорите, без единого сетевого вызова и без оплаты за токены. Интересна здесь не сама демонстрация, а то, что потоковое распознавание речи в SDK Foundry Local стало обычным асинхронным потоком.

## Сессия и есть весь API

Foundry Local отдаёт живую транскрипцию через аудиоклиент, привязанный к загруженной модели. Никакого `IChatClient` здесь нет: это нативная поверхность SDK, а не [Microsoft.Extensions.AI](/2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai/).

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

Дальше вы передаёте сырой 16-битный моно-PCM с частотой 16 кГц через `session.AppendAsync(chunk)` и читаете результаты из `session.GetStream()`:

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

`IsFinal` это маркер состояния расшифровки, а не признак конца потока. Понимайте его как "этот фрагмент больше не будет пересматриваться" и продолжайте чтение.

## Ловушка: обратный вызов NAudio синхронный

Захват микрофона использует `NAudio.WaveInEvent`, и его обработчик события `DataAvailable` синхронный, тогда как `AppendAsync` нет. Вызов `AppendAsync` прямо из обработчика порождает неограниченные вызовы по принципу "запустил и забыл", которые игнорируют обратное давление SDK. В примере звук идёт через ограниченный канал:

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

Отбрасывать самый старый фрагмент в 100 мс под нагрузкой это правильное решение для живых субтитров. Блокировать аудиообработчик неправильное.

## Какой пакет и какая модель

В Windows ставьте `Microsoft.AI.Foundry.Local.WinML`: он работает поверх среды выполнения Windows ML и даёт более широкое аппаратное ускорение. На остальных платформах `Microsoft.AI.Foundry.Local`. Поверхность API в обоих случаях одинакова. Для захвата добавьте `NAudio`, но учтите, что `WaveInEvent` работает только в Windows, поэтому на других системах пример переключается на синтетический PCM. Документация указывает минимальной планкой .NET 9.0 SDK или новее; пример из блога нацелен на .NET 10.

Английская модель `nemotron-speech-streaming-en-0.6b` квантована с 2.47 ГБ до 0.67 ГБ и работает на CPU быстрее реального времени. Если английского мало, замените псевдоним на `nvidia-nemotron-3.5-asr-streaming-multilingual-0.6b` и задайте `session.Settings.Language = "auto"`.

Завершайте вызовами `session.StopAsync()` и `model.UnloadAsync()`, а когда захотите вернуть место на диске, используйте `model.RemoveFromCacheAsync()`. Полное пошаговое руководство есть в [статье Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry-local/how-to/how-to-live-transcribe-audio).
