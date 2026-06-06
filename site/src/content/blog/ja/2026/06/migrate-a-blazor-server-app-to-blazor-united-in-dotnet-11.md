---
title: ".NET 11 で Blazor Server アプリを Blazor United (Blazor Web App) に移行する"
description: "スタンドアロンの Blazor Server アプリを .NET 11 の統合された Blazor Web App テンプレートへ移し、各ページを InteractiveServer のまま動作を変えずに維持するためのステップバイステップのチェックリストです。"
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "blazor"
  - "dotnet"
  - "aspnetcore"
  - "csharp"
lang: "ja"
translationOf: "2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-05
---

スタンドアロンの Blazor Server アプリ (`dotnet new blazorserver`) があり、それを .NET 8 のプレビューサイクル中に「Blazor United」という愛称で呼ばれ **Blazor Web App** として出荷された統合テンプレートに移したい場合、移行はほとんど機械的で、小さなアプリなら通常半日、大きなアプリなら 1 ～ 3 日かかります。コンポーネントのコードは何も変える必要はありません。変わるのはホストです。`_Host.cshtml` がなくなり、ルーティングは `Routes` コンポーネントに移り、`Program.cs` は `MapBlazorHub` を `MapRazorComponents` に置き換え、render mode を明示的に宣言します。各ページを `@rendermode InteractiveServer` のままにすれば、動作は .NET 7 時代の Blazor Server と同一のままです。唯一かみつくのはプリレンダリングの二重実行です。このガイドは **.NET 11**(執筆時点ではプレビュー、GA は 2026 年 11 月予定)と `Microsoft.AspNetCore.Components` 11.0.x パッケージセットを対象とします。

## なぜスタンドアロンの Server テンプレートから離れるのか

スタンドアロンの `blazorserver` テンプレートは .NET 11 でも引き続き動作するため、これは強制的な移行ではありません。次のいずれかが本当に望む成果になったときに行い、それより前には行わないでください。

- **ページごとの render mode。** Web App テンプレートに移れば、ダッシュボードを `InteractiveServer` に保ちつつ、マーケティングページを `@rendermode StaticServer`(SignalR の circuit なし、JavaScript なし、Razor Page のようにインデックスされる)に設定できます。スタンドアロンテンプレートではモードをまったく混在させられません。
- **書き直しなしで WebAssembly と Auto への道。** あとからオフライン対応ウィジェットを追加するには、アプリ全体を移植するのではなく、`.Client` プロジェクトと 1 つの `@rendermode InteractiveWebAssembly` を追加するだけで済みます。
- **Microsoft が推奨するデフォルトに乗っている。** テンプレート、ドキュメントのサンプル、新しいチュートリアルは .NET 8 以降すべて Blazor Web App テンプレートを先頭に据えています。スタンドアロンの Server にとどまることは、いまやコードレビューで正当化しなければならない逸脱です。
- **.NET 10+ での回復力のある circuit 状態。** Web App テンプレートと `[PersistentState]` 属性を組み合わせると、切断された SignalR の circuit が再接続したときにコンポーネントの状態を復元できます。これは古い `ServerPrerendered` モデルが決してきれいに行えなかったことです。

これらのいずれにも当てはまらない場合、既存のスタンドアロン Server アプリへの `<TargetFramework>net11.0</TargetFramework>` の変更は有効な代替手段であり、この移行ではありません。

## 何が壊れるか

| 領域                       | 変更                                                                                          | 重大度 |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| ホストページ               | `Pages/_Host.cshtml` と `_Layout.cshtml` がルートのホストコンポーネント `App.razor` に置き換わる | high     |
| ルーティング               | `<Router>` が `App.razor` の外、新しい `Routes.razor` に移る                                  | high     |
| `Program.cs` の起動        | `AddServerSideBlazor()` + `MapBlazorHub()` + `MapFallbackToPage("/_Host")` が `AddRazorComponents().AddInteractiveServerComponents()` + `MapRazorComponents<App>().AddInteractiveServerRenderMode()` に置き換わる | high     |
| Render mode                | 対話性はコンポーネントごとまたはグローバルにオプトイン。暗黙の「アプリ全体が対話的」はない     | high     |
| プリレンダリング           | `OnInitialized`/`OnInitializedAsync` がデフォルトで 2 回実行される(プリレンダーパス + 対話パス) | medium   |
| クライアントスクリプト     | `_framework/blazor.server.js` が `_framework/blazor.web.js` になる                           | medium   |
| 認証の配線                 | `CascadingAuthenticationState` コンポーネントが DI の `AddCascadingAuthenticationState()` に置き換わる | medium   |
| `HttpContext` アクセス     | `HttpContext` は静的 SSR 中のみ利用可能で、対話的コンポーネント内では使えない                 | medium   |
| `App.razor` の意味         | `App.razor` はもはやルーターではなく、HTML ドキュメントのシェルである                         | low      |

