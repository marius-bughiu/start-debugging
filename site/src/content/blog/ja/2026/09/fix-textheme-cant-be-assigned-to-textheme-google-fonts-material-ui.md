---
title: "解決: google_fonts で The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?' が出る"
description: "アプリは material_ui を import していますが、google_fonts 8.2.1 はまだ SDK の TextTheme を返します。google_fonts の移行が済むまでは、GoogleFonts.roboto のティアオフを使って TextTheme を自分で組み立ててください。"
pubDate: 2026-09-11
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "material-design"
  - "google-fonts"
lang: "ja"
translationOf: "2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui"
translatedBy: "claude"
translationDate: 2026-09-11
---

1 つのプログラムの中に `TextTheme` という名前の別々のクラスが 2 つ存在しています。アプリは `package:material_ui/material_ui.dart` を import しているので、`ThemeData.textTheme` は `material_ui` 側の `TextTheme` を期待します。一方、最新リリースの `google_fonts` 8.2.1 はまだ `package:flutter/material.dart` を import しているため、`GoogleFonts.robotoTextTheme()` は SDK 側の `TextTheme` を返します。Dart はこの 2 つを無関係な型として扱います。今日使える修正はこうです。`...TextTheme()` ヘルパーを呼ぶのをやめ、`GoogleFonts.roboto` のティアオフでスタイルごとにフォントを適用します。これは `TextStyle` を返し、この型は両方のコピーで共有されています。これはコンパイル時エラーなので、`MaterialUiCompatibilityBridge` では解決できません。

以下の内容はすべて Flutter 3.44.8 (Dart 3.12.2)、`material_ui` 1.2.0、`cupertino_ui` 1.0.2、`google_fonts` 8.2.1 で再現し、2026-09-11 時点の `flutter/packages` main ブランチにある `google_fonts` のソースと照らし合わせて確認しています。不一致の原因は SDK ではなくパッケージにあるため、同じエラーは 3.47 の stable 系列と master でも再現します。

## アナライザーとコンパイラーが出力する内容

`flutter analyze` と IDE は短い形式を表示します。2 つの型名が同じなので、意味不明に見えます。

```text
error • The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?'.  • lib/main.dart:13:20 • argument_type_not_assignable
```

`flutter run`、`flutter build`、`flutter test` で動くフロントエンドコンパイラーのほうが親切です。2 つの型に番号を振り、それぞれがどこにあるかを示してくれます。

```text
lib/main.dart:13:47: Error: The argument type 'TextTheme/*1*/' can't be assigned to the parameter type 'TextTheme/*2*/?'.
 - 'TextTheme/*1*/' is from 'package:flutter/src/material/text_theme.dart' ('/opt/homebrew/share/flutter/packages/flutter/lib/src/material/text_theme.dart').
 - 'TextTheme/*2*/' is from 'package:material_ui/src/text_theme.dart' ('/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.2.0/lib/src/text_theme.dart').
        textTheme: GoogleFonts.robotoTextTheme(),
                                              ^
```

この 2 つ目のメッセージが診断そのものです。`package:flutter/src/material/...` と `package:material_ui/src/...` の名前が出ていれば、このページで合っています。別の 2 つのライブラリの名前が出ている場合は、最後の「似ているが別のバグ」のセクションに進んでください。

## TextTheme クラスが 2 つ存在する理由

Flutter 3.44 以降、Material と Cupertino は独立した `material_ui` パッケージと `cupertino_ui` パッケージとして提供されています。2026-08-12 に公開された `material_ui` 1.0.0 は、4 月に SDK 内で凍結された Material ライブラリのコピーです。再エクスポートではありません。`material_ui/lib/src/text_theme.dart` は独自の `class TextTheme` を宣言しており、`ThemeData`、`Theme`、`ColorScheme` も同様に独自に宣言しています。

Dart の型の同一性は、名前ではなく宣言しているライブラリで決まります。`package:flutter/src/material/text_theme.dart` の `TextTheme` と `package:material_ui/src/text_theme.dart` の `TextTheme` は同じフィールドと同じコードを持っていますが、どちらも他方のサブタイプではないため、互いに代入できません。

`google_fonts` 8.2.1 は `material_ui` が 1.0 に達する前の 2026-07-31 に公開されました。その `lib/src/google_fonts_all_parts.dart` には今も次の行があります。

