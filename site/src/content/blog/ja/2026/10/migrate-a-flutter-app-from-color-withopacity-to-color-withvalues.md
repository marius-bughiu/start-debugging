---
title: "Flutter アプリを Color.withOpacity から Color.withValues へ移行する (Flutter 3.27 以降)"
description: "非推奨になった Color.withOpacity、opacity、value、red、green、blue、alpha を withValues、.a/.r/.g/.b、toARGB32 に置き換えます。dart fix が書き換える範囲、書き換えずに残す 4 つのゲッター、置き換え後に色の厳密なアサーションと Map<Color, T> の検索が壊れる理由、そして withOpacity が Display P3 を黙って失わせる仕組みを解説します。Flutter 3.44.8 と Dart 3.12.2 で検証しました。"
pubDate: 2026-10-23
updatedDate: 2026-10-23
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "colors"
lang: "ja"
translationOf: "2026/10/migrate-a-flutter-app-from-color-withopacity-to-color-withvalues"
translatedBy: "claude"
translationDate: 2026-10-23
---

`Color.withOpacity` は Flutter 3.27.0 から非推奨になりました。このバージョンで `dart:ui` が、色の成分を `ColorSpace` 付きの浮動小数点値として保持するようになったためです。代わりに使うのは `color.withValues(alpha: x)` で、関連する置き換えは、`.opacity` には `.a`、`.value` には `toARGB32()`、`.red`/`.green`/`.blue` (0 から 255 の int) には `.r`/`.g`/`.b` (0.0 から 1.0 の double) です。`dart fix --apply` は `withOpacity`、`opacity`、`value` を書き換えますが、`red`、`green`、`blue`、`alpha` は手動で直す必要があります。この置き換えは見た目だけの変更ではありません。`withOpacity(0.5)` は alpha を `0.50196` (128/255) として保持しますが、`withValues(alpha: 0.5)` はちょうど `0.5` を保持するため、この 2 つの色はもう `==` になりません。`expect(color, const Color(0x80000000))` のようなテストや、古い値をキーにした `Map<Color, T>` は、移行後に壊れます。一般的なアプリでは 30 分から 1 時間ほどかかり、その大半はテストの修正です。以下はすべて Flutter 3.44.8 (Dart 3.12.2) で実行した結果です。

## 今 withOpacity をやめる理由

- **精度。** `withOpacity` は alpha を 8 ビットに量子化します。本体はまさに `withAlpha((255.0 * opacity).round())` です。`withValues` は渡した double をそのまま保持します。細かいステップで何度もフェードするアニメーションでは、256 段階の alpha と連続的な alpha の違いになります。
- **色空間。** `withValues` はレシーバーの `colorSpace` を保持します。`withOpacity` と `withAlpha` は `Color.fromARGB` を経由するため常に sRGB の色が作られ、Display P3 の色は sRGB として返ってきます。詳しくは落とし穴の節で説明します。
- **非推奨は削除に変わります。** Flutter の移行ガイドは、8 ビット API の削除を "Phase 2" と説明しており、まだ実施されていません。実施されると、残っている `withOpacity`、`.value`、`.red` はすべて、`info` 診断ではなくコンパイルエラーになります。
- **ノイズ。** 大きなアプリでは、これらのゲッターだけで `deprecated_member_use` が数百件出ることがあり、本当に対応すべき非推奨が埋もれてしまいます。

## アプリで何が変わるか

| 領域 | 変更内容 | 重大度 |
| --- | --- | --- |
| `Color` の厳密な等価比較を使うテスト | `withValues(alpha: 0.5) != const Color(0x80000000)`。`isSameColorAs` を使います | 高 |
| `Map<Color, T>` / `Set<Color>` のキー | 古い色と新しい色でハッシュが異なり、検索が `null` を返します | 高 |
| `.red`/`.green`/`.blue` の演算 | 置き換え後は 0.0 から 1.0 の double になり、`< 128` のような整数のしきい値は黙って壊れます | 高 |
| `withOpacity(x)` の呼び出し箇所 | `withValues(alpha: x)` になります。`dart fix` が適用します | 低 |
| `.value` / `.opacity` | `toARGB32()` / `.a` になります。`dart fix` が適用します | 低 |
| `implements Color` するクラス | `a`、`r`、`g`、`b`、`colorSpace`、`toARGB32`、`withValues` を実装する必要があります | 中 |

