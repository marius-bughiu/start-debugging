---
title: "解決: JavaScript interop calls cannot be issued at this time (Blazor のプリレンダリング)"
description: "プリレンダリングはブラウザーのないサーバー上でコンポーネントを実行するため、IJSRuntime が例外を投げます。呼び出しを OnAfterRenderAsync に移すか、RendererInfo.IsInteractive で分岐するか、プリレンダリングを無効にしてください。"
pubDate: 2026-07-30
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
lang: "ja"
translationOf: "2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering"
translatedBy: "claude"
translationDate: 2026-07-30
---

解決策です。`IJSRuntime` を `OnInitialized`、`OnInitializedAsync`、`OnParametersSet{Async}`、またはコンポーネントのコンストラクターから呼び出し、そのコードがプリレンダリング中に実行されました。この時点では JavaScript を実行できるブラウザーが接続されていません。呼び出しを `OnAfterRenderAsync(bool firstRender)` に移し、`if (firstRender)` で保護してください。このメソッドはプリレンダリング中には決して実行されません。最初の対話的レンダリングより前に分岐する必要がある場合は、`RendererInfo.IsInteractive` を確認します (.NET 9 以降)。そのコンポーネントが JavaScript なしでは本当に成立しないなら、`@rendermode @(new InteractiveServerRenderMode(prerender: false))` でそのコンポーネントのプリレンダリングを無効にしてください。

```text
System.InvalidOperationException: JavaScript interop calls cannot be issued at this time.
This is because the component is being statically rendered. When prerendering is enabled,
JavaScript interop calls can only be performed during the OnAfterRenderAsync lifecycle method.
   at Microsoft.AspNetCore.Components.Server.Circuits.RemoteJSRuntime.BeginInvokeJS(...)
   at Microsoft.JSInterop.JSRuntime.InvokeAsync[TValue](String identifier, Object[] args)
   at BlazorSample.Components.Pages.Theme.OnInitializedAsync()
```

この記事は .NET 11 (ASP.NET Core 11、`Microsoft.AspNetCore.Components` 11.0.x) を対象にしていますが、この挙動はプリレンダリングの登場以来変わっておらず、内容は .NET 8、9、10 にもそのまま当てはまります。唯一の例外は `RendererInfo` で、これは .NET 9 で追加されました。

## 2 つのエラー文字列、2 つのレンダラー

この問題の検索流入は 2 つの異なるメッセージに分かれます。どちらが出たかで、どのホスティングモデルが投げたのかが分かります。

上に引用したメッセージは、Blazor Server の circuit スタックにある `RemoteJSRuntime` から来ています。ランタイムのクライアントプロキシが null のとき、つまりコンポーネントが有効な SignalR circuit の外で実行されているときに投げられます。`render-mode="ServerPrerendered"` を使う従来型の Blazor Server アプリで見るのはこのメッセージです。

2 つ目のメッセージはまったく別の型から来ています。

```text
System.InvalidOperationException: JavaScript interop calls cannot be issued during
server-side static rendering, because the page has not yet loaded in the browser.
Statically-rendered components must wrap any JavaScript interop calls in conditional
logic to ensure those interop calls are not attempted during static rendering.
   at Microsoft.AspNetCore.Components.Endpoints.UnsupportedJavaScriptRuntime.Microsoft.JSInterop.IJSRuntime.InvokeAsync[TValue](...)
```

`UnsupportedJavaScriptRuntime` は、エンドポイントレンダラーがサーバー側の静的レンダリング用に登録する internal sealed な `IJSRuntime` です。すべてのメソッドが例外を投げます。Blazor Web App (.NET 8 以降のテンプレート) では、プリレンダリングも静的 SSR もエンドポイントレンダラーを通るため、render mode がまったく指定されていないページや、`InteractiveWebAssembly` / `InteractiveAuto` コンポーネントのプリレンダリングパスでは、このメッセージが出ます。

