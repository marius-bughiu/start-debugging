---
title: "Flutter で ListView を Column にネストして unbounded height エラーを出さない方法"
description: "Column の中の ListView が 'Vertical viewport was given unbounded height' を投げる理由と、どれを選ぶかを決めるパフォーマンスのトレードオフを含む 4 つの解決策（Expanded、Flexible、shrinkWrap、SizedBox）。"
pubDate: 2026-07-02
tags:
  - "flutter"
  - "dart"
  - "layout"
  - "listview"
  - "constraints"
lang: "ja"
translationOf: "2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error"
translatedBy: "claude"
translationDate: 2026-07-02
---

`ListView` を `Column` に直接入れると、Flutter は 1 ピクセルも描画する前にエラーを投げます: `Vertical viewport was given unbounded height`、通常はその後に `RenderBox` の診断が壁のように続きます。手短に言うと、`Column` は子に無制限の垂直方向のスペースを渡し、スクロール可能な `ListView` は無限の高さの中にレンダリングすることを拒否します。どれだけの高さになればよいのか見当がつかないからです。これはリストに制限された高さを与えることで直り、正しいツールはほぼ常に、リストが唯一のスクロール可能領域である場合は `Expanded`（残りのスペースを埋める）、リストが短くて有限である場合は `shrinkWrap: true` です。この記事ではエラーが起きる理由を説明し、最小限の再現を示し、Flutter 3.x（3.44 で検証）で 4 つの解決策すべてを順に見ていきます。例外を黙らせるだけのものではなく、適合するものを選べるようにするためです。

## なぜ Column は子に無制限の高さを与えるのか

Flutter のレイアウトは単一のルールで動きます: 制約は下へ、サイズは上へ。親は各子に占有してよい最小と最大の幅と高さを伝え、子はその範囲内でサイズを選び、親がそれを配置します。フレームワーク全体が、ツリーを下りながら繰り返されるこのやり取りです。

`Column` は垂直軸に沿って配置される `Flex` ウィジェットです。主軸（垂直）に沿っては、非フレキシブルな子に最大の高さを**課しません**。各子に対して実質的に「好きなだけ高くなってよい、後で積み重ねて合計を測る」と伝えます。制約の用語で言うと、子は `maxHeight: double.infinity` を受け取ります。これが「unbounded（無制限）」の意味です: 入ってくる高さの制約に有限の最大値がないのです。

ほとんどのウィジェットはそれで問題ありません。`Text`、`Row`、`Icon`、子を持つ `Container` はすべて内容に合わせてサイズが決まるので、無限の上限は決して問題になりません。それらは具体的な高さを返し、`Column` はそれを合計します。

`ListView` は違います。これはスクロール可能な viewport であり、viewport の仕事全体は、自分自身よりはるかに大きくなり得る内容に対する固定された窓であることです。そのためには窓がどれだけの高さかを知る必要があります。スクロール軸（垂直）に沿って、`ListView` は与えられた高さすべてを埋めるように広がろうとします。無限を与えれば無限に高くなろうとし、それはスクロールの目的を無意味にし、配置できません。そこでフレームワークは、壊れたレイアウトを黙って生成する代わりに、アサーションを投げます:

```
The following assertion was thrown during performResize():
Vertical viewport was given unbounded height.
Viewports expand in the scrolling direction to fill their container. In this
case, a vertical viewport was given an unlimited amount of vertical space in
which to expand.
```

はっきり言うと: `Column` は「好きなだけ高さを取れ」と言い、`ListView` は「どれだけの高さをもらえるか正確に教えてくれたときだけ動く」と言い、この 2 つは高さを解決するウィジェットを挿入するまで両立しません。これは [RenderBox was not laid out](/ja/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) と同じ系統の失敗で、サイズ制約の欠如が描画前にレイアウトを止めます。

## 最小限の再現

これを再現する最小のウィジェットです。特別なものは何もなく、リストの上に見出しを積んだだけです:

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class ProfilePage extends StatelessWidget {
  const ProfilePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const Text('Recent activity'),
        ListView(
          children: const [
            ListTile(title: Text('Item 1')),
            ListTile(title: Text('Item 2')),
            ListTile(title: Text('Item 3')),
          ],
        ),
      ],
    );
  }
}
```

これを実行すると、このサブツリーがレイアウトを行う瞬間に unbounded height のアサーションが出ます。`Column` は `ListView` に無限の高さを提供し、`ListView` は諦めました。以下はすべて、`ListView` が受け取る高さを変える方法です。

## 解決策 1: Expanded、リストが残りのスペースを埋めるべきとき

これはほとんどの場合に望む解決策です。`Expanded` は flex の子で、非フレキシブルな子が測定された後に残る垂直方向のスペースをすべて与えるよう `Column` に伝えます。「残りのスペースすべて」は `Column` が自身の高さを知れば具体的な数値なので、`ListView` は制限された `maxHeight` を受け取り、通常どおりレイアウトを行い、完全な遅延スクロールを維持します。

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    Expanded(
      child: ListView(
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
          ListTile(title: Text('Item 3')),
        ],
      ),
    ),
  ],
)
```