## 事前チェックリスト

- Flutter 3.27.0 以降、できれば最新の stable を使います。`CupertinoDynamicColor.withValues` とその `dart fix` ルールは後から追加されたため (非推奨メッセージには "deprecated after v3.33.0-1.0.pre" とあります)、Cupertino を多用するアプリは 3.35 以降にしてください。
- `git status` がクリーンであること。`dart fix` の出力を 1 つの diff としてレビューできます。
- 開始前にテストスイートがすべて通ること。色の等価比較の失敗は何かが変わったことを示す主なシグナルなので、それだけが失敗するようにしておきます。
- 色を永続化している場所 (shared preferences、JSON、データベース) の一覧。整数への変換が問題になるのはそこです。

## 移行手順

1. **非推奨メンバーを洗い出します。** `flutter analyze` を実行して色のゲッターに絞り込み、`dart fix` が手を付けない箇所を把握します。

    ```bash
    # Flutter 3.44.8
    flutter analyze 2>&1 | grep deprecated_member_use | grep -E "'(withOpacity|opacity|value|red|green|blue|alpha)'"
    ```

    次のサンプルファイルでは、

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (before)
    import 'package:flutter/material.dart';

    Color scrim(Color base) => base.withOpacity(0.54);

    bool isDark(Color c) => (c.red * 0.299 + c.green * 0.587 + c.blue * 0.114) < 128;

    int serialize(Color c) => c.value;

    double fade(Color c) => c.opacity;

    int alphaByte(Color c) => c.alpha;
    ```

    アナライザーはメンバーごとに 1 件、合計 7 件の `deprecated_member_use` info を報告し、それぞれに推奨される置き換えが付きます。たとえば `'red' is deprecated and shouldn't be used. Use (*.r * 255.0).round().clamp(0, 255).` です。

    確認: 件数が分かっていること。手順 3 で比較するので控えておいてください。

2. **データ駆動の修正を適用します。** Flutter は `Color` の 3 つのメンバーに対してだけ `fix_data` ルールを提供しています。`withOpacity` から `withValues(alpha: ...)`、`opacity` から `a`、`value` から `toARGB32()` です。プレビューしてから適用します。

    ```bash
    # Flutter 3.44.8
    dart fix --dry-run .
    dart fix --apply .
    ```

    サンプルに対するドライランは `deprecated_member_use - 3 fixes` と報告し、diff は次のとおりです。

    ```diff
    -Color scrim(Color base) => base.withOpacity(0.54);
    +Color scrim(Color base) => base.withValues(alpha: 0.54);
    -int serialize(Color c) => c.value;
    +int serialize(Color c) => c.toARGB32();
    -double fade(Color c) => c.opacity;
    +double fade(Color c) => c.a;
    ```

    `CupertinoDynamicColor.withOpacity` にも同じルールがあります。モノレポではルートから 1 回実行してください。アナライザーが入れ子の `pubspec.yaml` をすべて拾います。

    確認: `flutter analyze` の色に関する非推奨が 7 件から 4 件に減り、残りはすべて `red`、`green`、`blue`、`alpha` であること。

