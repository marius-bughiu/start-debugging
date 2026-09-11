---
title: "修正: システムのフォントスケーリングが有効なとき、Android WebView で Flutter の Text が画面外に描画される"
description: "Flutter web 3.41 から 3.44 では、Android WebView の textZoom が 100 以外のとき、約 625 倍の行の高さのオーバーライドが報告されます。3.47 にアップグレードするか、MaterialApp.builder でオーバーライドを消去してください。"
pubDate: 2026-09-11
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-web"
  - "android"
  - "accessibility"
lang: "ja"
translationOf: "2026/09/fix-flutter-text-renders-off-screen-in-an-android-webview-with-font-scaling"
translatedBy: "claude"
translationDate: 2026-09-11
---

Flutter web アプリを Android の `WebView` 内で実行していて、ユーザーがシステムのフォントサイズを変更した途端にすべての通常の `Text` が消えてしまう場合、これは web エンジンの既知のバグです。Flutter 3.41.0 から 3.44.9 までは、WebView の `textZoom` をユーザーの行の高さの設定として誤って読み取ります。`MediaQuery.lineHeightScaleFactorOverride` がおよそ `624.9` を返すため、18 px の行は約 12,900 px の高さでレイアウトされ、グリフはビューポートのはるか下に描画されます。検出コードが書き直された Flutter 3.47.0 以降 (現在の stable は 3.47.3) にアップグレードしてください。古いバージョンでは、`MaterialApp.builder` で誤ったオーバーライドを消去します。Android ホストを自分で管理している場合は、`textZoom` を 100 に固定することもできます。

この記事では、バグ報告に記載されたバージョンである Flutter 3.44.8 (Dart 3.12.2) を対象とし、3.47.3 のエンジンソースと比較します。以下のウィジェットレベルの挙動は、3.44.8 上で `flutter test` を使って再現しました。

## 壊れた画面はどのように見えるか

例外もコンソールエラーもありません。Web フォントは HTTP 200 で読み込まれ、`flutter-first-frame` イベントも発火し、スケジューラーも動き続けます。症状はすべて幾何学的なものです。

- すべての `Text` ウィジェットが見えなくなりますが、アイコン、ボーダー、画像、`Container` の背景は描画されます。
- `Column` 内で最初の `Text` より下にあるものもすべて消えます。膨れ上がったテキストがそれらを数千ピクセル下に押しやるためです。
- `NavigationBar` のような固定高さのバーではラベルがクリップされて消え、`TextField` は `maxHeight` まで伸びます。
- リリースモードでは、一部のルートがグレーの `ErrorWidget` に置き換わります。デバッグビルドでは、いつものように端から数ピクセルはみ出す程度ではなく、数千ピクセル単位の [RenderFlex overflow](/ja/2026/05/fix-renderflex-overflowed-in-flutter/) が発生します。

発生条件は限定的です。同じビルドでも、デスクトップの Chrome、同じスマートフォンの Chrome ブラウザアプリ、GeckoView、デフォルト設定の標準エミュレーター上の WebView では正常に描画されます。壊れるのは、`textZoom` がちょうど 100 ではない Android System WebView だけです。設定 > ユーザー補助 にあるシステムのフォントサイズのスライダーは、この値をオーバーライドしていないすべての WebView に対して自動的にこの値を設定します。

