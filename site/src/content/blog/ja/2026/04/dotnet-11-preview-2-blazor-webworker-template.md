---
title: "dotnet new webworker: .NET 11 Preview 2 で Blazor 向けファーストクラスの Web Workers"
description: ".NET 11 Preview 2 の新しいプロジェクトテンプレートが、ブラウザの Web Worker で .NET コードを実行するために必要な JS 配管、WebWorkerClient、JSExport ボイラープレートをスキャフォールドします。"
pubDate: 2026-04-05
tags:
  - "dotnet-11"
  - "blazor"
  - "webassembly"
  - "web-workers"
  - "aspnet-core"
lang: "ja"
translationOf: "2026/04/dotnet-11-preview-2-blazor-webworker-template"
translatedBy: "claude"
translationDate: 2026-04-25
---

Blazor WebAssembly で CPU 重視の作業を実行することは、常に同じ嫌な副作用を持っていました。UI スレッドが停滞し、アニメーションがガタつき、ユーザーはブラウザがクラッシュしたと疑います。[.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) でチームは、これまで自分で書く必要があったすべての配管をスキャフォールドする真新しいプロジェクトテンプレート `dotnet new webworker` という形で、その問題への適切な修正を出荷しました。

## テンプレートが実際に提供するもの

このテンプレートは `net11.0` をターゲットとする Razor クラスライブラリを生成し、以下を含みます。

1. 専用の Web Worker を起動し、その中で .NET ランタイムを起動する JavaScript ブートストラッパー。
2. `postMessage` の interop レイヤーを隠す C# 型 `WebWorkerClient`。
3. 任意のコンポーネントから呼び出せるサンプルの `[JSExport]` メソッド。

重要な詳細は、これらのいずれも Blazor 自体に依存しないことです。テンプレートはスタンドアロンの `wasmbrowser` アプリ、カスタム JS フロントエンド、Blazor WebAssembly のいずれにも同様に動作します。1 回の呼び出しで配線します。

```bash
dotnet new blazorwasm -n SampleApp
dotnet new webworker -n WebWorker
dotnet sln SampleApp.sln add WebWorker/WebWorker.csproj
dotnet add SampleApp/SampleApp.csproj reference WebWorker/WebWorker.csproj
```

## worker メソッドの定義

worker メソッドは `[JSExport]` で装飾された普通の静的メソッドです。worker 内のランタイムは完全修飾名でそれらを認識します。

```csharp
using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;

namespace WebWorker;

public static partial class PrimesWorker
{
    [JSExport]
    public static string ComputePrimes(int limit)
    {
        var primes = new List<int>();
        for (var n = 2; n <= limit; n++)
        {
            var isPrime = true;
            for (var d = 2; d * d <= n; d++)
            {
                if (n % d == 0) { isPrime = false; break; }
            }
            if (isPrime) primes.Add(n);
        }

        return JsonSerializer.Serialize(new { Count = primes.Count, Last = primes[^1] });
    }
}
```

`[JSExport]` メソッドは戻り値の型としてプリミティブと文字列に依然として制限されているため、些細でないものは JSON ラウンドトリップが必要です。`WebWorkerClient` は反対側で結果を自動的にデシリアライズします。

## Blazor コンポーネントからの呼び出し

これがかつて 200 行の interop だった部分です。.NET 11 では 3 行です。

```razor
@inject IJSRuntime JS

<button @onclick="Run">Find primes</button>
<p>@status</p>

@code {
    string status = "";

    async Task Run()
    {
        await using var worker = await WebWorkerClient.CreateAsync(JS);
        var result = await worker.InvokeAsync<PrimeResult>(
            "WebWorker.PrimesWorker.ComputePrimes",
            args: new object[] { 2_000_000 });

        status = $"Found {result.Count}, last was {result.Last}";
    }

    record PrimeResult(int Count, int Last);
}
```

`WebWorkerClient.CreateAsync` は worker を起動し、その中の .NET ランタイムが準備完了するのを待ち、完全修飾メソッド名で呼び出すクライアントを返します。メインスレッドはブロックしないので、`StateHasChanged` 呼び出しは UI を滑らかに保ち、200 万の数字がバックグラウンドの OS スレッド上で因数分解される間も同様です。

## なぜこれが重要か

.NET 11 以前、Blazor コミュニティは [Tewr/BlazorWorker](https://github.com/Tewr/BlazorWorker) のようなサードパーティパッケージに頼るか、毎回オーダーメイドの `JSImport`/`JSExport` ブリッジを作っていました。新しいテンプレートはこのクラスのボイラープレートを完全に取り除き、Microsoft からの祝福されたパスとして出荷され、既存の JSImport/JSExport ソースジェネレーターと組み合わせます。配管のコストが高すぎたために Blazor でバックグラウンド作業を延期していた場合、Preview 2 はそのコストをゼロにするリリースです。完全なリリースノートは [.NET 11 Preview 2 アナウンス](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) と更新された [.NET on Web Workers ドキュメント](https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-on-webworkers?view=aspnetcore-10.0) にあります。
