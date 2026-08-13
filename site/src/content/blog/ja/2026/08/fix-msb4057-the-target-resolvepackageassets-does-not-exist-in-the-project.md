---
title: "解決: .NET MAUI で MSB4057 The target \"ResolvePackageAssets\" does not exist in the project"
description: "MSB4057 は、マルチターゲット MAUI プロジェクトの外側のクロスターゲットビルドに対してターゲットが実行されたことを意味します。TFM を指定するか、TargetFramework で条件を付けてください。"
pubDate: 2026-08-13
template: error-page
tags:
  - "errors"
  - "dotnet-maui"
  - "msbuild"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/08/fix-msb4057-the-target-resolvepackageassets-does-not-exist-in-the-project"
translatedBy: "claude"
translationDate: 2026-08-13
---

`ResolvePackageAssets` が失われているわけではなく、パッケージが壊れているわけでもありません。マルチターゲットプロジェクトの**外側 (クロスターゲット) のビルド**に対してターゲットが実行され、.NET SDK はそこに `ResolvePackageAssets` をインポートしないだけです。単一のフレームワークを指定する (`dotnet build -f net10.0-android -t:ResolvePackageAssets`) か、NuGet パッケージの `.targets` ファイルが呼び出している場合は、そのターゲットに `Condition="'$(TargetFramework)' != ''"` を付けて内側のビルドでのみ実行されるようにしてください。`bin` と `obj` を削除しても解決しません。

以下の内容はすべて .NET SDK 10.0.201 (MSBuild 18.3.0) と `maui-android` / `maui-ios` / `maui-maccatalyst` 10.0.20 のワークロードで検証しています。クロスターゲットの仕組みは .NET 11 でも変わりません。

## 実際のエラー

```text
C:\src\MauiApp1\MauiApp1.csproj : error MSB4057: The target "ResolvePackageAssets" does not exist in the project.

Build FAILED.
    0 Warning(s)
    1 Error(s)
```

NuGet パッケージが引き金の場合、エラーはプロジェクトパスではなくファイル名と列番号を示します。これは、あなたではなく `.targets` ファイルが要求したという手がかりです。

```text
C:\Users\me\.nuget\packages\ikvm.maven.sdk\1.9.2\buildTransitive\IKVM.Maven.Sdk.targets(37,64):
  error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
```

## マルチターゲットプロジェクトで MSB4057 が出る理由

MAUI アプリには `TargetFrameworks` (複数形) が指定されています。

```xml
<!-- .NET 10, MAUI 10 app csproj, from dotnet new maui -->
<TargetFrameworks>net10.0-android</TargetFrameworks>
<TargetFrameworks Condition="!$([MSBuild]::IsOSPlatform('linux'))">$(TargetFrameworks);net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
<TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net10.0-windows10.0.19041.0</TargetFrameworks>
```

MSBuild はこのプロジェクトを**二重に**ビルドします。処理を振り分けるだけの外側のパスが 1 回、そしてフレームワークごとに内側のパスが 1 回ずつです。どちらにいるかを SDK は 1 つのプロパティで判定しており、それは `Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets` で定義されています。

```xml
<!-- .NET SDK 10.0.201, Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets -->
<PropertyGroup Condition="'$(TargetFrameworks)' != '' and '$(TargetFramework)' == ''">
  <IsCrossTargetingBuild>true</IsCrossTargetingBuild>
</PropertyGroup>

<Import Project="$(MSBuildThisFileDirectory)..\targets\Microsoft.NET.Sdk.CrossTargeting.targets"
        Condition="'$(IsCrossTargetingBuild)' == 'true'"/>
<Import Project="$(MSBuildThisFileDirectory)..\targets\Microsoft.NET.Sdk.targets"
        Condition="'$(IsCrossTargetingBuild)' != 'true'"/>
```

この最後の 2 行がすべてです。`ResolvePackageAssets` は `Microsoft.PackageDependencyResolution.targets` で定義され、それは `Microsoft.NET.Sdk.targets` からインポートされ、さらにそれは **`IsCrossTargetingBuild` が true でないときにのみ**インポートされます。外側のビルドでは代わりに `Microsoft.NET.Sdk.CrossTargeting.targets` が読み込まれ、利用できるターゲットの全体が次の範囲まで縮小します。

- `Microsoft.Common.CrossTargeting.targets` から: `Build`、`Clean`、`Rebuild`、`DispatchToInnerBuilds`、`GetTargetFrameworks`、`GetTargetFrameworksWithPlatformFromInnerBuilds`、`InitializeSourceControlInformation`
- `Microsoft.NET.Sdk.CrossTargeting.targets` から: `Publish`、`GetAllRuntimeIdentifiers`、`GetPackagingOutputs`
- `Microsoft.NET.Sdk.Workloads.CrossTargeting.targets` から: `_GetRequiredWorkloads`

