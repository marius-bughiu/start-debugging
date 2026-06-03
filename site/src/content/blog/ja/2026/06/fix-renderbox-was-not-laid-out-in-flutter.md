---
title: "解決: Flutter の RenderBox was not laid out"
description: "RenderBox was not laid out はほぼ常に二次的なエラーです。その上にある最初の layout のアサーション、通常は制約が非有界な scrollable を見つけて修正してください。"
pubDate: 2026-06-03
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "renderbox"
lang: "ja"
translationOf: "2026/06/fix-renderbox-was-not-laid-out-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-03
---

`RenderBox was not laid out` は、サイズが一度も計算されていない render box に対して Flutter が描画または hit-test を試みたことを意味します。これはほぼ常に派生的なエラーです。より早い段階の layout のアサーションがツリーの一部に対する `performLayout` を中断させ、このメッセージはその残骸にすぎません。本当の修正は、コンソールを上にスクロールして最初のエラーまで遡ることです。それは通常、スクロール軸に非有界な制約を与えられた scrollable (`ListView`、`GridView`、`SingleChildScrollView`) です。そのウィジェットを `Expanded`、固定サイズ、または `shrinkWrap` で制約すれば、このエラーは消えます。このガイドは Flutter 3.44 (安定版、2026 年 5 月) と Dart 3.x を使用します。

スローされるアサーションは `package:flutter/src/rendering/box.dart` の `hasSize` です。`RenderBox` は `performLayout` のパスの間だけサイズを得ます。その box の layout が一度も成功して実行されていなければ、`.size` の要求 (描画と hit-testing の両方が行います) がガードを発動させます。だからこのメッセージは正確でありながら、それ単体では役に立ちません。被害者を名指ししても、犯人は名指ししないのです。

## コンテキストの中のエラー

コンソールのブロックは次のようになります。正確なウィジェット名と 16 進の ID は変わりますが、形は一定です。

```
======== Exception caught by rendering library =====================
The following assertion was thrown during performLayout():
RenderBox was not laid out: RenderShrinkWrappingViewport#4aefd
  relayoutBoundary=up13 NEEDS-PAINT NEEDS-COMPOSITING-BITS-UPDATE
'package:flutter/src/rendering/box.dart': Failed assertion: line 1966
  pos 12: 'hasSize'

The relevant error-causing widget was:
  ListView  lib/widgets/feed.dart:58
====================================================================
```

重要な点が 2 つあります。1 つ目は、名指しされた render object (`RenderShrinkWrappingViewport`、`RenderPadding`、`RenderRepaintBoundary` など) が、どのサブツリーで layout が失敗したかを教えてくれることです。2 つ目は、こちらのほうが重要ですが、これが唯一の例外であることはまれだという点です。debug モードでは、Flutter は最初の失敗を出力した後もレンダリングを試み続けるため、これらの `hasSize` アサーションのカスケードが生じます。対処すべきメッセージはカスケードの一番上にあるものであって、あなたの目が留まったものではありません。

## なぜ起きるのか

`RenderBox` は `performLayout` がサイズを割り当てた後にのみサイズを持ちます。3 つの状況が box をサイズなしのまま残します。

box が満たせない制約を与えられたため、その box 自身の `performLayout` が例外をスローした。典型的なのは、スクロール軸に非有界な制約を受け取った scrollable です。縦方向の `ListView` は、どれだけの viewport をレンダリングするか知るために有界な高さを必要とします。無限の高さを与えると `Vertical viewport was given unbounded height` をスローし、layout は中断され、その後にサイズを読もうとするすべての祖先が `RenderBox was not laid out` を報告します。

親が、子を先に layout せずに描画または hit-test した。これはカスタム `RenderObject` のバグです。`paint` が `child.size` を読むのに `performLayout` が `child.layout(...)` の呼び出しを忘れている render object を書いた場合です。子は一度もサイズを得ていません。

誰かが layout フェーズの外で `.size` を読んだ。`build`、`initState`、または同期コールバックの中で、最初のフレームがウィジェットを layout する前に `context.size` や `renderBox.size` を読むと、同じアサーションが発動します。サイズはまだ単純に存在していません。

