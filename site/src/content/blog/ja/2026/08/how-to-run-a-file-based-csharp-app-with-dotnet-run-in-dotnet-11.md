---
title: ".NET 11 で `dotnet run app.cs` を使ってファイルベース C# アプリを実行する方法"
description: "ファイルベース C# アプリの完全ガイド。dotnet run による単一 .cs ファイルの実行、#:package、#:sdk、#:property、#:project、#:include の各ディレクティブ、#:ref による複数ファイル構成のスクリプト、引数と stdin の扱い、ビルドキャッシュ、native AOT での発行、dotnet ツールとしてのパッケージ化、そしてスクリプトが手狭になったときの dotnet project convert を解説します。"
pubDate: 2026-08-09
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "dotnet-10"
  - "dotnet-cli"
  - "file-based-apps"
lang: "ja"
translationOf: "2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-09
---

プロジェクトなしで C# ファイルを実行するには、`app.cs` として保存して `dotnet run app.cs` を実行します。それだけです。SDK はメモリ上にプロジェクトを合成し、復元を行い、一時フォルダー配下のキャッシュディレクトリにビルドして、その結果を実行します。`.csproj` も `Program` クラスも `Main` メソッドも必要ありません。通常はプロジェクトファイルに置く構成は、ソースファイル先頭の `#:` ディレクティブに書きます。`#:package Humanizer@2.14.1` は NuGet パッケージ参照を追加し、`#:sdk Microsoft.NET.Sdk.Web` はスクリプトを Web アプリに変え、`#:property PublishAot=false` は任意の MSBuild プロパティを設定します。ファイルベースアプリは .NET 10 SDK で登場し、.NET 11 で複数ファイル対応を得ました。この記事ではその全体像を扱います。ビルド出力が実際にどこへ行くのか、なぜ作業ディレクトリの `.csproj` がコマンドを黙って横取りするのか、どのディレクティブがどの SDK バージョンを必要とするのかといった、意外に思われる部分も含めます。

以下で検証済みと記した内容はすべて、Windows 上の SDK 10.0.201 (ランタイム .NET 10.0.5) で実行したものです。.NET 11 は執筆時点で Preview 6 であり、GA は 2026 年 11 月が見込まれています。.NET 11 の機能は、挙動が異なる場合にバージョンを明示しています。

## ファイルベース C# アプリを実行する手順

1. コードを `.cs` 拡張子のファイルに保存します。トップレベルステートメントを使い、`class` も `Main` も書きません。
2. 必要な `#:` ディレクティブをファイル先頭に追加します。NuGet 参照には `#:package`、SDK の切り替えには `#:sdk`、MSBuild プロパティには `#:property` を使います。
3. プロジェクトファイルが存在しないディレクトリから `dotnet run app.cs` を実行します。
4. アプリへの引数は `--` 区切りの後ろに渡します。`dotnet run app.cs -- arg1 arg2` のようにします。
5. スクリプトが単一ファイルに収まらなくなったら、`dotnet project convert app.cs` を実行して同等の `.csproj` を生成します。

以降ではこれらの手順を掘り下げ、実際にぶつかって初めて分かる挙動を説明します。

## 動作する最小構成

トップレベルステートメントがエントリポイントになります。`args` は何の準備もなくスコープに入っています。

```csharp
// app.cs -- verified on SDK 10.0.201
Console.WriteLine($"args: {string.Join(",", args)}");
Console.WriteLine($"tfm: {System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}");
Console.WriteLine($"asm: {System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name}");
```

```bash
dotnet run app.cs -- one two
```

```
args: one,two
tfm: .NET 10.0.5
asm: app
```

アセンブリ名に注目してください。ファイル名から取られた `app` になっています。これは後で効いてきます。ビルドキャッシュのディレクトリ、user secrets の ID、パッケージ化したツールの名前は、いずれもここから導出されるからです。

呼び出し方は等価なものが 3 つあります。`dotnet run app.cs` が一般的な形です。`dotnet run --file app.cs` は明示的な形で、曖昧さがないためスクリプトではこちらを使いたいところです。そして `dotnet app.cs` が短縮形です。テストではこの 3 つとも同一の出力になりました。

