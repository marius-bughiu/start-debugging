---
title: "Polly 8.8.1: サーキットブレーカーが最初の呼び出し元の AsyncLocal 値を保持し続けなくなりました"
description: "Polly.Core 8.8.1 はサーキットブレーカーのバックグラウンドループを ExecutionContext.SuppressFlow の下で開始するため、長寿命のパイプラインがそれを構築した側の AsyncLocal 値を保持しなくなりました。15 行の再現コードで 8.8.0 のリークと 8.8.1 の修正を示します。"
pubDate: 2026-10-27
tags:
  - "polly"
  - "resilience"
  - "dotnet"
  - "csharp"
  - "memory-leaks"
lang: "ja"
translationOf: "2026/10/polly-8-8-1-circuit-breaker-no-longer-keeps-the-first-callers-asynclocal-values-alive"
translatedBy: "claude"
translationDate: 2026-10-27
---

[Polly 8.8.1](https://github.com/App-vNext/Polly/releases/tag/8.8.1) が 2026-10-26 にリリースされました。目玉の修正は、気づかないうちに抱えやすいメモリリークです。Polly.Core 8.8.0 以前で構築されたサーキットブレーカー戦略はすべて、それを構築したコードの `ExecutionContext` をパイプラインの存続期間中ずっと保持していました。その時点で設定されていたすべての `AsyncLocal<T>` 値も含まれます。

## サーキットブレーカーがコンテキストを捕捉していた理由

サーキットブレーカーは、状態変化のコールバック (`OnOpened`、`OnClosed`、`OnHalfOpened`) をホットパスの外で実行するために、内部の `ScheduledTaskExecutor` を使います。そのコンストラクターは `Task.Run(StartProcessingAsync)` で処理ループを開始していました。`Task.Run` は既定で現在の `ExecutionContext` を引き継ぎ、ループはパイプラインが破棄されるまで `SemaphoreSlim` で待機します。

つまり、たまたま構築を引き起こした側が、自分のアンビエントな状態を決して終わらないタスクに渡していたことになります。`ResiliencePipelineRegistry` 内のパイプラインや、`Microsoft.Extensions.Http.Resilience` が名前付き `HttpClient` 向けに構築するパイプラインでは、「パイプラインの存続期間」はアプリの存続期間を意味します。[Issue #3275](https://github.com/App-vNext/Polly/issues/3275) は最悪のケースを説明しています。Blazor Server アプリで最初のユーザーの circuit がパイプラインを構築し、`AsyncLocal` ベースのアクセサーがその circuit のサービスを保持するため、ユーザーが離れた後も circuit が回収されません。

## ファイルベースのアプリで再現する

これは .NET 10 SDK 上で `dotnet run repro.cs` によりそのまま実行できます。パッケージのバージョンを変えて比較してください。

```csharp
#:package Polly.Core@8.8.0
using System.Runtime.CompilerServices;
using Polly;

AsyncLocal<object?> current = new();

var (pipeline, value) = Build();
for (int i = 0; i < 3; i++) { GC.Collect(); GC.WaitForPendingFinalizers(); }
GC.KeepAlive(pipeline);
Console.WriteLine($"alive: {value.IsAlive}");

[MethodImpl(MethodImplOptions.NoInlining)]
(ResiliencePipeline, WeakReference) Build()
{
    object payload = new byte[1024];
    current.Value = payload; // whatever the first caller's flow carries
    var p = new ResiliencePipelineBuilder().AddCircuitBreaker(new()).Build();
    current.Value = null;
    return (p, new WeakReference(payload));
}
```

私のマシン (SDK 10.0.302) では、`Polly.Core@8.8.0` は `alive: True` を、`Polly.Core@8.8.1` は `alive: False` を出力します。8.8.0 では後から `AsyncLocal` をクリアしても効果がありません。バックグラウンドタスクが保持しているのは開始時に取得したコンテキストのスナップショットであり、ライブなビューではないためです。

## 修正内容

[PR #3284](https://github.com/App-vNext/Polly/pull/3284) はわずか 3 行です。

```csharp
public ScheduledTaskExecutor()
{
    using (ExecutionContext.SuppressFlow())
    {
        ProcessingTask = Task.Run(StartProcessingAsync);
    }
}
```

知っておくべき動作の変更が 1 つあります。状態変化のコールバックから、パイプラインを構築した側の `AsyncLocal` 値が見えなくなります。もともと、実際にブレーカーを作動させたリクエストの値を確実に見られたわけではなく、見えていたのはパイプラインを構築したコードの値だけでした。たとえば `OnOpened` の中で `Activity.Current` やテナントのアクセサーを読んでいた場合は、必要な情報を `ResilienceContext` かコールバックの引数経由で渡してください。

## 対応方法

`Polly.Core` (直接参照している場合は `Polly.Extensions` も) を 8.8.1 に更新してください。`Microsoft.Extensions.Http.Resilience` は Polly を推移的に取り込むため、ロックファイルがまだ 8.8.0 のままなら明示的な参照を追加します。

```xml
<PackageReference Include="Polly.Core" Version="8.8.1" />
```

まだアップグレードできない場合、Issue に記載された回避策は、どのリクエストよりも先に、起動時に `ExecutionContext.SuppressFlow()` の中でパイプラインを事前に構築しておくことです。

同じリリースでは、パイプライン実行の高速化 ([#3287](https://github.com/App-vNext/Polly/pull/3287)) と、レジストリにおける関連したクリーンアップ漏れの修正 ([#3288](https://github.com/App-vNext/Polly/pull/3288)) も行われています。2 つの呼び出し元が同じキーの初期化を競合したとき、負けた側のパイプラインは破棄されるもののリソースとリロード登録を保持し続けていました。現在はリロードと同じ非同期の破棄パスを通るようになり、[Polly 8.8 の `EnableReloadsWithMonitor`](/ja/2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor/) を採用している場合に重要です。
