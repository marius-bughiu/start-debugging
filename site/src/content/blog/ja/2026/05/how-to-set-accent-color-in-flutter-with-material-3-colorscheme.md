---
title: "Flutter アプリで Material 3 ColorScheme を使ってアクセントカラーを設定する方法"
description: "2026 年における Flutter での Material 3 アクセントカラー設定の正しい方法: ColorScheme.fromSeed、colorSchemeSeed のショートカット、7 種類の DynamicSchemeVariant、ダークモード、Android 12 以降での dynamic_color、ブランドカラーの調和。Flutter 3.27.1 と Dart 3.11 で検証済みです。"
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "material-3"
  - "theming"
  - "how-to"
lang: "ja"
translationOf: "2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme"
translatedBy: "claude"
translationDate: 2026-05-06
---

短い答え: Material 3 にはもう「アクセントカラー」という概念はありません。最も近い単一のつまみは、`ColorScheme.fromSeed` に渡すシードカラーです。最もシンプルなケースでは `ThemeData(colorSchemeSeed: Colors.deepPurple)` を使い、バリアント、コントラストレベル、ライトとダークの組み合わせを制御したいときには `ColorScheme.fromSeed(seedColor: ..., brightness: Brightness.light)` を使います。この 1 つのシードから、フレームワークは M3 のフルパレット (`primary`、`onPrimary`、`secondary`、`tertiary`、`surface`、`surfaceContainer` など) を導出します。Flutter 3.27.1、Dart 3.11 で検証しました。

このガイドでは、2026 年における正しいやり方、正しく見えるけれどダークモードや Android 12 以降で壊れるパターン、そして M3 の階調システムを保ちながら既存のブランドカラーを維持する方法を紹介します。

## Material 3 で「アクセントカラー」がなくなった理由

Material 2 には `primaryColor` と `accentColor` という、ほぼ独立した 2 つのつまみがありました。これらを設定すると `FloatingActionButton`、`Switch`、`TextField` のカーソルなどがどちらかを拾っていました。Material 3 ではこの語彙はなくなりました。仕様は両方を、単一のシードから計算される色ロールのシステムに置き換えています。

- `primary`、`onPrimary`、`primaryContainer`、`onPrimaryContainer`
- `secondary`、`onSecondary`、`secondaryContainer`、`onSecondaryContainer`
- `tertiary`、`onTertiary`、`tertiaryContainer`、`onTertiaryContainer`
- `surface`、`onSurface`、`surfaceContainerLowest` ... `surfaceContainerHighest`
- `error`、`onError`、およびそれらのバリアント
- `outline`、`outlineVariant`、`inverseSurface`、`inversePrimary`

