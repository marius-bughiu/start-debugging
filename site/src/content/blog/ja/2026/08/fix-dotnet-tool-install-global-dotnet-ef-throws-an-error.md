---
title: "修正: dotnet tool install --global dotnet-ef がエラーを出す"
description: ".NET 10 SDK で dotnet tool install --global dotnet-ef が失敗するすべてのパターンを、正確なメッセージと終了コード付きで解説します。インストール済み、バージョンが見つからない、ダウングレード拒否、shim の衝突、到達できない NuGet フィード、そしてインストール成功後に初めて壊れるランタイム不一致。"
pubDate: 2026-08-12
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "ef-core"
  - "entity-framework"
lang: "ja"
translationOf: "2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error"
translatedBy: "claude"
translationDate: 2026-08-12
---

`dotnet tool install --global dotnet-ef` は 6 つの異なる理由で失敗しますが、SDK はそれぞれに 1 行だけの別々のメッセージを出すだけで、区別の手がかりになるスタックトレースはありません。終了コードではなく、その 1 行を読んでください。"Tool 'dotnet-ef' is already installed." は終了コード **0** で、そもそもエラーではありません。一方 "is not found in NuGet feeds"、"is lower than existing version"、"conflicts with an existing command from another tool"、"No NuGet sources are defined or enabled" はいずれも終了コード **1** で、それぞれ必要なフラグが異なります。以下の内容はすべて、2026-08-12 に Windows 11 上の SDK 10.0.201 で、nuget.org の実フィードに対して実行したものです。

## エラーの実際の出力

以下が実際のメッセージで、そのまま記録したものです。SDK は 1 行出力して停止します。

```
Tool 'dotnet-ef' is already installed.

Version 99.0.0 of package dotnet-ef is not found in NuGet feeds https://api.nuget.org/v3/index.json.

dotnet-ef-typo-xyz is not found in NuGet feeds https://api.nuget.org/v3/index.json.

The requested version 8.0.11 is lower than existing version 9.0.11.

Tool 'dotnet-ef' failed to update due to the following:
Failed to create shell shim for tool 'dotnet-ef': Command 'dotnet-ef' conflicts with an existing command from another tool.
Tool 'dotnet-ef' failed to install.

No NuGet sources are defined or enabled

Unhandled exception: Unable to load the service index for source https://nuget.invalid.example/v3/index.json.
```

これらすべてより厄介な 7 番目の失敗があります。インストールが成功を報告してしまうからです。

```
You can invoke the tool using the following command: dotnet-ef
Tool 'dotnet-ef' (version '3.1.32') was successfully installed.
```

そのあとでツールが起動を拒否します。

## なぜこれが起きるのか

`dotnet tool install` は 1 つのコマンドで 3 つの別々の仕事をこなしており、それぞれの仕事に固有の失敗要因があります。設定済みの NuGet フィードからパッケージのバージョンを解決し、そのパッケージをツールストアに展開し、ツールディレクトリに実行可能な shim を書き込みます。NuGet の解決の問題、バージョンの順序規則、ファイルシステム上の名前衝突は、まったく無関係なメッセージを生みます。"dotnet tool install dotnet-ef error" で検索しても目の前の状況に合わない助言ばかり出てくるのは、そのためです。

7 番目のケースは性質が異なります。ツールのインストールは、それを実行できるランタイムがあるかを一切確認しません。パッケージのターゲットフレームワークは起動時にホストが強制するだけなので、手元にないランタイム向けにビルドされたツールもきれいにインストールされ、最初の実行で死にます。

## Repro: SDK 10.0.201 で各失敗を再現する

試すあいだは `--global` ではなく `--tool-path` を使ってください。実際のツールストアをかき回さずに各ケースを使い捨てディレクトリへ隔離でき、失敗メッセージは同一です。

```bash
# SDK 10.0.201. Each block is one failure mode.
dotnet tool install --tool-path ./tp dotnet-ef --version 99.0.0
dotnet tool install --tool-path ./tp dotnet-ef-typo-xyz
dotnet tool install --tool-path ./tp dotnet-ef --version 9.0.11
dotnet tool install --tool-path ./tp dotnet-ef --version 8.0.11
```

