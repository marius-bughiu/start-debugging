---
title: ".NET 11 で Web Workers を使って Blazor WebAssembly アプリの CPU 集約的な処理を実行する方法"
description: ".NET 11 で CPU 集約的な処理を Blazor WebAssembly の UI スレッドから追い出すための完全ガイドです。Task.Run が役に立たない理由、新しい blazorwebworker テンプレート、キャンセルとタイムアウトに対応した WebWorkerClient API、JSExport のマーシャリング制限、そして worker ごとに支払う 2 つ目のランタイムのコストを解説します。"
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "webassembly"
  - "web-workers"
  - "performance"
lang: "ja"
translationOf: "2026/08/how-to-run-cpu-bound-work-in-a-blazor-webassembly-app-with-web-workers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-02
---

Blazor WebAssembly は .NET コードをブラウザーの唯一の UI スレッド上で実行します。そのため密な `for` ループはページを凍結させ、再描画もクリックも `StateHasChanged` も止まります。`Task.Run` は助けになりません。実行できる 2 つ目のスレッドが存在しないからです。.NET 11 での解決策は `blazorwebworker` プロジェクトテンプレートです。このテンプレートは、メソッドが実際のブラウザー Web Worker の中で別の OS スレッド上で実行されるクラスライブラリを生成します。それらのメソッドに `[JSExport]` を付け、アプリからライブラリを参照し、`WebWorkerClient.InvokeAsync<TResult>` 経由で呼び出します。

以下の内容はすべて .NET 11 (執筆時点では Preview 6、SDK `11.0.100-preview.6`) と C# 14 を対象としています。このテンプレートは .NET 11 Preview 1 で `webworker` という名前で登場し、リリース前に [`blazorwebworker` へ名称変更されました](https://github.com/dotnet/aspnetcore/pull/66070)。旧名で生成したプロジェクトはそのまま動作し、変わったのはテンプレート ID だけです。.NET 11 の最終版クライアントでは 2 つの機能が新しく追加されました。`InvokeVoidAsync` と、worker の作成と呼び出しの両方に対するキャンセルおよびタイムアウトのサポートです。

## 最初から最後までの 6 ステップ

1. `dotnet new blazorwebworker` で worker クラスライブラリを作成し、Blazor WebAssembly アプリから参照します。
2. CPU 集約的なコードを、`static partial class` の中の `[JSExport]` 付き `static` メソッドとして記述します。
3. 戻り値はプリミティブか文字列だけにし、それより複雑なものは worker 内で JSON にシリアル化します。
4. `WebWorkerClient` は呼び出しごとではなく 1 回だけ作成し、コンポーネントまたはアプリの生存期間を通じて保持します。
5. メソッドは完全修飾名で呼び出し、`CancellationToken` とタイムアウトを渡します。
6. クライアントを破棄して worker を終了させ、読み込まれた 2 つ目のランタイムを解放します。

この記事の残りでは、それぞれがなぜ重要なのか、そして 1 つ飛ばすと何が壊れるのかを説明します。

## `Task.Run` が処理を UI スレッドの外へ動かさない理由

これは誰もが最初に試すことです。worker に手を伸ばす前に、なぜ失敗するのかを正確に理解しておく価値があります。

```csharp
// .NET 11, C# 14 - Blazor WebAssembly. This still freezes the browser.
private async Task Compute()
{
    status = "Working...";
    await Task.Run(() => CountPrimes(5_000_000));
    status = "Done";
}

private static int CountPrimes(int limit)
{
    var count = 0;
    for (var n = 2; n <= limit; n++)
    {
        var isPrime = true;
        for (var d = 2; d * d <= n; d++)
        {
            if (n % d == 0) { isPrime = false; break; }
        }
        if (isPrime) count++;
    }

    return count;
}
```

`status = "Working..."` の行は決して描画されません。ブラウザーのタブが数秒間反応しなくなり、その後で 2 つのステータス更新が一度に表示されます。

理由は、Blazor WebAssembly のランタイムがシングルスレッドだからです。`Task.Run` は .NET のスレッドプールに処理をキューイングしますが、`browser-wasm` ランタイムではそのプールはランタイムが所有する唯一のスレッド上でエミュレートされています。デリゲートは現在の同期ブロックが制御を手放すまで開始せず、いったん開始すると戻るまで他の何も割り込めません。ループの前に `await Task.Delay(1)` を入れれば最初の描画は通りますが、それでもループはその後のすべてをブロックします。