アプリ内から `MediaQuery` の値を出力すると、原因は明らかです。[flutter/flutter#190350](https://github.com/flutter/flutter/issues/190350) では、報告者が Flutter 3.44.8 で標準の `flutter create` アプリを実行し、`adb shell settings put system font_scale` だけを変更しました。

```text
font_scale  textZoom  lineHeightScaleFactorOverride  textScaler  Text visible
0.85        85        624.9374824709756              0.85        no
1.0         100       null                           1.0         yes
1.15        115       624.9347955648752              1.15        no
1.3         130       624.9375229225718              1.3         no
```

`textScaler` はどの段階でも正しい値です。`lineHeightScaleFactorOverride` は 100 のときは `null` で、それ以外のズームレベルでは、テキストが小さくなっても大きくなっても約 624.94 です。入力がどちらの方向に動いても変わらない値は、測定値ではありません。センチネル値が漏れ出しているのです。

## web エンジンが 625 倍の行の高さを報告する理由

Flutter 3.41 以降、web エンジンはブラウザ拡張機能やユーザースタイルシートが適用する [WCAG 1.4.12 のテキストの間隔](https://www.w3.org/WAI/WCAG21/Understanding/text-spacing.html) の設定をサポートしています。これを追加したのは [PR #178081](https://github.com/flutter/flutter/pull/178081) です。Flutter はテキストをキャンバスに描画するため、自身のコンテンツからこれらの CSS オーバーライドを読み取れません。その代わりに、`EnginePlatformDispatcher._addTypographySettingsObserver` は、意図的にありえない値のインラインスタイルを持つ非表示の `<p>` プローブ要素を `document.body` に追加し、`ResizeObserver` で監視します。3.44.8 では、`engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart` の該当部分は次のようになっています。

```dart
// Flutter 3.44.8, lib/web_ui/lib/src/engine/platform_dispatcher.dart (abridged)
const spacingDefault = 9999.0;
_typographyMeasurementElement!.style
  ..lineHeight = '${spacingDefault}px'
  ..letterSpacing = '${spacingDefault}px'
  ..wordSpacing = '${spacingDefault}px'
  ..margin = '0px 0px ${spacingDefault}px 0px';
domDocument.body!.append(_typographyMeasurementElement!);
final double typographyMeasurementElementFontSize =
    parseFontSize(_typographyMeasurementElement!)?.toDouble() ?? _defaultRootFontSize;
final double defaultLineHeightFactor = spacingDefault / typographyMeasurementElementFontSize;

// Inside the ResizeObserver callback:
final double? computedLineHeightScaleFactor =
    fontSize != null && lineHeight != null && lineHeight != spacingDefault
    ? lineHeight / fontSize
    : null;
_updateLineHeightScaleFactorOverride(
  computedLineHeightScaleFactor == defaultLineHeightFactor
      ? null
      : computedLineHeightScaleFactor,
);
```

考え方としては、Flutter の外部の何もプローブに触れていなければ、計算された `line-height` はちょうど `9999px` のままで、オーバーライドは `null` のままになる、というものです。それ以外の値はユーザーの設定を意味し、フォントサイズに対する比率が新しい行の高さの係数になります。

Android WebView の `textZoom` は、この両方のチェックを壊します。ルートの `font-size` をスケーリングするだけでなく、プローブのピクセル単位の `line-height` もスケーリングしますが、これはまったくユーザーの設定ではありません。`textZoom` が 115 で、ルートのデフォルトサイズが 16 px の場合を計算してみます。

1. プローブのフォントサイズは `16 * 1.15 = 18.4px` なので、`defaultLineHeightFactor = 9999 / 18.4 = 543.4` です。
2. 計算された `line-height` は `9999 * 1.15 = 11498.85px` です。これは `9999` ではないため、エンジンはオーバーライドとして扱います。
3. `computedLineHeightScaleFactor = 11498.85 / 18.4 = 624.9375` で、これはちょうど `9999 / 16` です。ズーム係数が打ち消し合うため、報告される値はズームレベルが変わってもほとんど変化しません。
4. `624.9375` は `543.4` と等しくないため、`MediaQueryData.lineHeightScaleFactorOverride` として公開されます。

フレームワークはこの値をそのまま受け取ります。`Text.build` は `MediaQuery.maybeLineHeightScaleFactorOverrideOf(context)` を読み取り、`inherit` に関係なく、スパンの `TextStyle.height` に、そして strut が設定されている場合は `StrutStyle.height` にも強制的に適用します。[leadingDistribution の記事](/ja/2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes/) で説明したとおり、`TextStyle.height` はフォントサイズに対する倍率なので、行ボックスはグリフの 625 倍の高さになります。`Icon` のように `RichText` を直接構築するウィジェットは、このオーバーライドを参照しません。そのため、テキストがすべて消えた画面でもアイコンは残るのです。

これは以前のバグの亜種です。[#178856](https://github.com/flutter/flutter/issues/178856) では、実行時にブラウザのフォントサイズを変更した後に同じ異常な値が出ることが報告され、[PR #178862](https://github.com/flutter/flutter/pull/178862) が 2025-12-02 にそれを修正しました。この修正は依然として `9999` との完全一致で比較していたため、最初の描画の時点ですでに有効なズームは素通りしてしまいます。issue スレッドでの bisect により、リグレッションは 3.39.0-0.2.pre (正常) と 3.40.0-0.1.pre (異常) の間にあると特定されています。stable リリースの中では、9999 px のセンチネルは 3.41.0 から 3.44.9 までのすべてのタグに存在し、3.38.x には存在しません。

レンダラーは関係ありません。スレッドでは、CanvasKit、CPU を強制した CanvasKit、そして [`flutter build web --wasm`](/ja/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) ビルドの skwasm でバグが再現されています。欠陥が共有の Dart コードにあるためです。

## 最小限の再現コード

web 側は、オーバーライドを `RichText` で表示するだけの標準的なアプリです。こうすることで、バグが発生している間もレポートを読める状態に保てます。

```dart
// Flutter 3.44.8, web target. Serve build/web and load it in an Android WebView.
import 'package:flutter/material.dart';

void main() => runApp(
      const MaterialApp(home: Scaffold(body: SafeArea(child: Probe()))),
    );

class Probe extends StatelessWidget {
  const Probe({super.key});

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        RichText(
          text: TextSpan(
            text: 'line=${mq.lineHeightScaleFactorOverride}\n'
                'scale10=${mq.textScaler.scale(10)}',
            style: const TextStyle(fontSize: 15, color: Colors.black),
          ),
        ),
        const Text('PLAIN TEXT', style: TextStyle(fontSize: 18, color: Colors.red)),
      ],
    );
  }
}
```

`flutter build web --release` でビルドし、`build/web` を配信します。次に `adb shell settings put system font_scale 1.15` を実行し、JavaScript を有効にした素の `android.webkit.WebView` でページを開きます。WebView はシステムのスケールを自動的に取り込むため、ホストが `setTextZoom` を呼び出す必要はありません。

デバイスがない場合でも、エンジンが報告する値を与えることで、フレームワーク側の半分をウィジェットテストで再現できます。

```dart
// Flutter 3.44.8, flutter_test
testWidgets('engine-reported override inflates Text', (tester) async {
  await tester.pumpWidget(MaterialApp(
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context)
          .copyWith(textScaler: const TextScaler.linear(1.15))
          .applyTextStyleOverrides(
            lineHeightScaleFactorOverride: 624.9375,
            letterSpacingOverride: null,
            wordSpacingOverride: null,
            paragraphSpacingOverride: null,
          ),
      child: child!,
    ),
    home: const Scaffold(
      body: SingleChildScrollView(
        child: Text('plain', key: Key('t'), style: TextStyle(fontSize: 18)),
      ),
    ),
  ));
  debugPrint('${tester.getSize(find.byKey(const Key('t'))).height}');
});
```

3.44.8 ではこれが `12936.0` を出力します。これは、issue の報告者が実際の WebView で測定した 12,936 px の行の高さと同じです。

## 修正 1: Flutter 3.47 にアップグレードする

2026-05-19 にマージされた [PR #186474](https://github.com/flutter/flutter/pull/186474) が、プローブのロジックを書き直しました。これは、同じ仕組みで同じ膨れ上がった係数を生み出していた Safari の "never use font sizes smaller than" のバグ ([#185931](https://github.com/flutter/flutter/issues/185931)) のために書かれたものです。この修正は 3.46.0-0.1.pre で初めて出荷され、すべての 3.47 stable リリースに含まれています。2026-08-05 の 3.44.9 を含む 3.44.x のホットフィックス系列には、一度も取り込まれていません。新しいコードは次のとおりです。

```dart
// Flutter 3.47.3, lib/web_ui/lib/src/engine/platform_dispatcher.dart (abridged)
const spacingDefault = 100.0;
final double defaultLineHeightFactor =
    spacingDefault / (typographyMeasurementElementFontSize / findBrowserTextScaleFactor());

bool isDefault(double? value, double defaultValue) {
  if (value == null) {
    return true;
  }
  return (value - defaultValue).abs() < _typographyPrecisionErrorTolerance ||
      (value - defaultValue * computedTextScaleFactor).abs() <
          _typographyPrecisionErrorTolerance;
}
```

`findBrowserTextScaleFactor()` はルートのフォントサイズを 16 で割った値で、`textZoom` が 115 のときは 1.15 になります。`100 * 1.15` というズームされた行の高さは "デフォルト" として扱われるようになり、ズームされた文字間隔、単語間隔、段落のマージンも同様です。`textScaler` は引き続き 1.15 を報告しつつ、オーバーライドは `null` のままになります。センチネルも 9999 px から 100 px に下がったため、将来誤検出が起きても、係数は 625 ではなく約 6 になります。

注意点が 1 つあります。#190350 はまだオープンのままで、スレッドでは誰も 3.47 でのデバイステストを投稿していません。上記の分析はソースを読んだ結果であり、WebView で実行した結果ではありません。アップグレード後は、実機で `font_scale` 1.15 にして `RichText` プローブを実行し、回避策を削除する前に `line=null` になることを確認してください。いずれにせよ 3.44 からアップグレードするのであれば、アプリの他のターゲットについて [3.47 のデスクトップレンダラーの変更](/ja/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) も読んでおく価値があります。

```bash
flutter upgrade
flutter --version
```

## 修正 2: MaterialApp.builder でありえないオーバーライドを消去する

まだ 3.41 から 3.44 を離れられない場合や、ホストアプリを管理していない場合は、ウィジェットツリーのルートで修正します。`MediaQuery.applyTextStyleOverrides` は、その配下のすべてに対して 4 つの間隔のオーバーライドを置き換えます。それぞれを渡した値 (`null` を含む) そのものに設定し、`textScaler` は維持するため、ユーザーが選んだフォントサイズは引き続き適用されます。

issue に投稿された回避策では、4 つすべてを `null` に設定しています。これでも動作しますが、プローブの存在理由である本物の WCAG のテキスト間隔の設定まで捨ててしまいます。より絞り込んだガードでは、実際のユーザー設定では生じ得ない値だけを破棄します。

```dart
// Flutter 3.41.0 to 3.44.9, workaround for flutter/flutter#190350
import 'package:flutter/widgets.dart';

/// Drops text spacing overrides that no real user preference can produce.
Widget sanitizeTextSpacing(BuildContext context, Widget? child) {
  final mq = MediaQuery.of(context);
  double? sane(double? value, double max) =>
      value == null || value.abs() > max ? null : value;

  final lineHeight = sane(mq.lineHeightScaleFactorOverride, 4);
  final letter = sane(mq.letterSpacingOverride, 100);
  final word = sane(mq.wordSpacingOverride, 100);
  final paragraph = sane(mq.paragraphSpacingOverride, 1000);

  if (lineHeight == mq.lineHeightScaleFactorOverride &&
      letter == mq.letterSpacingOverride &&
      word == mq.wordSpacingOverride &&
      paragraph == mq.paragraphSpacingOverride) {
    return child ?? const SizedBox.shrink();
  }
  return MediaQuery.applyTextStyleOverrides(
    lineHeightScaleFactorOverride: lineHeight,
    letterSpacingOverride: letter,
    wordSpacingOverride: word,
    paragraphSpacingOverride: paragraph,
    child: child ?? const SizedBox.shrink(),
  );
}
```

すべてのアプリのルートに組み込みます。

```dart
// Flutter 3.44.8
MaterialApp(
  builder: sanitizeTextSpacing,
  home: const HomePage(),
);
```

WCAG 1.4.12 が求めているのは行の高さ 1.5 と文字間隔 0.12em なので、係数の上限 4 と 100 px の上限は、実際の設定に対して十分な余裕があります。3.44.8 で、これをウィジェットテストで実行しました。`624.9375` のオーバーライドは `null` になり、18 px の `Text` は 12,936 px ではなく 30 px になります。`1.5` のオーバーライドは変更されずにそのまま通ります。どちらの場合も `textScaler.scale(10)` は `11.5` を返します。

ここで重要な点がいくつかあります。

- **すべてのルートに必要です。** builder は自身の `MaterialApp` しかカバーしません。独自の `MaterialApp` や `WidgetsApp` を持つ読み込み用、メンテナンス用、オンボーディング用のアプリを別々に実行している場合は、それぞれをラップしてください。
- **実行時の変更に追従します。** `MediaQuery.of(context)` は周囲のデータを購読するため、ページを開いている間にユーザーがフォントサイズを変更すると、エンジンが値を再公開し、ガードが再度実行されます。
- **`MediaQuery.withNoTextScaling` は役に立ちません。** これは `textScaler` をリセットするだけですが、そもそも問題はそこではありません。テキストスケールを制限しても、行の高さのオーバーライドは残ります。
- **アップグレード後も害はありません。** 3.47 では WebView のケースでエンジンが `null` を報告するはずなので、ガードは `child` をそのまま返します。デバイスでアップグレードの効果を確認したら削除して構いません。

## 修正 3: Android ホストで textZoom を 100 に固定する

ネイティブのホストも自分で出荷している場合は、WebView がシステムのフォントスケールをページに渡さないようにできます。3 つの修正の中で最も大ざっぱな方法です。`textScaler` が 1.0 のままになるため、Flutter web のコンテンツはユーザーのフォントサイズにまったく追従しなくなります。web アプリが独自のアプリ内テキストサイズ調整機能を持っている場合にのみ使ってください。

Kotlin のホストでは次のようにします。

```kotlin
// Android System WebView, API 14+
webView.settings.javaScriptEnabled = true
webView.settings.textZoom = 100
```

`webview_flutter` 4.14.1 を使う Flutter のホストでは、この設定は `webview_flutter_android` 4.14.1 の Android プラットフォームコントローラーにあります。

```dart
// webview_flutter 4.14.1, webview_flutter_android 4.14.1
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

WebViewController buildController(Uri appUrl) {
  final controller = WebViewController()
    ..setJavaScriptMode(JavaScriptMode.unrestricted)
    ..loadRequest(appUrl);

  final platform = controller.platform;
  if (platform is AndroidWebViewController) {
    // Opt out of Android's system font scale for this WebView.
    platform.setTextZoom(100);
  }
  return controller;
}
```

これで、バグを再現できないという報告があることの説明もつきます。issue スレッドによると、`flutter_inappwebview` で構築されたホストは、このプラグインがデフォルトで `textZoom` を 100 に設定するため影響を受けません。素の `android.webkit.WebView` や `webview_flutter` で構築されたホストは、ユーザーがフォントのスライダーをデフォルトから動かした時点で影響を受けます。

## このバグではないよく似た症状

- **Xclipse GPU を搭載した Samsung デバイスで何も描画されない。** アイコンや背景も表示されず、しかも CanvasKit でのみ発生する場合は、ANGLE-on-Vulkan のレンダリングのリグレッションである [#188164](https://github.com/flutter/flutter/issues/188164) です。これは `textZoom` が 100 でも発生します。
- **Safari 26.5 でウィジェット間に大きな隙間ができる。** これは [#185931](https://github.com/flutter/flutter/issues/185931) です。Safari の最小フォントサイズ設定を経由した同じ根本原因によるもので、同じ修正が適用できます。
- **ネイティブの Android または iOS で `flutter upgrade` 後にテキストがはみ出す。** タイポグラフィのプローブは web エンジンにしか存在しません。モバイルのターゲットでは、代わりに `TextScaler` とレイアウトの制約を確認してください。[Flutter 3.44 で画面の角の半径を読み取る](/ja/2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery/) ときに使うものと同じように動作する `MediaQuery.textScalerOf` などの項目別アクセサーを使えば、プラットフォームが報告する値を正確にログ出力できます。

このバグに当たっているかどうかを手早く判別するには、起動時に `PlatformDispatcher.instance.lineHeightScaleFactorOverride` をログ出力します。web でおよそ 3 を超える値が出ている場合、それはユーザーが求めたものではなく、エンジンがプローブを読み違えたことを意味します。

## 関連記事

- [修正: Flutter で A RenderFlex overflowed by N pixels が発生する](/ja/2026/05/fix-renderflex-overflowed-in-flutter/)。このバグが生み出すデバッグモードの縞模様について。
- [Flutter `Text` における `leadingDistribution` の詳細](/ja/2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes/)。`TextStyle.height` がどのように行ボックスのジオメトリになるかについて。
- [WebAssembly で Flutter web アプリをビルドする方法](/ja/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/)。skwasm でも同じバグが起きるため。
- [Flutter 3.47 がデスクトップで Impeller をデフォルトのレンダラーにする](/ja/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/)。エンジンの修正を含むリリースについて。

## 出典

- [flutter/flutter#190350](https://github.com/flutter/flutter/issues/190350): Android WebView の `textZoom` に関する報告、bisect、回避策。
- [flutter/flutter#178856](https://github.com/flutter/flutter/issues/178856) と [PR #178862](https://github.com/flutter/flutter/pull/178862): 実行時のフォントサイズ変更による最初の亜種と、その部分的な修正。
- [PR #178081](https://github.com/flutter/flutter/pull/178081): プローブを追加した、web のテキスト間隔オーバーライドのサポート。
- [PR #186474](https://github.com/flutter/flutter/pull/186474) と [flutter/flutter#185931](https://github.com/flutter/flutter/issues/185931): 3.46 と 3.47 で出荷された、ズームを許容する検出。
- [3.44.8 の `platform_dispatcher.dart`](https://github.com/flutter/flutter/blob/3.44.8/engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart) と [3.47.3 のもの](https://github.com/flutter/flutter/blob/3.47.3/engine/src/flutter/lib/web_ui/lib/src/engine/platform_dispatcher.dart)。
- [`MediaQuery.applyTextStyleOverrides`](https://api.flutter.dev/flutter/widgets/MediaQuery/applyTextStyleOverrides.html) と [`MediaQueryData.lineHeightScaleFactorOverride`](https://api.flutter.dev/flutter/widgets/MediaQueryData/lineHeightScaleFactorOverride.html) の API ドキュメント。
- [`WebSettings.setTextZoom`](https://developer.android.com/reference/android/webkit/WebSettings#setTextZoom(int)) と [`AndroidWebViewController.setTextZoom`](https://pub.dev/documentation/webview_flutter_android/latest/webview_flutter_android/AndroidWebViewController/setTextZoom.html)。
