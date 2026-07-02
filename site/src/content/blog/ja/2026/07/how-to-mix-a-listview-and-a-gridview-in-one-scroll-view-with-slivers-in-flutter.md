---
title: "Flutter で ListView と GridView を sliver で 1 つのスクロールビューにまとめる方法"
description: "ネストしたスクロール可能ウィジェットを使わずに、リストとグリッドを 1 つの連続したスクロールにまとめます。CustomScrollView と SliverList、SliverGrid を使い、パフォーマンスを静かに殺す shrinkWrap の罠を回避します。"
pubDate: 2026-07-02
tags:
  - "flutter"
  - "dart"
  - "layout"
  - "slivers"
  - "listview"
lang: "ja"
translationOf: "2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-02
---

リストがそのままグリッドに流れ込む（あるいはその逆の）画面を作りたい、そして全体が 1 つとしてスクロールしてほしい。誤った直感は、`ListView` と `GridView` を `Column` に積み重ねて、それらを収めるために `shrinkWrap: true` に手を伸ばすことです。それはコンパイルは通りますが、すべてのアイテムを最初に構築してしまい、互いに争う 2 つのスクロール位置ができてしまいます。正しい答えは、各セクションが sliver である単一の `CustomScrollView` です。リスト部分には `SliverList`、グリッド部分には `SliverGrid`、その間の普通のウィジェットには `SliverToBoxAdapter` を使います。1 つのビューポート、1 つのスクロール物理、完全な遅延構築です。この記事では Flutter 3.x（3.44、Dart 3.x でテスト済み）で動作するレイアウトを示し、なぜ素朴なバージョンが遅いのかを説明し、そして人がつまずくスペーシング、パディング、cross-axis-count の細部を解説します。

## なぜ 2 つのスクロール可能ウィジェットを単純に積み重ねられないのか

`ListView` も `GridView` も、どちらもスクロール可能なビューポートです。それぞれが自分自身のスクロール位置を持ち、自分のウィンドウの高さを知るために有限の高さを渡されることを期待します。この 2 つを `Column` に入れると、[アンバウンドな高さのエラーなしに ListView を Column の中にネストする方法](/ja/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) で説明したのと同じ壁にぶつかります。`Column` は各子に対して無限の垂直スペースを提供しますが、スクロール可能ウィジェットは無限に向かってレイアウトすることを拒否します。

よくある応急処置は、両方に `shrinkWrap: true` を付けて、`SingleChildScrollView` で包むことです。

```dart
// Flutter 3.x (tested 3.44) -- the anti-pattern, do not ship this
SingleChildScrollView(
  child: Column(
    children: [
      ListView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        itemCount: posts.length,
        itemBuilder: (context, i) => PostTile(posts[i]),
      ),
      GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2,
        ),
        itemCount: photos.length,
        itemBuilder: (context, i) => PhotoTile(photos[i]),
      ),
    ],
  ),
)
```

これは描画されますし、十数個のアイテムなら問題ありません。しかし `shrinkWrap: true` は、各スクロール可能ウィジェットに対して、有限の高さを報告できるように、最初のフレームですべての子を構築して測定することを強制します。Flutter のリストを滑らかに保つ遅延リサイクルを捨ててしまったのです。数百枚の写真のフィードでは、それは最初の描画の前に構築される数百個のウィジェットであり、タイムラインで観察できるスパイクになります（[Flutter アプリのジャンクを DevTools でプロファイルする方法](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) を参照）。さらに悪いことに、いまや 3 つのスクロールビュー（外側の `SingleChildScrollView` に加えて、`NeverScrollableScrollPhysics` で無効化しなければならなかった 2 つの内側のもの）が、そのうちの 1 つだけを実際にスクロールさせるためだけに存在しています。問題に対して間違った形なのです。

## sliver とは何か、1 段落で

