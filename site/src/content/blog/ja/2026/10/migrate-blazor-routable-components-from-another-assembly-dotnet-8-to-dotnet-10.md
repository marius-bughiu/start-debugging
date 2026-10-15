---
title: "別アセンブリにルーティング可能コンポーネントを持つ Blazor アプリを .NET 8 から .NET 10 へ移行する"
description: "Razor クラスライブラリや .Client プロジェクトにページを置いた Blazor Web App を .NET 8 から .NET 10 へアップグレードします。変わらないもの (2 つの AdditionalAssemblies 登録) と、壊れる 4 つのこと (薄いホストでの blazor.web.js の 404 から、空白で描画される NotFoundPage まで) を整理します。ASP.NET Core 8.0.32 と 10.0.10 で検証しています。"
pubDate: 2026-10-15
updatedDate: 2026-10-15
template: migration
tags:
  - "migration"
  - "blazor"
  - "dotnet-10"
  - "dotnet-8"
  - "aspnet-core"
  - "razor-class-library"
lang: "ja"
translationOf: "2026/10/migrate-blazor-routable-components-from-another-assembly-dotnet-8-to-dotnet-10"
translatedBy: "claude"
translationDate: 2026-10-15
---

.NET 8 の Blazor Web App が別アセンブリ (Razor クラスライブラリ、`.Client` プロジェクト、機能モジュール) にあるページを描画している場合、ルーティングの契約は .NET 10 でも変わりません。エンドポイント側には引き続き `MapRazorComponents<App>().AddAdditionalAssemblies(...)` が必要で、インタラクティブな `Router` にも `AdditionalAssemblies` パラメーターが必要です。ASP.NET Core 8.0.32 と 10.0.10 で同じ 7 ケースの登録マトリクスを実行したところ、すべてのケースで結果は同じでした。壊れるのはその周辺です。自前の `.razor` ファイルを持たないホストは `blazor.web.js` を配信しなくなります。ライブラリにある `NotFoundPage` は、ライブラリがエンドポイント側に登録されていないと空の 404 を返します。従来の `<NotFound>` フラグメントは廃止予定になりました。そして "Assembly already defined" エラーは、`Program.cs` の該当行からアプリの起動時へ移ります。ページライブラリが 1 つか 2 つある典型的なソリューションなら、アップグレードは 1 時間もかかりません。以下はすべて SDK 10.0.302 と `Microsoft.AspNetCore.Components.Web` 10.0.13 でビルドしています。

## なぜ今 .NET 8 から移行するのか

- **.NET 8 のサポートは 2026 年 11 月 10 日に終了します。** .NET 10 は現在の LTS で、2028 年 11 月までサポートされます。その日以降、.NET 8 アプリはセキュリティパッチを受け取れなくなります。
- **`NotFoundPage` はアセンブリをまたいで動作します。** .NET 10 では、未知の URL、`NavigationManager.NotFound()` の呼び出し、ステータスコードの再実行に対して、共有ライブラリのルーティング可能な not-found ページを描画できます。ホストごとにインラインのフラグメントを複製する必要はありません。
- **静的アセットにフィンガープリントと圧縮が付きます。** `MapStaticAssets` (.NET 9 で追加) は、ライブラリの `_content/...` ファイルと Blazor スクリプトを、ビルド時の圧縮と ETag 付きで配信します。独自の CSS や JS を同梱するページライブラリで効果があります。

## .NET 8 と .NET 10 の間で何が変わるか

| 領域 | 変更点 | 重大度 |
| --- | --- | --- |
| `.razor` ファイルのないホスト | .NET 10 では `blazor.web.js` は静的 Web アセットで、プロジェクトにコンポーネントが含まれる場合にのみ出力されます。薄いホストでは 404 になります。 | 高 |
| ライブラリ内の `NotFoundPage` | ページに `@page` が必要で、そのアセンブリを `AddAdditionalAssemblies` に渡さないと、404 レスポンスが空になります | 中 |
| `<NotFound>` フラグメント | `[Obsolete]` で、`NotFoundPage` と併用すると例外が発生します | 中 |
| RCL のパッケージ参照 | `Microsoft.AspNetCore.Components.Web` 8.0.x を 10.0.x に上げる必要があります | 低 |
| アセンブリの重複登録 | "Assembly already defined" は `AddAdditionalAssemblies` の呼び出し時ではなく、起動中にスローされます | 低 |
| ライブラリコンポーネントのメンバー名 | `ComponentBase` に .NET 9 で `RendererInfo` と `AssignedRenderMode` が追加されました。同名のコンポーネントメンバーはこれを隠します (CS0108) | 低 |
| `UseStaticFiles` | 発行後も動作しますが、移行ガイドでは `MapStaticAssets` に置き換えられています | 低 |