3 番目のコマンドは成功し、4 番目は `The requested version 8.0.11 is lower than existing version 9.0.11.` を出力して終了コード 1 で終わります。shim の衝突を再現するには、ツールのコマンド名と同じ名前のファイルを先に対象ディレクトリへ置きます。

```bash
# SDK 10.0.201
mkdir -p ./tp6 && echo dummy > ./tp6/dotnet-ef.exe
dotnet tool install --tool-path ./tp6 dotnet-ef
```

## 修正方法の詳細

実際に遭遇する頻度の高い順に並べています。

### "Tool 'dotnet-ef' is already installed." は失敗ではない

終了コードは 0 です。推測ではなく実測です。このコマンドは設計上べき等なので、プロビジョニングスクリプトや Dockerfile にガードなしで置いて問題なく、ビルドを壊すこともありません。

混乱の原因は、同じコマンドがまったく別の出力をすることがある点です。

```
Tool 'dotnet-ef' was successfully updated from version '10.0.10' to version '10.0.11'.
```

.NET 10 SDK では、`--version` なしの `dotnet tool install --global dotnet-ef` は既存のインストールを拒否せず、最新の安定版へ更新します。"already installed" が出るのは、到達するバージョンがすでに入っているものと同じ場合だけです。バージョンを固定したかったのに予期しない更新がかかったなら、理由はこれです。固定してください。

```bash
# SDK 10.0.201. Both forms work; the @ syntax needs SDK 10.0.100 or later.
dotnet tool install --global dotnet-ef --version 10.0.11
dotnet tool install --global dotnet-ef@10.0.11
```

### "is not found in NuGet feeds" はパッケージではなくバージョンの話

同じ言い回しを共有する 2 つのメッセージがあり、意味は異なります。`dotnet-ef-typo-xyz is not found in NuGet feeds ...` はパッケージ名を挙げているので、パッケージ ID が間違っているか、フィードがそれを持っていません。`Version 99.0.0 of package dotnet-ef is not found in NuGet feeds ...` はバージョンを挙げているので、パッケージ自体は解決できていてバージョンが存在しなかったということです。

よく遭遇するのは後者です。`--version 11.0.0` が期待どおりに動かないからです。.NET 8 以降、`--version Major.Minor.Patch` は一覧に出ていないものも含めてそのバージョンだけに一致し、変動しません。最新の 11.x にはワイルドカードを使い、プレビュー版には明示的にオプトインする必要があります。

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 11.0.*
dotnet tool install --global dotnet-ef --prerelease
```

`--prerelease` を付けた実行は、この記事を書いた日には `11.0.0-preview.7.26381.103` を解決しました。フラグがないとプレビュー版は見えないので、nuget.org 上ではっきり見えているバージョンに対して "not found" が返ってきます。

### "The requested version X is lower than existing version Y"

より新しいツールへの上書きインストールは拒否され、`dotnet tool update` で古いバージョンへ戻すのも同様です。まさにこのためのフラグがあります。

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 8.0.11 --allow-downgrade
```

これは `Tool 'dotnet-ef' was successfully updated from version '9.0.11' to version '8.0.11'.` と報告し、終了コード 0 で終わります。レガシーブランチで古い EF Core ランタイムに合わせてツールを固定するときに使ってください。`dotnet tool uninstall --global dotnet-ef` のあとに新規インストールする方法もありますが、コマンドが 2 つになり、2 つ目が失敗すると何も入っていない状態が残ります。

### "Failed to create shell shim ... conflicts with an existing command from another tool"

ツールディレクトリに、このインストールが作ったものではない `dotnet-ef` という実行ファイルがすでにあります。上書きせずにインストールを中止しますが、紛らわしい 1 行目に注意してください。"failed to install" と言う前に "failed to update" と言っています。

実際にはほぼ必ず、中途半端に削除された以前のインストールか、`--tool-path` によるインストールが `--global` のものを覆い隠しているかのどちらかです。古い shim を見つけて削除してください。グローバルツールは Windows では `%USERPROFILE%\.dotnet\tools`、Linux と macOS では `$HOME/.dotnet/tools` に置かれ、実体のバイナリは隣の `.store` ディレクトリにあります。

