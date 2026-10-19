---
title: "Flutter で ThemeExtension を使ってカスタムデザイントークンを定義し、ライトテーマとダークテーマの間でアニメーションさせる方法"
description: "ThemeExtension をサブクラス化し、extensions リストで ThemeData ごとに 1 つのインスタンスを登録し、Theme.of(context).extension<T>() で読み取ります。さらに本物の lerp を書いて、ライトとダークの切り替え中に MaterialApp の AnimatedTheme がトークンを補間できるようにします。色、角丸、シャドウ、テキストスタイル、真偽値の扱い、拡張が見つからないときのクラッシュ、他のすべての拡張を消してしまう copyWith の落とし穴、== と hashCode が必要な理由まで、すべて Flutter 3.44.8 のウィジェットテストで検証しています。"
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "theming"
  - "material-3"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-19
---

**結論:** `ThemeExtension<AppTokens>` を継承する `@immutable` なクラスを作り、デザインシステムに必要なフィールド(色、角丸、スペーシング、シャドウ、テキストスタイル)を持たせて、`copyWith` と `lerp` を実装します。`theme` 用と `darkTheme` 用に、それぞれ `ThemeData(extensions: [...])` へ 1 つずつインスタンスを渡せば、どこからでも `Theme.of(context).extension<AppTokens>()!` で読み取れます。`MaterialApp` はすでにアプリ全体を `AnimatedTheme` で包んでおり、テーマの変更中は毎フレーム `ThemeData.lerp` を呼び出し、その中であなたの `lerp` が呼ばれます。`lerp` が各フィールドを `Color.lerp`、`lerpDouble`、`BorderRadius.lerp` などで補間していれば、カスタムトークンは組み込みの `ColorScheme` とまったく同じ 200 ms でライトとダークの間をクロスフェードします。以下の内容はすべて Flutter 3.44.8 (Dart 3.12.2) のウィジェットテストで検証しました。

この記事では、`ThemeData` の内部で `ThemeExtension` が実際に何をしているか、7 種類のフィールド型を持つ完全なトークンクラス、`MaterialApp` での配線、アニメーションの制御方法、そしてテストで遭遇した 4 つの落とし穴を扱います。落とし穴は、片方のテーマにしか存在しない拡張、他の拡張を黙って消してしまう `copyWith`、リビルドのたびに再開するアニメーション、ちょうど中間点で切り替わる真偽値です。

## ColorScheme だけではデザイントークンに足りない理由

Material 3 の `ColorScheme` には約 45 のロールがあり、ブランドカラーを `ColorScheme.fromSeed` で設定すれば、まとまりのあるパレットが無料で手に入ります([Material 3 の ColorScheme でアクセントカラーを設定する方法](/ja/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)を参照してください)。しかし実際のデザインシステムには、Material が想定していないトークンがあります。`tertiary` ではない "success" の緑、`surfaceContainerHigh` とは数パーセントだけ異なる浮き上がったカードの表面色、コードブロックのテキストスタイル、カードの角丸、ライトモードには存在してダークモードでは消えるシャドウなどです。

よくある回避策はどれも良くありません。静的定数を持つグローバルな `AppColors` クラスは、明るさに応じて変化できません。`context.isDark ? x : y` という三項演算子をウィジェットのあちこちに散らすと、テーマが変わったときにそこだけ瞬時に切り替わり、アプリの他の部分がアニメーションしているのと食い違って壊れて見えます。独自の `InheritedWidget` は動きますが、`ThemeData` がすでに持っているアニメーションの仕組みを作り直すことになります。

