---
title: "Blazor のレンダーモードとは何か、どれが自分のコンポーネントを実行しているのか"
description: "レンダーモードは Razor コンポーネントがどこで実行され、インタラクティブになるかどうかを決めます。.NET 11 の 4 つのモード、コンポーネントが何を継承するかを決める伝播ルール、そして実行時にどのモードが適用されたかを教えてくれる RendererInfo と AssignedRenderMode を解説します。"
pubDate: 2026-09-05
tags:
  - "blazor"
  - "aspnetcore"
  - "dotnet-11"
  - "csharp"
lang: "ja"
translationOf: "2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component"
translatedBy: "claude"
translationDate: 2026-09-05
---

レンダーモードとは、Blazor Web App においてコンポーネント単位で設定される項目で、2 つのことを決めます。コンポーネントがどこで実行されるか (サーバーかブラウザーか)、そして UI イベントに応答できるかどうかです。モードは 4 つあります。Static Server、Interactive Server、Interactive WebAssembly、Interactive Auto です。割り当ては `@rendermode` ディレクティブまたはディレクティブ属性で行い、既定値は Static Server で、モードはコンポーネントツリーを下に伝播するため、大半のコンポーネントは何も宣言しません。あるコンポーネントを実際に実行しているモードを知るには、コンポーネント内部から `ComponentBase.AssignedRenderMode` と `ComponentBase.RendererInfo` を読みます。静的 SSR では `AssignedRenderMode` は `null` になり、割り当てられたモードがインタラクティブなコンポーネントであっても、プリレンダリング中は `RendererInfo.IsInteractive` が `false` になります。

ここでの内容はすべて .NET 11 と ASP.NET Core 11、C# 14 を対象としています。レンダーモードが存在するのは Blazor Web App (.NET 8 で導入された統合テンプレート) だけです。スタンドアロンの Blazor WebAssembly アプリや従来の Blazor Server アプリは、アプリ全体で 1 つのホスティングモデルを持ち、`@rendermode` ディレクティブ自体がありません。.NET 10 や .NET 11 で挙動が変わった箇所は明示します。

## 4 つのモードと、それらが変化する 2 つの軸

| モード | 実行場所 | インタラクティブ | `.Client` プロジェクトが必要 |
| --- | --- | --- | --- |
| Static Server | サーバー | いいえ | いいえ |
| Interactive Server | サーバー、SignalR 回線経由 | はい | いいえ |
| Interactive WebAssembly | ブラウザー | はい | はい |
| Interactive Auto | 最初はサーバー、以降の訪問ではブラウザー | はい | はい |

Static Server は通常は静的 SSR と表記され、コンポーネントを HTTP レスポンスストリームにレンダリングして終わります。回線もなく、ブラウザーに .NET ランタイムもなく、イベント処理もありません。静的にレンダリングされたボタンの `@onclick` は問題なくコンパイルされ、実行時には何もしません。これが既定値であり、コンテンツページにとっては正しい既定値です。開いたままにする接続も、ダウンロードする WebAssembly のペイロードもありません。

Interactive Server はコンポーネントをサーバー上で生かし続け、DOM イベントと差分を SignalR 接続経由でやり取りします。Interactive WebAssembly は .NET ランタイムとアプリのバンドルをダウンロードし、ブラウザー内でコンポーネントを実行します。Interactive Auto は 3 つ目のランタイムではありません。初回訪問では WebAssembly バンドルをバックグラウンドでダウンロードしながら Interactive Server でレンダリングし、バンドルがキャッシュされた以降の訪問では WebAssembly を使います。

Auto の性質のひとつが多くの人を驚かせます。[レンダーモードのドキュメント](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes)によれば、Auto はすでにページ上にあるコンポーネントのレンダーモードを決して切り替えません。コンポーネントが最初にレンダリングされた時点で 1 度だけ判断し、そのコンポーネントがページ上にある間はそのモードを保ちます。さらに Auto は、すでにページ上にあるインタラクティブなコンポーネントのモードに合わせることを優先します。ページの途中で、既存のランタイムと状態を共有しない 2 つ目の .NET ランタイムが持ち込まれるのを避けるためです。デバッグではなくホスティングモデルの選択で迷っている段階なら、詳しい解説は [.NET 11 における Blazor Server vs WebAssembly vs Blazor United](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) にあります。

