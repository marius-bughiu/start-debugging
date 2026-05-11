---
title: "Fix: The type or namespace name 'X' could not be found (プロジェクト参照を追加した直後)"
description: "新しい ProjectReference 直後の CS0246 は、ほぼ TargetFramework の不一致、古い obj/ フォルダ、または using ディレクティブの欠落のいずれかです。可能性の高い順に 5 つの対処を示します。"
pubDate: 2026-05-11
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "csproj"
lang: "ja"
translationOf: "2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference"
translatedBy: "claude"
translationDate: 2026-05-11
---

修正方法: 10 件中 9 件は、コンシューマ プロジェクトの `TargetFramework` が参照先プロジェクトより低いため SDK パックがそもそもアセンブリを解決しようとしない、前回ビルドの `obj/` と `bin/` ディレクトリが誤った参照アセンブリを指したままになっている、または型自体は問題なくコンパイルされているが呼び出し側で `using` ディレクティブが抜けている、のいずれかです。両方の `.csproj` を開き、`TargetFramework` の値を揃え、`dotnet build --no-incremental` を実行 (Windows なら `obj/` と `bin/` を手で削除) し、それからようやく `using` ディレクティブを確認してください。例外メッセージと原因は .NET 6 から .NET 11 preview 4 まで変わっていないため、最新の SDK スタイル プロジェクトには同じチェックリストがそのまま当てはまります。

```text
error CS0246: The type or namespace name 'OrderService' could not be found (are you missing a using directive or an assembly reference?)
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'MyApp.Domain' (are you missing an assembly reference?)
```

この 2 つのコードは、同じ根本原因を細い境界で分けています。`CS0246` は短い名前で参照されたトップレベルの型をコンパイラが見つけられないことを意味し、`CS0234` はコンパイラが名前空間は見つけたものの、その中にあるネストされたメンバーが見えないことを意味します。どちらも、C# コンパイラが Roslyn にシンボルを問い合わせ、メタデータ リーダーがそれを解決できなかったときに発火します。SDK スタイル ビルドでは、これは MSBuild が参照リストを組み上げ終えた後に起きるため、そのリストが間違っていれば、デバッグするレイヤーとしてコンパイラは間違っています。

このガイドは .NET SDK 11.0.100-preview.4、MSBuild 17.13、Roslyn 4.13 を対象に書かれています。.NET 8 LTS と .NET 10 でも挙動は同じです。コンパイラ エラー コードは Roslyn のリリース以来安定しているため、対処方法は C# 7.0 以降のすべてのバージョンに適用できます。

## なぜ `ProjectReference` 追加後にコンパイラが型を見つけられないのか

5 つの繰り返し起きる原因があり、この順序で確認してください。上から 3 つで、上記の正確なメッセージにたどり着く検索トラフィックの大半を説明できます。

1. **TargetFramework の不一致。** コンシューマが `net8.0` で参照先プロジェクトが `net11.0`、あるいはコンシューマが `netstandard2.0` で参照先が `net8.0` というケースです。MSBuild はここで正しく振る舞い、参照の結線を拒否しますが、出される警告 (NuGet からの `NU1201`、SDK からの `NETSDK1005`) はビルド出力で見落としやすいものです。続けて発火する C# エラーが CS0246 で、これがあなたが目にした症状です。
2. **古い `obj/` と `bin/`。** MSBuild のインクリメンタル ビルドは積極的に再利用します。`.csproj` を編集すると、アセット ファイル (`obj/project.assets.json`) や応答ファイル (`obj/*.csproj.AssemblyReference.cache`) が新しいグラフと食い違うことがあります。Roslyn は喜んで古い参照セットでコンパイルし、ディスク上には存在するはずの型に対して CS0246 を出します。
3. **`using` ディレクティブの欠落。** 参照は正しく追加し、型も存在し、ビルドも通っているのに、呼び出し側が名前空間をインポートしていません。`ImplicitUsings` を有効にしていても、これは BCL ではまれですが自前の名前空間では普通に起きます。CS0246 末尾のヒント `(are you missing a using directive or an assembly reference?)` がこの選択肢を最初に挙げているのには理由があります。
4. **プロジェクトがソリューションに入っていない。** Visual Studio と `dotnet build <solution>` は、`.sln` ファイルが知っているプロジェクトしかビルドしません。ソリューションに含まれていない `.csproj` への `ProjectReference` を追加できてしまうため、プロデューサ側がビルドされず、コンシューマは型を見つけられません。`dotnet build <consumer.csproj>` はプロジェクト グラフを直接たどるので成功し、IDE はソリューションをたどるので失敗します。
5. **参照に `ReferenceOutputAssembly="false"` または `PrivateAssets="all"` が付いている。** どちらも正当なメタデータ アイテムで、推移的な伝播を抑える、または解析器のようなビルド時専用の参照を渡すために使われます。しかしいずれも、生成されたアセンブリをコンパイラの参照リストに追加しないよう MSBuild に指示します。IDE は Solution Explorer 上ではプロジェクトが参照されているかのように表示することが多く、これがこのケースを最も見つけにくくしています。

