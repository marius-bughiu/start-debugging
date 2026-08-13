---
title: "解決: 新しい .NET SDK をインストールした後に blazor.server.js が 404 Not Found になる"
description: ".NET 10 では Blazor スクリプトが埋め込みリソースではなくなったため blazor.server.js が 404 になります。ホストプロジェクトに RequiresAspNetWebAssets を追加するか、.razor ファイルを置いてください。"
pubDate: 2026-08-13
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnet-core"
  - "dotnet-10"
  - "dotnet-11"
  - "static-web-assets"
lang: "ja"
translationOf: "2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk"
translatedBy: "claude"
translationDate: 2026-08-13
---

ホストプロジェクトに `<RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>` を追加して restore を実行してください。.NET 10 では Blazor スクリプトが `Microsoft.AspNetCore.Components.Server` の埋め込みリソースではなくなり、NuGet パッケージ `Microsoft.AspNetCore.App.Internal.Assets` のファイルになりました。このパッケージは、プロジェクトに `.razor` ファイルが 1 つ以上ある場合にのみ SDK が取り込みます。ホストに `.razor` ファイルがなければスクリプトもなく、404 になります。以下の内容はすべて、Windows 11 上の SDK 10.0.201 と ASP.NET Core 10.0.5 で計測しました。

## エラーの実際の姿

.NET 6 以来まったく変更していない `_Host.cshtml` から出るブラウザーコンソールの出力です。

```
GET https://localhost:5001/_framework/blazor.server.js net::ERR_ABORTED 404 (Not Found)
Uncaught ReferenceError: Blazor is not defined
```

ページはプリレンダリング済みの HTML を表示したあと、何も起きません。circuit は開かず、ボタンも動かず、サーバーのログは静かなままです。静的ファイルミドルウェアからの 404 は例外ではないからです。Blazor Web App では `_framework/blazor.web.js` にまったく同じことが起きます。

わかりにくいのはきっかけです。プロジェクトファイルは変わっていません。多くの場合、ターゲットフレームワークも変わっていません。誰かが .NET 10 SDK をインストールしただけで、昨日までビルドできて動いていたアプリが、たった 1 つのファイルに対して 404 を返すようになります。

## スクリプトが消えた理由

.NET 9 までは、`blazor.server.js` は共有フレームワークのアセンブリ内の埋め込みリソースであり、`MapBlazorHub()` がそのアセンブリから読み出す専用のエンドポイントを登録していました。このエンドポイントがファイルを見つけ損なうことはありえません。ファイルはエンドポイントを登録している DLL の中にあったからです。

