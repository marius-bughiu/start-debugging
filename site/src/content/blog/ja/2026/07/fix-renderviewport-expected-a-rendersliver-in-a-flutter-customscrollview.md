---
title: "修正: A RenderViewport expected a child of type RenderSliver but received a child of type RenderBox (Flutter の CustomScrollView)"
description: "CustomScrollView の slivers リストは sliver しか受け付けません。box ウィジェットは SliverToBoxAdapter でラップするか、ListView／Padding／Column を SliverList や SliverPadding に置き換えてください。"
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "slivers"
  - "layout"
lang: "ja"
translationOf: "2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview"
translatedBy: "claude"
translationDate: 2026-07-05
---

`A RenderViewport expected a child of type RenderSliver but received a child of type RenderParagraph`（あるいは `RenderFlex`、`RenderErrorBox`、その他任意の `RenderBox`）は、`CustomScrollView` の `slivers` リストの中に通常のウィジェットを直接置いたことを意味します。`slivers` の中身はすべて sliver でなければなりません。もっとも手早い修正は、問題となっている box ウィジェットを `SliverToBoxAdapter` でラップすることです。リストの場合のより良い修正は、`ListView` を `SliverList.builder` に、`Padding` を `SliverPadding` に置き換えることです。Flutter 3.x（3.44）、Dart 3.x で検証しました。

## このエラーが起きる文脈

Flutter はこれをレイアウト時、つまり何も描画する前にスローします。"received a child of type" の後に続く具体的な型は、リストに何を置いたかによって変わります。`Text` なら `RenderParagraph`、`Column` や `Row` なら `RenderFlex`、リスト内の builder が例外をスローした場合は `RenderErrorBox` になります。しかし形はいつも同じです。

```
FlutterError (A RenderViewport expected a child of type RenderSliver but received a
child of type RenderParagraph.
RenderObjects expect specific types of children because they coordinate with their
children during layout and paint. For example, a RenderSliver cannot be the child of
a RenderBox because a RenderSliver does not understand the RenderBox layout protocol.

The RenderViewport that expected a RenderSliver child was created by:
  Viewport ← IgnorePointer ← Semantics ← Listener ← _GestureSemantics ←
    Scrollable ← PrimaryScrollController ← CustomScrollView ← ...

The RenderParagraph that did not match the expected child type was created by:
  Text ← ...)
```

役に立つのは 2 つの "created by" ブロックです。最初のブロックは sliver を期待したスクロールウィジェットの名前を示します（ほぼ確実にあなたの `CustomScrollView` です）。2 つ目のブロックは sliver でなかった正確なウィジェットの名前を示します。まず 2 つ目のブロックを読んでください。変更すべき行をそのまま指し示しています。

## なぜ viewport は box の子を拒否するのか

Flutter にはレイアウトプロトコルが 1 つではなく 2 つあります。`Container`、`Text`、`Row`、`Column` のような通常のウィジェットは box としてレイアウトされます。親が幅と高さの制約を下に渡し、子が具体的な `Size` を返して完了です。それらのレンダーオブジェクトは `RenderBox` のサブクラス（`RenderParagraph`、`RenderFlex` など）です。

sliver はスクロールのために作られた、より豊かな別のプロトコルを使います。sliver は単にサイズを報告するだけではありません。レイアウト中に、現在どれだけがスクロールで画面外に出ているか、viewport にどれだけ余地が残っているか、スクロールオフセット、軸の方向などを記述した `SliverConstraints` を受け取ります。そして、どれだけの空間を描画したか、スクロール軸上でどれだけ消費したか、ヒットテストの範囲、可視化を望むかどうかを記述した `SliverGeometry` を返します。この往復のやり取りこそが、`SliverAppBar` がスクロールにつれて縮み、`SliverList` が現在画面上にある行だけをビルドできる理由です。そのレンダーオブジェクトは `RenderSliver` のサブクラスです。

`RenderViewport`（`CustomScrollView` の背後にあるレンダーオブジェクト）は、子に対して sliver プロトコルしか話しません。各子に `SliverConstraints` を渡し、`SliverGeometry` が返ってくることを期待します。そこに `RenderBox` を渡すと、その box は `SliverConstraints` をどう扱えばよいか分からず、viewport が呼び出そうとしているメソッドを実装していません。レイアウトの奥深くで分かりにくい null とともにクラッシュするのではなく、フレームワークは事前に子の型をチェックしてこのアサーションをスローします。メッセージがルールを明言しています。"a RenderSliver cannot be the child of a RenderBox because a RenderSliver does not understand the RenderBox layout protocol"（RenderSliver は RenderBox のレイアウトプロトコルを理解しないので、RenderBox の子にはなれない）。逆方向についても同じことが言え、それがまさにあなたが遭遇したミスマッチです。

つまりこれは、[RenderBox was not laid out](/ja/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) のような微妙な制約バグや [RenderFlex オーバーフロー](/ja/2026/05/fix-renderflex-overflowed-in-flutter/) とは違います。これは型のミスマッチです。sliver があるべき場所に box ウィジェットが立っているのです。

## 最小の再現

