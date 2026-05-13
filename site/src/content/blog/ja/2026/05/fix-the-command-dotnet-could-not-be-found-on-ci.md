---
title: "解決: The command 'dotnet' could not be found が CI で出る"
description: "CI ランナーが dotnet を解決できないのは、そのステップで SDK が未インストール、もしくはインストール済みでも PATH に無いためです。actions/setup-dotnet を使い、global.json を固定し、DOTNET_ROOT と ~/.dotnet/tools をエクスポートしてください。"
pubDate: 2026-05-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "ci"
  - "github-actions"
  - "azure-pipelines"
lang: "ja"
translationOf: "2026/05/fix-the-command-dotnet-could-not-be-found-on-ci"
translatedBy: "claude"
translationDate: 2026-05-13
---

解決策: CI のあるステップが、SDK が未インストール、`PATH` に無い、または `global.json` が禁じるバージョンに固定された状態で `dotnet` を実行しています。GitHub Actions では、`dotnet` を呼び出す前に `actions/setup-dotnet@v4` のステップを置き、要求した SDK と一致する `global.json` をコミットし、Linux コンテナーでは `DOTNET_ROOT` と `$HOME/.dotnet/tools` をエクスポートしてください。このエラーがランナーイメージのバグであることはほぼありません。

```text
/bin/bash: line 1: dotnet: command not found
##[error]Process completed with exit code 127.
```

または Windows ランナーで:

```text
dotnet : The term 'dotnet' is not recognized as the name of a cmdlet, function, script file, or operable program.
At line:1 char:1
+ dotnet build
+ ~~~~~~
    + CategoryInfo          : ObjectNotFound: (dotnet:String) [], CommandNotFoundException
```

または Ubuntu で `dotnet-install.sh` の後に:

```text
Command 'dotnet' not found, but can be installed with:
sudo apt install dotnet-host
```

このガイドは .NET 11 (SDK 11.0.100)、`actions/setup-dotnet@v4.0.1`、Azure DevOps の `UseDotNet@2` タスク 2.213.x、および 2026 年 5 月時点で `https://dot.net/v1/dotnet-install.sh` に公開されている `dotnet-install.sh` を対象にしています。根本原因は .NET Core 3.1 以降変わっていません。変わったのは action のバージョンだけです。

## なぜ CI のシェルが `dotnet` を見失うのか

根本原因は 4 つあります。いずれも同じ `command not found` の行を出すので混同しやすく、YAML を直す前にどれに当たっているかを知っておく価値があります。

1. **ランナーイメージにそもそも SDK が無い。** `ubuntu:24.04`、`alpine:3.20`、`mcr.microsoft.com/devcontainers/base:ubuntu` などのコンテナーイメージには .NET SDK は含まれません。GitHub ホスト型ランナー (`ubuntu-latest`、`windows-latest`) には含まれていますが、キャッシュされたバージョンはたまたまイメージに焼かれたものであり、リポジトリーが必要とするものとは限りません。
2. **SDK はインストール済みだが、このステップの `PATH` には無い。** GitHub Actions の各ステップは新しいシェルで実行されます。前のステップで `~/.bashrc` に行を追加しても引き継がれません。`run:` ブロック内で `export` した `PATH` は次の `run:` ブロックに漏れません。
3. **SDK は `PATH` にあるが、`global.json` が未インストールのバージョンに固定している。** `dotnet` 起動時、最も近い `global.json` をディレクトリツリー上方向に読み、`version` と `rollForward` のルールに合う SDK を解決します。一致するものが無ければ `error NETSDK1045` か、ホストの失敗が出て、ホストによってはラッパースクリプト上で "command not found" の形に化けて現れます。
4. **SDK は `dotnet-install.sh` で `$HOME/.dotnet` にインストールされたが、`DOTNET_ROOT` と `PATH` が設定されていない。** これがセルフホスト Linux ランナーや Docker コンテナー内で最もよく見る失敗です。スクリプトは綺麗にインストールしますが、その後のステップで変数をエクスポートしません。

## 最小限の CI 再現

これを `.github/workflows/build.yml` として保存し、`.csproj` のあるリポジトリーに push してください:

