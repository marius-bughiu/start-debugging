---
title: "Flutter の長いリストにおける shrinkWrap vs Expanded vs sliver: どれを選ぶべきか"
description: "長いリストでは shrinkWrap を絶対に使わないでください。リストが唯一のスクロール要素なら Expanded を、他のセクションとスクロールを共有するなら sliver（CustomScrollView）を使います。その理由を、build 回数のベンチマークとともに解説します。"
pubDate: 2026-07-07
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "layout"
  - "listview"
  - "slivers"
lang: "ja"
translationOf: "2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-07
---

Flutter の長いリストでは、優劣ははっきりしています。リストがヘッダーの下にある唯一のスクロール要素なら `Expanded` を使い、リストが他のセクションとスクロールを共有した瞬間に sliver（つまり `CustomScrollView`）へ切り替えてください。長いリストで `shrinkWrap: true` に頼ることは絶対に避けてください。それは最も短い差分で layout エラーを黙らせますが、同時にリストに最初のフレームですべての要素を build させ、スクロールを 60fps に保つ遅延リサイクルを捨ててしまいます。この記事では、この3つを Flutter 3.x（3.44 で検証、Dart 3.x）で対決させ、機能マトリクス、正確なコストを示す build 回数のベンチマーク、そしてあなたの代わりに結論を決める唯一のポイントを示します。

この3つは、同じ widget の交換可能なつまみではありません。`Expanded` と `shrinkWrap` は「`Column` の中のこの `ListView` の高さはいくつか」に答える2つの方法であり、一方で sliver は `Column` プラス `ListView` という形そのものを置き換えます。この3つが衝突するのは、`Column` の中の `ListView` が `Vertical viewport was given unbounded height` を投げたときに人々が試す3つの答えだからです。もしそのアサーションでここにたどり着いたのなら、根本原因の完全な解説は [Column の中に ListView を unbounded-height エラーなしでネストする方法](/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/) にあります。この記事は、赤い画面が消えたあとにどの解決策を残すべきか、というより鋭い問いです。

## 機能マトリクス

| プロパティ                                | `shrinkWrap: true`   | `Expanded`             | Sliver（`CustomScrollView`） |
| ----------------------------------------- | -------------------- | ---------------------- | ---------------------------- |
| 表示中の要素だけを build（遅延）          | いいえ、すべて build | はい                   | はい                         |
| N 要素での最初のフレームのコスト          | O(N)                 | O(viewport)            | O(viewport)                  |
| メモリのスケール要因                      | 要素数               | viewport のサイズ      | viewport のサイズ            |
| 無制限 / 増え続けるリストで機能するか      | いいえ               | はい                   | はい                         |
| 親に有界の高さが必要か                    | いいえ               | はい（親が必要）       | はい（Scaffold が与える）    |
| 1つの中に複数のスクロール可能セクション    | 自分自身と競合       | リストは1つだけ        | はい、ネイティブ             |
| 折りたたみヘッダー（`SliverAppBar`）      | いいえ               | いいえ                 | はい                         |
| ボイラープレートの行数                    | 1                    | 3                      | セクションあたり ~6          |

まず上の3行を読んでください。ここに議論のすべてがあります。`shrinkWrap` は3つのうちコストが要素数とともに増える唯一のものであり、「長いリスト」はまさにそのコストが噛みつくケースです。

## なぜ shrinkWrap は O(N) で、他の2つはそうでないのか

通常の `ListView` は遅延 viewport です。ウィンドウ内に表示されている要素と小さなキャッシュ範囲だけを build してレイアウトし、スクロールに応じてそれらの widget をリサイクルします。10,000 行のリストを作っても、どの瞬間にも存在するのは約15行だけです。この遅延こそが Flutter リストのパフォーマンスのすべてです。

`shrinkWrap: true` はそれをオフにします。（軸を埋めるのではなく）内容に合わせて自分のサイズを決めるには、viewport は自分の合計の高さを知る必要があり、それを知る唯一の方法はすべての子を前もって build して測定することです。つまり `shrinkWrap` は遅延リストを積極的なリストに変えます。N 要素は最初のフレームで N 回の build 呼び出し、N 個の `RenderBox` レイアウト、そして N に比例するメモリを意味します。人々がよくそれを試す3行の設定画面では、それは何でもありません。フィードでは、タイムラインで見える最初のフレームの停止になります（[DevTools で Flutter アプリの jank をプロファイルする方法](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) を参照）。

`Expanded` はリストを遅延のまま保ちます。これは `Flex` の子で、`Column` が他の子を測定したあとに残ったスペースに等しいタイトな高さを強制します。`ListView` は有界の `maxHeight` を受け取り、そのウィンドウをちょうど埋め、その中で行をリサイクルします。コストは O(viewport) で、要素数に依存しません。

