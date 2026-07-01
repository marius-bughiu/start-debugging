---
title: "C# で CancellationTokenSource.CancelAfter を使って非同期操作にタイムアウトを設定する方法"
description: ".NET 11 で非同期デッドラインを適用する CancellationTokenSource.CancelAfter の完全ガイド: コンストラクターと CancelAfter の違い、リンクされたトークン、例外処理、Task.WaitAsync、プール向け TryReset、TimeProvider によるテスト可能なタイムアウト。"
pubDate: 2026-07-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "ja"
translationOf: "2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-01
---

非同期操作にデッドラインを設定するには、3 つの要素が必要です: `CancellationTokenSource`、`cts.CancelAfter(TimeSpan.FromSeconds(5))` の呼び出し、そしてチェーン内のすべての非同期メソッドへの `cts.Token` の受け渡しです。デッドラインが切れると、トークンが発火し、後続の `await` が `OperationCanceledException` をスローし、それをキャッチします。この記事では、.NET 11 (`Microsoft.NET.Sdk` 11.0.0、C# 14) における完全なパターンを説明します: `CancelAfter` の代わりにコンストラクターのオーバーロードを使うべき場面、タイムアウトと外部の `CancellationToken` を組み合わせる方法、タイムアウトと呼び出し元によるキャンセルの区別、変更できないコードに対する `Task.WaitAsync`、プール向けの `TryReset`、そして `TimeProvider` を使ったテスト可能なタイムアウトです。

## 永遠にハングする操作

明示的なデッドラインのない `HttpClient` の呼び出しは、サーバーが応答するまで待ち続けます。`HttpClient.Timeout` のデフォルトは 100 秒ですが、高負荷時にはリクエストキューを枯渇させるには十分な長さです。また、`HttpClient.Timeout` は呼び出し元の `CancellationToken` と組み合わせることができず、発火時には `InnerException` が `TimeoutException` である `TaskCanceledException` をスローします -- これは協調的なキャンセルとは異なる形です。手動の `CancelAfter` パターンはデッドラインの適用と組み合わせの両方を提供します。

```csharp
// .NET 11, C# 14 -- 危険: HttpClient.Timeout のデフォルトは 100 秒
using HttpClient http = new();
string json = await http.GetStringAsync("https://slow-api.example.com/data");
```

## CancelAfter を 1 ステップで使う

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(5));

try
{
    using HttpClient http = new();
    string json = await http.GetStringAsync(
        "https://slow-api.example.com/data", cts.Token);
    Console.WriteLine(json);
}
catch (OperationCanceledException) when (cts.IsCancellationRequested)
{
    Console.WriteLine("リクエストが 5 秒後にタイムアウトしました。");
}
```

`CancelAfter` は内部に一度だけ発火するタイマーをスケジュールします。タイマーが発火すると CTS 上で `Cancel()` が呼び出され、トークンの状態が「未要求」から「要求済み」に変わります。`GetStringAsync` 内でトークンをチェックする `await` はすべて `OperationCanceledException` をスローします。`when` 句により、自分の CTS が発火した場合にのみ例外をキャッチし、フレームワークや呼び出し元が注入したキャンセルでは反応しません。

## コンストラクターのオーバーロードと CancelAfter の使い分け

```csharp
// .NET 11, C# 14 -- 固定の一度だけのデッドラインには同等:
using var cts1 = new CancellationTokenSource(TimeSpan.FromSeconds(5));

using var cts2 = new CancellationTokenSource();
cts2.CancelAfter(TimeSpan.FromSeconds(5));
```

デッドラインがオブジェクト生成時に固定で変わらない場合はコンストラクターのオーバーロードを使います。CTS を事前に作成してデッドラインを後から決める場合、または操作中にリセットする必要がある場合は `CancelAfter` を使います。例えば、成功したハートビートごとにウィンドウを更新するウォッチドッグです:

```csharp
// .NET 11, C# 14 -- パケットごとにデッドラインをリセットするウォッチドッグパターン
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(10));

