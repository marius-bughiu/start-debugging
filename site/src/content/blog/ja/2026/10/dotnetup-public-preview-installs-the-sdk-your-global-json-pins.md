---
title: "dotnetup パブリックプレビュー: 1 つのコマンドで global.json が固定する SDK をインストール"
description: "dotnetup は 2026-10-15 にパブリックプレビューになりました。リポジトリ内で dotnetup sdk install を実行すると global.json を読み取り、rollForward を更新チャンネルに対応付け、新しいパッチバージョンをファイルに書き戻すこともできます。"
pubDate: 2026-10-15
tags:
  - "dotnet"
  - "tooling"
  - "sdk"
  - "global-json"
lang: "ja"
translationOf: "2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins"
translatedBy: "claude"
translationDate: 2026-10-15
---

2026-10-15 に Microsoft は、.NET SDK とランタイム向けの rustup 型ツールチェーンマネージャーである [dotnetup のパブリックプレビューを発表しました](https://devblogs.microsoft.com/dotnet/introducing-dotnetup/)。[6 月に最初に書いたとき](/ja/2026/06/dotnetup-official-dotnet-sdk-version-manager/)は、ソースからビルドする必要があり、動作が確認されていたのは `dotnetup sdk install preview` だけでした。現在は 1 行のインストーラー、[Microsoft Learn のコマンドリファレンス](https://learn.microsoft.com/dotnet/core/tools/dotnetup/)が用意され、私が最も気にしていた疑問、つまり `global.json` をどう扱うのかにも答えが出ています。

## マシンへのインストール

ブートストラップスクリプトは最新の `preview` ビルドをダウンロードし、SHA-512 チェックサムを検証して `~/.dotnetup` に配置します。`sudo` は不要です。

```bash
# macOS / Linux (x64 and Arm64, glibc and musl)
curl -fsSL https://aka.ms/dotnetup/get-dotnetup.sh | bash

# then, non-interactively
dotnetup install latest
dotnetup env set shell
```

Windows では PowerShell の同等コマンドは `irm https://aka.ms/dotnetup/get-dotnetup.ps1 | iex` です。Windows の既定値には注意してください。`dotnetup init` は `everywhere` モードを提案しますが、これはシステムの `PATH` を変更し、`DOTNET_ROOT` を設定します。すると、管理対象のインストールが Visual Studio がインストールした SDK より優先されるため、dotnetup にないマシン全体の SDK を必要とするプロジェクトはビルドできなくなります。すべてを移行する予定がなければ、`shell` か `none` を選んでください。

試すのに最も面白いのは `none` モードです。`PATH` と `DOTNET_ROOT` には触れず、代わりにコマンドを転送します。

```bash
dotnetup env set none --dotnetup-on-path true
dotnetup dotnet -- --info
dotnetup dotnet build
```

## global.json が追跡される要件になる

リポジトリ内でチャンネルを指定せずに `dotnetup sdk install` を実行します。カレントディレクトリから上方向にたどって最も近い `global.json` を使用し、見つからない場合は `latest` にフォールバックします。ファイルの形式が不正な場合、コマンドは失敗します。親ディレクトリに黙ってフォールバックすることはありません。

```json
{
  "sdk": {
    "version": "10.0.103",
    "rollForward": "latestPatch"
  }
}
```

重要なのは、dotnetup が `10.0.103` をインストールするだけではない点です。`rollForward` を、`dotnetup update` が更新し続けるチャンネルに変換します。

| `rollForward` | 追跡されるチャンネル |
| --- | --- |
| 省略または `latestPatch` | `10.0.1xx` |
| `latestFeature` | `10.0` |
| `latestMinor` | `10` |
| `latestMajor` | `latest` |
| `disable`, `patch`, `feature`, `minor`, `major` | 厳密な `10.0.103`、更新されない |

`allowPrerelease` はチャンネルに影響しません。`dotnetup list` は各要件の取得元として `global.json` のパスを表示するので、どのリポジトリが古い SDK を残しているのかがわかります。どこからも参照されなくなった SDK は、次回の更新で削除されます。

## パッチを global.json に書き戻す

これは私にとって新しい機能で、再現可能なビルドのために正確なパッチバージョンを固定しているリポジトリにとても便利です。

```bash
dotnetup sdk install --update-global-json
# later, across every tracked repo
dotnetup sdk update --update-global-json
```

導出されたチャンネルの最新 SDK をインストールし、`sdk.version` だけを書き換えます。書式、他のプロパティ、ファイルの文字エンコーディングは保持されます。これにより、Patch Tuesday ごとの Dependabot 型の PR や手作業での編集が不要になります。

## プレビュー版の粗い部分

- `global.json` に `sdk.paths` がある場合、dotnetup は最初のエントリにインストールします。このプレビューでは `$host$` をリテラルのパスとして扱い、空のエントリをスキップしないため、`sdk.paths` を省略するか `--install-path` を渡してください。
- `dotnetup sdk uninstall 10.0.1xx --source globaljson` は、現在のリポジトリのものだけでなく、インストールルート内で一致するすべての `global.json` 要件を削除します。
- GitHub Actions と Azure DevOps へのファーストクラスの統合はまだロードマップ上にありますが、コマンド自体は CI 上でもすでに非対話的に実行できます。

異なる .NET 10 のフィーチャーバンドに固定された複数のリポジトリを扱っているなら、リポジトリごとの `dotnetup sdk install` と週 1 回の `dotnetup update` の組み合わせは、すでに `dotnet-install` スクリプトより優れた運用です。フィードバックは [dotnet/sdk の dotnetup ディスカッション](https://github.com/dotnet/sdk/discussions/categories/dotnetup)へどうぞ。
