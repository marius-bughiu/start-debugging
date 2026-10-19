---
title: "Flutter で子ウィジェットの型が変わらないときに AnimatedSwitcher をアニメーションさせる方法"
description: "AnimatedSwitcher は Widget.canUpdate が新しい子を別のウィジェットと判定したときだけ遷移します。そのため、キーのない Text から Text への切り替えはその場で更新されるだけです。この記事では 1 行の修正、キーを置くべき位置、UniqueKey が落とし穴になる理由、静的な transitionBuilder が引き起こすスライド方向のバグ、既定の Stack によるレイアウトのずれを、Flutter 3.44.8 のウィジェットテストで検証して解説します。"
pubDate: 2026-10-19
template: how-to
tags:
  - "flutter"
  - "dart"
  - "animation"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-make-animatedswitcher-animate-when-the-child-type-does-not-change"
translatedBy: "claude"
translationDate: 2026-10-19
---

**結論:** `AnimatedSwitcher` の直接の子に、内容が変わるたびに変化するキーを付けてください。通常は表示するデータから作った `ValueKey` です: `Text('$count', key: ValueKey<int>(count))`。`AnimatedSwitcher` は `Widget.canUpdate` で遷移を実行するかどうかを判断しますが、これが比較するのは `runtimeType` と `key` だけです。キーのない 2 つの `Text` は、フレームワークから見ると "同じウィジェット" なので、古いほうがその場で更新され、何もアニメーションしません。以下の内容はすべて Flutter 3.44.8 (Dart 3.12.2) のウィジェットテストで検証しており、`_AnimatedSwitcherState` のソースは現在の `stable` ブランチと完全に同一です。

この記事の残りでは、この現象を引き起こすフレームワーク内の正確な行、テスト出力つきの最小再現コード、キーを置くべき位置 (1 階層下に置いたキーは効果がありません)、`UniqueKey` が不適切な修正である理由、そして遷移が動き始めた直後によく遭遇する 3 つの落とし穴 (スライド遷移が逆方向に動く、コンテンツが中央にジャンプする、子の状態が失われる) を説明します。

## AnimatedSwitcher が行う唯一の比較

`AnimatedSwitcher` は `StatefulWidget` で、"現在のエントリ" (子とそれ専用の `AnimationController`) と、まだフェードアウト中の退場エントリの集合を保持しています。親が新しい `child` で再ビルドすると、`didUpdateWidget` が次のチェックを実行します。これは `packages/flutter/lib/src/widgets/animated_switcher.dart` からそのまま引用したものです。

```dart
// Flutter 3.44.8, _AnimatedSwitcherState.didUpdateWidget
final hasNewChild = widget.child != null;
final hasOldChild = _currentEntry != null;
if (hasNewChild != hasOldChild ||
    hasNewChild && !Widget.canUpdate(widget.child!, _currentEntry!.widgetChild)) {
  // Child has changed, fade current entry out and add new entry.
  _childNumber += 1;
  _addEntryForNewChild(animate: true);
} else if (_currentEntry != null) {
  // Child has been updated. ... keep the key from the previous transition
  // so that we update the transition instead of replacing it.
  _currentEntry!.widgetChild = widget.child!;
  _updateTransitionForEntry(_currentEntry!);
}
```

そして `Widget.canUpdate` はたった 1 行です。

```dart
// Flutter 3.44.8, framework.dart
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType && oldWidget.key == newWidget.key;
}
```

比較されないものに注目してください。テキスト、色、画像の URL、その他のフィールドは一切比較されません。遷移が始まるのは次の 3 つの場合だけです。子が `null` から非 null になる、非 null から `null` になる、または新しい子の実行時の型かキーが異なる、です。`Text('1')` から `Text('2')` への変更ではどれにも当てはまらないため、`else` 分岐が既存のエントリにウィジェットを差し替え、ユーザーには即座に切り替わったように見えます。API ドキュメントにははっきり書かれていますが、"AnimatedSwitcher が何もしない" という症状から、そこを読みに行く人はあまりいません。この比較の背景にある一般的な理論については、[Flutter の Key とは何か、省略するとどんなバグが起きるか](/ja/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)で解説しています。

## テストとして実行できる最小再現コード

遷移が動いているかどうかを確かめる最も手早い方法は、アニメーションの途中で `FadeTransition` ウィジェットの数を数えることです。既定の `transitionBuilder` は、入ってくるエントリも出ていくエントリも 1 つの `FadeTransition` で包みます。したがって 1 つなら "遷移なし"、2 つなら "クロスフェード進行中" を意味します。

