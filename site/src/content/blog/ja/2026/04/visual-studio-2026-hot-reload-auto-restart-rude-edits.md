---
title: "Visual Studio 2026 の Hot Reload 自動再起動: rude edit がデバッグセッションを殺さなくなる"
description: "Visual Studio 2026 は HotReloadAutoRestart を追加します。rude edit がさもなければデバッグセッションを終わらせるときにアプリを再起動するプロジェクトレベルの opt-in です。Razor と Aspire プロジェクトに特に有用。"
pubDate: 2026-04-14
tags:
  - "dotnet"
  - "visual-studio"
  - "hot-reload"
  - "razor"
lang: "ja"
translationOf: "2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits"
translatedBy: "claude"
translationDate: 2026-04-24
---

Visual Studio 2026 の 3 月のアップデートで最も静かな勝利の 1 つは、[rude edit のための Hot Reload 自動再起動](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload) です。"rude edit" とは、Roslyn EnC エンジンが in-process で適用できない変更のことです: メソッドシグネチャの変更、クラスのリネーム、ベースタイプの入れ替え。今までの唯一正直な答えは、デバッガーを停止し、リビルドし、再度アタッチすることでした。Visual Studio 2026 の .NET 10 プロジェクトでは、はるかに良いデフォルトに opt-in できます: IDE がプロセスを再起動してくれて、デバッグセッションを保ちます。

## 単一プロパティで opt-in

機能はプロジェクトレベルの MSBuild プロパティでゲートされるので、プロセス再起動が安価なプロジェクト - ASP.NET Core API、Blazor Server アプリ、Aspire オーケストレーション - には選択的にオンにし、重い desktop ホストにはオフのままにできます。

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <HotReloadAutoRestart>true</HotReloadAutoRestart>
  </PropertyGroup>
</Project>
```

`Directory.Build.props` に引き上げて solution 全体を一度に opt-in することもできます:

```xml
<Project>
  <PropertyGroup>
    <HotReloadAutoRestart>true</HotReloadAutoRestart>
  </PropertyGroup>
</Project>
```

プロパティが設定されていると、rude edit は変更されたプロジェクトとその依存元の的を絞ったリビルドをトリガーし、新しいプロセスが起動され、デバッガーが再アタッチします。再起動されないプロジェクトは走り続けるので、Aspire ではそれが大きく重要です: Postgres コンテナと worker service は、コントローラーメソッドをリネームしただけのために跳ねる必要がありません。

## Razor がついに速く感じる

アップデートの後半は Razor コンパイラです。前のバージョンでは、Razor ビルドは別プロセスに住んでいて、`.razor` ファイル上の Hot Reload はコンパイラがコールドスタートする間に数十秒かかりえました。Visual Studio 2026 では Razor コンパイラが Roslyn プロセス内に co-hosted されているので、Hot Reload 中の `.razor` ファイル編集は事実上無料です。

完全な再起動なしで Hot Reload を生き残るものを示す小さな例:

```razor
@page "/counter"
@rendermode InteractiveServer

<h1>Counter: @count</h1>
<button @onclick="Increment">+1</button>

@code {
    private int count;

    private void Increment() => count++;
}
```

`<h1>` テキストの変更、ラムダの調整、2 つ目のボタン追加は Hot Reload で動き続けます。今 `Increment` を `async Task IncrementAsync()` にリファクタリングする (シグネチャが変わったので rude edit) と、自動再起動がキックインし、プロセスが跳ね、デバッガーツールバーに触れずに `/counter` に戻ります。

## 気をつけるべきこと

自動再起動は in-process の state を保存しません。デバッグループがウォームキャッシュ、認証済みセッション、SignalR 接続に依存しているなら、再起動で失います。2 つの実用的な緩和策:

1. 高価なウォームアップを再実行が安価な `IHostedService` 実装に移すか、共有キャッシュで裏打ちします。
2. 更新が適用されたときにキャッシュをクリアして再シードするために、`MetadataUpdateHandlerAttribute` 経由で [カスタム Hot Reload ハンドラー](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload) を使います。

```csharp
[assembly: MetadataUpdateHandler(typeof(MyApp.CacheResetHandler))]

namespace MyApp;

internal static class CacheResetHandler
{
    public static void UpdateApplication(Type[]? updatedTypes)
    {
        AppCache.Clear();
        AppCache.Warm();
    }
}
```

Blazor と Aspire チームにとって、組み合わせの効果は機能の出荷以来最大の Hot Reload クオリティオブライフの飛躍です。1 つの MSBuild プロパティ、1 つの co-hosted コンパイラ、そして 1 日に十数回 5 分を食っていた「停止、リビルド、再アタッチ」の儀式がついに消えます。