目視で除外すべき、件数の少ない原因もいくつか挙げておきます。大文字小文字を区別するファイル システム (Linux, macOS) で `using` ディレクティブと名前空間の大文字小文字が完全に一致していないケース、現在の `Configuration` や `TargetFramework` で参照を除外する `Conditional` ItemGroup、マルチ ターゲットのコンシューマ (`<TargetFrameworks>net8.0;net11.0</TargetFrameworks>`) で内側ビルドの一方しか参照を拾わないケース、そしてコンシューマの最低 `TargetFramework` よりも古い SDK バージョンを固定している global.json などです。

## エラーをコンテキストで見る

TargetFramework が原因の場合、ビルド出力は次のようになります。CS0246 そのものではなく、その上の行に注目してください。

```text
warning NU1201: Project Domain is not compatible with net8.0 (.NETCoreApp,Version=v8.0). Project Domain supports: net11.0 (.NETCoreApp,Version=v11.0)
warning MSB3277: Found conflicts between different versions of "System.Runtime" that could not be resolved.
error CS0246: The type or namespace name 'OrderService' could not be found (are you missing a using directive or an assembly reference?) [C:\src\Api\Api.csproj]
```

決定的な手がかりは `NU1201` です。NuGet の restore はプロジェクトを見つけたものの、ターゲット フレームワーク セットにコンシューマが消費できるものが何もないため拒否しました。その後コンパイラはそのプロジェクトに対して空の参照で動きました。CS0246 は下流の影響であって、バグそのものではありません。

## 最小再現

TargetFramework の不一致を再現する最小の 2 プロジェクト構成です。`Domain/Domain.csproj` と `Api/Api.csproj` として保存してください。

```xml
<!-- Domain/Domain.csproj - .NET 11 preview 4 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

```xml
<!-- Api/Api.csproj - .NET 8 LTS consumer of a net11.0 library -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Domain\Domain.csproj" />
  </ItemGroup>
</Project>
```

```csharp
// Domain/OrderService.cs - .NET 11 preview 4
namespace MyApp.Domain;

public sealed class OrderService
{
    public string Greet(int id) => $"order-{id}";
}
```

```csharp
// Api/Program.cs - .NET 8 LTS
using MyApp.Domain;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<OrderService>();