```yaml
# .github/workflows/build.yml -- .NET 11, GitHub Actions May 2026
name: build
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    container: ubuntu:24.04   # no SDK is preinstalled here
    steps:
      - uses: actions/checkout@v4
      - run: dotnet --info     # fails: dotnet: command not found
```

`container:` キーはランナーの OS を素の Ubuntu イメージに差し替えます。既定の `ubuntu-latest` ランナーには SDK が入っているので、`container:` を外すとこのスニペットは動きます。多くのチームは、再現性のためにジョブをコンテナーへ移し、`setup-dotnet` を一緒に持っていくのを忘れた時にこれにぶつかります。

## 解決策 1: 同じジョブで SDK をインストールし、それを使う

GitHub Actions の正攻法は `actions/setup-dotnet` です。`dotnet` を呼ぶ任意のステップの前に置きます。SDK をランナー単位のキャッシュにダウンロードし、後続のすべてのステップで `PATH` の先頭に追加し、SDK のインストールディレクトリーを直接必要とするツールのために `DOTNET_ROOT` をエクスポートします。

```yaml
# .github/workflows/build.yml -- setup-dotnet@v4
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: "11.0.x"
      - run: dotnet --info
      - run: dotnet build -c Release
```

刺さる細部が 2 つ:

- **`dotnet-version` はワイルドカードを受け付けますが**、それでもローカルビルドと CI を一致させるために `global.json` をコミットすべきです。これが無いと、ローカルに SDK 11.0.5 を入れた開発者と CI の 11.0.7 で、異なる `obj/project.assets.json` を生み出して互いに驚くことになります。
- **`global-json-file:` は `setup-dotnet@v4` で `dotnet-version` を上書きします**。両方渡すと JSON が勝ちます。これは仕様であってバグではありませんが、`global.json` が 11 を指す workflow に `dotnet-version: "8.0.x"` を足して、なぜ .NET 11 がインストールされるのかと首をひねる人を見たことがあります。

Azure DevOps では同等の `UseDotNet@2` を使います:

```yaml
# azure-pipelines.yml -- Azure DevOps, UseDotNet@2
steps:
  - task: UseDotNet@2
    inputs:
      packageType: sdk
      version: "11.0.x"
  - script: dotnet build -c Release
```

GitLab CI や Buildkite では、SDK をあらかじめ焼き込んだベースイメージ (`mcr.microsoft.com/dotnet/sdk:11.0`) が最も綺麗な経路です。やむを得ない場合を除き、ジョブ内での `dotnet-install.sh` 実行は避けてください。動きはしますが、ジョブごとにダウンロードコストを払います。

## 解決策 2: CI と一致する `global.json` をコミットする

CI が `dotnet build` を実行すると、最新のインストール済み SDK ではなく、`global.json` の解決で勝った SDK を使います。よくある失敗はこんな形です:

```text
A compatible .NET SDK was not found.
Requested SDK version: 11.0.200
global.json file: /home/runner/work/myrepo/myrepo/global.json
Installed SDKs:
  8.0.412 [/usr/share/dotnet/sdk]
  11.0.100 [/usr/share/dotnet/sdk]
```

ランナーには 11.0.100 が、`global.json` は 11.0.200 を要求しています。ラッパースクリプトは非ゼロで終了し、ホストによっては、本当のエラーを飲み込んだ Bash の `if` から "command not found" が伝播して見えます。

`global.json` は正直に保ちましょう:

```json
{
  "sdk": {
    "version": "11.0.100",
    "rollForward": "latestFeature"
  }
}
```

`rollForward: latestFeature` なら、11.0.103 を入れた開発者がパッチリリースごとにファイルを上げなくても作業できます。`latestMajor` は CI には緩すぎ、`disable` はローカルには厳しすぎます。`version` は `actions/setup-dotnet` の `dotnet-version` がインストールするものに合わせてください。

## 解決策 3: どうしても `dotnet-install.sh` が必要なとき

切り詰めたコンテナー内、あるいは `setup-dotnet` を使えないセルフホストランナーでは、公式スクリプトでインストールし、その後のすべてのステップで明示的に変数をエクスポートしてください。

