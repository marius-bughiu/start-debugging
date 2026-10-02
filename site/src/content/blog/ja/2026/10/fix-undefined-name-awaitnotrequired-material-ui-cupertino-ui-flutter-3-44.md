---
title: "修正: Flutter 3.44 で material_ui または cupertino_ui から出る Undefined name 'awaitNotRequired'"
description: "material_ui 1.3.0 と cupertino_ui 1.1.0 は、Flutter 3.44 がエクスポートしていないアノテーションを使っています。どちらも retract 済みですが、ロックファイルが残していることがあります。ダウングレードしてからアップグレードし、1.2.0 と 1.0.2 に着地させます。"
pubDate: 2026-10-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-44"
  - "dart"
  - "pub"
lang: "ja"
translationOf: "2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44"
translatedBy: "claude"
translationDate: 2026-10-02
---

`pubspec.lock` が `material_ui` 1.3.0 または `cupertino_ui` 1.1.0 (あるいはその両方) に固定されています。この 2 つのリリースは `@awaitNotRequired` を使っていますが、`package:flutter/foundation.dart` がこれをエクスポートするのは Flutter 3.47.0 以降です。どちらのバージョンも pub.dev ではすでに retract されていますが、pub は一度ロックした retract 済みバージョンを保持し続けるため、Flutter 3.44 では `flutter pub upgrade` でも抜け出せません。`flutter pub downgrade material_ui cupertino_ui` を実行してから `flutter pub upgrade` を実行するか (最終的に `material_ui` 1.2.0 と `cupertino_ui` 1.0.2 になります)、Flutter を 3.47 にアップグレードしてください。以下の内容はすべて、2026-10-02 に Flutter 3.44.8 (Dart 3.12.2) と Flutter 3.47.6 (Dart 3.13.5) で検証したものです。

## エラーの実際の出方

アナライザーは何も報告せず、`flutter pub get` も成功し、最初の本格的なコンパイルで pub キャッシュ内部のコードが失敗します。以下は 3.44.8 での `flutter build web` の出力です。他のターゲットも同じソースに対して同じ Dart フロントエンドを実行するため、`flutter run` も同じ行で失敗します。

```text
Target dart2js failed: ProcessException: Process exited abnormally with exit code 1:
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/bottom_sheet.dart:1304:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/carousel.dart:1982:4:
Error: Not a constant expression.
  @awaitNotRequired
   ^^^^^^^^^^^^^^^^
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/dialog.dart:1672:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
...
/Users/marius/.pub-cache/hosted/pub.dev/cupertino_ui-1.1.0/lib/src/route.dart:1347:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
```

`material_ui` 1.3.0 ではこのエラーが 8 件出ます (`showModalBottomSheet`、`CarouselController.animateToItem`、`showDatePicker`、`showDateRangePicker`、`showDialog`、`showAdaptiveDialog`、`showMenu`、`showTimePicker`)。`cupertino_ui` 1.1.0 ではさらに 2 件追加されます (`showCupertinoModalPopup`、`showCupertinoDialog`)。`Not a constant expression` は同じバグの別の現れ方で、インスタンスメソッド上のアノテーションがフロントエンドによって別の形で報告されたものです。なお、アナライザーは依存パッケージ内部のエラーを表示しないため、プロジェクトで `flutter analyze` を実行しても何も報告されません。検出できるのはコンパイル工程だけです。

