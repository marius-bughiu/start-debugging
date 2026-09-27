---
title: "大規模な Flutter モノレポで VS Code の遅い Dart 解析サーバーを高速化する方法"
description: "pubspec.yaml が何十個もあるモノレポでは、Dart 解析サーバーがパッケージごとに解析コンテキストを 1 つずつ作り、メモリと 1 分近い起動時間はそこで消費されます。pub workspace に変換し、analysis_options.yaml で生成コードを除外し、レガシーのアナライザープラグインを外し、Insights ページで効果を確認します。Dart 3.12.2 での実測で、ピークメモリは 2.3 分の 1、コールド解析時間は半分になりました。"
pubDate: 2026-09-27
template: "how-to"
tags:
  - "dart"
  - "flutter"
  - "vs-code"
  - "performance"
  - "monorepo"
  - "how-to"
lang: "ja"
translationOf: "2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo"
translatedBy: "claude"
translationDate: 2026-09-27
---

**短い答え:** Flutter モノレポで Dart 解析サーバーが遅い主な原因は、独自の `pubspec.yaml` と `.dart_tool/package_config.json` を持つパッケージごとに別々の解析コンテキストを作ることにあります。各コンテキストは SDK、Flutter、そしてすべての共有依存関係を個別に読み込みます。リポジトリを [pub workspace](https://dart.dev/tools/pub/workspaces) (Dart 3.6+) に変換してすべてのパッケージが 1 つの共有コンテキストに解決されるようにし、ルートの `analysis_options.yaml` で `analyzer: exclude:` を使って生成コードを除外し、`custom_lint` などのレガシーのアナライザープラグインを削除し、VS Code ではワークスペースのルートを開いてください。40 パッケージ、3,240 ファイルの合成リポジトリでは、生成コードに手を付ける前の段階で、ピークメモリが約 1.2 GB から 0.5 GB に、コールド解析が 17-22 秒から 11-12 秒に減りました。

以下はすべて Apple Silicon Mac 上の Dart 3.12.2 (Flutter 3.44.8) で計測しています。現在の安定版は Flutter 3.47 ラインに同梱されている Dart 3.13.3 です。ここで説明する設定キーと挙動はそちらでも変わっておらず、さらに 3.13.2 では、セクション 4 で手放すよう勧めているレガシーのプラグインシステムが非推奨になっています。

## 1 つのリポジトリが 40 個のアナライザーになる理由

解析サーバー (Dart-Code 拡張機能が起動する `dart language-server` と、`dart analyze` の背後で動くプロセス) は、作業を解析コンテキスト単位で整理します。コンテキストとは、1 つのパッケージ解決と 1 組の解析オプションを共有するファイルの集合です。各コンテキストは見えるものすべてについて解決済みの要素モデルを個別に保持し、Flutter パッケージの場合それは Dart SDK、`flutter` パッケージ全体、そしてすべての推移的依存関係を意味します。

`apps/customer`、`apps/driver`、そして `packages/` 配下の 38 パッケージを含み、それぞれが独自の `pubspec.lock` と `.dart_tool/package_config.json` を持つモノレポのルートを開くと、サーバーには選択肢がありません。それらのパッケージは `collection` や `riverpod` を異なるバージョンに解決しているかもしれないので、40 個のコンテキストを構築し、`package:flutter` を 40 回解決します。Dart チームは workspaces のページでまさにこう述べています。ワークスペースなしでルートを開くと "create separate analysis contexts for each package, increasing memory usage" とのことです。この修正を追跡している長期の issue、[dart-lang/sdk#53874](https://github.com/dart-lang/sdk/issues/53874) では、コンテキスト数の削減がサーバーのパフォーマンス改善の中心に据えられています。

VS Code での症状はおなじみのものです。フォルダーを開いた後 1 分間 "Analyzing..." が回り続ける、補完に数秒かかる、自動インポートの候補が入力に追いつかない、そして 16 GB のマシンではサーバーが強制終了されて再起動する、といったものです。

## 何かを変える前に計測する

ここで当て推量をすると高くつくので、まず 2 つの数値を取ります。

VS Code で、コマンドパレットから **Dart: Open Analyzer Diagnostics / Insights** を実行します。サーバーの診断用 Web ページが開きます。Contexts ページには、すべての解析コンテキストが、その場所、ワークスペースルート、"added" ファイル (自分のコード) と "implicit" ファイル (そのコンテキストが取り込む必要があった SDK と依存関係のファイル) の数とともに一覧表示されます。パッケージごとに 1 つのコンテキストがあり、それぞれに何千もの implicit ファイルがあるなら、問題はそこです。"Memory and CPU usage" ページはプロセスが保持しているものを示し、"Legacy Plugins" ページはプラグインの isolate を一覧表示します。起動ではなく補完が不満の種であれば、**Dart: Capture Analysis Server Timings** でどのリクエストが遅いかを記録できます。

CI や変更の前後で再現可能な数値を得るには、コマンドラインを使います。`dart analyze` は同じ解析サーバーを実行し、2 つの隠しフラグ (`dart analyze -h -v` で表示されます) によってベンチマークとして使えるようになります。

```bash
# Dart 3.12.2. --cache points at an empty dir so every run is cold.
rm -rf /tmp/dart-cache
/usr/bin/time -l dart analyze --cache=/tmp/dart-cache .
# "maximum resident set size" in the time output is peak memory (macOS, bytes).
# On Linux use: /usr/bin/time -v dart analyze --cache=/tmp/dart-cache .

# Server-reported heap, printed only with JSON output:
dart analyze --cache=/tmp/dart-cache --memory --format=json . | jq .memory
```

`--cache` フラグが重要です。これがないと実行時に `~/.dartServer` が再利用され、ウォームな実行では計測しようとしている差の大部分が隠れてしまいます。

## 計測したリポジトリ

特定の会社のコードベースに依存しない数値を得るために、40 個の pure Dart パッケージからなるモノレポを生成しました。各パッケージには 80 個のライブラリファイルとバレルファイルがあり、直前の 2 つのパッケージへの path 依存を持つので、依存グラフは実際のレイヤー構造のアプリ (`core` -> `data` -> `features`) のようなチェーンになります。合計 3,240 ファイルです。この目的では Flutter パッケージも同じように振る舞います。`package:flutter` が大きいため、追加のコンテキスト 1 つあたりのコストが高くなるだけです。

バリアントは 2 つです。各パッケージで個別に `dart pub get` を実行した `separate` と、同じコードを pub workspace に変換した `workspace` です。それぞれ 3 回ずつコールド実行しました。

| バリアント | パッケージ設定 | コールド `dart analyze` | ピーク RSS |
| --- | --- | --- | --- |
| separate | 40 | 16.5 秒 / 20.7 秒 / 22.4 秒 | 1,225 / 1,291 / 1,067 MB |
| workspace | 1 | 11.1 秒 / 11.6 秒 / 11.7 秒 | 499 / 495 / 490 MB |

診断結果もコードも同じで、メモリは半分未満です。IDE では、一度きりの CLI 実行よりも差がさらに大きくなります。サーバーはセッション全体を通して動き続け、すべてのコンテキストが常駐したままになるからです。

## ステップバイステップ: アナライザーを再び速くする

1. 既知のリグレッションを避けるため SDK をアップグレードします。
2. リポジトリを pub workspace に変換します。
3. `analysis_options.yaml` で生成コードとベンダーコードを除外します。
4. レガシーのアナライザープラグインを削除します。
5. VS Code でワークスペースのルートを開き、IDE から見えるものを絞り込みます。

### 1. 既知のリグレッションを避けるためにアップグレードする

Dart 3.11.0 には、ファイル数とディレクトリ数が多いワークスペースでのパフォーマンス問題があり、3.11.1 で修正されました ([dart-lang/sdk#62456](https://github.com/dart-lang/sdk/issues/62456))。また、18 パッケージのワークスペースで 3.11.0 に移行した後、約 10 秒だった解析が 6 分以上になったという未解決の報告 [dart-lang/sdk#62704](https://github.com/dart-lang/sdk/issues/62704) もあります。ちょうど 3.11.0 を使っている場合は、まずアップグレードして計測し直してください。Dart 3.12 では解析オプションファイルのキャッシュが改善されて起動も速くなっており、これはすべてのパッケージが共有ファイルを `include:` する独自の `analysis_options.yaml` を持っている場合に最も効果があります。

### 2. pub workspace に変換する

ワークスペースでは、すべてのメンバーが `resolution: workspace` を宣言し、SDK の下限を 3.6 以上にする必要があります。ルートの `pubspec.yaml` にメンバーを列挙します。

```yaml
# pubspec.yaml at the repo root. Dart 3.6+ (measured on 3.12.2).
name: _
publish_to: none
environment:
  sdk: ^3.12.0
workspace:
  - apps/customer
  - apps/driver
  - packages/core
  - packages/data
  - packages/design_system
```

```yaml
# packages/data/pubspec.yaml
name: data
publish_to: none
environment:
  sdk: ^3.12.0
  flutter: ">=3.44.0"
resolution: workspace
dependencies:
  flutter:
    sdk: flutter
  core:
    path: ../core
```

次に、パッケージごとの解決成果物を削除し、ルートから一度だけ解決します。

```bash
# Remove stale per-package lockfiles and package configs, then resolve the workspace.
find . -name pubspec.lock -not -path './pubspec.lock' -delete
find . -path '*/.dart_tool/package_config.json' -not -path './.dart_tool/*' -delete
flutter pub get   # or: dart pub get
```

これで `pubspec.lock` と `.dart_tool/package_config.json` はどちらもルートに 1 つだけになります。解析サーバーを再起動し (**Dart: Restart Analysis Server**)、もう一度 Contexts ページを確認してください。ワークスペースに対してコンテキストが 1 つだけ表示されるはずです。

トレードオフは、ワークスペースのバージョン解決が 1 回だけという点です。`apps/driver` が `intl` をあるメジャーバージョンに固定し、`apps/customer` が別のメジャーバージョンを必要とする場合、揃えるまで `pub get` は失敗します。この失敗への対処こそが移行作業であり、たいていのリポジトリではこうした競合が 2 つか 3 つ見つかります。Melos を使っている場合、バージョン 7.0.0 で pub workspaces に移行し、`melos.yaml` はルートの `pubspec.yaml` 内の `melos:` セクションに置き換えられたので、Melos のアップグレードとワークスペースへの変換は同じ作業になります。

### 3. 生成コードとベンダーコードを除外する

生成された Dart コードは、自分で書いたコードと同じくらいの量になることがよくあります。`freezed`、`json_serializable`、`mockito`、`drift`、`intl` の出力は `*.g.dart`、`*.freezed.dart`、`*.mocks.dart` としてソースの隣に置かれ、サーバーはそのすべての行を解決し、lint します。(コード生成そのものが失敗している場合は [build_runner を壊す source_gen と analyzer のバージョン不一致](/ja/2026/08/fix-the-method-getinvocation-isnt-defined-for-the-type-dartobjectimpl/) を、生成されたモデルと組み込みのものとで迷っている場合は [Dart records と freezed クラスの比較](/ja/2026/05/dart-records-vs-freezed-classes/) を参照してください。)

```yaml
# analysis_options.yaml at the workspace root. Dart 3.12.2.
include: package:flutter_lints/flutter.yaml

analyzer:
  exclude:
    - "**/*.g.dart"
    - "**/*.freezed.dart"
    - "**/*.mocks.dart"
    - "**/build/**"
    - "third_party/**"
```

40 パッケージそれぞれに生成コード風のファイルを 10 個 (約 1,000 行) 追加し、workspace バリアントで再計測しました。

| workspace + 生成コード | コールド `dart analyze` | ピーク RSS |
| --- | --- | --- |
| 生成ファイルを解析 | 19.4 秒 / 14.7 秒 | 1,148 / 1,185 MB |
| `**/*.g.dart` を除外 | 6.9 秒 / 6.9 秒 | 523 / 523 MB |

ドキュメントには明記されていない `exclude` の詳細が 4 つあります。いずれも 3.12.2 で確認済みです。

- **glob はオプションファイルからの相対パスです。** [解析のドキュメント](https://dart.dev/tools/analysis) にはそう明記されています。`**/*.g.dart` はどこからでも機能しますが、ルートのファイルに書いた `lib/**` はルートの `lib` を意味し、各パッケージのものではありません。
- **ワークスペースでは、ルートファイルの exclude が独自の `analysis_options.yaml` を持つメンバーにも適用されます。** 私のテストではすべてのパッケージが独自のオプションファイルを保持していましたが、ルートだけの `exclude` でもそれらの生成ファイルは解析対象から外れました。ワークスペースなしではそうなりません。各パッケージがそれぞれコンテキストルートになり、それらに対してルートのファイルは無視されるので、すべてのパッケージに exclude を書くか、各パッケージのファイルに `include: ../../analysis_options.yaml` の行を入れる必要があります。後者なら exclude も引き継がれます。
- **ファイルを除外しても、何かがそれをインポートしていれば解決は止まりません。** 他のファイルからインポートされているライブラリを除外し、その中に警告を仕込んでみました。警告は消えましたが、インポート側は引き続き型チェックされました。つまり除外で節約できるのは lint と診断の作業であり、誰もインポートしていないファイル (モック、テスト用フィクスチャ、古い出力) についてはすべての作業を節約できますが、使っているモデルの `part` である `*.g.dart` は引き続き読み込まれます。
- **`build/` はデフォルトではスキップされません。** 名前がドットで始まるフォルダー (`.dart_tool`、`.git`) は無視されますが、たまたま `.dart` ファイルを含む `build/` や `ios/Pods/` ディレクトリは解析されます。独自の `pubspec.yaml` を持ち、ワークスペースのメンバーではない入れ子の `example/` アプリも追加のコンテキストになります。ワークスペースに追加するか、除外してください。

### 4. レガシーのアナライザープラグインを削除する

レガシーのアナライザープラグイン、つまり `custom_lint` や古いツールが使う `analyzer: plugins:` 形式のものは、解析コンテキストに紐付いた別々の isolate で動作します。Dart のドキュメントは、これを有効にすると "increases how much memory the analyzer uses" と警告しており、RAM が 16 GB 未満の場合や、`pubspec.yaml` または `analysis_options.yaml` ファイルが 10 個以上あるモノレポでは、まったく使わないことを推奨しています。Dart 3.13.2 ではレガシーのシステムが正式に非推奨になりました。

有無を確認します。

```bash
grep -rn --include=analysis_options.yaml -A3 'plugins:' .
```

その lint が重要なら、Dart 3.10 で追加された [新しいプラグインシステム](https://dart.dev/tools/analyzer-plugins) に移行してください。トップレベルの `plugins:` キーで設定し、IDE と `dart analyze` の両方でサポートされています。Dart 3.11 ではプラグインのエントリポイントの AOT スナップショットを再利用するようになり、changelog によれば IDE セッションの開始ごとに 10 秒程度を節約できます。移植するほど重要な lint でなければ、プラグインを削除して差を計測してください。通常、ワークスペースへの変換に次いで最も大きな改善になります。

### 5. 正しいフォルダーを開き、IDE から見えるものを絞り込む

ワークスペースにしたら、VS Code では単一のアプリフォルダーではなくリポジトリのルートを開いてください。そうすれば 1 つのサーバーセッションですべてのメンバーをカバーでき、パッケージをまたいだナビゲーション、リネーム、参照の検索がリポジトリ全体で機能します。

知っておく価値のある Dart-Code の設定が 2 つ、避けるべき設定が 1 つあります。

```jsonc
// .vscode/settings.json (Dart-Code extension)
{
  // Folders the IDE analysis server ignores entirely, including for project detection.
  "dart.analysisExcludedFolders": [
    "tools/legacy_scripts",
    "third_party"
  ],
  // Keep SDK and dependency symbols out of Ctrl+T if workspace symbol search is slow.
  "dart.includeDependenciesInWorkspaceSymbols": false
}
```

`dart.analysisExcludedFolders` はエディターにしか影響しないので、CI の `dart analyze` でもスキップすべきものには `analyzer: exclude:` を優先してください。この VS Code の設定は、チームの誰も編集しない大きなアーカイブ済みアプリのように、CI では解析したままにしつつローカルでは解析したくないフォルダーに使います。

`dart.onlyAnalyzeProjectsWithOpenFiles` は避けてください。これは非推奨で、設定自体の説明にも "can make performance significantly worse when moving around a project" と警告があります。ファイルを切り替えるたびに、サーバーがコンテキストを破棄しては再構築し続けるからです。

## それでも遅い場合

Contexts ページにコンテキストが 1 つだけ表示され、生成コードも除外されているなら、残りのコストは実際のコードによるものです。確認すべき点がいくつかあります。

- **循環した、または非常に幅広いバレルエクスポート。** パッケージ全体を再エクスポートするバレルファイルがあると、それをインポートするすべてのファイルがその中の全ファイルに依存することになり、1 回の編集で必要以上に多くのものが無効化されます。パッケージ内では `src/` のパスからインポートし、バレルは公開 API 用に留めてください。
- **巨大な単一パッケージ。** 3,000 ファイルの `app` パッケージを機能ごとに分割しても総作業量は減りませんが、編集後に影響を受けないライブラリの再解析をサーバーがスキップできるようになります。
- **大きな git 操作の後のサーバー再起動。** 何百ものファイルに触れるブランチ切り替えは、大量の作業をキューに積みます。場合によっては、インクリメンタルな無効化を待つより **Dart: Restart Analysis Server** のほうが速いことがあります。
- **バグ報告のためのインストルメンテーション。** `dart.analyzerInstrumentationLogFile` にパスを設定して再現し、[dart-lang/sdk](https://github.com/dart-lang/sdk/issues) の issue に添付してください。上で挙げたリグレッションはこの方法で見つかりました。

これらは `dart fix` が走査するのと同じコンテキストなので、ワークスペースへの変換後は [リポジトリ全体での dart fix の実行](/ja/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) も速くなります。また、[Dart と Flutter の MCP サーバー](/ja/2026/05/dart-flutter-mcp-server-claude-code-cursor/) を通してリポジトリに対して AI エージェントを動かしている場合、そのエージェントも解析サーバーと通信しているので、コンテキスト構成を軽くすることはエディターと同じくらいそちらでも効果があります。

## 参考資料

- [Pub workspaces (monorepo support)](https://dart.dev/tools/pub/workspaces), dart.dev
- [Customizing static analysis](https://dart.dev/tools/analysis), dart.dev
- [Analyzer plugins](https://dart.dev/tools/analyzer-plugins), dart.dev
- [Dart SDK CHANGELOG](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)、3.10.0、3.11.0、3.11.1、3.12.0、3.13.2 の項目
- [Dart-Code settings reference](https://dartcode.org/docs/settings/)
- [dart-lang/sdk#53874: reduce the number of analysis contexts](https://github.com/dart-lang/sdk/issues/53874)
- [Melos changelog, 7.0.0](https://pub.dev/packages/melos/changelog)