`slivers` リストに sliver でないウィジェットがあれば、どれでもこれを引き起こします。ここに最小のバージョンを示します。sliver があるべき場所に裸の `Text` を置いたものです。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class Feed extends StatelessWidget {
  const Feed({super.key});

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: [
        const Text('Recent activity'), // RenderParagraph, not a sliver
        SliverList.builder(
          itemCount: 20,
          itemBuilder: (context, i) => ListTile(title: Text('Item $i')),
        ),
      ],
    );
  }
}
```

`SliverList.builder` は問題ありません。問題は `Text` です。これは `RenderParagraph` になり、viewport は `RenderSliver` を期待していたので、レイアウトがスローします。`Column`、`Padding`、`Center`、`ListView`、あるいはカスタムページウィジェット全体を `slivers` に落とし込んでも同じことが起こります。sliver でなければ、viewport はそれを拒否します。

## 修正 1: 単一の box ウィジェットを SliverToBoxAdapter でラップする

見出し、バナー、カード、ボタン行のような単発の box ウィジェットには、`SliverToBoxAdapter` でラップします。このウィジェットは sliver であり、その役目はただ 1 つの `RenderBox` の子をホストし、2 つのプロトコルの間を翻訳することです。box を測定し、viewport に適切な `SliverGeometry` を報告します。

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(
      child: Text('Recent activity'),
    ),
    SliverList.builder(
      itemCount: 20,
      itemBuilder: (context, i) => ListTile(title: Text('Item $i')),
    ),
  ],
)
```

これは直接的な修正であり、box のコンテンツが本当に単一の固定サイズの塊であるときに正しい修正です。ヘッダー、スペーサー、サマリーカードが 1 つのスクロールビューの中でリストの上に置かれる必要があるときに、まず手を伸ばす sliver です。

知っておくべきことが 1 つあります。`SliverToBoxAdapter` は子を積極的にビルドし、画面上にあるかどうかにかかわらず生かし続けます。box には遅延という概念がないためです。ヘッダーには問題ありません。しかし長いリストには不適切であり、それが修正 2 です。

## 修正 2: リストにはラップした ListView ではなく SliverList／SliverGrid を使う

もっとも多い間違いは、`ListView` を `slivers` に落とし込み、このエラーが出たときに `ListView` を `SliverToBoxAdapter` でラップすることです。それはアサーションを黙らせますが、形が間違っています。スクロール可能なものの中にスクロール可能なものがあることになり、内側の `ListView` はアダプターから無制限の高さを受け取ります。これは [ListView を Column の中にネストする](/ja/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) のと同じ失敗の系統です。`shrinkWrap` で無理に動くようにしても、遅延ビルドを捨てることになります。すべての行が最初にまとめて構築されてしまいます。

`CustomScrollView` の要点は、そのセクションが 1 つの viewport を共有する sliver であることです。ですから、box 化された `ListView` ではなく sliver リストを使ってください。

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(child: Text('Recent activity')),

    // Lazy: only builds rows near the viewport. Direct replacement for ListView.builder.
    SliverList.builder(
      itemCount: items.length,
      itemBuilder: (context, i) => ListTile(title: Text(items[i])),
    ),

    // Grid section in the same scroll view.
    SliverGrid.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 2),
      itemCount: photos.length,
      itemBuilder: (context, i) => Image.network(photos[i]),
    ),
  ],
)
```

`SliverList.builder`、`SliverList.separated`、`SliverFixedExtentList`、`SliverGrid.builder` は、`ListView`／`GridView` の builder に相当する sliver です。長いリストを安価にする遅延ビルドを保ち、そのまま `slivers` にはまります。リストとグリッドを 1 つの連続したスクロールで流したい場合は、これがそのためのレイアウトです。完全なパターンについては [slivers で ListView と GridView を混在させる](/ja/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) を参照してください。

## 修正 3: Padding の代わりに SliverPadding、box の代わりに SliverFillRemaining

box と sliver のルールはラッパーウィジェットにも及びます。sliver に余白を付けるために `Padding` でラップすると、`Padding` は `RenderBox` なので viewport はそれを拒否します。sliver 対応のバージョンは `SliverPadding` で、これは sliver の子に余白を付けつつ自身は sliver であり続けます。

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    SliverPadding(
      padding: const EdgeInsets.all(16),
      sliver: SliverList.builder(       // note: 'sliver:', not 'child:'
        itemCount: items.length,
        itemBuilder: (context, i) => Text(items[i]),
      ),
    ),
  ],
)
```

パラメーター名に注意してください。`SliverPadding` は `child:` ではなく `sliver:` を取ります。その子自身が sliver でなければならないためです。同じ考え方が、他のいくつかのよくあるニーズをカバーします。

- **残った viewport を埋めるべき box**（残った空間の中央に置かれる空状態のメッセージ）: `SliverFillRemaining(child: ...)`。
- **ちょうど 1 画面分の高さであるべき box**: `SliverFillViewport`。
- **スクロールで縮む固定または浮動のヘッダー**: `SliverAppBar`。これはすでに sliver なので、そのまま `slivers` に入ります。
- **1 つのクリップやデコレーションを適用するために複数の sliver をグループ化する**: `SliverMainAxisGroup`／`SliverCrossAxisGroup`。