仕組み: `Expanded` は子の flex 係数を設定し、空きスペースにおける自分の取り分に等しいタイトな高さを強制します。`Column` はまず `Text` を測定し、それを自身の高さから引き、残りを `Expanded` に渡し、`Expanded` はそれを制限された制約として下に渡します。`ListView` はまさにその窓を埋め、その中で子をスクロールします。これは、リストが画面の主なスクロール可能領域で、利用可能な高さに応じて伸縮してほしいときには常に正しい選択で、それは圧倒的に一般的なケースです（フィードの上の見出し、結果の上のフォームフィールド、チャットログの上のタイトル）。

1 つの要件: `Expanded` が分割するものを持つには、`Column` 自身が制限された高さを持つ必要があります。`Scaffold` の body の中、高さを持つ `SizedBox` の中、あるいは垂直方向のスペースを既に制限している任意の親の中では、それを持っています。`Column` 自身が別の無制限のコンテキストの中にある場合、同じ問題を 1 レベル上へ押しやっただけであり、まず外側のボックスを制限する必要があります。

リストに残りのスペースを取らせつつ、内容が少ないときには取り分を下回って縮むことも許したい場合は、`Expanded` の代わりに `Flexible` を使います。`Expanded` は `fit: FlexFit.tight` の `Flexible` です。素の `Flexible` は `FlexFit.loose` を使い、これは「これくらいまで、ただし内容が必要とする以上ではない」を意味します。軸を埋めたい `ListView` にとっては、両者は実際には同じ動作をするので、緩さが重要な混在レイアウトでない限り `Expanded` に手を伸ばしてください。

## 解決策 2: shrinkWrap、リストが短くて有限のとき

リストの項目数が少なく、おおよそ分かっていて、その内容とちょうど同じ高さにしたい場合（`Column` がその下にさらにウィジェットを積めるように）、`shrinkWrap: true` を設定します:

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    ListView(
      shrinkWrap: true,
      children: const [
        ListTile(title: Text('Item 1')),
        ListTile(title: Text('Item 2')),
        ListTile(title: Text('Item 3')),
      ],
    ),
    const Text('End of list'),
  ],
)
```

`shrinkWrap: true` は viewport の動作を反転させます: 軸を埋めるように広がる代わりに、すべての子を測定し、その高さを合計し、その合計にサイズを合わせます。これで有限の高さを `Column` に上へ報告し、アサーションは消え、その上にも下にもウィジェットを配置できます。

コストは現実的で、理解する価値があります。通常の `ListView` は遅延的です: viewport に現在見えている項目と小さなキャッシュだけをビルドしレイアウトします。それが 10,000 行のリストを 60fps に保ちます。`shrinkWrap: true` はそれを捨てます。合計の高さを知るために、viewport は**すべての**子を前もってビルドし測定しなければならないからです。少数の項目ならそれは何でもありません。長い、あるいは無制限のリストでは、最初のフレームで何千ものウィジェットをビルドすることを意味し、レイアウト時間を跳ね上げ、タイムラインで観察できるジャンクを引き起こします（[DevTools で Flutter アプリのジャンクをプロファイルする方法](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)を参照）。`shrinkWrap` のリストは通常の意味で独立してスクロールもしません。収まるように伸び、`Column` 全体があふれると [RenderFlex overflowed](/ja/2026/05/fix-renderflex-overflowed-in-flutter/) の警告に逆戻りします。目安としては: `shrinkWrap` は短くて制限のあるリスト（数行の設定、固定メニュー）向けであり、フィード向けではありません。

`shrinkWrap` を使い、それでも全部合わせると高すぎるときに外側の `Column` をスクロールさせたい場合は、`Column` を `SingleChildScrollView` で包み、内側の `ListView` に `physics: const NeverScrollableScrollPhysics()` を設定して、2 つのスクロール可能領域が争わないようにします:

```dart
// Flutter 3.x (tested 3.44)
SingleChildScrollView(
  child: Column(
    children: [
      const Text('Recent activity'),
      ListView(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
        ],
      ),
    ],
  ),
)
```

## 解決策 3: SizedBox、正確な高さが分かっているとき

リストが画面の固定された一区画を占める場合は、具体的な高さを持つ `SizedBox` で包みます。これはエラーへの最も直接的な答えです: `ListView` はどれだけの高さになればよいか尋ね、あなたはそれに答えました。

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Recent activity'),
    SizedBox(
      height: 240,
      child: ListView(
        children: const [
          ListTile(title: Text('Item 1')),
          ListTile(title: Text('Item 2')),
          ListTile(title: Text('Item 3')),
        ],
      ),
    ),
  ],
)
```