Sliver もリストを遅延のまま保ちますが、別の仕組みによってです。`SliverList` は自分の合計の高さを知る必要が一切ありません。親の viewport と直接交渉します（「あなたはオフセット X までスクロールしているので、その範囲の子を描画します」）。したがって unbounded-height のハンドシェイクは存在せず、画面外の子を build する理由もありません。コストは再び O(viewport) です。

## build 回数のベンチマーク

これを測る最もクリーンな方法は、（マシンによって変動する）ミリ秒ではなく、最初のフレームでの要素の build 回数です。これは決定論的で仕組みに基づいています。各要素にカウンターを仕込みます。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
int buildCount = 0;

Widget itemBuilder(BuildContext context, int index) {
  buildCount++;                 // increment on every item build
  return ListTile(title: Text('Row $index'));
}
```

5,000 要素のリストを3通りでレンダリングし、最初のフレームのあとに `buildCount` を読みます（`WidgetsBinding.instance.addPostFrameCallback`）。結果は僅差ではありません。

| 5,000 要素の layout                | 最初のフレームでの要素の build 回数 | スケール要因      |
| ---------------------------------- | ----------------------------------- | ----------------- |
| `ListView(shrinkWrap: true)`       | 5,000                               | 要素数            |
| `Expanded(child: ListView)`        | ~12 から 15                         | viewport のみ     |
| `SliverList`（`CustomScrollView` 内） | ~12 から 15                       | viewport のみ     |

遅延モードでの正確な数は行の高さとデフォルトの `cacheExtent`（viewport の各側の外側に 250 論理ピクセル）に依存しますが、形は固定です。`shrinkWrap` は 5,000 すべてを build し、他の2つは収まる分とキャッシュだけを build します。profile モードの Pixel 7 では、`shrinkWrap` の最初のフレームはその 5,000 個の tile を build するために 16ms の予算を大きく超え、一方 `Expanded` 版と sliver 版は最初のフレームを予算内でレンダリングし、スクロール中もそこにとどまりました。重要なのは比率です。約 5,000 回の build に対して約 15 回、リストが大きくなるたびに広がる差です。

これを自分で再現するには、debug ではなく profile モード（`flutter run --profile`）で実行してください。debug モードの計測はアサーションに支配され、代表的ではないためです。build 回数の比率はどのモードでも同一で、異なるのは実時間だけです。

## Expanded を選ぶべきとき

`Expanded` が正しい答えになるのは、リストが画面唯一のスクロール可能領域で、何らかの固定された chrome の下（または上）にあるときです。

- **フィードの上のヘッダー、Flutter 3.44 で検証。** `Column` の中にタイトルや検索バーがあり、その後リストが残りを埋めます。`Expanded` はリストに残りの高さすべてを与え、遅延のまま保ちます。
- **画面に合わせて伸縮するリスト。** `Expanded` は利用可能なスペースをコードにハードコードするのではなく分割するため、`SizedBox(height: ...)` と違って、リストはさまざまなデバイスの高さやテキストスケール設定に適応します。
- **正しさを保ちつつ最小のコードが欲しい。** 3行、新しい widget の語彙は不要、完全な遅延。1つのリストなら、これは sliver に頼るより優れています。

唯一の要件は、`Expanded` が分割する対象を持つために、`Column` 自体が有界の高さを持たなければならないことです。`Scaffold` の body の中ならそれはあります。もし `Column` 自体が無制限のコンテキストの中にあるなら、問題を1つ上の階層へ動かしただけです。

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const SearchBar(),
    Expanded(
      child: ListView.builder(       // stays lazy
        itemCount: items.length,
        itemBuilder: (context, i) => ItemTile(items[i]),
      ),
    ),
  ],
)
```

## Sliver を選ぶべきとき

長いリストが単独でないとき、つまり他のセクションとスクロールを共有するとき、あるいは画面にスクロールで消えていくヘッダーが必要なときは、sliver を使った `CustomScrollView` に頼ってください。

- **1つのスクロールの中に2つ以上のスクロール可能セクション**、たとえばリストがグリッドへ流れ込む場合。このケースは [sliver で ListView と GridView を1つのスクロールに混在させる方法](/2026/07/how-to-mix-a-listview-and-a-gridview-in-one-scroll-view-with-slivers-in-flutter/) で端から端まで扱っています。2つの `ListView` を `Column` に積んでその physics を無効にするのは、sliver が置き換えるために存在するアンチパターンです。
- **折りたたみ式またはフローティングのヘッダー。** すでに `CustomScrollView` があれば、`pinned`、`floating`、`expandedHeight` を持つ `SliverAppBar` はほぼ無料です。`Column` ベースの同等物は存在しません。
- **内容とともにスクロールで消えるべきヘッダー。** `SliverToBoxAdapter` は遅延セクションのあいだに単発の box widget を包み、自然にスクロールで消えるようにします。

```dart
// Flutter 3.x (tested 3.44)
CustomScrollView(
  slivers: [
    const SliverAppBar(title: Text('Explore'), floating: true),
    SliverList.builder(              // lazy, shares the one scroll position
      itemCount: items.length,
      itemBuilder: (context, i) => ItemTile(items[i]),
    ),
  ],
)
```

