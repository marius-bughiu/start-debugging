---
title: "修正: Flutter の BoxConstraints forces an infinite height エラー"
description: "高さの上限がない親 (Column や ListView など) の中で、ウィジェットが height: double.infinity を要求しています。Expanded、有限の高さ、LimitedBox、または SliverFillRemaining を使って解決します。"
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "constraints"
lang: "ja"
translationOf: "2026/10/fix-boxconstraints-forces-an-infinite-height-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-06
---

`BoxConstraints forces an infinite height` は、あるウィジェットが高さをちょうど `double.infinity` ピクセルにするよう要求したものの、その親にはその要求を丸め込むための高さの上限がなかった、という意味です。よくある原因は、`Column`、`ListView`、`SingleChildScrollView` の直下に置かれた `SizedBox(height: double.infinity)`、`Container(height: double.infinity)`、`SizedBox.expand`、`BoxConstraints.expand()` です。解決策は、有限なものが何もない場所で "無限" を要求するのをやめることです。`Column` の中では `Expanded` を使う、ボックスに具体的な数値を与える、`LimitedBox` で包む、あるいは "画面の残りを埋めつつ、スクロールもできる" ようにしたいなら `SliverFillRemaining` に切り替えます。以下の内容はすべて Flutter 3.44.8 (stable) と Dart 3.12.2 で再現を確認しています。

わかりにくいのは、`height: double.infinity` がごく普通の書き方だという点です。ほとんどの場合は問題なく動きます。高さの制約を設定する直近の祖先が "好きな高さを選んでよい" と言う場合にだけ失敗しますが、Column やスクロールビューはまさにそう言います。

## エラーの全体像

これは Flutter が最初に出力するブロックです。スタックトレースは省略しています (実際には `RenderProxyBoxMixin.performLayout` のフレームが約 100 個続きます)。

```
══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═══════════════════════════════
The following assertion was thrown during performLayout():
BoxConstraints forces an infinite height.
These invalid constraints were provided to _RenderColoredBox's layout() function by the following
function, which probably computed the invalid constraints in question:
  RenderConstrainedBox.performLayout (package:flutter/src/rendering/proxy_box.dart:296:14)
The offending constraints were:
  BoxConstraints(0.0<=w<=800.0, h=Infinity)
The relevant error-causing widget was:
  SizedBox
```

必要な情報は次の 3 点に集約されています。

- 問題のある制約に含まれる **`h=Infinity`**。これは *タイト* な無限の高さ、つまり最小値も最大値も無限大という意味です。これを満たせるものはありません。
- **`RenderConstrainedBox.performLayout`** は、この制約を計算した関数です。`RenderConstrainedBox` は `SizedBox`、`ConstrainedBox`、そして `Container` のサイズ指定部分の背後にあるレンダーオブジェクトです。つまり原因はほぼ常にこの 3 つのどれかです。
- **"The relevant error-causing widget was"** は、そのウィジェットのファイルと行を示します。IDE でクリックしてください。

このブロックの下には、祖先ごとに 1 つずつ `RenderBox was not laid out` というアサーションが連鎖し、さらに `Scaffold` のものも出ます。これらは副次的なものです。最初のエラーを直せばすべて消えます。この連鎖から来た方は、[RenderBox was not laid out の解説](/ja/2026/06/fix-renderbox-was-not-laid-out-in-flutter/)で、なぜこのように積み重なるのかを説明しています。

姉妹メッセージの `BoxConstraints forces an infinite width.` は同じバグを 90 度回転させたもので、`BoxConstraints forces an infinite width and infinite height.` は両方が同時に起きた場合です。この記事の内容は、幅と高さを入れ替えればそのまま当てはまります。

## なぜ起きるのか

Flutter のレイアウトには 1 つのルールしかありません。制約は下へ、サイズは上へ、位置は親が決める、というものです。すべての親は、幅と高さの最小値と最大値を持つ `BoxConstraints` を子に渡します。

`SizedBox(height: double.infinity)` と書いたとき、高さを無限大に設定しているのではありません。`minHeight: infinity, maxHeight: infinity` というタイトな制約を要求しているのです。`RenderConstrainedBox` はその要求を、自分の親が許可した範囲と `BoxConstraints.enforce` で突き合わせます。

```dart
// Flutter 3.44.8, package:flutter/src/rendering/box.dart (simplified)
BoxConstraints enforce(BoxConstraints constraints) {
  return BoxConstraints(
    minHeight: clampDouble(minHeight, constraints.minHeight, constraints.maxHeight),
    maxHeight: clampDouble(maxHeight, constraints.minHeight, constraints.maxHeight),
    // width is clamped the same way
  );
}
```