.NET 10 はこれを削除しました。ASP.NET Core チームの Javier Calvarro Nelson は、最初にこれが報告されたとき[はっきりとこう述べています](https://github.com/dotnet/aspnetcore/issues/64381#issuecomment-3546832403)。

"In 10.0, we stopped embedding the `server.js` and the `.web.js` files inside their respective assemblies so that we can compress and fingerprint them like any other files."

これは本当に利点があります。スクリプトはビルド時の Gzip、発行時の Brotli、URL に含まれるコンテンツハッシュ、そして 1 年間の immutable な `Cache-Control` を得ました。しかし、ファイルの出どころが変わります。今やこれは静的 Web アセットであり、SDK が裏側で restore グラフに追加する NuGet パッケージによって提供されます。私の環境では次のとおりです。

```
C:\Users\mariu\.nuget\packages\microsoft.aspnetcore.app.internal.assets\10.0.5\_framework\
  blazor.server.js
  blazor.server.js.map
  blazor.web.js
  blazor.web.js.map
  blazor.webassembly.js
  blazor.webassembly.js.map
```

バージョンを固定するのはプロジェクトではなく SDK です。SDK インストール内の `Microsoft.NETCoreSdk.BundledVersions.props` が決めています。

```xml
<!-- C:\Program Files\dotnet\sdk\10.0.201\Microsoft.NETCoreSdk.BundledVersions.props -->
<KnownAspNetCorePack Include="Microsoft.AspNetCore.App.Internal.Assets"
                     TargetFramework="net10.0"
                     AspNetCorePackVersion="10.0.5" />
```

そして、実際に 404 を引き起こしているのがここです。SDK はすべての Web プロジェクトにこのパッケージを追加するわけではありません。ほとんどの Web プロジェクトは Blazor アプリではありませんし、minimal API に Blazor スクリプトをダウンロードしたい人はいないからです。SDK はたった 1 つのヒューリスティックで推測します。

```xml
<!-- Sdks\Microsoft.NET.Sdk.Web.ProjectSystem\targets\Microsoft.NET.Sdk.Web.ProjectSystem.targets -->
<Target Name="ResolveRequiredWebAssets" BeforeTargets="ProcessFrameworkReferences">
  <PropertyGroup>
    <RequiresAspNetWebAssets
      Condition="'$(RequiresAspNetWebAssets)' == '' and @(Content->AnyHaveMetadataValue(Extension, .razor))">true</RequiresAspNetWebAssets>
  </PropertyGroup>
</Target>
```

ホストプロジェクトの `Content` 項目に `.razor` ファイルがあれば、パッケージが取り込まれます。なければ `RequiresAspNetWebAssets` は既定値の `false` に落ち、パッケージは一度も復元されず、`_framework/blazor.server.js` はアプリの静的 Web アセットマニフェストに単純に存在しません。ビルド時の警告は一切ありません。ビルドは成功します。

現実の Blazor Server アプリには、ホストプロジェクトに `.razor` ファイルが 1 つもないものが数多くあります。コンポーネントが Razor Class Library にあり、ホストが `Program.cs`、`_Host.cshtml`、プロジェクト参照だけで構成されている場合、ヒューリスティックは「Blazor アプリではない」と判断し、404 が返ります。

## 最小の再現

RCL から Blazor Server コンポーネントを提供する ASP.NET Core ホストです。特別なことは何もしていません。

```xml
<!-- BzSrv.csproj, .NET 10, SDK 10.0.201 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\BzLib\BzLib.csproj" />
  </ItemGroup>
</Project>
```

```csharp
// Program.cs, .NET 10, ASP.NET Core 10.0.5
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorPages();
builder.Services.AddServerSideBlazor();

var app = builder.Build();
app.UseStaticFiles();
app.MapBlazorHub();
app.MapFallbackToPage("/_Host");
app.Run();
```

```html
<!-- Pages/_Host.cshtml -->
<component type="typeof(App)" render-mode="ServerPrerendered" />
<script src="_framework/blazor.server.js"></script>
```

ビルドして、restore が何を決めたかを確認します。

```bash
dotnet build
grep -o "Microsoft.AspNetCore.App.Internal.Assets/[0-9.]*" obj/project.assets.json
# (no output)
grep -c "blazor.server.js" bin/Debug/net10.0/BzSrv.staticwebassets.runtime.json
# 0
```

パッケージは restore グラフになく、スクリプトはマニフェストにありません。リクエストすると、本文 0 バイトの HTTP 404 が返ります。`.razor` ファイルを 1 つホストプロジェクトに移すか、下記のプロパティを設定すれば、どちらのカウントも 0 ではなくなります。

## 修正方法

**ホストプロジェクトでプロパティを設定する。** これがサポートされている回避策であり、ASP.NET Core チームが案内しているものです。設定先は `Microsoft.NET.Sdk.Web` を使うプロジェクト、つまり実際にリクエストを処理する側であって、RCL ではありません。

```xml
<!-- BzSrv.csproj, .NET 10 / .NET 11 -->
<PropertyGroup>
  <RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>
</PropertyGroup>
```

そのあとで restore を実行します。パッケージがグラフに入るのはビルド時ではなく restore 時だからです。

```bash
dotnet restore
```

`dotnet build` は暗黙の restore を実行するので、通常のリビルドなら大抵は反映されます。プロパティ追加前に実行した restore に対して `dotnet build --no-restore` を走らせる CI ステップでは反映されません。変更後は 2 つの確認がどちらも肯定的になり、ファイルは 164838 バイトで配信されます。

**あるいはホストに `.razor` ファイルを追加する。** `App.razor`（または任意のコンポーネント）をホストプロジェクトに戻せば、MSBuild プロパティなしでヒューリスティックを満たせます。もともと置くつもりだったなら問題ありませんが、コードを移動する理由としては奇妙ですし、プロパティのほうが意図を明確に表します。

**`MapStaticAssets()` に飛びつかないでください。** これはこのエラーに関して最もよくある誤ったアドバイスで、何時間も無駄にするため具体的に書いておく価値があります。動いているパイプラインを `MapStaticAssets()` に移行しても、欠けているパッケージは直りませんし、`UseStaticFiles()` は最初から問題ではありませんでした。チームはこの診断に基づいたコミュニティからの [PR をクローズしました](https://github.com/dotnet/aspnetcore/pull/66060#issuecomment-5068880296)。

"`blazor.web.js` and `blazor.server.js` are shipped as static web assets, and `app.UseStaticFiles()` already serves them without `MapStaticAssets()` (this is what our own server-side Blazor E2E tests exercise, using `UseStaticFiles()` and `MapBlazorHub()` with no `MapStaticAssets()` call)."

これは私の計測結果と一致します。パッケージがあれば、`UseStaticFiles()` と `MapBlazorHub()` は Development でも発行済み出力からでもスクリプトを配信し、`MapStaticAssets()` はどこにも必要ありません。

## 各構成が実際に返すもの

同じ再現プロジェクトに対する 9 回の実行です。いずれも実際の Kestrel プロセスへの `/_framework/blazor.server.js` の HTTP リクエストです。

| ホストプロジェクト | パイプライン | 環境 | 実行元 | 結果 |
| --- | --- | --- | --- | --- |
| `.razor` あり | `UseStaticFiles()` | Development | `dotnet run` | 200、164838 バイト |
| `.razor` あり | `UseStaticFiles()` | Development | ビルド出力 | 200 |
| `.razor` あり | `UseStaticFiles()` | Production | ビルド出力 | **404** |
| `.razor` あり | `UseStaticFiles()` | Production | 発行出力 | 200 |
| `.razor` あり | `MapStaticAssets()` | Development | ビルド出力 | 200 |
| `.razor` あり | `MapStaticAssets()` | Production | ビルド出力 | **500** |
| `.razor` なし | `UseStaticFiles()` | Development | ビルド出力 | **404** |
| `.razor` なし、プロパティ設定済み | `UseStaticFiles()` | Development | ビルド出力 | 200 |
| `EnableDefaultContentItems=false` | 任意 | 任意 | 任意 | パッケージが復元されない |

2 つの行は個別の説明に値します。

**プロジェクトが正しく構成されていても、Production でビルド出力を実行すると 404 になります。** `WebApplication.CreateBuilder` が `UseStaticWebAssets()` を呼ぶのは Development 環境のときだけです。Development では、静的 Web アセットマニフェストが `_framework/` を先ほど示した NuGet キャッシュフォルダーへ直接マッピングします。それ以外の環境ではこのマッピングは適用されず、ビルド出力には独自の `wwwroot/_framework/` がないため、配信するものがありません。発行出力が問題ないのは、`dotnet publish` が実際のファイル（および `.gz` と `.br` のバリアント）を `wwwroot/_framework/` にコピーするからです。これは `ASPNETCORE_ENVIRONMENT=Staging` で `dotnet build` の出力を実行する CI のスモークテストやコンテナーイメージを直撃します。.NET 10 で新しく生まれた挙動ではありませんが、.NET 10 より前は埋め込みリソースのエンドポイントがこのファイルに関してだけそれを覆い隠していました。

**同じ構成を `MapStaticAssets()` で動かすと 404 ではなく 500 になります。** これは診断に役立ちます。エンドポイントは `BzSrv.staticwebassets.endpoints.json` から登録され、このファイルは出力ディレクトリにコピーされて環境に関係なく読まれるため、ルーティングは一致します。そのうえでファイルプロバイダーがバイトを取得できません。

```
System.IO.FileNotFoundException: Could not find file '...\BzSrv\wwwroot\_framework\blazor.server.js'.
   at System.IO.FileInfo.get_Length()
   at Microsoft.AspNetCore.Builder.StaticAssetDevelopmentRuntimeHandler...
```

このスタックトレースを伴う 500 は、マニフェストはスクリプトを知っているがファイルプロバイダーが到達できないという意味です。つまりパッケージは問題なく、環境か出力ディレクトリが間違っています。素の 404 は、マニフェストに最初から入っていなかったという意味です。つまりパッケージが欠けており、`RequiresAspNetWebAssets` が解決策です。

## 落とし穴と紛らわしいケース

**`EnableDefaultContentItems=false` はヒューリスティックを黙って無効化します。** MSBuild の条件が調べるのは `Content` 項目であって、ディスク上のファイルではありません。`Program.cs` のすぐ隣に `App.razor` があるホストプロジェクトでも、既定のコンテンツ glob が無効ならパッケージは復元されません。検証済みです。同じプロジェクト、同じファイルで、パッケージは存在しませんでした。コンテンツ項目をカスタマイズしているプロジェクトでは、プロパティを明示的に設定してください。

**`Microsoft.NET.Sdk.Razor` のプロジェクトは決して自動検出しません。** `ResolveRequiredWebAssets` ターゲットは `Microsoft.NET.Sdk.Web.ProjectSystem.targets` にのみ同梱されています。ホストが Razor SDK を使っていたり `<OutputType>Library</OutputType>` を設定していたりすると、コンポーネントをいくつ含んでいても `RequiresAspNetWebAssets` を設定してくれるものはありません。これが [dotnet/aspnetcore#64545](https://github.com/dotnet/aspnetcore/issues/64545) で報告された形です。プロパティを手動で設定してください。

**`packages.lock.json` があると、この修正がビルド失敗に変わります。** プロパティを追加すると restore グラフが変わるため、ロックされた restore は次の明確なメッセージで拒否します。覚えておく価値があります。

```
error NU1004: The package references have changed for net10.0. Lock file's package references: None,
project's package references: Microsoft.AspNetCore.App.Internal.Assets >= 10.0.5. The packages lock
file is inconsistent with the project dependencies so restore can't be run in locked mode.
```

ロックファイルを一度再生成してコミットしてください。

```bash
dotnet restore --force-evaluate
```

**restore がパッケージに到達できる必要があります。** これは nuget.org にある実在のパッケージであり、SDK インストールに同梱されているものではありません。ネットワークから隔離されたビルドや、上流のミラーを持たないプライベートフィードでは見つかりません。しかも、どのバージョンが要求されるかを決めるのはターゲットフレームワークではなく SDK のバージョンです。新しい SDK のパッチをインストールすれば、オフラインフィードにはそれに対応する新しい `Microsoft.AspNetCore.App.Internal.Assets` が必要になります。

**パッケージのフォルダーが消えると、アプリは 404 を返すのではなく起動しなくなります。** 古いビルド出力が残ったまま NuGet キャッシュをクリアすると、Kestrel がバインドする前の起動時に次が出ます。

```
Unhandled exception. System.IO.DirectoryNotFoundException: ...\microsoft.aspnetcore.app.internal.assets\10.0.5\_framework\
   at Microsoft.AspNetCore.Hosting.StaticWebAssets.StaticWebAssetsLoader.UseStaticWebAssetsCore(...)
   at Microsoft.AspNetCore.Builder.WebApplication.CreateBuilder(String[] args)
```

`bin` 内のマニフェストはパッケージキャッシュへの絶対パスを保持しています。`bin` と `obj` を削除してリビルドしてください。

**.NET 9 のアプリは、アップグレードしていなくてもこれに遭遇しえます。** [dotnet/aspnetcore#65353](https://github.com/dotnet/aspnetcore/issues/65353) は、.NET 10 SDK をインストールした途端に 404 を返し始めた `net9.0` の Blazor アプリです。原因は環境変数の `DOTNET_ROLL_FORWARD=LatestMajor` でした。アプリはスクリプトがもう埋め込まれていない 10.0 ランタイムへロールフォワードしつつ、パッケージを決して復元しない .NET 9 プロジェクトとしてビルドされ続けていたのです。プロジェクトファイルに手を入れる前に、`dotnet --info` でこの変数を確認してください。9.0 ランタイムで実行すれば埋め込みリソースはそのまま存在し、.NET 10 SDK があってもなくてもすべて動きます。

**ドキュメントは影響範囲を控えめに書いています。** [Blazor プロジェクト構造の記事](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0)には、`.razor` ファイルが必要なのは "in order to automatically include the Blazor script when the app is published" とあります。実際には `dotnet build` にも影響します。上記の再現は、誰かが何かを発行するよりずっと前、Development の `dotnet run` の時点で 404 になります。

**.NET 11 でもこれは変わりません。** 静的アセットの配信モデルと `RequiresAspNetWebAssets` プロパティはどちらも引き継がれており、上記のドキュメントページは `aspnetcore-10.0` と `aspnetcore-11.0` の両方のモニカーに等しく適用されます。10 より先へアップグレードしても、この要件はなくなりません。

## 関連記事

アップグレードの途中で、これが一度に壊れた複数の問題のうちの 1 つなら、Blazor 関連の項目は [.NET 8 から .NET 11 へのチェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)にまとまっており、同じ移行のレンダーモード側は [Blazor Server アプリを Blazor United へ移行する](/ja/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/)にあります。スクリプトが読み込まれて circuit が実際に開いたあと、次に遭遇しやすい 2 つの障害は、[circuit が切断された後の再接続バナー](/ja/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/)と、[プリレンダリング中に JavaScript 相互運用の呼び出しを発行できない問題](/ja/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)です。そもそもホストがコンポーネントをホストし続けるべきかを検討しているなら、[Blazor Server と WebAssembly と United の比較](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)がトレードオフを扱っています。

## 参考資料

- [ASP.NET Core Blazor project structure](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0)：`RequiresAspNetWebAssets` プロパティと、`.razor` ファイルが 1 つ以上必要というルールについて。
- [ASP.NET Core Blazor static files](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0)：`MapStaticAssets` と `UseStaticFiles` の違い、それぞれが配信できるものとできないものについて。
- [dotnet/aspnetcore#64381](https://github.com/dotnet/aspnetcore/issues/64381)：最初の報告。スクリプトが埋め込みリソースでなくなった理由に関するチームの説明を含みます。
- [dotnet/aspnetcore#66175](https://github.com/dotnet/aspnetcore/issues/66175)：Blazor Server アプリのアップグレード後に SDK 10.0.201 で発生した同じ 404。プロパティの追加でクローズされました。
- [dotnet/aspnetcore#66059](https://github.com/dotnet/aspnetcore/issues/66059) と[そこから提案された PR](https://github.com/dotnet/aspnetcore/pull/66060)：旧来の埋め込みリソースのエンドポイントを戻す案が却下された理由と、`UseStaticFiles()` が現在もこれらのファイルを配信するという確認。
- [dotnet/aspnetcore#65353](https://github.com/dotnet/aspnetcore/issues/65353)：SDK インストール後に `net9.0` アプリを壊すロールフォワードのバリエーション。
- [dotnet/aspnetcore#64545](https://github.com/dotnet/aspnetcore/issues/64545)：`OutputType` と非 Web SDK のバリエーション。
