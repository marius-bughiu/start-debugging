---
title: "Flutter で ImageIcon が周囲の IconTheme の色でアイコンを着色するのを止める方法"
description: "ImageIcon は常に ColorFilter.mode(iconThemeColor, BlendMode.srcIn) を適用するため、多色の PNG がシルエットに潰れます。Flutter 3.47 ではこれを無効にする useOriginalColors が追加されました。color: null が効かなかった理由、useOriginalColors が黙って捨てるもの、古い SDK 向けの手書き代替を解説します。"
pubDate: 2026-09-08
template: how-to
tags:
  - "flutter"
  - "dart"
  - "material-design"
  - "how-to"
lang: "ja"
translationOf: "2026/09/how-to-stop-imageicon-from-tinting-an-icon-with-the-icontheme-color-in-flutter"
translatedBy: "claude"
translationDate: 2026-09-08
---

`ImageIcon` は画像を `color: IconTheme.of(context).color` とともに `Image` へ渡し、レンダーオブジェクトがそれを `ColorFilter.mode(color, BlendMode.srcIn)` に変換します。このフィルターは各ピクセルの RGB を捨ててアルファだけを残すため、多色のブランドマークは平坦なシルエット、たいていは黒か白になって出てきます。Flutter 3.47 以降、修正は引数ひとつです。`ImageIcon(AssetImage('assets/logo.png'), useOriginalColors: true)` と書きます。`color: null` を渡しても何も起きませんし、これまでも起きませんでした。`IconTheme.of` は具体的な色を返すことを契約として保証しており、不透明な黒にフォールバックするからです。3.44 以前にはこのフラグがないため、ウィジェットを素の `Image` に置き換え、ImageIcon が持つ 4 つのレイアウト引数を自分で再現します。以下はすべて現行の stable チャンネル、Flutter 3.47.2 と Dart 3.13.2 を対象としています。

## color: null で着色が止まらない理由

ウィジェット全体は 30 行ほどです。これが 3.47 で出荷されている `build` です。

```dart
// package:flutter/src/widgets/image_icon.dart, Flutter 3.47.2
@override
Widget build(BuildContext context) {
  final IconThemeData iconTheme = IconTheme.of(context);
  final double? iconSize = size ?? iconTheme.size;

  if (image == null) {
    return Semantics(
      label: semanticLabel,
      child: SizedBox(width: iconSize, height: iconSize),
    );
  }

  final double? iconOpacity = iconTheme.opacity;
  Color iconColor = color ?? iconTheme.color!;

  if (iconOpacity != null && iconOpacity != 1.0) {
    iconColor = iconColor.withOpacity(iconColor.opacity * iconOpacity);
  }

  return Semantics(
    label: semanticLabel,
    child: Image(
      image: image!,
      width: iconSize,
      height: iconSize,
      color: useOriginalColors ? null : iconColor,
      fit: BoxFit.scaleDown,
      excludeFromSemantics: true,
    ),
  );
}
```

要となる行は `Color iconColor = color ?? iconTheme.color!` です。この `!` は楽観ではなく、`IconTheme.of` が明示的に与えている保証です。この参照は最も近い周囲の `IconTheme` を解決し、結果が具体的かどうかを確認し、そうでなければ null のフィールドを `IconThemeData.fallback()` から埋めます。

```dart
// package:flutter/src/widgets/icon_theme.dart, Flutter 3.47.2
static IconThemeData of(BuildContext context) {
  final IconThemeData iconThemeData = _getInheritedIconThemeData(context).resolve(context);
  return iconThemeData.isConcrete
      ? iconThemeData
      : iconThemeData.copyWith(
          size: iconThemeData.size ?? const IconThemeData.fallback().size,
          // ...
          color: iconThemeData.color ?? const IconThemeData.fallback().color,
          opacity: iconThemeData.opacity ?? const IconThemeData.fallback().opacity,
          // ...
        );
}
```

そして `IconThemeData.fallback()` は `color = const Color(0xFF000000)` を設定します。`IconTheme.of(context).color` が null になるウィジェットツリーの状態は存在しません。したがって `ImageIcon.color` に今も付いている、`IconTheme` がなければ "defaults to not recolorizing the image" だという説明は、このウィジェットがとうの昔に失った動作を述べています。周囲にテーマがまったくなければ不透明な黒になり、これが「カラフルなアイコンが黒い塊になる」と報告される結果そのものです。

