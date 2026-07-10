---
title: "dotnet build と dotnet publish の違いは何ですか?"
description: "dotnet build は内側の開発ループのためにプロジェクトをコンパイルし、既定で Debug を使います。dotnet publish は MSBuild の Publish ターゲットを実行し、net8.0 以降では既定で Release を使い、Web アセット、自己完結型ランタイム、単一ファイル、トリミング、AOT まで処理済みのデプロイ可能なフォルダーをパッケージ化します。ここではそれぞれが何を生成し、いつ使うかを正確に説明します。"
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "dotnet-cli"
  - "msbuild"
  - "deployment"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish"
translatedBy: "claude"
translationDate: 2026-07-10
---

`dotnet build` は、内側の開発ループのためにプロジェクトとその依存関係を IL アセンブリにコンパイルし、既定で `Debug` 構成を使います。`dotnet publish` は別の MSBuild ターゲットを実行し、サーバーへコピーする準備が整った自己完結型のフォルダーを生成します。これは target が `net8.0` 以降のあらゆるプロジェクトで既定で `Release` 構成を使い、アプリケーションをデプロイ用に準備する唯一の公式にサポートされた方法です。手短に言えば、`build` はコードを書いている間に実行するもの、`publish` は書き終えて出荷できるものが欲しいときに実行するものです。実際に効いてくる違いは、既定構成の切り替えと、`Publish` ターゲットが行い `Build` が行わないすべて、つまり Web アセットの処理、自己完結型デプロイのためのランタイムのパッケージ化、そして単一ファイル、トリミング、AOT の適用です。

以下のすべては、`<TargetFramework>net11.0</TargetFramework>` と C# 14 を使う .NET 11 SDK (`11.0.100`) を対象としています。特定のバージョンを明記しない限り、記載した挙動は .NET 8 SDK 以降に当てはまります。最も影響の大きい違いである既定構成が .NET 8 で変わったからです。

## 同じものの 2 つの味ではなく、2 つの異なる MSBuild ターゲット

どちらのコマンドも MSBuild の薄いラッパーですが、異なるターゲットを呼び出します。そしてこの 1 つの事実が、あなたが気づくほとんどすべての違いを説明します。

`dotnet build` は既定の `Build` ターゲットを実行します。[dotnet build のリファレンス](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build)によれば、これを実行することは、既定の出力の詳細度が異なるだけの `dotnet msbuild -restore` と同等です。コードとその依存関係を一連のバイナリにコンパイルし、そこで止まります。

`dotnet publish` は `Publish` ターゲットを実行します。[dotnet publish のリファレンス](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-publish)は、これが「アプリケーションをコンパイルし、プロジェクトファイルで指定された依存関係を読み取り、結果として得られる一連のファイルをディレクトリに発行する」こと、そしてその出力が「ホスティングシステムへのデプロイの準備が整っている」ことを明言しています。`Publish` ターゲットは `Build` に依存するため、publish は常にまずビルドし、その上でさらに作業を行います。

その「その上でさらに作業」がすべてです。`Publish` ターゲットが何を追加するかを理解すれば、`build` の出力で十分なときと、それが本番環境で静かに失敗するときが分かります。

## 既定構成は、ほとんどの人が最初に踏む罠

これは人々に丸一日を費やさせる違いなので、最初に扱います。

`dotnet build` は既定で `Debug` を使います。`dotnet publish` は既定で `Release` を使いますが、target が `net8.0` 以降のプロジェクトに限ります。どちらの既定値も `-c|--configuration` で上書きできます。

```bash
# .NET 11 SDK 11.0.100, project targeting net11.0.
dotnet build      # builds Debug   -> bin/Debug/net11.0/
dotnet publish    # publishes Release -> bin/Release/net11.0/publish/
```

