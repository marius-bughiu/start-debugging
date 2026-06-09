---
title: "解決: その render mode は親コンポーネントの render mode でサポートされていません (Blazor)"
description: "親がすでに対話的な子に @rendermode を付けました。サブツリーには render mode がちょうど 1 つです。子のディレクティブを削除するか、境界へ移動してください。"
pubDate: 2026-06-09
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
lang: "ja"
translationOf: "2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor"
translatedBy: "claude"
translationDate: 2026-06-09
---

解決方法: すでに対話的な render mode を持つサブツリーの内側にある子コンポーネントに `@rendermode` を適用し、2 つのモードが一致していません。Blazor のサブツリーは、その対話的な境界で固定された render mode をちょうど 1 つだけ持ちます。ツリーの途中で `InteractiveServer` から `InteractiveWebAssembly` へ (またはその逆へ) 切り替えることはできません。子から `@rendermode` ディレクティブを削除して親のモードを継承させるか、render mode を対話的な境界を所有する唯一のコンポーネントへ引き上げてください。モードが実際には同じである場合、本当の問題は入れ子のコンポーネントにある重複した `@rendermode` であり、内側のものを削除すべきです。

```text
System.InvalidOperationException: Cannot create a component of type
'BlazorSample.Components.SharedMessage' because its render mode
'Microsoft.AspNetCore.Components.Web.InteractiveWebAssemblyRenderMode'
is not supported by Interactive Server rendering.
   at Microsoft.AspNetCore.Components.Rendering.ComponentState..ctor(...)
   at Microsoft.AspNetCore.Components.RenderTree.Renderer.AddToRenderQueue(...)
   at Microsoft.AspNetCore.Components.Endpoints.EndpointHtmlRenderer...
```

このガイドは .NET 11 (ASP.NET Core 11、`Microsoft.AspNetCore.Components` 11.0.0) を対象に書かれていますが、ルールは render modes が .NET 8 で登場して以来まったく同じです。メッセージのテキストは、どの組み合わせに当たるかによって変わるため、検索トラフィックはいくつかの言い回しでここに到達します: "its render mode is not supported by Interactive Server rendering"、"render mode is not supported by the parent component's render mode"、そして密接に関連する "Cannot pass the parameter X to component Y with rendermode InteractiveServerRenderMode" です。3 つとも同じ根本的な制約から生じており、最後のものには別の解決策があります。これは後述します。

## 1 つのサブツリー、1 つの render mode

Blazor Web App では、対話性はどこにでも振りまけるコンポーネントごとのスイッチではありません。コンポーネントが `@rendermode InteractiveServer` または `@rendermode InteractiveWebAssembly` を宣言すると、対話的な*境界*を作ります。その境界の内側でレンダリングされるすべて (すべての子、孫、そしてそれらがレンダリングするコンテンツ) が、その 1 つの render mode の下で実行されます。境界は対話的な*アイランド*のルートであり、アイランドはホスティングモデルを 1 つだけ持ちます: サーバー上の SignalR サーキットか、ブラウザ内の WebAssembly ランタイムのいずれかです。アイランドの半分をサーバーで、半分をブラウザで実行する仕組みはありません。両者は生きたコンポーネント状態ツリーと単一のディスパッチャーを共有するからです。

だからこそ、公式ドキュメントのルールは絶対的なものとして述べられています。[Blazor render modes のドキュメント](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes)より:

- render modes はコンポーネント階層を下へ伝播します。
- 既定の render mode は Static です。
- 子コンポーネントで別の対話的な render mode に切り替えることはできません。たとえば、Server コンポーネントは WebAssembly コンポーネントの子になれません。

そのため、レンダラーがツリーをたどって子コンポーネントに到達し、すでに属しているアイランドと衝突する `@rendermode` を見つけると、それを尊重できません。黙って 1 つを選ぶのではなく、例外をスローします。例外は、フレームワークが問題のある子のコンポーネント状態を作成しようとするときに構築されるため、スタックトレースはあなたのコードではなく `ComponentState` とレンダラーを指します。

役立つメンタルモデル: `@rendermode` は「このアイランドはどこで始まり、何がホストするのか?」という問いに答えます。それはすべてのコンポーネントの属性ではありません。ほとんどのコンポーネントは render mode をまったく持たず、着地したアイランドを単に継承すべきです。

## 最小の再現

ページがサーバー上で対話的であり、WebAssembly を要求するコンポーネントを入れ子にします:

```razor
@* RenderMode11.razor -- .NET 11, ASP.NET Core 11 -- throws at render time *@
@page "/render-mode-11"
@rendermode InteractiveServer

<h1>Dashboard</h1>

<SharedMessage @rendermode="InteractiveWebAssembly" />
```