このリストの外にあるものを外側のビルドに対して要求すると、MSBuild は MSB4057 を発生させます。`ResolvePackageAssets`、`GetTargetPath`、`GetCopyToOutputDirectoryItems`、`ComputeFilesToPublish` はいずれもリストの外です。.NET Aspire の AppHost が MAUI プロジェクトをオーケストレーションしようとしたときに、同じエラー文が `The target "GetTargetPath" does not exist in the project` として現れるのも同じ理由です。仕組みは同じで、ターゲット名が違うだけです。

## 最小限の再現手順

これを確認するのに MAUI は必要ありません。`TargetFrameworks` が複数形のプロジェクトはどれも同じ挙動になるため、再現はファイル 2 つで済みます。

```xml
<!-- MultiLib/MultiLib.csproj, .NET SDK 10.0.201 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net10.0;net9.0</TargetFrameworks>
  </PropertyGroup>
</Project>
```

```bash
# .NET SDK 10.0.201
# outer build: no -f, so TargetFramework is empty
dotnet build -t:ResolvePackageAssets
# error MSB4057: The target "ResolvePackageAssets" does not exist in the project.

# inner build: -f selects one framework
dotnet build -t:ResolvePackageAssets -f net10.0
# Build succeeded.
```

`dotnet new maui` で作ったばかりのアプリに対しても、`-f net10.0-android` を使えばまったく同じように失敗し、そして成功します。

## 外側のビルドかどうかを確認するには?

プロジェクトファイルを編集し始める前に、どちらのビルドにいるかを確かめてください。`-getProperty` スイッチはビルドせずにプロジェクトを評価するため、MAUI アプリでも一瞬で終わります。

```bash
# .NET SDK 10.0.201
dotnet msbuild -getProperty:IsCrossTargetingBuild -getProperty:TargetFramework
```

フレームワークを指定していない MAUI アプリでの結果です。

```json
{
  "Properties": {
    "IsCrossTargetingBuild": "true",
    "TargetFramework": ""
  }
}
```

`IsCrossTargetingBuild: true` であれば、MSB4057 はタイプミスではなくクロスターゲットの問題だと確定します。`-p:TargetFramework=net10.0-android` を加えると同じコマンドが空の `IsCrossTargetingBuild` を返し、内側のビルドが SDK のターゲット一式を持っていることを示します。選択できるフレームワークを知りたい場合は、直接問い合わせてください。

```bash
# .NET SDK 10.0.201
dotnet msbuild -getProperty:TargetFrameworks
# net10.0-android;net10.0-ios;net10.0-maccatalyst;net10.0-windows10.0.19041.0
```

`IsCrossTargetingBuild` が空で返るのに MSB4057 が出続ける場合は、SDK スタイルではないプロジェクトの節に進んでください。同じエラーコードですが、根本原因は別です。

## NuGet パッケージの .targets ファイルが外側のビルドを壊すのを防ぐには?

MAUI での報告の大多数はこれで解決します。ターゲットを名前で要求した覚えがなくても遭遇するのがこのケースだからです。NuGet パッケージ (またはあなた自身の `Directory.Build.targets`) が `AfterTargets="Build"` にフックし、`ResolvePackageAssets` への依存を宣言します。内側のビルドではこれで問題ありません。その後、外側の `Build` ターゲットが実行され、`AfterTargets="Build"` が再び発火し、依存関係が解決できなくなります。

```xml
<!-- Directory.Build.targets, broken on a multi-targeted project -->
<Project>
  <Target Name="MyPackageCopyJars"
          AfterTargets="Build"
          DependsOnTargets="ResolvePackageAssets">
    <Message Importance="high" Text="ran for TF=[$(TargetFramework)]" />
  </Target>
</Project>
```

上記の `MultiLib` に対して普通に `dotnet build` を実行すると、まさにこの結果になります。出力の順序が決め手です。

```text
ran for TF=[net9.0]
ran for TF=[net10.0]
Directory.Build.targets(4,11): error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
Build FAILED.
```

内側のビルドは 2 つとも成功し、*その後で*外側のパスが失敗しています。ビルドログでフレームワークごとの処理が完了し、*それから* MSB4057 が出ているなら、これがあなたのケースです。条件を追加してください。