```dart
// Flutter 3.44.8, Dart 3.12.2 -- test/switcher_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(Widget child) => Directionality(
      textDirection: TextDirection.ltr,
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 300),
        child: child,
      ),
    );

int fades(WidgetTester t) => find.byType(FadeTransition).evaluate().length;

void main() {
  testWidgets('no key: same type is updated in place', (t) async {
    await t.pumpWidget(host(const Text('1')));
    await t.pumpWidget(host(const Text('2')));
    await t.pump(const Duration(milliseconds: 100));
    print('no key -> ${fades(t)}'); // no key -> 1
  });

  testWidgets('ValueKey on the direct child animates', (t) async {
    await t.pumpWidget(host(const Text('1', key: ValueKey(1))));
    await t.pumpWidget(host(const Text('2', key: ValueKey(2))));
    await t.pump(const Duration(milliseconds: 100));
    print('ValueKey -> ${fades(t)}'); // ValueKey -> 2
    await t.pumpAndSettle();
    print('settled -> ${fades(t)}'); // settled -> 1
  });
}
```

キーがない場合、300 ms のアニメーションの 100 ms 時点で `FadeTransition` は 1 つしかなく、アニメーションが存在しないことを意味します。`ValueKey` がある場合は 2 つあり、`pumpAndSettle` の後には退場エントリが破棄されて取り除かれています。

## 実際のウィジェットでの修正

アプリのウィジェットでの同じ修正を示します。キーは `child` として渡すウィジェットに付け、遷移の引き金にしたい値から導出します。

```dart
// Flutter 3.44.8, Dart 3.12.2
class Counter extends StatefulWidget {
  const Counter({super.key});
  @override
  State<Counter> createState() => _CounterState();
}

class _CounterState extends State<Counter> {
  int _count = 0;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 250),
          transitionBuilder: (child, animation) =>
              ScaleTransition(scale: animation, child: child),
          child: Text(
            '$_count',
            key: ValueKey<int>(_count), // the whole fix
            style: Theme.of(context).textTheme.displayMedium,
          ),
        ),
        FilledButton(
          onPressed: () => setState(() => _count++),
          child: const Text('Increment'),
        ),
      ],
    );
  }
}
```

同じパターンで、"型は同じで内容が違う" というよくあるケースをすべて扱えます。

- 画像の入れ替え: `Image.network(url, key: ValueKey(url))`。
- アイコンの入れ替え: `Icon(isPlaying ? Icons.pause : Icons.play_arrow, key: ValueKey(isPlaying))`。
- モデルの状態の切り替え: プロフィールカードに `key: ValueKey(user.id)` を付けると、同じユーザーの編集ではアニメーションせず、別のユーザーを選んだときだけアニメーションします。
- たまたま同じウィジェット型を返すロード中、エラー、データの各分岐 (たとえば 3 つの `Center` ウィジェット): それぞれに `ValueKey('loading')`、`ValueKey('error')`、`ValueKey('data')` を付けます。非同期の状態を Riverpod から得ている場合は、[AsyncValue でロード中とエラーの状態を表示する方法](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)と自然に組み合わせられます。

キーに何を入れるかを選ぶことは、アニメーションがいつ発火するかを選ぶことです。`count` から作ったキーはインクリメントのたびにアニメーションします。`count ~/ 10` から作ったキーは、10 の位が変わったときだけアニメーションし、内側のテキストはその場で更新され続けます。

## キーは直接の子に付ける必要がある

`canUpdate` が見るのは常に `widget.child`、つまり `AnimatedSwitcher` に直接渡したウィジェットだけです。その内側にネストされたウィジェットのキーは、この比較からは見えません。

```dart
// Flutter 3.44.8 -- does NOT animate
AnimatedSwitcher(
  duration: const Duration(milliseconds: 300),
  child: Padding(
    padding: const EdgeInsets.all(8),
    child: Text('$_count', key: ValueKey<int>(_count)), // too deep
  ),
)
```

私のテストでは、アニメーションの途中で `FadeTransition` は 1 つで、キーがない場合と同じでした。外側の `Padding` にはキーがなく、毎回同じ型なので、スイッチャーはそれをその場で更新し、内側の `Text` は遷移なしにそれだけで新しい要素になります。キーを `Padding` (またはトップレベルのウィジェット。多くは `Container`、`Card`、または自作の `StatelessWidget`) に移せば動作します。

子が自作のウィジェットクラスの場合も同じ落とし穴があります。

```dart
// Flutter 3.44.8
AnimatedSwitcher(
  duration: const Duration(milliseconds: 300),
  child: StatusBadge(status: status, key: ValueKey(status)),
)
```

`key` を `super.key` 経由で `StatusBadge` のコンストラクターに渡せば十分です。`StatusBadge.build` の内側のウィジェットにキーを付けても効果はありません。