```bash
# SDK 10.0.201
dotnet tool list --global
ls ~/.dotnet/tools
```

`dotnet tool list --global` に `dotnet-ef` が出てこないのにファイルが存在する場合、その shim は孤立しており、手作業で削除して問題ありません。

### "No NuGet sources are defined or enabled"

復元元がありません。カレントディレクトリより上のどこかにある `NuGet.config` の `<packageSources>` に `<clear />` があり、そのあと何も追加されていないか、すべてのソースが無効化されています。プライベートフィードだけに絞ったリポジトリの中では踏みやすく、しかも原因の設定ファイルが数階層上にあることもあるため気づきにくい問題です。

```bash
# SDK 10.0.201
dotnet nuget list source
dotnet tool install --global dotnet-ef --source https://api.nuget.org/v3/index.json
```

`--source` はこのコマンド 1 回に限って設定済みのソースをすべて置き換えるので、問題がネットワークではなく設定にあることを確認する最速の手段です。

### "Unable to load the service index for source"

設定内のフィードのひとつに到達できていません。SDK 10.0.201 では、これが生の `Unhandled exception:` 行として表面化します。リストの後ろにある正常なフィードがパッケージを持っていても、インストール全体を中止します。到達できないフィードを警告として扱うよう SDK に指示してください。

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --ignore-failed-sources
```

到達できないプライベートフィードのあとに nuget.org を並べた設定では、素のコマンドは例外を投げ、`--ignore-failed-sources` を付けると 10.0.11 がきれいにインストールされました。パッケージを持っているのがそのプライベートフィード自体なら、このフラグでは救えません。その場合は認証を完了させるために `--interactive` が必要です。

### インストールは成功するのにツールが起動しない

半日を溶かすのがこれです。対象のランタイムが入っていないマシンに古い `dotnet-ef` を入れても問題なく通り、そのあとで次のようになります。

```
You must install or update .NET to run this application.

App: ...\dotnet-ef.exe
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '3.1.0' (x64)
.NET location: C:\Program Files\dotnet\

The following frameworks were found:
  6.0.36 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
  8.0.23 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
  10.0.5 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
```

修正は .NET 9 SDK から使えるインストール時のフラグで、ターゲットより新しいランタイム上でツールを実行できるようにします。

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 3.1.32 --allow-roll-forward
```

同じパッケージ、同じマシンです。フラグなしでは shim が起動を拒否し、付ければ `dotnet-ef --version` がランタイム 10.0.5 上で `3.1.32` を出力します。これは shim に焼き込まれるインストール時の決定なので、すでに入っているツールに反映するには再インストールが必要です。

## .NET 10 SDK で変わった点

3 つの挙動が変わり、いずれも問い合わせの原因になっています。

バージョン未固定のグローバルツールでは、インストールが install-or-update として振る舞うようになりました。プロビジョニング済みのマシンでこれまで何もしなかったコマンドが、いまは黙ってパッチバージョンをひとつ進めるのはこのためです。それが問題になるならバージョンを固定してください。

ローカルインストールはマニフェストがなくても失敗しなくなりました。以前は `.config/dotnet-tools.json` のないフォルダーで `-g` なしの `dotnet tool install dotnet-ef` を実行すると "Cannot find a manifest file." が出ていました。.NET 10 からは `--create-manifest-if-needed` が既定で有効になり、`.git` サブフォルダーを含む最も近い上位ディレクトリにマニフェストが自動生成されます。たいていは妥当ですが、ときにひどく的外れになります。ダウンロードフォルダーや無関係なリポジトリの中で実行すると、他人のマニフェストを黙って書き換えてしまいます。無効化するには `--create-manifest-if-needed=false` を指定してください。探索したマニフェストの場所を表示していた `-d` フラグは、その説明対象だったエラーが消えたため、もう使えません。

`@version` 構文は SDK 10.0.100 で入ったので、`dotnet-ef@10.0.11` は `dotnet-ef --version 10.0.11` と等価になりました。両方の書き方を混ぜるとエラーになります。`dotnet-ef@10.0.11` と `--version` を同時に渡すと "Cannot specify --version when the package argument already contains a version." が返ります。

## インストールせずに dotnet-ef を実行できますか

