---
title: "リポジトリ全体に dart fix を実行して Flutter の破壊的変更マイグレーションを適用する方法"
description: "dart fix が受け取るターゲットディレクトリは 1 つだけで、それはリポジトリのルートで構いません。アナライザーは入れ子になった pubspec.yaml ごとにコンテキストを開き、すべてのパッケージを 1 回で移行します。フラグの全体像、修正を黙って抑制して汚れたリポジトリに Nothing to fix と言わせる 4 つの原因、CI で終了コードが役に立たない理由、そして Flutter のトランスフォームがコンパイルできないコードを生成する実例をまとめます。"
pubDate: 2026-09-08
template: how-to
tags:
  - "flutter"
  - "dart"
  - "migration"
  - "tooling"
  - "how-to"
lang: "ja"
translationOf: "2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations"
translatedBy: "claude"
translationDate: 2026-09-08
---

`dart fix --apply` が受け取るターゲットディレクトリは 1 つだけで、そのディレクトリはリポジトリのルートで構いません。アナライザーはその下に入れ子になっている `pubspec.yaml` ごとに解析コンテキストを開くので、10 個以上のパッケージを含むモノレポでも 1 つのコマンドで移行でき、各パッケージ自身の `analysis_options.yaml` も尊重されます。リポジトリ全体に対する実行が、明らかに非推奨の警告だらけのコードベースでたびたび `Nothing to fix!` と表示するのは、ツールが壊れているからではありません。互いに無関係な 4 つの要因が修正を抑制し、そのいずれの場合でも `dart fix` は 0 で終了します。また、Flutter fix という名前のドキュメントページがあるにもかかわらず、`flutter fix` というコマンドは存在しません。以下はすべて Flutter 3.44.8 と Dart 3.12.2 で実行したものです。ここで引用したコマンドの構成と内部実装は、現在の安定版ライン Flutter 3.47 の元になっている Dart SDK の main ブランチでも変わっていません。

## コマンドの全体像はフラグ 4 つだけ

このツールを軸にリポジトリ全体のワークフローを設計する前に、中身がどれだけ少ないかを知っておくと役に立ちます。

```console
$ dart fix --help
Apply automated fixes to Dart source code.

This tool looks for and fixes analysis issues that have associated automated fixes.

To use the tool, run either 'dart fix --dry-run' for a preview of the proposed changes for a project, or 'dart fix --apply' to apply the changes.

Usage: dart fix [arguments]
-h, --help                      Print this usage information.
-n, --dry-run                   Preview the proposed changes but make no changes.
    --apply                     Apply the proposed changes.
    --code=<code1,code2,...>    Apply fixes for one (or more) diagnostic codes.
```

これで全部です。`pkg/dartdev/lib/src/commands/fix.dart` には隠しフラグが 2 つあります (SDK 自身のテスト用の `--compare-to-golden` と `--use-aot-snapshot`) が、どちらも実用には向きません。`--exclude` はなく、glob のサポートもなく、複数パスの引数もありません。位置引数のターゲットはちょうど 1 つ、ファイルかディレクトリで、既定はカレントディレクトリです。`--apply` も `--dry-run` も渡さない場合、あるいは両方渡した場合、コマンドは使い方を表示して何もせず 0 を返します。

もう 1 つ、早めに確認しておきたいこと。

```console
$ flutter fix --dry-run
Could not find a command named "fix".
```

