---
title: "修正: Flutter の No Material widget found"
description: "サブツリーを Material(type: MaterialType.transparency) で包むか、画面を Scaffold の中に置いてください。MaterialApp だけでは Material の祖先は提供されないため、TextField や InkWell が失敗します。"
pubDate: 2026-08-04
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "material"
lang: "ja"
translationOf: "2026/08/fix-no-material-widget-found-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-04
---

`No Material widget found` は、いま構築した widget (`TextField`、`InkWell`、`ListTile`、`Chip`、`Switch`、`Slider` など) がツリーを上にたどって `Material` の祖先を探したものの、見つからなかったことを意味します。最も手早く安全な修正は、サブツリーを `Material(type: MaterialType.transparency, child: ...)` で包むことです。見た目は一切変わりません。構造的な修正は、画面を `Scaffold` の中に置くことです。注意すべき点として、`MaterialApp` 単体では `Material` は**提供されません**。Flutter 3.44 stable、Dart 3.x で検証しています。

## エラーの実際の出力

このアサーションは失敗した widget の `build` メソッドから投げられるため、最初の行に祖先を見つけられなかった widget の名前が出ます。

```
======== Exception caught by widgets library ===================================
The following assertion was thrown building TextField(dirty, state: _TextFieldState#3f2a1):
No Material widget found.

TextField widgets require a Material widget ancestor within the closest LookupBoundary.
In Material Design, most widgets are conceptually "printed" on a sheet of
material. In Flutter's material library, that material is represented by the
Material widget. It is the Material widget that renders ink splashes, for
instance. Because of this, many material library widgets require that there be
a Material widget in the tree above them.

To introduce a Material widget, you can either directly include one, or use a
widget that contains Material itself, such as a Card, Dialog, Drawer, or
Scaffold.

The specific widget that could not find a Material ancestor was:
  TextField
The ancestors of this widget were:
  Center
  Semantics
  ...
```

これとは別の文面に遭遇することもあり、そちらは本質的に異なる問題です。

```
No Material widget found within the closest LookupBoundary.
There is an ancestor Material widget, but it is hidden by a LookupBoundary.
```

こちらは、上位に `Material` は確かに存在するものの、`LookupBoundary` が意図的に探索を遮っていることを意味します。これについては後半に専用の節を設けています。

## 実際に Material の祖先を必要とする widget

これが重要なのは、対象が「`package:flutter/material.dart` にあるものすべて」よりずっと狭いからです。Flutter 3.44 の stable ブランチで `packages/flutter/lib/src/material/` を `assert(debugCheckHasMaterial(context))` で検索すると、実際の集合が得られます。

- `InkWell`、`InkResponse` (`InkResponse.debugCheckContext` 経由)、`Ink`
- `TextField`
- `ListTile`
- `Chip`、`InputChip`、`ActionChip`、`ChoiceChip`、`FilterChip`
- `Checkbox`、`Radio`、`Switch`、`Slider`
- `DropdownButton`
- `DataTable`
- `TabBar`
- `Stepper`
- `ExpandIcon`

同じくらい有用なのは、この一覧に*ない*ものです。`ElevatedButton`、`FilledButton`、`OutlinedButton`、`TextButton`、`FloatingActionButton`、`Card`、`Tooltip` はアサーションを行いません。いずれも内部で自前の `Material` を構築し、そのインク描画面を自分の子の下に敷いているからです。ボタンだらけの画面が `Scaffold` の外でも問題なく動くのに、`TextField` を 1 つ追加した途端に落ちるのはこのためです。

`IconButton` は知っておく価値のある特殊なケースです。そのアサーションは Material 2 のコードパスにしか存在しません。`theme.useMaterial3` が true のとき `build` は `_SelectableIconButton` を返して早期に抜け、`assert(debugCheckHasMaterial(context))` はその return より後ろに置かれています。Flutter 3.16 以降 `useMaterial3` の既定値は `true` なので、素の `IconButton` はもう `Material` の祖先を必要としません。テーマを `useMaterial3: false` に戻すと、また失敗するようになります。

## MaterialApp では足りない理由

