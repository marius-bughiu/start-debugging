---
title: "修正: flutter upgrade や Flutter バージョンの切り替え後に pubspec.lock が変更扱いになる"
description: "Flutter SDK は meta、vector_math、test_api、matcher のバージョンを固定しているため、SDK を変えるたびにロックファイルが再解決されます。さらに flutter upgrade は今いるプロジェクトに対して pub upgrade を実行します。リポジトリごとに Flutter バージョンを 1 つに固定し、CI でロックファイルを強制しましょう。"
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-47"
  - "dart"
  - "pub"
lang: "ja"
translationOf: "2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions"
translatedBy: "claude"
translationDate: 2026-10-13
---

`pubspec.lock` が変わるのは、Flutter SDK 自体が独自のバージョン固定を持つ依存関係だからです。`flutter` と `flutter_test` は `meta`、`vector_math`、`test_api`、`matcher` などのパッケージに対して厳密なバージョンを要求するため、SDK が変わると pub はそれらを再解決せざるを得ません。SDK を切り替えた後の `flutter run` や `flutter build` は、自動的に `pub get` を実行します。加えて、`flutter upgrade` は今いるプロジェクトに対して `pub upgrade` を実行します。対処法は次のとおりです。リポジトリごとに Flutter バージョンを 1 つに固定し (FVM と `environment: flutter:` 制約の併用)、SDK 更新によるロックファイルの変更は単独のコミットにし、CI では `flutter pub get --enforce-lockfile` を実行します。以下の内容はすべて、2026-10-13 に Flutter 3.44.8 (Dart 3.12.2) と Flutter 3.47.7 (Dart 3.13.5) で計測したものです。

## 症状の全体像

`pubspec.yaml` には触れていません。`flutter upgrade` を実行した、チャンネルを切り替えた、あるいは別の Flutter バージョンを使うチームメイトがプッシュした、というだけで、`git status` に次のように表示されます。

```text
 M pubspec.lock
```

差分は、自分では追加していない推移的パッケージだけに及びます。

```diff
   meta:
     dependency: transitive
     description:
       name: meta
-      sha256: "1741988757a65eb6b36abe716829688cf01910bbf91c34354ff7ec1c3de2b349"
+      sha256: "307249ce4ff29d58a18e97f6345f539382eb9c9c29ecda628900f31de0443dd9"
       url: "https://pub.dev"
     source: hosted
-    version: "1.18.0"
+    version: "1.19.0"
```

古い SDK に戻して `pub get` が走る操作を実行すると、差分は逆向きになります。Flutter バージョンが混在しているチームでは、プルリクエストのたびにロックファイルが行ったり来たりします。

## なぜ起きるのか

仕組みは 3 つあり、多くのチームはそのすべてに遭遇します。

**1. Flutter SDK は自身の依存関係を固定しています。** SDK 内の `packages/flutter/pubspec.yaml` と `packages/flutter_test/pubspec.yaml` には厳密なバージョンが書かれています。アプリは `sdk: flutter` を通じて両方に依存するため、それらの固定がそのままアプリの解決に対する制約になります。SDK が変わると固定も変わり、ロックファイル内のバージョンが制約を満たさなくなるので、pub は新しいバージョンを選び直す必要があります。テストした 2 つの SDK の該当行は次のとおりです。

| パッケージ | Flutter 3.44.8 | Flutter 3.47.7 |
| --- | --- | --- |
| `meta` | `1.18.0` | `^1.18.3` |
| `vector_math` | `2.2.0` | `^2.4.0` |
| `test_api` | `0.7.11` | `0.7.12` |
| `matcher` | `0.12.19` | `0.12.20` |
| `material_color_utilities` | `0.13.0` | `0.13.0` |
| `collection` | `1.19.1` | `^1.19.1` |