3. **整数のゲッターをスケールを保ったまま手動で書き換えます。** 実際のバグはここから生まれます。`.red` は 0 から 255 の `int` を返し、`.r` は 0.0 から 1.0 の `double` を返します。どちらも `num` なので、片方をもう片方に置き換えてもコンパイルは通りますが、比較はずっと誤ったままになります。

    ```dart
    // Flutter 3.44.8: compiles, always returns true
    bool isDark(Color c) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) < 128;
    ```

    式全体を 0 から 1 のスケールに移すか、バイト値が本当に必要な箇所で明示的に変換します。

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (after)
    bool isDark(Color c) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) < 0.5;

    // Or, better for contrast decisions, the built-in WCAG luminance:
    bool isDarkWcag(Color c) => c.computeLuminance() < 0.179;

    extension ColorBytes on Color {
      int get alpha8 => (a * 255.0).round().clamp(0, 255);
      int get red8 => (r * 255.0).round().clamp(0, 255);
      int get green8 => (g * 255.0).round().clamp(0, 255);
      int get blue8 => (b * 255.0).round().clamp(0, 255);
    }

    int alphaByte(Color c) => c.alpha8;
    ```

    この拡張は非推奨メッセージが示す式をそのまま使っており、各チャンネルに対して内部で `(x * 255.0).round().clamp(0, 255)` を行う `toARGB32()` と一致します。`Colors.blue[500]` (`0xFF2196F3`) では、`.red` は `33`、`.r` は `0.12941176470588237` です。

    確認: `flutter analyze` で色に関する非推奨が 0 件であること。また `grep -rnE '\.(red|green|blue)\b' lib/` の結果に、`.r` 系の double をバイト値サイズのリテラルと比較している箇所がないこと。

4. **テストの厳密な色のアサーションを直します。** スイートを実行してください。移行した色を整数リテラルと比較しているテストはすべて失敗します。リテラルは 8 ビットのコンストラクターを通るため、alpha が 128/255 になるからです。

    ```dart
    // Flutter 3.44.8, flutter_test
    import 'package:flutter/material.dart';
    import 'package:flutter_test/flutter_test.dart';

    Color scrim() => Colors.black.withValues(alpha: 0.5);

    void main() {
      // Fails after the migration
      test('exact', () => expect(scrim(), const Color(0x80000000)));
      // Passes
      test('same color', () => expect(scrim(), isSameColorAs(const Color(0x80000000))));
    }
    ```

    失敗する方は次のように出力されます。

    ```text
    Expected: Color:<Color(alpha: 0.5020, red: 0.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)>
      Actual: Color:<Color(alpha: 0.5000, red: 0.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)>
    ```

    `isSameColorAs` は、各成分をデフォルトのしきい値 `colorEpsilon = 0.004` (8 ビットのおよそ 1 ステップ) で比較し、`colorSpace` が同じであることも要求します。演算で作られた色をテストで比較する箇所では、すべてこれを使ってください。期待値を厳密なままにしたい場合は、コードと同じコンストラクターで書きます。`Colors.black.withValues(alpha: 0.5)` です。

    確認: `flutter test` がすべて通り、テストの編集がマッチャーの変更だけで、新しい期待値を含まないこと。

5. **色をキーにしたコレクションと永続化された値を監査します。** `Map<Color`、`Set<Color>`、色に対する `switch`、そして `toARGB32()` を保存しているあらゆる箇所を検索します。往復の両方向が重要で、次の節で実測した挙動を示します。

    確認: ユーザーが選んだ色を保存して読み込み直すユニットテストが、`==` ではなく `isSameColorAs` でアサートしていること。

## 検証

上記の手順の後に、次を実行します。

```bash
# Flutter 3.44.8
flutter analyze
flutter test
dart fix --dry-run .
```

`flutter analyze` は `Color` メンバーに対する `deprecated_member_use` を出さず、`flutter test` はすべて通り、`dart fix --dry-run` は色のルールについて `Nothing to fix!` と表示するはずです。その後、アプリを起動して、半透明のオーバーレイ (スクリム、無効化されたボタン、テーマ由来のリップルやホバーの色) を使う画面を確認してください。見た目は変わらないはずです。`withOpacity` に渡していたどの alpha でも、古い色と新しい色の `toARGB32()` は同一であり (0.5 ではどちらも `0x80000000`)、8 ビットに量子化されるものは同じ結果になるからです。

## ロールバック

この移行は元に戻せます。`withOpacity`、`.opacity`、`.value`、整数のゲッターは 3.44.8 にまだ存在し、従来の意味を保っているため、移行コミットを `git revert` すれば挙動が正確に元に戻ります。戻せないのは、Phase 2 でそれらが削除された将来の Flutter リリースです。しばらく非推奨 API を使い続ける必要がある場合は、診断を全体で無効にするのではなく、ファイル単位で `// ignore_for_file: deprecated_member_use` を使って抑制してください。他の非推奨が見え続けます。