## UniqueKey が不適切な修正である理由

多くの人が最初に見つける答えは `key: UniqueKey()` です。確かにスイッチャーはアニメーションしますが、内容が変わったときだけでなく、親が再ビルドされるたびにアニメーションします。

```dart
// Flutter 3.44.8, Dart 3.12.2
testWidgets('UniqueKey animates on every rebuild', (t) async {
  await t.pumpWidget(host(Text('1', key: UniqueKey())));
  await t.pumpWidget(host(Text('1', key: UniqueKey()))); // same text
  await t.pump(const Duration(milliseconds: 100));
  print(fades(t)); // 2
});
```

同じテキストなのに、完全なクロスフェードが起きます。実際の画面では、親は切り替え対象のコンテンツとは無関係な理由で再ビルドされます。キーボードが開いたときの `MediaQuery` の変化、テーマの変更、無関係な `setState`、プロバイダーの通知などです。そのたびに遷移が再開され、子の要素と状態が破棄されます。逆の間違いは、文字列が変わる `Text` に `ValueKey('label')` のような定数キーを付けることです。そのキーは変わらないため `canUpdate` は true になり、何もアニメーションしません。私のテストでも `FadeTransition` は 1 つで、新しいテキストは即座に表示されました。キーは必ずデータから導出してください。

## 連続した切り替えと null の子

バグと間違えないよう、知っておく価値のある 2 つの挙動があります。

1. 前の遷移が終わる前に子が再び変わっても、スイッチャーは何もキャンセルしません。現在のエントリは退場の集合に移されて逆再生されるため、複数の子が同時にフェードアウトすることがあります。100 ms 以内に 1 から 2、3 へ切り替えると、ツリーには 3 つの `FadeTransition` ウィジェットが残りました。同じキーが戻ってきても安全なのもこのためです。すべての遷移は内部カウンター (`_childNumber`) をキーとする `KeyedSubtree` で包まれているので、キー `A` を持つ新しい子が、同じくキー `A` を持つ退場中の子と混同されることはありません。
2. `child: null` を設定するのは、コンテンツをアニメーションで消す正当な方法です。`hasNewChild != hasOldChild` が遷移を発動し、古い子がフェードアウトし、フェードインするものはありません。

## 落とし穴: スライド遷移が逆方向に動く

クロスフェードが動くようになると、次の要望はたいてい横方向のスライドです。新しい値が右からスライドインし、古い値が左へスライドアウトします。素朴な実装では、退場する子のコントローラーが同じトゥイーンに沿って単に逆再生されるため、両方の子が右から来て右へ出ていきます。標準的な手法は、`transitionBuilder` の中で、包もうとしている子が現在の子かどうかを確認することです。

```dart
// Flutter 3.44.8, Dart 3.12.2
Widget _slide(Widget child, Animation<double> animation) {
  final incoming = child.key == ValueKey<int>(_count);
  final offset = Tween<Offset>(
    begin: Offset(incoming ? 1 : -1, 0),
    end: Offset.zero,
  ).animate(animation);
  return ClipRect(child: SlideTransition(position: offset, child: child));
}
```

ここが微妙な部分です。`AnimatedSwitcher` が退場エントリに対して `transitionBuilder` を再実行するのは、`widget.transitionBuilder != oldWidget.transitionBuilder` のときだけです。`build` の中に直接書いた関数リテラル、たとえば `transitionBuilder: (c, a) => _slide(c, a)` は、ビルドのたびに新しいクロージャーオブジェクトを作るため、比較は true になり、すべてのエントリが最新の `_count` で再構築され、古い子は正しく退場として判定されます。`transitionBuilder: _slide` のようなメソッドのティアオフや、フィールドに保存したビルダーは、ビルドをまたいで等しいと比較されることがあり、退場エントリは入場していたときに構築された遷移をそのまま保持します。両方の方法を実行し、途中時点の `SlideTransition` のオフセットを読み取りました。

```text
inline closure:   child 1 dx=-0.50   child 2 dx=0.50
stored function:  child 1 dx= 0.50   child 2 dx=0.50
```

保存した関数を使うと、古い子は新しい子の上に重なったまま右へスライドして戻ります。方向を考慮する `transitionBuilder` を書く場合は、インラインのクロージャーとして渡し (またはキーが変わるたびに新しいオブジェクトになるようにし)、上のようなテストを追加して、ティアオフへのリファクタリングで気づかないうちに壊れることがないようにしてください。

## 落とし穴: コンテンツが中央にジャンプする、またはサイズが急に変わる

既定の `layoutBuilder` は、退場する子と現在の子を `alignment: Alignment.center` の `Stack` に入れます。これにより 2 つの目に見える副作用があります。