```dart
// google_fonts 8.2.1, lib/src/google_fonts_all_parts.dart
import 'package:flutter/material.dart';
```

そして、生成された `...TextTheme` ヘルパーはすべてこの import の上に作られています。

```dart
// google_fonts 8.2.1, lib/src/google_fonts_parts/part_r.dart (trimmed)
static TextTheme robotoTextTheme([TextTheme? textTheme]) {
  textTheme ??= ThemeData.light().textTheme;
  return TextTheme(
    displayLarge: roboto(textStyle: textTheme.displayLarge),
    // ...14 more styles
  );
}
```

パラメーターの型も戻り値の型も SDK の `TextTheme` です。ファイルが `package:flutter/material.dart` の代わりに `material_ui` を import するようになると (これはまさに `dart fix --apply --code=migrate_design_widgets` が行う変更です)、`GoogleFonts.xxxTextTheme()` を呼んでいる箇所はすべてコンパイルできなくなります。この問題は [flutter/flutter#191067](https://github.com/flutter/flutter/issues/191067) で追跡されており、`material_ui` 1.0.0 のリリース翌日に起票されました。

## 最小の再現コード

```yaml
# pubspec.yaml, Flutter 3.44.8
dependencies:
  flutter:
    sdk: flutter
  google_fonts: ^8.2.1
  material_ui: ^1.2.0
```

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: ThemeData(
        textTheme: GoogleFonts.robotoTextTheme(), // error here
      ),
      home: const Scaffold(body: Center(child: Text('Hello'))),
    );
  }
}
```

import を `package:flutter/material.dart` に戻すとコンパイルが通ります。このエラーの報告の多くに「以前は動いていた」と書かれているのはこのためです。

## MaterialUiCompatibilityBridge が役に立たない理由

`material_ui` 0.0.3 で追加されたブリッジは、誰もが最初に試すものであり、#191067 でメンテナーが最初に提案したのもこれでした。しかしこのエラーは解決せず、原理的に解決できません。ブリッジはウィジェットです。レガシーの `Theme` と `Localizations` の InheritedWidget をツリーに挿入し、未移行のパッケージが実行時に `Theme.of(context)` を呼んだときに何かが見つかるようにします。対象になるのは、`BuildContext` から Material の状態を *読み取る* 依存関係です。

`google_fonts` はツリーから何も読み取りません。公開 API から SDK の Material 型を *返し*、その値は引数としてあなたのコードに流れ込みます。型チェッカーはウィジェットが 1 つも存在しない段階でそれを拒否します。[flutter/flutter#191448](https://github.com/flutter/flutter/issues/191448) はこの制約を一般的な形で文書化しており、ファーストパーティの例として `google_fonts` のケースを最初に挙げています。コンパイルできない以上、ウィジェットのラッパーは関係ありません。

## 修正 1: ティアオフでスタイルごとにフォントを適用する (推奨)

`TextStyle` は `package:flutter/painting.dart` で宣言されています。これは SDK の一部であり、Material の両方のコピーで共有されています。`GoogleFonts.roboto(...)` は `TextStyle` を返します。つまり置き換える必要があるのは、`...TextTheme` ヘルパーが代わりにやってくれている 15 行のループだけで、それは `material_ui` の `TextTheme` に対して書けます。

```dart
// lib/theme/google_text_theme.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

/// Applies a Google Font to every style of a material_ui [TextTheme].
///
/// Pass a tear-off such as `GoogleFonts.roboto`. Only [TextStyle] crosses
/// the package boundary, and TextStyle lives in package:flutter/painting.dart,
/// which both copies of Material share.
TextTheme withGoogleFont(
  TextTheme base,
  TextStyle Function({TextStyle? textStyle}) font,
) {
  TextStyle? apply(TextStyle? style) =>
      style == null ? null : font(textStyle: style);

  return base.copyWith(
    displayLarge: apply(base.displayLarge),
    displayMedium: apply(base.displayMedium),
    displaySmall: apply(base.displaySmall),
    headlineLarge: apply(base.headlineLarge),
    headlineMedium: apply(base.headlineMedium),
    headlineSmall: apply(base.headlineSmall),
    titleLarge: apply(base.titleLarge),
    titleMedium: apply(base.titleMedium),
    titleSmall: apply(base.titleSmall),
    bodyLarge: apply(base.bodyLarge),
    bodyMedium: apply(base.bodyMedium),
    bodySmall: apply(base.bodySmall),
    labelLarge: apply(base.labelLarge),
    labelMedium: apply(base.labelMedium),
    labelSmall: apply(base.labelSmall),
  );
}
```

呼び出し側を短く保つ秘訣は `font` パラメーターの型にあります。生成されたフォントメソッドはすべて `TextStyle Function({TextStyle? textStyle, Color? color, double? fontSize, ...})` というシグネチャを持っています。省略可能な名前付きパラメーターが多い関数型は、少ない関数型のサブタイプなので、`GoogleFonts.roboto`、`GoogleFonts.lato`、`GoogleFonts.pangolin` をそのまま渡せます。

あとは先にテーマを作り、そのテキストテーマを差し替えます。

```dart
// lib/main.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