ここがほぼ全員がはまる箇所であり、名前からは読み取れません。`MaterialApp` が用意するのは `Theme`、`MaterialLocalizations`、`Navigator`、`ScaffoldMessenger`、そして `WidgetsApp` です。`Material` はどこにも挿入しません。`packages/flutter/lib/src/material/app.dart` には `Material(` という構築が 1 か所もありません。

`Material` は `Scaffold` から来ます。その State の `build` がレイアウト全体を 1 つの `Material` で包んでいます。

```dart
// Flutter 3.44, packages/flutter/lib/src/material/scaffold.dart
child: ScrollNotificationObserver(
  child: Material(
    color: widget.backgroundColor ?? themeData.scaffoldBackgroundColor,
    child: Builder(...),
  ),
),
```

`Card`、`Dialog`、`Drawer`、そして `showModalBottomSheet` が構築するシートについても同様で、いずれも子の周りに `Material` を構築します。エラーのヒントが挙げているのはまさにこの一覧であり、実際にそれを行っている widget がこれらだからこそ、この一覧になっています。

## 最小の再現コード

12 行で、最初のフレームから失敗します。

```dart
// Flutter 3.44, Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      home: Center(child: TextField()), // throws: No Material widget found.
    );
  }
}
```

`TextField` を `ElevatedButton` に替えると描画されます。`ListTile` に替えるとまた失敗します。原因になっている材料は決して `MaterialApp` ではなく、アプリと widget のあいだに `Scaffold` (あるいは他の `Material` の担い手) が存在しないことです。

## 修正 1: 画面を Scaffold の中に置く

失敗している widget が画面の一部なら、これが回避策ではなく正しい修正です。`Material` に加えて、背景色、アプリバーの領域、セーフエリアの処理、キーボードのインセットまで手に入ります。widget はもともとこれらの上に載る前提で設計されています。

```dart
// Flutter 3.44, Dart 3.x
class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Sign in')),
        body: const Padding(
          padding: EdgeInsets.all(16),
          child: TextField(
            decoration: InputDecoration(labelText: 'Email'),
          ),
        ),
      ),
    );
  }
}
```

他の修正に手を伸ばすのは、`Scaffold` が本当にそぐわない場合だけにしてください。overlay のエントリ、widget テスト、通常のルートツリーの外で描画されるフラグメントなどです。

## 修正 2: MaterialType.transparency を指定した Material

インクの描画面は必要だが見た目は変えたくない場合、この修正はコストがゼロです。

```dart
// Flutter 3.44, Dart 3.x
Material(
  type: MaterialType.transparency,
  child: InkWell(
    onTap: _handleTap,
    child: const Padding(
      padding: EdgeInsets.all(12),
      child: Text('Tap me'),
    ),
  ),
)
```

この type は見た目以上に重要です。type によって 2 つの挙動が変わり、どちらも `Material` の build メソッドに現れています。

```dart
// Flutter 3.44, packages/flutter/lib/src/material/material.dart
final Color? backgroundColor = widget.color ?? switch (widget.type) {
  MaterialType.canvas => theme.canvasColor,
  MaterialType.card => theme.cardColor,
  MaterialType.button || MaterialType.circle || MaterialType.transparency => null,
};
// ...
child: _InkFeatures(
  absorbHitTest: widget.type != MaterialType.transparency,
  color: backgroundColor,
  ...
),
```

素の `Material(child: ...)` は既定で `MaterialType.canvas` になり、背後にあったものの上に `theme.canvasColor` の不透明な矩形を描き、`absorbHitTest: true` を設定します。その結果、それまで下の widget に届いていたポインタイベントを飲み込んでしまいます。`MaterialType.transparency` は何も描かず、何も吸収しません。既存のレイアウトに手を入れているのなら、必ず `transparency` から始めてください。クラッシュを、静かに壊れたジェスチャーやグラデーションの上の白い矩形と交換せずに済みます。

`transparency` でも免れないことが 1 つあります。`Material` は常に子を `AnimatedDefaultTextStyle` で包み、`widget.textStyle ?? Theme.of(context).textTheme.bodyMedium` を適用します。新たに包んだサブツリー内のスタイル未指定の `Text` が急にサイズや色を変えたなら、原因はこれです。明示的に `textStyle` を渡すか、`Text` widget 側でスタイルを指定してください。