sliver とは、親のビューポートに対して、自分自身のどれだけが現在表示されていて、どれだけを描画すべきかを直接伝えるスクロール可能な領域です。「これが私の全体の高さです、ウィンドウをください」ではなく、sliver は「あなたはオフセット X までスクロールしていて、高さ H のビューポートを持っているので、その範囲に入る子だけを正確にレイアウトします」と言います。このプロトコルこそが `SliverList` を遅延にするものです。sliver は自分の全体の高さを知る必要が決してないため、失敗するアンバウンドな高さのハンドシェイクもなく、画面外の子を構築する必要もありません。`CustomScrollView` は、これらの sliver のリストをホストし、それらすべてを 1 つの連続した面としてスクロールするビューポートです。すべてのセクションが sliver なので、それらは親の単一のスクロール位置を共有します。これがまさにあなたの求めていた挙動です。

## 動作するレイアウト: SliverList のあとに SliverGrid

これが全体です。ヘッダー、リストセクション、グリッドセクションが、1 つのスクロールの中にあります。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class FeedPage extends StatelessWidget {
  const FeedPage({super.key, required this.posts, required this.photos});

  final List<Post> posts;
  final List<Photo> photos;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: CustomScrollView(
        slivers: [
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Text('Latest posts',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            ),
          ),
          SliverList.builder(
            itemCount: posts.length,
            itemBuilder: (context, index) => PostTile(posts[index]),
          ),
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Text('Photos',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            ),
          ),
          SliverGrid.builder(
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              childAspectRatio: 1,
            ),
            itemCount: photos.length,
            itemBuilder: (context, index) => PhotoTile(photos[index]),
          ),
        ],
      ),
    );
  }
}
```

スクロールすると、リストが 1 つの面としてグリッドへ流れ込みます。両方のセクションが遅延です。投稿や写真がいくつあろうと、ビューポート内のタイル（それに小さなキャッシュ）だけが構築されます。スクロール位置は 1 つなので、リストで始めたフリングは継ぎ目なくグリッドへと引き継がれます。

ここでは 3 つの sliver 型が仕事をしていて、それらはほとんどすべてのケースで使う 3 つです。

1. **`SliverToBoxAdapter`** は、任意の普通のボックスウィジェット（見出し、バナー、区切り線）を包んで、sliver リストの中に配置できるようにします。子を積極的に（eager に）構築するので、単一の小さなウィジェットには正しいですが、長いリストには間違っています。そのため `ListView` や大きな `Column` を中に入れてはいけません。遅延セクションの間に置く単発のウィジェットに使ってください。
2. **`SliverList.builder`** は遅延リストです。`ListView.builder` でおなじみの `itemCount` / `itemBuilder` の API と同じで、ビューポートだけがありません。囲んでいる `CustomScrollView` がいまやビューポートだからです。
3. **`SliverGrid.builder`** は遅延グリッドです。`GridView.builder` とまったく同じように、列を制御する `gridDelegate` を取ります。

## グリッドの列を制御する

`gridDelegate` は、グリッドの列数とタイルの間隔を決める場所です。2 つのデリゲートでほぼすべてのケースをカバーできます。

`SliverGridDelegateWithFixedCrossAxisCount` は列数を固定します。列数がデザイン上の決定である場合（「常に 3 列」）に使います。

```dart
// Flutter 3.x (tested 3.44)
gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
  crossAxisCount: 3,   // exactly 3 columns
  mainAxisSpacing: 8,  // vertical gap between rows
  crossAxisSpacing: 8, // horizontal gap between columns
  childAspectRatio: 1, // width / height of each tile; 1 = square
),
```

`SliverGridDelegateWithMaxCrossAxisExtent` は代わりに各タイルの幅に上限を設け、利用可能な幅から列数を Flutter に計算させます。これがレスポンシブな選択です。`LayoutBuilder` なしで、スマートフォンは 2 列、タブレットは 5 列になります。

```dart
// Flutter 3.x (tested 3.44)
gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
  maxCrossAxisExtent: 180, // each tile is at most 180px wide
  mainAxisSpacing: 8,
  crossAxisSpacing: 8,
  childAspectRatio: 1,
),
```

最もよくあるグリッドの悩みは、タイルが引き伸ばされたり押しつぶされたりして見えることで、その原因はほとんど常に `childAspectRatio` です。これは幅を高さで割ったものです。デフォルトは `1.0`（正方形）です。写真タイルが幅より高い場合は、比率を 1 未満に下げます（たとえば 3:4 の縦長カードなら `0.75`）。幅の方が広い場合は 1 より上に押し上げます。`childAspectRatio` の不一致は例外を投げず、ただ静かにすべてのタイルを歪めるだけなので、デフォルトに任せるよりも意図的に設定する価値があります。

## 遅延構築を壊さずにパディングを追加する

sliver を普通の `Padding` ウィジェットで包むのは機能しません。`Padding` は sliver ではなくボックスの子を期待するからです。sliver に相当するものは `SliverPadding` です。

```dart
// Flutter 3.x (tested 3.44)
SliverPadding(
  padding: const EdgeInsets.symmetric(horizontal: 16),
  sliver: SliverGrid.builder(
    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
      crossAxisCount: 3,
      mainAxisSpacing: 8,
      crossAxisSpacing: 8,
    ),
    itemCount: photos.length,
    itemBuilder: (context, index) => PhotoTile(photos[index]),
  ),
)
```

`child:` ではなく `sliver:` パラメーターに注意してください。`SliverPadding` は sliver を内側にインセットしつつ、遅延のままです。セクションが画面の端から余白を必要とするときにはいつでもこれに手を伸ばしてください。`CustomScrollView` のボディ全体を 1 つの大きな `Padding` で包むと、グリッドのスペーシングの計算がクリップされてしまい、マージンを追加するレイヤーとして間違っています。

## 折りたたまれるスクロールヘッダー

すでに `CustomScrollView` を持っているので、スクロールに応じて展開・折りたたみされる `SliverAppBar` を追加するのはほとんど無料です。これが、そもそも人が sliver へ移行する古典的な理由です。

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverAppBar(
      title: Text('Explore'),
      floating: true,      // reappears as soon as you scroll up
      expandedHeight: 160,
      flexibleSpace: FlexibleSpaceBar(
        background: ColoredBox(color: Colors.indigo),
      ),
    ),
    SliverList.builder(
      itemCount: posts.length,
      itemBuilder: (context, i) => PostTile(posts[i]),
    ),
    SliverGrid.builder(
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
      ),
      itemCount: photos.length,
      itemBuilder: (context, i) => PhotoTile(photos[i]),
    ),
  ],
)
```

