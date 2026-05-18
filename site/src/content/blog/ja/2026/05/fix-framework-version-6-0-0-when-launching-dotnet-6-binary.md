---
title: "修正: .NET 6 バイナリ起動時の framework_version=6.0.0 was not found"
description: ".NET 6 ランタイムが消えたか合っていません。net6.0 を入れ直すか、runtimeconfig で net8.0 へ roll forward するか、csproj のターゲットを変えるか、self-contained で発行します。"
pubDate: 2026-05-18
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-6"
  - "runtime"
  - "deployment"
lang: "ja"
translationOf: "2026/05/fix-framework-version-6-0-0-when-launching-dotnet-6-binary"
translatedBy: "claude"
translationDate: 2026-05-18
---

修正方法: `framework_version=6.0.0` を出して起動を拒否する .NET 6 バイナリは、アプリが壊れているのではなく、マシンに .NET 6 ランタイムが無いと言っています。まだ `net6.0` を残しておけるサーバーであれば、Microsoft.NETCore.App 6.0 ランタイムをインストールすれば起動エラーは消えます。net8.0 や net10.0 に移行したサーバーでは、`runtimeconfig.json` の `rollForward` を `Major` に設定するか、プロジェクトをサポート対象のフレームワークにターゲット変更するか、バイナリ自身がランタイムを抱えるように self-contained で発行します。その修正の直後に `MissingMethodException` が出る場合、それは同じ問題が時限式で発火したものです。roll-forward によってアプリは新しいランタイムで起動できたものの、ある推移的アセンブリが .NET 6 にあって新しいランタイムでは名前が変わったメソッドへ固く結びついているためです。

```text
You must install or update .NET to run this application.

App: /opt/myapp/MyApp
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '6.0.0' (x64)
.NET location: /usr/share/dotnet

The following frameworks were found:
  8.0.15 at [/usr/share/dotnet/shared/Microsoft.NETCore.App]
  10.0.0 at [/usr/share/dotnet/shared/Microsoft.NETCore.App]

Learn more:
https://aka.ms/dotnet/app-launch-failed

To install missing framework, download:
https://aka.ms/dotnet-core-applaunch?framework=Microsoft.NETCore.App&framework_version=6.0.0&arch=x64&rid=linux-x64&os=linux
```

このガイドは 2026 年 5 月時点の状況に合わせて書かれています。.NET 6 は 2024-11-12 にサポート終了を迎えたため、プロダクション用イメージ、パッケージマネージャー、自動更新されるベースレイヤーは .NET 6 を取り除き始めています。2 年間プロダクションで動いていた同じバイナリが、今は上記のメッセージで起動に失敗します。挙動はホストが Windows の `dotnet.exe MyApp.dll` であっても、Linux の apphost スタブであっても、macOS の `dotnet exec` であっても同じです。ここで説明するランタイムの probing ルールは、.NET 6、.NET 8、.NET 10 のホストのものであり、バージョン間で変わっていません。

## エラーは 2 種類、根本原因は 1 つ

このエラーは無関係に見える 2 つの形で現れ、ほとんどのチームが引っかかるのは 2 つ目の方です。

1 つ目は冒頭の host-fxr エラーです。ホストは `MyApp.runtimeconfig.json` を開いて `tfm` と `framework` ブロックを読み、`Microsoft.NETCore.App` バージョン 6.0.0 が必要だと判断します。次にインストールパスをたどり、何も見つからないか、もっと新しい SxS フォルダしか見つかりません。インストール URL にはフレームワーク名とバージョンがクエリパラメーターとして埋め込まれているので、`framework_version=6.0.0` でググるとみんな同じ問題に辿り着くわけです。

2 つ目は実行時の `MissingMethodException` です。ホストは互換性のあるフレームワークを見つけ、プロセスは起動し、その後 `JIT_GetMethodCall` のルックアップが失敗します:

```text
System.MissingMethodException: Method not found: 'System.String System.String.IsNullOrEmpty(System.String)'
   at MyApp.Services.RequestPipeline.HandleAsync(HttpContext ctx)
```

これは、アプリは新しいランタイムで起動したものの、読み込まれたアセンブリの 1 つが .NET 6 の参照アセンブリに対してコンパイルされていて、.NET 8 や .NET 10 でシグネチャが変わったメソッドを参照しているときに起こります。roll-forward が起動チェックを通してしまい、その代償としてユーザーコードでバインディングエラーが遅れて出ます。どちらのメッセージも、.NET 6 ランタイムがこのマシンに無いということを意味しています。