## 2 つの登録と、それぞれが制御するもの

ほとんどの移行がここでつまずきます。多くの場合、.NET 7 の Blazor Server アプリではどちらか一方だけで済んでいたためです。Blazor Web App には 2 つのルーターがあります。ASP.NET Core のエンドポイントルーティングは最初の HTTP リクエスト (およびすべての拡張ナビゲーションリクエスト) を処理し、どのアセンブリに `@page` コンポーネントがあるかを知る必要があります。Blazor の `Router` コンポーネントはインタラクティブに動作し始めてからのナビゲーションを処理し、`AppAssembly` と `AdditionalAssemblies` から独自のルートテーブルを構築します。

テスト構成は次のとおりです。.NET 8 の `blazor` テンプレート (Interactive Server) から作成したホストと、ページを 1 つ持つ Razor クラスライブラリ `Shared.Pages` です。

```razor
@* Shared.Pages/Pages/Reports.razor, .NET 8 and .NET 10 *@
@page "/reports"
@rendermode InteractiveServer

<h1>Reports (from Shared.Pages)</h1>
<p>Rendered from @GetType().Assembly.GetName().Name</p>
<button @onclick="() => count++">Clicked @count</button>

@code {
    int count;
}
```

環境変数で各登録と `<Routes />` のレンダーモードを切り替え、`/reports` に直接リクエストしました。結果は 8.0.32 と 10.0.10 で同一でした。

| `Router.AdditionalAssemblies` | `AddAdditionalAssemblies` | `<Routes>` のレンダーモード | `GET /reports` |
| --- | --- | --- | --- |
| 未設定 | 未設定 | 静的 | 404 |
| 設定済み | 未設定 | 静的 | 404 |
| 未設定 | 設定済み | 静的 | 200 |
| 設定済み | 設定済み | 静的 | 200 |
| 設定済み | 未設定 | `InteractiveServer` | 404 |
| 未設定 | 設定済み | `InteractiveServer` | 200、その後サーキット開始時に "not found" |
| 設定済み | 設定済み | `InteractiveServer` | 200 |

6 行目が紛らわしいケースです。サーバーはページを正しくプリレンダリングし、ブラウザーは一瞬それを表示しますが、その後インタラクティブな `Router` が引き継ぎ、自身のルートテーブルに `/reports` を見つけられず、ページを not-found のコンテンツに置き換えます。両方のバージョンでブラウザー上で確認しました。5 行目はその逆の間違いです。インタラクティブルーターはページを知っていますが、エンドポイントが存在しないため、最初のリクエストがそこに届きません。

したがって、両バージョン共通のルールは単純です。**ルーティング可能なコンポーネントを含むすべてのアセンブリを、両方の場所に登録してください。** `Routes` コンポーネントがサーバープロジェクトにある場合は、その `AdditionalAssemblies` にも `.Client` アセンブリを含める必要があります。

## 事前チェックリスト

1. .NET 10 SDK がインストールされていること (`dotnet --list-sdks` に `10.0.1xx` 以降が表示されること。私は 10.0.302 を使用しました)。`global.json` が 8.0 に固定されている場合は更新してください。
2. `@page` コンポーネントを含むすべてのアセンブリの一覧。`grep -rln "@page" --include=*.razor .` を実行し、ヒットしたファイルをプロジェクトごとにまとめます。
3. それらを登録しているすべての場所。`grep -rn "AdditionalAssemblies" --include=*.razor --include=*.cs .` で、ホストごとに `Router` が 1 つ、`MapRazorComponents` のチェーンが 1 つ表示されるはずです。片方しか表示されない場合は、上記のマトリクスのバグがすでに発生しています。
4. 動作し続ける必要がある URL の一覧。各ライブラリから 1 つずつと、404 になるべきものを 1 つ含めてください。各ステップの後にこれらを curl で確認します。