統一的な規則は Flutter の layout 契約です。制約は下りていき、サイズは上がってくる、そして box のサイズが有効なのは、その `performLayout` の終了から次の `markNeedsLayout` までの間だけです。詳しくは公式ページ [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) を参照してください。Flutter のあらゆる layout エラーにとって最も有用なドキュメントです。

## 新しいアプリに貼り付けられる最小再現

群を抜いて最も多いトリガー: `ListView` を `Column` の直下に置くことです。`Column` は子に主軸方向で非有界な高さを与え、`ListView` は有界な高さを求め、layout は失敗します。

```dart
// Flutter 3.44, Dart 3.x -- throws, layout aborts, "RenderBox was not laid out" follows.
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: FeedScreen()));

class FeedScreen extends StatelessWidget {
  const FeedScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          const Text('Latest'),
          // ListView inside a Column: unbounded height on the main axis.
          ListView(
            children: const [
              ListTile(title: Text('One')),
              ListTile(title: Text('Two')),
              ListTile(title: Text('Three')),
            ],
          ),
        ],
      ),
    );
  }
}
```

これを実行すると、コンソールの最初のエラーは `Vertical viewport was given unbounded height` です。その下にある `RenderBox was not laid out` のアサーションは結果であって、原因ではありません。修正は `ListView` を制約することです。

## 修正の詳細

修正は、それが正しい答えである頻度の高い順に並べています。サイズなしの box が実際に何を必要としているかに基づいて選んでください。

### 1. Expanded で scrollable に有界なサイズを与える (推奨)

scrollable が `Column` や `Row` の中にあり、残りのスペースを埋めるべき場合は、`Expanded` で包みます。`Expanded` は主軸方向に tight (きつい) で有界な制約を子に渡します。これはまさに viewport が必要とするものです。

```dart
// Flutter 3.44, Dart 3.x -- Expanded gives the ListView a bounded height.
Column(
  children: [
    const Text('Latest'),
    Expanded(
      child: ListView(
        children: const [
          ListTile(title: Text('One')),
          ListTile(title: Text('Two')),
          ListTile(title: Text('Three')),
        ],
      ),
    ),
  ],
)
```

これは `ListView` を遅延 (lazy) のままに保ちます。画面に表示されている行だけを構築し、残りはスクロールします。これは大きくなりうるあらゆるリストに対して望ましい挙動です。フィード、検索結果リスト、または上にヘッダーがあるスクロール可能な領域に対する正しい修正です。

### 2. リストが短く内容に合わせるべきなら shrinkWrap を使う

リストが本当に小さく有限 (ひと握りの設定行や固定メニュー) で、内容の高さ分だけを占めるようにしたい場合は、`shrinkWrap: true` を設定します。これは `ListView` に、有界な viewport を要求する代わりに子を測定して合計の高さを報告するよう指示します。

```dart
// Flutter 3.44, Dart 3.x -- shrinkWrap sizes the list to its children.
Column(
  children: [
    const Text('Settings'),
    ListView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      children: const [
        ListTile(title: Text('Profile')),
        ListTile(title: Text('Notifications')),
        ListTile(title: Text('Privacy')),
      ],
    ),
  ],
)
```

トレードオフは現実のものです。`shrinkWrap` はすべての子を前もって layout し、`ListView` を軽量にしている遅延レンダリングを無効にします。短く有界なリストにのみ使ってください。数十項目に成長しうるものには、修正 1 に戻ってください。`physics: NeverScrollableScrollPhysics()` を加えると内側のリストが独立してスクロールするのを防げます。外側の `Column` がスクロール面である場合は通常これが望ましい挙動です。

### 3. box に明示的な有界の制約を与える

正しい答えが具体的なサイズであることもあります。固定された高さの `SizedBox`、または最大高さを持つ `ConstrainedBox` は、scrollable に作業できる境界を与えます。

