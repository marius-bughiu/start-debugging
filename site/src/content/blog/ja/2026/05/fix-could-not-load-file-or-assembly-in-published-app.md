---
title: "修正: System.IO.FileNotFoundException: Could not load file or assembly が発行済みアプリで発生する"
description: "dotnet run では動くのに dotnet publish 後に失敗するケースです。原因はランタイムではなく発行フォルダーに DLL がないことです。deps.json、ProjectReference の Private、トリミングを確認してください。"
pubDate: 2026-05-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "publish"
  - "trimming"
lang: "ja"
translationOf: "2026/05/fix-could-not-load-file-or-assembly-in-published-app"
translatedBy: "claude"
translationDate: 2026-05-12
---

修正方法です。`dotnet publish` のあとに発生する `FileNotFoundException: Could not load file or assembly` は、ほぼ確実にランタイムが見つけられないのではなく、発行フォルダーに DLL が存在しないことを意味します。発行出力を一覧し、名前から不足しているアセンブリを特定し、パッケージングのバグとして扱ってください。実際の報告の九割を占める四つの原因は、`Private=false` が指定された `ProjectReference`、`PrivateAssets="all"` が指定された `PackageReference`、リフレクション経由で読み込まれるアセンブリをトリミングが落としているケース、そして self-contained と framework-dependent の発行で間違った RID を選んでいるケースです。`COREHOST_TRACE=1` を設定して発行済みのバイナリを一度実行すれば、ホストのログがどの探索パスを試したかを教えてくれます。

```text
Unhandled exception. System.IO.FileNotFoundException: Could not load file or assembly 'Contoso.Shared, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'. The system cannot find the file specified.
File name: 'Contoso.Shared, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'
   at MyApp.Program.Main(String[] args)

--- End of stack trace from previous location ---
   at System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw()
   at System.Runtime.CompilerServices.TaskAwaiter.ThrowForNonSuccess(Task task)
```

このガイドは .NET 11 preview 4 (ランタイム `Microsoft.NETCore.App` 11.0.0-preview.4) と .NET SDK 11.0.100-preview.4 を Windows、Linux、macOS で動かすことを想定して書いています。例外の型、メッセージ内の四要素から成るアセンブリ ID、ホストの探索ルールは .NET Core 3.0 から変わっていません。.NET 8 と .NET 11 で変わったのはトリマーのアナライザーで、いまでは `IL2026` / `IL3050` の警告を最初に出すため、実行時に初めて気付くということが減りました。メッセージが `Could not load file or assembly` のあとに `or one of its dependencies` と続く場合、不足しているのは最初に書かれているものではなく依存先のファイルです。何かを触る前に二つ目の節を読んでください。

## なぜランタイムはアセンブリを見つけられないのか

.NET ホスト (`dotnet.exe`、あるいは `dotnet publish` で `.exe` の隣に生成される apphost スタブ) は、`<app>.deps.json` から導出された決まった探索パス群からアセンブリを読み込みます。`PATH` も GAC も探しませんし、ビルドした側のプロジェクトの bin フォルダーにフォールバックすることもありません。試す順序は次のとおりです。

1. apphost のディレクトリ (`AppContext.BaseDirectory`)。
2. framework-dependent アプリ用の共有フレームワークディレクトリ (`{DOTNET_ROOT}/shared/Microsoft.NETCore.App/{version}`)。
3. `useNuGet` 解決が有効な場合の NuGet フォールバックフォルダー (開発時のみ)。
4. `<app>.runtimeconfig.dev.json` の `additionalProbingPaths` で宣言されている場所。これは発行済みアプリには **存在しません**。

開発マシンでアセンブリが NuGet キャッシュにあり、runtimeconfig がそこを指している場合、`dotnet run` はそれを見つけます。発行済みアプリにはそのキャッシュも開発用 runtimeconfig もないので、同じ呼び出しが例外を投げます。例外は、`<app>.deps.json` 内のアセンブリ ID がディスク上のどのファイルにも解決されなかったとホストが伝えている状態です。

