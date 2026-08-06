---
title: "解決: Blazor Server の circuit が切断された後の Attempting to reconnect to the server"
description: "再接続モーダルはアプリがクラッシュしたのではなく、SignalR の circuit が切れたという合図です。再試行が failed で終わるか rejected で終わるかを確認し、セッションアフィニティ、3 分の保持期間、32 KB 制限を直すか、[PersistentState] で状態を保存してください。"
pubDate: 2026-08-06
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnetcore"
  - "dotnet-11"
  - "signalr"
lang: "ja"
translationOf: "2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects"
translatedBy: "claude"
translationDate: 2026-08-06
---

このモーダルはエラーではなく、SignalR の circuit が切断されてクライアントが再試行中であることを Blazor が伝えているものです。重要なのは、その再試行がどう終わるかです。`failed` ("Reconnection failed"、"Failed to rejoin") で終わる場合、ブラウザーはサーバーに到達していません。プロキシを通る WebSocket の経路、keep-alive のタイムアウト、そして `MaximumReceiveMessageSize` の 32 KB 制限を確認してください。`rejected` ("Could not reconnect to the server"、"Failed to resume the session") で終わる場合は、サーバーに到達したうえで拒否されています。アプリが再起動した、セッションアフィニティなしでロードバランサーが別のインスタンスへ振り分けた、あるいは 3 分の `DisconnectedCircuitRetentionPeriod` が切れた、のいずれかで circuit が失われています。.NET 10 と .NET 11 では、この最後のグループに対する恒久的な答えは、circuit の同一性にこだわるのをやめ、状態に `[PersistentState]` を付けることです。

```text
Attempting to reconnect to the server: 3 of 8
Reconnection failed. Try reloading the page if you're unable to reconnect.
Could not reconnect to the server. Reload the page to restore functionality.
```

これは .NET 8 以前の文言で、多くの人が検索ボックスに貼り付けるのもこれです。.NET 9 以降では同じ状態の文言が変わっており、検索結果が別のバグの話に見えるのはそのためです。

```text
Rejoining the server...
Rejoin failed... trying again in 5 seconds.
Failed to rejoin. Please retry or reload the page.
The session has been paused by the server.
Failed to resume the session. Please retry or reload the page.
```

以下の内容はすべて、Interactive Server レンダリングの Blazor Web App テンプレートを用いて .NET 11 Preview 6 (SDK `11.0.100-preview.6.26359.118`) で確認しており、.NET 8、9、10 で挙動が異なる箇所も示します。Blazor WebAssembly に circuit は存在しないため、このモーダルが出ているならコンポーネントは `InteractiveServer`、または現時点でサーバーに解決された `InteractiveAuto` でレンダリングされています。

## 切れた WebSocket が例外ではなくモーダルを生む理由

サーバーサイドの Blazor アプリは、コンポーネントツリー、各コンポーネントインスタンスのすべてのフィールド、circuit スコープのすべての DI サービスをサーバーのメモリに保持します。この一式が circuit です。ブラウザーが持っているのはレンダリング済みの DOM と SignalR 接続だけで、クリックのたびにサーバーへのリモート呼び出しが飛び、レンダリングのたびに差分が返ってきます。接続が切れるとブラウザーには描画する材料がないので、フレームワークがページを覆い、同じ circuit に ID で再び結び付こうとします。

この UI を自分で書く必要はありません。アプリが `id="components-reconnect-modal"` の要素を定義していれば、Blazor はその要素の CSS クラスを切り替えます。定義していなければ、Blazor は組み込みの表示を挿入し、そこからあの古典的な文言が出てきます。デバッグ上ここが重要です。目にしているメッセージは完全にクライアント側で、クライアント側の状態から生成されています。サーバーが何が起きたと考えているかについては何も語りません。サーバー側の事情はログの中にあります。

## 3 つの終了状態と、実際にどれが起きているのか

.NET 10 以降、フレームワークはモーダル要素上で `components-reconnect-state-changed` イベントを発火し、対応する CSS クラスを設定します。推測ではなく結果を読み取れます。