await foreach (Packet packet in ReadPacketsAsync(cts.Token))
{
    Process(packet);
    cts.CancelAfter(TimeSpan.FromSeconds(10));  // 10 秒ウィンドウをリセット
}
```

各 `CancelAfter` 呼び出しは、内部で `ITimer.Change` を使って以前にスケジュールされた時間を置き換えます -- 新たなメモリ割り当てなし。新しいカウントダウンは呼び出し時点から始まります。

## タイムアウトと外部の CancellationToken を組み合わせる

ASP.NET Core では、クライアントが切断すると `HttpContext.RequestAborted` が発火します。`BackgroundService` では、シャットダウン時に `stoppingToken` が発火します。デッドラインが切れても呼び出し元がキャンセルしても操作をキャンセルすべきです。`CancellationTokenSource.CreateLinkedTokenSource` を使います:

```csharp
// .NET 11, C# 14
public async Task<string> FetchWithDeadlineAsync(
    string url,
    CancellationToken callerToken = default)
{
    using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(
        callerToken, timeoutCts.Token);

    using HttpClient http = new();
    return await http.GetStringAsync(url, linked.Token);
}
```

`linked.Token` をすべての下流の呼び出しに渡します。どちらかのソースが発火するとリンクされたトークンがキャンセルされます。`CreateLinkedTokenSource` は任意の数のトークンを受け付け、返された CTS はいずれかがキャンセルされると即座にキャンセルされます。

タイムアウト CTS とリンクされた CTS の両方を必ず `Dispose` してください。ペンディングのタイマーがある未破棄の CTS インスタンスはタイマーが発火するまでガベージコレクションされません。

## タイムアウトと呼び出し元のキャンセルを区別する

両方のパスで `OperationCanceledException` がスローされます。呼び出し元に意味のあるエラー情報を提供するために、真のタイムアウトを `TimeoutException` に変換します:

```csharp
// .NET 11, C# 14
catch (OperationCanceledException ex)
{
    if (timeoutCts.IsCancellationRequested)
        throw new TimeoutException(
            "操作が 5 秒後にタイムアウトしました。", ex);

    // 呼び出し元がキャンセルした -- 呼び出し元のトークンが
    // そのまま伝播するよう、ラップせずに再スロー
    throw;
}
```

これは、呼び出し元のコードが内部の `CancellationTokenSource` を知らない場合に重要です。`TimeoutException` をキャッチする呼び出し元は、自分が作成していないトークンを検査する必要がありません。

リンクされた CTS を使用する場合は、`timeoutCts.IsCancellationRequested` を直接チェックしてください。`ex.CancellationToken` をリンクされたトークンと比較しないでください -- `ex.CancellationToken` は最初に発火した構成トークン (呼び出し元、タイムアウト、またはリンク) を保持しており、競合状態によって異なります。

## トークンを受け付けないコードに対する Task.WaitAsync

すべての API が `CancellationToken` を受け付けるわけではありません。.NET 6 ではそのケースのために `Task.WaitAsync` が追加されました:

```csharp
// .NET 11, C# 14 -- トークンなしのレガシー API をラップ
Task<string> slowWork = LegacyApiAsync();

try
{
    string result = await slowWork.WaitAsync(TimeSpan.FromSeconds(5));
}
catch (TimeoutException)
{
    // デッドライン切れ。slowWork はバックグラウンドで実行中です。
    Console.WriteLine("5 秒後に待機を中止しました。");
}
```

`WaitAsync(TimeSpan)` は `TimeoutException` (ではなく `OperationCanceledException`) をスローし、基になる `Task` をキャンセルしません。作業は自然に完了するまで実行し続けます。`WaitAsync` は呼び出されるコードにトークンを渡せない場合にのみ使用してください。リソースの消費はいずれにせよ続きます。

デッドラインと `CancellationToken` の両方を受け付ける組み合わせオーバーロードもあります:

```csharp
// .NET 11, C# 14 -- キャンセル可能かつ時間制限あり
await slowWork.WaitAsync(TimeSpan.FromSeconds(5), callerToken);
```

このオーバーロードは、デッドラインが先に切れると `TimeoutException` を、トークンが先に発火すると `TaskCanceledException` (`OperationCanceledException` のサブクラス) をスローします。

## 既存のタイムアウトのリセットと無効化

`CancelAfter` は複数回呼び出せます。各呼び出しは以前にスケジュールされたデッドラインを置き換えます:

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(10));   // 初期デッドライン: 10 秒

// 延長: 今から 5 秒ウィンドウでタイマーを再起動
cts.CancelAfter(TimeSpan.FromSeconds(5));

// CTS をキャンセルせずにタイムアウトを完全に無効化:
cts.CancelAfter(Timeout.InfiniteTimeSpan);   // 発火しなくなる
```

`Timeout.InfiniteTimeSpan` は `-1` ミリ秒に相当し、CTS をキャンセル状態にせずに内部タイマーを無効化します。

CTS がキャンセルされた後は、`CancelAfter` を呼び出しても効果がありません。キャンセルがすでに発生している可能性がある場合は、最初に `IsCancellationRequested` を確認してください。

## プール向けの TryReset

短い操作を多数実行する高スループットなコードでは、リクエストごとに新しい `CancellationTokenSource` を作成するとメモリ割り当てが発生します。.NET 6 では再利用のために `TryReset` が追加されました:

```csharp
// .NET 11, C# 14 -- プールされた CTS パターン
private CancellationTokenSource _cts = new();

public async Task ProcessRequestAsync()
{
    if (!_cts.TryReset())
        _cts = new CancellationTokenSource();

    _cts.CancelAfter(TimeSpan.FromSeconds(5));

    await DoWorkAsync(_cts.Token);
}
```

`TryReset` は CTS がキャンセルされておらず安全に再利用できる場合に `true` を返し、キャンセル済みで新しいインスタンスが必要な場合は `false` を返します。同時キャンセル要求に対してはスレッドセーフではありません -- 前の操作が完了した後、単一のオーナーからのみ呼び出してください。ASP.NET Core は Kestrel 内部でこのパターンを使用しています。