`SizedBox` は `ListView` に `maxHeight: 240` を課し、`ListView` はその 240 の論理ピクセルを埋め、その中で内容を遅延的にスクロールし、`shrinkWrap` が手放すパフォーマンスの利点を維持します。これは水平カルーセル（垂直の `Column` の中の固定高さのカードの行）や、リストの高さが意図的な定数である任意のデザインに適しています。欠点はマジックナンバーです: ハードコードされた高さは異なる画面サイズやテキストスケール設定に適応しないので、残ったスペースを埋めるべきリストには避けてください。それには、`Expanded` が同じアイデアの適応版です。

## 解決策 4: Column を slivers を使う CustomScrollView に置き換える

「column」が実際にはたまたまリストを含むスクロールするページである場合、最もきれいな構造はネストされた `ListView` を持つ `Column` ではまったくありません。セクションが sliver である単一の `CustomScrollView` です。1 つの viewport、1 つのスクロール physics、完全な遅延性、ネストの衝突なし:

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverToBoxAdapter(
      child: Text('Recent activity'),
    ),
    SliverList.builder(
      itemCount: 3,
      itemBuilder: (context, index) => ListTile(
        title: Text('Item ${index + 1}'),
      ),
    ),
  ],
)
```

sliver はスクロール可能な領域で、どれだけ描画するかを親の viewport と直接交渉するので、失敗しうる「unbounded height」のやり取りはありません。`SliverToBoxAdapter` は通常のボックスウィジェット（あなたの見出し）を包み、`SliverList.builder` は遅延リストです。画面に複数の積み重なったスクロール可能セクションがある、スクロールで消えるべき見出しがある、あるいは 1 つの連続したスクロールにリストとグリッドがある場合に手を伸ばしてください。`Column` より冗長ですが、この形に対して Flutter が実際に望むレイアウトであり、正しさと遅延性のどちらかを選ばせることは決してありません。

## 実際にどの解決策を使うか

- **リストが見出しの下の主コンテンツで、画面を埋めるべき:** `Expanded`。遅延性を保ち、どんな高さにも適応します。
- **少数の固定項目で、同じ `Column` の中で上下にウィジェットを置きたい:** `shrinkWrap: true`。リストが短いので安価です。
- **リストに特定の固定高さが必要（カルーセル、ミニリスト）:** `SizedBox(height: ...)`。遅延性を保ち、明示的でシンプルです。
- **画面全体が複数のセクションを持つスクロール:** slivers を使う `CustomScrollView`。構造的に正しい答えです。

避けるべき罠は、最も短い差分だからと反射的に `shrinkWrap: true` に手を伸ばすことです。それは赤いエラーを消しますが、長いリストではうるさいレイアウトのアサーションを静かなパフォーマンスの後退と黙って取り替えます: すべての行が最初のフレームでビルドされ、読み込み時にフレームが落ち、メモリが viewport のサイズではなく項目数に応じてスケールします。リストが伸びうるなら、フレームワークが行のリサイクルを続けられるように `Expanded` か slivers を使ってください。関連するデバッグのメモは [Fix: RenderBox was not laid out](/ja/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) と [Fix: A RenderFlex overflowed](/ja/2026/05/fix-renderflex-overflowed-in-flutter/) にあり、これを組み立てている最中に次に遭遇する可能性が最も高い 2 つのエラーです。そしてリストが `ScrollController` を使う場合は、ウィジェットのアンマウント時にリークさせないよう[破棄する](/ja/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)ことを忘れないでください。

## 覚えておくべき一行のメンタルモデル

`Column` は無制限の高さを与え、`ListView` は制限された高さを要求します。上記のどの解決策も、「どれだけの高さか？」に答える別の方法にすぎません -- `Expanded` は「残り」と言い、`SizedBox` は「ちょうどこれ」と言い、`shrinkWrap` は「私の子と同じ高さ」と言い、slivers は「外側の viewport に決めさせる」と言います。エラーを「スクロール可能領域にその高さを伝え忘れた」と読めば、解決策は毎回明白です。

## 出典

- [Flutter ドキュメント: Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) -- 「制約は下へ、サイズは上へ」のモデルと、制限あり対無制限を決めるボックス。
- [ListView クラス、Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/ListView-class.html) -- `shrinkWrap`、viewport の動作、すべての子をビルドすることについてのパフォーマンスの注記。
- [Expanded クラス、Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- flex fit と、`Column` または `Row` で残りのスペースがどのように分割されるか。
- [CustomScrollView クラス、Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- 単一の viewport で slivers を組み合わせる。