どちらも `InvalidOperationException` で、根本原因も同じ、対処法のセットも同じです。スタックトレースに `UnsupportedJavaScriptRuntime` が見えたら、その文面に注目してください。"must wrap any JavaScript interop calls in conditional logic" です。この言い回しは重要で、本記事の後半で扱う落とし穴につながります。

## プリレンダリングには呼び出す相手のブラウザーが存在しない

プリレンダリングとは、HTML をできるだけ早くブラウザーに届けるために、ページの内容をサーバー上で静的にレンダリングする処理です。コンポーネントツリーは最後まで実行され、マークアップを生成し、HTTP レスポンスに書き出されて破棄されます。その後になって初めて Blazor スクリプトがブラウザーで起動し、circuit を開く (`InteractiveServer` の場合) か、ランタイムをダウンロードして (`InteractiveWebAssembly` の場合)、コンポーネントを対話的に作り直します。

この最初のパスの間、DOM も `window` も、JS interop のメッセージを送るトランスポートも存在しません。サービスは登録されておりコンポーネントも問題なくコンパイルされるので `IJSRuntime` は注入できますが、その背後の実装はクライアントプロキシを持たないか、有用なメッセージを投げることだけが仕事のプレースホルダーです。これが実行時エラーであり、コンパイル時エラーには決してならない理由です。

ライフサイクルのドキュメントは、その帰結をはっきり書いています。`OnAfterRender` と `OnAfterRenderAsync` は "aren't invoked during prerendering or static server-side rendering (static SSR) on the server because those processes aren't attached to a live browser DOM and are already complete before the DOM is updated" です。まさにこの性質が、`OnAfterRenderAsync` を interop の安全な置き場所にしています。

なお、プリレンダリングされるコンポーネントでは `OnInitializedAsync` が 2 回実行されます。静的パスで 1 回、コンポーネントが対話的になったときにもう 1 回です。そこで取得したものはすべて 2 回計算されます。これは別の問題であり解決策も別で、[.NET 11 で Blazor の静的から対話的へのレンダリング境界をまたいで状態を保持する方法](/ja/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/)で扱っています。

## 最小限の再現

.NET 11 のテンプレートで作成した Blazor Web App に、グローバルまたはページ単位の対話的な render mode を設定した状態で、次のコードを置いてください。最初のリクエストで必ず失敗します。

```razor
@* Theme.razor *@
@* .NET 11, Microsoft.AspNetCore.Components 11.0.0, Blazor Web App *@
@page "/theme"
@rendermode InteractiveServer
@inject IJSRuntime JS

<p>Stored theme: @theme</p>

@code {
    private string? theme;

    protected override async Task OnInitializedAsync()
    {
        // Throws during the prerender pass: no browser, no localStorage.
        theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
    }
}
```

同じコードを `@rendermode InteractiveWebAssembly` にすると、代わりに `UnsupportedJavaScriptRuntime` の側が投げられます。プリレンダリングパスが circuit ではなくサーバー上のエンドポイントレンダラーで起きるためです。`@rendermode` の行をまるごと削除した場合も `UnsupportedJavaScriptRuntime` の側になり、しかも恒久的にそうなります。ページが静的 SSR になり、対話的になることが二度とないからです。

## 対処 1: 呼び出しを `OnAfterRenderAsync` に移す

これが推奨される対処であり、フレームワーク自身のエラーメッセージが指し示している方法でもあります。`OnAfterRenderAsync` は、コンポーネントが生きた DOM を伴って対話的にレンダリングされた後にのみ呼ばれるため、そこでの interop は常に合法です。

```razor
@* Theme.razor *@
@* .NET 11, Microsoft.AspNetCore.Components 11.0.0 *@
@page "/theme"
@rendermode InteractiveServer
@inject IJSRuntime JS

<p>Stored theme: @(theme ?? "loading...")</p>

@code {
    private string? theme;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
            StateHasChanged();
        }
    }
}
```