Flutter 3.47 は、[PR #185268 "Unpin sdk package dependencies"](https://github.com/flutter/flutter/pull/185268) を含む最初の安定版リリースです。この PR によって、長年の課題だった [#158050 "Stop pinning dependencies"](https://github.com/flutter/flutter/issues/158050) がクローズされました。固定の大半はキャレット範囲になりました。ただし `test_api` と `matcher` は、SDK がそれらの `src/` ライブラリをインポートしているため厳密な固定のままで、`material_color_utilities` も引き続き固定されています (理由は PR の説明に書かれています)。そのため 3.47 以降でも、`test_api` や `matcher` を更新する Flutter リリースごとに、ロックファイルのそれらのエントリが書き換えられます。

**2. SDK を切り替えた後、Flutter は裏で `pub get` を実行します。** `flutter run`、`flutter build`、`flutter test` などは、何よりも先に `pub get` を呼び出します。Flutter ツールがこれをスキップするのは、`.dart_tool/version` が現在のフレームワークのバージョンと一致し、かつ `pubspec.yaml` が `pubspec.lock` と `.dart_tool/package_config.json` の両方より古い場合だけです。このチェックは `packages/flutter_tools/lib/src/dart/pub.dart` にあります。したがって、SDK を切り替えた後の最初の `flutter run` は必ず再解決を行い、`pub` と一度も入力していなくてもロックファイルが変わります。

**3. `flutter upgrade` はプロジェクトに対して `pub upgrade` を実行します。** 見落とされやすいのがこれです。SDK のアップグレード後、`UpgradeCommand.updatePackages` はカレントディレクトリまたは親ディレクトリにある `pubspec.yaml` を探し、見つかればそのプロジェクトに対して `pub.get(..., upgrade: true)` を呼び出します。これは `pub get` ではなく `pub upgrade` なので、SDK とは無関係なパッケージも含め、*すべての* 依存関係が制約の許す最新バージョンに移動します。このコードは少なくとも Flutter 3.0.0 から同じ動作をしています。

## 最小限の再現手順

古い SDK でプロジェクトを作成してコミットし、その後新しい SDK で解決します。ここでは 2 つの SDK を並べて用意しました。Homebrew の Flutter 3.44.8 と、作業用フォルダーに展開した 3.47.7 stable の zip です。

```bash
# Flutter 3.44.8 (Dart 3.12.2) creates and locks the project
flutter create -e --platforms=android app
cd app
flutter pub add http shared_preferences intl
git init -q && git add -A && git commit -qm base

# Same project, Flutter 3.47.7 (Dart 3.13.5)
~/sdks/flutter-3.47.7/bin/flutter pub get
git diff --stat
```

3.47.7 での出力は次のとおりです。

```text
Resolving dependencies...
Downloading packages...
  clock 1.1.2 (1.1.3 available)
> matcher 0.12.20 (was 0.12.19)
  material_color_utilities 0.13.0 (0.13.1 available)
> meta 1.19.0 (was 1.18.0)
  stack_trace 1.12.1 (1.12.2 available)
> test_api 0.7.12 (was 0.7.11) (0.7.15 available)
> vector_math 2.4.3 (was 2.2.0)
Changed 4 dependencies!
Upgrading analysis_options.yaml to exclude build and platform directories.
 analysis_options.yaml |  4 ++++
 pubspec.lock          | 16 ++++++++--------
 2 files changed, 12 insertions(+), 8 deletions(-)
```

4 つのパッケージが移動しましたが、いずれも SDK の固定、またはかつて SDK が固定していたものです。`http`、`shared_preferences`、`intl` はそのままでした。通常の `pub get` は、維持できるロック済みバージョンをすべて維持します。おまけのファイル変更にも注目してください。Flutter 3.47 には `AnalysisOptionsMigration` が含まれており、プロジェクトで初めて `pub get` を実行したときに、`build/**` と各プラットフォームフォルダーごとの `<platform>/**` の除外設定を `analysis_options.yaml` に追加します。これは一度きりの編集で、ロックファイルと一緒にコミットすべきです。

では 3.44.8 に戻します。

```text
< matcher 0.12.19 (was 0.12.20) (0.12.20 available)
< meta 1.18.0 (was 1.19.0) (1.19.0 available)
< test_api 0.7.11 (was 0.7.12) (0.7.15 available)
< vector_math 2.2.0 (was 2.4.3) (2.4.3 available)
Changed 4 dependencies!
```

これが行ったり来たりの正体です。どちらの SDK も相手のロックファイルを受け付けないため、最後に実行した人が勝ちます。

比較のために、同じ 3.44 のロックファイルに対して 3.47.7 で `pub upgrade` を実行しました (`flutter upgrade` が代わりにやってくれることです)。変更されたのは 4 つではなく 6 つで、`clock` と `stack_trace` も最新バージョンに移動したためです。数十個の依存関係を持つ実際のアプリでは、この数はたいていもっと大きくなります。

## 修正の詳細

目標は、ロックファイルを一切変わらないようにすることではありません。SDK が変われば古い解決結果はもう有効ではないので、ロックファイルは変わるべきです。目標は、変更が一度だけ、意図的に、レビューできるコミットとして行われるようにすることです。

### 1. `pubspec.lock` はアプリではコミットし、アプリだけでコミットする

[`pub get` に関する Dart のドキュメント](https://dart.dev/tools/pub/cmd/pub-get)では、アプリケーションパッケージはロックファイルをチェックインして、すべての開発者とデプロイが同じバージョンを使うようにし、再利用可能なパッケージはチェックインしないこととされています。*パッケージ* のリポジトリで差分の頻発に悩んでいる場合は、そこでロックファイルをコミットしないのが最も簡単な対処です。以下はすべてアプリを前提としています。

### 2. リポジトリごとに Flutter バージョンを 1 つに固定する

行ったり来たりが起きるのは、同じロックファイルに対して人によって異なる SDK を実行する場合だけです。バージョンをリポジトリの一部にしましょう。

[FVM](https://fvm.app/) を使うと、`fvm use` がプロジェクトルートの `.fvmrc` にバージョンを書き込み、全員がそれに対して `fvm flutter ...` を実行します。

```bash
# FVM 3.x, Flutter 3.47.7
fvm install 3.47.7
fvm use 3.47.7
git add .fvmrc
```

次に、`pubspec.yaml` に Flutter の制約を追加して補強します。これは FVM を使うかどうかに関係なく、pub が全員に対して強制します。

```yaml
# pubspec.yaml, Flutter 3.47.7 / Dart 3.13.5
environment:
  sdk: ^3.13.5
  flutter: ">=3.47.0 <3.48.0"
```

pub は両方の境界をチェックします。範囲を `<3.45.0` に設定すると、Flutter 3.47.7 は解決そのものを拒否しました。

```text
The current Flutter SDK version is 3.47.7.

Because app2 requires Flutter SDK version >=3.0.0 <3.45.0, version solving failed.
Failed to update packages.
```

このエラーは、ロックファイルが黙って書き換えられるよりずっと優れています。間違った SDK を使っているチームメイトは、コードレビューではなくその場で気づくことができます。`pubspec.lock` の末尾にある `sdks:` ブロックには、制約が反映されます (`flutter: ">=3.47.0 <3.48.0"`)。pub は依存グラフ内のすべての SDK 制約の共通部分をそこに記録するためです。この行は制約を編集するたびに変わりますが、問題ありません。

CI も同じファイルに従わせたい場合は、[複数バージョンの CI 構成](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)が `.fvmrc` からバージョンを読み取ります。

### 3. Flutter のアップグレードは、プロジェクトディレクトリの外で、独立した変更として行う

`flutter upgrade` は作業ディレクトリから見つけたプロジェクトに対して `pub upgrade` を実行するため、リポジトリの内側でアップグレードすると、SDK 起因の再解決と依存関係の全面アップグレードという性質の大きく異なる 2 つの変更が 1 つの差分に混ざります。これを分けましょう。

```bash
# Flutter 3.44.8 -> 3.47.7
cd ~                # no pubspec.yaml here or in any parent directory
flutter upgrade     # upgrades only the SDK

cd ~/src/my_app
flutter pub get     # re-resolves only what the new SDK forces
git add pubspec.lock analysis_options.yaml
git commit -m "Flutter 3.47.7: re-resolve SDK-pinned packages"
```

FVM を使っていれば、同じ効果が自動で得られます。`fvm install` と `fvm use` はアプリに対して `pub upgrade` を呼び出しません。新しいパッケージが欲しいときは、2 つ目のコミットで意図的に `flutter pub upgrade` を実行してください。そうすれば、リグレッションの原因を"新しい SDK" か "新しいパッケージ" のどちらかに二分探索で絞り込めます。これは、[`awaitNotRequired` の問題](/ja/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)で推奨したのと同じ分け方です。そこでは、取り消されたパッケージと SDK の不一致が 1 つの問題のように見えていました。

### 4. CI でロックファイルを強制する

`--enforce-lockfile` を付けると、コミット済みの解決結果が現在の SDK で有効でない場合に、`pub get` はロックファイルを書き換えずに失敗します。ドキュメントでは CI と本番デプロイでの使用が推奨されています。3.44 のロックファイルを Flutter 3.47.7 で実行すると次のようになります。

```text
> matcher 0.12.20 (was 0.12.19)
> meta 1.19.0 (was 1.18.0)
> test_api 0.7.12 (was 0.7.11) (0.7.15 available)
> vector_math 2.4.3 (was 2.2.0)
Would change 4 dependencies.
Unable to satisfy `pubspec.yaml` using `pubspec.lock`.

To update `pubspec.lock` run `flutter pub get` without
`--enforce-lockfile`.
Failed to update packages.
```

このコマンドは終了コード 65 で終了し、`pubspec.lock` には手を付けません。すべてのビルドの前に入れておきましょう。

```yaml
# GitHub Actions, subosito/flutter-action v2, Flutter 3.47.7
- uses: subosito/flutter-action@v2
  with:
    flutter-version-file: .fvmrc
- run: flutter pub get --enforce-lockfile
- run: flutter build apk --release
```

これで、間違った SDK の CI ランナーや、SDK 更新後にコミットし忘れたロックファイルは、誰もレビューしていないバージョンでの緑のビルドではなく、明確なメッセージ付きの赤いビルドになります。`--enforce-lockfile` は、ホスト型パッケージの内容ハッシュがロックファイルに記録された `sha256` と一致しなくなった場合にも失敗するので、サプライチェーンのチェックとしても役立ちます。

### 5. `--no-pub` で差分と戦わない

`flutter run --no-pub` は暗黙の `pub get` をスキップするので、ロックファイルの変更は確かに止まります。しかしそれは、古い SDK 用に解決された `package_config.json` に対して新しい SDK を実行することを意味します。うまくいくのは動かなくなるまでで、たいていは `flutter_test` 内のコンパイルエラーや、新しいフレームワークが期待する `meta` アノテーションの問題として現れます。`--no-pub` は簡単な実験にだけ使い、修正としては決して使わないでください。

## 注意点と紛らわしいケース

**3.47 以降の新規プロジェクトは下限から始まります。** [PR #175352](https://github.com/flutter/flutter/pull/175352) 以降、`flutter create` は SDK の依存関係を新しい範囲の下限でロックした `pubspec.lock` を書き出します。新しい 3.47.7 のプロジェクトは `meta` 1.18.3 と `vector_math` 2.4.0 でロックされ、最初の `flutter pub upgrade` でそれぞれ 1.19.0 と 2.4.3 に移動します。この差分は想定どおりのもので、いつ取り込むかは自分で決められます。

**パッチリリースで固定が動くことはまれです。** `flutter_test` の pubspec は 3.47.0、3.47.6、3.47.7 で同一なので、同じマイナーバージョン内のパッチアップグレードでは、通常ロックファイルは変わりません。マイナーリリース (3.44 から 3.47) ではほぼ必ず変わります。マイナーバージョンをまたぐときは、差分が出ることを見込んでおいてください。

**`sha256` の引用符は変更ではありません。** 上記の差分では、引用符付きのハッシュと付いていないハッシュがあります。pub は、YAML が数値として読まないように、数字で始まるハッシュには引用符を付けます。ハッシュの行が変わった場合は、書式ではなくバージョンが変わったためです。

**pub workspace を使うモノレポ。** Dart workspace では、`pubspec.lock` はワークスペースのルートに 1 つだけあり、メンバーフォルダーから実行した `flutter upgrade` も親ディレクトリをたどって `pubspec.yaml` を見つけます。ルールは同じですが、影響範囲はより大きくなります。再解決の後でエディターが重くなる場合は、[大規模モノレポでの Dart 解析サーバーの高速化](/ja/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)を参照してください。

**差分ではなく "version solving failed" になる場合。** 依存しているパッケージが SDK と同じパッケージを固定している場合、SDK を切り替えるとロックファイルが静かに書き換えられるのではなく、解決そのものが失敗します。これは別の問題で、専用の解説があります: [pubspec.yaml の "version solving failed" の修正](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)。

**エンジンのアーティファクトは別の固定です。** フレームワークのバージョンを固定すると、エンジンも固定されます。これは再現可能なリリースビルドにとって重要です。背景は [Flutter 3.38.6 のエンジンバージョンの記事](/ja/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/)にあります。

## 関連記事

- [pubspec.yaml の "version solving failed" を修正する方法](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [1 つの CI パイプラインから複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [修正: Flutter 3.44 で material_ui または cupertino_ui の Undefined name 'awaitNotRequired'](/ja/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)
- [Flutter 3.38.6 とエンジンバージョンの更新: 固定すれば再現可能なビルドが容易になります](/ja/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/)
- [大規模な Flutter モノレポで VS Code の遅い Dart 解析サーバーを高速化する方法](/ja/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)

## 参考資料

- [dart.dev: `dart pub get`](https://dart.dev/tools/pub/cmd/pub-get)、ロック済みバージョン、`--enforce-lockfile`、ロックファイルのコミットについて。
- [flutter/flutter#158050: Stop pinning dependencies](https://github.com/flutter/flutter/issues/158050) と[設計ドキュメント](https://flutter.dev/go/unpin-flutter-sdk-dependencies)。
- [flutter/flutter#184821: Unpin sdk package dependencies](https://github.com/flutter/flutter/pull/184821) と、その再適用である [#185268](https://github.com/flutter/flutter/pull/185268)。
- [flutter/flutter#175352: Have `flutter create` create a pubspec.lock](https://github.com/flutter/flutter/pull/175352)。
- [3.47.7 タグ](https://github.com/flutter/flutter/tree/3.47.7/packages/flutter_tools/lib/src)の Flutter ツールのソース: `commands/upgrade.dart` (`updatePackages`)、`dart/pub.dart` (pub get をスキップするチェック)、`migrations/analysis_options_migration.dart`。