## 事前チェックリスト

- **.NET 11 SDK** をインストールします(`dotnet --version` が `11.0.1xx` を報告)。`dotnet --list-sdks` で確認してください。
- クリーンなチェックポイントをコミットし、**ブランチを作成**します。この移行はファイルを削除します。簡単に戻れる手段が欲しいところです。
- 現在のエントリポイントを記録します。スタンドアロンの Blazor Server は `_Host.cshtml`(.NET 8 より前の一般的なレイアウト)を使うか、すでに `App.razor` ホストを使っています。以下の手順は `_Host.cshtml` を前提とします。
- 副作用(書き込み、アナリティクスイベント、1 回限りのフェッチ)を持つすべての `OnInitializedAsync` を棚卸しします。これらがプリレンダリングによって 2 回実行されるメソッドです。手順 7 でそれぞれに戻ってきます。
- CI を .NET 11 SDK イメージに更新し、何かに触れる前に基準となる `dotnet build` と `dotnet test` が現在のコードで通ることを確認します。
- `dotnet new blazor --interactivity Server -o _ref` で使い捨ての参照アプリをスキャフォールドし、構造をコピーできる既知の正しい `App.razor`、`Routes.razor`、`Program.cs` を手元に用意します。

## 移行手順

### 1. target framework とパッケージを引き上げる

`.csproj` を編集します。SDK は `Microsoft.NET.Sdk.Web` のままです。

```xml
<!-- .NET 11 -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <Nullable>enable</Nullable>
  <ImplicitUsings>enable</ImplicitUsings>
</PropertyGroup>
```

`Microsoft.AspNetCore.Components.*` のパッケージ参照を `11.0.x` に引き上げます。明示的に参照されている場合は `Microsoft.AspNetCore.Components.Web` を削除します。これはウェブ SDK プロジェクトのフレームワーク参照の一部です。

確認: `dotnet restore` が完了し、`dotnet build` がパッケージ解決のエラーではなく、ホストページと `Program.cs` に関するエラー(この時点では想定どおり)でのみ失敗すること。

### 2. `App.razor` ホストコンポーネントを作成する

スタンドアロンの Server テンプレートでは、HTML ドキュメントは `Pages/_Host.cshtml` と `Pages/_Layout.cshtml` にあります。そのマークアップを新しいルートの `App.razor` に移します(先に古い `App.razor` ルーターを削除するか、名前を変更します)。ルートをブートしていた `<component>` タグヘルパーは `<Routes />` になります。

```razor
@* .NET 11 - App.razor is now the HTML document shell, not the router *@
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base href="/" />
    <link rel="stylesheet" href="app.css" />
    <link rel="stylesheet" href="YourApp.styles.css" />
    <HeadOutlet />
</head>
<body>
    <Routes />
    <script src="_framework/blazor.web.js"></script>
</body>
</html>
```

見落としやすい変更が 2 つあります。スクリプトは `blazor.web.js`(`blazor.server.js` ではない)であること、そして `<HeadOutlet />` と `<Routes />` はコンポーネントなので、手順 6 で割り当てた render mode を受け継ぐことです。

確認: ファイルが Razor コンポーネントとしてコンパイルされること(`@page` ディレクティブなし、`@model` なし)。

### 3. ルーティングを `Routes.razor` に移す

プロジェクトのルートに `Routes.razor` を作成し、古い `App.razor` にあった `<Router>` ブロックを貼り付けます。

```razor
@* .NET 11 - Routes.razor holds the router that used to be in App.razor *@
<Router AppAssembly="@typeof(Program).Assembly">
    <Found Context="routeData">
        <RouteView RouteData="@routeData" DefaultLayout="@typeof(Layout.MainLayout)" />
        <FocusOnNavigate RouteData="@routeData" Selector="h1" />
    </Found>
    <NotFound>
        <PageTitle>Not found</PageTitle>
        <LayoutView Layout="@typeof(Layout.MainLayout)">
            <p role="alert">Sorry, there's nothing at this address.</p>
        </LayoutView>
    </NotFound>
</Router>
```

確認: `dotnet build` が `Routes` 型の欠如についてもう文句を言わないこと。

### 4. `_Imports.razor` で render mode の短縮形を有効にする

完全修飾する代わりに `InteractiveServer` と書けるように、この行を `_Imports.razor` に追加します。

```razor
@* .NET 11 *@
@using static Microsoft.AspNetCore.Components.Web.RenderMode
```

確認: コンポーネント内の `@rendermode InteractiveServer` が using のエラーなしで解決されること。

### 5. `Program.cs` を書き直す