もうひとつの反射的な試みである `color: Colors.transparent` はさらに悪い結果になります。`BlendMode.srcIn` はソースの色を宛先のアルファに合成するため、完全に透明なソースは完全に透明な結果を生みます。アイコンは自分の色を見せる代わりに消えます。テーマのレベルにも手がかりはありません。`IconTheme.of` がそのまま返すような `IconThemeData` で「色なし」を表現できないからです。

## 再現コード: 1 枚の PNG が灰色になる 3 か所

アイコンの領域を自分で持つ Material のウィジェットは、その領域の上に `IconTheme` を設置します。したがって同じアセットがどこでも潰れます。以下は 3.47 でそのまま動きます。[独立パッケージ material_ui と cupertino_ui](/ja/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) への移行がまだなら、import を `package:flutter/material.dart` に置き換えてください。

```dart
// Flutter 3.47.2, Dart 3.13.2
import 'package:material_ui/material_ui.dart';

const AssetImage brandMark = AssetImage('assets/brand/logo.png');

class TintDemo extends StatelessWidget {
  const TintDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Tinting'),
        // Flattened to ColorScheme.onSurface.
        actions: const <Widget>[ImageIcon(brandMark)],
      ),
      body: Column(
        children: <Widget>[
          // Flattened to the button's resolved foreground color.
          ElevatedButton.icon(
            onPressed: () {},
            icon: const ImageIcon(brandMark),
            label: const Text('Open'),
          ),
          // Flattened to ListTileThemeData.iconColor.
          const ListTile(
            leading: ImageIcon(brandMark),
            title: Text('Account'),
          ),
          // Not flattened: no IconTheme is being applied to raw images.
          const Image(image: brandMark, width: 24, height: 24),
        ],
      ),
    );
  }
}
```

最後の行が決め手です。同じアセット、同じサイズ、カラーフィルターなし、色は正しく出ます。PNG に問題はなく、アセットの解決にも問題はありません。画像がおかしいときに最初に疑われるのはたいてい後者ですが、その失敗の見た目はまったく異なり、[pubspec.yaml に画像を追加した後の Flutter の unable to load asset](/ja/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/) で扱っています。

## ImageIcon を元の色に切り替える手順

