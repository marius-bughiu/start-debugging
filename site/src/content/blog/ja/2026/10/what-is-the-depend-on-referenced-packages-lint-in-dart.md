---
title: "Dart の depend_on_referenced_packages lint とは何か、推移的インポートで警告が出るのはなぜか"
description: "depend_on_referenced_packages は、別の依存関係経由で解決できる場合でも、自分の pubspec.yaml に記載されていないパッケージを import または export すると警告します。Dart 3.12.2 と Flutter 3.44.8 でこのルールが何を検査するのか、推移的インポートが実際にバグである理由、そして各パターンの修正方法を解説します。"
pubDate: 2026-10-24
tags:
  - "dart"
  - "flutter"
  - "lints"
  - "pub"
  - "pubspec"
lang: "ja"
translationOf: "2026/10/what-is-the-depend-on-referenced-packages-lint-in-dart"
translatedBy: "claude"
translationDate: 2026-10-24
---

**結論:** `depend_on_referenced_packages` は、`package:foo/...` の `import` または `export` のうち、`foo` がインポート元パッケージ自身の `pubspec.yaml` に記載されていないものをすべて報告します。依存関係の 1 つが `foo` を取り込んでいるために `foo` が問題なく解決されるかどうかは関係ありません。推移的パッケージは借りているだけのものであり、バージョンを自分で制御できず、存在も保証できないからです。修正するには、自分でパッケージを宣言します (`dart pub add foo` または `flutter pub add foo`)。インポートが `lib/`、`bin/`、`hook/build.dart`、`hook/link.dart` にある場合は `dependencies` に、`test/` や `tool/` などそれ以外の場所にある場合に限り `dev_dependencies` に宣言します。以下の内容はすべて Dart 3.12.2、Flutter 3.44.8、`lints` 6.1.0、`flutter_lints` 6.0.0 で確認したものです。