## なぜバイナリがピンポイントで 6.0.0 を要求するのか

バージョン文字列 `6.0.0` は、プロジェクトをビルドしたときにインストールされていたランタイムバージョンではありません。コンパイル対象の `<TargetFramework>` が宣言した下限値です。`net6.0` プロジェクトで `dotnet publish` を実行すると、MSBuild は次のような `MyApp.runtimeconfig.json` を書き出します:

```json
{
  "runtimeOptions": {
    "tfm": "net6.0",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "6.0.0"
    },
    "configProperties": {
      "System.Runtime.TieredCompilation": true
    }
  }
}
```

ホストはこの `version` フィールドを完全一致ではなく最小値として扱います。既定の `rollForward` ポリシーである `Minor` では、6.x はどれでも受け入れますが、7.x 以上は決して受け入れません。`Major` だと 7.x、8.x、10.x を受け入れます。`LatestPatch` だと 6.0.x のみです。検索クエリが `framework_version=6.0.0` になっている理由は、6.x がまったく入っていないときでもホストが要求した下限値をそのままエコーするからです。

失敗するホストで `dotnet --list-runtimes` を実行してください。`Microsoft.NETCore.App 8.0.15` と `10.0.0` は見えるのに 6.x の行が無ければ、それが診断結果です。本来あるべき行は `Microsoft.NETCore.App 6.0.x [/usr/share/dotnet/shared/Microsoft.NETCore.App]` です。

## 最小再現

`net6.0` コンソールアプリをビルドし、framework-dependent で発行し、新しいランタイムしか入っていないホストで実行します。

```xml
<!-- MyApp.csproj, .NET SDK 8.0.300+ still builds net6.0 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net6.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// MyApp/Program.cs, .NET 6, C# 10
Console.WriteLine($"Running on .NET {Environment.Version}");
```

```bash
dotnet publish -c Release -r linux-x64 --self-contained false -o ./out
./out/MyApp
# You must install or update .NET to run this application.
# Framework: 'Microsoft.NETCore.App', version '6.0.0' (x64)
```

ベースを `mcr.microsoft.com/dotnet/aspnet:6.0` から `mcr.microsoft.com/dotnet/aspnet:8.0` に切り替えたものの、プロジェクトをターゲット変更していない Docker イメージでもまったく同じ形で発生します。`runtimeconfig.json` の `net6.0` タグはベースイメージのバンプより長生きします。

## 修正一、推奨: プロジェクトのターゲットを変える

2026 年にサポートされている答えは、`net6.0` の出荷をやめることです。.NET 6 は 2024 年 11 月にセキュリティパッチが止まり、.NET 7 は 2024 年 5 月、.NET 9 は 2026 年 5 月に止まりました。現時点でサポートされているブランチは `net8.0` (LTS、2026 年 11 月までサポート)、`net10.0` (LTS、2028 年 11 月までサポート)、そして開発中の `net11.0` プレビューだけです。

プロジェクトファイルを変更し、復元してから再発行します:

```xml
<!-- MyApp.csproj, .NET SDK 10.0.x -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

```bash
dotnet restore
dotnet publish -c Release -r linux-x64 --self-contained false -o ./out
```

`runtimeconfig.json` は `version: 10.0.0` を宣言するようになり、`Microsoft.NETCore.App 10.0.0` がインストールされているホストは文句を言わずに起動します。これは `MissingMethodException` のバリアントも同時に消す唯一の修正です。なぜなら、アプリは実行されるランタイムと同じ参照アセンブリに対してコンパイルされるようになるからです。

`net10.0` ビルドを出していないパッケージにプロジェクトが依存している場合、通常は 2 つの逃げ道があります。パッケージのバージョンを上げるか、`<TargetFrameworks>net6.0;net10.0</TargetFrameworks>` を設定してマルチターゲットの出力を出荷するかです。新しいサーバーのホストは `net10.0` を選び、古いサーバーのレガシーホストは `net6.0` を選び、6.x マシンを完全に廃止するまで両方が動き続けます。

## 修正二、低コスト: 新しいランタイムへ roll forward する

ターゲット変更がブロックされている場合 (再コンパイルできないベンダーバイナリ、遅いリリースサイクル、すべてのアセンブリに法務レビューが必要、など)、`rollForward` ポリシーを変えて .NET 6 バイナリを新しいランタイム上で起動させます。設定箇所は 2 か所あります。

発行前にプロジェクトで設定する:

```xml
<!-- MyApp.csproj, still net6.0 -->
<PropertyGroup>
  <TargetFramework>net6.0</TargetFramework>
  <RollForward>Major</RollForward>