Blazor Server の登録とエンドポイントを Razor Components 相当に置き換えます。

```csharp
// .NET 11, C# 14 - Blazor Web App startup
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

// keep your existing app services here (DbContext, HttpClient, etc.)

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
```

`AddServerSideBlazor()`、`app.MapBlazorHub()`、`app.MapFallbackToPage("/_Host")` を削除します。`app.UseAntiforgery()` の呼び出しは新しく、必須です。Web App テンプレートはデフォルトで antiforgery ミドルウェアを有効にしており、これがないとフォームの POST が失敗します。

確認: `dotnet build` がエラーゼロで完了すること。

### 6. アプリを対話的にする(グローバル render mode)

最もリスクの低い移行は、アプリ全体を `InteractiveServer` にして、古い動作を正確に再現することです。`App.razor` の中の `<Routes />` と `<HeadOutlet />` に render mode を設定します。

```razor
@* .NET 11 - global InteractiveServer, matches standalone Blazor Server behaviour *@
<HeadOutlet @rendermode="InteractiveServer" />
...
<Routes @rendermode="InteractiveServer" />
```

確認: `dotnet run` を実行し、アプリを開き、対話的コンポーネント(ボタン、`@onclick`、`EditForm` の送信)が動作し、ブラウザが `/_blazor` への WebSocket を開いたまま保持していることを確認します。これが動いたら、あとで個々のページを `@rendermode StaticServer` に下げたり、アイランドを WebAssembly に上げたりできますが、それは移行後の作業です。

### 7. プリレンダリングの二重実行に対処する

これは人々を驚かせる唯一の動作変更です。対話的な render mode では、Blazor はまず静的 HTML をプリレンダーし、その後ライブの circuit 上で再びレンダーするため、`OnInitialized` と `OnInitializedAsync` が 2 回実行されます。古いスタンドアロン Server のデフォルト(`render-mode="ServerPrerendered"`)も同じ性質を持っていましたが、多くのアプリは `render-mode="Server"` を使っていて、これに気づくことはありませんでした。

選択肢は 3 つあります。.NET 11 で最もきれいなのは宣言的な `[PersistentState]` 属性(.NET 10 で追加)です。プリレンダー中に一度フェッチし、HTML にシリアライズして、対話パスで復元します。

```csharp
// .NET 11 - fetch once, survive the prerender-to-interactive handoff
public partial class Dashboard : ComponentBase
{
    [PersistentState]
    public List<Order>? Orders { get; set; }

    [Inject] public required IOrderService OrderService { get; init; }

    protected override async Task OnInitializedAsync()
    {
        // Orders is non-null on the interactive pass: state was restored,
        // so the service is not hit a second time.
        Orders ??= await OrderService.GetRecentAsync();
    }
}
```

プリレンダー中にまったくフェッチしたくない場合は、その境界でプリレンダリングを無効にします。