次に浮かぶ当然の疑問は、単純にスレッドを有効化できないのか、というものです。ランタイム自体は `<WasmEnableThreads>true</WasmEnableThreads>` をサポートしていますが、これはランタイムレベルの機能であり、Blazor WebAssembly はサポートしていません。Blazor のレンダラーは歴史的なシングルスレッド保証に依存しています。レンダーバッチはゼロコピーの共有メモリ経由で JavaScript に渡され、イベントは同期的に .NET へディスパッチされます。マルチスレッドランタイムはすべての .NET コードをバックグラウンドの "deputy" スレッドへ移すため、この 2 つの前提が両方とも崩れます。追跡用 issue の [dotnet/aspnetcore#54365](https://github.com/dotnet/aspnetcore/issues/54365) は現在も開いたままです。Blazor WASM プロジェクトでこのフラグを立てると、より速いアプリではなく、動かないビルドが手に入ります。

つまり現実的な選択肢は、Web Worker の中に .NET ランタイムの 2 つ目の独立したコピーを走らせ、メッセージパッシングでやり取りすることだけです。テンプレートが構築するのはまさにそれです。

## worker プロジェクトの作成

コマンド 2 つとプロジェクト参照が 1 つです。

```bash
# .NET 11 SDK
dotnet new blazorwasm -n SampleApp
dotnet new blazorwebworker -n WebWorker

cd SampleApp
dotnet add reference ../WebWorker/WebWorker.csproj
```

生成されるライブラリは次のような構成です。

```
WebWorker/
├── WebWorker.csproj
├── WebWorkerClient.cs
├── WorkerMethods.cs
└── wwwroot/
    ├── dotnet-web-worker-client.js
    └── dotnet-web-worker.js
```

`dotnet-web-worker.js` は worker のエントリーポイントです。`dotnet.create()` を呼んで Blazor のレイヤーを一切含まない WebAssembly ランタイムを起動し、続いて `getAssemblyExports(assemblyName)` で `[JSExport]` メソッドへのハンドルを取得し、届いたメソッド名をそのオブジェクトグラフに対して解決します。`dotnet-web-worker-client.js` はメインスレッドで動作し、worker を生成してリクエストとレスポンスを ID で対応付けます。`WebWorkerClient.cs` はその JavaScript クライアントを包む C# のラッパーです。3 つとも編集する必要はありません。

重要なプロジェクトプロパティが 1 つあり、テンプレートが既に設定しています。

```xml
<PropertyGroup>
  <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
</PropertyGroup>
```

`[JSExport]` と `[JSImport]` はポインターを使うマーシャリングコードを生成するため、これがないとコンパイラーが拒否します。後から Blazor アプリ側のプロジェクトに `[JSImport]` 呼び出しを追加する場合は、そちらにも同じプロパティが必要です。

## worker メソッドを書く

worker メソッドは `static` で、`[JSExport]` が付き、`static partial class` の中に置きます。`partial` は飾りではありません。JS interop のソースジェネレーターが残り半分を生成します。`[SupportedOSPlatform("browser")]` はプラットフォーム互換性アナライザーの警告を抑制します。これらの API はブラウザーランタイムにしか存在しないためです。

`WebWorker/WorkerMethods.cs`:

```csharp
// .NET 11, C# 14
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;

namespace WebWorker;

[SupportedOSPlatform("browser")]
public static partial class WorkerMethods
{
    [JSExport]
    public static int CountPrimes(int limit)
    {
        var count = 0;
        for (var n = 2; n <= limit; n++)
        {
            var isPrime = true;
            for (var d = 2; d * d <= n; d++)
            {
                if (n % d == 0) { isPrime = false; break; }
            }
            if (isPrime) count++;
        }

        return count;
    }

    [JSExport]
    public static string Analyze(string csv)
    {
        var rows = csv.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var report = new Report(rows.Length, rows.Length == 0 ? 0 : rows.Max(r => r.Length));
        return JsonSerializer.Serialize(report);
    }
}

public record Report(int RowCount, int WidestRow);
```

`Analyze` の形に注目してください。`[JSExport]` が JavaScript の境界を越えてマーシャリングできる型は決まっています。プリミティブ、`string`、`byte[]`、それらの `Task<T>`、そしていくつかの JS 固有の型です。任意の POCO や record はマーシャリングされません。標準的な回避策は worker 側でシリアル化し、反対側でデシリアル化することで、ドキュメントが推奨し、生成されるサンプルが実際にそうしています。ペイロードが多態的な階層である場合は、[`[JsonDerivedType]` による判別子の設定](/ja/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)がそのまま当てはまります。両端とも System.Text.Json だからです。

もう 1 つ知っておく価値があります。`byte[]` は直接境界を越えられ、生成されるクライアントは `ArrayBuffer` の転送を最適化するので、大きなバイナリ結果はコピーではなく移動されます。画像やファイルのバイト列を返すなら、JSON 文字列の中の base64 よりも `byte[]` を選んでください。

## コンポーネントから worker を呼び出す

`WebWorkerClient.CreateAsync` は worker を起動し、その中のランタイムが準備完了を報告するまで待ちます。これはネットワーク取得を伴う非同期処理なので、`OnInitializedAsync` ではなく `OnAfterRenderAsync` に置くべきです。

`Pages/Home.razor.cs`:

```csharp
// .NET 11, C# 14
using System.Text.Json;
using System.Runtime.Versioning;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using WebWorker;

namespace SampleApp.Pages;

[SupportedOSPlatform("browser")]
public partial class Home : ComponentBase, IAsyncDisposable
{
    private WebWorkerClient? worker;
    private string status = "Booting worker...";

    [Inject] private IJSRuntime JSRuntime { get; set; } = default!;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            worker = await WebWorkerClient.CreateAsync(JSRuntime);
            status = "Ready";
            StateHasChanged();
        }
    }

    private async Task Run()
    {
        if (worker is null) return;

        status = "Working...";

        var count = await worker.InvokeAsync<int>(
            "WebWorker.WorkerMethods.CountPrimes", [5_000_000]);

        status = $"Found {count} primes";
    }

    public async ValueTask DisposeAsync()
    {
        if (worker is not null)
        {
            await worker.DisposeAsync();
        }
    }
}
```

これで `status = "Working..."` はすぐに描画され、スピナーは回り続け、500 万個の数が別の OS スレッドで素因数分解される間も UI は操作可能なままです。

メソッド名は文字列です。`AssemblyName.ClassName.MethodName` という形式です。worker はこれを分割し、`getAssemblyExports` が返す exports オブジェクトを辿るため、タイプミスはコンパイルエラーではなく実行時の失敗になります。呼び出しごとにサービスクラスの小さな型付きメソッドで包むのは、その 10 行の価値があります。マジックストリングが存在する場所が 1 か所にまとまるからです。

`OnAfterRenderAsync` に置くのは好みの問題ではありません。`.Client` プロジェクトがサーバー側でプリレンダリングされる Blazor Web App では、prerender のパスの間 JS interop は利用できず、そこで呼び出すと [JavaScript interop calls cannot be issued at this time](/ja/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) のエラーがスローされます。`OnAfterRenderAsync` は対話性が確立された後にのみ実行されるので、worker はクライアント上でちょうど 1 回だけ作成されます。

## キャンセルとタイムアウト

これがクライアントを本番で使えるものにした .NET 11 の追加点です。API の全体像は次のとおりです。

```csharp
// .NET 11
public sealed class WebWorkerClient : IAsyncDisposable
{
    public static async Task<WebWorkerClient> CreateAsync(
        IJSRuntime jsRuntime,
        int timeoutMs = 60000,
        string? assemblyName = null,
        CancellationToken cancellationToken = default);

    public async Task<TResult> InvokeAsync<TResult>(
        string method,
        object[] args,
        int timeoutMs = 60000,
        CancellationToken cancellationToken = default);

    public async Task InvokeVoidAsync(
        string method,
        object[] args,
        int timeoutMs = 60000,
        CancellationToken cancellationToken = default);

    public async ValueTask DisposeAsync();
}
```

`timeoutMs` もトークンも、守るのはメインスレッド側の待機であって、worker 側の実行ではありません。同期ループを回している `[JSExport]` メソッドは `CancellationToken` を観測できません。外部から中断する手段がないからです。キャンセルが与えてくれるのは、待機をやめて固まった worker をきれいに片付ける能力です。

```csharp
// .NET 11, C# 14
private CancellationTokenSource? cts;

private async Task RunCancellable()
{
    cts?.Cancel();
    cts?.Dispose();
    cts = new CancellationTokenSource();

    try
    {
        var count = await worker!.InvokeAsync<int>(
            "WebWorker.WorkerMethods.CountPrimes",
            [5_000_000],
            timeoutMs: 10_000,
            cancellationToken: cts.Token);

        status = $"Found {count} primes";
    }
    catch (OperationCanceledException)
    {
        status = "Cancelled";

        // The worker is still busy. Kill it and start a fresh one.
        await worker.DisposeAsync();
        worker = await WebWorkerClient.CreateAsync(JSRuntime);
    }
}

private void Cancel() => cts?.Cancel();
```

キャンセル後に破棄することが重要な半分です。待機だけキャンセルしてクライアントを保持し続けると、放棄された計算はコアを消費し続け、次の `InvokeAsync` はその後ろに並びます。`DisposeAsync` は下層の `Worker` に対して `terminate()` を呼び、何をしていようと即座に停止させます。トークンを呼び出しチェーンに通す一般的な形は [.NET 11 で CancellationToken を非同期メソッドに伝播させる方法](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)のガイドで扱っています。また、独自のクリーンアップも走らせるクライアント側の期限が欲しい場合は、[`CancellationTokenSource.CancelAfter`](/ja/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/) を `timeoutMs` と組み合わせられます。

結果が不要な処理には、`InvokeVoidAsync` が結果の往復を省きます。

```csharp
await worker.InvokeVoidAsync("WebWorker.WorkerMethods.WarmCaches", []);
```

## コスト: worker ごとに自前のランタイムをダウンロードする

ここが驚かれる部分であり、上で述べた設計判断の大半を左右します。

worker はメインスレッドのランタイムを共有しません。2 つ目の完全な .NET WebAssembly ランタイムを起動します。`dotnet.js`、ランタイムの `.wasm`、そして worker ライブラリが推移的に参照するすべてのアセンブリです。ブラウザーの HTTP キャッシュのおかげで初回ロード以降の 2 回目の取得はたいてい安く済みますが、インスタンス化はただではなく、2 つのランタイムはヒープが別々なのでメモリは本当に倍になります。

ここから導かれる実践的なルールです。

- **クライアントは一度作って、ずっと再利用する。** ボタンのクリックごとに `CreateAsync` を呼ぶのは、worker を置き換え前のコードより遅くする最も一般的な方法です。
- **アプリ全体で使うならシングルトンとして登録し**、コンポーネントごとに作るのではなく遅延初期化します。

  ```csharp
  // .NET 11, C# 14 - Program.cs of the Blazor WebAssembly app
  builder.Services.AddSingleton<WorkerService>();
  ```

  ```csharp
  public sealed class WorkerService(IJSRuntime js) : IAsyncDisposable
  {
      private WebWorkerClient? client;
      private readonly SemaphoreSlim gate = new(1, 1);

      private async Task<WebWorkerClient> GetClientAsync(CancellationToken ct)
      {
          if (client is not null) return client;

          await gate.WaitAsync(ct);
          try
          {
              return client ??= await WebWorkerClient.CreateAsync(js, cancellationToken: ct);
          }
          finally
          {
              gate.Release();
          }
      }

      public async Task<int> CountPrimesAsync(int limit, CancellationToken ct = default)
      {
          var c = await GetClientAsync(ct);
          return await c.InvokeAsync<int>(
              "WebWorker.WorkerMethods.CountPrimes", [limit], cancellationToken: ct);
      }

      public async ValueTask DisposeAsync()
      {
          if (client is not null) await client.DisposeAsync();
          gate.Dispose();
      }
  }
  ```

  セマフォが重要なのは、同時に描画される 2 つのコンポーネントが両方とも `client is null` を見て両方とも `CreateAsync` を呼び、1 つで済むはずのランタイムが 2 つできてしまうからです。

- **worker ライブラリの依存グラフは小さく保つ。** worker プロジェクトから参照するパッケージはすべて、2 つ目のランタイムにダウンロードされ読み込まれる追加のアセンブリになります。そこに置くのは計算コードだけにし、EF Core や検証をぶら下げた共有モデルライブラリは置かないでください。
- **呼び出しはまとめる。** 1 回の呼び出しは両端でのシリアル化を伴う `postMessage` の往復です。ループの中で 10 回呼ぶのは、配列引数で 1 回呼ぶより明確に遅くなります。

## 境界を越えないもの

worker は本当に独立したランタイムであり、同一プロセス内のバックグラウンドスレッドのように扱うことがバグの源になります。

**共有状態はない。** worker アセンブリの静的フィールドは 2 つ存在します。メインスレッドのランタイムに 1 つ、worker に 1 つです。コンポーネントから静的フィールドに書き込み、`[JSExport]` メソッドから読み出すと、worker 側のコピーが持っている値が返ります。状態はすべて引数と戻り値で運ぶ必要があります。

**依存性注入はない。** worker メソッドは静的で、worker のランタイムはサービスプロバイダーを構築しません。計算コードに設定が必要なら、引数か JSON の blob として渡してください。

**DOM も `IJSRuntime` も `NavigationManager` もない。** Web Worker には `document` も `window` もありません。UI に触れるものはすべて、`InvokeAsync` が返った後のメインスレッドで行う必要があります。

**進捗コールバックは標準では用意されていない。** 生成されるクライアントがモデル化しているのはリクエストとレスポンスであって、ストリーミングではありません。長い計算に進捗バーが必要なら、処理をチャンクに分割してチャンクごとに 1 回呼び出し、呼び出しの合間に UI を更新してください。

## デバッグと trimming という 2 つの粗い部分

`[JSExport]` メソッドの内部でスローされた例外は `postMessage` 経由でメッセージ文字列として戻ってくるため、メインスレッドで得られる C# のスタックトレースが説明しているのは interop レイヤーであって、あなたのループではありません。worker メソッドの挙動がおかしいときは、同じ静的メソッドを一時的にコンポーネントから直接呼び出し、デバッガーを接続したメインスレッドで再現させてから元に戻すのが、たいてい最短の道です。

trimming が 2 つ目の注意点です。公開された Blazor アプリは積極的にトリミングし、worker は `getAssemblyExports` を通じて実行時に名前でメソッドを解決します。それらのメソッドを保持しているのが `[JSExport]` 属性なので、エクスポートされたメソッド自体は安全です。しかしそこからリフレクション経由でのみ到達するものは安全ではありません。worker の呼び出しが `dotnet run` では動くのに `dotnet publish` の後で失敗するなら、リフレクションと trimming の組み合わせが最初に検証すべき仮説です。[Native AOT に当てはまるトリム安全性のルール](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)がここでもそのまま当てはまります。

最後に、そもそもこれが必要なのかを正直に考えてください。スタンドアロンの WebAssembly アプリではなく Blazor Web App を作っているなら、クライアントが 2 つ目のランタイムを起動するよりサーバーのほうが速く計算を終えられることが多く、単純な API 呼び出しのほうが同じ結果を少ない仕掛けで得られます。ホスティングモデル間のトレードオフは [Blazor Server、WebAssembly、United の比較](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)で整理しています。Web Workers が正解になるのは、データが既にクライアント上にあり、処理が IO ではなく本当に CPU に律速され、サーバーへの往復が許容できない場合です。それ以外では、サーバーは今でも「より良いハードウェアを持つスレッドプール」です。

## 関連記事

- [dotnet new webworker: .NET 11 Preview 2 の Blazor 向けファーストクラスな Web Workers](/ja/2026/04/dotnet-11-preview-2-blazor-webworker-template/)
- [.NET 11 における Blazor Server と Blazor WebAssembly と Blazor United の比較](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [.NET 11 で CancellationToken を非同期メソッドに伝播させる方法](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [Fix: Blazor のプリレンダリング中に JavaScript interop calls cannot be issued at this time が出る](/ja/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)
- [System.Text.Json で JsonDerivedType を使って多態的な型階層をシリアル化する方法](/ja/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)
- [CPU 集約的な処理のために Dart の isolate を書く方法](/ja/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)

## 参考資料

- [ASP.NET Core Blazor with .NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/blazor/blazor-with-dotnet-on-web-workers?view=aspnetcore-11.0)、Microsoft Learn
- [.NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-on-webworkers?view=aspnetcore-11.0)、Microsoft Learn
- [What's new in ASP.NET Core in .NET 11: New Blazor Web Worker template](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11?view=aspnetcore-11.0)、Microsoft Learn
- [.NET Web Worker template update to Blazor Web Worker template (dotnet/aspnetcore #66070)](https://github.com/dotnet/aspnetcore/pull/66070)、GitHub
- [Make Blazor WebAssembly work on multithreaded runtime (dotnet/aspnetcore #54365)](https://github.com/dotnet/aspnetcore/issues/54365)、GitHub
- [JSExportAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.javascript.jsexportattribute)、Microsoft Learn
- [Running background tasks in Blazor with Web Workers](https://andrewlock.net/exploring-the-dotnet-11-preview-1-running-background-tasks-in-blazor-with-web-workers/)、Andrew Lock
- [Web Workers API](https://developer.mozilla.org/docs/Web/API/Web_Workers_API)、MDN