| CSS クラス | イベントの `detail.state` | 意味 |
| --- | --- | --- |
| `components-reconnect-show` | `show` | 接続が失われ、再試行中です。 |
| `components-reconnect-retrying` | `retrying` | 再試行が進行中です。 |
| `components-reconnect-paused` | `paused` | circuit が一時停止しました (クライアントまたはサーバーによる)。 |
| `components-reconnect-hide` | `hide` | 再接続できました。何も失われていません。 |
| `components-reconnect-failed` | `failed` | サーバーに到達できませんでした。`Blazor.reconnect()` を呼びます。 |
| `components-reconnect-rejected` | `rejected` | サーバーに到達したうえで拒否されました。`location.reload()` を呼びます。 |

.NET 9 以前で得られるのは CSS クラスだけで、イベントはありません。いずれにせよ `failed` と `rejected` が診断の分岐点であり、両者に共通する原因はほとんどありません。設定を変える前に、どちらが起きているかを記録してください。

```javascript
// .NET 10 or .NET 11, wwwroot or a collocated ReconnectModal.razor.js
const modal = document.getElementById("components-reconnect-modal");
modal.addEventListener("components-reconnect-state-changed", e => {
  console.log("[circuit]", e.detail.state, new Date().toISOString());
});
```

## 最小限の再現

壊れたアプリは必要ありません。Interactive Server のコンポーネントと、停止したプロセスがあれば十分です。

```csharp
// .NET 11 preview 6, C# 14. Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

var app = builder.Build();
app.MapRazorComponents<App>()
   .AddInteractiveServerRenderMode();
app.Run();
```

実行してカウンターのページを開き、数回クリックしてから Ctrl+C でプロセスを止めます。モーダルはおよそ 0.5 秒で現れます。プロセスを起動し直して何が起きるか見てください。接続自体は成功しますが、circuit の ID は新しいプロセスにとって未知なので、`hide` ではなく `rejected` になり、カウントはゼロに戻ります。これをネットワーク切断 (DevTools、Network、Offline) と比べてみます。再試行はどこにも届かず `failed` になり、ネットワークを戻すと保持期間内であれば再試行が元の circuit に着地し、カウントは保たれたままです。

この違いが診断のすべてを凝縮しています。`failed` はトランスポートの問題、`rejected` はライフタイムの問題です。

## 対処 1: インスタンスが複数あるならセッションアフィニティ

本番環境で最も多い原因で、ほぼすべての再接続が `rejected` になります。circuit は 1 つのプロセスのメモリの中にあります。別のインスタンスに着地した再接続は circuit の ID を見つけられず、拒否します。ラウンドロビンのロードバランサーの背後にサーバーが 2 台あれば、およそ半分の再接続が恒久的に失敗し、しかも断続的に見えるため、テストを生き延びてしまいます。

ロードバランサーでセッションアフィニティ (sticky sessions) を有効にしてください。Azure App Service なら ARR アフィニティ、ingress なら `sessionAffinity`、nginx なら `ip_hash` か sticky cookie です。ログで探すべき関連症状は `Invocation canceled due to the underlying connection being closed` です。アフィニティを使えない場合、インスタンスをまたいでメモリ上の circuit を維持することはできないので、対処 5 の分散永続化を選ぶことになります。

## 対処 2: 再試行スケジュールと保持期間をそろえる

サーバーは切断された circuit を `DisconnectedCircuitRetentionPeriod` (既定は 3 分) のあいだ保持し、その数は最大でも `DisconnectedCircuitMaxRetained` (既定は 100) です。それを過ぎると circuit は破棄され、以後の再接続は定義上すべて `rejected` になります。

クライアント側のスケジュールは .NET 9 で変わり、いまでは日常的にこの保持期間より長く続きます。

- **.NET 8 以前**: `maxRetries: 8`、`retryIntervalMilliseconds: 20000`。固定 20 秒間隔なので、クライアントは約 160 秒であきらめ、サーバーの 3 分にぎりぎり収まります。
- **.NET 9、.NET 10、.NET 11**: `maxRetries: 30` と計算されたバックオフ。最初の 10 回は handshake が許す限り速く実行され、11 回目から 20 回目までは 5 秒間隔、それ以降は 30 秒間隔です。合計およそ 350 秒、サーバーが 180 秒で削除した circuit に対して再試行し続けることになります。