## 実際の移行で見つかった落とし穴

以下はすべて、Flutter 3.44.8 で実行した 1 つのプローブテストの結果です。数値は推定ではなく、出力された値です。

### 古い色と新しい色は等しくなく、ハッシュも一致しない

```dart
// Flutter 3.44.8
final o = Colors.black.withOpacity(0.5);
final v = Colors.black.withValues(alpha: 0.5);

print(o.a);                          // 0.5019607843137255
print(v.a);                          // 0.5
print(o == v);                       // false
print(o.toARGB32() == v.toARGB32()); // true (both 0x80000000)
print({o: 'x'}[v]);                  // null
```

`Color.==` は `a`、`r`、`g`、`b`、`colorSpace` を double として比較し、`hashCode` も同じフィールドからハッシュを作ります。コードベースの半分だけが移行済みの場合、一方で作られた色は、もう一方で作られたマップのエントリーを見つけられません。ルックアップテーブルと、それを参照するすべての呼び出し箇所は同じコミットで移行するか、マップのキーを `toARGB32()` にしてください。

### toARGB32 で永続化すると古い色に戻る

```dart
// Flutter 3.44.8
final stored = v.toARGB32();
print(Color(stored) == v); // false
print(Color(stored) == o); // true
```

`toARGB32()` は設計上、情報が失われます。各チャンネルをバイトに丸めるためです。`Color(int)` で復元した色の alpha は `128/255` になり、これは保存した値ではなく `withOpacity` の値です。描画には問題ありませんが、"保存されたアクセントカラーが今選択中のものと同じか" のような等価チェックでは誤りになります。正確な往復が必要な場合は、4 つの double と色空間の名前を保存し、`Color.from(alpha: ..., red: ..., green: ..., blue: ..., colorSpace: ...)` で再構築してください。

### `.a` は名前が変わっただけの `.opacity` ではない

`dart fix` は `opacity` を `a` に名前変更しますが、古いゲッターは 8 ビットの alpha から計算されていました。`Colors.black.withValues(alpha: 0.3)` では、`.opacity` は `0.30196078431372547` を返し、`.a` は `0.3` を返します。`opacity` を `0.30196` のようなリテラルと比較していたり、マップのキーにしていたりするコードは、名前変更の後で挙動が変わります。まれなケースですが、`dart fix` の変更の中で意味が中立でない唯一のものです。

### withOpacity は Display P3 の色を黙って sRGB に変換する

```dart
// Flutter 3.44.8
const p3 = Color.from(alpha: 1, red: 1, green: 0, blue: 0, colorSpace: ColorSpace.displayP3);

print(p3.withOpacity(0.5));
// Color(alpha: 0.5020, red: 1.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)
print(p3.withValues(alpha: 0.5));
// Color(alpha: 0.5000, red: 1.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.displayP3)
```

P3 の赤は sRGB の範囲外にあり (拡張 sRGB に変換すると `red: 1.0931, green: -0.2267, blue: -0.1501` です)、`withOpacity` は同じ成分値に sRGB というラベルを付け直すだけなので、色が目に見えてくすみます。`withAlpha(128)` も同じことをしますが、こちらは非推奨ではないため、アナライザーには表示されません。アプリで広色域のブランドカラーを使っている場合は、`withAlpha(` も grep して、`withValues(alpha: n / 255)` に置き換えてください。