var app = builder.Build();
app.MapGet("/", (OrderService svc) => svc.Greet(1));
app.Run();
```

`dotnet build Api/Api.csproj` を実行すると、前述のエラーが組で出ます。CS0246 は派手ですが、真の障害はその上にある `NU1201` 警告です。

## 修正 1: TargetFramework の値を揃える

最も安全な手は、ライブラリを下げるよりコンシューマを上げることです。下げると API を失うことが多いからです。

```xml
<!-- Api/Api.csproj - now .NET 11 to match the library -->
<TargetFramework>net11.0</TargetFramework>
```

コンシューマを動かせないなら、ライブラリ側をマルチ ターゲットにして両方向けのアセンブリを出します。

```xml
<!-- Domain/Domain.csproj -->
<TargetFrameworks>net8.0;net11.0</TargetFrameworks>
```

本当にフレームワークに依存しないライブラリなら、`netstandard2.0` は今でも最も広いターゲットで、.NET Framework 4.7.2+、Mono、Unity、すべての最新 .NET から消費できます。API 表面が `netstandard2.0` に収まる場合だけそれを選び、そうでなければ 2026 年の現実では `net8.0` + `net11.0` のマルチ ターゲットの方がクリーンです。

単一の値を持つ `<TargetFrameworks>` についての注意: 単数形の `<TargetFramework>` で書いてください。MSBuild はこれらを別のプロパティとして扱い、`<TargetFrameworks>net8.0</TargetFrameworks>` のプロジェクトは `bin/<config>/` ではなく `bin/<config>/net8.0/` にビルドされ、フラットなレイアウトを前提にしている下流ツールを静かに壊します。

## 修正 2: `.csproj` を編集したら `obj/` と `bin/` を吹き飛ばす

フレームワークが揃っていてもエラーが残るなら、ビルド キャッシュが古くなっています。Roslyn は参照解決を短絡させるために `obj/<project>.csproj.AssemblyReference.cache` とプロジェクトごとの `*.GeneratedMSBuildEditorConfig.editorconfig` を読みます。以前のビルドが常駐している間に `.csproj` を編集して `ProjectReference` を追加すると、キャッシュが新しいグラフと食い違い、コンパイラは古い参照リストで動きます。

.NET 11 における正しいリセットは、単発のクリーン リビルドであれば `dotnet build --no-incremental`、それでも足りないまれなケースではビルド フォルダを手動で削除します。

```powershell
# .NET SDK 11.0.100-preview.4, PowerShell on Windows
Get-ChildItem -Path . -Include obj,bin -Recurse -Directory | Remove-Item -Recurse -Force
dotnet build
```

```bash
# .NET SDK 11.0.100-preview.4, bash on Linux/macOS
find . -type d \( -name obj -o -name bin \) -prune -exec rm -rf {} +
dotnet build
```

`dotnet clean` は意図的に控えめで、出力は消すものの アセット ファイルは残します。そのため、この種のバグを必ず治すわけではありません。完全リセットではなく部分リセットと考えてください。同時に IDE を開いている場合は、`obj/` を消す前に閉じてください。Windows では言語サービスがファイル ハンドルを開いたまま保持しており、ディレクトリの削除が半分くらいで失敗します。

## 修正 3: `using` ディレクティブを追加または修正する

参照が健全になれば、コンパイラは型を見つけられますが、呼び出し側でその名前空間をインポートする必要があります。修正は機械的です。

```csharp
// Api/Program.cs - .NET 11 preview 4
using MyApp.Domain;        // the namespace declared inside Domain/OrderService.cs
// using MyApp.Domain.Models; // for the CS0234 variant where you also need the nested namespace
```

リリースごとにチームを噛む細かい点が 2 つあります。第一に、`<ImplicitUsings>enable</ImplicitUsings>` は固定の名前空間セット (`System`、`System.Collections.Generic`、`System.Linq`、`System.Net.Http`、`System.Threading`、`System.Threading.Tasks` と SDK 固有の追加) を入れてくれますが、自前の名前空間はインポートしません。第二に、C# 10 以降ではグローバル using を宣言してその穴を埋められます。

```xml
<!-- Api/Api.csproj - .NET 11 preview 4 -->
<ItemGroup>
  <Using Include="MyApp.Domain" />
</ItemGroup>
```

これは `obj/` に `GlobalUsings.g.cs` を生成し、`OrderService` を消費するすべての箇所でファイルごとの `using` 行を省けます。トレードオフは、グローバル using によってリファクタリングのノイズが増えることです。グローバル名前空間のタイポはプロジェクト全体を落とし、ライブラリを削除しても赤い波線の波ではなく MSBuild の編集 1 行として隠れます。反射的にではなく、意識的に使ってください。

## 修正 4: プロジェクトがソリューションに入っていることを確認する

`dotnet sln list` が最速の確認方法です。コンシューマが `Api/Api.csproj`、ライブラリが `Domain/Domain.csproj` なら、両方が `.sln` に並んでいる必要があります。

```bash
# .NET SDK 11.0.100-preview.4
dotnet sln list
# Project(s)
# ----------
# Api\Api.csproj
# Domain\Domain.csproj   <-- must be here
```

`Domain` が欠けていると、IDE は知っているように見えます (`ProjectReference` がディスク上で解決されるため) が、ソリューション スコープのビルドはこれをスキップし、単一プロジェクトのリビルドは、コンシューマの `obj/project.assets.json` が誰も生成していないアセンブリを参照しているため失敗します。欠けているプロジェクトを追加してください。

```bash
dotnet sln add Domain/Domain.csproj
```

この罠は、`slnx` と新しい軽量ソリューション フォーマットが .NET 11 SDK で着地したときよりも 2026 年の方が見かけます。CLI は参照グラフが切れているソリューションのビルドも許容しますし、Visual Studio 2026 と Rider 2026.1 の言語サービスは、アクティブ ソリューションの外にある参照プロジェクトについて警告を出すのが上手になりました。それより古い SDK では、警告は静かです。ソリューション ファイルのエルゴノミクス全般については、新しい CLI を一度見ておく価値があります。[.NET 11 の dotnet sln CLI 改善](/ja/2026/04/dotnet-11-sln-cli-solution-filters/) を参照してください。

## 修正 5: `ReferenceOutputAssembly` と `PrivateAssets` を確認する

いくつかの参照は意図的にコンパイラに伝播されません。`ProjectReference` 上で確認すべきメタデータ アイテムは次の 2 つです。

```xml
<!-- Will NOT add Domain.dll to the compiler's reference list -->
<ProjectReference Include="..\Domain\Domain.csproj"
                  ReferenceOutputAssembly="false" />