## 移行手順

1. **すべてのプロジェクトのターゲットを変更し、ライブラリのパッケージを更新します。** ホスト、`.Client` プロジェクト、各 Razor クラスライブラリで `<TargetFramework>net8.0</TargetFramework>` を `net10.0` に変更します。RCL テンプレートは `Microsoft.AspNetCore.Components.Web` をパッケージとして参照しているため、そのバージョンも更新が必要です。

   ```xml
   <!-- Shared.Pages.csproj, .NET 10 -->
   <Project Sdk="Microsoft.NET.Sdk.Razor">
     <PropertyGroup>
       <TargetFramework>net10.0</TargetFramework>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
     <ItemGroup>
       <SupportedPlatform Include="browser" />
     </ItemGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.AspNetCore.Components.Web" Version="10.0.13" />
     </ItemGroup>
   </Project>
   ```

   他のアプリがまだ .NET 8 でこのライブラリを使っている場合は、`<TargetFrameworks>net8.0;net10.0</TargetFrameworks>` でマルチターゲットにし、パッケージのバージョンを `$(TargetFramework)` で条件分岐させてください。`dotnet build` で確認し、警告を読んでください。ライブラリコンポーネントでの CS0108 は、`ComponentBase` のメンバーを隠すメンバーを宣言していることを意味します (注意点を参照)。

2. **アセンブリの一覧を 1 か所にまとめ、両方の登録で使います。** "更新すると動くのに、クリックすると動かない"バグの多くは、2 つの一覧がずれることが原因です。小さな静的クラスでずれをなくせます。

   ```csharp
   // Host/RoutableAssemblies.cs, .NET 10
   using System.Reflection;

   namespace Host;

   public static class RoutableAssemblies
   {
       // Do NOT include typeof(Program).Assembly: it is already the app assembly.
       public static readonly Assembly[] Additional =
       [
           typeof(Shared.Pages._Imports).Assembly,
           // typeof(Host.Client._Imports).Assembly,
       ];
   }
   ```

   ```csharp
   // Host/Program.cs, .NET 10
   app.MapRazorComponents<App>()
       .AddInteractiveServerRenderMode()
       .AddAdditionalAssemblies(RoutableAssemblies.Additional);
   ```

   ```razor
   @* Host/Components/Routes.razor, .NET 10 *@
   <Router AppAssembly="typeof(Program).Assembly"
           AdditionalAssemblies="RoutableAssemblies.Additional"
           NotFoundPage="typeof(Shared.Pages.Pages.NotFound)">
       <Found Context="routeData">
           <RouteView RouteData="routeData" DefaultLayout="typeof(Layout.MainLayout)" />
           <FocusOnNavigate RouteData="routeData" Selector="h1" />
       </Found>
   </Router>
   ```

   各ライブラリにつき 1 つの URL で `curl -s -o /dev/null -w '%{http_code}' http://localhost:5000/reports` が `200` を返すことを確認し、次に同じ URL をブラウザーで開いて、サーキット (または WebAssembly ランタイム) が開始するのを待ちます。その後もページが表示され続けている必要があります。

3. **`<NotFound>` をルーティング可能な `NotFoundPage` に置き換えます。** .NET 10 では `NotFound` レンダーフラグメントに `[Obsolete("NotFound is deprecated. Use NotFoundPage instead.")]` が付いています。リリースノートではさらに踏み込んで ".NET 10 以降ではサポートされない" と書かれていますが (原文は "isn't supported in .NET 10 or later")、私のテストでは `NotFoundPage` を設定しない場合、10.0.10 でもフラグメントは描画されました。つまり、これは障害ではなく、計画的に対応できる廃止予定です。両方を設定すると `InvalidOperationException: Setting NotFound and NotFoundPage properties simultaneously is not supported` がスローされます。ルーターがこのページに `[Route]` 属性があることを検証するため、ページにはルートが必要です。

   ```razor
   @* Shared.Pages/Pages/NotFound.razor, .NET 10 *@
   @page "/not-found"

   <h1>Not found (from Shared.Pages)</h1>
   ```

   次に、.NET 10 テンプレートが使うステータスコード再実行ミドルウェアを追加します。これで、最初の HTTP リクエストでの未知の URL もこのページに到達します。

   ```csharp
   // Host/Program.cs, .NET 10
   app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);
   app.UseAntiforgery();
   ```

   `GET /missing` が、本文にこのページの `<h1>` を含む `404` を返すこと、そして `GET /not-found` が `200` を返すことを確認します。404 の本文が空の場合は、次のステップを読んでください。