### withValues は範囲を検証しない

`Colors.black.withOpacity(1.5)` はデバッグビルドで `AssertionError` を投げます。`Colors.black.withValues(alpha: 1.5)` は成功し、`a == 1.5` を保持します。`toARGB32()` は `0xff000000` にクランプしますが、等価比較やその他 `.a` を読むものはすべて `1.5` を見ます。alpha が演算から来る場合 (たとえばアニメーションの値に係数を掛けたものなど) は、`clampDouble(x, 0, 1)` で自分でクランプしてください。`Color.lerp` は出力をクランプするので、トゥイーンは安全です。

### Color を実装するクラス

ガイドによると、Flutter は最終的に `Color` を `sealed` にする予定です。`implements Color` するクラス (動的な色をラップするために、一部のテーマ系パッケージがそうしていました) がある場合、浮動小数点のゲッター、`colorSpace`、`toARGB32`、`withValues` を実装する必要があります。推奨される方向はコンポジションです。自分が色であるかのように装うのではなく、`Color` フィールドを保持して公開します。`CupertinoDynamicColor` 自体が参照実装で、すべてのオーバーライドが `_effectiveColor` に転送されています。

## 関連記事

- 手順 2 の 3 つの機械的な書き換えは標準的なデータ駆動の修正です。[リポジトリ全体で dart fix を実行する方法](/ja/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)では、フラグ、汚れたリポジトリで "Nothing to fix" と報告されるケース、そして終了コードが CI で役に立たない理由を説明しています。
- アプリ内の `withOpacity` 呼び出しの多くはテーマカラーの近くにあります。ついでに手を入れるなら、[Material 3 の ColorScheme でアクセントカラーを設定する方法](/ja/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)が、alpha を手作業で調整する代わりに、スキームから半透明のバリエーションを導き出す方法を示しています。
- カスタムのデザイントークンは `Color.lerp` と厳密な色の比較が出会う場所です。[Flutter で ThemeExtension を使ってデザイントークンを定義する方法](/ja/2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter/)を参照してください。
- 将来のアップグレードでコンパイルエラーになる別の非推奨として、[Flutter が削除する前に describeEnum から移行する方法](/ja/2026/09/migrate-off-describeenum-before-flutter-removes-it/)があります。
- 広色域の色は Impeller でのみ画面に届きます。デスクトップ向けには、[Flutter の Windows または Linux デスクトップアプリを Impeller に移行する方法](/ja/2026/10/migrate-a-flutter-windows-or-linux-desktop-app-to-impeller/)がレンダラーの切り替えを扱っています。

## 参考資料

- [Migration guide for wide gamut Color](https://docs.flutter.dev/release/breaking-changes/wide-gamut-framework) (docs.flutter.dev)
- [Migration guide for wide gamut CupertinoDynamicColor](https://docs.flutter.dev/release/breaking-changes/wide-gamut-cupertino-dynamic-color) (docs.flutter.dev)
- [`Color.withValues`](https://api.flutter.dev/flutter/dart-ui/Color/withValues.html) と [`Color.withOpacity`](https://api.flutter.dev/flutter/dart-ui/Color/withOpacity.html) (api.flutter.dev)
- [`isSameColorAs` matcher](https://api.flutter.dev/flutter/flutter_test/isSameColorAs.html) (api.flutter.dev)
- [flutter/flutter#127855: Implement wide gamut color support in the Framework](https://github.com/flutter/flutter/issues/127855) と [flutter/engine#54737: Framework wide color](https://github.com/flutter/engine/pull/54737)
- [`fix_dart_ui.yaml` data-driven fixes](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/fix_data/fix_dart_ui.yaml) (flutter/flutter)