自分で制御できない CI ランナーでインストールが失敗しているなら、.NET 10 での最速の解決策はインストールをやめることです。`dotnet tool exec` とその短縮形 `dnx` は、ツールのダウンロードと実行を一度に行います。

```bash
# SDK 10.0.201
dnx dotnet-ef -y -- --version
dotnet tool exec dotnet-ef --yes -- database update
```

`-y` はダウンロードの確認プロンプトに同意するもので、非対話環境では必須です。ここでの `--` 区切りは省略可能ではなく、付け忘れたときの失敗が分かりにくいので注意してください。`dnx` は `--version`、`--prerelease`、`--source` を自身のオプションとして解釈するため、`dnx dotnet-ef --version` はツールに届きません。`dotnet-ef` へ渡したいものはすべて `--` の後ろに置いてください。

ワンショット実行はローカルマニフェストも尊重します。近くに `.config/dotnet-tools.json` があれば、`dnx` はフィードの最新版ではなくそこで固定されたバージョンを実行するので、リポジトリのスクリプトの既定として妥当な選択になります。

## 落とし穴と紛らわしいエラー

**"Could not execute because the specified command or file was not found"** は別の問題です。インストールは成功しており、shim のディレクトリが `PATH` に入っていません。これについては [dotnet ef not found の修正](/ja/2023/06/how-to-fix-command-dotnet-ef-not-found/) に個別の手順があります。Linux では自分で PATH をエクスポートするまでツールは `$HOME/.dotnet/tools` からしか実行できませんし、CI ランナーではたいてい先に [dotnet 自体を PATH に通す](/ja/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/) 必要があります。

**ツールがランタイムより古いという警告** は、何も壊れていないのに再インストールへ人を走らせます。

```
The Entity Framework tools version '8.0.11' is older than that of the runtime '10.0.5'. Update the tools for the latest features and bug fixes. See https://aka.ms/AAc1fbw for more information.
```

これは警告であって、そのあとに失敗した何かの原因ではありません。上記の実行では、無関係な "No DbContext was found in assembly" エラーが続いていました。ツールを更新するのは構いませんが、それで何かが直ったと決めつけないでください。

**インストールが成功しても、あなたのソリューションで `dotnet ef` が動くとは限りません。** 次に起きやすい失敗の 2 大要因は、デザイン時ホストが解決できないこと（[Unable to create an object of type DbContext](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) で解説）と、design パッケージが間違ったプロジェクトに入っていること（[スタートアッププロジェクトが Microsoft.EntityFrameworkCore.Design を参照していない](/ja/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/) で解説）です。

**マイグレーション実行のために本番マシンへツールを入れないでください。** 代わりに CI で migration bundle をビルドすれば、対象マシンに SDK もグローバルツールも要りません。その手順は [dotnet ef migrations bundle による EF Core 11 マイグレーションの適用](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) にあります。

## 関連記事

ツールが入ったあとの摩擦は、分割されたソリューションで正しく呼び出すことへ移ります。EF Core 11 はそれにようやく答えを出しました：[.config/dotnet-ef.json による既定値ファイル](/ja/2026/06/efcore-11-dotnet-ef-json-config-file/)。アップグレードの途中でここへ来たなら、ツールのバージョンは [.NET 8 から .NET 11 へのチェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) と [EF Core 6 から EF Core 11 への破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) にある多数の項目のひとつにすぎません。

## 参考資料

- [dotnet tool install コマンド](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install)：オプションのリファレンス、インストール先の一覧表、.NET 8 で導入された `--version Major.Minor.Patch` の一致規則。
- [破壊的変更: dotnet tool install --local が既定でマニフェストを作成する](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/10.0/dotnet-tool-install-local-manifest)：廃止された "Cannot find a manifest file." エラーと `--create-manifest-if-needed=false` によるオプトアウト。
- [.NET 10 の SDK とツールの新機能](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/sdk)：`dotnet tool exec` によるワンショット実行と `dnx` スクリプト。
- [.NET ツール利用時の問題のトラブルシューティング](https://learn.microsoft.com/en-us/dotnet/core/tools/troubleshoot-usage-issues)：PATH と shim の診断。