```xml
<!-- Directory.Build.targets, fixed. .NET SDK 10.0.201 -->
<Project>
  <Target Name="MyPackageCopyJars"
          AfterTargets="Build"
          DependsOnTargets="ResolvePackageAssets"
          Condition="'$(TargetFramework)' != ''">
    <Message Importance="high" Text="ran for TF=[$(TargetFramework)]" />
  </Target>
</Project>
```

これで同じビルドが `ran for TF=[net9.0]`、`ran for TF=[net10.0]`、`Build succeeded.` を出力します。この条件は「内側のビルドでのみ」を表す SDK の定石であり、本来パッケージ側が同梱すべきものです。問題のターゲットが `~/.nuget/packages/<id>/<ver>/build*/` 配下のパッケージ内にある場合、その場で編集しないでください。次の restore で変更が上書きされます。上流にバグを報告し、当面はインポートをローカルで無効化してください。

## CLI から単一のターゲットを呼び出すには?

`-t:` を自分で入力しているなら、フレームワークを指定してください。

```bash
# .NET SDK 10.0.201, MAUI 10
dotnet build -t:ResolvePackageAssets -f net10.0-android
```

これはビルドを調べるために個別のターゲットを呼び出すスクリプトや CI ステップで重要になります。`-t:` を付けない `dotnet build` と `dotnet publish` はそれ自体では安全です。`Build` と `Publish` はどちらもクロスターゲットのセットに存在し、処理を振り分ける方法を知っているためです。

## MSBuild タスクで別プロジェクトのターゲットを呼び出すには?

あるプロジェクトが別のプロジェクトのターゲットを実行する場合 (独自ツール、何らかの SDK のオーケストレーション用ターゲット、パッケージング手順など)、`MSBuild` タスクにも同じルールが適用されます。これは失敗します。

```xml
<!-- broken: no framework selected on the callee -->
<Target Name="ProbeRef" AfterTargets="Build">
  <MSBuild Projects="..\MultiLib\MultiLib.csproj" Targets="GetTargetPath">
    <Output TaskParameter="TargetOutputs" ItemName="_Probed" />
  </MSBuild>
</Target>
```

```text
MultiLib.csproj : error MSB4057: The target "GetTargetPath" does not exist in the project.
```

呼び出し側でプロパティを設定すれば解決します。

```xml
<!-- fixed. .NET SDK 10.0.201 -->
<Target Name="ProbeRef" AfterTargets="Build">
  <MSBuild Projects="..\MultiLib\MultiLib.csproj"
           Targets="GetTargetPath"
           Properties="TargetFramework=net10.0">
    <Output TaskParameter="TargetOutputs" ItemName="_Probed" />
  </MSBuild>
</Target>
```

フレームワークをハードコードしたくない場合は、先に `GetTargetFrameworks` を呼び出し (これは外側のビルドに存在し、まさにそのためのものです)、その結果をループしてください。

## マルチターゲットプロジェクトへの ProjectReference は変更が必要?

マルチターゲットプロジェクトへの通常の `ProjectReference` は MSB4057 を**引き起こしません**。MSBuild が互換性のあるフレームワークを自動で調整するため、上記の `net10.0;net9.0` ライブラリを参照する `net10.0` のコンソールアプリは問題なくビルドできます。手を入れる必要があるのは調整で勝者を決められない場合だけで、テストプロジェクトやツールプロジェクトが MAUI アプリの head を参照するときによく起こります。`SetTargetFramework` を使ってください。

```xml
<!-- .NET SDK 10.0.201 -->
<ItemGroup>
  <ProjectReference Include="..\MultiLib\MultiLib.csproj"
                    SetTargetFramework="TargetFramework=net9.0" />
</ItemGroup>
```

これで参照が 1 つの内側のビルドに固定され、`MultiLib.dll` が期待どおり参照元の出力ディレクトリに配置されます。MSB4057 ではなく `NETSDK1005: Assets file doesn't have a target for ...` が出る場合は、ターゲットの欠落ではなく調整の失敗ですが、解決策はやはり `SetTargetFramework` です。

## そもそもプロジェクトが SDK スタイルでない場合は?

同じエラーコードに至る、まったく別の経路がもう 1 つあります。`Microsoft.CSharp.targets` を直接インポートする旧形式の `.csproj` は .NET SDK のターゲットを一切インポートしないため、`ResolvePackageAssets` は**どのパスにも**存在しません。

```xml
<!-- legacy non-SDK csproj -->
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion>
  </PropertyGroup>
  <Import Project="$(MSBuildToolsPath)\Microsoft.CSharp.targets" />
</Project>
```

```bash
# .NET SDK 10.0.201
dotnet msbuild -t:ResolvePackageAssets
# error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
```