.NET 8 より前は、`dotnet publish` も既定で `Debug` を使っており、多くの手癖や CI スクリプトが今なおそれを前提にしています。Microsoft はこれを意図的に変更し、デプロイ成果物を生成するのが仕事であるコマンドが、既定で最適化されたものを生成するようにしました。この変更は['dotnet publish' は Release 構成を使う](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/8.0/dotnet-publish-config)に文書化されています。

実際の結果として、`dotnet build` を実行してから `bin/Debug/...` をサーバーにコピーすると、JIT の最適化が無効でデバッグ補助が有効な、最適化されていないバイナリを出荷することになります。CI パイプラインが「念のため」まだ `dotnet publish` に `-c Release` を渡しているなら、それは今や冗長ですが無害です。習慣で `-c Debug` を渡しているなら、妥当な既定値を上書きして Debug を出荷しています。パイプラインを一度読み、カーゴカルトを削除してください。

## 各コマンドが実際にディスクへ書き込むもの

出力の集合は重なるため、コマンドは一見すると入れ替え可能に見えますが、同じフォルダーではありません。

`dotnet build` は `bin/<configuration>/<framework>/`、たとえば `bin/Debug/net11.0/` に書き込みます。IL の `.dll`、`Exe` プロジェクトではそれを起動する実行可能ファイル、`.pdb` シンボルファイル、依存関係を列挙する `.deps.json`、共有ランタイムを指定する `.runtimeconfig.json`、そして依存関係の DLL のコピーを出力します。.NET Core 3.0 以降を target とする実行可能プロジェクトについて、ドキュメントは「(Web プロジェクトが持つような) 他の発行固有のロジックがなければ、ビルド出力はデプロイ可能なはずだ」と述べています。

`dotnet publish` は `publish` サブフォルダーに書き込みます。フレームワーク依存ビルドでは `bin/<configuration>/<framework>/publish/`、特定のランタイム向けに自己完結型でビルドする場合は `bin/<configuration>/<framework>/<runtime>/publish/` です。同じ中核ファイル (IL の `.dll`、`.deps.json`、`.runtimeconfig.json`、依存関係) に加えて、デプロイの形が要求するものを出力します。

`publish` の出力が入れ子の `publish` ディレクトリに入るのは、まさに通常のビルド出力と衝突しないためであることに注意してください。Web プロジェクトでプロジェクトの直下のフォルダーに `-o` を向けると、連続する発行が `publish/publish` に入れ子になることがあります。これはドキュメントで指摘されている既知の鋭いエッジです。

## 「ビルド出力はデプロイ可能」が半分だけ真実である理由

ドキュメントは、素の実行可能ファイルについてビルド出力は「デプロイ可能なはずだ」と言っており、単純なコンソールアプリについてはこれは本当にそのとおりです。`dotnet build -c Release` を実行し、`bin/Release/net11.0/` を zip 化し、対応する .NET 11 ランタイムがインストールされたマシンに置いて実行できます。

問題は、「他の発行固有のロジックがなければ」という但し書きが、多くの実際のアプリケーションを含んでしまうことです。`Publish` ターゲットは、`Build` が決して実行しない作業を行います。

- **Web アセット。** ASP.NET Core と Blazor のプロジェクトは、静的ファイルを集め、Razor コンポーネントをコンパイルし、`wwwroot` のレイアウトを生成し、publish 中に static-web-assets のマニフェストを生成します。素の `build` は、ホストが期待する形でデプロイ可能な Web コンテンツのツリーを組み立てません。
- **自己完結型ランタイムのパッケージ化。** `--self-contained` を渡すと、publish は .NET ランタイム全体を出力の中にコピーし、ターゲットマシンが何も事前インストールを必要としないようにします。`build` はランタイムをパッケージ化しません。
- **Ready-to-run、単一ファイル、トリミング、AOT。** これらはすべて発行時の変換であり、以下で説明します。