</PropertyGroup>
```

または、発行済みの成果物のバイナリの隣にある `MyApp.runtimeconfig.json` を編集する:

```json
{
  "runtimeOptions": {
    "tfm": "net6.0",
    "rollForward": "Major",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "6.0.0"
    }
  }
}
```

ファイルを触らずに、1 回の起動だけ環境変数で済ますこともできます:

```bash
DOTNET_ROLL_FORWARD=Major ./out/MyApp
```

`Major` は新しいメジャーをどれでも受け入れます。`LatestMajor` は同じことをしつつ、常にインストール済みの最も高いメジャーを選びます。複数のランタイムメジャーにまたがるプロダクションフリートが普段欲しがるのはこちらです。プロセスを再起動すれば起動エラーは消えます。

roll-forward は、後から `MissingMethodException` を生む修正です。依存関係グラフの中に .NET 6 の参照アセンブリに対してコンパイルされ、.NET 8 や .NET 10 で削除または改名されたメソッドを呼び出すパッケージがあれば、そのコードパスが最初に実行されたときに JIT がそれを発見します。このケースを回避する方法は、問題のパッケージを更新するか、修正一に戻るかしかありません。

## 修正三、最後の手段: .NET 6 ランタイムをインストールする

マシンがサポート外のランタイムを残さなければならない場合は、明示的にインストールします。Microsoft は .NET 6 ランタイムのダウンロードを end-of-life マークを付けて、起動エラーがリンクしていたのと同じ URL で今もホストしています。

Debian と Ubuntu ではパッケージ名は `dotnet-runtime-6.0` です:

```bash
sudo apt-get install -y dotnet-runtime-6.0
dotnet --list-runtimes
# Microsoft.NETCore.App 6.0.36 [/usr/share/dotnet/shared/Microsoft.NETCore.App]
# Microsoft.NETCore.App 8.0.15 [...]
# Microsoft.NETCore.App 10.0.0 [...]
```

Windows では `winget install Microsoft.DotNet.Runtime.6` か単体 MSI でインストールします。Docker イメージでは `FROM mcr.microsoft.com/dotnet/aspnet:8.0` を `FROM mcr.microsoft.com/dotnet/aspnet:6.0` に戻すか、`mcr.microsoft.com/dotnet/runtime-deps:6.0` のマルチバージョンイメージに `dotnet-runtime-6.0` を明示的にインストールするレイヤーを足します。

次の無人アップグレードで再び削除されないように、`dotnet-runtime-6.0` を hold で固定します:

```bash
sudo apt-mark hold dotnet-runtime-6.0
```

これは執行猶予であって修正ではありません。ランタイムはもうセキュリティパッチを受けないので、`System.Net.Http` や `System.Text.Json` 6.x の CVE はそのホストでは未パッチのままです。修正一を完了するまでの期限延長として扱ってください。

## 修正四、隔離: self-contained で発行する

ビルドはコントロールできるがデプロイ先はコントロールできない場合は、成果物の中にランタイムを同梱します。self-contained 発行は `Microsoft.NETCore.App` のファイルを DLL の隣に置き、ホストはシステムにランタイムを要求しません。

```bash
dotnet publish -c Release -r linux-x64 \
  --self-contained true \
  -p:PublishSingleFile=true \
  -p:PublishTrimmed=false \
  -o ./out