- 左揃えのコンテンツ、たとえば `Row` 内のラベルや `ListTile` のサブタイトルは、遷移の実行中に中央へジャンプします。
- `Stack` は最大の子と同じ大きさになるため、長い文字列が短い文字列に置き換わったとき、古い子が消えてからでないとスペースが縮みません。

どちらも、カスタムの `layoutBuilder` で修正でき、サイズ変更を滑らかにするために `AnimatedSize` で包むこともできます。

```dart
// Flutter 3.44.8, Dart 3.12.2
AnimatedSize(
  duration: const Duration(milliseconds: 200),
  alignment: Alignment.centerLeft,
  child: AnimatedSwitcher(
    duration: const Duration(milliseconds: 200),
    layoutBuilder: (currentChild, previousChildren) => Stack(
      alignment: Alignment.centerLeft,
      children: [
        ...previousChildren,
        if (currentChild != null) currentChild,
      ],
    ),
    child: Text(status, key: ValueKey(status)),
  ),
)
```

入ってくるウィジェットが一番上に描画されるよう、`previousChildren` を `currentChild` より前に置いてください。これは既定の動作と同じです。

## 落とし穴: 子の状態が破棄される

キーが変われば新しい要素になります。切り替え対象の子の下にある `State`、たとえば `initState` で作られた `TextField` のコントローラー、スクロール位置、展開フラグなどは、入ってくる子のために新しく作られます。私のテストでは、キーの変更前後で要素は別のオブジェクトでした。"別のものを表示する" ならたいていこれで構いませんが、"同じものの属性をアニメーションさせる" には不適切な道具です。ユーザーがフィールドに入力している最中にテキストでキーを付けると、キーストロークのたびにフィールドが再作成され、フォーカスが失われます。

同じウィジェットの属性の変化には、代わりに暗黙的アニメーションを使ってください。`AnimatedDefaultTextStyle`、`AnimatedContainer`、`AnimatedOpacity`、任意の値には `TweenAnimationBuilder` があります。これらは要素を保持したまま属性を補間します。`AnimatedSwitcher` はコンテンツの置き換えのためのもので、キーはコンテンツが置き換えられたことを伝える手段です。遷移を 1 つの画面の中ではなく画面をまたいで行いたい場合は、代わりに[2 つの画面間の Hero アニメーション](/ja/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/)や[カスタムページ遷移](/ja/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/)を参照してください。

## AnimatedSwitcher が何もしないときのチェックリスト

1. キーは、内側のものではなく、`child` として直接渡すウィジェットに付ける。
2. キーは、遷移の引き金にしたいデータから導出する。通常は `ValueKey(value)` で、`build` の中で作る `UniqueKey()` は使わない。
3. キーが実際に変化しているか確認する。定数の `ValueKey('x')` は、この目的ではキーなしと同じです。
4. `AnimatedSwitcher` 自体が再作成されていないことを確認する。祖先の型やキーが変わると、スイッチャー自身の状態がゼロから再構築され、最初の子はアニメーションなしで表示されます (`initState` が `_addEntryForNewChild(animate: false)` を呼びます)。
5. 方向を考慮する `transitionBuilder` を使う場合は、退場エントリが再構築されるようにインラインのクロージャーとして渡す。
6. 配置とサイズは、カスタムの `layoutBuilder` と `AnimatedSize` で修正する。

### 関連記事

- [Flutter の Key とは何か、省略するとどんなバグが起きるか](/ja/2026/09/what-is-a-flutter-key-and-when-does-omitting-it-cause-bugs/)
- [Flutter Riverpod で AsyncValue を使ってロード中とエラーの状態を表示する方法](/ja/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [Flutter で 2 つの画面間に Hero アニメーションを追加する方法](/ja/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/)
- [Flutter のページ遷移ビルダー再編後にカスタムページ遷移を移行する](/ja/2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization/)
- [Flutter で build 中に setState() または markNeedsBuild() が呼ばれた場合の修正](/ja/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/)

## 参考資料

- [AnimatedSwitcher class, Flutter API docs](https://api.flutter.dev/flutter/widgets/AnimatedSwitcher-class.html)
- [AnimatedSwitcher.layoutBuilder, Flutter API docs](https://api.flutter.dev/flutter/widgets/AnimatedSwitcher/layoutBuilder.html)
- [Widget.canUpdate, Flutter API docs](https://api.flutter.dev/flutter/widgets/Widget/canUpdate.html)
- [animated_switcher.dart on the stable branch, flutter/flutter](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/widgets/animated_switcher.dart)
- [Implicit animations, Flutter docs](https://docs.flutter.dev/codelabs/implicit-animations)