ファイルを完全に省いて、`-` を引数に指定し標準入力からソースを流し込むこともできます。

```bash
echo 'Console.WriteLine("hello from stdin!");' | dotnet run -
```

これは `hello from stdin!` を出力します。`-` を使うと、SDK は起動プロファイルなど他のファイルを求めて作業ディレクトリを走査しません。ただしビルドの作業ディレクトリは引き続きカレントディレクトリです。C# を生成するシェルスクリプトにとって、これは実に便利な逃げ道です。

## SDK が実際に生成するもの

ファイルベースアプリを理解する最も明快な方法は、SDK が代わりにビルドしているプロジェクトを見ることです。`dotnet project convert` はそれをディスクに書き出します。`Console.WriteLine("plain");` しか含まないファイルの場合、生成されるプロジェクトは次のとおりです。

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <PublishAot>true</PublishAot>
    <PackAsTool>true</PackAsTool>
    <UserSecretsId>plain-c7cf82264bd176cef60e04b947ef58d1b133625432bf800179babd82aa79722e</UserSecretsId>
  </PropertyGroup>

</Project>
```

この既定値のうち 4 つは頭に入れておく価値があります。`ImplicitUsings` と `Nullable` はどちらも有効です。だから `using System;` なしで `Console` が解決されますし、使い捨てのスクリプトでもコンパイラーが null 許容について指摘してきます。`PublishAot` は既定で **true** なので、明示的に無効化しない限り `dotnet publish app.cs` はネイティブ実行可能ファイルを生成します。`PackAsTool` も既定で true なので、`dotnet pack app.cs` は追加設定なしで `dotnet tool install` 可能なパッケージを出力します。`UserSecretsId` はファイルのフルパスの安定したハッシュです。つまり user secrets はそのまま動きますが、ファイルを移動すると解決されなくなります。

`TargetFramework` はインストール済みの SDK に追随します。SDK 10.0.201 では `net10.0`、.NET 11 SDK では `net11.0` です。気になる場合は `#:property TargetFramework=net10.0` で明示的に固定してください。

## 5 つのディレクティブ

ディレクティブは `#:` を前置してファイル先頭に置きます。ドキュメント化されているのは `#:include`、`#:package`、`#:project`、`#:property`、`#:sdk` です。

`#:package` は NuGet パッケージ参照を追加します。バージョンは `@` の後ろに書きます。

```csharp
// pkg.cs -- verified on SDK 10.0.201
#:package Humanizer@2.14.1

using Humanizer;
Console.WriteLine(TimeSpan.FromMinutes(90).Humanize(2));
```

これは `1 hour, 30 minutes` を出力します。最新バージョンに追随させるには `@*` を使います。バージョンを完全に省略できるのは、`Directory.Packages.props` によって中央パッケージ管理下にある場合だけです。それ以外では固定するか `@*` を使ってください。

`#:sdk` は MSBuild SDK を差し替えます。単一ファイルから Web アプリを作れるのはこれのおかげです。

```csharp
// web.cs
#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=false

var app = WebApplication.Create();
app.MapGet("/", () => "ok");
app.Run();
```

`#:sdk` は `#:sdk Aspire.AppHost.Sdk@13.0.2` のようにバージョン指定も受け付けます。`Microsoft.NET.Sdk.Web` に切り替えると既定の項目 glob も変わり、ディレクトリ内の `*.json` 構成ファイルが自動的に取り込まれます。

`#:property` は任意の MSBuild プロパティを設定し、リテラルに限定されません。MSBuild のプロパティ関数が使えるので、既定値付きで環境変数を読めます。

```csharp
#:property LogLevel=$([MSBuild]::ValueOrDefault('$(LOG_LEVEL)', 'Information'))
```

`#:project` は実際のプロジェクトファイル、またはそれを含むディレクトリを参照します。通常のソリューションへ戻る橋渡しになります。

