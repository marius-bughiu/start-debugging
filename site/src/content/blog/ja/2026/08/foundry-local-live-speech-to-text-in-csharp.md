---
title: "Foundry Local と C# によるリアルタイム音声認識: 0.67 GB のモデルでクラウド呼び出しはゼロ"
description: "2026-08-04 に .NET ブログが Foundry Local と nemotron-speech-streaming-en-0.6b を使ったマイクのリアルタイム文字起こしサンプルを公開しました。セッション API、PCM のバックプレッシャーの落とし穴、選ぶべき NuGet パッケージを解説します。"
pubDate: 2026-08-05
tags:
  - "dotnet"
  - "csharp"
  - "ai"
  - "foundry-local"
  - "speech-to-text"
lang: "ja"
translationOf: "2026/08/foundry-local-live-speech-to-text-in-csharp"
translatedBy: "claude"
translationDate: 2026-08-05
---

2026-08-04、Bruno Capuano 氏が .NET ブログに [Beyond Chat: live Speech-to-Text with Foundry Local and C#](https://devblogs.microsoft.com/dotnet/foundry-local-live-speech-to-text-csharp/) を公開しました。マイクの音声を読み取り、話している最中に文字起こしを出力するコンソールアプリで、ネットワーク呼び出しもトークン課金もありません。注目すべきはデモそのものではなく、ストリーミング音声認識が Foundry Local SDK では普通の非同期ストリームになったという点です。

## セッションがすべての API です

Foundry Local はロード済みモデルにぶら下がるオーディオクライアント経由でリアルタイム文字起こしを公開します。ここに `IChatClient` は登場しません。これは SDK のネイティブな面であり、[Microsoft.Extensions.AI](/2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai/) ではありません。

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

あとは 16 kHz、16 ビット、モノラルの生 PCM を `session.AppendAsync(chunk)` で送り込み、結果を `session.GetStream()` から読み取ります。

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

`IsFinal` は文字起こしの状態を示すマーカーであって、ストリームの終端ではありません。「この区間はもう修正されない」という意味として扱い、読み取りは続けてください。

## 落とし穴: NAudio のコールバックは同期です

マイク入力には `NAudio.WaveInEvent` を使いますが、その `DataAvailable` イベントハンドラーは同期であるのに対し、`AppendAsync` は非同期です。ハンドラーの中から `AppendAsync` を呼ぶと、SDK のバックプレッシャーを無視した投げっぱなしの呼び出しが際限なく積み上がります。サンプルでは、音声を境界付きチャネル経由で流しています。

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

負荷が高いときに最も古い 100 ms のチャンクを捨てるのは、リアルタイム字幕では正しい判断です。オーディオのコールバックをブロックするのは正しくありません。

## どのパッケージ、どのモデルを選ぶか

Windows では `Microsoft.AI.Foundry.Local.WinML` を入れます。Windows ML ランタイムを経由するため、より広いハードウェアアクセラレーションが使えます。それ以外の環境では `Microsoft.AI.Foundry.Local` です。API の面はどちらでも同じです。入力キャプチャ用に `NAudio` を追加しますが、`WaveInEvent` は Windows 専用なので、他のプラットフォームではサンプルは合成 PCM にフォールバックします。ドキュメントは最低要件として .NET 9.0 SDK 以降を挙げており、ブログのサンプルは .NET 10 を対象にしています。

英語モデル `nemotron-speech-streaming-en-0.6b` は 2.47 GB から 0.67 GB へ量子化されており、CPU でリアルタイムより速く動作します。英語以外も必要な場合は、エイリアスを `nvidia-nemotron-3.5-asr-streaming-multilingual-0.6b` に差し替え、`session.Settings.Language = "auto"` を設定してください。

最後は `session.StopAsync()` と `model.UnloadAsync()` で締め、ディスク容量を戻したいときは `model.RemoveFromCacheAsync()` を使います。詳しい手順は [Microsoft Learn のガイド](https://learn.microsoft.com/en-us/azure/foundry-local/how-to/how-to-live-transcribe-audio)にあります。