バーを上部に固定したままにするには `pinned: true` を、上方向へのスクロールがあればいつでも滑り戻ってくるようにするには `floating: true` を、そして大きい状態から小さい状態への折りたたみを得るには `flexibleSpace` を伴う `expandedHeight` を設定します。これらはいずれもスクロール可能ウィジェットを並べた普通の `Column` では不可能で、sliver に切り替える具体的な見返りです。

## 実際に噛みついてくる落とし穴

**sliver の中にスクロール可能ウィジェットをネストしないでください。** 全体の主旨は 1 つのビューポートです。`SliverToBoxAdapter` の中に `ListView` を入れると、アンバウンドな高さのエラーと 2 つ目のスクロール位置が再び持ち込まれます。垂直の `CustomScrollView` の中に水平にスクロールする行があるなら、それは問題ありません（軸が異なるので、`SizedBox` を包んだ `SliverToBoxAdapter` で固定の高さを与えます）。ですが、同じ軸のスクロール可能ウィジェットは決してネストしないでください。

**アイテムが並び替わるときはキーが重要です。** リストやグリッドのアイテムが挿入、削除、並び替えされうる場合、Flutter がリビルドをまたいで正しい状態を正しいウィジェットに対応付けられるように、各タイルにそのデータに紐づいた `ValueKey` を与えてください。キーがないと、削除された行がその状態を間違ったタイルに付けたまま残すことがあります。

**空セクションのケースに注意してください。** `itemCount: 0` の `SliverList` や `SliverGrid` は単に何も描画しません。それが望みどおりですが、「まだ写真がありません」というプレースホルダーも表示したい場合は、空のグリッドではなく `SliverToBoxAdapter` または `SliverFillRemaining` を使って表示してください。