```csharp
#:project ../SharedLibrary/SharedLibrary.csproj
```

## 複数ファイル構成のスクリプトと、それを左右する SDK バージョン

`#:include` は他のファイルを同一のコンパイルに取り込みます。拡張子で対応付けられ、`*.cs` は `Compile`、`*.resx` は `EmbeddedResource`、`*.json` は `None`、`*.razor` は `Content` になります。リテラルなパス、glob パターン、MSBuild プロパティのいずれも使えます。

```csharp
#:include helpers.cs
#:include models/customer.cs
#:include shared/**/*.cs
```

重要な制約があります。取り込まれた `.cs` ファイルは型、メソッド、名前空間を追加できますが、トップレベルステートメントを含めることは**できません**。それを持てるのはエントリファイルだけです。

`#:include` には .NET SDK 10.0.300 または .NET 11 Preview 3 以降が必要です。それより古い SDK では、バージョンに関する親切なメッセージではなく素っ気ない拒否が返ります。10.0.201 での正確なエラーは次のとおりです。

```
inc.cs(1): error: Unrecognized directive 'include'.
```

これが出たら、タイプミスを探し始める前に `dotnet --version` を確認してください。これは [.NET 10 での `#:include` が節目として注目された](/ja/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/)ときと同じギャップです。