考え方はこうです。通常使う box ウィジェットごとに、それをラップする（`SliverToBoxAdapter`、`SliverFillRemaining`）か、その sliver 版を見つける（`SliverList`、`SliverGrid`、`SliverPadding`、`SliverAppBar`）かのどちらかにします。

## 落とし穴とそっくりさん

**slivers 内の builder がスローすると、この同じエラーが表示されます。** 受け取った型が `RenderErrorBox` の場合、子は `ErrorWidget` でした。`slivers` の中にある `StreamBuilder` や `FutureBuilder` の内部で何かがビルド中にスローし、Flutter が赤いエラー box（`RenderBox`）を代わりに置き、viewport がそれを拒否したのです。修正は 2 段階です。builder がどのパスでも sliver を返すようにし、エラーケースを処理します。`slivers` 内の `StreamBuilder` は、エラーとローディングの分岐を含め、その `builder` から sliver を返さなければなりません。

```dart
// Flutter 3.x (tested 3.44)
StreamBuilder<List<String>>(
  stream: feed,
  builder: (context, snapshot) {
    if (snapshot.hasError) {
      return const SliverToBoxAdapter(child: Text('Could not load feed'));
    }
    if (!snapshot.hasData) {
      return const SliverToBoxAdapter(child: Center(child: CircularProgressIndicator()));
    }
    final items = snapshot.data!;
    return SliverList.builder(
      itemCount: items.length,
      itemBuilder: (context, i) => ListTile(title: Text(items[i])),
    );
  },
)
```

いずれかの分岐から裸の `Text` や `CircularProgressIndicator` を返すと、元のエラーに逆戻りします。（ついでに言うと、`FutureBuilder` がリビルドのたびに future を再実行しているなら、それは別のバグで、修正する価値があります。[FutureBuilder が Future を再作成しないようにする方法](/ja/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/) を参照してください。）

**逆方向のミスマッチはほとんど同じように読めます。** box があるべき場所に sliver を置くと（たとえば `Column` の中の `SliverList`）、"A RenderObjectWithChildMixin expected a child of type RenderBox but received a child of type RenderSliverList" または "expected a RenderBox but received a RenderSliverPadding" が出ます。同じルールの逆方向です。sliver は viewport（`CustomScrollView`、または `NestedScrollView` の slivers 領域）の中にしか住めず、`Column`、`Center`、`Padding` の中に直接置くことはできません。sliver を box の親が受け入れるものに戻すには、通常はそうしません。sliver が `CustomScrollView` の中に入るように構造を組み直します。

**`SliverToBoxAdapter` は長いリストを隠す場所ではありません。** 動作するので誘惑されますが、遅延性を台無しにします。アダプターは子のサブツリー全体を即座にビルドします。5,000 行の `ListView`（または 5,000 個の子を持つ `Column`）を 1 つに包むと、最初のフレームで 5,000 個すべてをビルドすることになり、レイアウト時間が急増してタイムライン上でジャンクとして現れます。ヘッダーや単一のカードには使い、スクロールするものには `SliverList.builder` を使ってください。

**ホットリロードがこれから回復できないことがあります。** アサーションがレイアウト中に発火するため、コードを修正した後のホットリロードでレンダーツリーが行き詰まったままになることがときどきあります。問題の行を明らかに修正した後もエラーが残る場合は、ホットリロード（`r`）ではなくホットリスタート（`R`）を行ってください。

## 関連記事

- [slivers で 1 つのスクロールビューに ListView と GridView を混在させる方法](/ja/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/)：このエラーがあなたを導いている、正しいマルチセクションの `CustomScrollView` レイアウト。
- [無制限の高さエラーなしで ListView を Column の中にネストする方法](/ja/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/)：ListView を box 化してこれを「修正」した場合に遭遇する失敗。
- [修正: Flutter で RenderBox was not laid out](/ja/2026/06/fix-renderbox-was-not-laid-out-in-flutter/)：スクロールビューを組み立てる際に出会う、もう 1 つのレイアウト時アサーション。
- [修正: Flutter で A RenderFlex overflowed](/ja/2026/05/fix-renderflex-overflowed-in-flutter/)：`Row`／`Column` での制約の問題で、この問題の box 側のいとこ。

## 出典

- [RenderViewport クラス, Flutter API リファレンス](https://api.flutter.dev/flutter/rendering/RenderViewport-class.html)：sliver プロトコルを話し、box の子を拒否するレンダーオブジェクト。
- [SliverToBoxAdapter クラス, Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/SliverToBoxAdapter-class.html)：単一の box ウィジェットを sliver としてラップする。
- [SliverList クラス, Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/SliverList-class.html)：遅延リスト sliver と、その `.builder`／`.separated` コンストラクター。
- [flutter/flutter issue 126064](https://github.com/flutter/flutter/issues/126064)：`slivers` 内でスローする builder がこの同じアサーションを生む `RenderErrorBox` のバリアント。
