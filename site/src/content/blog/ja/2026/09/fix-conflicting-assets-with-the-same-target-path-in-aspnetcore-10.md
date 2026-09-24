---
title: "修正: .NET 10 SDK へのアップグレード後に発生する Conflicting assets with the same target path"
description: ".NET 10 SDK ではすべての Microsoft.NET.Sdk.Web プロジェクトに StaticWebAssetBasePath=/ が設定されるため、Web アプリが別の Web アプリを参照すると衝突します。参照される側のプロジェクトにベースパスを設定してください。圧縮を無効にしても解決しません。"
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "aspnet-core"
  - "blazor"
  - "dotnet-10"
  - "msbuild"
  - "static-web-assets"
lang: "ja"
translationOf: "2026/09/fix-conflicting-assets-with-the-same-target-path-in-aspnetcore-10"
translatedBy: "claude"
translationDate: 2026-09-24
---

**参照される側**のプロジェクト、つまり以前は `wwwroot` が `/_content/...` の下に表示されていたプロジェクトに `<StaticWebAssetBasePath>_content/$(MSBuildProjectName)</StaticWebAssetBasePath>` を追加してください。.NET 10 SDK 以降、すべての `Microsoft.NET.Sdk.Web` プロジェクトのベースパスは `/` になります。そのため、ある Web アプリが別の Web アプリを参照すると、両方が `css/site.css` を同じ URL に公開し、静的 Web アセットのパイプラインがビルドを拒否します。圧縮をオフにしても何も変わりません。チェックは圧縮より前に実行されるからです。以下の内容はすべて macOS 上の SDK 10.0.302 と SDK 9.0.318 で計測したものです。

## エラーの全体像

メッセージは両方のアセットレコードを出力するため長くなります。読む必要がある部分だけに絞ると次のとおりです。

```text
Microsoft.NET.Sdk.StaticWebAssets.targets(640,5): error : Conflicting assets with the same target path
'css/site#[.{fingerprint}]?.css'. For assets
'Identity: .../Common/wwwroot/css/site.css, SourceType: Project, SourceId: Common, ContentRoot: .../Common/wwwroot/,
 BasePath: /, RelativePath: css/site#[.{fingerprint}]?.css, ...' and
'Identity: .../Main/wwwroot/css/site.css, SourceType: Discovered, SourceId: Main, ContentRoot: .../Main/wwwroot/,
 BasePath: /, RelativePath: css/site#[.{fingerprint}]?.css, ...' from different projects.
```

どのケースに該当するかは 3 つのフィールドでわかります。

- **`SourceId`** はアセットを生成する 2 つのプロジェクトの名前です。id が異なる場合はプロジェクト間の衝突です。
- **`SourceType`** はビルド中のプロジェクトなら `Discovered`、プロジェクト参照なら `Project`、NuGet パッケージなら `Package` になります。
- **`BasePath`** は URL のプレフィックスです。参照される側のプロジェクトが `_content/<Name>` ではなく `BasePath: /` と表示されている場合、後述する .NET 10 の変更に該当しています。

ターゲットパスが `.gz` や `.br` で終わることがあるため、このエラーは .NET 9 で導入されたビルド時圧縮のせいにされがちです。しかし現在の SDK では、それが実際の原因であることはまれです。

## .NET 10 SDK でこれが起きる理由

静的 Web アセットは、どのファイルがどの URL に応答するかをビルド時に決定します。マニフェストは 1 つのファイルを 1 つのルートにしかマップできません。.NET 10 より前は、別の Web プロジェクトから*参照される* Web プロジェクトはクラスライブラリのように振る舞っていました。SDK はその `StaticWebAssetBasePath` の既定値を `_content/$(PackageId)` にしていたため、`wwwroot/css/site.css` はホスト内で `/_content/Common/css/site.css` になり、衝突は起きませんでした。

.NET 10 SDK では、すべての `Microsoft.NET.Sdk.Web` プロジェクトがインポートする props ファイルである `Sdk.Server.props` が変更され、次の内容を無条件に設定するようになりました。