したがって正確なルールはこうです。ライブラリや些細なコンソールアプリでは、`build` の出力と `publish` の出力はほぼ同じファイルの集合です。Web アプリ、自己完結型デプロイ、あるいは発行時の変換を使う何かでは、`publish` だけが正しいものを生成します。[発行されたアプリケーションでファイルまたはアセンブリを読み込めないエラー](/ja/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)を報告する人がいるとき、根本原因はしばしば、本物の `publish` 出力ではなく `build` フォルダー、あるいはその部分的なコピーをデプロイしたことにあります。

## フレームワーク依存 vs 自己完結型: publish 専用の判断

`dotnet build` は共有フレームワークに対してビルドし、実行時にランタイムが存在すると仮定します。ランタイムをパッケージ化するという概念を持ちません。

`dotnet publish` はデプロイモデルを選ばせます。フレームワーク依存が既定で、出力を小さく保ちますが、ターゲット上に対応する .NET ランタイムが必要です。

```bash
# .NET 11 SDK 11.0.100. Framework-dependent, cross-platform. Target needs .NET 11 installed.
dotnet publish -c Release
```

自己完結型はランタイムをバンドルするため、ターゲットは何も事前インストールを必要としませんが、はるかに大きな出力とランタイムごとのビルドという代償を伴います。

```bash
# .NET 11 SDK 11.0.100. Self-contained: the runtime ships inside the output folder.
dotnet publish -c Release -r linux-x64 --self-contained
```

`-r` (ランタイム識別子) は出力をプラットフォーム固有にします。`linux-x64` の publish は `win-x64` では動きません。だからこそ自己完結型の出力パスにはランタイムのセグメントが含まれます (`bin/Release/net11.0/linux-x64/publish/`)。複数のプラットフォームに出荷するなら、RID ごとに 1 回 publish を実行します。この移植性のトレードオフは、[Native AOT に手を伸ばすか、そして何を犠牲にするか](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)を判断するときに天秤にかけるものと同じです。

## build に相当するものが存在しない、発行時の変換

4 つの MSBuild プロパティが `publish` の生成物を変えますが、素の `build` の間はどれも意味のあることをしません。これらこそが、`publish` が別のコマンドとして存在する理由です。

**`PublishReadyToRun`** は、アセンブリを ReadyToRun (R2R) 形式にコンパイルします。これは事前コンパイルの一種で、コードを事前に JIT コンパイルして起動時間を削る一方、JIT を後のために利用可能なまま残します。これは発行時のステップです。代替手段との比較は [Native AOT vs ReadyToRun vs JIT](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) を参照してください。

**`PublishSingleFile`** は、アプリをプラットフォーム固有の 1 つの実行可能ファイルにまとめます。これを設定すると `PublishSelfContained` が暗黙的に有効になります。

**`PublishTrimmed`** は、トリマーが到達可能だと証明できないライブラリコードを削除し、自己完結型デプロイを縮小します。自己完結型の発行にのみ適用されます。

**`PublishAot`** は ILC コンパイラーを実行し、JIT を一切持たない 1 つのネイティブバイナリを生成します。

```xml
<!-- .NET 11, C# 14. These belong in the .csproj, not on the build command line. -->
<PropertyGroup>
  <PublishSingleFile>true</PublishSingleFile>
  <PublishTrimmed>true</PublishTrimmed>
  <PublishReadyToRun>true</PublishReadyToRun>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100. Only 'publish' honors these; 'build' ignores them.
dotnet publish -c Release -r win-x64
```

これらのプロパティを設定したプロジェクトで `dotnet build` を実行しても、何も起きません。トリマーは動かず、単一ファイルは生成されず、ILC は決して呼び出されません。これらの変換は `Build` ではなく `Publish` ターゲットの依存グラフに組み込まれています。これが、ドキュメントが `publish` を「アプリケーションをデプロイ用に準備する唯一の公式にサポートされた方法」と呼ぶ、具体的で機械的な理由です。

## --no-build で再ビルドをスキップする