[Flutter fix](https://docs.flutter.dev/tools/flutter-fix) のドキュメントページが説明しているのは機能であって、コマンドではありません。実行するのは `dart fix` で、`PATH` 上の `dart` が Flutter SDK 同梱のもの (`$FLUTTER_ROOT/bin/dart`) である限り、フレームワークのマイグレーションデータは自動的に解決されます。

## ルートでの 1 回の実行がすべての入れ子パッケージをカバーする

ここが多くのチームが間違えるところで、たいていは必要かどうかを確かめる前に `find` のループを書いてしまいます。メンバーが 3 つある pub workspace を例にします。

```yaml
# pubspec.yaml at the repo root, Dart 3.12.2
name: mono_root
environment:
  sdk: ^3.12.0
workspace:
  - packages/pkg_a
  - packages/pkg_b
  - apps/app
```

ルートでコマンドを 1 回、レポートは 3 つすべてを含みます。

```console
$ dart fix --dry-run
Computing fixes in mono (dry run)...

6 proposed fixes in 3 files.

apps/app/lib/main.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix

packages/pkg_a/lib/a.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix

packages/pkg_b/lib/b.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix
```

これは workspace の機能ではありません。ルートに `pubspec.yaml` がまったくない並列のパッケージ 2 つでも同じ扱いになります。アナライザーはディレクトリツリーをたどって `pubspec.yaml` と `analysis_options.yaml` を探すことでコンテキストのルートを見つけるからです。この 1 回の実行の中で各パッケージは自分の lint 設定を保持するので、`prefer_final_locals` を有効にしているパッケージだけがその修正を受け取り、隣のパッケージは受け取りません。

`dart fix` は反復もします。`FixCommand.maxPasses` は 4 で、編集が生成されなくなるかこの上限に達するまで計算全体を再実行します。その効果は 1 つの文で確認できます。`var b = Box(1);` は `final b = const Box(1);` になりますが、これには `prefer_final_locals` と `prefer_const_constructors` が同じ行に対して別々のパスで発火する必要があります。

## 非推奨 API だらけなのにパッケージが "Nothing to fix!" と言う理由

4 つの異なる仕組みが、同じ出力と同じ終了コードを生みます。次の順で消し込んでください。

**パッケージが解決されていない。** `dart fix` が `package:lib_pkg/api.dart` の意味を知るには `.dart_tool/package_config.json` が必要で、それがなければ修正を紐づける `deprecated_member_use` の診断そのものが存在しません。同じリポジトリ、同じファイルで、`pub get` の前後を比べます。

```console
$ dart fix --dry-run          # no pub get yet
Computing fixes in app (dry run)...
Nothing to fix!

$ dart pub get && dart fix --dry-run
Computing fixes in app (dry run)...

1 proposed fix in 1 file.

lib/main.dart
  deprecated_member_use - 1 fix
```

モノレポではこれが定番の原因です。CI がアプリは解決したのに 6 個のリーフパッケージは解決しておらず、マイグレーションがツリーの一部だけを黙ってカバーする、という状況になります。

**ファイルが解析対象から除外されている。** 生成コードを lint レポートから外すために何年も前に追加された `exclude` のリストは、それらのファイルを修正対象からも外します。

```yaml
# analysis_options.yaml
analyzer:
  exclude:
    - lib/main.dart
```

```console
$ dart fix --dry-run
Nothing to fix!
```

**診断が `ignore` に格下げされている。** これが最も害の大きいケースです。Flutter のアップグレードで CI が非推奨の警告であふれたときの定番の対処だからです。

```yaml
analyzer:
  errors:
    deprecated_member_use: ignore
```

警告を黙らせると、対応する自動マイグレーションも無効になります。リポジトリにこの行があるなら、`dart fix` を実行する前に消してください。あとからではありません。

**その行に `// ignore:` コメントが付いている。** 効果は同じで、ファイル単位でも行単位でも起こります。大きなウィジェットファイルの先頭にある `// ignore_for_file: deprecated_member_use` は、`dart fix` に何も言わせずファイル全体をスキップさせます。

lint 由来の修正には、罠ではなく仕様である 5 つ目のケースがあります。修正が存在するのは、その lint が有効な場合だけです。`--code` はこれを上書きしません。

```console
$ dart fix --dry-run --code=prefer_final_locals   # lint not in analysis_options.yaml
Nothing to fix!
```

ルールを追加すれば、同じコマンドが修正を見つけます。ここから 1 回限りの便利な使い方が導けます。片付け用の lint を一時的に有効にし、`dart fix --apply --code=<その lint>` を実行し、そのうえでルールを有効なまま残すかどうかを決める、という流れです。

この 5 つのケースはいずれも終了ステータスを変えません。上のすべての実行が 0 を返しています。ゼロ以外を返す唯一の呼び出しは、未知の診断コードです。

```console
$ dart fix --apply --code=this_is_not_a_real_code
Computing fixes in app...
Unable to compute fixes: The diagnostic 'this_is_not_a_real_code' is not defined by the analyzer.
$ echo $?
3
```

これは知っておく価値があります。CI スクリプトのタイプミスが、マイグレーションを黙って飛ばすのではなく明確に失敗してくれるという意味だからです。

## リポジトリ全体に対して実行する手順

1. **先に SDK を更新し、そのあと抑制設定を外す。** 非推奨のトランスフォームは、アナライザーが非推奨と認識できる API に対してしか存在しないので、まず `flutter upgrade` です。次に各 `analysis_options.yaml` の `deprecated_member_use: ignore` と `lib/` の `ignore_for_file: deprecated_member_use` を探して削除します。ここを飛ばすと、手順 3 と 4 はリポジトリがきれいだと報告します。

2. **すべてのパッケージを解決する。** pub workspace の内側なら、どこか 1 か所で `dart pub get` を実行すれば全体が解決されます (メンバーパッケージで実行すると `Resolving dependencies in /path/to/root` と表示され、ルートの `.dart_tool` が書かれます)。workspace の外では、独自に解決するパッケージごとに `pub get` が必要です。

3. **ルートで 1 回実行してレポートを読む。** リポジトリのルートから `dart fix --dry-run` を実行し、ファイル一覧に期待どおりのパッケージがすべて出ているか確認します。レポートに出てこないパッケージは、きれいなのではなく、手順 2 に失敗したか解析対象から除外されているパッケージです。

4. **手順 3 で足りなかったときだけ、パッケージごとのループに切り替える。** 1 か所からパッケージを解決できないリポジトリでは、これですべてをカバーでき、冪等でもあります。

   ```bash
   #!/usr/bin/env bash
   # tool/dart_fix_repo.sh - Flutter 3.44.8, Dart 3.12.2
   set -euo pipefail

   find . -name pubspec.yaml \
     -not -path '*/.*' \
     -not -path '*/build/*' \
     -not -path '*/ephemeral/*' \
     -print | while read -r manifest; do
       pkg=$(dirname "$manifest")
       echo "==> $pkg"
       ( cd "$pkg" && dart pub get >/dev/null && dart fix --apply "$@" )
     done

   dart format .
   ```

   `-not -path` のフィルターは重要です。`build/` と、`windows/`、`linux/`、`macos/` 配下の `ephemeral/` ディレクトリには、触りたくない生成済みの `pubspec.yaml` が入っています。すでに [Melos](https://melos.invertase.dev/) を使っているなら、`melos exec -- "dart pub get && dart fix --apply"` が、設定済みのフィルターフラグをそのまま活かして同じことをします。

5. **フォーマットし、次に解析し、次にテストを実行する。** この順番で、最後を飛ばさないでください。詳細は後述します。

## 1 コミットにつき診断 1 つ

400 ファイルに及ぶ `dart fix --apply` の差分はレビューできません。`--code` はカンマ区切りのリストを受け取るので、人間が実際に読めるコミットに実行を分割してください。

```bash
dart fix --apply --code=deprecated_member_use
git commit -am "chore: apply Flutter deprecation migrations via dart fix"

dart fix --apply --code=prefer_const_constructors,prefer_const_literals_to_create_immutables
git commit -am "chore: const cleanup via dart fix"
```

dry run のレポートは、見つかったコードごとの正確なコマンドを表示してくれるので、この計画は安上がりです。

## マイグレーションはどこから来るのか

非推奨の修正はコンパイラーのロジックではなくデータです。パッケージは `lib/fix_data.yaml` でそれを宣言し、アナライザーは解決済みの任意の依存関係からそれを拾います。Flutter 3.44.8 では、フレームワークが `packages/flutter/lib/fix_data/` 配下にそのようなファイルを 30 個同梱しており、381 個のトランスフォームが入っています。さらに `flutter_test` に 8 個、`flutter_driver` に 2 個、`integration_test` に 1 個あります。`package:flutter` における変更の種類を頻度順に並べると、`removeParameter` 418、`addParameter` 228、`fragment` 204、`rename` 158、`renameParameter` 90、`import` 16、`addTypeParameter` 12、`replacedBy` 11、`changeParameterType` 1 です。

同じ仕組みは自社の内部パッケージでも使えます。共有のデザインシステムを保守しているなら、この記事で最も効果が大きいのはここです。古いメンバーを非推奨にし、そのうえで書き換え方を記述します。

```dart
// lib_pkg/lib/api.dart
class Report {
  @Deprecated('Use render() instead. Removed in lib_pkg 3.0.0.')
  String toHtml() => render();
  String render() => '<html/>';
}
```

```yaml
# lib_pkg/lib/fix_data.yaml - Dart 3.12.2
version: 1
transforms:
  - title: "Rename to 'render'"
    date: 2026-09-01
    element:
      uris: ['api.dart']
      method: 'toHtml'
      inClass: 'Report'
    changes:
      - kind: 'rename'
        newName: 'render'
```

依存関係を上げたあとに `dart fix --apply` を実行した利用側はすべて、`r.toHtml()` が `r.render()` に書き換えられます。`uris` のリストには、利用側が import する公開ライブラリのパスを書く必要があり、クラスが宣言されている `src/` のファイルではありません。手書きの `fix_data.yaml` が何も起こさない原因として、この 1 点が最も多いものです。

## dart fix はコンパイラーではなく、ビルドできないコードを渡してくることがある

上の手順 5 がコミットではなく解析とテストで終わっているのはこのためです。非推奨の Flutter API を 2 つ使った最小限のウィジェットを用意します。

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

class Card1 extends StatelessWidget {
  const Card1({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black.withOpacity(0.5),
      child: ListView(
        cacheExtent: 250.0,
        children: const [Text('hi')],
      ),
    );
  }
}
```

`dart fix --apply` は `deprecated_member_use - 2 fixes` と報告し、両方を書き換えます。`withOpacity` のトランスフォームは正しいものです。`cacheExtent` のほうは正しくありません。

```dart
color: Colors.black.withValues(alpha: 0.5),
child: ListView(
  scrollCacheExtent: ScrollCacheExtent.pixels(250.0), children: const [Text('hi')],
),
```

```console
$ flutter analyze
error - Undefined name 'ScrollCacheExtent'. Try correcting the name to one that is defined,
        or defining the name - lib/main.dart:11:28 - undefined_identifier
```

`ScrollCacheExtent` は `packages/flutter/lib/src/rendering/viewport.dart` で宣言されており、エクスポートされているのは `package:flutter/rendering.dart` からだけです。`material.dart` も `widgets.dart` も再エクスポートしておらず、`fix_widgets.yaml` のトランスフォームは対応する `import` の変更なしに `addParameter` を使っています。書き換え自体は意味的に正しいのに、ファイルはコンパイルできなくなります。`import 'package:flutter/rendering.dart';` を追加すれば直り、`flutter analyze` は緑になります。

この失敗の形は一般化できます。`dart fix` は YAML に記述されたトークン範囲を編集するだけで、結果の型チェックはせず、書き込んだシンボルがスコープに入っているかも知りません。ここではコンパイルエラーより挙動の変化のほうが厄介です。何も捕まえてくれないからで、[Material と Cupertino のパッケージ分離](/ja/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)や [Radio から RadioGroup への書き換え](/ja/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/)が、自動パスのあとに analyze だけでなくテストの実行を必要とするのも同じ理由です。

救いが 1 つあります。構文エラーのあるファイルが実行全体を汚染することはありません。`dart fix` は同じパッケージの他のファイルについては引き続き修正を計算し、適用します。

## 必ず dart format を続けて実行する

このツールは編集を適用するだけで、結果を整形し直しはしません。上のコードで `children` がどこに行ったか見てください。`dart format .` が元に戻します。

```dart
child: ListView(
  scrollCacheExtent: ScrollCacheExtent.pixels(250.0),
  children: const [Text('hi')],
),
```

フォーマットの手順は修正と同じコミットに入れてください。そうしないと次の人のエディターがやることになり、blame がより読みにくくなります。

## CI でのゲート

終了コードが常に 0 なので、CI のチェックは代わりにワーキングツリーを見る必要があります。修正を適用し、判断は git に任せます。

```yaml
# .github/workflows/analyze.yml
- run: dart pub get
- run: dart fix --apply
- run: git diff --exit-code
```

ローカルで検証済みです。未適用の修正がブランチにコミットされている状態では `git diff --exit-code` は 1 を返してジョブが失敗し、修正が何もなければ 0 を返します。[1 つの CI から複数の Flutter バージョンをビルドしている](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)場合はマトリクスと組み合わせてください。利用できるトランスフォームは SDK ごとに異なり、3.47 で未適用の修正が 3.44 には存在しないこともあります。

数年もののコードベースで実際に持ちこたえるワークフローは退屈なものです。SDK を更新し、抑制設定を消し、すべてを解決し、ルートで dry run し、診断コードを 1 つずつ適用し、フォーマットし、解析し、テストし、コミットする。タイピングの大半はフレームワークの 392 個のトランスフォームがやってくれます。トランスフォームにできないのは、あなたが差分を読む部分です。

## 関連記事

- [Flutter の Material / Cupertino インポートを material_ui と cupertino_ui パッケージへ移行する](/ja/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)
- [Flutter の Web アプリを dart:html から package:web と dart:js_interop へ移行する](/ja/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/)
- [Flutter で非推奨になった Radio の groupValue と onChanged を RadioGroup に置き換える方法](/ja/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/)
- [Flutter 2 アプリを Flutter 3.x に移行する: null safety チェックリスト](/ja/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)
- [1 つの CI パイプラインから複数の Flutter バージョンをターゲットにする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)

## 参考資料

- [dart fix](https://dart.dev/tools/dart-fix), Dart ツールのドキュメント
- [Flutter fix](https://docs.flutter.dev/tools/flutter-fix), Flutter ツールのドキュメント
- [Breaking changes and migration guides](https://docs.flutter.dev/release/breaking-changes), Flutter リリースのドキュメント
- [`pkg/dartdev/lib/src/commands/fix.dart`](https://github.com/dart-lang/sdk/blob/main/pkg/dartdev/lib/src/commands/fix.dart), Dart SDK
- [`pkg/dartdev/doc/dart-fix.md`](https://github.com/dart-lang/sdk/blob/main/pkg/dartdev/doc/dart-fix.md), Dart SDK
- [Data driven fixes](https://dart.dev/go/data-driven-fixes), `fix_data.yaml` の Dart 仕様
- [Pub workspaces](https://dart.dev/tools/pub/workspaces), Dart のパッケージ管理ドキュメント
- [Customizing static analysis](https://dart.dev/tools/analysis), Dart アナライザーのドキュメント