import 'theme/google_text_theme.dart';

ThemeData buildTheme(Brightness brightness) {
  final base = ThemeData(
    brightness: brightness,
    colorSchemeSeed: Colors.indigo,
  );
  return base.copyWith(
    textTheme: withGoogleFont(base.textTheme, GoogleFonts.roboto),
  );
}

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: const Scaffold(body: Center(child: Text('Hello'))),
    );
  }
}
```

これで `flutter analyze` はクリーンになり、ウィジェットテストでも出力が以前の `GoogleFonts.robotoTextTheme()` と一致することを確認できます。すべてのスタイルに `fontFamily: 'Roboto_regular'` と `fontFamilyFallback: ['Roboto']` が付きます。これは `google_fonts` が読み込んだバリアントに付ける名前です。

このバージョンには、置き換え前の呼び出しより優れている点が 1 つあります。引数なしの `robotoTextTheme()` は `ThemeData.light().textTheme` から始まるため、`ThemeData.dark().textTheme` を渡さずに `darkTheme` で使い回すと、暗い背景に暗い文字が表示されていました。明るさごとに `base.textTheme` から派生させれば、構造上、色が正しくなります。上記のテストでは、ライトの `bodyMedium` はほぼ黒の `Color(0xFF1B1B21)` に、ダークの `bodyMedium` はほぼ白の `Color(0xFFE4E1E9)` に解決されます。

上流で移行が完了したら、このファイルを削除して `GoogleFonts.robotoTextTheme(base.textTheme)` に戻すだけで、テーマごとに 1 行の変更で済みます。

### フォントファミリー名が実行時にしか分からない場合

ユーザーが設定画面でフォントを選ぶ場合、おそらく `GoogleFonts.getTextTheme(name)` を呼んでいたはずで、これにも同じ問題があります。`TextStyle` を返す `getFont` をラップしてください。

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
TextTheme withGoogleFontNamed(TextTheme base, String family) =>
    withGoogleFont(
      base,
      ({TextStyle? textStyle}) =>
          GoogleFonts.getFont(family, textStyle: textStyle),
    );
```