<!-- Will not flow transitively to projects that consume the consumer -->
<ProjectReference Include="..\Domain\Domain.csproj"
                  PrivateAssets="all" />
```

`ReferenceOutputAssembly="false"` は、参照先がビルド時ツール (コード ジェネレータ、解析器ホスト) で、その出力をビルド グラフに順序付けたいけれどそのアセンブリ自体は消費したくない、というときに正しい設定です。これが本物のライブラリ参照に付いていると、ビルド グラフは健全でもコンシューマは CS0246 で落ちます。

`PrivateAssets="all"` は、推移参照に対する対称的なケースです。`Api` が `Bff` を参照し、`Bff` が `PrivateAssets="all"` で `Domain` を参照していると、`Bff` は `Domain` の型を見られても `Api` からは見えません。手がかりは、生成する側ではなく消費する側のプロジェクトにあります。

## 同じエラーに見えるバリエーション

検索結果では、CS0246 と混同されがちな近い種類のエラーがいくつかあります。

- **`CS1069`: The type name 'X' could not be found in the namespace 'Y'. This type has been forwarded to assembly 'Z'.** 型フォワーダが不足しています。メッセージで挙げられているアセンブリを追加してください。最新の .NET では `System.Configuration.ConfigurationManager` や `System.Drawing.Common` で最もよく見ます。
- **`CS8073` / `CS0518`: Predefined type 'System.Object' is not defined or imported.** 暗黙の `System.Runtime` 参照が壊れています。ほぼ常に、`obj/` の破損か、フレームワークを除外する手書きの `<Reference>` が原因です。まずは `dotnet build --no-incremental` です。
- **`CS0433`: The type 'X' exists in both 'A' and 'B'.** 同じ型を 2 つのアセンブリが公開しています。`ProjectReference` に alias を付け (`<ProjectReference Include="..." Aliases="domain" />`)、呼び出し側で `extern alias` を使って解決します。
- **`NETSDK1005`: Assets file '...' doesn't have a target for 'net8.0'.** 参照先がコンシューマより高いフレームワーク向けにコンパイルされた NuGet パッケージです。上の修正 1 と同じ根本原因ですが、生成側がプロジェクトではなくパッケージなのでメッセージが違います。
- **`MSB4181`: The "ResolvePackageAssets" task returned false but did not log an error.** 純粋な restore 失敗で、パッケージ グラフが解決不能です。問題のパッケージについてグローバル キャッシュ `~/.nuget/packages/<name>/<version>/` を削除して、もう一度 restore してください。CS0246 と一緒に起きがちですが、別問題として扱ってください。

## 修正を確認するためのビルド出力の読み方

参照解決が壊れているときは、C# のエラー一覧ではなくビルド ログにデバッグの軸を移してください。コンパイラは出発点として間違っています。役立つコマンドが 3 つあります。

```bash
# .NET SDK 11.0.100-preview.4
dotnet build -v:n Api/Api.csproj
```

`-v:n` (`-verbosity normal`) は `CoreCompile -> ResolveReferences` の下に解決済みの参照リストを出します。ライブラリがそのリストに無いなら、コンパイラは見ておらず、Roslyn ではなく MSBuild の問題です。

```bash
dotnet build -bl Api/Api.csproj
```

`-bl` はプロジェクトの隣に `msbuild.binlog` を書き出します。これを [MSBuild Structured Log Viewer](https://msbuildlog.com/) で開き、`ResolveAssemblyReferences` を検索してください。MSBuild が Roslyn に渡したファイル パスと、それぞれが含められた、あるいは除外された理由が正確に見えます。

```bash
dotnet msbuild Api/Api.csproj -t:ResolveReferences -p:DesignTimeBuild=false
```

これは参照解決ターゲットだけを単独で実行し、コンパイラは呼びません。出力は簡潔で、失敗が restore、解決、コンパイルのどこにあるかをはっきり示します。CS0246 はノイズから消えます。

## 経験豊富な開発者を捕まえるエッジ ケース

見た目は正しいのに CS0246 を再現するパターンがいくつかあります。

- **`ManagePackageVersionsCentrally=true` の `Directory.Packages.props`。** ライブラリが API に露出している推移依存パッケージに対して `<PackageVersion>` エントリを追加し忘れると、コンシューマはその推移依存から型を解決できません。出るメッセージは想定される missing-version エラーではなく CS0246 です。
- **`Condition` 付きのマルチ ターゲット。** `<ProjectReference Include="..." Condition="'$(TargetFramework)' == 'net11.0'" />` は、マルチ ターゲット コンシューマの `net8.0` 内側ビルドではこの参照をスキップします。IDE は参照を表示しますが、`net8.0` ビルドは型を見られません。
- **`TargetFramework` を含まない SDK を固定する `global.json`。** `global.json` が SDK 8.0.x を選択し、プロジェクトが `net11.0` を狙うと、restore は無害な警告を出すだけで、ビルドは参照ライブラリのすべての型に対して CS0246 で落ちます。`net11.0` 用の SDK パックがインストールされていないためです。
- **Linux の大文字小文字感度。** `using MyApp.Domain;` ではなく `using MyApp.domain;` と書くと、Windows ではコンパイルできて Linux の CI で CS0246 になります。`<EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>` を追加し、`.editorconfig` ルールで大文字小文字を固定してください。
- **Native AOT のコンシューマ。** コンシューマだけに `<PublishAot>true</PublishAot>` が立っていてライブラリには立っていないと、AOT アナライザが推移的な trim 警告をエラーに昇格し、型が trim されると下流の CS0246 でビルドが止まります。修正は、アナライザを黙らせるのではなく、ライブラリを trim-safe にすることです。[Native AOT における PlatformNotSupportedException の記事](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/) が扱っているのと同じ trim の規律がここでも効きます。

## 関連記事

- このエラーの次にチームがぶつかる参照解決の例外は、実行時バージョンで、[Unable to resolve service for type 'X' while attempting to activate 'Y'](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) で扱っています。
- このクラスのバグを見つけやすくするソリューション ファイルのエルゴノミクス: [.NET 11 の dotnet sln CLI の変更点](/ja/2026/04/dotnet-11-sln-cli-solution-filters/)。
- trimming を介して CS0246 を間接的に引き出す Native AOT の隅のケース: [Native AOT における PlatformNotSupportedException](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/)。
- 緑の CI の下で `NU1201` の静かな警告が紛れ込むのを防ぐビルド警告ポリシー: [dev ビルドを壊さない TreatWarningsAsErrors](/ja/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)。
- 欠けている「型」が構成値で、メッセージが精神的に近いとき: [no connection string named 'DefaultConnection' could be found](/ja/2026/05/fix-no-connection-string-named-defaultconnection/)。

## 出典

- Microsoft Learn, [Compiler Error CS0246](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0246).
- Microsoft Learn, [Compiler Error CS0234](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0234).
- Microsoft Learn, [MSBuild ProjectReference protocol](https://learn.microsoft.com/en-us/visualstudio/msbuild/common-msbuild-project-items#projectreference).
- Microsoft Learn, [Implicit using directives in .NET 6+](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/overview#implicit-using-directives).
- Microsoft Learn, [global.json overview](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json).
- MSBuild source, [`Microsoft.Common.CurrentVersion.targets`](https://github.com/dotnet/msbuild/blob/main/src/Tasks/Microsoft.Common.CurrentVersion.targets), where `ResolveProjectReferences` lives.