`publish` は `Build` に依存するため、publish は既定で再コンパイルします。すでに `dotnet build` を実行した (アナライザーやテストをそのバイナリそのものに対して走らせるために) CI パイプラインでは、publish 中の再コンパイルは時間の無駄であり、さらに悪いことに微妙に異なる出力を生むことがあります。既存のビルド出力を再利用するには `--no-build` を渡します。

```bash
# .NET 11 SDK 11.0.100. Build once with the config you want, then publish that.
dotnet build -c Release
dotnet publish -c Release --no-build
```

注意すべき点が 2 つあります。1 つ目に、`--no-build` は暗黙的に `--no-restore` を設定するので、restore はすでに済んでいる必要があります。2 つ目に、構成は一致していなければなりません。`dotnet build -c Release` を実行した後で `-c Release` なしに `dotnet publish --no-build` すると、publish は (その既定である) `Debug` 出力を探し、対応するビルドを見つけられずに失敗します。両方のコマンドで `-c` の値を同一に保ってください。成果物の出力レイアウト (`--artifacts-path`) を使う場合、ドキュメントは同じパスを両方のコマンドにも引き継ぐ必要があると述べています。

## dotnet run と dotnet test はこれらの隣に並ぶ

この 2 つのコマンドをより広い CLI の中に位置づけると役立ちます。`dotnet run` は (既定で Debug で) ビルドし、直ちにアプリを起動します。これは内側のループの便利ラッパーであり、デプロイツールではありません。`dotnet test` はテストプロジェクトをビルドして実行します。`dotnet pack` はデプロイ可能なアプリではなく NuGet パッケージを生成し、publish と同様に `net8.0` 以降では既定で `Release` を使います。これらはすべて、`--no-restore` を渡さない限りまず暗黙的な `dotnet restore` を実行します。CI がこれらのいずれかを実行するための SDK すら見つけられないなら、それは [dotnet コマンドが CI で見つからない](/ja/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/)で扱う別の環境問題です。

## どちらを実行するか、それぞれ 1 行で決める

開発中は `dotnet build` を使います。コンパイルし、警告やアナライザーの診断を表に出し、テスト用のバイナリを生成するためです。速く、既定で Debug を使い、その出力はあなたのマシン向けです。

出荷用の成果物が欲しいときは `dotnet publish` を使います。既定で Release を使い、デプロイ固有のステップを実行し、サーバー、コンテナーイメージ、あるいは Native AOT バイナリに渡せるフォルダーへの、サポートされた道です。CI で release ビルドを切るとき、publish (必要なら `--no-build` を使う 1 回の共有 `build` の後に) が、あなたがデプロイするものを生成するコマンドです。同時にランタイムのメジャーバージョン間を移動しているなら、publish の出力が実際に実行するつもりのランタイムを対象とするよう、[.NET 8 から .NET 11 への移行チェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)と組み合わせてください。

1 文のテスト。出力があなたのためのものなら `build`、出力があなたのものではないマシンのためのものなら `publish` です。

## 関連

- [Native AOT とは何か、そして何を犠牲にするのか?](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [.NET 11 における Native AOT vs ReadyToRun vs JIT](/ja/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Fix: 発行されたアプリでファイルまたはアセンブリを読み込めない](/ja/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)
- [Fix: CI で 'dotnet' コマンドが見つからない](/ja/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/)
- [.NET 8 から .NET 11 への移行: 完全なチェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## 出典

- [dotnet publish コマンドリファレンス](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-publish) (Microsoft Learn)
- [dotnet build コマンドリファレンス](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build) (Microsoft Learn)
- ['dotnet publish' は既定で Release 構成を使う](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/8.0/dotnet-publish-config) (Microsoft Learn)
- [.NET アプリケーション発行の概要](https://learn.microsoft.com/en-us/dotnet/core/deploying/) (Microsoft Learn)