4. **not-found ページのアセンブリをエンドポイント側に登録します。** 再実行は、`/not-found` に対するエンドポイントルーティングを通る 2 回目のリクエストです。ページが `Router` しか知らないライブラリにある場合、そのためのエンドポイントは存在しません。ページを `Shared.Pages` に置いた 10.0.10 での計測結果です。

   | `AddAdditionalAssemblies(Shared.Pages)` | `GET /missing` | `GET /not-found` |
   | --- | --- | --- |
   | なし | 404、空の本文 | 404、空の本文 |
   | あり | 404、"Not found (from Shared.Pages)" | 200 |

   ライブラリが共有リストに含まれていれば、ステップ 2 ですでに解決しています。同じ 2 つのリクエストで確認してください。

5. **`UseStaticFiles` を `MapStaticAssets` に切り替えます。** .NET 9 の移行ガイドでは、`app.UseStaticFiles()` を `app.MapStaticAssets()` に置き換えることになっており、.NET 10 のテンプレートもこれを使っています。ライブラリのアセットを `_content/Shared.Pages/...` 以下で、事前圧縮された `.br` と `.gz` のバリアント付きで配信します。.NET 10 で `UseStaticFiles` を使い続けても、発行フォルダーから `blazor.web.js` が配信されることは確認しているため、強制ではありません。ただし、テンプレートの他の部分 (`@Assets["..."]`、`<ResourcePreloader />`、`<ImportMap />`) はこれを前提としています。

   ```csharp
   // Host/Program.cs, .NET 10
   app.UseAntiforgery();
   app.MapStaticAssets();
   app.MapRazorComponents<App>()
       .AddInteractiveServerRenderMode()
       .AddAdditionalAssemblies(RoutableAssemblies.Additional);
   ```

   `GET /_framework/blazor.web.js` が `200` を返すこと、そして `/_content/Shared.Pages/Shared.Pages.bundle.scp.css` のようなライブラリのスタイルシートが引き続き読み込まれることを確認します。

6. **ホストに `.razor` ファイルがない場合は、Blazor スクリプトを強制的に含めます。** これは、最もすっきりしたアーキテクチャにだけ影響する問題です。`App.razor`、レイアウト、すべてのページがライブラリにあり、ホストが `Program.cs` だけの場合、.NET 8 は共有フレームワークの埋め込みリソースだったため `blazor.web.js` を配信していました。.NET 10 では、このスクリプトは静的 Web アセットで、プロジェクトに少なくとも 1 つのコンポーネントがある場合にのみ SDK が追加します。発行フォルダーから計測した、薄いホストの結果です。

   | ホスト | `GET /reports` | `GET /_framework/blazor.web.js` |
   | --- | --- | --- |
   | .NET 8.0.32、`UseStaticFiles` | 200 | 200 |
   | .NET 10.0.10、`MapStaticAssets` | 200 | 404 |
   | .NET 10.0.10、`MapStaticAssets` + `RequiresAspNetWebAssets` | 200 | 200 |

   ページは引き続きプリレンダリングされるため、見落としやすい問題です。何もインタラクティブにならず、唯一のサインはブラウザーのネットワークタブにある 404 だけです。修正は MSBuild プロパティ 1 つです。

   ```xml
   <!-- Host.csproj, .NET 10, host project without any .razor file -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>
   </PropertyGroup>
   ```

   `dotnet publish` の後に `publish/wwwroot/_framework/blazor.web.js` が存在することを確認し、ブラウザーでインタラクティブな要素をクリックします。

