---
title: "Flutter のページ遷移ビルダー再編後にカスタムページ遷移を移行する (Flutter 3.44 から 3.47)"
description: "Flutter は PageTransitionsBuilder と 2 つの組み込みビルダーを widgets レイヤーへ、CupertinoPageTransitionsBuilder を Material から移動しました。実際に壊れるもの (import が 1 つだけで、エラーは紛らわしい 'Not a constant expression')、dart fix が行うことと material_ui プロジェクトで誤ること、そしてカスタムビルダーとルートを Material にまったく依存しない形に書き換える方法を解説します。"
pubDate: 2026-10-08
updatedDate: 2026-10-08
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "navigation"
  - "cupertino"
lang: "ja"
translationOf: "2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization"
translatedBy: "claude"
translationDate: 2026-10-08
---

ほとんどのアプリでは 5 分で終わる移行で、ソースを壊す変更は 1 つだけです。Flutter 3.44 以降、`CupertinoPageTransitionsBuilder` は Cupertino ライブラリに置かれているため、`package:flutter/material.dart` (または `package:material_ui/material_ui.dart`) だけを import してそのビルダーを `PageTransitionsTheme` に入れているファイルはコンパイルできなくなります。Cupertino の import を追加すれば完了です。再編のそれ以外の部分、つまり Flutter 3.38 と 3.41 で `PageTransitionsBuilder` 基底クラスと `FadeUpwardsPageTransitionsBuilder`、`OpenUpwardsPageTransitionsBuilder` を `package:flutter/widgets.dart` に移した変更は、互換性を壊しません。ただし、対応する価値があるのはこちらです。カスタムビルダーから Material への依存を完全に外せるようになり、スタンドアロンのデザインパッケージへ移行しても動き続けるようになります。以下の内容はすべて Flutter 3.44.8 と Dart 3.12.2 でコンパイルとテストを行い、現在の stable である Flutter 3.47.6 と [`material_ui`](https://pub.dev/packages/material_ui) 1.6.0、[`cupertino_ui`](https://pub.dev/packages/cupertino_ui) 1.1.2 でも確認しています。

## ビルダーが移動された理由

`PageTransitionsBuilder` はもともと Material のクラスでした。利用側が `PageTransitionsTheme` と `MaterialPageRoute` だけだったためです。しかしこれは Cupertino アプリや、`WidgetsApp` 上に独自のデザインシステムを構築しているチームにとっては不自然でした。遷移オブジェクトを再利用するだけで Material を import する必要があったからです。Flutter の [issue #172929](https://github.com/flutter/flutter/issues/172929) ("Move platform specific page transitions outside of Material and Cupertino") がこの切り離しを追跡しており、Material と Cupertino を別パッケージとして提供する大きな取り組みの一部になっています。

具体的な成果は次のとおりです。

- **カスタムビルダーに Material が不要になりました。** `PageTransitionsBuilder` のサブクラスは `package:flutter/widgets.dart` だけを import すれば、手書きの `PageRoute`、`WidgetsApp`、`CupertinoApp`、`PageTransitionsTheme` のいずれからでも使えます。
- **Cupertino アプリは Material を取り込まずに iOS 用ビルダーを使えます。** `CupertinoPageTransitionsBuilder` は `cupertino/route.dart` の `CupertinoPageRoute` の隣に置かれるようになりました。
- **ビルダーは `material_ui` への移行後も使えます。** 基底クラスは SDK から出ない widgets レイヤーにあるため、`widgets.dart` に対して書いたビルダーは、SDK 内の `PageTransitionsTheme` でも `material_ui` 内のものでも同じ型になります。

## 何が壊れるか

| 対象 | 変更内容 | stable への反映 | 影響度 |
| ---- | ------ | ---------------- | -------- |
| `PageTransitionsBuilder` | Material から `widgets.dart` へ移動 ([PR #174321](https://github.com/flutter/flutter/pull/174321)) | 3.38 | なし。Material が widgets を再エクスポート |
| `FadeUpwardsPageTransitionsBuilder` | `widgets.dart` へ移動 ([PR #175560](https://github.com/flutter/flutter/pull/175560)) | 3.41 | なし |
| `OpenUpwardsPageTransitionsBuilder` | `widgets.dart` へ移動 ([PR #177080](https://github.com/flutter/flutter/pull/177080)) | 3.41 | なし |
| `CupertinoPageTransitionsBuilder` | Material から `cupertino.dart` へ移動 ([PR #179776](https://github.com/flutter/flutter/pull/179776)) | 3.44 | Material のみを import するファイルでは高。import 1 行で解決 |
| `ZoomPageTransitionsBuilder`、`FadeForwardsPageTransitionsBuilder`、`PredictiveBackPageTransitionsBuilder`、`PageTransitionsTheme` | 変更なし。引き続き Material | 該当なし | なし |

最初の 3 行は、`material.dart` が `export 'package:flutter/widgets.dart'` を行っているため、Material アプリからは見えません。Material の import だけで `extends PageTransitionsBuilder` と書いたファイルは、その再エクスポート経由でクラスが解決され、以前とまったく同じに動きます。公式の[破壊的変更のページ](https://docs.flutter.dev/release/breaking-changes/decouple-page-transition-builders)が `FadeUpwardsPageTransitionsBuilder` と `OpenUpwardsPageTransitionsBuilder` を "Material" の下に挙げているのも同じ理由です。Material の import から見ると、そこが提供元に見えるからです。

## 事前チェックリスト

- 使用中の Flutter を確認します: `flutter --version`。この破壊的変更が起きるのは 3.44 以降です。3.47.x が現在の stable です。
- 何かを変更する前に、すべての参照を洗い出します。

  ```bash
  # Any Flutter version
  grep -rn "PageTransitionsBuilder\|PageTransitionsTheme" lib test packages
  ```

- プロジェクトが SDK ライブラリ (`package:flutter/material.dart`) とスタンドアロンパッケージ (`package:material_ui/material_ui.dart`) のどちらを使っているか確認します。修正の考え方は同じですが import の行が異なり、`dart fix` はそのうち片方で誤った結果を出します (手順 3 を参照)。
- パス依存や git 依存も確認します。Material の import だけで `CupertinoPageTransitionsBuilder` を参照しているパッケージがあると、同じ形でビルドが壊れますが、アプリ側からは直せません。

## 移行手順

1. **アップグレードして失敗を再現します。** 対象の SDK に更新し、アナライザーを実行します。コンパイラーよりもはるかに分かりやすいメッセージが出ます。

   ```bash
   # Flutter 3.44.8 or later
   flutter upgrade
   flutter analyze
   ```

   3.41 では問題なくコンパイルできた、典型的なアプリの次の `ThemeData` を例にします。

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 -- fails to compile
   import 'package:flutter/material.dart';

   final ThemeData theme = ThemeData(
     pageTransitionsTheme: const PageTransitionsTheme(
       builders: <TargetPlatform, PageTransitionsBuilder>{
         TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
         TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
         TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
       },
     ),
   );
   ```

   `flutter analyze` は本当の原因として `undefined_method` ("The method 'CupertinoPageTransitionsBuilder' isn't defined") を報告し、各エントリについて `invalid_constant` と `non_constant_map_value` のノイズも出します。確認: `CupertinoPageTransitionsBuilder` の使用箇所ごとに `undefined_method` が 1 つずつ出ており、他に新しいエラーがないことを確かめます。

2. **影響を受ける各ファイルに Cupertino の import を追加します。** SDK ライブラリの場合:

   ```dart
   // Flutter 3.44+, SDK libraries
   import 'package:flutter/cupertino.dart';
   import 'package:flutter/material.dart';
   ```

   スタンドアロンパッケージの場合:

   ```dart
   // Flutter 3.47.6, material_ui 1.6.0, cupertino_ui 1.1.2
   import 'package:cupertino_ui/cupertino_ui.dart';
   import 'package:material_ui/material_ui.dart';
   ```

   `material_ui` はすでに `cupertino_ui` に依存していますが、推移的依存を import すると `depend_on_referenced_packages` リントに引っかかるため、`flutter pub add cupertino_ui` で明示的に追加してください。確認: 対象ファイルで `flutter analyze` がエラーなしになります。

3. **または `dart fix` に任せ、結果を確認します。** 両方のライブラリに、この移動に対応するデータ駆動の修正 (`fix_material.yaml` の `replacedBy` エントリ) が含まれています。

   ```bash
   # Flutter 3.44+
   dart fix --dry-run
   dart fix --apply
   ```

   SDK ライブラリのプロジェクトでは `import 'package:flutter/cupertino.dart';` が挿入されるだけで、これは正しい結果です。`material_ui` 1.6.0 のプロジェクトでは、修正データが依然として `cupertino_ui` ではなく、凍結された SDK 側のコピーである `package:flutter/cupertino.dart` を指しています。SDK のビルダーが同じ widgets レイヤーの基底クラスを継承しているのでコードはコンパイルできますが、せっかく SDK のデザインライブラリから移行したプロジェクトに、その import を再び持ち込むことになります。この行は手作業で `cupertino_ui` の import に置き換えてください。確認: 移行済みプロジェクトで `grep -rn "package:flutter/cupertino.dart" lib` が何も返しません。

4. **カスタムビルダーの依存先を widgets レイヤーに変更します。** `SlideTransition`、`FadeTransition`、`ScaleTransition` とカーブを組み合わせるだけのビルダーなら、もう Material を import する理由はありません。

   ```dart
   // Flutter 3.44+, Dart 3.12 -- no Material import needed
   import 'package:flutter/widgets.dart';

   class FadeSlidePageTransitionsBuilder extends PageTransitionsBuilder {
     const FadeSlidePageTransitionsBuilder();

     @override
     Duration get transitionDuration => const Duration(milliseconds: 250);

     @override
     Widget buildTransitions<T>(
       PageRoute<T> route,
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
       Widget child,
     ) {
       final Animation<Offset> position = animation.drive(
         Tween<Offset>(begin: const Offset(0.0, 0.08), end: Offset.zero)
             .chain(CurveTween(curve: Curves.easeOutCubic)),
       );
       return FadeTransition(
         opacity: animation,
         child: SlideTransition(position: position, child: child),
       );
     }
   }
   ```

   `PageTransitionsTheme.builders` はまさにこの基底クラスで型付けされているため、同じクラスを変更なしで Material テーマにもそのまま入れられます。確認: ファイルの Flutter import が `widgets.dart` だけで、`flutter analyze` がエラーなしになります。

5. **`PageRouteBuilder` の定型コードを、ビルダーに委譲するルートに置き換えます。** 再編はこのパターンのために設計されました。ルートクラスは 1 つで、遷移は何でも使え、Material は不要です。

   ```dart
   // Flutter 3.44+, Dart 3.12
   import 'package:flutter/widgets.dart';

   class BuilderPageRoute<T> extends PageRoute<T> {
     BuilderPageRoute({
       required this.builder,
       this.transitionsBuilder = const FadeSlidePageTransitionsBuilder(),
       super.settings,
     });

     final WidgetBuilder builder;
     final PageTransitionsBuilder transitionsBuilder;

     @override
     Duration get transitionDuration => transitionsBuilder.transitionDuration;

     @override
     Duration get reverseTransitionDuration =>
         transitionsBuilder.reverseTransitionDuration;

     @override
     DelegatedTransitionBuilder? get delegatedTransition =>
         transitionsBuilder.delegatedTransition;

     @override
     Color? get barrierColor => null;

     @override
     String? get barrierLabel => null;

     @override
     bool get maintainState => true;

     @override
     Widget buildPage(
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
     ) => builder(context);

     @override
     Widget buildTransitions(
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
       Widget child,
     ) => transitionsBuilder.buildTransitions<T>(
       this,
       context,
       animation,
       secondaryAnimation,
       child,
     );
   }
   ```

   `transitionDuration`、`reverseTransitionDuration`、`delegatedTransition` を転送することが重要です。[公式サンプル](https://api.flutter.dev/flutter/widgets/PageTransitionsBuilder-class.html)は 300 ms を直接書いており、ビルダーが宣言する所要時間が黙って無視されます。また `delegatedTransition` がないと、このルートに渡した `CupertinoPageTransitionsBuilder` は、遷移してくるページはアニメーションするものの、前のページが左へスライドせず固まったままになります。確認は次のセクションのウィジェットテストで行います。

6. **使っているアプリウィジェットにルートを組み込みます。** `WidgetsApp` ベースのデザインシステムでは、`pageRouteBuilder` として渡します。

   ```dart
   // Flutter 3.44+
   WidgetsApp(
     color: const Color(0xFF0B57D0),
     pageRouteBuilder: <T>(RouteSettings settings, WidgetBuilder builder) =>
         BuilderPageRoute<T>(builder: builder, settings: settings),
     home: const HomeScreen(),
   );
   ```

   Material アプリでは、デフォルトには引き続き `PageTransitionsTheme` を使い、別の遷移が必要な画面でだけ `BuilderPageRoute` を push します。確認: push した画面への移動で新しいアニメーションが表示され、`flutter analyze` がエラーなしになります。

## 動作確認

250 ms のアニメーションを目視で判断してはいけません。ルートを途中まで進めて、遷移ウィジェットに対してアサートします。

```dart
// Flutter 3.44.8, flutter_test
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:my_app/transitions.dart';

void main() {
  testWidgets('BuilderPageRoute uses the builder duration', (tester) async {
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(WidgetsApp(
      navigatorKey: navigator,
      color: const Color(0xFF000000),
      pageRouteBuilder: <T>(RouteSettings s, WidgetBuilder b) =>
          BuilderPageRoute<T>(builder: b, settings: s),
      home: const Text('home', textDirection: TextDirection.ltr),
    ));

    navigator.currentState!.push(BuilderPageRoute<void>(
      builder: (_) => const Text('second', textDirection: TextDirection.ltr),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 125));

    final fade = tester.widget<FadeTransition>(find
        .ancestor(of: find.text('second'), matching: find.byType(FadeTransition))
        .first);
    expect(fade.opacity.value, 0.5);

    await tester.pumpAndSettle();
    expect(find.text('second'), findsOneWidget);
  });
}
```

Flutter 3.44.8 では、このテストは 125 ms の時点で opacity がちょうど `0.5` になって成功します。これは、ルートがビルダーの 250 ms という所要時間を取り込んでいることの証明です。誰かが再び 300 ms を直接書くと、値は約 `0.42` になりテストは失敗します。このほかに次の点も確認します。

- `flutter analyze` が `undefined_method` や `undefined_hidden_name` の診断を出さないこと。
- `flutter test` が成功すること。遷移途中のフレームを取得するゴールデンテストがあれば、それも含みます。
- iOS シミュレーターで、`CupertinoPageTransitionsBuilder` を使う画面の左端からスワイプして戻り、前のページがジェスチャーに合わせて動くことを確認すること。

## ロールバック計画

コードの変更は追加的なものです。import が 1 行増え、Material が不要になったクラスがいくつかあるだけです。そのどれも 3.41 でもコンパイルできます。ただし 3.41 では `CupertinoPageTransitionsBuilder` が Material の import 経由で解決されるため、追加した `cupertino.dart` の import は単に冗長になります。`flutter downgrade` や CI でのバージョン固定で SDK を戻す場合も、これらの変更を元に戻す必要はありません。3.38 より前に戻せない唯一のものは、`widgets.dart` だけを import するビルダーです。その時点では基底クラスがまだ存在しないためです。

## 注意点

**コンパイラーのエラーは別の問題を指しています。** ほぼすべての `PageTransitionsTheme` がそう書かれる `const` マップの内側では、フロントエンドは名前が未定義だとは言いません。`flutter build` と `flutter test` が出力するのは次だけです。

```text
lib/main.dart:14:33: Error: Not a constant expression.
            TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

そこで `const` を消すと、今度は "The method 'CupertinoPageTransitionsBuilder' isn't defined for the type 'App'" となり、メソッドを探し回ることになります。まず `flutter analyze` を実行してください。定数に関するノイズと並んで `undefined_method` の診断が表示されます。

**一部だけの `builders` マップはデフォルトとマージされません。** `builders:` を渡すとデフォルトのマップ全体が置き換えられ、指定のないプラットフォームは実行時に、iOS のみ `CupertinoPageTransitionsBuilder`、それ以外 (macOS を含む) はすべて `ZoomPageTransitionsBuilder` にフォールバックします。Android と iOS だけを列挙すると、macOS ではズーム遷移になります。このファイルを触るついでに、出荷するすべてのプラットフォームを列挙してください。

**1 つのファイルで SDK とパッケージの Cupertino import を混在させないでください。** `material_ui` プロジェクトで、`package:flutter/cupertino.dart` (`dart fix` が残したもの) と `package:cupertino_ui/cupertino_ui.dart` の両方を import するファイルでは、すべての Cupertino の名前で `ambiguous_import` エラーが出ます。どちらか一方だけにしてください。

**古い `hide` 句。** 同名のローカルクラスとの衝突を避けるために `import 'package:flutter/material.dart' hide CupertinoPageTransitionsBuilder;` と書いているコードベースがあります。3.44 以降では、その名前はもう Material の名前空間に存在せず、アナライザーが `undefined_hidden_name` を報告します。この句は削除してください。

**サードパーティのビルダーは引き続き動作します。** [`animations`](https://pub.dev/packages/animations) の `SharedAxisPageTransitionsBuilder` などのクラスは、自身の Material の import を通じて基底クラスを継承しており、これが widgets レイヤーの型を再エクスポートするため、テーマにそのまま入れられます。壊れるのは、自分自身が Material のみの import で `CupertinoPageTransitionsBuilder` を参照しているパッケージだけで、その場合に必要なのはアプリ側の変更ではなくパッケージのリリースです。

**Material のビルダーを継承する場合は引き続き Material が必要です。** `ZoomPageTransitionsBuilder`、`FadeForwardsPageTransitionsBuilder` と predictive back のビルダーは Material に残りました。所要時間を調整するためにこれらのいずれかを継承するカスタムビルダーは、Material (または `material_ui`) の import を保持します。

## 関連記事

- ここでの import の変更は、[Flutter の Material と Cupertino の import を material_ui と cupertino_ui パッケージへ移行する](/ja/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)で扱っている大きな移行の一部です。
- 分離の発端となったリリースについては、[Flutter 3.44 による Material と Cupertino のパッケージ分割](/ja/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)を参照してください。
- 同じ根本原因による 3.44 のもう 1 つのコンパイルエラー: [material_ui と cupertino_ui での "Undefined name 'awaitNotRequired'" の修正](/ja/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)。
- カスタム遷移の実態が共有要素であれば、[2 つの画面間の Hero アニメーション](/ja/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/)のほうが適しているかもしれません。
- go_router の `CustomTransitionPage` のように独自にページを構築するルーターについては、[go_router vs auto_route vs Navigator 2.0](/ja/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/)で比較しています。

## 参考資料

- [Page transition builders reorganization](https://docs.flutter.dev/release/breaking-changes/decouple-page-transition-builders), Flutter の破壊的変更。
- [`PageTransitionsBuilder` API リファレンス](https://api.flutter.dev/flutter/widgets/PageTransitionsBuilder-class.html)。
- [flutter/flutter#172929](https://github.com/flutter/flutter/issues/172929), 追跡用の issue。
- PR [#174321](https://github.com/flutter/flutter/pull/174321)、[#175560](https://github.com/flutter/flutter/pull/175560)、[#177080](https://github.com/flutter/flutter/pull/177080)、[#179776](https://github.com/flutter/flutter/pull/179776)。
- Dart ドキュメントの[データ駆動の修正](https://dart.dev/tools/fix)。
