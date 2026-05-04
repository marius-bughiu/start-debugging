---
title: ".NET MAUI アプリを Microsoft Store 向けにパッケージ化する方法"
description: ".NET MAUI 11 の Windows アプリを MSIX としてパッケージ化し、x64/x86/ARM64 を .msixupload にバンドルして、Partner Center 経由で送信するエンドツーエンドのガイド: アイデンティティの予約、Package.appxmanifest、dotnet publish フラグ、MakeAppx バンドリング、Store 信頼の証明書ハンドオフ。"
pubDate: 2026-05-04
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "windows"
  - "msix"
  - "microsoft-store"
  - "partner-center"
  - "how-to"
lang: "ja"
translationOf: "2026/05/how-to-package-a-maui-app-for-the-microsoft-store"
translatedBy: "claude"
translationDate: 2026-05-04
---

短い回答: まず Partner Center でアプリ名を予約し、生成された Identity 値を `Platforms/Windows/Package.appxmanifest` にコピーし、`.csproj` で `WindowsPackageType=MSIX` と `AppxPackageSigningEnabled=true` を設定し、その後出荷したいアーキテクチャごとに `dotnet publish -f net10.0-windows10.0.19041.0 -c Release -p:RuntimeIdentifierOverride=win-x64` を一度実行します。結果として得られた `.msix` ファイルを `MakeAppx.exe bundle` で 1 つの `.msixbundle` に結合し、それを `.msixupload`(バンドルとそのシンボルバンドルを含むプレーンな zip)にラップして、Partner Center の送信のパッケージとしてアップロードします。Store はあなたのバンドルを独自の証明書で再署名するため、ローカルの `PackageCertificateThumbprint` はビルドマシンで信頼されている必要があるだけです。

このガイドは、2026 年 5 月時点の .NET MAUI 11.0.0 on .NET 11、Windows App SDK 1.7、および Partner Center 送信フローの完全なパイプラインを通します。以下のすべては、`Microsoft.WindowsAppSDK` 1.7.250401001 と `Microsoft.Maui.Controls` 11.0.0 とともに、.NET 11.0.100 SDK の `dotnet new maui` に対して検証されています。.NET 8 と .NET 9 の以前のアドバイスとの違いは、レシピが分岐する箇所で言及されています。

## なぜ「[公開] をクリックするだけ」が機能しなくなったのか