つまり .NET 9 以降では、4 分席を外したユーザーはカウントダウンを続けたあげく拒否されるモーダルを見ます。設計どおりの動作ですが体験としては悪く、2 つの数字をそろえておく価値があります。サーバー側を延ばすか、

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents(options =>
    {
        options.DisconnectedCircuitRetentionPeriod = TimeSpan.FromMinutes(6);
        options.DisconnectedCircuitMaxRetained = 100;
        options.JSInteropDefaultCallTimeout = TimeSpan.FromSeconds(30);
    });
```

あるいはクライアント側を短くし、取り繕わずに早く失敗してリロードさせます。

```html
<!-- .NET 10 or .NET 11, App.razor. Requires autostart="false" on the Blazor script. -->
<script src="_framework/blazor.web.js" autostart="false"></script>
<script>
  Blazor.start({
    circuit: {
      reconnectionOptions: {
        maxRetries: 8,
        retryIntervalMilliseconds:
          Array.prototype.at.bind([0, 0, 1000, 2000, 5000, 10000, 15000, 30000])
      }
    }
  });
</script>
```

`retryIntervalMilliseconds` から `null` または `undefined` を返すと再試行が止まります。配列の末尾を越えたときに `Array.prototype.at` が返すのがまさにそれです。サーバー側の値を上げる前にメモリのコストも考えてください。保持される circuit は 1 つずつが生きたコンポーネントツリーとスコープ付きサービスであり、負荷のあるアプリでの 100 という数字は決して小さくありません。

## 対処 3: モーダルが延々と繰り返すときは 32 KB 制限

通常の操作中にモーダルが何度も出る場合、とくにファイルアップロード、大きなフォーム送信、大きな JS 相互運用のペイロードの直後であれば、既定 32 KB の `HubOptions.MaximumReceiveMessageSize` にぶつかっているとほぼ断定できます。これを超えると circuit はエラーで閉じられ、クライアントが再接続し、ユーザーが同じ操作を繰り返し、また閉じられます。

ブラウザーのコンソールには一般的なクローズしか出ません。

```text
Error: Connection disconnected with error 'Error: Server returned an error on close: Connection closed with an error.'
```

本当のメッセージは `Microsoft.AspNetCore.SignalR` のログを Debug か Trace にして初めて現れます。

```text
System.IO.InvalidDataException: The maximum message size of 32768B was exceeded.
```

上限を引き上げれば動きますが、その分 DoS への余裕を失います。

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddHubOptions(options =>
    {
        options.MaximumReceiveMessageSize = 64 * 1024;
    });
```

本当に大きなデータに対するより良い対処は、上限を上げるのではなく上限未満に分割するストリーミング JS 相互運用です。`MaximumParallelInvocationsPerClient` は既定の `1` のままにしてください。Blazor はこれを前提にしており、増やすと `InputFile` のアップロードが壊れます。

同じ問題には、操作時ではなく初回ロード時に出る第 2 の形もあります。`PersistentComponentState` で送られるプリレンダリング済みの状態が上限を超えると circuit はそもそも起動せず、ログに `Circuit host not initialized` が出ます。保存する状態を減らすか、上限を上げてください。

## 対処 4: アイドル状態の WebSocket を切るタイムアウトとプロキシ

アイドル時間の後、モバイル、あるいはリバースプロキシの背後でだけ起きる `failed` は、トランスポートのタイムアウトです。3 つの数字が整合している必要があります。

```csharp
// .NET 11 preview 6. Program.cs. These are the framework defaults, stated explicitly.
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddHubOptions(options =>
    {
        options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
        options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        options.HandshakeTimeout = TimeSpan.FromSeconds(15);
    });
```