## 修正 3: すでに Material を内包しているコンテナ widget を使う

正解が `Scaffold` でも生の `Material` でもないこともあります。そのコンテナ自体がもともと必要だった場合です。

```dart
// Flutter 3.44, Dart 3.x
Card(
  child: ListTile(                    // ListTile asserts; Card supplies the Material
    leading: const Icon(Icons.person),
    title: const Text('Marius'),
    onTap: _openProfile,
  ),
)
```

`showDialog`、`showModalBottomSheet`、`Drawer` はいずれも `Material` を無償で提供するため、その内側では `ListTile` や `TextField` が `Scaffold` なしで動きます。注意すべき失敗パターンは `showGeneralDialog` です。その `pageBuilder` は `Material` のラッパーを一切付けずに、あなたの widget をそのまま返します。自分で包むか、`Dialog` を使ってください。

`Overlay` のエントリも同じ形の問題を抱えます。`OverlayEntry` の builder は `Overlay` の子としてマウントされ、画面の `Scaffold` の子にはなりません。そのため、挿入したコードがツリーのどれほど深い位置にあっても、`Scaffold` の `Material` は継承されません。

## 修正 4: WidgetsApp を使っているなら MaterialApp が必要

アプリのルートが `WidgetsApp` や `CupertinoApp` で、それでも Material の widget を使っているなら、このエラーと、その兄弟である `No MaterialLocalizations found` の両方が出ます。これは [flutter/flutter#103843](https://github.com/flutter/flutter/issues/103843) で不正な使い方として close されており、メンテナーの判断は妥当です。`MaterialApp` に移行するか、`Material` と `Localizations` のスコープを自分で追加してください。ほとんどの場合、`MaterialApp` のほうが安上がりな答えです。

## LookupBoundary のバリエーション

`within the closest LookupBoundary` という文面は、探索が遮断されたことを意味します。`debugCheckHasMaterial` は素の要素探索ではなく `LookupBoundary.findAncestorWidgetOfExactType<Material>(context)` を使っており、上位に何の問題もない `Material` があっても `LookupBoundary` は探索をそこで打ち切ります。

フレームワークのコードで `LookupBoundary` を挿入している場所は `view.dart` だけです。

```dart
// Flutter 3.44, packages/flutter/lib/src/widgets/view.dart (ViewAnchor.build)
return _MultiChildComponentWidget(
  views: <Widget>[if (view != null) LookupBoundary(child: view!)],
  child: child,
);
```

つまり `ViewAnchor` を通して 2 つ目の `FlutterView` に描画している場合 (独自のプラットフォームビューに表示するツールチップ、デスクトップのサブウィンドウなど)、この境界は意図的なものです。そのビューの内容は独立したレンダーツリーであり、ホストビュー側の祖先に暗黙のうちに依存してはならないからです。修正は、境界を越えて手を伸ばそうとするのではなく、新しいビューに専用の `Material` (または専用の `Scaffold`) を与えることです。これは [Flutter のデスクトップアプリでマルチウィンドウ対応を有効にする](/ja/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/)ときに出会う、とりわけ鋭い落とし穴の 1 つです。

サブツリーを隔離するために自分で `LookupBoundary` を挿入した場合も同じ規則が当てはまります。サブツリーが必要とするものはすべて、その内側になければなりません。

## 落とし穴と紛らわしいケース

**debug では投げるが release では投げない。** `debugCheckHasMaterial` は `assert(() { ... }())` で包まれているため、release ビルドからは完全に取り除かれ、関数は単に `true` を返します。`Material` のない `TextField` は `--release` では描画され、debug では落ちます。これが issue 103843 の背後にある混乱そのものです。「release では動く」ことを、ツリーが正しい証拠として扱ってはいけません。インク効果が実際に発火した瞬間に `Material.of(context)` が走り、こちらは release でも例外を投げます。"Material.of() was called with a context that does not contain a Material widget."

**スプラッシュが見えないがエラーは出ない。** 別のバグですが、隣接した領域です。インクのスプラッシュは `Material` 自体の上に、その上に描かれるすべてのものの*下*に描画されます。そのため `Container(color: ...)` に包まれた `InkWell` は、コンテナの不透明な塗りの裏側にスプラッシュを描いてしまいます。`Container(color: x)` を `Ink(color: x)` に置き換える (または色を `Material` 側に指定する) と解決します。`Ink` は装飾を親の `Material` に描くため、スプラッシュがその上に乗るからです。関連: [Flutter の Container での Cannot provide both a color and a decoration](/ja/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/)。

**アプリでは動くのに widget テストで失敗する。** `tester.pumpWidget(const TextField())` が失敗する理由は `runApp` の場合と同じです。widget テストでは祖先を明示的に書く必要があります。`MaterialApp(home: Scaffold(body: TextField()))`、少なくとも `Material(child: Directionality(textDirection: TextDirection.ltr, child: ...))` です。`Directionality` の欠落も `MediaQuery` の欠落も、`debugCheckHasDirectionality` や `MediaQuery.of` から同じ形のエラーを出します。

**アプリ全体を 1 つの Material で包まないでください。** 動きはしますが、罠です。アプリレベルの `Material` が 1 つだけだと、アプリ中のインクスプラッシュがすべて同じ面に描画され、画面ごとの背景色は無効化され、`bodyMedium` の既定テキストスタイルが全体に適用されます。エラーを解消できる最小のスコープに `Material` を追加してください。

**Material をネストするとスプラッシュが乗る面が変わります。** `Material.of` は*最も近い*祖先を解決するため、`borderRadius` や `shape` を持つ内側の `Material` はスプラッシュをその形状にクリップします。カスタムカードでは通常これが望ましい挙動であり、丸いはずのスプラッシュが四角く見える原因になることもたまにあります。

**`No MaterialLocalizations found` は別の祖先の欠落です。** 上方向にたどる仕組みは同じでスコープが違い、`debugCheckHasMaterialLocalizations` が出します。`Material` を追加しても直りません。`MaterialApp` か `Localizations` のデリゲートを追加すれば直ります。

## 関連記事

- [修正: ScaffoldMessenger.of() was called with a context that does not contain a Scaffold](/ja/2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter/)：1 階層上で起きる同じ祖先探索の失敗と、必要な widget より下の context を得る `Builder` のテクニック。
- [修正: Flutter の Looking up a deactivated widget's ancestor is unsafe](/ja/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/)：祖先は存在するのに、探索がライフサイクルの誤ったタイミングで起きる場合。
- [修正: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets](/ja/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/)：Flutter が build 中に検出する、もう 1 つの「widget ツリーの位置が誤っている」構造的アサーション。
- [Flutter のデスクトップアプリでマルチウィンドウ対応を有効にする方法](/ja/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/)：実際のアプリで `LookupBoundary` が祖先探索を遮り始める場面。
- [Material 3 の ColorScheme で Flutter アプリのアクセントカラーを設定する方法](/ja/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/)：色を渡さなかったときに `Material` が拾う `canvasColor` と `scaffoldBackgroundColor`。

## 参考情報

- [debugCheckHasMaterial、Flutter API リファレンス](https://api.flutter.dev/flutter/material/debugCheckHasMaterial.html)：アサーション本体。`LookupBoundary` の分岐と正確なヒント文を含みます。
- [Material クラス、Flutter API リファレンス](https://api.flutter.dev/flutter/material/Material-class.html)：`MaterialType` の値、クリッピング、エレベーション、インク効果の取り付け方。
- [Ink クラス、Flutter API リファレンス](https://api.flutter.dev/flutter/material/Ink-class.html)：`Material` の上に描かれた不透明な装飾によってスプラッシュが隠れる理由と、`Ink` がそれを回避する仕組み。
- [flutter/flutter#103843: Error "No Material widget found.", but not in release build](https://github.com/flutter/flutter/issues/103843)：メンテナーが確認した debug 限定のアサーション。`WidgetsApp` の不正な使い方として close されています。
- [flutter/flutter `packages/flutter/lib/src/material/debug.dart` (stable)](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/material/debug.dart)：`debugCheckHasMaterial` と `debugCheckHasMaterialLocalizations` のソース。