```

出力は約 70 MB 大きくなり、デプロイ先のマシンには何もインストールする必要がありません。これは `net6.0` でも動作しますが、ビルドする SDK が `net6.0` の参照パックをまだ解決できる必要があります。執筆時点では .NET SDK 10.0.x は `net6.0` をターゲットにできるので、最新の SDK でビルドして問題ありません。

self-contained は、1 回限りのツール、CI スクリプト、サイドカー、ホスト環境を指定できないあらゆる場面で正しい答えです。共通ランタイムへのパッチ適用がセキュリティ運用の一部になっているフリートでは、間違った答えです。なぜなら、各アプリが `System.Net.Http` のコピーを自前で抱え、CVE が出るたびに再ビルドしなければならないからです。

## 直す前に診断する

ホストには、何をどこで探しているかを正確に出力する verbose モードがあります。`COREHOST_TRACE=1` (任意で `COREHOST_TRACEFILE=/tmp/host.log`) を設定し、失敗するバイナリを再実行します:

```bash
COREHOST_TRACE=1 COREHOST_TRACEFILE=/tmp/host.log ./out/MyApp
grep -E "version|framework|rollForward" /tmp/host.log
```

ログには、ホストが検討したフレームワークバージョン、適用された `rollForward` ポリシー、probing したパスがすべて並びます。8.0.15 を見つけたのに `rollForward=LatestPatch` が設定されていたために拒否した、とログが言うなら、ポリシーを切り替えればいいと分かります。`/usr/share/dotnet/shared/Microsoft.NETCore.App` の下に何も見つからなかったとログが言うなら、インストールするか配置を変えるかと分かります。

`MissingMethodException` の形では、スタックトレースが間違ったメソッドにバインドしたアセンブリを名指しします。発行済みフォルダを開き、ホストに対して `dotnet --info` を実行してランタイムバージョンを確認し、問題の DLL を `ildasm` や `dotnet-ildasm` で覗いて 6.0 参照アセンブリを参照していることを確認してください。`net8.0` または `net10.0` ビルドのあるパッケージに置き換えるか、両方を維持しなければならない場合は `<AssemblyLoadContext>` 経由のバインディングリダイレクトを使ってください。

## 落とし穴とそっくりさん

URL の `framework_version` パラメーターはインストール済みランタイムのバージョン**ではなく**、アプリが要求した下限値です。「install .NET 6.0.0」だけを検索するのは行き止まりです。実際に出荷されるパッチは 6.0.36 のような番号だからです。インストールするのは最新の 6.0.x であって 6.0.0 ではありません。

`Microsoft.NETCore.App` ではなく `Microsoft.AspNetCore.App` 側の `MissingMethodException` も同じロジックですが、指す先は ASP.NET Core の共有フレームワークです。修正経路も `rollForward` のつまみも同じで、.deps.json の共有フレームワーク名が違うだけです。

`dotnet --info` は SDK とランタイムを一覧表示します。アプリが使うランタイムは "Microsoft.NETCore.App" の下に並ぶものです。"Microsoft.AspNetCore.App 6.0.x" だけがインストールされていると、ASP.NET Core アプリは起動しますがコンソールアプリは引き続き元のエラーを出します。ASP.NET 共有フレームワークは .NET ランタイムに依存していますが、同じインストールではないからです。

Windows では apphost は `dotnet.exe` ではなく `MyApp.exe` です。エラーメッセージもトラブルシュートも同じで、`where dotnet` は間違った質問に答えます。どのホストが動いているかは `MyApp.exe --info` で確認してください。

バイナリが Azure App Service や Functions ホストの中から起動する場合、ランタイムパスはプラットフォームが設定します。修正は App Service の構成 "Stack" バージョンであって、ローカルのファイルではありません。App Service 向けの関連バリアントは [Microsoft.NetCore.App または Microsoft.AspNetCore.App の指定バージョンが見つかりません](/ja/2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found/) で扱っており、同じ根本原因を Azure ポータルを前に解説しています。

## 関連

- [修正: 発行済みアプリでの Could not load file or assembly](/ja/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) -- ホストがランタイムは見つけたが、発行フォルダにプロジェクト DLL が無い場合。
- [Azure App Service: Microsoft.NetCore.App が見つからない](/ja/2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found/) -- プラットフォームがホストを持っている場合の同じ根本原因。
- [修正: CI で 'dotnet' コマンドが見つからない](/ja/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/) -- ランタイムが PATH にすら無い場合。
- [修正: ProjectReference 追加後の The type or namespace name could not be found](/ja/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) -- ターゲット変更が `NU1201` の TargetFramework 不一致を引き起こす場合。
- [修正: Native AOT での PlatformNotSupportedException](/ja/2026/05/fix-platformnotsupportedexception-in-native-aot/) -- 発行後にだけ表面化する関連クラスのランタイムホストエラー。

## 参考

- [.NET 6 サポート終了アナウンス](https://learn.microsoft.com/en-us/lifecycle/announcements/dotnet-6-end-of-support) と .NET リリーススケジュール (まだパッチを受けるブランチを確認)。
- [framework-dependent アプリの roll forward](https://learn.microsoft.com/en-us/dotnet/core/versions/selection#framework-dependent-apps-roll-forward) -- `rollForward` ポリシーの完全な表。
- [Self-contained 配置](https://learn.microsoft.com/en-us/dotnet/core/deploying/) -- `--self-contained` での発行フロー。
- [.NET ランタイム構成設定](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/) -- `runtimeconfig.json` の完全なスキーマ。
- [dotnet/runtime issue #79286](https://github.com/dotnet/runtime/issues/79286) -- ホストのフレームワーク解決ロジックとトレースフラグに関する正典スレッド。
