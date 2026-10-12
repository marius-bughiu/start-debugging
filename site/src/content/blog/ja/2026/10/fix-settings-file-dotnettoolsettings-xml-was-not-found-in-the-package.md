---
title: "修正: Settings file 'DotnetToolSettings.xml' was not found in the package"
description: "ツールパッケージがインストールを実行している SDK よりも新しい .NET を対象としているか、そもそも .NET ツールではありません。新しい SDK を使うか、互換性のある tools フォルダーを持つツールのバージョンを固定するか、--framework を強制してください。"
pubDate: 2026-10-12
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "dotnet-tools"
  - "ef-core"
lang: "ja"
translationOf: "2026/10/fix-settings-file-dotnettoolsettings-xml-was-not-found-in-the-package"
translatedBy: "claude"
translationDate: 2026-10-12
---

パッケージが壊れていることはほとんどなく、NuGet キャッシュをクリアしても解決しません。このメッセージは、`dotnet tool install` を実行している SDK が、使用を許可された `tools/<tfm>/` フォルダーを見つけられなかったことを意味します。よくある原因は、SDK 自体よりも新しい .NET だけを対象にビルドされたツールです。たとえば SDK 8 や 9 で `dotnet-ef` 10.0.0/10.0.1 や 11.0 をインストールする場合が該当します。インストールが失敗するフォルダーで `dotnet --version` を実行してください。そのうえで、ツールの対象フレームワークと同じかそれより新しい SDK に移行するか、古い `tools/` フォルダーを含むツールのバージョンを固定します(`dotnet-ef` 10.0.2 以降は再び `net8.0` を含んでいます)。パッケージがそもそも .NET ツールではない場合(`Microsoft.EntityFrameworkCore.Tools`、`Microsoft.EntityFrameworkCore.Design`)は、代わりに `dotnet-ef` をインストールしてください。以下の内容はすべて、2026-10-12 に macOS arm64 上の SDK 8.0.425、9.0.318、10.0.302 を使い、実際の nuget.org に対して再現したものです。

## エラーの状況

`dotnet tool install`(グローバル、`--tool-path`、ローカルのいずれでも)は、以前に何もインストールしていないクリーンなマシンでも次のように出力します。

```
Tool 'dotnet-ef' failed to update due to the following:
The settings file in the tool's NuGet package is invalid: Settings file 'DotnetToolSettings.xml' was not found in the package.
Tool 'dotnet-ef' failed to install. Contact the tool author for assistance.
```

"Failed to update" という表現は誤解を招きます。初回インストールでも表示されます。`dotnet tool restore` と `dotnet dnx` も同じコードパスを通りますが、例外をラップしないため、ツールマニフェストのあるリポジトリでは次のような生の形式で表示されます。

```
Unhandled exception: Settings file 'DotnetToolSettings.xml' was not found in the package.
```

どちらの形式も終了コード 1 で終了します。SDK がどのフレームワークを探していたのかは出力のどこにも書かれていないため、多くの人がキャッシュを削除したり SDK を再インストールしたりと、手当たり次第に試すことになります。

## なぜ起きるのか

.NET ツールパッケージはペイロードを `tools/<target framework>/<rid>/` の下に置き、`DotnetToolSettings.xml` はそのフォルダーの中にあります。ファイルは存在しますが、フレームワークフォルダーの内側だけです。SDK はパッケージ全体からこのファイルを探しません。NuGet のアセット選択ルールで合成アセットファイルを作り、**最も近い互換フレームワークフォルダー**にある項目を要求します。.NET 10 SDK のソース(`ToolPackageDownloader.CreateAssetFile`)では、対象フレームワークは CLI が動作しているランタイムから決まります。

```csharp
// dotnet/sdk, release/10.0.3xx: src/Cli/dotnet/ToolPackage/ToolPackageDownloader.cs
currentTargetFramework = new NuGetFramework(
    FrameworkConstants.FrameworkIdentifiers.NetCoreApp,
    new Version(Environment.Version.Major, Environment.Version.Minor));
```

SDK 9.0.318 は .NET 9 ランタイム上で動作するため、`net9.0` を要求します。`tools/net10.0/any/` しか含まないパッケージには互換フォルダーがなく、選択された項目リストは空になります。続いて `ToolPackageInstance.DeserializeToolConfiguration` が `MissingToolSettingsFile` をスローし、これが表示されるメッセージになります。実際には、このテキストは"この SDK が実行できるフレームワークを対象とする `tools/` フォルダーがない" という意味です。

意外に思われる点が 2 つあります。