このルールは Dart 2.14 から存在し、[`package:lints`](https://pub.dev/packages/lints) の **core** セットに含まれています。つまり `lints/recommended.yaml` と `flutter_lints` のどちらでも有効になります。新しい Flutter アプリで `import 'package:collection/collection.dart';` と入力した途端、コンパイルも実行も問題なくできる行に青い波線が出て、初めてこのルールに出会う人が多いでしょう。

## 動作するインポートに警告が出る理由

`flutter pub get` を実行すると、pub は依存関係グラフ全体を解決し、そこに含まれるすべてのパッケージを `.dart_tool/package_config.json` に書き出します。コンパイラーとアナライザーは、このファイルを通して `package:` URI を解決します。このファイルには推移的な依存関係も含まれています。`http` にしか依存していないプロジェクトで `package:http_parser` が解決できるのはそのためです。`http` が `http_parser` に依存しているので、package config に入っているわけです。

このインポートが今動いているのは偶然にすぎません。後から壊れる可能性のある要因が 3 つあり、どれも差分には現れません。

1. **仲介パッケージが依存をやめる。** `http` 2.0 が `http_parser` への依存をやめた場合、次の `pub upgrade` でグラフから消え、ビルドは `Target of URI doesn't exist` で失敗します。`pubspec.yaml` には何の変更もありません。
2. **バージョンを自分で選んでいない。** コードは、`http` の制約がたまたま許容した `http_parser` のバージョンに対して書かれています。`http` が許容する推移的パッケージのメジャーバージョンアップは、自分の側にそれを止める制約がないまま、破壊的変更になります。
3. **利用者には渡らない。** パッケージを公開する場合、利用者は自分のグラフを解決します。開発用の依存関係は決して推移的に引き継がれないため、`lib/` のコードが dev dependency からインポートしているものは、利用者側には単に存在しません。

この lint は、これら 3 つの潜在的な失敗を、インポート箇所の 1 つの info 診断として可視化します。[公式のルールページ](https://dart.dev/tools/linter-rules/depend_on_referenced_packages)ではこれを "Depend on referenced packages" と要約しており、その理由は、明示的な依存関係こそが、パッケージの存在を保証しつつ自分のバージョン制約を課せる唯一の方法だからです。

## ルールが実際に検査する内容

実装は短く、読む価値があります。Dart SDK の [`pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart`](https://github.com/dart-lang/sdk/blob/main/pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart) です。各ライブラリについて、許可されるパッケージ名のリストを作成します。

- パッケージ自身の `name` (そのため `package:my_app/...` という自己インポートは常に問題ありません)
- `dependencies` 配下のすべてのキー
- `dev_dependencies` 配下のすべてのキー。**ただし、ファイルが公開ロケーションにない場合に限ります。**

ファイルが `lib/` または `bin/` の中にある場合、あるいは `hook/build.dart` か `hook/link.dart` そのものである場合 (ネイティブアセットのビルドフック。[dart-lang/sdk#54334](https://github.com/dart-lang/sdk/issues/54334) の後に追加されました) に、公開ロケーションとみなされます。そのうえで、すべての `import` と `export` ディレクティブを走査し、`package:` の後ろの最初のパスセグメントを取り出して、その名前が許可リストになければ報告します。

このコードから、次のことが直接導かれます。

- `dependency_overrides` は参照されません。そこにしか現れないパッケージは、依然として "not a dependency" です。
- `export` ディレクティブも、インポートとまったく同じように検査されます。
- ディレクティブのメイン URI だけが検査され、条件付き `if (dart.library.io) ...` 句の中の URI は検査されません。
- ハードコードされた唯一の例外は `flutter_gen` で、これは以前のローカライズ用の合成パッケージです ([dart-lang/linter#3308](https://github.com/dart-lang/linter/issues/3308) を参照)。
- ルートパッケージやワークスペースからの継承はありません。各パッケージは自分自身の pubspec に対して検査されます。

## すべてのパターンを再現するリポジトリ

`http` だけに依存し、`meta` を dev dependency として持つ小さな純粋な Dart パッケージです。

```yaml
# pubspec.yaml -- Dart 3.12.2
name: repro
version: 1.0.0

environment:
  sdk: ^3.12.0

dependencies:
  http: ^1.6.0

dev_dependencies:
  lints: ^6.1.0
  meta: ^1.18.0

dependency_overrides:
  path: ^1.9.1
```

```yaml
# analysis_options.yaml
include: package:lints/recommended.yaml
```

```dart
// lib/repro.dart -- Dart 3.12.2
import 'package:http/http.dart' as http;          // declared: OK
import 'package:http_parser/http_parser.dart';   // transitive via http: LINT
import 'package:meta/meta.dart';                 // dev_dependency in lib/: LINT
import 'package:repro/src/helpers.dart';         // self package: OK
export 'package:async/async.dart' show Result;   // transitive export: LINT

@immutable
class Probe {
  const Probe();

  Future<MediaType> contentType(Uri uri) async {
    final response = await http.head(uri);
    return MediaType.parse(response.headers['content-type'] ?? 'text/plain');
  }
}

final helper = helperValue;
```

同じ `import 'package:meta/meta.dart';` を `bin/repro.dart`、`hook/build.dart`、`tool/gen.dart`、`test/repro_test.dart` にも追加し、テストからも `package:http_parser` をインポートし、`lib/src/over.dart` から `package:path` (override のみ) をインポートします。`dart analyze` の報告は次のとおりです。

```text
info - bin/repro.dart:1:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - hook/build.dart:1:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:2:8 - The imported package 'http_parser' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:3:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:5:8 - The imported package 'async' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/src/over.dart:1:8 - The imported package 'path' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - test/repro_test.dart:2:8 - The imported package 'http_parser' isn't a dependency of the importing package. ... - depend_on_referenced_packages
```

報告されていないものに注目してください。`tool/gen.dart` と `test/` 内の `meta` のインポートは問題ありません。dev dependency は公開ロケーション以外では許可されているためです。また、パッケージが存在しない場合でも、間違ったセクションにあるだけの場合でも、メッセージは同じです。"Isn't a dependency" は "dev dependency だが、このファイルは公開ロケーションにある" という意味の場合もあります。

## 同じ問題の Flutter 版

Flutter アプリで誤ってインポートしやすい推移的パッケージは、SDK 自体が依存しているものです。`collection`、`meta`、`vector_math`、`characters`、`material_color_utilities` などです。`flutter` が必要とするため、これらは常にグラフに含まれています。新しい `flutter create --empty` アプリに次のファイルを置きます。

```dart
// lib/probe.dart -- Flutter 3.44.8
import 'package:collection/collection.dart';
import 'package:meta/meta.dart';
import 'package:vector_math/vector_math_64.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
```

すると `depend_on_referenced_packages` の info が 4 件出ます。`flutter_localizations` にはさらに `uri_does_not_exist` のエラーも出ます。これは別の SDK パッケージで、要求するまでグラフに含まれないためです。lint のほうが親切な診断ですが、根本的な問題は同じです。

## ケース別の修正方法

1. **`lib/` から推移的パッケージをインポートしている。** 通常の依存関係として宣言します。制約は推測せず、pub に選ばせます。

   ```bash
   # Flutter 3.44.8
   flutter pub add collection meta vector_math
   ```

   ```yaml
   dependencies:
     collection: ^1.19.1
     flutter:
       sdk: flutter
     meta: ^1.18.0
     vector_math: ^2.2.0
   ```

2. **`flutter_localizations` のような SDK パッケージ。** `sdk: flutter` の形式が必要で、`pub add` は JSON 記述子としてこれを受け付けます。

   ```bash
   flutter pub add 'flutter_localizations:{"sdk":"flutter"}'
   ```

3. **`lib/`、`bin/`、ビルドフックから dev dependency をインポートしている。** `dependencies` に移すか (`dart pub add meta` なら自動で移動します)、インポートしているコードを公開ディレクトリの外に移します。`meta` のようなアノテーション専用のパッケージの場合は、`dependencies` に移すのが正解です。`lib/` に `@immutable` があるパッケージを公開すると、そうしなければ利用者側でコンパイルできません。

4. **`dependency_overrides` にしか存在しないパッケージ。** override はすでにグラフに入っているもののバージョンを変更するだけで、依存関係を宣言するものではありません。通常のエントリも追加し、まだ必要なら override も残します。

5. **ライブラリから export しているパッケージ。** インポートと同じ修正です。`package:async` の `Result` を再エクスポートすると、公開 API が `async` のバージョンに依存することになります。だからこそ、自分の制約をそこに課したいわけです。

このルールには `dart fix` がありません。再現リポジトリで `dart fix --dry-run` を実行すると "Nothing to fix!" と報告されます。IDE のクイックフィックスはパッケージを `pubspec.yaml` に追加し、ターミナルからは `pub add` が同じことをします。

## 落とし穴とエッジケース

### Flutter SDK が制約を固定する

`meta` や `collection` のようなパッケージは、`flutter` と `flutter_test` によって正確なバージョンに固定されています。固定バージョンより高い制約を書くと、解決に失敗します。

```text
Note: meta is pinned to version 1.18.0 by flutter_test from the flutter SDK.

Because every version of flutter_test from sdk depends on meta 1.18.0 and fapp depends on meta ^1.19.0, flutter_test from sdk is forbidden.
So, because fapp depends on flutter_test from sdk, version solving failed.
```

制約を手で入力するよりも `flutter pub add` のほうが優れているのはこのためです。固定を満たすバージョンを選んでくれます。すでにこのエラーに遭遇した場合は、[pubspec.yaml の "version solving failed" の修正](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)の解説で、ソルバーの出力の読み方を説明しています。後で Flutter のバージョンを変更すると、固定が SDK とともに動くため `pubspec.lock` が大きく変わることがあります。その理由は[この pubspec.lock の解説](/ja/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/)にあります。

### pub ワークスペースは依存関係を継承しない

Dart 3.6 以降の pub ワークスペースでは、すべてのメンバーが 1 つの解決結果と 1 つの `package_config.json` を共有するため、メンバーは他のどのメンバーが依存しているものでもインポートできます。しかし lint はそれを許可しません。ルートの `pubspec.yaml` の `dependencies` に `http` があり、メンバー `pkgs/app` が `resolution: workspace` で依存関係を持たない場合でも、次のように報告されます。

```text
info - pkgs/app/lib/app.dart:1:8 - The imported package 'http' isn't a dependency of the importing package. ... - depend_on_referenced_packages
```

モノレポではこれが望ましい動作です。共有された解決結果は、パッケージ間の意図しない借用を簡単にしてしまいます。この lint は、パッケージが兄弟パッケージの依存関係リストに黙って頼ることを防ぐものです。大きなワークスペースで解析サーバーが遅い場合、それは別の問題です。[大規模な Flutter モノレポで Dart 解析サーバーを高速化する方法](/ja/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)を参照してください。

### 条件付きインポートは見逃される

このルールはディレクティブの主 URI だけを検査します。次のコードは、`path` が宣言されていなくても lint を通過します。

```dart
// lib/src/cond.dart -- Dart 3.12.2
import 'package:repro/src/helpers.dart'
    if (dart.library.io) 'package:path/path.dart';
```

Dart 3.12.2 では `dart pub publish --dry-run` もこれを指摘しませんでした。プラットフォーム条件付きインポートは、レビューで手作業で確認してください。

### `dart pub publish` は同じルールをエラーとして強制する

公開パッケージでは、pub 自身のバリデーターがこのチェックのより厳しい版を実行します。再現リポジトリで `dart pub publish --dry-run` を実行すると、lib、bin、フックの指摘はハードエラーになりました。

```text
* line 3, column 1 of lib/repro.dart: meta is in the `dev_dependencies` section of `pubspec.yaml`. Packages used in lib/ must be declared in the `dependencies` section.
* line 2, column 1 of lib/repro.dart: This package does not have http_parser in the `dependencies` section of `pubspec.yaml`.
```

`test/` の指摘は警告としてのみ返されます。つまり、公開するパッケージで lint を無視しても、失敗がリリース当日に先送りされるだけです。

### `flutter_gen` は例外だが、なくなりつつある

`flutter_gen` が例外とされているのは、`flutter gen-l10n` がかつて、どの pubspec にも記載できない合成パッケージを生成していたためです。Flutter はこの合成パッケージを非推奨にしました ([破壊的変更の告知](https://docs.flutter.dev/release/breaking-changes/flutter-generate-i10n-source)を参照)。生成されるローカライズ用コードは自分のソースツリー内に置かれ、自分のパッケージ名でインポートされます。これは lint がすでに許可している形です。

### 開発用パッケージ 1 つだけのために無効にしない

よくある要望は、開発専用のアノテーションパッケージを `analysis_options.yaml` でホワイトリスト化することです。[dart-lang/sdk#60026](https://github.com/dart-lang/sdk/issues/60026) はまさにそれを求めましたが、機能は追加されずにクローズされました。メンテナーの回答は、`lib/` からインポートされるパッケージは本物の依存関係であり、どうしてもという場合は `// ignore:` コメントが使える、というものでした。どうしても必要なら、抑制はプロジェクト全体ではなく行単位にとどめてください。

```dart
// ignore: depend_on_referenced_packages
import 'package:meta/meta.dart';
```

ルールをグローバルに無効にする (`linter: rules:` の下で `depend_on_referenced_packages: false`) と、pub や利用者のビルドが失敗する前に得られる唯一の早期警告も無効になります。lint の設定は、各ルールがどこを見ているかを正確に知ると理解しやすくなります。[unawaited_futures と discarded_futures の比較](/ja/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)は、名前から想像されるよりも対象範囲が狭い 2 つのルールの好例です。

## 関連記事

- [Fix: Version solving failed in pubspec.yaml](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Fix: pubspec.lock shows as modified after flutter upgrade or switching Flutter versions](/ja/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/)
- [unawaited_futures vs discarded_futures in Dart](/ja/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)
- [How to run dart fix across a whole repo to apply Flutter breaking-change migrations](/ja/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)
- [How to speed up a slow Dart analysis server in VS Code for a large Flutter monorepo](/ja/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)

## 参考資料

- [depend_on_referenced_packages rule page](https://dart.dev/tools/linter-rules/depend_on_referenced_packages) and [diagnostic page](https://dart.dev/tools/diagnostics/depend_on_referenced_packages)
- [Rule implementation in dart-lang/sdk](https://github.com/dart-lang/sdk/blob/main/pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart) and [its tests](https://github.com/dart-lang/sdk/blob/main/pkg/linter/test/rules/depend_on_referenced_packages_test.dart)
- [package:lints core rule set](https://pub.dev/packages/lints)
- [dart-lang/sdk#60026: exempting dev dependencies](https://github.com/dart-lang/sdk/issues/60026)
- [dart-lang/linter#3308: flutter_gen exemption](https://github.com/dart-lang/linter/issues/3308)
- [SDK version pinning](https://dart.dev/go/sdk-version-pinning)
- [Flutter breaking change: flutter generate l10n source](https://docs.flutter.dev/release/breaking-changes/flutter-generate-i10n-source)