Visual Studio の MAUI 公開ウィザードには「Microsoft Store」ターゲットが含まれていますが、.NET 6 以降、どの MAUI リリースでも Store が受け入れる `.msixupload` を生成していません。ウィザードは単一アーキテクチャの単一の `.msix` を生成してそこで停止します。つまり、アップロードは Partner Center の検証で完全に失敗するか(以前の送信がバンドルされていた場合)、リスティングの寿命の間、単一のアーキテクチャに静かに閉じ込められるかのいずれかです。MAUI チームは 2024 年からこのギャップを [dotnet/maui#22445](https://github.com/dotnet/maui/issues/22445) として追跡しており、修正は MAUI 11 に到達していません。CLI がサポートされているパスです。

ウィザードが誤解を招く 2 番目の理由はアイデンティティです。生成される `.msix` は指定したローカル証明書で署名されますが、Store への送信では、アプリの `Identity` 要素(`Name`、`Publisher`、`Version`)が Partner Center が予約した値と完全に一致する必要があります。マニフェストが `CN=DevCert` と言い、Partner Center が `CN=4D2D9D08-...` を期待している場合、アップロードは問題のあるフィールド名を示さない 12345 スタイルの汎用エラーコードで失敗します。最初に名前を予約し、Partner Center の値をビルド前にマニフェストに貼り付けることが、そのループを回避する唯一の方法です。

良いニュース: 正しいマニフェストを取得すると、CLI コマンドは .NET 8、9、10、11 で安定しています。変更されたのはランタイム識別子の形式だけです: `win10-x64` は [NETSDK1083](https://learn.microsoft.com/en-us/dotnet/core/tools/sdk-errors/netsdk1083) に従って、.NET 10 でポータブルな `win-x64` に置き換えられました。それ以外はすべて、Xamarin が 2020 年に出荷した `MSBuild` 呼び出しと同じです。

## ステップ 1: 名前を予約してアイデンティティ値を収集する

[Partner Center](https://partner.microsoft.com/dashboard/apps-and-games/overview) にサインインして、新しいアプリを作成します。名前を予約します。**製品アイデンティティ**(または、表示されているダッシュボードのバージョンに応じて **アプリ管理 > アプリ アイデンティティ**)を開きます。3 つの文字列が必要です:

- **Package/Identity Name**、たとえば `12345Contoso.MyMauiApp`。
- **Package/Identity Publisher**、Microsoft が割り当てる長い `CN=...` 文字列、たとえば `CN=4D2D9D08-7BAC-4F2C-9D32-2A2F3C9F0E4A`。
- **Package/Publisher display name**、Store のリスティングに表示される人間が読める形式のバージョン。

これらの 3 つの値は、`Platforms/Windows/Package.appxmanifest` に逐語的に着地する必要があります。MAUI テンプレートには `Name="maui-package-name-placeholder"` のプレースホルダーマニフェストが付属していて、ビルドシステムは通常、これを `.csproj` から書き換えます。Store ビルドの場合は、`Identity` 要素がビルドを生き残るように明示的に上書きします。

```xml
<!-- Platforms/Windows/Package.appxmanifest, .NET MAUI 11 -->
<Identity
    Name="12345Contoso.MyMauiApp"
    Publisher="CN=4D2D9D08-7BAC-4F2C-9D32-2A2F3C9F0E4A"
    Version="1.0.0.0" />

<Properties>
  <DisplayName>My MAUI App</DisplayName>
  <PublisherDisplayName>Contoso</PublisherDisplayName>
  <Logo>Images\StoreLogo.png</Logo>
</Properties>
```

ここでの `Version` は 4 部構成の Win32 スキーム(`Major.Minor.Build.Revision`)を使用し、Partner Center は 4 番目のセグメントを予約済みとして扱います: 任意の Store 送信では `0` でなければなりません。CI ビルド番号をバージョンにエンコードする場合は、3 番目のセグメントに入れてください。

マニフェスト内にいる間に、`<TargetDeviceFamily>` を `Windows.Desktop` に設定し、`MinVersion` を `10.0.17763.0`(Windows App SDK 1.7 の下限)に、`MaxVersionTested` を実際にテストしたものと一致するように設定します。`MaxVersionTested` を高すぎる値に設定すると、Partner Center は送信を追加の認証用にフラグを立てます。低すぎると、Windows はより新しい OS バージョンへのインストールを拒否します。

## ステップ 2: MSIX ビルド用にプロジェクトを配線する

以下の `.csproj` プロパティは、Visual Studio ドキュメントの「MSIX 用にプロジェクトを構成する」アドバイス全体を置き換えます。このブロックを 1 回追加して、それから忘れてください。

```xml
<!-- MyMauiApp.csproj, .NET MAUI 11.0.0 on .NET 11 -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'windows' and '$(Configuration)' == 'Release'">
  <WindowsPackageType>MSIX</WindowsPackageType>
  <AppxPackage>true</AppxPackage>
  <AppxPackageSigningEnabled>true</AppxPackageSigningEnabled>
  <GenerateAppxPackageOnBuild>true</GenerateAppxPackageOnBuild>
  <AppxAutoIncrementPackageRevision>False</AppxAutoIncrementPackageRevision>
  <AppxSymbolPackageEnabled>true</AppxSymbolPackageEnabled>
  <AppxBundle>Never</AppxBundle>
  <PackageCertificateThumbprint>AA11BB22CC33DD44EE55FF66AA77BB88CC99DD00</PackageCertificateThumbprint>
</PropertyGroup>

<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'windows' and '$(RuntimeIdentifierOverride)' != ''">
  <RuntimeIdentifier>$(RuntimeIdentifierOverride)</RuntimeIdentifier>
</PropertyGroup>
```

これらのプロパティのうち 2 つは明白ではありません。

`AppxBundle=Never` は Store がバンドルを望んでいるため間違っているように見えますが、.NET MAUI ビルドは `dotnet publish` 呼び出しごとに単一アーキテクチャの単一の `.msix` のみを生成する方法しか知りません。ここで `AppxBundle=Always` を設定すると、ビルドは非 UWP プロジェクトに対して UWP 時代のバンドル生成を試行し、[dotnet/maui#17680](https://github.com/dotnet/maui/issues/17680) で追跡されている難解な `The target '_GenerateAppxPackage' does not exist in the project` エラーを発生させます。アーキテクチャごとにビルドし、次のステップで自分でバンドルします。

`AppxSymbolPackageEnabled=true` は各 `.msix` の隣に `.appxsym` を生成します。送信する `.msixupload` は、内容がバンドルと兄弟のシンボルバンドルである zip であり、Partner Center はどちらかが欠けている場合、クラッシュ分析を黙って取り除きます。警告はしません。6 週間後に Health ダッシュボードで空のスタックトレースを見るだけです。

2 番目の `<PropertyGroup>` は、プロジェクトが GitHub に移動して以来オープンであり、閉じる兆しのない [WindowsAppSDK#3337](https://github.com/microsoft/WindowsAppSDK/issues/3337) の回避策です。それなしでは、`dotnet publish` は MSIX ターゲットがそれを読む前に暗黙の RID を選択し、結果のパッケージは、コマンドラインで渡したものではなく、ビルドホストのアーキテクチャをターゲットにします。

`PackageCertificateThumbprint` はサイドロードインストールにのみ重要です。Partner Center は publisher アカウントに関連付けられた証明書でバンドルを再署名するため、Store 送信には自己署名証明書で問題ありません。`New-SelfSignedCertificate -Type Custom -Subject "CN=Contoso" -KeyUsage DigitalSignature -CertStoreLocation "Cert:\CurrentUser\My" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")` で 1 つ生成し、サムプリントをプロジェクトファイルにコピーし、Store リスティングが公開される前に、サイドロードする任意のマシンで **信頼された人々** ストアの証明書を信頼します。

## ステップ 3: アーキテクチャごとに 1 つの MSIX をビルドする

Store は今日 x64 と ARM64 を受け入れ、古い PC のロングテール用にオプションの x86 ビルドを受け入れます。Windows SDK ツールが `PATH` にあるように、**Developer Command Prompt for Visual Studio** から、アーキテクチャごとに `dotnet publish` を 1 回実行します。

```powershell
# .NET MAUI 11.0.0 on .NET 11, Windows App SDK 1.7
$tfm = "net10.0-windows10.0.19041.0"
$project = "src\MyMauiApp\MyMauiApp.csproj"

foreach ($rid in @("win-x64", "win-x86", "win-arm64")) {
    dotnet publish $project `
        -f $tfm `
        -c Release `
        -p:RuntimeIdentifierOverride=$rid
}
```

3 つのすべての実行が完了した後、アーキテクチャごとのパッケージは次の場所に着地します:

```
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-x64\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_x64.msix
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-x86\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_x86.msix
src\MyMauiApp\bin\Release\net10.0-windows10.0.19041.0\win-arm64\AppPackages\MyMauiApp_1.0.0.0_Test\MyMauiApp_1.0.0.0_arm64.msix
```

各フォルダーには `.appxsym` シンボルバンドルも含まれています。バンドリングステップが単一のディレクトリで動作できるように、6 つすべてのアーティファクトをフラットなステージングフォルダーにコピーします。

```powershell
$staging = "artifacts\msix"
New-Item -ItemType Directory -Force -Path $staging | Out-Null

Get-ChildItem -Recurse -Include *.msix, *.appxsym `
    -Path "src\MyMauiApp\bin\Release\$tfm" |
    Copy-Item -Destination $staging
```

`dotnet build` ログは各アーキテクチャに対して `package version 1.0.0.0` を報告します。それらは正確に一致する必要があり、そうでなければ `MakeAppx.exe bundle` は入力セットを `error 0x80080204: The package family is invalid` で拒否します。

## ステップ 4: アーキテクチャを `.msixbundle` にバンドルする

`MakeAppx.exe` は Windows 11 SDK に `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe` で同梱されています。新しい SDK バージョンは並んでインストールされます。`MaxVersionTested` と一致するものを選んでください。

```powershell
$makeappx = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe"
$version = "1.0.0.0"

& $makeappx bundle `
    /bv $version `
    /d $staging `
    /p "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixbundle"
```

`/d` スイッチは `MakeAppx` にフォルダー内の各 `.msix` を取り込み、3 つすべてをカバーするアーキテクチャマップを持つファットバンドルを生成するように指示します。`/bv`(バンドルバージョン)値は `Package.appxmanifest` の `Version` と等しくなければなりません。不一致は Partner Center が送信を `package version mismatch` で拒否する原因になります。

シンボルファイルをバンドルするために 2 回目のパスを実行します:

```powershell
& $makeappx bundle `
    /bv $version `
    /d $staging `
    /p "artifacts\MyMauiApp_${version}_x86_x64_arm64.appxsymbundle"
```

`MakeAppx` は入力セットからファイル拡張子を判断し、シンボルをバンドルするときに `.msix` ファイルをスキップします。シンボルバンドルを忘れた場合、アップロードは成功しますが、Health Reports は空のままです。

## ステップ 5: `.msixupload` としてラップする

`.msixupload` は特定の拡張子を持つ単なる zip です。Partner Center はその中の兄弟バンドルとシンボルバンドルファイルを自動検出します。

```powershell
$upload = "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixupload"

Compress-Archive `
    -Path "artifacts\MyMauiApp_${version}_x86_x64_arm64.msixbundle", `
          "artifacts\MyMauiApp_${version}_x86_x64_arm64.appxsymbundle" `
    -DestinationPath ($upload -replace '\.msixupload$', '.zip') -Force

Move-Item -Force ($upload -replace '\.msixupload$', '.zip') $upload
```

PowerShell 5.1 は `Compress-Archive` で `.zip` 以外の拡張子を直接書き込むことを拒否するため、スニペットは最初に `.zip` を書き込んで名前を変更します。PowerShell 7.4+ は拡張子を直接受け入れます。

## ステップ 6: Partner Center 経由でアップロードする

Partner Center で予約済みのアプリを開き、**送信を開始** をクリックし、**パッケージ** セクションにジャンプして、`.msixupload` をドロップします。Partner Center は即座にパッケージを検証し、3 つのカテゴリで問題を表面化します:

- **アイデンティティの不一致。** マニフェストの `Identity Name` または `Publisher` が Partner Center が予約した値と一致しません。`Package.appxmanifest` と並べてダッシュボードの **製品アイデンティティ** ページを開き、マニフェストを修正し、再ビルドし、再バンドルし、再アップロードします。`.msixupload` zip を直接編集しないでください。バンドルは署名されており、解凍-編集-再圧縮のサイクルは署名を無効にします。
- **Capabilities。** 宣言する任意の `<Capability>` は、追加の認証を必要とする可能性のある Store カテゴリにマッピングされます。`runFullTrust`(Win32 デスクトップアプリが必要とするため、MAUI が暗黙的に設定するもの)は通常の Store アカウントで承認されます。`extendedExecutionUnconstrained` および類似のケイパビリティは追加のレビューを受けます。
- **最小バージョン。** `<TargetDeviceFamily>` の `MinVersion` が Store が現在サポートしている最小の Windows バージョン(2026 年 5 月時点で 10.0.17763.0)よりも古い場合、パッケージは拒否されます。修正は SDK を下げるのではなく、マニフェストでそれを上げることです。

検証が通過したら、他の Store アプリと同じようにリスティングのメタデータ、年齢評価、価格を入力します。最初のレビューは通常 24-48 時間で完了します。既存のアプリへの更新は通常 12 時間未満でクリアされます。

## 午後を食べる 5 つの落とし穴

**1. 最初の送信は永遠にバンドル対単一の MSIX を決定します。** リスティングに対して単一の `.msix` を一度でもアップロードした場合、すべての将来の送信も単一の `.msix` でなければなりません。既存のリスティングをバンドルに昇格させることはできず、バンドルを単一の `.msix` に降格させることもできません。最初に決めて、今日 1 つのアーキテクチャしか出荷しなくてもバンドルにこだわってください。

**2. Partner Center の `Package Family Name` は `Identity Name` と同じではありません。** PFN は `Identity.Name + "_" + Publisher ハッシュの最初の 13 文字` であり、Windows が自動的に派生させます。PFN をマニフェストの `Identity.Name` にコピーすると、アップロードは [dotnet/maui#32801](https://github.com/dotnet/maui/issues/32801) に文書化されている誤解を招く「package identity does not match」エラーで失敗します。

**3. Windows App SDK は再頒布可能ファイルではなく、フレームワーク依存です。** MAUI テンプレートのフレームワーク依存の `WindowsAppSDK` 参照を使用している限り、Store は対応する `Microsoft.WindowsAppRuntime.1.7` パッケージを自動的にインストールします。self-contained に切り替えた場合、結果の MSIX は 80MB 大きくなり、Partner Center は Store の無料層のアーキテクチャごとのサイズ予算を超えるとして拒否します。

**4. アンダースコアを含むプロジェクト名は MakeAppx を壊します。** `My_App.csproj` という名前の `.csproj` は、ファイル名に `MakeAppx bundle` がバージョン区切り文字として解釈する位置にアンダースコアを含むパッケージを生成し、`error 0x80080204` で失敗します。プロジェクトの名前をハイフンを使用するように変更するか、出力名を上書きするために `<AssemblyName>MyApp</AssemblyName>` を追加してください。これは [dotnet/maui#26486](https://github.com/dotnet/maui/issues/26486) で追跡されています。

**5. `Test` サフィックスは本物です。** `AppPackages\MyMauiApp_1.0.0.0_Test` フォルダーは、`dotnet publish` がデフォルトでテスト証明書を生成するため、そのように名付けられています。フォルダー内の `.msix` は Store には問題ありません。フォルダー名のみが誤解を招きます。`.msix` をコピーし、`_Test` ディレクトリを無視して、先に進んでください。

## これが CI パイプラインに収まる場所

このパイプラインのものは何も Visual Studio を必要としません。.NET 11 SDK と MAUI ワークロードがインストールされたクリーンな `windows-latest` GitHub Actions ランナーは、これらのコマンドから同じ `.msixupload` を生成します。唯一の機密性の高い素材は署名証明書のサムプリントと PFX で、両方ともリポジトリシークレットに収まります。アップロード後、[Microsoft Store Submission API](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services) を使用すると、ダッシュボードに触れることなく、同じアーティファクトを直接ドラフト送信にプッシュでき、完全に自動化されたリリースのループを閉じます。

Windows ビルドが Android と iOS のワークロードも引き込まないように、同じプロジェクトからモバイルターゲットフレームワークを除去している場合、[Windows と macOS のみの MAUI 11 セットアップ](/ja/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) は、上の publish コマンドのいずれかがクリーンに実行される前に必要な `<TargetFrameworks>` の書き換えをカバーします。`Package.appxmanifest` の Manifest Designer 側と Store が読み取る小さなテーマ設定セットについては、[MAUI アプリでダークモードを正しくサポートする](/ja/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) は、リスティングのスクリーンショットジェネレーターに表示されるリソースキーを通り抜けます。Store リスティングが Maps ページを紹介する場合、[MAUI 11 のマップピンクラスタリング ウォークスルー](/2026/04/dotnet-maui-11-map-pin-clustering/) は、認証チームがアプリを承認する前にマニフェストで宣言する必要がある `MapsKey` ケイパビリティをカバーします。そして、バンドルに出荷されるフレームワークの新機能をより広く見回るには、[.NET MAUI 10 の新機能](/2025/04/whats-new-in-net-maui-10/) がドキュメントが持っているリリースノートの柱に最も近いものです。

## ソースリンク

- [Use the CLI to publish packaged apps for Windows - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/windows/deployment/publish-cli?view=net-maui-10.0)
- [Publish a .NET MAUI app for Windows (overview)](https://learn.microsoft.com/en-us/dotnet/maui/windows/deployment/overview?view=net-maui-10.0)
- [App manifest schema reference](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/root-elements)
- [Create a certificate for package signing](https://learn.microsoft.com/en-us/windows/msix/package/create-certificate-package-signing)
- [MakeAppx.exe tool reference](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)
- [Microsoft Store Submission API](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)
- [WindowsAppSDK Issue #3337 - RID workaround](https://github.com/microsoft/WindowsAppSDK/issues/3337)
- [dotnet/maui Issue #22445 - .msixupload missing](https://github.com/dotnet/maui/issues/22445)
- [dotnet/maui Issue #32801 - package identity mismatch](https://github.com/dotnet/maui/issues/32801)