```razor
@* .NET 11 - skip the prerender pass entirely for this component tree *@
<Routes @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

確認: 副作用のある各 `OnInitializedAsync` にブレークポイントまたはログ行を置き、実際のナビゲーションごとに 1 回だけ実行され、2 回ではないことを確認します。

### 8. 認証と認可を再配線する

アプリがルーターを包む `<CascadingAuthenticationState>` を使っていた場合、そのコンポーネントを削除して代わりに DI に登録し、`Routes.razor` で `RouteView` を `AuthorizeRouteView` に置き換えます。

```csharp
// .NET 11 - Program.cs
builder.Services.AddCascadingAuthenticationState();
```

```razor
@* .NET 11 - Routes.razor, authorized routing *@
<AuthorizeRouteView RouteData="@routeData" DefaultLayout="@typeof(Layout.MainLayout)" />
```

確認: サインアウト状態で `[Authorize]` ページにアクセスしてリダイレクトされることを確認し、その後サインインしてアクセスできることを確認します。

### 9. 不要になったホストファイルを削除する

`Pages/_Host.cshtml`、`Pages/_Layout.cshtml`、および `_Host` を提供するためだけに存在していた `app.MapRazorPages()` の呼び出しを削除します。Razor Pages を他に何も使っていない場合は、`Program.cs` から `AddRazorPages()` を削除します。

確認: `dotnet build` がクリーンで、アプリがすべてのルートを引き続き提供すること。

## 検証: 移行後のスモークテスト

マージする前に、これらすべてを実行します。

- `dotnet build -c Release` が render mode 関連の警告ゼロを報告する。
- `dotnet test` が移行前の基準と同じ件数で通る。
- アプリが `dotnet run` で起動し、ホームページがレンダリングされる。
- 対話的なコントロール(`@onclick`、`EditForm`)が動作し、ブラウザが `/_blazor` の WebSocket を開いたまま保持する。
- ページのナビゲーションが副作用を二重に発火しない(手順 7 のチェックをエンドツーエンドで繰り返す)。
- `[Authorize]` で保護されたルートがサインアウト時にリダイレクトする。
- フォームの POST が成功する(これは手順 5 の antiforgery ミドルウェアのチェックです)。
- ページのソースを表示する: マークアップがプリレンダーされた HTML であり、空の `<div id="app">` ではないこと。

## ロールバック計画

この移行が元に戻せるのは、事前チェックの手順でブランチを保持していた場合のみです。`_Host.cshtml` を削除して `Program.cs` を書き直すと、スタンドアロン Server モデルへ戻すその場での切り替えはありません。前進方向に編集するのではなく、移行前のコミットをチェックアウトしてロールバックします。変更は構造的なものでデータ移行ではないため、データベースやストレージで元に戻すものはありません。ブランチを作り、作業を行い、スモークテストで検証し、グリーンになったときだけマージします。

## ぶつかった落とし穴

- **`app.UseAntiforgery()` を忘れる。** Web App テンプレートは antiforgery ミドルウェアを必要とします。この呼び出しがないと、`EditForm` の POST はすべて `Antiforgery token validation failed` を伴う 400 を返します。スタンドアロン Server テンプレートでは、フォーム処理が HTTP POST ではなく SignalR の circuit 上を通っていたため、これは不要でした。
- **`HttpContext` が対話的コンポーネント内では null。** スタンドアロン Server では、コンポーネントから `IHttpContextAccessor` に到達できることがありました。Web App テンプレートでは、`HttpContext` は静的 SSR パスの間だけ存在します。必要なもの(ヘッダー、cookie、認証済みユーザー)をプリレンダー中に読み取って下に渡すか、カスケードする `AuthenticationState` を使ってください。
- **`blazor.server.js` をマークアップに残す。** `_Host.cshtml` の古いスクリプトタグをそのままコピーすると、ページは読み込まれますが circuit は開かれず、何も対話的になりません。`_framework/blazor.web.js` でなければなりません。
- **scoped サービスがプリレンダー境界をまたいで異なる振る舞いをする。** プリレンダー中に解決されたサービスと対話パス中に解決されたサービスは、2 つの異なるスコープです。リクエストごとの状態を scoped サービスにキャッシュして残ることを期待していた場合、残りません。これは [singleton から scoped サービスを使用できない](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/) で扱われているのと同じ種類の問題です。
- **移動後に静的アセットが 404。** Web App テンプレートはコンポーネントスコープの CSS を `YourApp.styles.css` として提供します。古い `_Layout.cshtml` が別名のバンドルを参照していた場合、リンクは静かに壊れます。新しい `App.razor` の `<link>` の href を確認してください。

ここでの行き先はほぼ常に「各ページを `InteractiveServer` に、プリレンダリングは処理済み」です。これはユーザーが見られるものを何も変えない移行です。Static Server ページ、WebAssembly アイランド、Auto コンポーネントを追加することは、そのあとで、1 コンポーネントずつ、さらなる構造的な揺さぶりなしに回収する見返りです。

## 関連

- [.NET 11 における Blazor Server 対 Blazor WebAssembly 対 Blazor United: どれを選ぶべきか](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) 移行先テンプレートの背後にある判断について。
- [サーバーと Blazor WebAssembly の間で検証ロジックを共有する方法](/ja/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) WASM コンポーネントを追加したときに欲しくなる共有プロジェクトのパターンについて。
- [.NET 11 で Blazor SSR についに TempData が登場](/ja/2026/04/blazor-ssr-tempdata-dotnet-11/) いま追加できる静的 SSR ページでの Post-Redirect-Get フローについて。
- [解決: singleton から scoped サービスを使用できない](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/) プリレンダー境界が露呈させるスコープの有効期間の問題について。
- [2026 年に .NET Framework 4.8 から .NET 11 へ移行する](/ja/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) この Blazor の移動がより大きなフレームワークの飛躍の一部である場合に。

## 出典

- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/aspnet/core/blazor/components/render-modes), Microsoft Learn, 2026-06-05 アクセス。
- [ASP.NET Core Blazor prerendered state persistence](https://learn.microsoft.com/aspnet/core/blazor/state-management/prerendered-state-persistence), Microsoft Learn, .NET 10 で追加された `[PersistentState]` 属性について。
- [Migrate from ASP.NET Core in .NET 7 to .NET 8](https://learn.microsoft.com/aspnet/core/migration/70-to-80), Microsoft Learn, Blazor Server から Web App への元のホスト再構成手順について。
- [ASP.NET Core Razor component lifecycle](https://learn.microsoft.com/aspnet/core/blazor/components/lifecycle), Microsoft Learn, プリレンダーの二重実行の動作について。
</content>