M2 で「アクセント」だったものは、M3 ではほとんどの場合 `primary` に対応し、ハイライト用に使っていたなら `tertiary` に対応することもあります。Material 3 の[色ロールのドキュメント](https://m3.material.io/styles/color/roles)が、どのロールをどの面に使うかの正準的なソースです。

実際的な結果として、「`ThemeData.accentColor` を設定してください」と書かれた古い StackOverflow の回答を読むと、このプロパティはまだ一部の狭い経路ではコンパイル可能ですが、Material 3 のどのウィジェットも参照しません。何も変わらないのはなぜか、と午後を 1 つ潰すことになります。これは非推奨であり、M3 ウィジェットにとっては事実上の no-op です。

## 最小で正しいパターン

Material 3 は Flutter 3.16 以降ではデフォルトで有効です。`useMaterial3: true` を設定する必要はもうありません。新しいアプリのもっともシンプルで慣用的なアクセントカラー:

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Demo',
      theme: ThemeData(
        colorSchemeSeed: Colors.deepPurple,
        brightness: Brightness.light,
      ),
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.deepPurple,
        brightness: Brightness.dark,
      ),
      themeMode: ThemeMode.system,
      home: const Scaffold(),
    );
  }
}
```

`colorSchemeSeed` は `ThemeData` 内のショートカットで、次と等価です。

```dart
// What colorSchemeSeed expands to internally
ThemeData(
  colorScheme: ColorScheme.fromSeed(
    seedColor: Colors.deepPurple,
    brightness: Brightness.light,
  ),
);
```

シードと明るさだけで十分なら `colorSchemeSeed` を選びましょう。バリアント、コントラストレベル、または 1 つか 2 つの特定ロールを上書きする必要がある場合は `ColorScheme.fromSeed` を直接使ってください。

## DynamicSchemeVariant の選び方

Flutter 3.22 以降、`ColorScheme.fromSeed` コンストラクターは `dynamicSchemeVariant` パラメーターを受け取ります。これは Material Color Utilities のどのアルゴリズムでパレットを導出するかを選びます。シードの可視性をどれだけ強く保つかの順に並べると、選択肢は次のとおりです。

- `DynamicSchemeVariant.tonalSpot` (デフォルト): Material 3 の標準レシピ。中程度の彩度で、バランスが取れています。シードが `primary` のソースになり、`secondary` と `tertiary` は近接する色相から取られます。
- `DynamicSchemeVariant.fidelity`: `primary` を正確なシードカラーに非常に近く保ちます。ブランドがシードをそのままレンダリングしてほしいときに使います。
- `DynamicSchemeVariant.content`: `fidelity` に似ていますが、コンテンツ由来のパレット (例: ヒーロー画像の主要色) 向けに設計されています。
- `DynamicSchemeVariant.monochrome`: グレースケール。`primary`、`secondary`、`tertiary` はすべてニュートラルです。
- `DynamicSchemeVariant.neutral`: 低彩度。シードはほとんど結果を色付けしません。
- `DynamicSchemeVariant.vibrant`: 彩度を強めます。遊び心のある、メディア中心のアプリに適しています。
- `DynamicSchemeVariant.expressive`: `secondary` と `tertiary` を色相環でさらに回します。視覚的に賑やか。
- `DynamicSchemeVariant.rainbow`、`DynamicSchemeVariant.fruitSalad`: 極端なバリアントで、典型的なアプリよりも Material You のランチャーで使われます。

具体例。ブランドカラーがちょうど `#7B1FA2` で、マーケティングチームがその特定の紫色を承認済みなら、`tonalSpot` ではそれを脱彩度化してしまいます。`fidelity` なら保てます。

```dart
// Flutter 3.27.1
final brand = const Color(0xFF7B1FA2);

final lightScheme = ColorScheme.fromSeed(
  seedColor: brand,
  brightness: Brightness.light,
  dynamicSchemeVariant: DynamicSchemeVariant.fidelity,
);
```

バリアントは一度選び、ライトとダークの両方の明るさに同じものを適用して、テーマ間で見た目が一貫するようにします。

## ライトとダークのスキームを正しくペアリングする

同じシードから `ColorScheme` を 2 つ (`Brightness` ごとに 1 つ) 構築するのが正しいアプローチです。フレームワークは明るさごとに階調パレットを再生成し、コントラスト比を M3 の最小値以上に保ちます。色を自分で反転させてはいけません。

```dart
// Flutter 3.27.1
final seed = Colors.indigo;

final light = ColorScheme.fromSeed(
  seedColor: seed,
  brightness: Brightness.light,
);
final dark = ColorScheme.fromSeed(
  seedColor: seed,
  brightness: Brightness.dark,
);

return MaterialApp(
  theme: ThemeData(colorScheme: light),
  darkTheme: ThemeData(colorScheme: dark),
  themeMode: ThemeMode.system,
  home: const Home(),
);
```

ここでよくあるバグ: ライトテーマを `Brightness.light` で作るのに、ダークテーマに `Brightness.dark` を渡し忘れることです。すると、ダークスキームはライトの階調を再利用してしまい、黒い背景の上では色あせて見え、本文では WCAG AA のコントラストを満たしません。両方を必ず渡してください。

コントラストをさらに細かく制御したい場合、`ColorScheme.fromSeed` は `-1.0` (低コントラスト) から `1.0` (高コントラスト) までの `contrastLevel` を受け取ります。デフォルトの `0.0` は M3 仕様に一致します。エンタープライズのアクセシビリティ監査を満たす必要があるときには高コントラストが役立ちます。

## ブランドカラーを使いつつ M3 の生成を維持する

ブランドカラーは譲れないが、残りのパレットは決まっていない、ということもあります。`ColorScheme.fromSeed` を使い、1 つのロールだけ上書きします。

```dart
// Flutter 3.27.1
final scheme = ColorScheme.fromSeed(
  seedColor: Colors.indigo,
  brightness: Brightness.light,
).copyWith(
  primary: const Color(0xFF1E3A8A), // exact brand
);
```