インタラクティブなモードには、対応するサービスとエンドポイントが `Program.cs` に登録されている必要があります。そうでなければ `@rendermode` は何の意味も持ちません。

```csharp
// .NET 11, C# 14 -- Program.cs of a Blazor Web App
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddInteractiveWebAssemblyComponents();

// ...

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .AddInteractiveWebAssemblyRenderMode();
```

## レンダーモードを設定できる 3 か所

コンポーネントに届くモードは 3 つの異なる構文上の位置から来る可能性があり、それらは交換可能ではありません。

**コンポーネントのインスタンスに対して**、ディレクティブ属性として、コンポーネントを使う場所で指定します。

```razor
@* .NET 11 -- any render mode instance is allowed here *@
<Dialog @rendermode="InteractiveServer" />
```

**コンポーネントの定義に対して**、`.razor` ファイルの先頭のディレクティブとして指定します。ルーティング対象のページではこちらを使います。ページを手動でインスタンス化するものは存在しないからです。

```razor
@* .NET 11 -- Pages/Counter.razor *@
@page "/counter"
@rendermode InteractiveServer
```

`@rendermode` は Razor のディレクティブであると同時に Razor のディレクティブ属性でもあり、その違いが効いてくるのはちょうど 1 点だけです。ディレクティブ形式は静的なレンダーモードのインスタンスを要求しますが、ディレクティブ属性形式はオプション付きで構築したものを含め、任意のインスタンスを受け付けます。

**アプリ全体に対して**は、`App.razor` 内の `Routes` コンポーネントにモードを付けます。ルーターは自身のモードを、ルーティングするすべてのページに伝播します。

```razor
@* .NET 11 -- Components/App.razor *@
<Routes @rendermode="InteractiveServer" />
<HeadOutlet @rendermode="InteractiveServer" />
```

ルートコンポーネントである `App` 自体にモードを設定することはサポートされていません。だからこそ、グローバルなインタラクティビティは先頭の 1 つのディレクティブではなく `Routes` と `HeadOutlet` で表現されます。従来のアプリをこのモデルへ移す場合の手順は [.NET 11 で Blazor Server アプリを Blazor Web App へ移行する](/ja/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) にあります。

モードを計算で求めることもできます。これは、それ以外はインタラクティブなアプリの中から静的 SSR のページを切り出すやり方です。

```razor
@* .NET 11 -- Components/App.razor *@
<Routes @rendermode="PageRenderMode" />

@code {
    private IComponentRenderMode? PageRenderMode => InteractiveServer;
}
```

## コンポーネントが何を受け取るかを決める伝播ルール

実際のアプリにあるコンポーネントの大半は `@rendermode` を一切持ちません。継承するからです。ルールは 4 つで、いずれも短いものです。

1. 既定のレンダーモードは Static です。
2. `@rendermode` を持たないコンポーネントは親のモードを受け取ります。
3. 子で別のインタラクティブモードに切り替えることはできません。Interactive Server のコンポーネントは Interactive WebAssembly の子を保持できません。
4. 静的な親からインタラクティブな子へ渡すパラメーターは JSON シリアライズ可能でなければなりません。

ルール 2 は、あるページでは動き別のページでは無反応になる共有コンポーネントの原因が、そのコンポーネント自身であることがまずない理由です。次のコンポーネントをモード指定のないページに置くと、ボタンは何もしません。

```razor
@* .NET 11 -- Components/SharedMessage.razor, render-mode agnostic *@
<button @onclick="UpdateMessage">Click me</button> @message

@code {
    private string message = "Not updated yet.";

    private void UpdateMessage() => message = "Somebody updated me!";
}
```

同じコンポーネントを `@rendermode InteractiveServer` の下に置けば動きます。コンポーネント側は何も変わっていません。「ボタンが何もしない」ときの正しい勘は、ハンドラーではなくツリーの上を見ることです。

ルール 3 は沈黙ではなく実行時エラーを生みます。Interactive Server に固定されたページに WebAssembly の子があると、`Cannot create a component of type '...' because its render mode 'Microsoft.AspNetCore.Components.Web.InteractiveWebAssemblyRenderMode' is not supported by Interactive Server rendering.` で失敗します。静的なページ上で異なるインタラクティブモードの兄弟コンポーネントを並べるのは問題ありませんが、一方をもう一方の中に入れ子にするのは不可です。