1. `flutter --version` で SDK を確認します。`useOriginalColors` は [PR 180491](https://github.com/flutter/flutter/pull/180491) として 2026-04-27 に入り、Flutter 3.47 の stable リリースで出荷されました。それより古い場合は、下の手書き代替に進んでください。
2. 呼び出し側から `color` 引数を削除します。コンストラクターは `useOriginalColors` が true のとき `color` が null であることを assert しているため、両方を残すと確実なエラーになります。
3. `useOriginalColors: true` を追加します。変更はこれだけです。`build` は `color: null` を `Image` に渡すようになり、レンダーオブジェクトに `ColorFilter` は設置されず、デコードされたピクセルがそのままキャンバスに届きます。
4. そのアイコンの状態依存のバリエーションをすべて見直します。選択、非選択、無効、押下の各状態はいずれも異なる `IconThemeData` の色として表現されており、あなたはそのすべてから一度に降りたことになります。
5. 無効状態の見た目を何が担うかを決めます。ウィジェットが半透明の着色色に頼ってグレーアウトを表現していたなら、アイコンを `Opacity` で包むか、彩度を落とした別アセットを用意します。

完成した呼び出し側は次のようになります。

```dart
// Flutter 3.47.2, Dart 3.13.2
const ImageIcon(
  AssetImage('assets/brand/logo.png'),
  useOriginalColors: true,
  semanticLabel: 'Acme',
)
```

サイズは引き続き周囲の `IconTheme` から取られるため、アイコンは隣の `Icon` ウィジェットと揃ったままです。消えるのはカラーフィルターだけです。

## useOriginalColors が着色と一緒に捨てるもの

`build` の重要な 2 行をもう一度見てください。

```dart
if (iconOpacity != null && iconOpacity != 1.0) {
  iconColor = iconColor.withOpacity(iconColor.opacity * iconOpacity);
}
// ...
color: useOriginalColors ? null : iconColor,
```

`IconTheme.opacity` は着色色のアルファに畳み込まれ、その着色色だけが不透明度を画像に届ける唯一の経路です。`useOriginalColors: true` にすると、計算された `iconColor` は不透明度ごと丸ごと破棄されます。`IconTheme(data: IconThemeData(opacity: 0.38), ...)` でサブツリーを暗くしている祖先は、周囲の `Icon` をすべて薄くしながら、あなたの画像だけを全強度で残します。

半透明の着色色についても同じで、Material が今日の無効アイコンを表現しているのはまさにこの方法です。`NavigationBar` のデフォルトは無効状態を `onSurfaceVariant` のアルファ 38 パーセントに解決し、そのアルファが `srcIn` を通ってレンダリング結果まで届きます。フィルターから降りると、無効な destination が有効に見えてしまいます。

周囲の不透明度を取り戻したい場合は、自分で読み取って適用します。

```dart
// Flutter 3.47.2, Dart 3.13.2
class BrandIcon extends StatelessWidget {
  const BrandIcon({super.key, required this.image});

  final ImageProvider image;

  @override
  Widget build(BuildContext context) {
    final double opacity = IconTheme.of(context).opacity ?? 1.0;
    final Widget icon = ImageIcon(image, useOriginalColors: true);
    return opacity == 1.0 ? icon : Opacity(opacity: opacity, child: icon);
  }
}
```

`Opacity` は実際の合成レイヤーであり無料ではありません。だからこそ無条件に包むのではなく、よくある `1.0` のケースを弾くガードを残す価値があります。

## 3.47 より前の代替実装

バックポートできるフラグはなく、同じ結果に至る `color` の値の組み合わせもないため、3.44 以前では `ImageIcon` の使用をやめます。ImageIcon 自体が短いので代替も短く済みます。残す価値があるのは、サイズの参照、`BoxFit.scaleDown`、そしてラベルをラッパーに置いて画像をツリーから除外するセマンティクスの分割です。

```dart
// Flutter 3.44 or older. Drop-in for ImageIcon that keeps the image's colors.
import 'package:flutter/widgets.dart';

class OriginalColorImageIcon extends StatelessWidget {
  const OriginalColorImageIcon(
    this.image, {
    super.key,
    this.size,
    this.semanticLabel,
  });

  final ImageProvider image;
  final double? size;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final double? iconSize = size ?? IconTheme.of(context).size;
    return Semantics(
      label: semanticLabel,
      child: Image(
        image: image,
        width: iconSize,
        height: iconSize,
        fit: BoxFit.scaleDown,
        excludeFromSemantics: true,
      ),
    );
  }
}
```

代わりに素の `Image.asset` を書くと落としやすい点が 2 つあります。`BoxFit.scaleDown` は決して拡大しません。固有サイズがアイコンの箱より小さいアセットは固有サイズのまま中央に配置され、これは `ImageIcon` の挙動と一致し、`BoxFit.contain` なら生じるぼやけを避けられます。そして内側の `Image` に付けた `excludeFromSemantics: true` は、ラッパーのラベルと画像自身のラベルの両方をアクセシビリティツリーが持ってしまうのを防ぎます。`ImageIcon` が同じ理由で行っていることです。

## 問題の IconTheme を設置するウィジェット

| ウィジェット | 周囲の IconTheme に入れるもの |
| --- | --- |
| `AppBar`, `SliverAppBar` | leading ウィジェット用の `iconTheme` と actions 用の `actionsIconTheme`、既定値は `ColorScheme.onSurface` |
| `ElevatedButton.icon` とその他の `ButtonStyleButton` 系 | `iconTheme` を解決済みの前景色とアイコンサイズでマージした `AnimatedTheme` |
| `IconButton` | 現在のウィジェット状態に対して解決された前景色 |
| `NavigationBar`, `NavigationRail` | 選択、非選択、無効ごとに別々に解決される `WidgetStateProperty<IconThemeData>` |
| `BottomNavigationBar` | 選択項目と非選択項目の色 |
| `ListTile` | `ListTileThemeData.iconColor`、または `enabled: false` のときの無効色 |
| `Chip` とその派生 | チップ自身のアイコンテーマ |
| `TabBar` | `labelColor` と `unselectedLabelColor` |

よく提出されるバグ報告、最も有名なものでは [flutter/flutter#81643](https://github.com/flutter/flutter/issues/81643) が invalid として閉じられるのはこのためです。このウィジェットはアイコンウィジェットがすべきことを正確に行っています。Material のテーマシステムは、アイコンを再着色してよい単色のシルエットだと仮定しており、[Material 3 の ColorScheme が Flutter アプリ全体のアクセントカラーを決める](/ja/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)仕組みも同じ仮定の上に立っています。

## 選択と非選択の destination には別々のウィジェットが要る

`NavigationBar` はアイコンを差し替えるのではありません。両方を構築し、それぞれを自前の `IconTheme.merge` で包み、`Stack` の中でクロスフェードします。

```dart
// package:flutter/src/material/navigation_bar.dart, Flutter 3.47.2
final Widget selectedIconWidget = IconTheme.merge(
  data: enabled ? selectedIconTheme : disabledIconTheme,
  child: selectedIcon ?? icon,
);
final Widget unselectedIconWidget = IconTheme.merge(
  data: enabled ? unselectedIconTheme : disabledIconTheme,
  child: icon,
);
```

`icon` は非選択の枠に使われ、`selectedIcon` が null なら選択の枠にも使われるため、`useOriginalColors: true` のウィジェットを 1 つ渡すと両方の状態が着色から外れます。destination がアクティブなときだけブランドカラーを出したいなら、ウィジェットを 2 つ渡します。

```dart
// Flutter 3.47.2, Dart 3.13.2
NavigationDestination(
  icon: const ImageIcon(AssetImage('assets/brand/logo_mono.png')),
  selectedIcon: const ImageIcon(
    AssetImage('assets/brand/logo.png'),
    useOriginalColors: true,
  ),
  label: 'Acme',
)
```

非選択の枠に置いた単色アセットは引き続き着色されます。それが狙いどおりで、他の destination と同じようにテーマに追従し、フルカラーのマークは選択時だけ現れます。

## 出荷前に知っておきたい落とし穴

**assert は debug モードのチェックであり、自分でそうしない限りコンパイルエラーではありません。** `ImageIcon` は `const` コンストラクターを持つため、`const ImageIcon(image, useOriginalColors: true, color: Colors.red)` はコンパイル時に評価され、アナライザーがその場で拒否します。`const` なしで書くと debug と profile のビルドでしか例外になりません。release では assert が取り除かれ、`build` は変わらず `useOriginalColors ? null : iconColor` を評価するので、指定した色は黙って無視されます。こうした呼び出し側では `const` を使いましょう。

**`Icon` に相当する機能はなく、必要でもありません。** フォントベースのアイコンは単一グリフの輪郭であり、保持すべき元の色がありません。多色のグリフが必要なら、`IconFont` ではなく画像かベクターが必要です。

**`flutter_svg` は逆向きに動きます。** `SvgPicture.asset` は `IconTheme` をまったく読まないため、SVG は既定で自分の色を保ち、着色したいときに明示的な `colorFilter: ColorFilter.mode(IconTheme.of(context).color!, BlendMode.srcIn)` で有効化します。SVG が意図せず単色になるときは、周囲のテーマではなくファイル内にハードコードされた `fill` を探してください。

**スクリーンショットを目視するのではなく、ウィジェットテストで検証しましょう。** レンダリングされたピクセルの検査は難しいですが、ウィジェットの構成はそうではありません。

```dart
// Flutter 3.47.2, Dart 3.13.2
testWidgets('brand mark ignores the ambient icon color', (WidgetTester tester) async {
  await tester.pumpWidget(
    const IconTheme(
      data: IconThemeData(color: Color(0xFFFF0000)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: ImageIcon(
          AssetImage('assets/brand/logo.png'),
          useOriginalColors: true,
        ),
      ),
    ),
  );

  expect(tester.widget<Image>(find.byType(Image)).color, isNull);
});
```

golden テストでも回帰は捕まえられますが、こちらは読みやすいメッセージで落ち、アセットバンドルの挙動に依存せずに動きます。

**適切な解像度を出荷しましょう。** `BoxFit.scaleDown` は拡大しないため、3x 端末で 24 論理ピクセルのアイコン枠には `assets/brand/3.0x/` に置いた 72 ピクセルのアセットが必要です。シルエットに潰されている間は問題なく見えていた 24 ピクセルの PNG 1 枚は、実際のピクセルが見えるようになった途端にはっきりぼやけて見えます。

### 次に読む

- [Flutter の Material と Cupertino の import を material_ui と cupertino_ui パッケージへ移行する](/ja/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)
- [Material 3 の ColorScheme で Flutter のアクセントカラーを設定する方法](/ja/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)
- [Fix: pubspec.yaml に画像を追加した後の Flutter の unable to load asset](/ja/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/)
- [Fix: Flutter の Container で cannot provide both a color and a decoration](/ja/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)
- [Flutter の Key とは何か、省略するとどんなバグが起きるのか](/ja/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)

### 出典

- [ImageIcon クラス、Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/ImageIcon-class.html)
- [Added useOriginalColors flag which allows ImageIcon to bypass IconTheme colorization, flutter/flutter PR 180491](https://github.com/flutter/flutter/pull/180491)
- [Flutter 3.47.0 リリースノート](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)
- [IconTheme.of、Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/IconTheme/of.html)
- [BlendMode.srcIn、dart:ui API リファレンス](https://api.flutter.dev/flutter/dart-ui/BlendMode.html)
- [ImageIcon displays a colourful icon as black & white, flutter/flutter issue 81643](https://github.com/flutter/flutter/issues/81643)