## TimeProvider によるテスト可能なタイムアウト

ユニットテストで実際の 5 秒を待つのは遅くて不安定です。.NET 8 で導入され .NET 11 で安定した `TimeProvider` により、内部タイマーが注入可能になります:

```csharp
// .NET 11, C# 14
public async Task<string> FetchAsync(
    string url,
    TimeProvider? clock = null)
{
    clock ??= TimeProvider.System;
    using var cts = clock.CreateCancellationTokenSource(TimeSpan.FromSeconds(5));

    using HttpClient http = new();
    return await http.GetStringAsync(url, cts.Token);
}
```

テストでは、NuGet パッケージ `Microsoft.Extensions.TimeProvider.Testing` の `FakeTimeProvider` を注入します:

```csharp
// xUnit, .NET 11, C# 14
[Fact]
public async Task FetchAsync_ThrowsOnTimeout()
{
    var clock = new FakeTimeProvider();
    Task<string> fetch = FetchAsync("https://slow.example.com", clock);

    clock.Advance(TimeSpan.FromSeconds(10));  // 10 秒を瞬時に進める

    await Assert.ThrowsAsync<OperationCanceledException>(() => fetch);
}
```

クロックを進めると同期的にキャンセルが発火します。`Task.Delay` なし。不安定なテストのタイミングなし。

## CTS を破棄する

`CancellationTokenSource` は `IAsyncDisposable` ではなく `IDisposable` を実装しています。`DisposeAsync` はありません。`CancelAfter` を呼び出すと、スレッドプールのタイマーキューにタイマーが登録されます。このタイマーは CTS への参照を保持し、発火するまでガベージコレクションを妨げます。

常に破棄してください:

```csharp
// 正しい: 例外がスローされても保証されたクリーンアップ
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
await DoWorkAsync(cts.Token);
// cts.Dispose() がここで呼び出される; タイマーがキャンセルされ解放される
```

破棄するとペンディングのタイマーがキャンセルされ、待機ハンドルが解放され、CTS が属する `CreateLinkedTokenSource` チェーンから削除されます。数千の同時リクエストを処理するサーバーでは、CTS インスタンスのリークがタイマーの蓄積を引き起こします。

## よくある落とし穴

**HttpClient.Timeout があなたのトークンと競合します。** `HttpClient.Timeout` のデフォルトは 100 秒です。`CancelAfter` でトークンも渡す場合、2 つのタイマーが動いています。`HttpClient.Timeout` が発火すると `ex.InnerException is TimeoutException` の `TaskCanceledException` がスローされ、あなたのトークンが発火すると `ex.CancellationToken == cts.Token` の `OperationCanceledException` がスローされます。どちらかを無効化してください: `HttpClient.Timeout` を `Timeout.InfiniteTimeSpan` に設定してデッドラインを自分で管理するか、`HttpClient.Timeout` に任せて手動 CTS を省略します。完全な解説は [Fix: HttpClient の TaskCanceledException](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) を参照してください。

**Cancel の後の CancelAfter は無効です。** CTS がキャンセル状態になった後、`CancelAfter` を呼び出しても効果がありません。キャンセルは一方向の遷移です。

**UI スレッドへのマーシャリング。** WinForms、WPF、または MAUI では、キャンセルされた `await` の後の継続は、完了を拾ったスレッドプールのスレッドで実行されます -- UI スレッドではありません。catch ブロックで UI 要素を更新する場合は、明示的に適切なスレッドに戻してください。ASP.NET Core では `SynchronizationContext` がインストールされていないため、[ConfigureAwait(false) は効果がありません](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/)。

**意図せずトークンを並列ブランチ間で共有しないでください。** `Task.WhenAll` で作業をファンアウトし、すべてのブランチに同じ `cts.Token` を渡す場合、最初のキャンセルがすべてをキャンセルします。これは共有デッドラインに対して通常望ましい動作ですが、意図的に行ってください。

## 関連記事

- すべての非同期レイヤーに単一の `CancellationToken` を受け渡す: [.NET 11 で非同期メソッドを通じて CancellationToken を伝播する方法](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- デッドラインなしの手動キャンセル: [C# でデッドロックなしに長時間実行タスクをキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- HttpClient が TaskCanceledException をスローする 3 つの理由: [Fix: HttpClient の TaskCanceledException](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- ライブラリコードでの ConfigureAwait(false): [.NET 11 での ConfigureAwait(false) とデフォルトの比較](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- async void vs async Task -- 例外を伝播できるのはどちら: [C# での async void vs async Task: それぞれが正しい場面](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)

## ソースリンク

- [CancellationTokenSource.CancelAfter -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.cancelafter)
- [CancellationTokenSource.TryReset -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.tryreset)
- [Task.WaitAsync -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync)
- [TimeProvider.CreateCancellationTokenSource -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider.createcancellationtokensource)
- [Microsoft.Extensions.TimeProvider.Testing (NuGet)](https://www.nuget.org/packages/Microsoft.Extensions.TimeProvider.Testing)