これにはコストがあることを理解しておいてください。`getFont` はフォントファミリーを `GoogleFonts.asMap()` から探します。これは生成されたすべてのフォントメソッドを参照する const マップなので、コンパイラーは使われていないフォントをツリーシェイクできなくなります。修正 1 の直接のティアオフが参照するフォントは 1 つだけです。このサイズの差を狙っているのが [flutter/packages#11433](https://github.com/flutter/packages/pull/11433) の `google_fonts_lite.dart` エントリポイントで、2026-09-04 にマージされましたが、まだ公開されていません。`getFont` は実行時の名前が本当に必要な場合にだけ使ってください。

## 修正 2: 既存のレガシー TextTheme を境界で変換する

SDK の `TextTheme` が自分では制御できない場所から渡される場合 (たとえば今週は変更できない共有テーマパッケージなど)、フィールドごとに変換します。レガシーライブラリはプレフィックスと `show` 句を付けて import し、他の名前がファイルに漏れ込まないようにします。

```dart
// lib/theme/legacy_adapter.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
// Temporary: delete once google_fonts ships a material_ui release.
import 'package:flutter/material.dart' as legacy show TextTheme;
import 'package:material_ui/material_ui.dart';

extension LegacyTextThemeToMaterialUi on legacy.TextTheme {
  TextTheme toMaterialUi() => TextTheme(
        displayLarge: displayLarge,
        displayMedium: displayMedium,
        displaySmall: displaySmall,
        headlineLarge: headlineLarge,
        headlineMedium: headlineMedium,
        headlineSmall: headlineSmall,
        titleLarge: titleLarge,
        titleMedium: titleMedium,
        titleSmall: titleSmall,
        bodyLarge: bodyLarge,
        bodyMedium: bodyMedium,
        bodySmall: bodySmall,
        labelLarge: labelLarge,
        labelMedium: labelMedium,
        labelSmall: labelSmall,
      );
}
```

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
final theme = ThemeData(
  textTheme: GoogleFonts.pangolinTextTheme().toMaterialUi(),
);
```

各フィールドが `TextStyle` なので、これはコンパイルが通ります。`TextTheme` でうまくいくのは、このクラスが 15 個のスタイルを詰めただけの単純な入れ物だからです。一般化はできません。#191448 では、メソッドが他の Material 型を引数に取る `FloatingActionButtonLocation` のような型では、同じアダプターの手法が 1 段深いところで失敗することが示されています。また、この方法は前述のライト専用のデフォルトもそのまま引き継ぎ、移行で取り除くはずだった SDK の Material の import を再び持ち込みます。そのため、コメントを付けて 1 つのファイルにとどめ、修正 1 を優先してください。

## 修正 3: google_fonts の移行を待つ

`google_fonts` 自体を移行するプルリクエストが 2 つあります。8 月 17 日に起票され #191067 にリンクされた [flutter/packages#12489](https://github.com/flutter/packages/pull/12489) と、エコシステム全体の [flutter/flutter#191322](https://github.com/flutter/flutter/issues/191322) の一環として 9 月 9 日に起票された [flutter/packages#12810](https://github.com/flutter/packages/pull/12810) です。後者はパッケージの最小要件を Flutter 3.44 と Dart 3.12 に引き上げます。2026-09-11 時点では、どちらもマージされていません。どちらかがマージされれば、`...TextTheme` ヘルパーは `material_ui` の型を受け取って返すようになり、元の 1 行が再びコンパイルできるようになります。[google_fonts の changelog](https://pub.dev/packages/google_fonts/changelog) を注視してください。

出荷するアプリにはおすすめしない待ち方が 2 つあります。

- **テーマファイルだけ import を元に戻す。** これは動きません。そのファイルの `ThemeData` が SDK の `ThemeData` になり、`material_ui` の `MaterialApp` が 1 つ上の型で同じエラーを出して拒否します。アプリ全体をどちらか一方にそろえる必要があります。
- **未マージの PR ブランチを指す `dependency_overrides` の git 参照。** コンパイルは通りますし、#191067 のあるコメント投稿者がまさにそれを提案しています。しかし、フォークのレビューされていないコードを出荷することになります。それでも行う場合は、`ref:` をブランチではなくコミット SHA に固定してください。

何らかの理由で修正 1 を使えない場合、正直な代替案は、`google_fonts` がリリースされるまで `material_ui` への移行を延期することです。SDK 内の Material ライブラリは凍結されていますが、3.47 でもまだ動作します。

## 落とし穴: ウェイトはまだテーマに入っていない

`...TextTheme` ヘルパーが常にやっていたことで、修正 1 もそのまま引き継いでいる点があります。ビルド時点の `ThemeData.textTheme` が保持しているのは色とフォントファミリーだけです。サイズとウェイトは `Typography.englishLike` から来ており、後で `Theme.of` がテーマをローカライズするときにマージされます。そのため、`google_fonts` が `titleMedium` を見た時点ではウェイトが `null` で、regular のバリアントが選ばれ、スタイルには `fontFamily: 'Roboto_regular'` が付きます。実行時には `Theme.of(context).textTheme.titleMedium` が `Roboto_regular` と `FontWeight.w500` に解決されるので、エンジンはウェイト 400 のファイルからウェイト 500 のスタイルを描画することになります。

タイトルやラベルに本物の medium ファイルが必要なら、フォントを適用する前にジオメトリーをマージしてください。

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
final geometry = Typography.material2021().englishLike.merge(base.textTheme);
final textTheme = withGoogleFont(geometry, GoogleFonts.roboto);
// titleMedium -> fontFamily 'Roboto_500', fontWeight w500
```

どちらの結果もウィジェットテストで確認しました。トレードオフとして、英語向けのサイズが焼き込まれるため、中国語、日本語、韓国語で出荷する場合は、代わりにロケールごとにジオメトリー (`Typography.material2021().tall` または `.dense`) を選んでください。同じ理由で、`TextTheme.apply(fontFamily: GoogleFonts.roboto().fontFamily)` は罠です。ウェイトに関係なく、すべてのスタイルに `'Roboto_regular'` を設定してしまいます。

## 似ているが別のバグ

- **`The argument type 'TextTheme' can't be assigned to the parameter type 'CupertinoTextThemeData'`。** Material のテキストテーマを `CupertinoThemeData.textTheme` に渡しています。これらは設計上別のクラスで、2022 年に [material-foundation/flutter-packages#227](https://github.com/material-foundation/flutter-packages/issues/227) として報告されています。Cupertino 用の `...TextTheme` ヘルパーはありません。`CupertinoTextThemeData` を自分で組み立て、その `textStyle` や関連するパラメーターに `GoogleFonts.lato()` のスタイルオブジェクトを渡してください。
- **同じメッセージだが、コンパイラーが自分のファイルの名前を出している。** 自分のコードや生成されたデザイントークンのファイルにある `TextTheme` という名前のクラスが、Material のものを隠しています。番号付きのコンパイラー出力を見れば、どのファイルの名前を変えればよいかが分かります。
- **`ColorScheme` で同じメッセージが出る。** これは `DynamicColorBuilder` から SDK の `ColorScheme` を返していた `dynamic_color` の問題でした。すでに修正されています。メンテナーが [material-foundation/flutter-packages#698](https://github.com/material-foundation/flutter-packages/issues/698) で確認したとおり、`dynamic_color` 2.1.0 は `material_ui` に依存しています。
- **コンパイルは通るが、パッケージのウィジェットが "Could not find an ancestor of type Theme" でクラッシュする。** これは同じ分割の実行時側の問題で、`MaterialUiCompatibilityBridge` が実際に解決するケースです。

## 関連記事

- このエラーが生じる移行作業の全体像 (互換ブリッジが必要になる場面も含む) は、[Flutter の Material と Cupertino の import を material_ui と cupertino_ui に移行する](/ja/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) にまとめています。
- そもそもなぜ Material が SDK から切り離されたのかという背景は、[Flutter 3.44 で Material と Cupertino が SDK から分離される](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) を参照してください。
- モノレポ全体で import の書き換えを実行した場合は、[リポジトリ全体で dart fix を実行する](/ja/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) で、パッケージごとに範囲を絞ってレビューする方法を説明しています。
- 修正 1 で使った `ThemeData` を先に作る手法は色にも使えます。[Material 3 の ColorScheme でアクセントカラーを設定する](/ja/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) を参照してください。
- 依存関係ではなく自分のコードで祖先の検索に失敗している場合は、[Flutter の "No Material widget found" を修正する](/ja/2026/08/fix-no-material-widget-found-in-flutter/) を読んでください。

## ソース

- [flutter/flutter#191067](https://github.com/flutter/flutter/issues/191067)、material_ui の `TextTheme` と `google_fonts` の競合
- [flutter/flutter#191448](https://github.com/flutter/flutter/issues/191448)、`MaterialUiCompatibilityBridge` は API シグネチャの結合をカバーできない
- [flutter/flutter#191322](https://github.com/flutter/flutter/issues/191322)、ファーストパーティのパッケージを `material_ui` と `cupertino_ui` に移行する
- [flutter/packages#12489](https://github.com/flutter/packages/pull/12489) と [flutter/packages#12810](https://github.com/flutter/packages/pull/12810)、未マージの `google_fonts` 移行プルリクエスト
- [flutter/packages#11433](https://github.com/flutter/packages/pull/11433)、`google_fonts_lite.dart` エントリポイント
- [pub.dev の google_fonts](https://pub.dev/packages/google_fonts)、バージョン 8.2.1、およびその [ソース](https://github.com/flutter/packages/tree/main/packages/google_fonts)
- [pub.dev の material_ui](https://pub.dev/packages/material_ui)、バージョン 1.2.0、およびその [changelog](https://pub.dev/packages/material_ui/changelog)
- [argument_type_not_assignable](https://dart.dev/diagnostics/argument_type_not_assignable)、Dart の診断