7. **ライブラリ内の WebAssembly ページと Auto ページでは、`.Client` 側も確認します。** ここは 8 から 10 の間で変わっていませんが、移行は修正する良い機会です。`@rendermode InteractiveWebAssembly` を持つライブラリのページは、ブラウザーがダウンロードできる必要があります。そのため `.Client` プロジェクトがライブラリを参照している必要があり、最初のリクエストのために、サーバー側も `AddAdditionalAssemblies` にそれを列挙している必要があります。`Routes` 自体が WebAssembly 上で動作する場合 (グローバルなインタラクティビティ)、それは `.Client` にあり、その `Router` の `AdditionalAssemblies` にライブラリが必要です。WebAssembly ページを直接読み込み、次に別のページからそこへナビゲートして確認します。

## 検証

`bin/` ではなく、発行したアプリ (`dotnet publish -c Release -o out`、続いて `dotnet out/Host.dll`) に対して次を実行してください。

```bash
#!/usr/bin/env bash
# .NET 10 smoke test for routable components from other assemblies
BASE=http://localhost:5000
for u in /reports /not-found /missing /_framework/blazor.web.js; do
  printf '%-30s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$u")"
done
```

期待値は `200`、`200`、`404`、`200` です。その後、ブラウザーで次を確認します。

- ライブラリのページを直接開き、2 秒待ちます。not-found ページに変わってはいけません。
- ホストのページからライブラリのページへリンクをクリックして移動し、戻ります。
- 使っている場合は、ライブラリのページから `NavigationManager.NotFound()` を実行し、`NotFoundPage` が描画されることを確認します。
- ネットワークタブで、`_framework/` や `_content/` に 404 がないか確認します。

## ロールバック

ライブラリの互換性を保つ限り、この変更は元に戻せます。ライブラリが `net8.0;net10.0` にマルチターゲットしていれば、ホストの `.csproj` を元に戻して `net8.0` にロールバックできます。8 に存在しないものを覚えておいてください。`MapStaticAssets` (`UseStaticFiles` を使います)、`NotFoundPage` (`<NotFound>` フラグメントを使います)、`UseStatusCodePagesWithReExecute` の `createScopeForStatusCodePages` パラメーター、`RequiresAspNetWebAssets` (無害ですが未使用になります) です。ロールバックをきれいな revert にするため、これらの変更はターゲット変更とは別のコミットにしてください。

## テスト実行で見つけた注意点

**"Assembly already defined" の発生場所が移りました。** アプリ自身のアセンブリを `AddAdditionalAssemblies` に追加することは、以前からエラーです。8.0.32 では、スタックトレースがあなたのコードを直接指します。

```text
Unhandled exception. System.InvalidOperationException: Assembly already defined.
   at Microsoft.AspNetCore.Components.Discovery.ComponentApplicationBuilder.AddLibrary(...)
   at Microsoft.AspNetCore.Builder.RazorComponentsEndpointConventionBuilderExtensions.AddAdditionalAssemblies(...)
   at Program.<Main>$(String[] args) in .../Host/Program.cs:line 29
```

10.0.10 では、登録はエンドポイントが最初に構築されるまで遅延されます。そのため同じ間違いが `RazorComponentEndpointDataSource.UpdateEndpoints()` からの `Application startup exception` としてログに記録され、どのフレームにも `Program.cs` は現れません。アップグレード後にこのメッセージが出たら、追加アセンブリのリストで `typeof(Program).Assembly` を探すか、同じライブラリが 2 つのヘルパーメソッドから二重に追加されていないか確認してください。

**アセンブリをまたぐルートの重複は、起動時ではなくリクエスト時に失敗します。** ホストとライブラリの両方が `@page "/reports"` を宣言していた場合、アプリは 10.0.10 で問題なく起動し、リクエストは `AmbiguousMatchException: The request matched multiple endpoints` とともに `500` を返しました。壊れるのは衝突した URL だけなので、それをスキップするスモークテストは通ってしまいます。事前チェックリストの `grep -rn '@page "' --include=*.razor` の出力をルート順に並べ替えれば、リリース前に見つけられます。