```yaml
# self-hosted runner or restrictive container -- .NET 11
jobs:
  build:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - name: Install .NET 11 SDK
        run: |
          curl -sSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
          chmod +x dotnet-install.sh
          ./dotnet-install.sh --channel 11.0 --install-dir "$HOME/.dotnet"
          echo "$HOME/.dotnet" >> "$GITHUB_PATH"
          echo "$HOME/.dotnet/tools" >> "$GITHUB_PATH"
          echo "DOTNET_ROOT=$HOME/.dotnet" >> "$GITHUB_ENV"
      - run: dotnet --info
      - run: dotnet tool restore && dotnet build -c Release
```

2 行の `echo` は、GitHub Actions がステップ間で読む特別なファイルに書き込みます。`GITHUB_PATH` はジョブ内の以後すべてのステップで `PATH` の先頭にエントリーを追加し、`GITHUB_ENV` は同じ仕組みで環境変数をエクスポートします。同じ `run:` ブロック内の `export PATH=...` は次のステップでは効かないため、シェルスクリプトを字面どおりに移植すると人はここにはまります。

`DOTNET_ROOT` は `PATH` が設定済みでも重要です。ホスト (`dotnet` バイナリー) は `DOTNET_ROOT` を使って `shared/Microsoft.NETCore.App` と `sdk/` フォルダーを見つけます。`PATH` だけ直すと、`dotnet --info` は動くが `dotnet build` がランタイム不足のホストエラーで落ちる、という状態になり得ます。Microsoft Learn によれば、`DOTNET_ROOT` は Linux と macOS のホストで読まれ、Windows では既定外のインストール時に読まれます。

`tools` ディレクトリーも追加してください。`$HOME/.dotnet/tools` が `PATH` に無いと、`dotnet tool install --global` の呼び出しは成功してもツールには手が届かず、関連エラー `dotnet-ef: command not found` が出ます。

## 解決策 4: ビルド済み SDK イメージ、インストールステップなし

Docker ベースの CI では、最も摩擦の少ない経路は SDK が既に入ったイメージから始めることです:

```yaml
# .gitlab-ci.yml -- pinned SDK image, no install step
build:
  image: mcr.microsoft.com/dotnet/sdk:11.0
  script:
    - dotnet --info
    - dotnet build -c Release
```

これを Buildkite、CircleCI、Docker 上の Jenkins エージェント、そして CI のプリミティブが「コンテナー＋スクリプト」のあらゆるプラットフォームへ展開してください。柔軟性 (1 つのイメージ、1 つの SDK) を犠牲にして、最初のコマンドから `dotnet` が `PATH` にあることを保証します。

## よくある変種と紛らわしい亜種

このページに辿り着く検索が、わずかに違うエラーを探している場合があります。間違った修正を追わないよう、先に切り分けておきましょう。

- **`dotnet-ef: command not found`**。グローバルツールはインストール済みですが `$HOME/.dotnet/tools` が `PATH` にありません。上述のとおり追加するか、ローカルマニフェスト `dotnet-tools.json` を使って `dotnet tool restore && dotnet ef` を呼びます。
- **`Could not execute because the specified command or file was not found`**。`dotnet` は `PATH` にありますが、サブコマンド (`dotnet foo`) は組み込みでもツールとしてインストールされてもいません。別のエラー、別の根本原因です。
- **`error NETSDK1045: The current .NET SDK does not support targeting .NET 11.0`**。SDK は `PATH` にありますが、プロジェクトの `TargetFramework` には古すぎます。`setup-dotnet` の `dotnet-version` (もしくは `global.json`) を引き上げてください。マルチターゲットの解決で何とかなることを期待して、もう一つ SDK を並べてインストールするのは違います。
- **`/usr/bin/env: 'dotnet': No such file or directory`**。"command not found" と同じ根本原因、別シェル。修正は同一です。
- **`A fatal error occurred. The required library libhostfxr.so could not be found`**。`dotnet` は `PATH` にありますが、`DOTNET_ROOT` が空ディレクトリーを指しているか、SDK が部分インストールです。`dotnet-install.sh` を再実行し、`DOTNET_ROOT` が実際のインストール先と一致しているか確認してください。

## 解決策に見えて違うもの