Microsoft Learn の公式ページ [Understand dependency loading in .NET](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/overview) が探索順序の信頼できるリファレンスです。[ホストトレースの手順](https://github.com/dotnet/runtime/blob/main/docs/design/features/host-tracing.md) には、探索ログをファイルに書き出す方法が書かれています。

## 最小再現

```xml
<!-- .NET 11, SDK 11.0.100-preview.4 -->
<!-- src/MyApp/MyApp.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <RootNamespace>MyApp</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Contoso.Shared\Contoso.Shared.csproj">
      <Private>false</Private>
    </ProjectReference>
  </ItemGroup>
</Project>
```

```csharp
// .NET 11, C# 14
using Contoso.Shared;

var greeter = new Greeter();
Console.WriteLine(greeter.Hello("world"));
```

`dotnet run` は成功します。`dotnet publish -c Release -r win-x64 -o ./out` もエラーなしで完了します。しかし `./out/MyApp.exe` は `Could not load file or assembly 'Contoso.Shared'` を投げます。`<Private>false</Private>` というフラグは、GAC やほかの配置手段が DLL を提供してくれることを前提に、`Contoso.Shared.dll` を消費側の出力にコピーしないよう MSBuild に指示します。.NET (Core) アプリには GAC がないので、ファイルは単に存在しません。

これがこのバグの典型的な姿です。プロジェクトグラフのどこかの一つのプロパティが MSBuild に「DLL を含めるな」と伝え、発行ステップがそれに従います。修正は、そのプロパティを見つけて取り除くことです。

## 修正 1: コピーの抑止をやめる

不足しているアセンブリの親プロジェクトのプロジェクトファイルを開き、参照に対して以下のいずれかのプロパティが指定されていないか確認します。

```xml
<!-- These three lines all suppress the copy. Remove them. -->
<ProjectReference Include="..\Contoso.Shared\Contoso.Shared.csproj">
  <Private>false</Private>
</ProjectReference>

<Reference Include="Contoso.Shared">
  <CopyLocal>false</CopyLocal>
</Reference>

<PackageReference Include="Some.Library" Version="1.0.0">
  <PrivateAssets>all</PrivateAssets>
</PackageReference>
```

`Private=false` と `CopyLocal=false` はプロジェクト参照とアセンブリ参照では等価です。`PackageReference` の `PrivateAssets="all"` は、そのアセットがビルド時には消費されるが消費側プロジェクトには伝播しないという意味で、結果として DLL は `deps.json` から外れます。`PrivateAssets="all"` の正当な用途はアナライザー、ソースジェネレーター、ビルドタスクのパッケージ (ランタイムが DLL を必要としないもの) です。パッケージが `Microsoft.Extensions.Logging.Abstractions` のように実行時に呼び出すものであれば、このフラグは誤りです。外してから `dotnet publish` を実行し、DLL がアプリの隣に置かれることを確認してください。

MS Learn の [Controlling dependency assets](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#controlling-dependency-assets) には、`PrivateAssets` が受け付けるすべての値と、それぞれが何を無効化するかが一覧されています。

## 修正 2: ホストトレースを有効にして探索ログを読む

どの DLL が不足しているか分からない場合は、ホストに尋ねます。発行済みバイナリを起動する前に `COREHOST_TRACE=1` と `COREHOST_TRACEFILE=corehost.log` を設定します。

```powershell
# Windows, PowerShell, .NET 11
$env:COREHOST_TRACE = "1"
$env:COREHOST_TRACE_VERBOSITY = "4"
$env:COREHOST_TRACEFILE = "corehost.log"
./out/MyApp.exe
```

```bash
# Linux / macOS, bash, .NET 11
COREHOST_TRACE=1 COREHOST_TRACE_VERBOSITY=4 COREHOST_TRACEFILE=corehost.log ./out/MyApp
```

ログは長いですが、注目すべきは `Attempting to load` の節です。各探索はホストが試したフルパスとともに記録されます。例外の直前に失敗した最後の探索が答えです。

```text
Attempting to load: C:\out\Contoso.Shared.dll - false
Attempting to load: C:\out\runtimes\win-x64\lib\net11.0\Contoso.Shared.dll - false
File [C:\out\Contoso.Shared.dll] does not exist
```

これで、ホストがアプリフォルダー直下に `Contoso.Shared.dll` を期待していたが見つからなかったことが分かります。修正は、発行出力にそのパスのファイルを含めるようにすることであって、探索パスやロードコンテキストを追加することではありません。

## 修正 3: トリミングが黙ってアセンブリを削っているとき

self-contained な .NET 11 アプリをトリミングすると、トリマーが静的解析で到達可能と証明できないアセンブリはすべて削除されます。`Assembly.Load("Plugins.Foo")`、`Type.GetType("Some.Type, Some.Assembly")`、そしてリフレクションベースの DI コンテナーの多くは、トリマーから見えません。アセンブリは発行出力から除外され、実行時に `FileNotFoundException` として現れます。

トリミングが原因か確認するには、トリマーの警告を致命的エラーに昇格させて一度発行します。

```xml
<!-- .NET 11 -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
  <TrimmerSingleWarn>false</TrimmerSingleWarn>
  <SuppressTrimAnalysisWarnings>false</SuppressTrimAnalysisWarnings>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

これで `IL2026` や `IL3050` がリフレクションの呼び出し箇所を指して発行が失敗するなら、原因はトリミングです。修正は、トリマーが残してくれるようアセンブリをルートとして固定することです。

```xml
<!-- .NET 11 -->
<ItemGroup>
  <TrimmerRootAssembly Include="Plugins.Foo" />
</ItemGroup>
```

特定の型だけが対象なら、読み込みを引き起こすメソッドに `DynamicDependencyAttribute` を付けます。

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public static class PluginLoader
{
    [DynamicDependency(DynamicallyAccessedMemberTypes.PublicConstructors, "Plugins.Foo.Entry", "Plugins.Foo")]
    public static object Load() => Activator.CreateInstance(Type.GetType("Plugins.Foo.Entry, Plugins.Foo")!)!;
}
```

トリマーのルートと依存関係属性の一覧は [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming) にあります。ランタイム側のより深い解説は、[ASP.NET Core 最小 API での Native AOT](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) の記事が同じトリマー警告をより攻めた形で扱っています。

## 修正 4: RID の間違い、あるいは framework-dependent を self-contained として発行している

エラーに挙がっているアセンブリが `Microsoft.NETCore.App`、もしくはその構成要素 (`System.Private.CoreLib.dll`、`System.Runtime.dll` など) の場合、原因はあなたのコードではなく、発行されたアプリが framework-dependent なのに対象マシンに対応する共有フレームワークがインストールされていないことです。

```text
Could not load file or assembly 'System.Runtime, Version=11.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'
```

このメッセージは、ホストが `MyApp.dll` を見つけて `MyApp.runtimeconfig.json` を読み、`Microsoft.NETCore.App 11.0.0` を要求したが何も得られなかった、という意味です。対象マシンに共有フレームワークをインストール (`dotnet --list-runtimes`) するか、self-contained として再発行してください。

```bash
# .NET 11
dotnet publish -c Release -r win-x64 --self-contained true -o ./out
```

ランタイムがフレームワークの DLL を `./out` に同梱するため、アプリはマシンにインストールされたランタイムに依存しなくなり、FileNotFoundException も消えます。対応する記事 [.NET 11 の AWS Lambda のコールドスタート時間を短縮する方法](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) では、発行のトレードオフ (サイズ vs ポータビリティ vs コールドスタート) をより深く扱っています。

もうひとつの RID 由来の失敗は、一部の RID 向けにしかネイティブバイナリを同梱しない NuGet パッケージです。`osx-arm64` 向けに発行しても、パッケージが `win-x64` と `linux-x64` のネイティブしか含んでいなければ、パッケージの `runtimes/win-x64/native/foo.dll` は発行から除外され、マネージドのラッパーが `FileNotFoundException` を投げます。修正は、パッケージのオーナーに不足を報告するか、必要な RID を同梱しているバージョンに固定することです。パッケージの `runtimes/` フォルダーが真実の源です。

## 落とし穴とよく似たケース

**`Could not load file or assembly 'X' or one of its dependencies`。** 名前で挙がっているアセンブリはディスク上にあります。その依存先がありません。`X.dll` に対して `dotnet-dump analyze` や `dnSpy` を実行して参照アセンブリ一覧を読むか、修正 2 のホストトレースで二段目の失敗を見つけてください。最初の名前を不足ファイルと思い込むと堂々巡りになります。

**`FileLoadException` であって `FileNotFoundException` ではないケース。** `FileLoadException: Could not load file or assembly 'X, Version=2.0.0.0'` は、ファイルは存在するもののバージョン、カルチャー、または public key token が要求されたものと一致しないという意味です。これはアセンブリのバインディングリダイレクトの問題で、推移的依存がトップレベルだけで更新された場合によく起こります。修正は、解決グラフが単一バージョンに収束するよう、トップレベルの `PackageReference` に一致するバージョンを追加することです。.NET (Core) のランタイムは `app.config` のバインディングリダイレクトをもう読みません。読んでいたのは .NET Framework のランタイムだけです。`app.config` から移行した場合、リダイレクトは今は無視され、`deps.json` で解決されたバージョンがロードされます。

**`TypeLoadException` と `MissingMethodException`。** これらはアセンブリ未検出のエラーではありません。アセンブリはロードできたが、その中の型やメソッドが呼び出し側の期待するシグネチャと違うという意味で、ほぼ確実にバージョンの不一致です。修正の形は `FileLoadException` と同じで、バージョングラフをそろえます。

**`BadImageFormatException`。** ファイルはディスク上にあり名前も正しいが、アーキテクチャが間違っている (`x64` プロセスに `x86` の DLL を読み込んだ、ネイティブとしてマネージド DLL を読み込んだ、など) ケースです。両側の RID と `Platform` を確認してください。これは姉妹カテゴリーであり、`FileNotFoundException` の偽装ではありません。

**Single-file 発行。** `PublishSingleFile=true` の場合、apphost は初回起動時に同梱アセンブリを一時フォルダー (`%TEMP%/.net/<appname>/<hash>`) に展開します。シングルファイルバンドル内にあることが見える (`dotnet-bundle list` で確認可能) アセンブリに対して `FileNotFoundException` が出る場合、最も多い原因は自前の `AssemblyLoadContext.LoadFromAssemblyPath(Assembly.GetExecutingAssembly().Location)` の呼び出しです。.NET 6 以降の single-file バンドルでは `Assembly.Location` は空なので、パス引数が誤っています。`AppContext.BaseDirectory` に切り替えるか、`Assembly.LoadFromAssemblyName` を使ってホストに同梱ファイルを解決させてください。

**ASP.NET Core の IIS へのデプロイ。** 発行ではファイルがあるのに IIS では例外が出る場合、アプリプールの `Identity` に発行フォルダーへの読み取り権限があるか、`aspnetcorev2.dll` が現在のバージョン (`%programfiles%\IIS\Asp.Net Core Module\V2\aspnetcorev2.dll`) になっているかを確認してください。古い ANCM は古い `deps.json` を読み込みます。これはデプロイの問題で、ビルドの問題ではありません。

**プラグイン / 動的ロードコンテキスト。** `AssemblyLoadContext` 経由でプラグインを読み込む場合、プラグインのコンテキストはデフォルトコンテキストのアセンブリを継承しません。`Newtonsoft.Json` を呼び出すプラグインには、プラグインの横に独自の `Newtonsoft.Json.dll` か、プラグインのパスから構築した `AssemblyDependencyResolver` が必要です。修正 1 と同じ形ですが、対象はアプリフォルダーではなくプラグインフォルダーです。MS Learn のチュートリアル [Create a .NET application with plugins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) には、リゾルバーパターンのひととおりが書かれています。

**ビルドはコピーしたが発行はしなかった。** publish は build と異なる MSBuild ターゲット (`BuiltProjectOutputGroup` ではなく `ComputeFilesToPublish`) を実行します。`<Content Include="Foo.dll" CopyToOutputDirectory="PreserveNewest" />` はファイルを `bin/` に置きますが、発行フォルダーに置くには `<None Include="Foo.dll"><Pack>true</Pack><CopyToPublishDirectory>PreserveNewest</CopyToPublishDirectory></None>` (または publish フラグ付きの `<Content>`) が必要です。`bin/Release/net11.0/` に DLL があるのに `bin/Release/net11.0/publish/` にない場合、これが原因です。

## 関連記事

- [修正: プロジェクト参照を追加したあとに型または名前空間名が見つからない](/ja/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) はこの例外のコンパイル時のいとこで、同じ `Private` と `TargetFramework` のずれがビルドでは `CS0246`、実行時には `FileNotFoundException` として現れます。
- [修正: MSBuild MSB3027 could not copy exceeded retry count](/ja/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) は、発行フォルダーが中途半端に残る発行時のコピー失敗を扱います。
- [修正: Native AOT での PlatformNotSupportedException](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/) は、アセンブリは存在するのにコードパスが存在しない、似た形のトリム＆発行ケースです。
- [.NET 11 の AWS Lambda のコールドスタート時間を短縮する方法](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) は同じ発行ステップにおける self-contained vs framework-dependent のトレードオフを論じています。
- [ASP.NET Core 最小 API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) は、この種のバグをビルド時に捕まえるトリマー警告を、より深く扱う記事です。

## ソース

- [Understand dependency loading in .NET](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/overview) (MS Learn)
- [Host tracing in the .NET runtime host](https://github.com/dotnet/runtime/blob/main/docs/design/features/host-tracing.md) (`dotnet/runtime`)
- [Controlling dependency assets with PackageReference](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#controlling-dependency-assets) (MS Learn)
- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming) (MS Learn)
- [`DynamicDependencyAttribute` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicdependencyattribute) (MS Learn)
- [Create a .NET application with plugins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) (MS Learn)
- [`AppContext.BaseDirectory` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.appcontext.basedirectory) (MS Learn)