この丸め込みがあるため、この書き方は通常うまく動きます。`Scaffold` の body の中では、親が `0 <= h <= 600` と言うので、無限大は 600 に丸められ、ボックスは画面を埋めます。ところが `Column` は、フレックスでない各子にその主軸方向で `0 <= h <= Infinity` を渡し、縦方向の `ListView` や `SingleChildScrollView` も同様です。無限大を最大値が無限大の範囲に丸めても、結果は無限大のままです。その結果の制約が子の `layout()` に渡され、`debugAssertIsValid(isAppliedConstraint: true)` が実行されて、最小値が無限大であることを検出し、例外を投げます。

覚えておくべきルールはこれです。**`double.infinity` は "親が許す限り大きく" という意味です。親が有限の値を許している場合にだけ安全です。**

## 新しいアプリに貼り付けられる最小の再現コード

次の 3 つの body はいずれも Flutter 3.44.8 でエラーを投げます。`MaterialApp(home: Scaffold(body: ...))` の中でウィジェットテストとして実行しました。

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

// 1. A Column gives children unbounded height.
const columnRepro = Column(
  children: [
    Text('Header'),
    SizedBox(
      height: double.infinity,
      child: ColoredBox(color: Colors.red),
    ),
  ],
);

// 2. A vertical ListView gives children unbounded height.
final listRepro = ListView(
  children: [
    Container(height: double.infinity, color: Colors.red),
  ],
);