古いクラスライブラリに SDK 前提の NuGet パッケージ (IKVM.Maven.SDK が定番の例です) を追加した人や、Xamarin 時代のバインディングプロジェクトを MAUI ソリューションに残している人がこれに引っかかります。ここでは `IsCrossTargetingBuild` が空になるため、前述の診断コマンド 1 つで 2 つのケースを見分けられます。解決策はプロジェクトを SDK スタイルに変換するか、SDK のターゲットを前提とするパッケージの参照をやめることです。すでに Xamarin.Forms 5.0 から .NET MAUI 11 へ移行している最中なら、こうした残存物の移行はいずれにせよ正しい判断です。

## 注意点と、間違ってこのページにたどり着く紛らわしいエラー

**MSB4018: The "ResolvePackageAssets" task failed unexpectedly.** 別のエラーで、原因も別です。ターゲットは存在して*実行され*、タスクの側が例外を投げています。多くは `project.assets.json` の破損か、グローバルキャッシュ内の読み取れないパッケージが原因で、`obj/` を削除して `dotnet restore` をやり直すことが本当に効くのはこのケースだけです。

**「The ResolvePackageAssets task was not given a value for the required parameter TargetFramework」** これも内側と外側の混同ですが、ターゲットが見つからなかったのではなく、`TargetFramework` が空のままターゲットに到達したという意味です。解決策は同じで、フレームワークを選択してください。

**.NET 10 の `dotnet ef` から出る MSB4057** `dotnet-ef` 10 のツール側リグレッションとして [dotnet/efcore#37230](https://github.com/dotnet/efcore/issues/37230) に登録され、マイルストーン 10.0.2 で修正されます。遭遇した場合は、プロジェクトの構成を変えるのではなくツールのバージョンを固定してください。

```bash
# workaround for the dotnet-ef 10 regression
dotnet tool update --global dotnet-ef --version 9.0.10
```

**自分で書いたターゲット名を指す MSB4057** その場合は本当にターゲットが存在しないか、綴りが間違っています。これは [MSBuild ドキュメントの MSB4057](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb4057) が説明しているケースです。`BeforeTargets`、`AfterTargets`、`DependsOnTargets`、`CallTarget` の綴りを確認し、ターゲット定義の `Condition` によって除外されていないかも確認してください。

**MAUI head に対する Aspire のオーケストレーション** [microsoft/aspire#3043](https://github.com/microsoft/aspire/issues/3043) は、同じ外側のビルドの問題が `The target "GetTargetPath" does not exist` として表面化したものです。こちら側でのきれいな解決策はありません。MAUI アプリは Aspire が提供できるリソースではないため、AppHost から外し、代わりに単一ターゲットの共有クラスライブラリを参照してください。

## 内側のビルドに属するターゲットは?

コンパイラーの入力、パッケージのアセット、出力パスを取りにプロジェクトの内部へ手を伸ばすものはすべて、内側のビルドに属します。あなたのターゲットが `ResolvePackageAssets`、`@(ReferencePath)`、`$(TargetPath)` に触れるなら、`Condition="'$(TargetFramework)' != ''"` が必要です。この 1 行で MAUI リポジトリにおける MSB4057 の報告のほとんどを防げますし、`TargetFramework` が常に設定されている単一ターゲットのプロジェクトでは何のコストもありません。

同じスタックで起きる関連のビルド失敗については、[MSB3027 が 10 回の再試行後にファイルをコピーできなかったと報告する理由](/ja/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/)、[MAUI Android で Gradle ビルドが .apk を生成しないときに確認すること](/ja/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/)、[プロジェクト参照を追加した後の型または名前空間のエラーを解決する方法](/ja/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/)、[Xamarin.Forms から .NET MAUI 11 への完全な移行チェックリスト](/ja/2026/05/migrate-from-xamarin-forms-to-maui-11/)の各記事を参照してください。

## 参照元

- [MSB4057 診断コード](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb4057)、MSBuild ドキュメント
- `Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets` および `Microsoft.Common.CrossTargeting.targets`、.NET SDK 10.0.201
- [ikvmnet/ikvm-maven#76](https://github.com/ikvmnet/ikvm-maven/issues/76)、SDK スタイルではないプロジェクトでパッケージの `.targets` ファイルから出る MSB4057
- [microsoft/aspire#3043](https://github.com/microsoft/aspire/issues/3043)、MAUI head における `GetTargetPath` 版
- [dotnet/efcore#37230](https://github.com/dotnet/efcore/issues/37230)、`dotnet-ef` 10 のリグレッション