ルール 4 が最も紛らわしいメッセージを生みます。静的からインタラクティブへの境界を越えて子コンテンツを渡すと、次の例外がスローされます。

> System.InvalidOperationException: Cannot pass the parameter 'ChildContent' to component 'SharedMessage' with rendermode 'InteractiveServerRenderMode'. This is because the parameter is of the delegate type 'Microsoft.AspNetCore.Components.RenderFragment', which is arbitrary code and cannot be serialized.

静的な親を持つインタラクティブな子は、それ自身のレンダラーにとってのルートコンポーネントであり、そのパラメーターはプロセス (あるいはネットワーク) の境界を JSON として越えなければなりません。`RenderFragment` はデリゲートであり、デリゲートはシリアライズできません。従来の対処は境界を上へずらすことです。子をレンダーフラグメントを取らないコンポーネントで包み、その包み側に `@rendermode` を付けます。

```razor
@* .NET 11 -- Components/WrapperComponent.razor *@
<SharedMessage>
    Child content
</SharedMessage>
```

```razor
@* .NET 11 -- the page *@
@page "/render-mode-10"

<WrapperComponent @rendermode="InteractiveServer" />
```

テンプレートが `Router` に直接 `@rendermode` を付けず、`Router` を包む `Routes.razor` を同梱しているのは、まさにこのためです。

## .NET 11 での変更: インタラクティブなレイアウトがついに動く

ルール 4 にはよく知られた犠牲者がいました。`LayoutComponentBase` は `@Body` を `RenderFragment` として公開するため、ページ単位のインタラクティビティを採用したアプリで `MainLayout` に `@rendermode InteractiveServer` を付けると、パラメーター名を `'Body'` として同じシリアライズエラーがスローされていました。過去 3 つのメジャーバージョンにわたる回避策はどれも、「代わりにラッパーか Blazor のセクションにインタラクティビティを置く」という形でした。