ルールは、サーバーのタイムアウトを keep-alive 間隔の 2 倍以上にすることです。片方を上げるならもう片方も上げます。そのうえで、keep-alive の合間にアイドルになる接続をインフラが許容するか確認してください。nginx の `proxy_read_timeout`、Application Gateway の WebSocket アイドルタイムアウト、IIS の `webSocket enabled="true"` と妥当な `pingInterval` です。20 秒で接続を閉じるプロキシは 20 秒ごとに再接続モーダルを出し続け、Blazor 側をどう設定しても直りません。

モバイルブラウザーとバックグラウンドタブがこの話のもう半分です。スロットルされたタブはタイマーの実行を止め、keep-alive が途切れ、サーバーは circuit を破棄します。.NET 9 以降はタブが再び表示された時点で、次の予定された再試行を待たずにすぐ再接続します。さらに .NET 10 テンプレートの `ReconnectModal.razor.js` は、失敗後に `visibilitychange` でも再試行します。つまりバージョンを上げること自体が「タブに戻ったら全部消えていた」という報告への実際の対処になります。

## 対処 5: .NET 10 と 11 では状態を保存し、circuit と戦うのをやめる

ここまでの対処はすべて 1 つの circuit を生かし続けようとするものです。.NET 10 では、それをあきらめて代わりに状態を保持するという選択肢が加わりました。コンポーネントのプロパティ、またはスコープ付きサービスのプロパティに `[PersistentState]` を付けると、circuit が破棄されるときに Blazor がそれらをシリアライズし、同じタブが再接続したときに新しい circuit へ復元します。

```razor
@* .NET 10 or .NET 11, Counter.razor *@
@page "/counter"
@rendermode InteractiveServer

<p role="status">Current count: @CurrentCount</p>
<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    [PersistentState]
    public int CurrentCount { get; set; }

    private void IncrementCount() => CurrentCount++;
}
```

これは `AddInteractiveServerComponents` を呼んだ時点で既定で有効です。インメモリのプロバイダーは保存済み circuit を最大 1,000 件、2 時間保持します。どちらも設定可能です。

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.Configure<CircuitOptions>(options =>
{
    options.PersistedCircuitInMemoryMaxRetained = 2_000;
    options.PersistedCircuitInMemoryRetentionPeriod = TimeSpan.FromHours(3);
});
```

複数インスタンスなら `HybridCache` を割り当てると保存済み状態が分散化され、既定 8 時間の `PersistedCircuitDistributedRetentionPeriod` が独自に効きます。セッションアフィニティを使えない場合の逃げ道がこれです。

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddHybridCache()
    .AddRedis("{CONNECTION STRING}");

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();
```

頼り切る前に知っておくべき制約があります。Interactive Server レンダリングでしか動かないこと、状態は JSON シリアライズ可能でなければならないこと (循環参照を持つ EF Core のエンティティは生き残りません)、ページの完全リロードで破棄されること、そして復元は保証されず、永続化に失敗した場合は通常の切断時の挙動にフォールバックすることです。ループ内で保存対象のコンポーネントをレンダリングするときは `@key` を使ってください。

同じ仕組みが一時停止も支えています。`Blazor.pauseCircuit()` と `Blazor.resumeCircuit()` を使えば、非表示タブの circuit を手放して復帰時に組み立て直せます。.NET 11 ではそのサーバー側として `Circuit.RequestCircuitPauseAsync(CancellationToken)` が追加され、デプロイ時にプロセスを止める前に、接続中のクライアントへ一時停止と状態保存を要求できます。全ユーザーに拒否された再接続を突きつけずに済むわけです。クライアント側は `Blazor.start` の `onPauseRequested` コールバックで先送りできます。

## 誤った対処に導きやすい落とし穴