```dart
// Flutter 3.44, Dart 3.x -- a fixed viewport height for a horizontal carousel.
SizedBox(
  height: 200,
  child: ListView(
    scrollDirection: Axis.horizontal,
    children: const [/* cards */],
  ),
)
```

`Column` の中の横方向 `ListView` は再現の鏡像です。`Column` は幅を制約しますが高さは非有界のままにし、横方向の viewport は有界な高さを必要とします。固定の `height` がこれをきれいに解決します。内容が上限より短くなりうる場合は、代わりに `ConstrainedBox(constraints: BoxConstraints(maxHeight: 300))` を使ってください。

### 4. カスタム RenderObject では子のサイズを読む前に layout する

カスタム `RenderObject` (または `RenderBox` のサブクラス) を書いた場合、アサーションは `performLayout` が子を layout する前にその子のサイズにアクセスしたことを伝えています。`child.size` を読む前に必ず `child.layout(...)` を呼んでください。

```dart
// Flutter 3.44, Dart 3.x -- lay out the child, THEN read its size.
@override
void performLayout() {
  final BoxConstraints childConstraints = constraints.loosen();
  child!.layout(childConstraints, parentUsesSize: true); // must come first
  size = constraints.constrain(child!.size);              // now .size is valid
}
```

`parentUsesSize: true` フラグは、親自身のサイズが子に依存する場合に必須です。これを省くと、子が変化したときに Flutter が relayout をスキップすることがあり、その結果まさにこのエラーのように見える古い layout が断続的に生じます。契約は [RenderBox.size の API ページ](https://api.flutter.dev/flutter/rendering/RenderBox/size.html) に文書化されています。サイズは `performLayout` の間と後にのみ有効で、親からの読み取りには `layout` の時点で `parentUsesSize: true` が必要です。

### 5. サイズの読み取りを最初のフレームの後まで遅らせる

Dart でウィジェットのレンダリング後のサイズが必要な場合 (オーバーレイの位置決め、兄弟のサイズ設定、測定値を状態に戻す、など)、`build` の中で `context.size` を読まないでください。render box はまだ layout されていません。フレームの後に読んでください。

```dart
// Flutter 3.44, Dart 3.x -- the size exists only after layout has run.
@override
void initState() {
  super.initState();
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted) return;
    final Size? size = context.size; // valid now: the frame has been laid out
    setState(() => _measuredHeight = size?.height);
  });
}
```

layout の後ではなく layout の最中に測定したい場合は、フレーム後のサイズ読み取りではなく、`LayoutBuilder` (親の制約を渡してくれます) または `parentUsesSize: true` を持つ `RenderObject` に頼ってください。フレーム後のアプローチは「最終的なピクセルを一度だけ必要とする」場合のためのものです。

## 落とし穴とよく似たエラー

- `Vertical viewport was given unbounded height` と `Horizontal viewport was given unbounded width` は、ほとんどの `RenderBox was not laid out` カスケードを *引き起こす* 一次的なエラーです。`hasSize` アサーションの上にこのどちらかが見えたら、それを修正すれば残りは消えます。修正は上記の修正 1 から 3 です。
- `A RenderFlex overflowed by N pixels` は別の失敗です。flex の layout は問題なく行われたものの、その子が利用可能なスペースを超えました。これは layout を中断する代わりに縞を描きます。そのケースについては [RenderFlex オーバーフローのガイド](/ja/2026/05/fix-renderflex-overflowed-in-flutter/) を参照してください。サイズなしの box とは別物です。
- `IntrinsicHeight` または `IntrinsicWidth` で scrollable を包むことでスローされる `BoxConstraints forces an infinite height`。intrinsic 系ウィジェットは投機的な layout パスを行いますが、scrollable はそれへの参加を拒みます。`IntrinsicHeight` を取り除くか、`SizedBox` で scrollable を直接制約してください。
- 別の scrollable の中に入れ子になった `TabBarView`、`PageView`、または `ListView` は、同じ非有界制約の壁にぶつかります。内側の scrollable を `Expanded` で包むか (外側が flex の場合)、固定の高さを与え、`shrinkWrap` は内側のリストが短い場合にのみ設定してください。
- `setState` の直後に `GlobalKey` から `renderBox.size` を読むと、*前の* フレームのサイズが返るか、ウィジェットがまだ一度も layout されていなければ例外をスローします。これらの読み取りは常に `addPostFrameCallback` と `mounted` チェックの後ろで守ってください。これは [コントローラーの dispose ガイド](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) で扱う disposal クラッシュを防ぐのと同じ規律です。
- release モードではアサーションがコンパイルで除去されるため、赤い画面の代わりに空白の領域、サイズゼロのウィジェット、または静かにスキップされた描画が得られます。だからこそコンソールの警告を素通りせず debug で原因を直すのです。症状は release で形を変えますが、バグは依然としてそこにあります。

## 真犯人をすばやく見つける

このエラーはカスケードするため、最速の道はコンソールを上から下へ読み、最初の例外で止まることです。次にサブツリーを絞り込みます。

1. 最初のエラーはウィジェットとソース上の場所 (`lib/widgets/feed.dart:58`) を名指しします。そのファイルを開き、名指しされたウィジェットの親が何かを見ます。親が `Column`、`Row`、`IntrinsicHeight`、または別の scrollable である scrollable が容疑者です。
2. `main` で `debugPaintSizeEnabled = true;` を有効にする (または Flutter Inspector で Debug Paint を切り替える) と、すべての box の輪郭が見えます。何も描画しない、または線に潰れている box が、layout に失敗したものです。
3. DevTools で Layout Explorer を開き、失敗しているウィジェットを選択します。その制約パネルは `h=unbounded` か `w=unbounded` を受け取ったかどうかを示し、診断を裏付けます。layout の作業で DevTools を使ったことがなければ、[DevTools で Flutter アプリのジャンクをプロファイリングする](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) の手順が実機に対するセッションの開き方を扱っています。同じセッションが Layout Explorer を動かします。

より深い教訓は、`RenderBox was not laid out` はバグそのものでは決してないということです。これは、より早いウィジェットが始めた仕事を終えられなかったと Flutter が報告しているものです。最も声の大きいメッセージを無視し、最初の静かなものを見つけるよう自分を訓練すれば、このエラーは謎ではなくなります。scrollable を有界に保ち、子を測定する前に layout し、サイズを生み出すフレームより前に決してサイズを読まないようにすれば、このアサーションは決して発動しません。

## 関連

- [解決: Flutter の A RenderFlex overflowed by N pixels](/ja/2026/05/fix-renderflex-overflowed-in-flutter/) は兄弟関係にある layout エラーです。flex は layout されたものの子が収まらなかったケースで、サイズなしの box とは別の失敗モードです。
- [解決: Flutter の setState() or markNeedsBuild() called during build](/ja/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/) は「間違ったタイミングで framework に触れた」もう 1 つのエラーで、post-frame-callback による修正を共有します。
- [DevTools で Flutter アプリのジャンクをプロファイリングする方法](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) は、その Layout Explorer がこのエラーの背後にある非有界制約を指し示す、同じ DevTools セッションを準備します。
- [メモリリークを避けるために Flutter でコントローラーを dispose する方法](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) は、フレーム後のサイズ読み取りを安全に保つ `mounted` とライフサイクルの規律を扱います。

## 出典

- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints)。制約、サイズ、layout プロトコルがどう噛み合うかについての規範的な解説です。
- [RenderBox.size の API リファレンス](https://api.flutter.dev/flutter/rendering/RenderBox/size.html)。box のサイズが `performLayout` の間と後にのみ有効で、親からの読み取りには `parentUsesSize: true` が必要だと述べています。
- [Common Flutter errors](https://docs.flutter.dev/testing/common-errors)。これらのカスケードの大半を引き起こす非有界 viewport とオーバーフローのエラーを定義する公式の一覧です。
- [flutter/flutter issue #130967](https://github.com/flutter/flutter/issues/130967)。非有界な制約を与えられた shrink-wrapping viewport から `hasSize` アサーションが発動する代表的な報告です。