つまずきやすい点が 2 つあります。

`if (firstRender)` のガードは任意の作法ではありません。これがないと毎回のレンダリングで interop が再実行され、`StateHasChanged` がレンダリングを誘発するため、無限ループになります。

明示的な `StateHasChanged()` は必須です。他のライフサイクルメソッドと異なり、フレームワークは `OnAfterRenderAsync` が返す `Task` の完了時に再レンダリングをあえてスケジュールしません。まさにその無限ループを避けるためです。フィールドに値を入れただけで `StateHasChanged` を呼ばないと UI は永遠に更新されず、バグは「interop が null を返す」ように見えます。

JavaScript の結果がなくてもプリレンダリング出力が意味を成すようにマークアップを設計してください。ユーザーはその最初のパスを目にします。プレースホルダー、スケルトン、あるいは妥当な既定値のほうが、一瞬後に突然現れる空要素よりずっと良いです。

## 対処 2: `RendererInfo.IsInteractive` で分岐する

最初の対話的レンダリングより早く分岐したい場合もあります。たとえば「何を取得するか」ではなく「何をレンダリングするか」を決めるときです。`ComponentBase.RendererInfo` (.NET 9 以降) がまさにそれを公開しています。

- `RendererInfo.Name` は `Static`、`Server`、`WebAssembly`、`WebView` のいずれかを返します。
- `RendererInfo.IsInteractive` は対話的レンダリング時に `true`、プリレンダリング中または静的 SSR では `false` です。
- `ComponentBase.AssignedRenderMode` はコンポーネントに割り当てられた render mode を返し、割り当てがなければ `null` を返します。

```razor
@* ThemeAware.razor *@
@* .NET 11 / .NET 10 / .NET 9. RendererInfo requires aspnetcore 9.0+ *@
@page "/theme-aware"
@rendermode InteractiveServer
@inject IJSRuntime JS

@if (!RendererInfo.IsInteractive)
{
    <p>Loading preferences...</p>
}
else
{
    <p>Stored theme: @theme</p>
}

@code {
    private string? theme;

    protected override async Task OnInitializedAsync()
    {
        if (RendererInfo.IsInteractive)
        {
            theme = await JS.InvokeAsync<string>("localStorage.getItem", "theme");
        }
    }
}
```

これが `UnsupportedJavaScriptRuntime` のメッセージが求めている "conditional logic" です。使い物になる静的マークアップをレンダリングしなければならないコンポーネント、たとえば `AssignedRenderMode is null` のときは通常のフォーム送信を行い、そうでないときはイベントハンドラーを使うフォームにも適した道具です。

`RendererInfo` が存在しない .NET 8 では、プリレンダリングパスを検出する最も近い方法は、コンポーネントに `[CascadingParameter] public HttpContext? HttpContext { get; set; }` を置くことです。これはサーバー側レンダリング中にのみ null 以外になります。動作はしますが、コンポーネントを ASP.NET Core のホスティング型に結び付けてしまうので、.NET 9 以降を対象にできるなら `RendererInfo` を選んでください。

## 対処 3: そのコンポーネントのプリレンダリングを無効にする

JavaScript なしでは意味を成さないコンポーネント (グラフのラッパー、地図、リッチテキストエディターなど) では、プリレンダリングは壊れたマークアップが一瞬見えるだけの結果に終わります。コンポーネント定義側で無効にしてください。

```razor
@* MapView.razor *@
@* .NET 11. prerender: false is valid on all three interactive render modes *@
@rendermode @(new InteractiveServerRenderMode(prerender: false))
```

あるいは使用箇所で指定します。

```razor
@* .NET 11 *@
<MapView @rendermode="new InteractiveWebAssemblyRenderMode(prerender: false)" />
```

アプリ全体で無効にするには、`App.razor` の `Routes` コンポーネントにモードを設定し、`HeadOutlet` にも同じことを忘れずに行います。