1. **インストール済みのランタイムは考慮されません。** SDK 9.0.318 の隣に .NET 10.0.12 ランタイムを追加しても、`dotnet-ef` 10.0.1 の通常のインストールは同じメッセージで失敗しました。意味を持つのは SDK 自身のランタイムバージョンだけです。
2. **パッケージ種別のチェックは後で行われ、しかも SDK 10 だけです。** SDK 10 は最初に nuspec の `packageType` を確認し、ツールではないパッケージには"is not a .NET tool" というわかりやすいメッセージを出します。SDK 8 と 9 はこのチェックを行わず、同じ誤解を招くメッセージに落ちます。

つまり、1 つの文字列の背後には 3 つの実際の原因があり、頻度の高い順に並べると次のとおりです。

- **ツールが SDK よりも新しい .NET を対象としている。** 新しいメジャーリリースの後に最もよく起きます(`dotnet-ef` 10.0.0/10.0.1、`AzureSignTool` 7.0.0、`net10.0` や `net11.0` だけを対象にビルドされたあらゆるツール)。
- **ツールが .NET 10 の RID 固有(プラットフォーム固有)ツールである。** ルートパッケージにも `tools/net10.0/` フォルダーしかないため、古い SDK では同じように失敗します。
- **パッケージがツールではない。** ライブラリや MSBuild/PowerShell パッケージを、誤って `dotnet tool install` でインストールしている場合です。

## 最小限の再現手順

これらのコマンドは `--tool-path` を使うため、グローバルツールフォルダーには影響しません。各ブロックは、それを実行した SDK のバージョンを示しています。

```bash
# SDK 9.0.318 (also identical on SDK 8.0.425)
dotnet tool install dotnet-ef --version 10.0.1 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install dotnet-ef --version 11.0.0-rc.1.26425.128 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install AzureSignTool --version 7.0.0 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install dotnet-ef --tool-path ./tools
# Tool 'dotnet-ef' (version '10.0.12') was successfully installed.  exit 0
```

最後の行が重要です。バージョンを指定しない `dotnet tool install dotnet-ef` は現在 10.0.12 に解決され、SDK 8 と 9 でも動作します。失敗が現れるのはバージョンを固定している場合だけで、たとえば `dotnet-tools.json` マニフェストや、2025 年 11 月に書かれた CI スクリプトがそうです。nuget.org で確認した各 `dotnet-ef` バージョンの `tools/` 構成は次のとおりです。

| dotnet-ef バージョン | tools フォルダー | SDK 8 / 9 でインストール可能 | SDK 10 でインストール可能 |
|---|---|---|---|
| 8.0.21 | `tools/net8.0/any/` | はい | はい |
| 9.0.10 | `tools/net8.0/any/` | はい | はい |
| 10.0.0, 10.0.1 | `tools/net10.0/any/` | **いいえ** | はい |
| 10.0.2 to 10.0.12 | `tools/net8.0/any/` | はい | はい |
| 11.0.0-rc.1.26425.128 | `tools/net10.0/any/` | **いいえ** | はい |

メジャーバージョンが 1 つ上でも同じことが起きます。簡単なツールを再パッケージして唯一のフォルダーを `tools/net11.0/any/` にしたところ、SDK 10.0.302 は同一のメッセージで拒否しました。SDK 10 の `dotnet dnx` も、同じパッケージに対して "Unhandled exception" 形式を出力しました。

## 修正方法の詳細

### 1. そのフォルダーで実際にどの SDK が動いているか確認する

`global.json` はディレクトリごとに SDK を選択するため、リポジトリで `dotnet tool restore` を実行する SDK が、インストールされている最新の SDK とは限りません。

```bash
# Any SDK. Run in the directory where the install fails.
dotnet --version
dotnet --list-sdks
cat global.json 2>/dev/null
```

`dotnet --version` が `8.0.x` または `9.0.x` を表示し、ツールが `net10.0` を対象としているなら、それが答えです。CI では、古い SDK しかないランナーイメージや、8.0 を固定する `global.json` を `actions/setup-dotnet` が読み込むことで同じ不一致が起こります。ランナーが SDK をどう選ぶかについては、["the command dotnet could not be found" の CI での解説](/ja/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/)を参照してください。

### 2. 推奨: ツールの対象と同じかそれより新しい SDK でツールを実行する

```json
// global.json, .NET 10 SDK. rollForward keeps you on the newest 10.0 feature band.
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestFeature"
  }
}
```

.NET 10 SDK は `net8.0` と `net9.0` のプロジェクトを変更なしでビルドできるため、SDK を上げてもアプリの対象フレームワークを変更する必要はありません。マニフェスト内の他のすべてのツールにも利点があるため、これが最もすっきりした修正です。いずれ全面的に移行する予定なら、[.NET 8 から .NET 11 へのチェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)に、想定される SDK レベルの破壊的変更が載っています。