`SharedMessage` 自体は render mode 非依存です (独自のモードを宣言しません):

```razor
@* SharedMessage.razor -- .NET 11 *@
<p>@message</p>
<button @onclick="UpdateMessage">Update</button>

@code {
    private string message = "Not updated yet.";
    private void UpdateMessage() => message = "Updated!";
}
```

`/render-mode-11` に移動すると、ページは次のエラーでレンダリングに失敗します:

```text
Cannot create a component of type 'SharedMessage' because its render mode
'InteractiveWebAssemblyRenderMode' is not supported by Interactive Server rendering.
```

親はサーバーアイランドを所有しています。子はその内側に入れ子になった WebAssembly アイランドを要求しました。その入れ子は表現不可能なので、例外がスローされます。

## 解決策、優先順位順

**1. 子から render mode を削除する (最も一般的)。** 10 回のうち 9 回は、子に `@rendermode` を付けるべきではありませんでした。サンプルからコピーされたか、「対話的にするため」に念のため追加されたものですが、実際には親から対話性を無料で継承します。ディレクティブを削除してください:

```razor
@* RenderMode11.razor -- fixed: child inherits the parent's server island *@
@page "/render-mode-11"
@rendermode InteractiveServer

<h1>Dashboard</h1>

<SharedMessage />
```