```razor
@* App.razor, .NET 11 Blazor Web App template *@
<Routes @rendermode="new InteractiveServerRenderMode(prerender: false)" />
<HeadOutlet @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

見落としがちなルールが 1 つあります。プリレンダリングの無効化はトップレベルの render mode にしか効きません。親コンポーネントがすでに render mode を指定している場合、その子のプリレンダリング設定は無視されます。これは [解決: その render mode は親コンポーネントの render mode でサポートされていません](/ja/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/) の背後にある「1 つのサブツリーに 1 つの render mode」という制約と同じものです。`prerender: false` に手を伸ばすのは自分が境界を所有しているときだけにして、最後の手段として扱ってください。プリレンダリングが存在する理由である高速な初回描画と SEO の利点を手放すことになります。

## 落とし穴: 静的 SSR のページでは `OnAfterRenderAsync` が一度も実行されない

「`OnAfterRenderAsync` に移したのにまだ動かない」という声の、いちばん多い原因がこれです。

`OnAfterRender{Async}` はプリレンダリング中に呼ばれないだけでなく、静的 SSR 中にも呼ばれません。プリレンダリングされる対話的コンポーネントならそれで構いません。一瞬後にコンポーネントが対話的に作り直され、そのときメソッドが発火するからです。しかし render mode を**持たない**ページでは、コンポーネントは静的にしかレンダリングされません。2 回目のパスは存在しません。`OnAfterRenderAsync` は一度も呼ばれず、interop は静かに実行されないままで、症状は騒がしい例外から沈黙した機能不全へと変わります。

interop が例外を投げなくなったが同時に動作もしなくなった場合は、そのコンポーネントが本当に対話的な render mode を持っているか確認してください。直接指定、親からの継承、`Routes` でのグローバル適用のいずれでも構いません。コンポーネント内の `AssignedRenderMode is null` は、静的 SSR にいることを 1 行で確認できる方法です。どのホスティングモデルを割り当てるべきかは別の判断であり、[.NET 11 における Blazor Server vs Blazor WebAssembly vs Blazor United](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) で整理しています。

## 3 つ目のバリエーション: "the circuit has disconnected and is being disposed"

同じ書き出しで始まる 3 つ目のメッセージがありますが、これは別のバグで対処も異なります。

```text
Microsoft.JSInterop.JSDisconnectedException: JavaScript interop calls cannot be issued
at this time. This is because the circuit has disconnected and is being disposed.
```

例外の型に注目してください。`InvalidOperationException` ではなく `JSDisconnectedException` です。これはプリレンダリングとは無関係です。コンポーネントの寿命の反対側、サーバー側アプリで、SignalR circuit が失われた後に JS を呼び出したり `IJSObjectReference` を破棄したりしたときに起こります。典型的には、ユーザーが別ページへ移動したりリロードしたりしている最中の `DisposeAsync` からです。対処はこの例外を捕捉することです。

```csharp
// .NET 11, server-side Blazor. Disposing a JS module after the circuit is gone.
async ValueTask IAsyncDisposable.DisposeAsync()
{
    try
    {
        if (module is not null)
        {
            await module.DisposeAsync();
        }
    }
    catch (JSDisconnectedException)
    {
    }
}
```

WebAssembly のコンポーネントでは失われる circuit がないので、`try`/`catch` を外してモジュールを破棄するだけで構いません。また、接続が失われた後にブラウザー側で本当のクリーンアップを行いたい場合、JS interop は適切な道具ではありません。クライアント側で `MutationObserver` パターンかカスタム要素の `disconnectedCallback` を使ってください。

## 同じ例外を引き起こす落とし穴

**サードパーティのコンポーネントライブラリ。** MudBlazor や Radzen などのライブラリは、ビューポートの計測、ポップオーバーの配置、ブラウザー機能の判定のために内部で interop を呼びます。例外のスタックトレースが自分のコードではなくライブラリの型で終わっている場合、対処はたいていライブラリ側のスイッチか、そのコンポーネントを載せているページのプリレンダリングを無効にすることです。まずライブラリのリリースノートを確認してください。多くは .NET 8 以降にプリレンダリング用のガードを追加しています。

**JS を呼び出す注入サービス。** `localStorage` をラップする scoped サービスは、最初に呼び出した場所で例外を投げます。それは多くの場合 `OnInitializedAsync` です。サービス側でこれを肩代わりして直すことはできません。移動または条件付けが必要なのは呼び出し側です。一部のライブラリ (Blazored.LocalStorage など) が「最初のレンダリング後にのみストレージへ触れること」と案内しているのは、まさにこの理由からです。

**WebAssembly での `IJSInProcessRuntime`。** 同期 interop がクライアント側コンポーネントで使えるのは、WebAssembly ランタイムが動き始めた後だけです。`InteractiveWebAssembly` コンポーネントのサーバー側プリレンダリングパス中は、`IJSRuntime` を `IJSInProcessRuntime` にキャストしても失敗するか、呼び出しが例外を投げます。コードが本当に WebAssembly 上で実行されているかを知りたいときは `OperatingSystem.IsBrowser()` を使ってください。

**対話的ルーティングはプリレンダリングを飛ばす。** `Routes` コンポーネントが対話的なアプリで、内部の拡張ナビゲーションによってそのページに到達した場合、プリレンダリングはそもそも発生しません。したがってバグはフルページロードでしか再現しません。リンクをクリックしたときは動くのに F5 を押すと失敗するコンポーネントは、ほぼ確実にこれです。

**初期化での長時間処理。** プリレンダリングは quiescence を待つため、遅い `OnInitializedAsync` はプリレンダリング応答全体をブロックします。これは今回の例外ではありませんが、ストリーミングレンダリングが解決するために存在する隣接した問題であり、同じコンポーネントで一緒に顔を出しがちです。

## 関連記事

- [.NET 11 で Blazor の静的から対話的へのレンダリング境界をまたいで状態を保持する方法](/ja/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/)：プリレンダリング境界のもう半分である二重初期化を解決します。
- [解決: その render mode は親コンポーネントの render mode でサポートされていません (Blazor)](/ja/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/)：`prerender: false` が効く範囲を制限する「1 つのサブツリーに 1 つの render mode」のルールを説明します。
- [.NET 11 における Blazor Server vs Blazor WebAssembly vs Blazor United](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)：そもそもどの render mode を割り当てるべきかを扱います。
- [.NET 11 で Blazor Server アプリを Blazor United (Blazor Web App) に移行する](/ja/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/)：render mode がまったくなかったアプリに render mode を導入する手順です。
- [サーバーと Blazor WebAssembly でバリデーションロジックを共有する方法](/ja/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/)：境界の両側で動かす必要があるロジックのためのパターンです。

## 参考資料

- [Prerender ASP.NET Core Razor components](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/prerender) (Microsoft Learn、.NET 10/11)
- [ASP.NET Core Razor component lifecycle](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/lifecycle) (Microsoft Learn)
- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes) (Microsoft Learn) の "Detect rendering location, interactivity, and assigned render mode at runtime"
- [ASP.NET Core Blazor JavaScript interoperability (JS interop)](https://learn.microsoft.com/en-us/aspnet/core/blazor/javascript-interoperability/) (Microsoft Learn) の "JavaScript interop calls without a circuit"
- `dotnet/aspnetcore` の [`RemoteJSRuntime.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Server/src/Circuits/RemoteJSRuntime.cs) と [`UnsupportedJavaScriptRuntime.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Endpoints/src/DependencyInjection/UnsupportedJavaScriptRuntime.cs)。2 つのメッセージが投げられる場所です
- [dotnet/aspnetcore #24320](https://github.com/dotnet/aspnetcore/issues/24320)。このエラーを追跡している長期の issue です