### 3. SDK を変更できない場合: 互換性のあるフォルダーを持つツールのバージョンを固定する

`dotnet-ef` の場合、10.0.2 以降のどのビルドも `tools/net8.0/` を含んでおり、SDK 8 と 9 でインストールできます。

```bash
# SDK 8.0.425 or 9.0.318
dotnet tool install --global dotnet-ef --version 10.0.12
```

```json
// .config/dotnet-tools.json, works with SDK 8, 9 and 10
{
  "version": 1,
  "isRoot": true,
  "tools": {
    "dotnet-ef": { "version": "10.0.12", "commands": [ "dotnet-ef" ], "rollForward": false }
  }
}
```

ツールには、実行できるランタイムも引き続き必要です。`dotnet-ef` 10.0.12 の `net8.0` ビルドは、.NET 8 ランタイムだけをインストールした SDK 8.0.425 で問題なく動作しました。他のツールについては、固定する前にパッケージの中身を確認してください。nuget.org の "Frameworks" タブに表示されますし、アーカイブを直接一覧することもできます。

```bash
# Any OS with curl and unzip. Replace the id and version.
curl -sL https://api.nuget.org/v3-flatcontainer/dotnet-ef/10.0.1/dotnet-ef.10.0.1.nupkg -o t.nupkg
unzip -l t.nupkg | grep DotnetToolSettings
#   tools/net10.0/any/DotnetToolSettings.xml
```

使えるバージョンがすべて新しいフォルダーしか持たない場合は、修正 2 に戻ってください。

### 4. 最終手段: `--framework` でフレームワークを強制する

`dotnet tool install` と `dotnet tool update` は `--framework` を受け取り、その値が上記のアセット選択における `Environment.Version` の代わりになります。新しいランタイムが並行してインストールされていれば、古い SDK でも新しいポータブルツールをインストールできます。

```bash
# SDK 9.0.318 with the .NET 10.0.12 runtime installed next to it
dotnet tool install --global dotnet-ef --version 10.0.1 --framework net10.0
# Tool 'dotnet-ef' (version '10.0.1') was successfully installed.
dotnet-ef --version
# 10.0.1
```

.NET 10 ランタイムがなくてもインストールは "成功" しますが、ツールは初回実行で失敗します。.NET 8 しかない SDK 8.0.425 では、`dotnet-ef` は "You must install or update .NET to run this application" と報告し、`Microsoft.NETCore.App` 10.0.0 を要求しました。`dotnet tool restore` には `--framework` オプションがないため、これが有効なのはグローバルインストールと `--tool-path` インストールだけです。パイプラインの修正ではなく、応急処置として扱ってください。

### 5. パッケージがツールではない場合: 正しいパッケージをインストールする

`Microsoft.EntityFrameworkCore.Tools` は Visual Studio 用のパッケージマネージャーコンソールのパッケージで、`Microsoft.EntityFrameworkCore.Design` はスタートアッププロジェクトが参照するデザイン時ライブラリです。どちらも .NET ツールではありません。各 SDK が何を出力するかはバージョンによって異なります。

```bash
# SDK 8.0.425 and 9.0.318
dotnet tool install --global Microsoft.EntityFrameworkCore.Tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.

# SDK 8.0.425 and 9.0.318
dotnet tool install --global Microsoft.EntityFrameworkCore.Design
# Unhandled exception: System.IO.DirectoryNotFoundException: Could not find a part
# of the path '.../microsoft.entityframeworkcore.design/10.0.12/tools'.

# SDK 10.0.302
dotnet tool install --global Microsoft.EntityFrameworkCore.Tools
# Package microsoft.entityframeworkcore.tools is not a .NET tool.
```

CLI ツールは `dotnet-ef` です。`Microsoft.EntityFrameworkCore.Design` は、通常の `PackageReference` としてスタートアッププロジェクトに追加してください。その後 `dotnet ef` がこの件で文句を言う場合の対処は、[your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/ja/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/) にあります。

## 注意点と似たエラー