これで `SharedMessage` は親と同じ SignalR 接続上で対話的に実行されます。ボタンは動作します。これはドキュメントが説明する [render mode の継承](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#render-mode-inheritance)の挙動です: 対話的な親の内側に置かれたコンポーネントは、その親のモードを採用します。

**2. 2 つのモードを一致させる。** ここで本当に WebAssembly が欲しかったのなら、間違っているのは*親*です。境界でアイランド全体を WebAssembly に設定し、子のディレクティブを削除してください:

```razor
@* fixed: the whole island is WebAssembly *@
@page "/render-mode-11"
@rendermode InteractiveWebAssembly

<SharedMessage />
```

WebAssembly アイランドはクライアントプロジェクト (名前が `.Client` で終わるもの) の中にしか存在できないことを覚えておいてください。ページと `SharedMessage` の両方をそこへ移動してください。さもないとこの解決策は 1 つのエラーを `Could not find any interactive components` に置き換えてしまいます。

**3. 2 つのモードが入れ子ではなく兄弟になるようにアイランドを分割する。** Server と WebAssembly のコンテンツは、どちらかが他方の*内側*にない限り、同じページ上で共存できます。両方を静的な親の子にしてください:

```razor
@* fixed: two sibling islands under a static page *@
@page "/render-mode-11"

@* no @rendermode here -- the page stays static SSR *@
<ServerWidget @rendermode="InteractiveServer" />
<WasmWidget @rendermode="InteractiveWebAssembly" />
```

ページ自体は静的にレンダリングされ、独立した 2 つのアイランドをホストします。これは、あるウィジェットがサーバー専用サービス (データベース、HTTP cookie) を必要とし、別のウィジェットがブラウザでオフライン実行を必要とする場合の正しいパターンです。制約は一致しないモードを*入れ子にする*ことだけに関するもので、両方を 1 ページに持つこと自体ではありません。

**4. `InteractiveAuto` は境界で使い、途中では使わない。** `InteractiveAuto` も依然としてアイランドにとって 1 つの render mode です: 最初の訪問では Server を選び、バンドルがキャッシュされると WebAssembly を選びます。他の 2 つとまったく同じく、境界で一度だけ設定します。サブツリー内でモードを混在させることはできません。

## そっくりさん: "Cannot pass the parameter ... with rendermode"

別物だが常に混同されるエラーが、ほぼ同じきっかけを持っています。対話的な子が*静的な*親の下にあり、それに `RenderFragment` (子コンテンツ) を渡すと、次が得られます:

```text
System.InvalidOperationException: Cannot pass the parameter 'ChildContent' to
component 'SharedMessage' with rendermode 'InteractiveServerRenderMode'. This is
because the parameter is of the delegate type
'Microsoft.AspNetCore.Components.RenderFragment', which is arbitrary code and
cannot be serialized.
```

ここではモードが衝突しているのではなく、*パラメーター*が境界を越えられません。静的な親から対話的な子へ渡されるパラメーターは JSON シリアライズ可能でなければなりません。静的サーバーがそれらをページにシリアライズし、対話的ランタイムが再ハイドレートできるようにする必要があるからです。`RenderFragment` はコンパイル済みのデリゲート (任意のコード) なので、マーシャリングできません。

フレームワーク自身が使う解決策は、パラメーターを取らず、自身の定義で render mode を適用するラッパーコンポーネントです。Blazor Web App テンプレートが `Router` を `Routes` コンポーネントで包んでいるのは、まさにこのためです:

```razor
@* WrapperComponent.razor -- holds the render mode, takes no serialized params *@
@rendermode InteractiveServer

<SharedMessage>
    <p>This child content is created inside the interactive island, not passed across it.</p>
</SharedMessage>
```

`RenderFragment` が境界を越えて渡されるのではなく、対話的な境界の*内側*で書かれるようになったので、シリアライズするものは何もありません。同じ手法は、ページ単位の対話性を持つアプリで `LayoutComponentBase` から派生したレイアウトを対話的にしようとして当たるバリアントも解決します: レイアウトをマークするのではなく、対話的な部分を包んでください。

## 誤った解決策へ導く落とし穴

**`App` またはルートコンポーネントを対話的にマークする。** `App` のようなルートコンポーネントを対話的にすることはサポートされていないため、アプリ全体の render mode を `App` に直接設定することはできません。テンプレートは `<Routes @rendermode="..." />` と `<HeadOutlet @rendermode="..." />` に設定します。`App.razor` に `@rendermode` を付けると、関連する境界エラーが出ます。`Routes` まで下げてください。

**`null` の render mode は「静的」ではない。** `@rendermode="@あるnull変数"` を渡しても静的レンダリングは強制されません。`null` の render mode は「親から継承する」を意味します。親が対話的なら、`null` の子も対話的なままです。[静的 SSR ページのパターン](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#static-ssr-pages-in-an-interactive-app)が `null` モードで機能する唯一の理由は、その親 (`App`) がそもそも静的だからです。

**グローバルな対話性がディレクティブを隠す。** `Routes` にモードを設定してグローバルな対話性を採用した場合、すべてのページがそれを継承します。ページやコンポーネントに*2 つ目*の `@rendermode` を追加するのは、よくて冗長、悪ければ衝突します。フレームワークが間違っていると決めつける前に、プロジェクト内の迷子の `@rendermode` ディレクティブを探してください。

**コンポーネント定義 vs コンポーネントインスタンス。** `@rendermode` は 2 通りで適用できます: コンポーネント*インスタンス* (`<SharedMessage @rendermode="InteractiveServer" />`) か、コンポーネント*定義* (`SharedMessage.razor` の先頭に属性形式で `@rendermode InteractiveServer`) です。定義に焼き込まれたモードは、そのコンポーネントが使われるあらゆる場所で発火します。すでに別のモードを持つアイランドの内側でも同様です。問題のあるインスタンスのディレクティブが見つからない場合は、子自身の `.razor` ファイルに定義レベルのものがないか確認してください。

すべてのバリアントに共通する筋: 各対話的アイランドがどこで始まるかを決め、その境界でモードを一度だけ設定し、内側のすべてに継承させること。レンダラーが例外をスローするのは、まさにすでに境界を持つサブツリーの途中で境界を描き直そうとしたからです。

## 関連

- [.NET 11 で Blazor の静的から対話的へのレンダリング境界をまたいで状態を保持する方法](/ja/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) は、このエラーが守るのと同じ境界のデータ側を扱います。
- [.NET 11 における Blazor Server vs Blazor WebAssembly vs Blazor United](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) は、各 render mode がどのホスティングモデルを選ぶか、どれをいつ選ぶべきかを説明します。
- [.NET 11 で Blazor Server アプリを Blazor United へ移行する](/ja/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) は、render modes を一度も持たなかったアプリにそれを導入する手順を解説します。
- [サーバーと Blazor WebAssembly の間でバリデーションロジックを共有する方法](/ja/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) は、兄弟アイランドが同じルールを必要とするときに欲しいパターンです。
- [.NET 11 で Blazor SSR がついに TempData を得る](/ja/2026/04/blazor-ssr-tempdata-dotnet-11/) は、それ以外は対話的なアプリ内の静的 SSR ページが、ページの完全な再読み込みをまたいでデータを渡す必要があるときに役立ちます。

## 出典

- [ASP.NET Core Blazor render modes -- Render mode propagation and inheritance](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes), Microsoft Learn (aspnetcore-11.0).
- [ASP.NET Core Blazor render modes -- Child component with a different render mode than its parent](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/render-modes#render-mode-propagation), Microsoft Learn.
- [dotnet/aspnetcore #55319 -- Blazor component cannot be nested inside a parent using a render fragment if the nested component is interactive](https://github.com/dotnet/aspnetcore/issues/55319).
</content>