.NET 11 Preview 5 では、複数ファイルにまたがるための 2 つ目の異なる方法が追加されました。[`#:ref` ディレクティブ](/ja/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/)です。これは他のファイルベースアプリを 1 つのコンパイルに統合するのではなく、*ライブラリ*として参照するもので、推移的な参照もサポートされます ([dotnet/sdk#53480](https://github.com/dotnet/sdk/pull/53480))。同じプレビューで `#:include` と `#:exclude` から機能フラグが外れ ([dotnet/sdk#53775](https://github.com/dotnet/sdk/pull/53775))、取り込まれたファイル内のディレクティブが推移的に処理されるようになりました ([dotnet/sdk#54012](https://github.com/dotnet/sdk/pull/54012))。Preview 6 では `#:include` がコンパイル済みアセンブリにも拡張され、`#:include ./libs/MyLibrary.dll` がフラグなしで動くようになりました。

これらのプレビューノートにある挙動の細部のうち、2 点は見落としやすいところです。`#:project` と `#:ref` の重複エントリは許可され、MSBuild の項目セマンティクスに沿います。それ以外の種類のディレクティブが取り込まれたファイル間で重複した場合は、黙って受け入れられるのではなく診断が出ます。ただし Preview 6 では、重複した値が一致する場合の `#:sdk`、`#:property`、`#:package` について、この扱いが緩和されました。なお `#:ref` と `#:exclude` は SDK のリリースノートには記載されていますが、[MS Learn のファイルベースアプリの記事](https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps)にはまだ載っていません。この 2 つについてはリリースノートを正とみなしてください。

## 引数、環境変数、そして出力の行き先

`--` の後ろの引数は CLI に消費されず、アプリへ転送されます。環境変数は `-e` でインラインに設定できます。

```bash
dotnet run -e FOO=bar env.cs
```

これは `Environment.GetEnvironmentVariable("FOO")` から `FOO=bar` を出力します。.NET 11 のリリースノートは `dotnet run -e` を新しい SDK オプションとして挙げていますが、ここで検証した SDK 10.0.201 でも既に動作しました。

ビルド出力はファイルの隣には置かれません。システムの一時フォルダー配下の内容アドレス方式のディレクトリ、すなわち `<temp>/dotnet/runfile/<appname>-<sha>/bin/<configuration>/` という形の場所に置かれます。Windows で検証したパスは次のとおりです。

```
C:\Users\...\AppData\Local\Temp\dotnet\runfile\app-82b0b938fb24db69...\bin\debug\app.dll
```

`dotnet build` の `--output` で行き先を変えるか、ファイル内で `#:property OutputPath=./output` を指定して既定値を設定してください。

## パフォーマンスの話はビルドキャッシュに尽きる

SDK はソースファイルの内容、ディレクティブの構成、SDK バージョン、暗黙のビルドファイルの有無と内容をキーにしてビルド出力をキャッシュします。その差はツールの使い心地を変えるほど大きなものです。SDK 10.0.201、同一マシン、同一の些細なスクリプトでの計測値です。

| 実行 | 実時間 |
| --- | --- |
| `dotnet clean app.cs` 後の初回実行 | 1.174 秒 |
| キャッシュ利用時の実行 | 0.252 秒 |

0.25 秒は、`.cs` ファイルがシェルスクリプトの現実的な代替になる範囲に入っています。コールドビルドはそうではありません。

キャッシュの挙動のうち 3 点が混乱のもとになります。`Directory.Build.props` のような暗黙のビルドファイルへの変更は、必ずしも再ビルドを引き起こしません。ファイルを別のディレクトリへ移動してもキャッシュは無効化されません。そして `#:include` で glob パターンを使うと、現状ではビルドキャッシュが完全に無効になります。つまり `shared/**/*.cs` の 1 行が、黙って高速パスを奪います。

消去するには次のようにします。

```bash
dotnet clean file-based-apps
```

このコマンドは `<temp>/dotnet/runfile` を走査し、少なくとも 30 日間使われていない成果物フォルダーを削除します。しきい値を変えるには `--days` を渡します。単一のアプリについては、`dotnet clean app.cs` に続けて `dotnet build app.cs` を実行するとクリーンな再ビルドを強制できます。

並行実行についての注意が 1 点あります。同じファイルベースアプリのインスタンスを並列に複数実行すると、ビルド出力ファイルの競合で失敗することがあります。先に一度ビルドしてから `--no-build` で実行してください。

```bash
dotnet build app.cs
dotnet run app.cs --no-build
```

## 発行、パッケージ化、シェルからの実行

`dotnet publish app.cs` は `.cs` ファイルの隣の `artifacts` ディレクトリに自己完結型の実行可能ファイルを生成します。`PublishAot` が既定で true なので、これは起動が速くランタイム依存のない native AOT バイナリになります。配布するコマンドラインツールにはまさに望ましいものであり、スクリプトがリフレクションを多用するライブラリを使っている場合にはまさに望ましくないものです。無効化するには `#:property PublishAot=false` を指定します。自分のコードがこの線のどちら側にあるか判断がつかない場合、トレードオフは [Native AOT が実際に何を犠牲にするか](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)で扱ったものと同じです。ビルドと発行の違いについても正確に押さえておく価値があり、それは [`dotnet build` と `dotnet publish` の違い](/ja/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)で扱っています。

`dotnet pack app.cs` は NuGet パッケージを生成します。`PackAsTool` が既定で true なので、そのパッケージはグローバルツールとしてインストール可能です。1 つの `.cs` ファイルから、プロジェクトファイルなしで出荷可能な `dotnet tool` に至る道のりは、実に短いものです。

Unix 系システムでは、shebang を使ってファイルを直接実行可能にできます。

```csharp
#!/usr/bin/env -S dotnet --
#:package Spectre.Console@*

using Spectre.Console;

AnsiConsole.MarkupLine("[green]Hello, World![/]");
```

```bash
chmod +x file.cs
./file.cs
```

`-S` フラグは `env` に行の残りを個別の引数へ分割させます。末尾の `--` は、`dotnet` が自身のもののように見える引数 (たとえば `--help`) を飲み込むのを防ぎます。改行コードは LF を使い、BOM は付けないでください。付けると shebang が認識されません。`env` が `-S` に対応していない場合は `#!/usr/bin/env dotnet` にフォールバックし、引数衝突のリスクを受け入れてください。

## 最も時間を浪費させる落とし穴

現在の作業ディレクトリにプロジェクトファイルが存在すると、`dotnet run app.cs` は*そのプロジェクト*を実行し、`app.cs` をコマンドライン引数としてそちらに渡します。これは意図的な後方互換性であり、しかも何も告げずに起こります。

検証済みです。`pkg.csproj` を含むディレクトリから `dotnet run ../env.cs` を実行すると、`env.cs` ではなく `pkg.csproj` が実行され、その出力が表示されました。警告は一切ありません。確実を期すときは `dotnet run --file ../env.cs` を使い、ファイルベースアプリはどのプロジェクトのディレクトリ配下にも置かないでください。

```
MyProject/
  MyProject.csproj
  Program.cs
scripts/
  utility.cs
```

関連する罠が暗黙のビルドファイルです。ファイルベースアプリは、カレントディレクトリと親ディレクトリの `Directory.Build.props`、`Directory.Build.targets`、`Directory.Packages.props`、`nuget.config`、`global.json` を尊重します。リポジトリのルートにある `Directory.Build.props` が `TreatWarningsAsErrors` を設定していれば、それは使い捨てのスクリプトにも適用されます。分離が必要な場合は、スクリプト専用のディレクトリを用意し、そこに専用の `Directory.Build.props` を置いてください。

細かい点が 2 つあります。起動プロファイルは `Properties/launchSettings.json` ではなく、`app.cs` の隣のフラットな `app.run.json` に置きます。両方が存在する場合は従来の場所が優先され、CLI が警告を記録します。また `dotnet user-secrets` でスクリプトを対象にするには `--file` オプションが必要です。`dotnet user-secrets set "ApiKey" "value" --file app.cs` のように書きます。

## スクリプトがスクリプトでなくなるとき

`dotnet project convert app.cs` が卒業への道です。このコマンドは `.cs` ファイルをコピーし、あなたの `#:` ディレクティブから導出した同等の SDK、プロパティ、パッケージ参照を持つ `.csproj` を書き出します。両者はアプリ名を冠した新しいディレクトリに置かれます。元のファイルは手つかずのまま残るので、変換は非破壊的であり、採用を決める前に結果を差分で確認できます。

上記の Humanizer の例に対して実行したところ、期待どおりの変換になりました。`#:package Humanizer@2.14.1` は `PackageReference` に、`#:property PublishAot=false` はプロパティになります。

```xml
  <ItemGroup>
    <PackageReference Include="Humanizer" Version="2.14.1" />
  </ItemGroup>
```

この段階的な移行こそが、この機能の本当の設計です。1 ファイルから始めます。`#:include` でヘルパーを切り出します。`#:ref` でヘルパーをライブラリへ昇格させます。`#:project` で実際のプロジェクトを指します。そして MSBuild の手続きがようやく見合うようになったら変換します。各ステップは 1 行であり、どれも `dotnet run` の放棄を強いません。実際にプロジェクトを持つようになった後の内側の開発ループについては、[`dotnet watch` と `dotnet run` の違い](/ja/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)が次に知っておく価値のあることです。

## 関連記事

- [.NET 11 Preview 5 で `#:ref` によりファイルベースアプリが相互参照できるようになりました](/ja/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/)
- [.NET 10 のファイルベースアプリが複数ファイルのスクリプトに対応しました。`#:include` が到着します](/ja/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/)
- [`dotnet build` と `dotnet publish` の違いは何ですか](/ja/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)
- [Native AOT とは何か、そして何を犠牲にするのか](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [`dotnet watch` と `dotnet run` の違いは何ですか](/ja/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)

## 参考資料

- MS Learn の [File-based apps](https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps)。ディレクティブ、CLI コマンド、キャッシュ、フォルダー構成に関する概念リファレンスです。
- [What's new in .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview)。`#:include` の DLL サポートと `dotnet run -e` が挙げられています。
- [.NET 11 Preview 5 SDK リリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md)。`#:ref`、機能フラグの撤廃、重複ディレクティブの診断について。
- [.NET 11 Preview 6 SDK リリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/sdk.md)。コンパイル済みアセンブリの `#:include` について。
- .NET ブログの [Announcing dotnet run app.cs](https://devblogs.microsoft.com/dotnet/announcing-dotnet-run-app/)。当初の設計意図が書かれています。