これにより、その他 (`secondary`、`tertiary`、`surface` など) はアルゴリズム的に導出されたパレットのまま残り、`primary` だけが固定されます。1 つか 2 つを超えるロールを上書きしないでください。M3 システムの要点は、ロールが相互に整合的であることです。4 色を固定すると、たいていどこかでコントラストが崩れます。

ブランドカラーが複数あって必須な場合、より安全な代替策はロールを置き換えるのではなく、シードに対して調和 (harmonize) させることです。Material Color Utilities は `MaterialDynamicColors.harmonize` を提供し、[`dynamic_color`](https://pub.dev/packages/dynamic_color) パッケージから利用できます。

```dart
// Flutter 3.27.1, dynamic_color 1.7.0
import 'package:dynamic_color/dynamic_color.dart';

final brandError = const Color(0xFFD32F2F);
final harmonized = brandError.harmonizeWith(scheme.primary);
```

`harmonizeWith` はブランドの色相をシードに向けてわずかにずらし、ブランドのアイデンティティを失わずに 2 つを視覚的に共存させます。デザインシステムが、たとえばエラーボタンや破壊的アクション用に正確な赤を要求している場合に適したツールです。

## Material You: Android 12 以降の動的カラー

Android 12 以上で配布する場合、システムは壁紙から導出された `ColorScheme` を渡してくれます。`dynamic_color` の `DynamicColorBuilder` で配線します。iOS、Web、デスクトップ、または古い Android では builder は `null` を返すので、自分のシードへフォールバックします。

```dart
// Flutter 3.27.1, dynamic_color 1.7.0
import 'package:dynamic_color/dynamic_color.dart';
import 'package:flutter/material.dart';

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return DynamicColorBuilder(
      builder: (lightDynamic, darkDynamic) {
        final ColorScheme light = lightDynamic ??
            ColorScheme.fromSeed(
              seedColor: Colors.indigo,
              brightness: Brightness.light,
            );
        final ColorScheme dark = darkDynamic ??
            ColorScheme.fromSeed(
              seedColor: Colors.indigo,
              brightness: Brightness.dark,
            );

        return MaterialApp(
          theme: ThemeData(colorScheme: light),
          darkTheme: ThemeData(colorScheme: dark),
          themeMode: ThemeMode.system,
          home: const Home(),
        );
      },
    );
  }
}
```

細かい注意点: `lightDynamic` と `darkDynamic` は常に同じ壁紙から導出されているとは限りません。一部の Pixel デバイスではダークスキームが別のソースから来ます。両者を独立として扱ってください。ユーザーがどのスキームに落ち着いたかに対してブランドの赤を調和させたい場合は、起動時に 1 度ではなく、build ごとに `brandRed.harmonizeWith(scheme.primary)` を呼んでください。

## ウィジェット内で色を読み取る

スキームが設定されたら、ロールには `Theme.of(context).colorScheme` 経由でアクセスします。ウィジェット内に hex 値をハードコードしないでください。M2 の `primaryColor` / `accentColor` ゲッターを参照しないでください。

```dart
// Flutter 3.27.1
class CallToAction extends StatelessWidget {
  const CallToAction({super.key, required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FilledButton(
      style: FilledButton.styleFrom(
        backgroundColor: scheme.primary,
        foregroundColor: scheme.onPrimary,
      ),
      onPressed: () {},
      child: Text(label),
    );
  }
}
```

`FilledButton` はデフォルトで `primary` と `onPrimary` を使うので、明示的な `styleFrom` はロール名を示すためだけのものです。ほとんどの M3 ウィジェットには妥当なデフォルトがあるので、「アクセントカラーでボタンをスタイルしたい」という問いへの最も簡単な答えは「正しいウィジェットを選ぶ」であって「style を上書きする」ではありません。

M2 から M3 への素早いマッピング:

| M2 のアイデア | M3 のロール |
| --- | --- |
| トグル、スライダー、FAB のハイライトでの `accentColor` | `primary` |
| チップの控えめな背景としての `accentColor` | `secondaryContainer` とテキスト用の `onSecondaryContainer` |
| 「3 番目」のハイライトとして使う `accentColor` | `tertiary` |
| app bar の `primaryColor` | `primary` (または M3 デフォルトの app bar には `surface`) |
| `cardColor` | `surfaceContainer` |
| `dividerColor` | `outlineVariant` |
| `disabledColor` | 不透明度 38% の `onSurface` |

## 正しく見えるが間違っているもの

毎週のように見かける 5 つのミス:

1. **新規アプリで「スタイリングを楽にする」ために `useMaterial3: false` を設定**し、なぜ `colorSchemeSeed` がまだ M3 の階調を返すのかと尋ねるパターン。`colorSchemeSeed` は M3 専用です。M3 をやめると、シードベースのカラースキームもやめることになります。固い要件がない限り M3 のままでいてください。
2. **1 つの `ColorScheme` を作り、両方のテーマで使い回す。** 黒背景上のライトスキームはコントラストを失敗します。同じシードから 2 つ作ってください。
3. **ツリー上層のウィジェットの `build()` 内で `ColorScheme.fromSeed` を呼ぶ。** rebuild ごとに Material Color Utilities が走り、致命的ではないものの無駄です。スキームは `main` か `App` の `State` で 1 回作り、下に渡してください。
4. **`Colors.deepPurple.shade300` をシードとして使う。** シードは彩度が高く色相が明確なほど良く動きます。色あせたシェードは色あせたパレットを生みます。ベースカラー (例: 500 番手の `Colors.deepPurple`) を渡し、より明るいロールの脱彩度化作業は `tonalSpot` に任せましょう。
5. **「アクセントカラーがなくなった」から FAB や選択された `Switch` の thumb に hex 値をハードコードする。** ロールは `primary` です。`primary` がそのサーフェスでうまく見えないなら、間違っているのはバリアントであって、ウィジェットではありません。

## 古いアプリの後片付け: 5 分のマイグレーション

アプリにすでに `accentColor` や `primarySwatch` がある場合、もっとも安価で正しいマイグレーションは次のとおりです。

1. `ThemeData(...)` から `accentColor` と `primarySwatch` を削除します。
2. `colorSchemeSeed: <以前の primary>` を追加します。
3. `useMaterial3: false` があれば削除します。3.16 以降では M3 がデフォルトです。
4. プロジェクトを `Theme.of(context).accentColor`、`theme.primaryColor`、`theme.colorScheme.background` (新しい Flutter では `surface` に改名) で grep し、それぞれを上の表にある正しい M3 ロールに置き換えます。
5. `flutter analyze` を実行します。非推奨のテーマプロパティについて警告が残っているものは、同じように対応します。

これを行ったあとに見られる最大の見た目の変化は、`AppBar` のデフォルト背景が `primary` ではなく `surface` になることです。色付きの app bar を取り戻したい場合は `appBarTheme: AppBarTheme(backgroundColor: scheme.primary, foregroundColor: scheme.onPrimary)` を設定します。多くのチームは慣れたあとで、実は M3 の `surface` の app bar の方が好きだったと気付きます。

## 関連する読み物

同時にもっと大きな Flutter アプリを移行している場合、[GetX から Riverpod へのマイグレーションのウォークスルー](/ja/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) と [DevTools でジャンクをプロファイリングするガイド](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) は、テーマ刷新時によく出てくる 2 つのこと、つまり状態管理の変更と予想外の rebuild の嵐をカバーしています。ネイティブブリッジ (Flutter だけでは取れないシステムテーマ信号を露出させる、など) については [プラグインなしでプラットフォーム固有のコードを追加する方法](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) を参照してください。マイグレーション中に CI マトリクスが古い Flutter SDK と新しい Flutter SDK にまたがる場合は、[1 つの CI パイプラインから複数の Flutter バージョンを対象にする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) のポストが両方のブランチを緑のままに保ってくれます。

## ソース

- Flutter API: [`ColorScheme.fromSeed`](https://api.flutter.dev/flutter/material/ColorScheme/ColorScheme.fromSeed.html)
- Flutter API: [`ThemeData.colorSchemeSeed`](https://api.flutter.dev/flutter/material/ThemeData/colorSchemeSeed.html)
- Flutter API: [`DynamicSchemeVariant`](https://api.flutter.dev/flutter/material/DynamicSchemeVariant.html)
- Material 3 仕様: [色ロール](https://m3.material.io/styles/color/roles)
- pub.dev: Material You と調和のための [`dynamic_color`](https://pub.dev/packages/dynamic_color)