// 3. SizedBox.expand and BoxConstraints.expand() are the same request in disguise.
const scrollRepro = SingleChildScrollView(
  child: Column(
    children: [
      SizedBox.expand(child: ColoredBox(color: Colors.red)),
    ],
  ),
);
```

問題のある制約の表示は少し異なります。`Column` の再現では、Column の交差軸がルーズなため `BoxConstraints(0.0<=w<=800.0, h=Infinity)` と報告され、`ListView` と `SizedBox.expand` の再現では `BoxConstraints(w=800.0, h=Infinity)` と報告されます。バグも対処法も同じです。

誤解されやすい点が 1 つあります。`SizedBox` に **子がない** 場合、このメッセージは出ません。代わりに `RenderConstrainedBox object was given an infinite size during layout` が出ます。`layout()` を呼ぶ子がいないため、ボックスが自分自身を無限大のサイズにしようとするからです。原因は同じで、文言が違うだけです。

## 修正方法の詳細

無限の高さで何をしたかったのかを考えて、対処法を選んでください。

### 1. "Column の残りのスペースを埋めたい": Expanded を使う

これが最も多い意図です。`Column` の中で "残りをすべて使う" ことを表す方法は、無限のサイズではなく、フレックスな子です。

```dart
// Flutter 3.44.8, Dart 3.12.2
Column(
  children: [
    const Text('Header'),
    Expanded(
      child: Container(color: Colors.red), // no height at all
    ),
  ],
)
```

800x600 のサーフェスでのテストでは、赤いボックスは `Size(800.0, 580.0)` になりました。全体の高さからヘッダー 1 行分を引いた値です。`Expanded` が機能するのは、`Column` がフレックスな子を最後にレイアウトするためです。固定サイズの子が使った分を把握した後で、タイトかつ有限な高さを渡します。

これは `Column` 自体の高さに上限がある場合にしか使えません。その `Column` が `SingleChildScrollView` の中にあると、`Expanded` はこのエラーを `RenderFlex children have non-zero flex but incoming height constraints are unbounded` に置き換えるだけです。これは 1 つ上の階層での同じ問題で、対処法 3 と 4 で解決できます。

### 2. "とにかく高くしたい": 有限の数値を与える

ボックスがスクロールビューの中にある場合はスクロールされるので、"画面を埋める" ことは通常は意図したことではありません。具体的な高さを与えるか、画面から導出してください。

```dart
// Flutter 3.44.8, Dart 3.12.2
Builder(
  builder: (context) => ListView(
    children: [
      SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.5,
        child: const ColoredBox(color: Colors.red),
      ),
      // ... more children
    ],
  ),
)
```

これにより、高さ 600 ピクセルのサーフェスで `Size(800.0, 300.0)` のボックスになりました。`MediaQuery.of(context).size` より `MediaQuery.sizeOf(context)` を推奨します。キーボードのインセットなど `MediaQuery` のあらゆる変更ではなく、サイズが変わったときだけ再ビルドされるためです。

再利用可能なウィジェットで、上限のある親に置かれるか、ない親に置かれるかがわからない場合は、`LimitedBox` を使います。親に上限があるときは何もせず、ないときだけ最大値を制限します。

```dart
// Flutter 3.44.8, Dart 3.12.2
ListView(
  children: [
    LimitedBox(
      maxHeight: 200,
      child: Container(height: double.infinity, color: Colors.red),
    ),
  ],
)
```

`ListView` の中で、そのコンテナは `Size(800.0, 200.0)` でエラーなくレイアウトされました。同じウィジェットを上限のある親に置くと、代わりに親を埋めます。これはまさにこの状況に対して、公式の "Understanding constraints" ガイドが推奨しているパターンです。

### 3. "画面を埋めたいが、内容が長ければスクロールもしたい": SliverFillRemaining

これはログインフォームの場合です。ボタンを下端に置けるよう、列をビューポートの下端まで伸ばしたいが、小さい端末やキーボード表示中にはスクロールさせたい、というケースです。`hasScrollBody: false` を指定した `SliverFillRemaining` がそのための専用ウィジェットです。

```dart
// Flutter 3.44.8, Dart 3.12.2
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(child: SizedBox(height: 100)),
    SliverFillRemaining(
      hasScrollBody: false,
      child: Container(color: Colors.red),
    ),
  ],
)
```

赤いボックスは `Size(800.0, 500.0)` になりました。ビューポートから 100 ピクセルのヘッダーを引いた値そのものです。`hasScrollBody: false` は、その子自体がスクロール可能ではないことをスリヴァーに伝えます。そのため、子のサイズは少なくとも残りの範囲になり、子自身の高さの方が大きければその高さになります。子が `ListView` などのスクロールビューの場合は、`hasScrollBody` を既定値の `true` のままにしてください。

### 4. スリヴァーを使わない同等の方法: LayoutBuilder と ConstrainedBox

画面を `CustomScrollView` に移行する準備ができていない場合は、`SingleChildScrollView` のドキュメントに、ビューポートの高さを一度読み取り、タイトな無限サイズではなく *最小値* に変換するパターンが説明されています。

```dart
// Flutter 3.44.8, Dart 3.12.2
LayoutBuilder(
  builder: (context, viewport) => SingleChildScrollView(
    child: ConstrainedBox(
      constraints: BoxConstraints(minHeight: viewport.maxHeight),
      child: IntrinsicHeight(
        child: Column(
          children: [
            const Text('top'),
            Expanded(child: Container(color: Colors.red)),
            const Text('bottom'),
          ],
        ),
      ),
    ),
  ),
)
```

`LayoutBuilder` はスクロールビューの外側にあるので、`viewport.maxHeight` は有限です (ここでは 600)。`ConstrainedBox` は列に 600 の下限を与えますが、上限は与えません。そして `IntrinsicHeight` が `Column` に上限のある高さを与えるので、`Expanded` を使えるようになります。テストでは、2 つのテキスト行の間に 560 ピクセルの赤いボックスができました。`IntrinsicHeight` はサブツリーに対して追加のレイアウトパスが必要になるため、フォームなら問題ありませんが、長いリストには向きません。長いコンテンツには、対処法 3 か、[shrinkWrap vs Expanded vs slivers](/ja/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/)の選択肢を使ってください。

### 5. "行の高さに合わせたい": IntrinsicHeight と stretch

リスト内でこのエラーが起きる非常に多い原因は、隣の要素と同じ高さにしたい色付きのサイドバーや縦の区切り線です。

```dart
// Flutter 3.44.8, Dart 3.12.2
// Throws: BoxConstraints(w=4.0, h=Infinity)
ListView(
  children: const [
    Row(
      children: [
        SizedBox(width: 4, height: double.infinity, child: ColoredBox(color: Colors.blue)),
        Text('item'),
      ],
    ),
  ],
)
```

`Row` は、自分が受け取った上限のない縦方向の制約をそのままバーに渡します。先に行に最も高い子を測らせ、それに合わせてすべてを引き伸ばします。

```dart
// Flutter 3.44.8, Dart 3.12.2
ListView(
  children: const [
    IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(width: 4, child: ColoredBox(color: Colors.blue)),
          Text('item\nline2'),
        ],
      ),
    ),
  ],
)
```

バーには `height` を指定していません。`CrossAxisAlignment.stretch` が行と同じタイトな高さを与え、`IntrinsicHeight` がその高さを有限にします。リスト項目ごとに 1 つの `IntrinsicHeight` なら、一般的なリストでは十分に軽量です。

## 注意点と、似たエラー

- **`double.maxFinite` は解決策ではありません。** `double.infinity` を `double.maxFinite` に置き換えるとアサーションは出なくなりますが、テストではボックスが `Size(0.0, 1.7976931348623157e+308)` でレイアウトされました。宇宙より高いボックスを作ったことになり、その下にあるものには到達できません。コードレビューでこの "修正" を見つけたら、それは隠されただけの同じバグです。
- **このチェックはデバッグ専用です。** `debugAssertIsValid` は `assert` の中で実行されるため、リリースビルドではスキップされ、赤い画面ではなく灰色の領域やコンテンツの欠落になります。レイアウトのバグは必ずデバッグモードで再現してください。
- **横方向の `ListView` は問題ありません。** `ListView(scrollDirection: Axis.horizontal)` は子に上限のある *高さ* (自身の高さ) を渡すので、その中の `height: double.infinity` は正しく丸められます。テストでは `Size(100.0, 600.0)` になりました。このリストで壊れるのは `width: double.infinity` の方です。
- **`Vertical viewport was given unbounded height`** は逆の状況です。スクロール可能なものが `Column` の中に置かれており、無限のボックスがスクロール可能なものの中に置かれているわけではありません。対処法は重なりますが、これについては [Column の中の ListView のガイド](/ja/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/)で詳しく扱っています。
- **`Row` の中の `TextField`** は、Flutter 3.44.8 では最初のエラーとして `BoxConstraints` のメッセージではなく `An InputDecorator, which is typically created by a TextField, cannot have an unbounded width` を出します。フィールドを `Expanded` か固定幅の `SizedBox` で包んでください。
- **`ListView` を囲む `IntrinsicHeight`** はこのエラーを投げません。代わりに `RenderViewport does not support returning intrinsic dimensions` を投げます。遅延ビューポートはすべての子を測ることを拒否するためです。スクロール可能なものを intrinsic 系のウィジェットで包んではいけません。
- **`UnconstrainedBox`** は親の制約を完全に取り除くため、その中の無限の子は、画面に上限があってもこのエラーを投げます。両者の間に `LimitedBox` を置くか、`UnconstrainedBox` を外してください。
- **例外を投げずにオーバーフローする `Column`** は別の問題です。内容は有限ですが高すぎます。[RenderFlex overflowed のガイド](/ja/2026/05/fix-renderflex-overflowed-in-flutter/)を参照してください。

## 大きなウィジェットツリーで原因を見つける

"relevant error-causing widget" が共有コンポーネントを指している場合は、Flutter DevTools を開き、Widget Inspector でそのウィジェットを選択して、Layout Explorer に表示される制約を確認します。ツリーを上にたどり、高さの制約が `Infinity` になっている最初の祖先を探してください。それが上限を取り除いた `Column`、`ListView`、`Row`、または `UnconstrainedBox` です。修正は、その祖先に (上限を設ける) か、子に (無限を要求するのをやめる) 加えます。コードを `double.infinity`、`.expand(`、`BoxConstraints.expand` で検索すれば、たいてい 1 分もかからずに候補が見つかります。

## 関連記事

- [修正: Flutter の RenderBox was not laid out](/ja/2026/06/fix-renderbox-was-not-laid-out-in-flutter/)。このエラーに続いて発生する連鎖について。
- [無限の高さエラーなしで ListView を Column の中にネストする方法](/ja/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/)。
- [Flutter の長いリストにおける shrinkWrap、Expanded、スリヴァーの比較](/ja/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/)。
- [修正: Flutter の A RenderFlex overflowed](/ja/2026/05/fix-renderflex-overflowed-in-flutter/)。
- [修正: Flutter の CustomScrollView での RenderViewport expected a RenderSliver](/ja/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/)。`SliverFillRemaining` へ移行する際にこのエラーが出た場合に。

## 参考資料

- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) (Flutter ドキュメント)。`LimitedBox` と `UnconstrainedBox` の例を含みます。
- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors) (Flutter ドキュメント)。
- [BoxConstraints.enforce](https://api.flutter.dev/flutter/rendering/BoxConstraints/enforce.html) と [BoxConstraints.debugAssertIsValid](https://api.flutter.dev/flutter/rendering/BoxConstraints/debugAssertIsValid.html) (API リファレンス)。
- [SingleChildScrollView](https://api.flutter.dev/flutter/widgets/SingleChildScrollView-class.html)。"Centering, spacing, or aligning fixed-height content" のセクション。
- [SliverFillRemaining](https://api.flutter.dev/flutter/widgets/SliverFillRemaining-class.html) と [LimitedBox](https://api.flutter.dev/flutter/widgets/LimitedBox-class.html) (API リファレンス)。
- Flutter 3.44.8 SDK の `packages/flutter/lib/src/rendering/box.dart` と `proxy_box.dart`。ローカルで読みました。