- **再接続モーダルは `blazor-error-ui` ではありません。** "An unhandled error has occurred" と表示される黄色いバーはコンポーネントの例外で、これも circuit を落とします。両方見えているなら例外を先に直してください。コンポーネント内の未処理例外は circuit を終了させ、その後の再接続は必ず `rejected` になります。
- **クラスが付くのは最初に一致した要素だけです。** レイアウトとページの両方が `id="components-reconnect-modal"` の要素をレンダリングすると、Blazor が切り替えるのは最初に見つけた 1 つだけで、もう一方は壊れて見えます。
- **500 ms の遅延は意図的です。** 一瞬の途切れで UI がちらつかないよう、Blazor はモーダル表示まで約 0.5 秒待ちます。伸ばすときは JavaScript ではなく CSS の `transition: visibility 0s linear 1000ms` を使ってください。
- **`Reconnection failed` と `Could not reconnect` は別の状態です。** 前者では `Blazor.reconnect()` を呼び、後者では必ず `location.reload()` を呼びます。両方を同じハンドラーにつなぐと、無限の再試行ループか、復元可能な状態を捨てるリロードのどちらかになります。
- **`_blazor` が 404 や 400 を返すのはこの問題ではありません。** それはハブのエンドポイントがマップされていないか、プロキシが upgrade ヘッダーを落としているケースで、再接続が成功することは決してありません。
- **放置タブの問題はバージョンアップで解決できるようになりました。** 2 時間前のタブを再接続することは、メモリ上の circuit だけでは不可能でした。.NET 10 以降は `[PersistentState]` で可能です。

## 関連記事

- [.NET 11 における Blazor Server と Blazor WebAssembly と Blazor United の比較](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)：そもそも circuit の上に乗ることになるホスティングモデルのトレードオフを扱っています。
- [.NET 11 で Blazor の静的レンダリングから対話的レンダリングへの境界をまたいで状態を保持する方法](/ja/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/)：`[PersistentState]` と `PersistentComponentState` を全面的に解説しています。
- [ASP.NET Core 11 で Redis を L2 キャッシュとして HybridCache を使う方法](/ja/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)：インスタンスをまたいだ circuit 永続化を支える分散キャッシュを構築します。
- [解決: JavaScript interop calls cannot be issued at this time (Blazor のプリレンダリング)](/ja/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)：どのレンダリングパスにいるかを読み違えることで起きる、もう 1 つの Blazor のエラーです。
- [.NET 11 で Blazor Server アプリを Blazor United (Blazor Web App) に移行する](/ja/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/)：カスタマイズ可能な `ReconnectModal` コンポーネントを同梱するテンプレートへの道筋です。

## 参考資料

- Microsoft Learn, [ASP.NET Core Blazor SignalR guidance](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/signalr?view=aspnetcore-11.0) (再接続の CSS クラス、`components-reconnect-state-changed` イベントの表、`MaximumReceiveMessageSize`、ハブのタイムアウト、セッションアフィニティ)。
- Microsoft Learn, [ASP.NET Core Blazor server-side state management](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/server?view=aspnetcore-11.0) (circuit 状態永続化の既定値、`PersistedCircuitInMemoryRetentionPeriod`、一時停止と再開、`Circuit.RequestCircuitPauseAsync`)。
- Microsoft Learn, [CircuitOptions.DisconnectedCircuitRetentionPeriod](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.server.circuitoptions.disconnectedcircuitretentionperiod) (既定値の 3 分)。
- dotnet/aspnetcore, [`CircuitStartOptions.ts`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Platform/Circuits/CircuitStartOptions.ts) (`maxRetries` の 30 と `computeDefaultRetryInterval` の 0 ms / 5 s / 30 s の段階。.NET 8 のブランチは `maxRetries: 8` と `retryIntervalMilliseconds: 20000`)。
- dotnet/aspnetcore, [`DefaultReconnectDisplay.ts`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Platform/Circuits/DefaultReconnectDisplay.ts) (.NET 8 のブランチと現行ブランチの両方における、各状態のモーダル文言)。
- dotnet/aspnetcore, [Blazor Web App テンプレートの `ReconnectModal.razor.js`](https://github.com/dotnet/aspnetcore/blob/main/src/ProjectTemplates/Web.ProjectTemplates/content/BlazorWeb-CSharp/BlazorWebCSharp.1/Components/Layout/ReconnectModal.razor.js) (`Blazor.reconnect()` から `Blazor.resumeCircuit()`、そして `location.reload()` という流れと、`visibilitychange` での再試行)。