Sliver はより冗長で、セクションあたり3行ではなく約6行になります。この冗長さこそが、単独のリストでそれを使わない唯一の理由です。スクロール可能な要素がちょうど1つのときは、`Expanded` が少ない儀式で同じ遅延を与えてくれます。

## shrinkWrap が実際に問題ないとき

`shrinkWrap: true` はバグではなく、狭い正しい用途を持つ道具です。それは、要素数を自分で制御でき、同じ `Column` の中でその上下に他の widget を置けるように内容に合わせてサイズを決める必要がある、**短くて有界な**リストです。

- 固定された一握りの行を持つ設定画面。
- 既知の小さな選択肢の集合を持つドロップダウンやメニュー。
- N が小さく（1桁、せいぜい十数）、データではなく設計によって固定されている任意のリスト。

N が増え得るデータ（投稿、写真、検索結果、メッセージ）によって決まる瞬間、`shrinkWrap` は間違った道具です。そのコストがそのデータとともに増えるからです。スクロール可能な `Column` の中の短いリストにそれを使う場合は、内側のリストが外側の `SingleChildScrollView` とスクロールジェスチャーを取り合わないように、`physics: const NeverScrollableScrollPhysics()` も設定してください。

```dart
// Flutter 3.x (tested 3.44) -- fine ONLY because this list is short and fixed
Column(
  children: [
    const Text('Settings'),
    ListView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      children: const [
        SwitchListTile(title: Text('Notifications'), value: true, onChanged: null),
        SwitchListTile(title: Text('Dark mode'), value: false, onChanged: null),
      ],
    ),
  ],
)
```

## あなたの代わりに結論を決めるポイント

2つの制約が、好みを完全に上書きします。

**リストが際限なく増え得るなら、`shrinkWrap` は選択肢から外れます。** これは好みの問題でも、我慢できる数フレームの取りこぼしの問題でもありません。無制限の積極的な build は、正しさとメモリの問題です。build 時間もメモリもどちらも要素数とともにスケールするため、テストで20行なら問題ないリストが、本番で 2,000 になると最初のフレームを数百ミリ秒ロックし得ます。フレームワークは警告してくれません。`shrinkWrap` はあなたが頼んだことをそのままやっただけだからです。これは Flutter リストが静かに退行する最も一般的な経路です。

**スクロール可能なセクションが2つ以上あるなら、sliver が唯一のクリーンな答えです。** `Expanded` はちょうど1つのリストを扱います。`Column` の中の2つの `Expanded` リストは、高さを互いに2つの別々の scroll view に分割してしまい、それはほとんど望みではありません。リストプラスグリッド、リストプラスもう1つのリスト、あるいはリストと1つの面としてスクロールすべき任意のセクションを持った瞬間、`CustomScrollView` が構造的に正しい形であり、それ以外はすべて回避策です。

それ以外のすべて、画面への適応性、ボイラープレート、折りたたみヘッダーは、この2つの固い規則の中でのタイブレークです。

## 推奨、あらためて

長いリストでは、順位づけはこうです。**リストが他の何かとスクロールを共有するなら sliver、唯一のスクロール要素なら `Expanded`、そして `shrinkWrap` は決して使わない。** `shrinkWrap: true` は、`Column` の中で内容に合わせてサイズを決める必要のある短く固定されたリストのためだけに、道具箱に残しておいてください。落とし穴は、3つすべてが unbounded-height エラーを消してしまうことです。だから、大きな layout アサーションを、実データの下でしか現れないパフォーマンス退行と静かに引き換えるものを、うっかり出荷しやすいのです。この選択を「どうすればリストを遅延のまま保てるか」と読めば、答えは常に `Expanded` か sliver であり、決して `shrinkWrap` ではありません。

これらのいずれかの中で行が自分の幅をあふれた場合、それは tile レベルの別問題である [RenderFlex overflowed](/2026/05/fix-renderflex-overflowed-in-flutter/) であり、外側の layout の選択とは無関係です。そしてどの layout を選ぶにせよ、それが `ScrollController` を使うなら、widget がアンマウントされたときにリークしないよう [dispose すること](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) を忘れないでください。

## 出典

- [ListView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/ListView-class.html) -- `shrinkWrap`、viewport の挙動、そして shrink-wrap されたリストがすべての子を build するという明示的な注記。
- [Expanded class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html) -- flex fit と、`Column` が残りのスペースをどう分割するか。
- [CustomScrollView class, Flutter API reference](https://api.flutter.dev/flutter/widgets/CustomScrollView-class.html) -- 複数の sliver を1つの遅延 viewport にホストすること。
- [Using slivers to achieve fancy scrolling, Flutter docs](https://docs.flutter.dev/ui/layout/scrolling/slivers) -- sliver のプロトコルと、viewport が描画範囲をどう交渉するか。
- [Flutter docs: Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) -- 比較全体の背後にある有界 vs 無制限の高さのモデル。
