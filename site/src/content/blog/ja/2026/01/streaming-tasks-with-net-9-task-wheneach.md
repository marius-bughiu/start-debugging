---
title: ".NET 9 の Task.WhenEach でタスクをストリーミングする"
description: ".NET 9 は Task.WhenEach を導入し、完了したタスクの IAsyncEnumerable を返します。並列の結果を到着順に処理するのをどう単純化するかを紹介します。"
pubDate: 2026-01-04
tags:
  - "dotnet"
  - "dotnet-9"
lang: "ja"
translationOf: "2026/01/streaming-tasks-with-net-9-task-wheneach"
translatedBy: "claude"
translationDate: 2026-04-30
---
複数の並列タスクの扱いは、.NET ではいつもややバイナリでした。すべてが終わるのを待つ (`Task.WhenAll`) か、最初の 1 つを待つ (`Task.WhenAny`) かのどちらかです。

しかし、結果を _到着順に_ 処理したい場合はどうしますか?

.NET 9 以前は、`Task.WhenAny` を含む複雑なループを書き、リストから完了したタスクを取り除き、再度ループする必要がありました。これは冗長なだけでなく、O(N^2) のパフォーマンス特性を持っていました。

## `Task.WhenEach` の登場

.NET 9 では、`Task.WhenEach` がこれをネイティブに解決します。完了したタスクを yield する `IAsyncEnumerable` を返します。

```cs
using System.Threading.Tasks;

public async Task ProcessImagesAsync(List<string> urls)
{
    // Start all downloads in parallel
    List<Task<byte[]>> downloadTasks = urls.Select(DownloadAsync).ToList();

    // Process them one by one, as soon as they finish
    await foreach (var completedTask in Task.WhenEach(downloadTasks))
    {
        try 
        {
            byte[] image = await completedTask;
            Console.WriteLine($"Processed image: {image.Length} bytes");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"One download failed: {ex.Message}");
        }
    }
}
```

## なぜこれが重要か

1.  **ユーザー体験**: UI アプリ (MAUI、WPF) では、バッチ全体が終わるまでスピナーを表示する代わりに、項目を段階的にレンダリングできます。
2.  **スループット**: バックエンドサービスでは、最初の結果をすぐに処理し始め、より遅い I/O 操作の完了を待つ間 CPU を働かせ続けることができます。
3.  **シンプルさ**: コードは線形で読みやすいです。もう `while` ループやリストのミューテーションは不要です。

これは私たちのプロジェクトから多くの「ユーティリティ」コードを削除する、ああいう小さな API 追加の 1 つです。