```xml
<!-- SDK 10.0.302: Sdks/Microsoft.NET.Sdk.Web/Targets/Sdk.Server.props -->
<PropertyGroup>
  <DebugSymbols Condition="'$(DebugSymbols)' == ''">true</DebugSymbols>
  <StaticWebAssetProjectMode>Root</StaticWebAssetProjectMode>
  <StaticWebAssetBasePath>/</StaticWebAssetBasePath>
</PropertyGroup>
```

SDK 9.0.318 の同じファイルは、どちらのプロパティも設定していません。`Microsoft.NET.Sdk.StaticWebAssets.targets` にある `_content/$(PackageId)` という既定値は `StaticWebAssetBasePath` が空の場合にのみ適用されますが、SDK 10 では Web プロジェクトでこれが空になることはありません。両方の Web アプリが `/` を主張するようになり、両方の `wwwroot` フォルダーで同じ相対パスに存在するすべてのファイルが衝突します。

[dotnet/aspnetcore#62138](https://github.com/dotnet/aspnetcore/issues/62138) での ASP.NET Core チームの立場は、Web アプリが Web アプリを参照する構成はそもそもサポートされていなかった、というものです。"Only class libraries or Blazor apps can be referenced by webapps in a supported capacity." この issue はコード変更なしでクローズされ、現時点ではこの変更は [.NET 10 の破壊的変更のページ](https://learn.microsoft.com/en-us/dotnet/core/compatibility/10)にも [ASP.NET Core 10 の破壊的変更のページ](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/overview)にも記載されていません。多くのアップグレードで予告なしにこの問題に遭遇するのはそのためです。

これを決めるのはターゲットフレームワークではなく **SDK** です。`net8.0` や `net9.0` のプロジェクトでも、SDK 10.x でビルドした瞬間に同じように失敗します。[dotnet/aspnetcore#64726](https://github.com/dotnet/aspnetcore/issues/64726) では `netcoreapp8.0` のアプリでこれが報告されています。

## 最小の再現手順

それぞれ独自の `wwwroot/css/site.css` を持つ空の Web アプリを 2 つ用意し、一方がもう一方を参照します。

```bash
# SDK 10.0.302
dotnet new web -o Main -n Main
dotnet new web -o Common -n Common
mkdir -p Main/wwwroot/css Common/wwwroot/css
echo "body{color:red}/*Main*/"   > Main/wwwroot/css/site.css
echo "body{color:red}/*Common*/" > Common/wwwroot/css/site.css
dotnet add Main/Main.csproj reference Common/Common.csproj
dotnet build Main
```

このプロジェクトの組み合わせで計測した結果です。

| SDK | TargetFramework | 結果 |
| --- | --- | --- |
| 9.0.318 | net9.0 | ビルド成功。ルート: `css/site.css`、`_content/Common/css/site.css` |
| 10.0.302 | net9.0 | `Conflicting assets with the same target path 'css/site#[.{fingerprint}]?.css'` |
| 10.0.302 | net10.0 | 同じエラー |
| 10.0.302 | net10.0、`-p:DisableBuildCompression=true` | 同じエラー |
| 10.0.302 | net10.0、`-p:CompressionEnabled=false` | 同じエラー |
| 10.0.302 | net10.0、`rm -rf */bin */obj` の実行後 | 同じエラー |

覚えておく価値があるのは最後の 3 行です。このエラーで検索すると最初に出てくるアドバイスは、圧縮を無効にするか `bin` と `obj` を削除するというものです。この原因に対しては、どちらも何も変えません。衝突は targets ファイルの 640 行目にある `GenerateStaticWebAssetsManifest` が発生させており、これは圧縮が有効かどうかに関係なく実行されます。

## 修正: 参照される側のプロジェクトに以前のベースパスを戻す

このプロパティはホストではなく、参照される側のプロジェクト(ここでは `Common`)の csproj に記述します。

```xml
<!-- Common.csproj, SDK 10.0.302 -->
<Project Sdk="Microsoft.NET.Sdk.Web">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <StaticWebAssetBasePath>_content/$(MSBuildProjectName)</StaticWebAssetBasePath>
  </PropertyGroup>

</Project>
```

プロジェクトファイルで設定すればうまくいくのは、SDK が `/` を設定しているのが props ファイルであり、それがプロジェクト本体より先に評価されるため、あなたの値が優先されるからです。変更後は `dotnet build Main` が成功し、`Main.staticwebassets.endpoints.json` には両方のルートが含まれます。

```text
_content/Common/css/site.css
_content/Common/css/site.css.gz
css/site.css
css/site.css.gz
(plus the fingerprinted variants of each)
```

`app.MapStaticAssets()` を使ってホストを実行し、両方の URL をリクエストしてみました。`/css/site.css` は `Main` のファイルを、`/_content/Common/css/site.css` は `Common` のファイルを返し、リクエストが許可している場合はどちらも `Content-Encoding: gzip` が付きました。つまり、圧縮されたバリアントは以前とまったく同じようにプロジェクトごとに生成されています。

ベースパスが適用されるのは利用する側からアクセスする場合だけです。変更後に `Common` を単独で実行すると、`/css/site.css` は引き続き 200 を返し、`/_content/Common/css/site.css` は 404 を返しました。スタンドアロンのアプリでもあり参照先でもあるプロジェクトは、両方の役割で動作し続けます。

### ここで `$(PackageId)` を使わないでください

以前の既定値を再現する素直な方法は `_content/$(PackageId)` です。SDK がかつて算出していたのがこの値だからです。しかし csproj からでは機能しません。`PackageId` は後から NuGet の targets で代入されるため、あなたの `PropertyGroup` が評価される時点ではまだ空です。実際に試したところ、ビルドは成功しましたがルートは `_content/css/site.css` になりました。これは修正されたように見えながら、ビューにあるすべての `<link href="_content/Common/...">` を暗黙のうちに壊します。`$(MSBuildProjectName)` を使うか、`AssemblyName` がプロジェクトファイル名と異なりマークアップでアセンブリ名を使っている場合は、名前を直接書いてください。

### より良い方法: Web アプリを参照するのをやめる

`Common` が Razor ビュー、コンポーネント、`wwwroot` のファイルを共有するためだけに存在するなら、Razor クラスライブラリ(`Microsoft.NET.Sdk.Razor`)に変換してください。それがサポートされている構成であり、既定で `_content/{PackageId}` が付与されます。[Blazor の静的ファイルのドキュメント](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0)でもアセットの共有方法としてこれが説明されています。ベースパスのプロパティは、参照されるプロジェクトが本当にアプリとしても実行される必要があるケースのために残しておきましょう。たとえば、実際のアプリを参照する `Microsoft.NET.Sdk.Web` ベースの統合テストホストなどです。

## Blazor Web App の 2 つのプロジェクトに同じファイルがある場合

2 つ目のよくある発生原因は、Web から Web への参照とは関係ありません。対話型 WebAssembly を使う Blazor Web App では、サーバープロジェクトと `.Client` プロジェクトの両方が `/` に寄与します。これは設計どおりです。クライアントのアセットはホストのルートから配信されます。

そのため、両方の `wwwroot` フォルダーに存在するファイルは衝突します。SDK 10.0.302 で `dotnet new blazor -int WebAssembly` テンプレートを使い、`favicon.png` を `W.Client/wwwroot` にコピーして再現しました。

```text
Microsoft.NET.Sdk.StaticWebAssets.targets(640,5): error : Conflicting assets with the same target path
'favicon#[.{fingerprint}]?.png'. For assets 'Identity: .../W.Client/wwwroot/favicon.png, SourceType: Project, ...
```

この場合の修正はベースパスではありません。クライアントのファイルを `_content/` の下に移動させたくはないはずです。各ファイルは 2 つのプロジェクトのどちらか一方だけに置いてください。役立つルールとしては、サーバーでレンダリングされるマークアップだけが必要とするアセットはサーバープロジェクトに、WebAssembly のコードが実行時に読み込むアセットは `.Client` に置きます。クライアントプロジェクトが `index.html`、`favicon`、CSS を所有していた古いホスト型 Blazor WebAssembly テンプレートから移行した場合、これはよくある残骸です。2 つのプロジェクトがルートを共有する理由は [Blazor のホスティングモデルの比較](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)で説明しています。

## 本当に圧縮が原因の場合

ビルド時圧縮は .NET 9 で導入され、.NET 9 のプレビュー期間中は実際にこのエラーを引き起こしていました。`Z.Blazor.Diagrams` 3.0.2 などのパッケージや一部のバンドラー構成は、独自の `.gz` ファイルを `wwwroot` に含めて配布していました。SDK は同じアセットに対して `app.js.gz` を生成しようとし、既に存在するものと衝突していたのです([dotnet/aspnetcore#57512](https://github.com/dotnet/aspnetcore/issues/57512)、[dotnet/sdk#40413](https://github.com/dotnet/sdk/issues/40413))。

これは 2024 年 11 月にクローズされた [dotnet/aspnetcore#57518](https://github.com/dotnet/aspnetcore/issues/57518) で修正されました。現在の SDK は `DiscoverPrecompressedAssets` タスクを実行し、既存の `.gz` や `.br` の兄弟ファイルを認識して、独自に生成する代わりにそれを圧縮バリアントとして扱います。SDK 10.0.302 で両方のケースを確認しました。

- `wwwroot/js/app.js`、`app.js.gz`、`app.js.br` をチェックインした Web アプリ: ビルドも発行も警告ゼロで成功します。エンドポイントマニフェストは `js/app.js` を `gzip` セレクター付きで `js/app.js.gz` にマップし、発行された `app.js.gz` は私が作成したファイルとバイト単位で同一です。再生成されたものではなく、あなたのファイルが配信されます。
- #57512 のパッケージである `Z.Blazor.Diagrams` 3.0.2 を参照する Web アプリ: 問題なくビルドできます。

したがって、SDK 9.0.1xx のプレビューを使っている場合は SDK を更新してください。特定のファイルを圧縮から除外する必要が依然としてある場合、たとえばバンドラーがより良い設定で独自の `.br` を既に書き出している場合は、機能をオフにするのではなく除外リストを使ってください。これも SDK 10.0.302 で検証しました。発行後、`app.bundle.js` には `.gz` も `.br` の兄弟ファイルもなく、同じフォルダーの `other.js` には両方がありました。

```xml
<!-- Host .csproj, SDK 9.0.100 and later -->
<PropertyGroup>
  <CompressionExcludePatterns>$(CompressionExcludePatterns);**/*.bundle.js</CompressionExcludePatterns>
</PropertyGroup>
```

`DisableBuildCompression=true` は `dotnet build` の場合だけ圧縮をスキップし(発行時は引き続き圧縮されます)、`CompressionEnabled=false` は圧縮の targets を完全に取り除きます。どちらもビルド速度のためなら妥当な選択です。ただし、上の表が示すとおり、どちらもベースパスの衝突は解決しません。実行時のレスポンス圧縮はさらに別の機能です。そちらについては [ASP.NET Core API にレスポンス圧縮を追加する方法](/ja/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)を参照してください。

## 落とし穴と似たエラー

**"Two assets found targeting the same path with incompatible asset kinds" は別のエラーです。** これは*単一の*プロジェクト内で発生します。たとえば `<Content Include="shared/app.js" Link="wwwroot/js/app.js" />` アイテムが実際の `wwwroot/js/app.js` と同じルートを指している場合です。SDK 10.0.302 で、同じ targets ファイルの 706 行目から発生することを再現しました。2 つのアイテムのどちらかを削除してください。

**`An item with the same key has already been added` を伴う `The "DiscoverPrecompressedAssets" task failed unexpectedly`** は関連する .NET 10 のバグで、これも Web プロジェクトが別の Web プロジェクトを参照することで発生し、キーが `microsoft.aspnetcore.app.internal.assets` 内の `blazor.web.js` を指していることがよくあります。[dotnet/sdk#52089](https://github.com/dotnet/sdk/issues/52089) としてまだオープンのままです。上記のベースパスの修正は重複登録を根本から取り除くので、最初に試すべきものです。アップグレード後に Blazor のスクリプトが見つからない問題も追っている場合、そのパッケージについては [blazor.server.js の 404 に関する記事](/ja/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/)で説明しています。

**エラーがビルドごとに出たり出なかったりする場合**は、静的 Web アセットの targets が `wwwroot` を読み取っている最中に、そこへ書き込むビルドステップ(TypeScript、LibMan、JS バンドラー)を疑ってください。[dotnet/sdk#52014](https://github.com/dotnet/sdk/issues/52014) には、このエラーや `No file exists for the asset`、`The asset ... can not be found` として表面化する競合状態が記録されています。これは単一のターゲットフレームワークでも再現します。確実な修正は、`BeforeTargets="Build"` のターゲットから実行するのではなく、ジェネレーターを MSBuild の前の独立したステップとして実行すること(CI と起動プロファイルで `npm run build && dotnet build`)です。そうすれば、SDK が `wwwroot` の glob を評価する時点でファイルが既にディスク上に存在します。binlog(`dotnet build -bl`)を見ると実行順序がわかります。[binlog MCP サーバー](/ja/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/)を使うと手早くクエリできます。

**`global.json` で SDK 9 に固定する方法は機能しますが、あくまで一時しのぎです。** 再現プロジェクトは、.NET 10 SDK を並行してインストールしていても 9.0.318 で問題なくビルドできます。ただしその場合 `net10.0` プロジェクトはビルドできず、実際の衝突は先送りされるだけです。どの SDK からリポジトリでの失敗が始まったかを二分探索で調べる必要があるなら、[dotnetup](/ja/2026/06/dotnetup-official-dotnet-sdk-version-manager/) を使えば SDK の切り替えが簡単になります。

**以前の "すべての `.gz` StaticWebAsset を削除する" ターゲットはもう不要です。** #57512 にある、`ResolveStaticWebAssetsConfiguration` の前に拡張子 `.gz` の `StaticWebAsset` アイテムを削除する回避策は、.NET 9 のプレビュー向けのものでした。SDK 10 では、SDK が現在正しく処理している事前圧縮済みファイルを捨ててしまううえ、ベースパスのケースには何の効果もありません。

## 関連記事

- [修正: 新しい .NET SDK をインストールした後の blazor.server.js の 404 Not Found](/ja/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/)。ターゲットフレームワークではなく SDK とともにやってくる、静的 Web アセットのもう 1 つの変更です。
- [.NET 11 における Blazor Server vs Blazor WebAssembly vs Blazor United](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)。サーバープロジェクトと `.Client` プロジェクトが `/` を共有する理由について。
- [ASP.NET Core 11 API にレスポンス圧縮を追加する方法](/ja/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)。ビルド時のアセット圧縮に対応する実行時の仕組みです。
- [.NET binlog 用の MCP サーバー](/ja/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/)。どのターゲットが衝突するアセットを生成したかを追跡するために。
- [dotnetup: 公式の .NET SDK バージョンマネージャー](/ja/2026/06/dotnetup-official-dotnet-sdk-version-manager/)。複数の SDK に対してリポジトリをテストするために。

## 出典

- [dotnet/aspnetcore#62138](https://github.com/dotnet/aspnetcore/issues/62138): SDK 10 preview 5 のリグレッション、`StaticWebAssetBasePath` による回避策、そして "サポート対象外" という結論。
- [dotnet/aspnetcore#64726](https://github.com/dotnet/aspnetcore/issues/64726): 新しい SDK をインストールした後の `netcoreapp8.0` アプリで発生した同じエラー。
- [dotnet/aspnetcore#57512](https://github.com/dotnet/aspnetcore/issues/57512) と [dotnet/aspnetcore#57518](https://github.com/dotnet/aspnetcore/issues/57518): .NET 9 における事前圧縮済みのパッケージアセットとその修正。
- [dotnet/sdk#40413](https://github.com/dotnet/sdk/issues/40413): 圧縮の設定(`DisableBuildCompression`、`BuildCompressionFormats`、`CompressionExcludePatterns`)。
- [dotnet/sdk#52089](https://github.com/dotnet/sdk/issues/52089) と [dotnet/sdk#52014](https://github.com/dotnet/sdk/issues/52014): 症状が重なる、未解決の .NET 10 静的 Web アセットのバグ。
- Microsoft Learn の [ASP.NET Core Blazor の静的ファイル](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0)。
- ローカルで調査した SDK ソース: SDK 10.0.302 と 9.0.318 の `Sdk.Server.props`、`Microsoft.NET.Sdk.StaticWebAssets.targets`、`Microsoft.NET.Sdk.StaticWebAssets.Compression.targets`。