.NET 11 でこの制限はなくなります。Microsoft のドキュメントは現在、「Statically-rendered layout components」の制限全体をバージョン `>= 8.0 < 11.0` に限定し、それが "prior to the release of .NET 11" に適用されると述べています。土台となる作業は [dotnet/aspnetcore#52768](https://github.com/dotnet/aspnetcore/issues/52768) で、.NET 11 Preview 5 で出荷されました。レンダーモードを持つコンポーネントが `RenderFragment` パラメーターを受け取ると、フレームワークは静的側でそのフラグメントを実行し、得られたレンダーツリーを JSON としてシリアライズし、インタラクティブ側で `RenderFragment` デリゲートとして復元します。これを健全に保つため、コンパイラーはそのようにラップされる関数を静的ローカル関数であることを要求します。移送に耐えないサーバー側の状態をキャプチャできないようにするためです。

実際的な効果として、.NET 11 では次のように書けます。

```razor
@* .NET 11 only -- Components/Layout/MainLayout.razor *@
@inherits LayoutComponentBase
@rendermode InteractiveServer

<div class="page">
    <NavMenu />
    <main>@Body</main>
</div>
```

これでセクションベースのラッパーという回りくどい手順なしにインタラクティブなナビゲーションバーが得られます。.NET 10 以前では同じファイルが実行時にスローします。この点は結論が反転したので、インターネットからレイアウトのスニペットをコピーする前に対象フレームワークを確認してください。

## 今このコンポーネントを実行しているモードはどれか

`ComponentBase` はこのために 2 つのプロパティを公開しており、いずれも .NET 9 以降で利用できます。どちらも DI を必要としません。

`AssignedRenderMode` はコンポーネントに割り当てられたモードを返します。`InteractiveServerRenderMode`、`InteractiveWebAssemblyRenderMode`、`InteractiveAutoRenderMode` のいずれかのインスタンス、またはコンポーネントが静的 SSR で動いている場合は `null` です。

`RendererInfo` は実際にコンポーネントを実行しているレンダラーを表します。`RendererInfo.Name` は `Static`、`Server`、`WebAssembly`、`WebView` のいずれかです。`RendererInfo.IsInteractive` はコンポーネントが本当にインタラクティブなときだけ `true` で、静的 SSR のときも、インタラクティブなコンポーネントのプリレンダリングのパスの間も `false` です。

この最後の区別が役に立ちます。`@rendermode InteractiveServer` を持つコンポーネントは 2 回レンダリングされます。1 回目はプリレンダリングで、`AssignedRenderMode` は `InteractiveServerRenderMode` のインスタンスですが `RendererInfo.IsInteractive` は `false` です。2 回目は回線経由で、両者が一致します。したがって次のようになります。

- 「このコンポーネントはいずれインタラクティブになるのか」を問うには `AssignedRenderMode is null` を使います。これはマークアップの形についての判断です。
- 「今この瞬間にイベントを処理できるのか」を問うには `RendererInfo.IsInteractive` を使います。これは現在のパスについての判断です。

サブツリーが何を継承したかを見るために、ツリーのどこにでも置ける診断用コンポーネントです。

```razor
@* .NET 11 -- Components/RenderModeProbe.razor *@
<dl>
    <dt>AssignedRenderMode</dt>
    <dd>@(AssignedRenderMode?.GetType().Name ?? "null (static SSR)")</dd>
    <dt>RendererInfo.Name</dt>
    <dd>@RendererInfo.Name</dd>
    <dt>RendererInfo.IsInteractive</dt>
    <dd>@RendererInfo.IsInteractive</dd>
</dl>
```

このプローブ自身はモードを宣言していないため継承し、ホストしているページが下に渡したものをそのまま報告します。ツリーを上にたどって `@rendermode` ディレクティブを読むより速く答えが出ます。モードをプログラムで割り当てているアプリでは特にそうです。

`AssignedRenderMode` のドキュメント化された用途は、優雅な劣化です。コンポーネントが静的なときは本物の HTML の `form` をレンダリングし、そうでないときはバインドされた入力とイベントハンドラーをレンダリングします。

```razor
@* .NET 11 *@
@if (AssignedRenderMode is null)
{
    <form action="/movies">
        <input type="text" name="titleFilter" />
        <input type="submit" value="Search" />
    </form>
}
else
{
    <input @bind="titleFilter" />
    <button @onclick="FilterMovies">Search</button>
}
```

そして `IsInteractive` のドキュメント化された用途は、プリレンダリングのパスでは黙って何もしないコントロールを抑止することです。

```razor
@* .NET 11 *@
<button @onclick="Send" disabled="@(!RendererInfo.IsInteractive)">
    Send
</button>
```

## プリレンダリングと、初期化処理が 2 回走る理由

プリレンダリングは 3 つのインタラクティブモードすべてで既定で有効です。サーバーが最初の HTML レスポンスにコンポーネントを静的にレンダリングし、その後インタラクティブなレンダラーが引き継いでもう一度レンダリングします。そのため `OnInitializedAsync` はレンダラーごとに 1 回、合計 2 回実行されます。これが「API が 2 回呼ばれる」「UI がローディング状態に戻ってちらつく」という訴えの実際の原因です。

`OnAfterRender` と `OnAfterRenderAsync` は例外で、プリレンダリング中はまったく呼ばれません。`OnInitializedAsync` からの JS 相互運用がスローするのも同じ理由で、呼び出す先のブラウザーがまだ存在しないからです。詳しくは [JavaScript interop calls cannot be issued at this time](/ja/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) を参照してください。

対応は 2 つあります。ひとつはコンポーネントのプリレンダリングを無効にすることです。

```razor
@* .NET 11 -- component definition form *@
@rendermode @(new InteractiveServerRenderMode(prerender: false))
```

```razor
@* .NET 11 -- component instance form *@
<Dialog @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

もうひとつは、ユーザーに見えるものについてはこちらの方が良い方法で、プリレンダリングを残したまま `[PersistentState]` 属性で状態を境界の向こうへ運ぶことです (旧名は `[SupplyParameterFromPersistentComponentState]`。`PersistentStateAttribute` が .NET 10 以降の API です)。

```csharp
// .NET 11, C# 14
[PersistentState]
public int? CurrentCount { get; set; }
```

`RestoreBehavior` や `AllowUpdates` を含む完全な解説は [.NET 11 で Blazor の静的からインタラクティブへのレンダー境界をまたいで状態を保持する方法](/ja/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) にあります。

無効化の側にひとつ罠があります。`prerender: false` が効くのは最上位のレンダーモードだけです。親コンポーネントがすでにモードを宣言している場合、その子のプリレンダリング設定は完全に無視されます。入れ子のコンポーネントに設定してもプリレンダリングが続くのはバグではありません。

## 静的 SSR で失われるのはインタラクティビティだけではない

静的 SSR ではリクエストは ASP.NET Core のミドルウェアパイプラインが処理し、その処理の間 Razor コンポーネントはレンダリングされません。したがって Blazor 自身のルーター機能は関与しません。.NET 10 と .NET 11 では、静的にレンダリングされたページで `AuthorizeRouteView` の `<NotAuthorized>` コンテンツは表示されません。認可されないリクエストは代わりに認可ミドルウェアが、通常はカスタムの `IAuthorizationMiddlewareResultHandler` を通じて処理します。.NET 10 より前は `<NotFound>` コンテンツにも同じ問題がありました。ルートレベルでインタラクティブなアプリはこれに当たりません。最初の静的レンダリングの後はミドルウェアパイプラインが関与しなくなるからです。

.NET 11 はレンダーモードに隣接する、知っておく価値のあるツールも追加しています。`CacheView` コンポーネントは静的 SSR 中にコンポーネントのサブツリーのレンダリング結果をキャッシュし、ヒット時には子コンポーネントをインスタンス化することも、そのライフサイクルメソッドを実行することもなくマークアップを再生します。

```razor
@* .NET 11 *@
<CacheView VaryByQuery="category" ExpiresAfter="TimeSpan.FromMinutes(5)">
    <ProductList Category="@Category" />
</CacheView>
```

これは静的 SSR にのみ適用されます。習慣でアプリ全体をインタラクティブにするのではなく、コンテンツページを既定のモードのまま残しておくべき理由がもうひとつ増えたわけです。

## 短くまとめると

レンダーモードとは、コンポーネントがどこで動き、イベントを処理できるかどうかです。インスタンスに、定義に、あるいはアプリ全体なら `Routes` に割り当てます。ディレクティブのないものはすべて親から継承し、既定は静的です。反応しないボタンはツリーの上を見るべきサインです。シリアライズ例外は `RenderFragment` が静的からインタラクティブへの境界を越えたサインで、.NET 10 以前ではインタラクティブなレイアウトすべてがこれに該当し、.NET 11 では該当しなくなりました。API の二重呼び出しはプリレンダリングのサインで、修正は `prerender: false` よりも `[PersistentState]` である場合の方がはるかに多いです。推測ではなく事実が必要なときは、割り当てについては `AssignedRenderMode` を、現在のパスについては `RendererInfo.IsInteractive` を読み、プリレンダリング中に両者が食い違うのは意図的だということを覚えておいてください。

## 関連記事

- [.NET 11 における Blazor Server vs Blazor WebAssembly vs Blazor United](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [.NET 11 で Blazor Server アプリを Blazor United (Blazor Web App) へ移行する](/ja/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/)
- [.NET 11 で Blazor の静的からインタラクティブへのレンダー境界をまたいで状態を保持する方法](/ja/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/)
- [Fix: JavaScript interop calls cannot be issued at this time (Blazor のプリレンダリング)](/ja/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)
- [Fix: Blazor Server の回線が切断された後の Attempting to reconnect to the server](/ja/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/)

## 参照元

- [ASP.NET Core Blazor render modes -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes?view=aspnetcore-11.0)
- [Prerender ASP.NET Core Razor components -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/prerender?view=aspnetcore-11.0)
- [ASP.NET Core Blazor layouts -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/layouts?view=aspnetcore-11.0)
- [Persist state across prerendering -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/prerendered-state-persistence?view=aspnetcore-11.0)
- [What's new in ASP.NET Core in .NET 11 -- Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11)
- [Support serializing RenderFragment parameters -- dotnet/aspnetcore #52768](https://github.com/dotnet/aspnetcore/issues/52768)
- [ComponentBase.AssignedRenderMode Property -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.componentbase.assignedrendermode)
- [RendererInfo Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.rendererinfo)