**ライブラリのメンバー名 `RendererInfo` がフレームワークのメンバーを隠すようになりました。** テストページの最初のバージョンには `string RendererInfo` プロパティがありました。.NET 8 ではきれいにコンパイルされましたが、.NET 10 では `warning CS0108: 'Reports.RendererInfo' hides inherited member 'ComponentBase.RendererInfo'` が出ました。`ComponentBase` に .NET 9 で `RendererInfo` と `AssignedRenderMode` が追加されたためです。この警告は、チームメイトがそのコンポーネントで `RendererInfo.IsInteractive` を読み、あなたの文字列を受け取るまでは無害です。メンバーの名前を変更してください。

**`UseStaticFiles` を使い続けて `bin/` からテストすると、誤った 404 が出ます。** .NET 8 のパイプライン (`UseStaticFiles` で `MapStaticAssets` なし) のまま、Production 環境で `dotnet bin/Release/net10.0/Host.dll` を実行すると、コンポーネントを持つ通常のホストでも `blazor.web.js` が 404 を返しました。.NET 8 で同じことをすると 200 でした。`UseStaticFiles` は `wwwroot` に物理的に存在するファイルしか見ず、Development 以外では、参照プロジェクトや SDK の静的 Web アセットを追加するものがないためです。.NET 8 では Blazor スクリプトが埋め込みリソースから来ていたため影響を受けませんでしたが、.NET 10 では静的 Web アセットです。同じ `bin/` の実行でも、`MapStaticAssets` を使うと生成されたエンドポイントマニフェストを読むため 200 を返し、発行フォルダーはどちらのミドルウェアでも 200 を返しました。`dotnet publish` のフォルダーか `dotnet run` でテストしないと、見当違いの問題を追いかけることになります。

**プリレンダリングは `Router` の登録漏れを隠します。** マトリクスが示すとおり、エンドポイント側にだけ登録されたページは、`curl` でも自動化された HTML スナップショットテストでも完璧に描画されます。失敗はインタラクティブルーターが起動してから初めて現れます。ライブラリページのエンドツーエンドテストでは、インタラクティビティを待つ必要があります。たとえば、ボタンをクリックして結果をアサートします。

## 関連記事

- まだ .NET 7 のホスティングモデルを使っている場合は、まず [Blazor Server アプリを Blazor United に移行する](/ja/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/)方法から始め、その後でマルチアセンブリの部分に戻ってください。
- ルーティングされたライブラリページが実際にどのレンダーモードで動作するかについては、[Blazor のレンダーモードとは何か、自分のコンポーネントはどれで動くのか](/ja/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)を参照してください。
- 原因は異なるものの、関連する静的アセットの失敗として [新しい .NET SDK のインストール後に blazor.server.js が 404 Not Found になる問題](/ja/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/)があります。
- ライブラリのページが、親が受け入れられないレンダーモードを宣言している場合は、[親コンポーネントのレンダーモードでは render mode がサポートされないというエラー](/ja/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/)に遭遇します。
- `.Client` と `AddAdditionalAssemblies` の背後にあるプロジェクト構成は、[Blazor Server vs WebAssembly vs United](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)で比較しています。

## 参考資料

- [Route to components from multiple assemblies](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/routing) (Microsoft Learn, ASP.NET Core Blazor routing)
- [Migrate from ASP.NET Core in .NET 8 to ASP.NET Core in .NET 9](https://learn.microsoft.com/en-us/aspnet/core/migration/80-to-90) ("Replace UseStaticFiles with MapStaticAssets" を含みます) (Microsoft Learn)
- [Migrate from ASP.NET Core in .NET 9 to ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/migration/90-to-100) (Microsoft Learn)
- [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0): "Blazor router has a NotFoundPage parameter" と "Blazor script as static web asset"
- [Map static files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/map-static-files) (Microsoft Learn)
- [ASP.NET Core Razor class libraries](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/class-libraries) (Microsoft Learn)
- [`Router.cs` at v10.0.0](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Components/src/Routing/Router.cs): `NotFoundPage` の検証と、廃止予定の `NotFound` パラメーターのソースです (dotnet/aspnetcore)
- [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core): .NET 8 と .NET 10 のサポート終了日について