- **CI で `apt install dotnet-host` を実行**。これはホストだけを入れて SDK は入れず、SDK チャネルから数週遅れることがある Microsoft 署名済み `.deb` を引きます。`setup-dotnet` か `dotnet-install.sh` を使ってください。
- **`run:` ステップで `~/.bashrc` に `dotnet` を `PATH` 追加**。CI のステップは非対話シェルで動き、`~/.bashrc` は読み込まれません。`GITHUB_PATH` (GitHub Actions)、`task.prependpath` (Azure DevOps)、もしくはステップ単位の `PATH=...` プレフィックスを使ってください。
- **ホスト型ランナーでの `sudo`**。ホスト型ランナーは既にパスワード無し `sudo` を持つユーザーで動いていますが、SDK は `/usr/share/dotnet` にインストールされ、`/usr/bin/dotnet` のラッパーは既に存在します。動かすのに `sudo` を必要とするなら、欠けているのは権限ではなく `setup-dotnet` です。
- **「v4 で壊れた」からと `actions/setup-dotnet` を古いメジャーに固定**。v4 はキャッシュディレクトリーを変え、`global.json` をより厳密にパースするようになりました。壊れた原因はほぼ常に、利用不可な SDK を指す `global.json` です。JSON を直してください。v3 に永久に縛り付けないように。

## CI で解決を検証する

次に進む前に、診断ステップを 2 つ走らせます。安価で、`dotnet build` の出力で幻影を追うことを防げます。

```yaml
- run: which dotnet || command -v dotnet || true
- run: dotnet --info
```

`which dotnet` (Windows では `where dotnet`) は、シェルがどのバイナリーを解決するかを確定させます。`dotnet --info` はランタイム、SDK 一覧、解決された `global.json` を出力します。`--info` が成功するのに `build` が "command not found" で落ちるなら、失敗は `dotnet` 自身ではなく、エラーを飲み込むラッパースクリプトの中にあります。そのときは再インストールではなく、ラッパーを読む時間です。

`--info` の出力が要求した SDK を示し、`Base Path:` が期待したディレクトリーを指し、`global.json file: <あなたのパス>` を列挙したら完了です。それ以外は本当の設定誤りで、直す価値があります。

## 関連

- CI の並列レーンでツールを動かす全体像については、[1 つの CI パイプラインから複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) を参照してください。マトリックスジョブごとに SDK を切り替える同じ `GITHUB_PATH` のテクニックを使っています。
- SDK が見つかった後にビルドが失敗するなら、[公開済みアプリがアセンブリーを読み込めない理由](/ja/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) で trim とランタイムパックの話を読んでください。
- ビルド時のコピー失敗そのものについては、[MSB3027 リトライカウントの解決](/ja/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) がアンチウイルスとファイルロックのケースをカバーします。
- 解決はできるがホストへのアタッチで失敗する EF Core ツールについては、[DbContext を作成できないときの dotnet ef migrations add の修正](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) を見てください。
- 同じジョブで本物のデータベースが欲しいコンテナーベースの結合テストには、[Testcontainers で本物の SQL Server に対する結合テスト](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) が動くパイプラインを通します。

## 出典

- [`actions/setup-dotnet` README](https://github.com/actions/setup-dotnet)、`v4.0.x` の `dotnet-version`、`global-json-file`、`cache` のドキュメント。
- [パッケージマネージャーを使わずに Linux に .NET をインストールする](https://learn.microsoft.com/en-us/dotnet/core/install/linux-scripted-manual)、Microsoft Learn。`dotnet-install.sh`、`DOTNET_ROOT`、`PATH` を扱います。
- [.NET SDK と CLI が使う環境変数](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-environment-variables)、Microsoft Learn、`DOTNET_ROOT` について。
- [`global.json` の概要](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json)、Microsoft Learn、`rollForward` のルールについて。
- [GitHub Actions のワークフローコマンド](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-system-path)、GitHub Docs、`GITHUB_PATH` と `GITHUB_ENV` について。
- [`dotnet/core` Issue 5267](https://github.com/dotnet/core/issues/5267)、"command 'dotnet' not found, but can be installed with" についての長期にわたる upstream スレッド。