`ThemeExtension` は、まさにこの問題を解決するために Flutter 3.0 (PR #98033) で追加されました。独自の型付きオブジェクトを `ThemeData` にぶら下げることができ、`ThemeData.lerp` がそれらを認識しているため、テーマのアニメーションに参加します。

## ThemeData は拡張をどう扱うか

仕組み全体は、一度に読める程度に小さなものです。Flutter 3.44.8 の `packages/flutter/lib/src/material/theme_data.dart` から引用します。

```dart
// Flutter 3.44.8, theme_data.dart (abridged)
abstract class ThemeExtension<T extends ThemeExtension<T>> {
  const ThemeExtension();

  Object get type => T;

  ThemeExtension<T> copyWith();

  ThemeExtension<T> lerp(covariant ThemeExtension<T>? other, double t);
}

// On ThemeData:
final Map<Object, ThemeExtension<dynamic>> extensions;

T? extension<T>() => extensions[T] as T?;
```

ここから 3 つのことが分かります。

1. 拡張は `type`(ジェネリック引数 `T`)をキーとする `Map` に保存されます。1 つの型につき拡張は最大 1 つで、検索はマップの読み取りです。
2. `extension<T>()` は `T?` を返します。現在のテーマに `T` のエントリがなければ、例外ではなく `null` が返ります。
3. `lerp` はあなたの責任です。フレームワークはあなたのフィールドを一切検査しません。

そして、`ThemeData.lerp` が 2 つのマップをどう結合するかは次のとおりです。

```dart
// Flutter 3.44.8, ThemeData._lerpThemeExtensions
final Map<Object, ThemeExtension<dynamic>> newExtensions = a.extensions.map((
  Object id,
  ThemeExtension<dynamic> extensionA,
) {
  final ThemeExtension<dynamic>? extensionB = b.extensions[id];
  return MapEntry<Object, ThemeExtension<dynamic>>(id, extensionA.lerp(extensionB, t));
});
// Add [b]-only extensions.
newExtensions.addEntries(
  b.extensions.entries.where(
    (MapEntry<Object, ThemeExtension<dynamic>> entry) => !a.extensions.containsKey(entry.key),
  ),
);
```

"from" 側のテーマにあるすべての拡張に対して `lerp(matching, t)` が呼ばれ、`matching` は `null` の場合があります。"to" 側にしか存在しない拡張は、補間されずにそのままコピーされます。この点は落とし穴の節で重要になるので覚えておいてください。

## ステップごとの手順: アニメーションするトークンセットを作る

1. null 非許容のフィールドだけを持つ、`ThemeExtension<AppTokens>` の `@immutable` なサブクラスを定義します。
2. 呼び出し側が個々のトークンを上書きできるように `copyWith` を実装します。
3. すべてのフィールド型に対応する `lerp` ヘルパーを使って `lerp` を実装します。
4. 等しいトークンセットが等しいと比較されるように、`==` と `hashCode` をオーバーライドします。
5. `theme` にライト用インスタンス、`darkTheme` にダーク用インスタンスを登録します。
6. `BuildContext` の拡張ゲッター経由でトークンを読み取ります。

### ステップ 1 から 4: トークンクラス

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:ui' show lerpDouble;

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';

@immutable
class AppTokens extends ThemeExtension<AppTokens> {
  const AppTokens({
    required this.surfaceRaised,
    required this.success,
    required this.cardRadius,
    required this.cardElevationShadow,
    required this.gap,
    required this.codeStyle,
    required this.useHairlineBorders,
  });

  final Color surfaceRaised;
  final Color success;
  final BorderRadius cardRadius;
  final List<BoxShadow> cardElevationShadow;
  final double gap;
  final TextStyle codeStyle;
  final bool useHairlineBorders;

  static const light = AppTokens(
    surfaceRaised: Color(0xFFFFFFFF),
    success: Color(0xFF1B873F),
    cardRadius: BorderRadius.all(Radius.circular(12)),
    cardElevationShadow: [
      BoxShadow(color: Color(0x1F000000), blurRadius: 12, offset: Offset(0, 4)),
    ],
    gap: 16,
    codeStyle: TextStyle(fontFamily: 'monospace', fontSize: 13, color: Color(0xFF24292F)),
    useHairlineBorders: false,
  );

  static const dark = AppTokens(
    surfaceRaised: Color(0xFF1E2228),
    success: Color(0xFF4ADE80),
    cardRadius: BorderRadius.all(Radius.circular(12)),
    cardElevationShadow: [
      BoxShadow(color: Color(0x00000000), blurRadius: 0, offset: Offset.zero),
    ],
    gap: 16,
    codeStyle: TextStyle(fontFamily: 'monospace', fontSize: 13, color: Color(0xFFE6EDF3)),
    useHairlineBorders: true,
  );

  @override
  AppTokens copyWith({
    Color? surfaceRaised,
    Color? success,
    BorderRadius? cardRadius,
    List<BoxShadow>? cardElevationShadow,
    double? gap,
    TextStyle? codeStyle,
    bool? useHairlineBorders,
  }) {
    return AppTokens(
      surfaceRaised: surfaceRaised ?? this.surfaceRaised,
      success: success ?? this.success,
      cardRadius: cardRadius ?? this.cardRadius,
      cardElevationShadow: cardElevationShadow ?? this.cardElevationShadow,
      gap: gap ?? this.gap,
      codeStyle: codeStyle ?? this.codeStyle,
      useHairlineBorders: useHairlineBorders ?? this.useHairlineBorders,
    );
  }

  @override
  AppTokens lerp(AppTokens? other, double t) {
    if (other is! AppTokens) return this;
    return AppTokens(
      surfaceRaised: Color.lerp(surfaceRaised, other.surfaceRaised, t)!,
      success: Color.lerp(success, other.success, t)!,
      cardRadius: BorderRadius.lerp(cardRadius, other.cardRadius, t)!,
      cardElevationShadow:
          BoxShadow.lerpList(cardElevationShadow, other.cardElevationShadow, t)!,
      gap: lerpDouble(gap, other.gap, t)!,
      codeStyle: TextStyle.lerp(codeStyle, other.codeStyle, t)!,
      useHairlineBorders: t < 0.5 ? useHairlineBorders : other.useHairlineBorders,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AppTokens &&
          other.surfaceRaised == surfaceRaised &&
          other.success == success &&
          other.cardRadius == cardRadius &&
          listEquals(other.cardElevationShadow, cardElevationShadow) &&
          other.gap == gap &&
          other.codeStyle == codeStyle &&
          other.useHairlineBorders == useHairlineBorders;

  @override
  int get hashCode => Object.hash(
        surfaceRaised,
        success,
        cardRadius,
        Object.hashAll(cardElevationShadow),
        gap,
        codeStyle,
        useHairlineBorders,
      );
}
```

ここにはいくつか意図的な選択があります。

- **null 非許容のフィールド。** Flutter リポジトリの公式サンプル(`examples/api/lib/material/theme/theme_extension.1.dart`)は `Color?` を使っています。コンパイルは通りますが、すべての呼び出し箇所で `!` やフォールバックが必要になり、`Color.lerp(null, x, t)` は透明からフェードするため、望む結果になることはまずありません。デザインシステムの中で常に存在するトークンなら、required にしてください。
- **`lerp` の引数の型は `ThemeExtension<AppTokens>?` ではなく `AppTokens?` です。** 基底クラスのシグネチャは引数を `covariant` としているので、型を狭められます。`other is! AppTokens` で `null` の場合もカバーできます。
- **すべてのフィールド型に対応する静的な `lerp` があります。** `Color.lerp`、`lerpDouble`、`BorderRadius.lerp`、`EdgeInsets.lerp`、`TextStyle.lerp`、`BoxShadow.lerpList`、`Gradient.lerp`、`Offset.lerp`、`Size.lerp` がすべて存在します。これらは null 許容の入力を受け付けるため null 許容型を返します。両方の入力が null 非許容の場合に `!` を付けているのはそのためです。
- **離散値は中間点で切り替わります。** `true` と `false` の中間には意味のある値がありません。`ThemeData` 自身も `platform` や `useMaterial3` などで `t < 0.5 ? a : b` というパターンを使っているので、それに倣っています。
- **"消える" シャドウは空のリストではなく、透明なシャドウです。** `BoxShadow.lerpList` は長さの異なるリストも補間できますが、ジオメトリが同じでアルファが 0 のシャドウを使うと、きれいにフェードします。私のテストでは、中間点でのシャドウのアルファは `0.0608` で、ライトの値 `0x1F` (`0.1216`) のほぼ半分でした。まさに望んでいるクロスフェードです。

### ステップ 5: 両方のインスタンスを登録する

```dart
// Flutter 3.44.8
MaterialApp(
  theme: ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal),
    extensions: const <ThemeExtension<dynamic>>[AppTokens.light],
  ),
  darkTheme: ThemeData(
    colorScheme: ColorScheme.fromSeed(
      seedColor: Colors.teal,
      brightness: Brightness.dark,
    ),
    extensions: const <ThemeExtension<dynamic>>[AppTokens.dark],
  ),
  themeMode: themeMode, // ThemeMode.system, .light or .dark
  home: const HomePage(),
);
```

アニメーションのために必要な配線はこれだけです。`_MaterialAppState._materialBuilder` が `themeMode` とプラットフォームの明るさに基づいて `theme` か `darkTheme` を選び、サブツリーを `AnimatedTheme(data: theme, duration: ..., curve: ...)` で包みます。選択された `ThemeData` が変わると、`AnimatedTheme` は `ThemeDataTween` を実行し、その `lerp` は文字どおり `ThemeData.lerp(begin!, end!, t)` です。これで、あなたのトークンもそのトゥイーンの一部になります。

これは、あなたのコードが `themeMode` を切り替える場合にも、`themeMode` が `ThemeMode.system` のときにユーザーが OS のダークモードを切り替える場合にも機能します。

### ステップ 6: 手間をかけずにトークンを読み取る

`Theme.of(context).extension<AppTokens>()!` は長すぎます。`BuildContext` の拡張を使うと、呼び出し側がデザインシステムのコードらしく読めるようになります。

```dart
// Flutter 3.44.8
extension AppTokensContext on BuildContext {
  AppTokens get tokens => Theme.of(this).extension<AppTokens>()!;
}

class TokenCard extends StatelessWidget {
  const TokenCard({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Container(
      padding: EdgeInsets.all(tokens.gap),
      decoration: BoxDecoration(
        color: tokens.surfaceRaised,
        borderRadius: tokens.cardRadius,
        boxShadow: tokens.cardElevationShadow,
        border: tokens.useHairlineBorders
            ? Border.all(color: Theme.of(context).colorScheme.outlineVariant, width: 0.5)
            : null,
      ),
      child: DefaultTextStyle.merge(style: tokens.codeStyle, child: child),
    );
  }
}
```

`Theme.of` は継承されたテーマへの依存関係を登録するため、`TokenCard` はテーマアニメーションの毎フレームでリビルドされ、補間された値を参照します。なお、`Container` に `color` と `decoration` を同時に渡すと例外が発生するため、色を `BoxDecoration` の中に入れています(詳しくは["Cannot provide both a color and a decoration" の修正](/ja/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)を参照してください)。

## トークンが実際にアニメーションしていることを確認する

200 ms の動きを目視で確認するのは当てになりません。アニメーションの中間地点までポンプするウィジェットテストなら確実です。

```dart
// Flutter 3.44.8, flutter_test
AppTokens? seen;

class Probe extends StatelessWidget {
  const Probe({super.key});
  @override
  Widget build(BuildContext context) {
    seen = Theme.of(context).extension<AppTokens>();
    return const SizedBox();
  }
}

Widget app(ThemeMode mode) => MaterialApp(
      theme: ThemeData(extensions: const [AppTokens.light]),
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        extensions: const [AppTokens.dark],
      ),
      themeMode: mode,
      home: const Probe(),
    );

testWidgets('tokens interpolate during a theme switch', (tester) async {
  await tester.pumpWidget(app(ThemeMode.light));
  expect(seen!.surfaceRaised, AppTokens.light.surfaceRaised);

  await tester.pumpWidget(app(ThemeMode.dark));
  await tester.pump(const Duration(milliseconds: 100)); // halfway of 200 ms
  expect(seen!.surfaceRaised, isNot(AppTokens.light.surfaceRaised));
  expect(seen!.surfaceRaised, isNot(AppTokens.dark.surfaceRaised));

  await tester.pumpAndSettle();
  expect(seen!.surfaceRaised, AppTokens.dark.surfaceRaised);
});
```

100 ms の時点での表面色は `Color(red: 0.5588, green: 0.5667, blue: 0.5784)` で、白と `#1E2228` のほぼ正確な中間でした。デフォルトのカーブは `Curves.linear` なので、`t` は経過時間を継続時間で割った値と等しくなります。

## 継続時間とカーブを制御する

`MaterialApp` は、アニメーションを 2 つの古いパラメーターと 1 つの新しいパラメーターで公開しています。

```dart
// Flutter 3.44.8
MaterialApp(
  // Older API, still supported:
  themeAnimationDuration: const Duration(milliseconds: 350),
  themeAnimationCurve: Curves.easeInOut,

  // Newer API, takes precedence when non-null:
  themeAnimationStyle: AnimationStyle(
    duration: const Duration(milliseconds: 350),
    curve: Curves.easeInOutCubic,
  ),
  // ...
);
```

デフォルトは `kThemeAnimationDuration` で、200 ms です。`themeAnimationStyle: AnimationStyle.noAnimation` を渡すと、`AnimatedTheme` が単純な `Theme` に置き換わり、切り替えは瞬時に行われます。このモードでは、切り替え後の最初のフレームですでにダークの `surfaceRaised` が報告されることを確認しました。ゴールデンテストや、"視差効果を減らす"を有効にしているユーザー(`MediaQuery.disableAnimationsOf(context)` で取得できます)には、この設定が適切です。

## テストで見つかった落とし穴

### 片方のテーマに拡張がないと、アニメーションの最後でクラッシュする

`theme` には `AppTokens.light` を登録したのに、`darkTheme` では忘れたとします。アニメーション中、`_lerpThemeExtensions` は `AppTokens.light.lerp(null, t)` を呼び、これは `this` を返すので、ウィジェットはライトのトークンを見続けます。私のテストでは、中間フレームで `AppTokens` のインスタンスが返りました。その後トゥイーンが `t == 1.0` に達すると、`Tween.transform` は `end` を直接返し、その `end` には `AppTokens` がまったくありません。`extension<AppTokens>()` は `null` を返し、`context.tokens` は最後のフレームで null チェックエラーを投げます。

その結果、テーマを切り替えた後にだけ起きるクラッシュになり、最も見逃しやすい種類の不具合です。対処は構造的なものです。拡張リストが常に存在するように、両方のテーマを 1 つの関数から作ります。

```dart
// Flutter 3.44.8
ThemeData buildTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  return ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: Colors.teal, brightness: brightness),
    extensions: <ThemeExtension<dynamic>>[
      isDark ? AppTokens.dark : AppTokens.light,
    ],
  );
}
```

### ThemeData.copyWith(extensions: ...) はマップ全体を置き換える

これは、1 つのサブツリーに対して単一のトークンを上書きするときに問題になります。`ThemeData.copyWith` のソースは次のとおりです。

```dart
extensions: (extensions != null) ? _themeExtensionIterableToMap(extensions) : this.extensions,
```

マージは行われません。私のテストでは、`AppTokens` と `BrandTokens` を持つテーマに `copyWith(extensions: [BrandTokens(...)])` を通すと、`extension<AppTokens>()` が `null` を返しました。1 つの拡張を上書きして残りを保持するには、先に既存の値をスプレッドします。マップは `type` をキーとする `for` ループで構築されるため、後ろのエントリが優先されます。

```dart
// Flutter 3.44.8
final theme = Theme.of(context);
return Theme(
  data: theme.copyWith(
    extensions: [
      ...theme.extensions.values,
      context.tokens.copyWith(gap: 8), // overrides AppTokens only
    ],
  ),
  child: const CompactSection(),
);
```

ここではリストリテラルに型を付けないでください。`<ThemeExtension<dynamic>>[...]` と書くと、Dart 3.12.2 では "Can't assign spread elements of type 'ThemeExtension<dynamic>' to collection elements of type 'ThemeExtension<ThemeExtension<dynamic>>'" というエラーでコンパイルに失敗します。これは自己参照的な `T extends ThemeExtension<T>` という境界による癖です。要素型を推論に任せればコンパイルが通り、正しく動作します。私のテストでは、サブツリーは `gap: 8.0` と、手を加えていない `BrandTokens` 拡張を参照していました。

通常の `Theme` ウィジェットはアニメーションしません。上書き自体を遷移させたい場合(たとえば、ホバーで色が変わる "danger zone" セクション)は、`AnimatedTheme` を直接使ってください。

### == と hashCode がないと、リビルドのたびにテーマアニメーションが再開する

`ThemeData.==` は `extensions` を `mapEquals` で比較し、それが各拡張の `==` を呼びます。クラスが `==` をオーバーライドしていなければ、同じ値を持つ 2 つのインスタンスは等しくなりません。これは、`const` インスタンスを使わず実行時にトークンを作る場合、たとえばユーザーが選んだアクセントカラーから作る場合や、`build` の中で `AppTokens.light.copyWith()` を呼ぶ場合に問題になります。

最初のアニメーションが落ち着いた後、新しく作った同一内容の `copyWith()` インスタンスで `MaterialApp` をリビルドして試しました。`==` がないと `tester.hasRunningAnimations` は `true` になりました。`AnimatedTheme` が "新しい" テーマを検出して別の 200 ms のトゥイーンを開始し、見た目の変化がないまま、テーマに依存するすべてのウィジェットを 12 フレームにわたってリビルドしたのです。上に示した `==` と `hashCode` のオーバーライドを追加すると、同じテストは `false` を報告しました。手で書きたくない場合は、`theme_extensions_builder` のようなパッケージを使うと、アノテーションから `copyWith`、`lerp`、`==`、`hashCode` が生成されます。

### 真偽値と enum はちょうど t = 0.5 で切り替わる

`t < 0.5` のパターンでは、100 ms のフレームで `t` がちょうど `0.5` だったため、`useHairlineBorders` はすでに `true` になっていました。これは `ThemeData` が自身の離散フィールドを補間する方法と一貫していますが、色のフェードの途中で枠線が突然現れる可能性があることを意味します。それが不自然に見える場合は、見た目を連続的なトークンで表現してください。真偽値を、透明から `outlineVariant` へ変化する枠線の `Color` に置き換え、`Color.lerp` に任せます。

### キーは実行時の型ではなく、ジェネリック引数

`type` が返すのは `runtimeType` ではなく、`ThemeExtension` に渡した型引数 `T` です。`class BrandAppTokens extends AppTokens` と書くと、そのインスタンスは `AppTokens` の下に保存され、基底のインスタンスを置き換えます。ホワイトラベル化では通常それが望ましい動作ですが、基底クラスとサブクラスを並べて登録することはできません。

## 他のテーマ機能と比べた ThemeExtension の位置づけ

Material のコンポーネントが参照するものには、まず `ColorScheme` を使ってください。ボタン、チップ、アプリバーがあなたの拡張を読むことは決してないからです。Material のウィジェットをアプリ全体で再スタイルしたい場合は、コンポーネントテーマ(`CardThemeData`、`FilledButtonThemeData`)を使います。Material に対応する枠がない、独自のウィジェットが必要とするすべてのものには、`ThemeExtension` を使います。`google_fonts` でフォントを読み込んでいる場合も、`TextTheme` は `ThemeData.textTheme` に置き、標準ではないスタイル(コードブロックや数値表示など)だけを拡張に入れてください。そこで時々発生する型の不一致については、[google_fonts の TextTheme に関する修正](/ja/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/)で扱っています。

"最も近い継承ウィジェットから環境の値を取得する" という同じモデルが `IconTheme` を動かしており、設定していない色をアイコンが拾う理由もそれで説明できます。詳しくは[ImageIcon が IconTheme の色で着色されるのを止める方法](/ja/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/)を参照してください。また、テーマ切り替えボタンが太陽アイコンと月アイコンを入れ替える場合は、[その入れ替えをアニメーションさせるには AnimatedSwitcher にキーが必要です](/ja/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/)。

### 関連記事

- [Flutter アプリで Material 3 の ColorScheme を使ってアクセントカラーを設定する方法](/ja/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)
- [子ウィジェットの型が変わらなくても AnimatedSwitcher をアニメーションさせる方法](/ja/2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change/)
- [ImageIcon が環境の IconTheme の色でアイコンを着色するのを止める方法](/ja/2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter/)
- [Fix: The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?' with google_fonts](/ja/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/)

## 参考資料

- [`ThemeExtension` class, Flutter API docs](https://api.flutter.dev/flutter/material/ThemeExtension-class.html)
- [`ThemeData.extensions` property, Flutter API docs](https://api.flutter.dev/flutter/material/ThemeData/extensions.html)
- [`MaterialApp.themeAnimationStyle`, Flutter API docs](https://api.flutter.dev/flutter/material/MaterialApp/themeAnimationStyle.html)
- [`theme_data.dart` source on GitHub](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/src/material/theme_data.dart)
- [Official `ThemeExtension` sample, `theme_extension.1.dart`](https://github.com/flutter/flutter/blob/master/examples/api/lib/material/theme/theme_extension.1.dart)
- [Introduce Theme extensions (flutter/flutter#98033)](https://github.com/flutter/flutter/pull/98033)