**`SliverFillRemaining` は残りのビューポートを埋めます。** リストとグリッドを合わせても画面が埋まらず、フッターや空状態を表示領域の下部に固定したい場合、`SliverFillRemaining(hasScrollBody: false, child: ...)` は残りの高さをちょうど取ります。これは最後のセクション向けの、`Expanded` の sliver 版です。

**sliver をグループ化する。** リストとグリッドのペアを複数構築し、それぞれのペアを 1 つの単位として扱いたい場合（たとえば 1 つの背景を適用するため）、`SliverMainAxisGroup`（Flutter 3.16 以降）は子の sliver をスクロール軸に沿って積み重ねて、それらが 1 つの sliver として振る舞うようにします。単純なリストとグリッドではめったに必要ありませんが、セクションが内部構造を持つときにはこれが道具です。

## 普通の GridView や ListView がいまだに正しいとき

sliver は、セクションを 1 つのスクロールにまとめているときの答えです。単一のリストや単一のグリッドがあって、それと一緒にスクロールするものが他に何もないときには、やりすぎです。`Scaffold` のボディの中の単独の `GridView.builder` は、すでに遅延であり、すでにビューポートです。それを 1 つの `SliverGrid` を持つ `CustomScrollView` で包むのは、なんの利益もなく形式ばった手続きを増やすだけです。スクロール可能なセクションが 2 つ以上あるとき、折りたたまれるヘッダーがあるとき、あるいはコンテンツと一緒にスクロールして消えなければならないヘッダーがあるときに、sliver に手を伸ばしてください。それ以外のすべてでは普通のウィジェットで十分ですし、もし唯一の問題が単一のリストが `Column` に収まらないことだけなら、[アンバウンドな高さの記事](/ja/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) にある 4 つの修正の方が近道です。

もう 1 つ持っておく価値のある習慣があります。どのセクションかが `ScrollController` を使う場合（たとえば結合されたビューをあるセクションへジャンプさせるため）、それを個々の sliver ではなく `CustomScrollView` に接続し（sliver はコントローラーを取りません）、リークさせないように `State.dispose` の中で [それを破棄する](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) ようにしてください。そして、グリッド内のタイルがそのセルからあふれることがあれば、それはタイルの内部での [RenderFlex overflowed](/ja/2026/05/fix-renderflex-overflowed-in-flutter/) の警告として現れます。sliver の配線とは無関係で、タイルのレベルで修正します。

## 持っておくべきメンタルモデル

`CustomScrollView` は 1 つのビューポートです。その中に入れる各セクションは sliver であり、sliver はその単一のスクロール位置を共有しつつ、それぞれが遅延のままです。`SliverList` と `SliverGrid` は遅延のリストとグリッドで、`SliverToBoxAdapter` は単発のボックスウィジェットのための脱出口、`SliverPadding` はマージンを追加し、`SliverAppBar` はほとんど無料で得られる折りたたまれるヘッダーです。「2 つのスクロール可能ウィジェットを積み重ねる」と考えるのをやめて「sliver で作られた 1 つのスクロール」と考え始めれば、リストとグリッドを混ぜることはレイアウトエンジンとの戦いではなくなり、4 行の合成になります。

## 出典

- [CustomScrollView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- 1 つのビューポートで複数の sliver をホストする方法。SliverAppBar + SliverList + SliverGrid の例を含む。
- [SliverGrid class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverGrid-class.html) -- builder/count/extent のコンストラクターと 2 つのグリッドデリゲート。
- [SliverList class, Flutter API reference](https://api.flutter.dev/flutter/widgets/SliverList-class.html) -- 遅延リストの挙動と SliverFixedExtentList についての注記。
- [Using slivers to achieve fancy scrolling, Flutter docs](https://docs.flutter.dev/ui/layout/scrolling/slivers) -- sliver プロトコルと、ビューポートが描画範囲をどう交渉するか。