この問題に遭遇するために `material_ui` を直接依存に入れている必要はありません。たとえば `shimmer` 4.0.0 は `material_ui: ^1.0.1` に依存しているため、2026-09-15 から retract までの間に Flutter 3.44 で `flutter pub add shimmer` を実行すると、1.3.0 が推移的に入ってきました。[flutter/flutter#192839](https://github.com/flutter/flutter/issues/192839) の報告者が遭遇したのもまさにこの経路です。

## Flutter 3.44 が自身の meta パッケージにあるアノテーションを認識できない理由

`awaitNotRequired` は新しいものではありません。`package:meta` に 1.17.0 から存在しており、Flutter 3.44.8 が固定している `meta` 1.18.0 にもすでに含まれています。定数自体は pub キャッシュの中にあります。3.44 に欠けているのは再エクスポートです。

`material_ui` と `cupertino_ui` は `package:meta` をインポートしません。ライブラリファイルは `package:flutter/foundation.dart` をインポートし、それが `meta` から再エクスポートしているものに依存しています。Flutter 3.44 では、そのリストは次のように閉じています。

```dart
// packages/flutter/lib/foundation.dart, Flutter 3.44.8
export 'package:meta/meta.dart'
    show
        factory,
        immutable,
        internal,
        // ignore: experimental_member_use
        mustBeConst,
        mustCallSuper,
        nonVirtual,
        optionalTypeArgs,
        protected,
        required,
        visibleForOverriding,
        visibleForTesting;
```

[flutter/flutter#181513](https://github.com/flutter/flutter/pull/181513) ("Add @awaitNotRequired annotation to flutter sdk") は、2026-04-25 にこの `show` リストへ `awaitNotRequired` を追加しました。この変更は 3.44 ブランチには間に合わず、Flutter 3.47.0 (2026-08-12) で出荷されました。3.44.x のどのリリース (3.44.0 から 3.44.9) でも、`foundation.dart` だけをインポートしているコードからこの識別子はスコープ内にありません。

一方、パッケージ側は Flutter の main チャンネルに対して開発されています。[flutter/packages#12622](https://github.com/flutter/packages/pull/12622) と [#12817](https://github.com/flutter/packages/pull/12817) がアノテーションを追加し、`material_ui` 1.3.0 と `cupertino_ui` 1.1.0 は 2026-09-15 に、アノテーション付きで、しかし従来と同じ `environment` のまま公開されました。

```yaml
# material_ui 1.3.0 pubspec.yaml
environment:
  sdk: ^3.12.0
  flutter: ">=3.44.0"
```

pub はこの制約を信頼するため、Flutter 3.44 では 1.3.0 を互換性のある最新バージョンとして選択しました。上流での対応は二段構えでした。`material_ui` 1.4.0 と `cupertino_ui` 1.1.1 (どちらも 2026-09-21/22) が下限を `flutter: ">=3.47.0"` と `sdk: ^3.13.0` に引き上げ、1.3.0 と 1.1.0 は retract されました。issue は 2026-09-21 にクローズされています。

## 最小の再現手順

retract 済みのバージョンも `dependency_overrides` で固定すれば強制できます。ビルド失敗をあえて再現する最も簡単な方法です。

```yaml
# pubspec.yaml, Flutter 3.44.8 / Dart 3.12.2
name: repro
publish_to: 'none'
environment:
  sdk: ^3.12.0
dependencies:
  flutter:
    sdk: flutter
  material_ui: ^1.0.0
dependency_overrides:
  material_ui: 1.3.0
  cupertino_ui: 1.1.0
```

```dart
// lib/main.dart, Flutter 3.44.8, material_ui 1.3.0
import 'package:material_ui/material_ui.dart';

void main() => runApp(
  const MaterialApp(home: Scaffold(body: Center(child: Text('hi')))),
);
```

`flutter pub get` は成功し、`flutter analyze` もエラーを報告せず、`flutter build web` が上記の出力で失敗します。オーバーライドなしで `flutter pub add material_ui:1.3.0` を実行すると、現在は `Because repro depends on material_ui 1.3.0 which doesn't match any versions, version solving failed.` と拒否されます。ソルバーは、固定されているかすでにロックされている場合を除き、retract 済みバージョンを隠すためです。

## retract してもプロジェクトが直らない理由

1.3.0 が公開されている間に `pub get` を実行していた場合、`pubspec.lock` には `version: "1.3.0"` と書かれており、retract はロックファイルには影響しません。[pub のドキュメント](https://dart.dev/tools/pub/publishing#retract)には、ロックされた retract 済みバージョンは引き続き動作すると明記されています。この状態かどうかを最も手早く確認できるのは `flutter pub outdated` です。

```text
Package Name              Current             Upgradable          Resolvable          Latest

direct dependencies:
material_ui               *1.3.0 (retracted)  *1.3.0 (retracted)  *1.3.0 (retracted)  1.5.0

transitive dependencies:
cupertino_ui              *1.1.0 (retracted)  *1.1.0 (retracted)  *1.1.0 (retracted)  1.1.1
...
material_ui
    Version 1.3.0 is retracted. See https://dart.dev/go/package-retraction
cupertino_ui
    Version 1.1.0 is retracted. See https://dart.dev/go/package-retraction
```

Upgradable 列と Resolvable 列を見てください。pub 自身が、移動させないと言っています。同じ pub のドキュメントは retract 済みバージョンから抜けるために `dart pub upgrade <package>` を勧めていますが、Flutter 3.44 では何も起きません。

```text
$ flutter pub upgrade material_ui cupertino_ui
  cupertino_ui 1.1.0 (retracted, 1.1.1 available)
  material_ui 1.3.0 (retracted, 1.5.0 available)
No dependencies changed.
```

原因はソルバーにあります。`lib/src/solver/version_solver.dart` の `_getAllowedRetracted` は、そのパッケージがアップグレードのためにアンロックされているかどうかに関係なく、`_lockFile.packages[package]?.version` を返します。そのため `upgrade` の間も、ロックされた retract 済みバージョンは有効な候補のままです。それより新しいリリース (1.4.0、1.5.0、1.1.1) はすべて Flutter 3.47 を必要とするので、3.44 でソルバーが選べる最高バージョンは、すでに持っている retract 済みのものになります。ドキュメントの助言が通用するのは、新しい*互換性のある*リリースが存在する場合だけで、3.44 にはそれがありません。

## 修正 1: Flutter 3.44 のまま material_ui 1.2.0 に戻す

ロックファイルから 1.3.0 と 1.1.0 の記述を消したい場合、最もきれいな方法はダウングレードしてからアップグレードすることです。アップグレードの実行前に、retract 済みバージョンがロックから外れます。

```bash
# Flutter 3.44.8: escape the retracted versions
flutter pub downgrade material_ui cupertino_ui
flutter pub upgrade
```

最初のコマンドは、両パッケージを制約が許す最も低いバージョンに移動します (`^1.0.0` なら `material_ui` 1.0.0 と `cupertino_ui` 0.0.2)。これにより `pubspec.lock` から retract 済みのエントリも消えます。2 番目のコマンドで、3.44 が受け付ける retract されていない最新バージョンまで戻ります。

```text
> cupertino_ui 1.0.2 (was 0.0.2) (1.1.1 available)
> material_ui 1.2.0 (was 1.0.0) (1.5.0 available)
```

その後は、3.44.8 での `flutter build web` が成功します。`pubspec.lock` から `material_ui` と `cupertino_ui` のエントリを手で削除して `flutter pub get` を実行しても同じ結果 (1.2.0 と 1.0.2) になります。ロックファイル全体を削除しても同じですが、その場合は依存グラフ内の他のパッケージもすべて再解決されます。`cupertino_ui` を省略しないでください。多くの場合これは推移的依存であり、`material_ui` だけを指定すると 1.1.0 がロックされたまま残り、壊れたままです。

新しい `pubspec.lock` をコミットしてください。CI で `flutter pub get --enforce-lockfile` を実行している場合は、コミット済みのロックファイルの内容どおりにインストールされるため、新しいロックファイルが反映されるまでビルドは失敗し続けます。

## 修正 2: パッケージが現在想定している Flutter 3.47 に移行する

`material_ui` 1.4.0 以降は Flutter 3.47 を必要とし、新しい修正もそこにしか入りません。アップグレードできるなら、これが長期的な答えです。

```bash
# Flutter 3.47.6 / Dart 3.13.5
flutter upgrade
flutter pub upgrade
```

3.47.6 では、新しい互換バージョンが存在するため、アップグレードは pub のドキュメントが説明するとおりに動作します。

```text
> cupertino_ui 1.1.1 (was 1.1.0)
> material_ui 1.5.0 (was 1.3.0)
```

厳密には、パッケージのアップグレードすら必要ありません。retract 済みの 1.3.0 でも Flutter 3.47.6 ではコンパイルできます。`foundation.dart` がアノテーションを再エクスポートするようになったためです。それでも `flutter pub upgrade` の実行をお勧めします。ロックファイルが retract 済みリリースを指したままだと、`flutter pub outdated` が警告し続けるからです。


3.47 への移行は、パッケージのバージョンを上げるだけよりも大きな変更です。Dart 3.13 が付いてきて (とりわけ、[通常のパラメーターへの `final` を拒否します](/ja/2026/09/fix-dart-3-13-cant-have-modifier-final-here-on-parameters/))、デスクトップでは Impeller がデフォルトのレンダラーになります。そのため、緊急の修正ではなく計画的なアップグレードとして扱ってください。

## 修正 3: pubspec.yaml に制約を残して 3.44 での再発を防ぐ

しばらく 3.44 に留まるなら、パッケージに明示的に上限を設けてください。判断が記録として残り、別のリリースが誤った `environment` で公開されても、チームメンバーの `pub upgrade` で意図せず移動するのを防げます。

```yaml
# pubspec.yaml, Flutter 3.44.x
dependencies:
  material_ui: ">=1.0.0 <1.3.0"
  cupertino_ui: ">=1.0.0 <1.1.0"
```

`cupertino_ui` はインポートしていなくても追加してください。`material_ui` だけに上限を付け、壊れたロックファイルに対して `flutter pub get` を実行したところ、pub は `material_ui` を 1.2.0 に移動しましたが、推移的な `cupertino_ui` は retract 済みの 1.1.0 のまま残しました。変更を強制するものが何もなかったためです。両方に上限を付けた状態で同じ `flutter pub get` を実行すると、1.2.0 と 1.0.2 に移動しました。

## 修正のように見えて効果がないもの

- **`meta` を上げる。** `meta` 1.18.0 はすでに `awaitNotRequired` を宣言しており、Flutter 3.44 フレームワークは自身の `pubspec.yaml` で `meta` をちょうど 1.18.0 に固定しているため、そもそも上げられません。問題は `meta` のバージョンではなく、`foundation.dart` の `show` リストです。
- **独自の `awaitNotRequired` を宣言する。** 名前解決は `material_ui` のライブラリの内部で行われます。アプリ側のトップレベル定数は、それらのスコープにはありません。
- **`flutter clean` や pub キャッシュの削除。** 問題のバージョンを選んでいるのは古いビルド出力ではなくロックファイルなので、次の `pub get` で再びダウンロードされます。
- **`dependencies` で `material_ui: 1.3.0` を固定する。** retract 済みバージョンは、この方法ではそもそも選択できません。強制できるのは `dependency_overrides` だけで、それはバグを再現するだけです。

スタンドアロンパッケージへの移行後に、別の Flutter 識別子で `Undefined name` が出る場合、原因は通常、方向が逆なだけの同じパターンです。つまり、インストールされているものより新しいフレームワークに対してコンパイルされたコードです。`flutter --version` と、エラーパスに出ているパッケージの `environment` ブロックを見れば、どちらが先行しているかがすぐにわかります。

## 関連記事

- Material と Cupertino が SDK から分離された背景は、[Flutter 3.44 が Material と Cupertino をパッケージに分割](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)で解説しています。
- インポート移行の全体像 (`dart fix --code=migrate_design_widgets` や互換ブリッジを含む) は、[material_ui と cupertino_ui パッケージへの移行](/ja/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)を参照してください。
- 2 つの Material 世界の間で起きる、もう 1 つの型レベルの不一致は、[material_ui での google_fonts の TextTheme エラー](/ja/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/)で扱っています。
- 壊れたものに解決されるのではなく、pub がそもそも解決を拒否する場合は、まず [pubspec.yaml の "version solving failed" の修正](/ja/2026/05/fix-version-solving-failed-in-pubspec-yaml/)から始めてください。
- 3.47 に移行する前に、[Flutter 3.47 でデスクトップのデフォルトレンダラーになる Impeller](/ja/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/)についても読んでおいてください。

## 参考資料

- [flutter/flutter#192839: material_ui 1.3.0 & cupertino_ui 1.1.0 on Flutter 3.44 Error: Undefined name 'awaitNotRequired'](https://github.com/flutter/flutter/issues/192839)
- [flutter/flutter#181513: Add @awaitNotRequired annotation to flutter sdk](https://github.com/flutter/flutter/pull/181513)
- [flutter/packages#12622: Add awaitNotRequired annotation to material_ui](https://github.com/flutter/packages/pull/12622) と、未マージの revert [#12942](https://github.com/flutter/packages/pull/12942)
- [material_ui changelog](https://pub.dev/packages/material_ui/changelog) と [cupertino_ui changelog](https://pub.dev/packages/cupertino_ui/changelog)
- [Retract a package version](https://dart.dev/tools/pub/publishing#retract)、Dart ドキュメント
- [dart-lang/pub の `version_solver.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/solver/version_solver.dart)
- [package:meta の `awaitNotRequired` API ドキュメント](https://pub.dev/documentation/meta/latest/meta/awaitNotRequired-constant.html)