**RID 固有の .NET 10 ツールは、より適切なメッセージを隠します。** .NET 10 では、作者が[プラットフォーム固有ツール](https://learn.microsoft.com/en-us/dotnet/core/tools/rid-specific-tools)を配布できます。これは、`DotnetToolSettings.xml` が `Version="2"` を使い、RID ごとのパッケージを指す小さなルートパッケージです。SDK 10.0.302 で `<RuntimeIdentifiers>osx-arm64;linux-x64;win-x64</RuntimeIdentifiers>` を指定して 1 つパックしました。ルートパッケージには `net10.0` フォルダーしかないため、SDK 8.0.425 と 9.0.318 はどちらも一般的な "was not found" のテキストで拒否しました。Microsoft はより明確なエラーを SDK 8.0.21 にバックポートしました([dotnet/sdk#50414](https://github.com/dotnet/sdk/pull/50414))が、そこに到達できるのはフォルダーが解決された後だけです。`--framework net10.0` を付けると、SDK 9.0.318 は "Format version is higher than supported. This tool may not be supported in this SDK version. Update your SDK." と出力しました。`--framework` では RID 固有ツールを救えません。唯一の修正は .NET 10 SDK です。

**キャッシュのクリアでは直りません。** `dotnet nuget locals all --clear` は、このメッセージに対して最もよく見かけるアドバイスです。しかし上の 3 つのどの場合にも効果がありません。パッケージは正しくダウンロードされているからです。ファイルはパッケージの中にありますが、お使いの SDK が選択するフォルダーの中にないだけです。ダウンロードの途中切れも理屈の上ではありえますが、可能性はかなり低いです。キャッシュに手を付ける前に、`dotnet --version` とパッケージの `tools/` フォルダーを確認してください。

**"Tool 'dotnet-ef' is already installed"、"is not found in NuGet feeds"、シムの競合は別の失敗です。** 原因もフラグも異なります。6 つすべてが [every way dotnet tool install --global dotnet-ef fails](/ja/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/) で扱われています。

**インストールは成功したのに `dotnet ef` が "not found" になる場合。** これはパッケージではなく `PATH` の問題です。[fixing "dotnet ef" not found](/ja/2023/06/how-to-fix-command-dotnet-ef-not-found/) を参照してください。

**ツール作者は、ユーザーのためにこれを避けられます。** ツールをマルチターゲットにし(`<TargetFrameworks>net8.0;net10.0</TargetFrameworks>` と `<PackAsTool>true</PackAsTool>`)、古い SDK が実行できるフォルダーを見つけられるようにします。`dotnet-ef` は 10.0.2 以降でそうしています。RID 固有ツールについては、Andrew Lock が、古い SDK 向けのフレームワーク依存ビルドも含む妥協案のルートパッケージを紹介しています。SDK チームもこのメッセージがわかりにくいことは認めています。[dotnet/sdk#38172](https://github.com/dotnet/sdk/issues/38172) と [dotnet/sdk#51878](https://github.com/dotnet/sdk/issues/51878) は、執筆時点でどちらもまだオープンのままです。

## 関連記事

- [Fix: dotnet tool install --global dotnet-ef throws an error](/ja/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/): その他のインストール失敗と、インストール成功後にのみ現れるランタイムの不一致について。
- [How to fix "dotnet ef" not found](/ja/2023/06/how-to-fix-command-dotnet-ef-not-found/): 同じツールの `PATH` に関する側面について。
- [Fix: the command dotnet could not be found on CI](/ja/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/): CI ランナーが SDK をどう選択し公開するかについて。
- [Fix: your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/ja/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/): ツールとして誤ってインストールされがちなパッケージについて。
- [Migrate from .NET 8 to .NET 11: the full checklist](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/): SDK の更新がより大きなアップグレードの一部である場合。

## 参考資料

- [dotnet/sdk `ToolPackageDownloader.cs`](https://github.com/dotnet/sdk/blob/release/10.0.3xx/src/Cli/dotnet/ToolPackage/ToolPackageDownloader.cs) と [`ToolPackageInstance.cs`](https://github.com/dotnet/sdk/blob/release/10.0.3xx/src/Cli/dotnet/ToolPackage/ToolPackageInstance.cs): フレームワークの選択と `MissingToolSettingsFile` のスローについて。
- [dotnet/sdk#38172](https://github.com/dotnet/sdk/issues/38172), "Installing a tool that targets a framework not installed gives a non-actionable error message".
- [dotnet/sdk#51878](https://github.com/dotnet/sdk/issues/51878): `AzureSignTool` 7.0.0 の報告と、ツールのダウンロードがリストアを経由しなくなった .NET 7 からのリグレッションであるという説明。
- [dotnet/sdk#50414](https://github.com/dotnet/sdk/pull/50414): "Format version is higher than supported" エラーの 8.0.4xx へのバックポート。
- Microsoft Learn の [Create RID-specific, self-contained, and AOT .NET tools](https://learn.microsoft.com/en-us/dotnet/core/tools/rid-specific-tools)。
- [dotnet tool install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install): `--framework`、`--tool-path`、マニフェストの動作について。
- Andrew Lock, [Supporting platform-specific .NET tools on old SDKs](https://andrewlock.net/exploring-dotnet-10-preview-features-8-supporting-platform-specific-dotnet-tools-on-old-sdks/): `DotnetToolSettings.xml` のバージョン 1 とバージョン 2 のスキーマについて。
