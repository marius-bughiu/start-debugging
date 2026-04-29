---
title: "Flutter Text: UI の \"呼吸\" を変える `leadingDistribution` という細部"
description: "Flutter の TextHeightBehavior にある leadingDistribution プロパティは、追加の leading をグリフの上下にどう分配するかを制御します。これが効いてくる場面と、テキストが縦方向にずれて見えるときの直し方を解説します。"
pubDate: 2026-01-18
tags:
  - "dart"
  - "flutter"
lang: "ja"
translationOf: "2026/01/flutter-text-the-leadingdistribution-detail-that-changes-how-your-ui-breathes"
translatedBy: "claude"
translationDate: 2026-04-29
---
2026-01-16 に公開された Flutter のチュートリアル動画を見て、地味だがとても現実的な "なぜこれは見栄えがおかしいのか?" 系のバグの原因を思い出しました: `Text` ウィジェットは、カスタムフォント、詰めた行高、複数行レイアウトを組み合わせ始めるまではシンプルです。

ソース: [動画](https://www.youtube.com/watch?v=xen-Al9H-4k) と、元の [r/FlutterDev の投稿](https://www.reddit.com/r/FlutterDev/comments/1qfhug1/how_well_do_you_really_know_the_text_widget/)。

## 行高は `TextStyle.height` だけではありません

Flutter 3.x では、開発者がよく次を調整します。

-   行を詰めたり緩めたりする `TextStyle(height: ...)`
-   leading の適用方法を制御する `TextHeightBehavior(...)`

`height` だけを指定しても、`Row` の中で縦方向に "中心がずれて" 見えるテキストになったり、本文に比べて見出しがやけに余白っぽく感じることがあります。ここで登場するのが `leadingDistribution` です。

`leadingDistribution` は、追加の leading (行高で加えられたスペース) をグリフの上下にどう分配するかを制御します。デフォルト値は、UI のタイポグラフィにとって常に望ましいものとは限りません。

## 違いを一目で分からせる小さなウィジェット

画面に貼って視覚的に比較できる、最小のスニペットがこちらです。

```dart
import 'package:flutter/material.dart';

class LeadingDistributionDemo extends StatelessWidget {
  const LeadingDistributionDemo({super.key});

  @override
  Widget build(BuildContext context) {
    const style = TextStyle(
      fontSize: 20,
      height: 1.1, // intentionally tight so leading behavior is visible
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: const [
        Text('Default leadingDistribution', style: style),
        SizedBox(height: 8),
        Text(
          'Even leadingDistribution\n(two lines to show it)',
          style: style,
          textHeightBehavior: TextHeightBehavior(
            leadingDistribution: TextLeadingDistribution.even,
          ),
        ),
      ],
    );
  }
}
```

2 つのブロックを並べて見ると、実際のフォントでは違いがすぐに分かることが多いです。アイコンと位置を揃える場面や、コンテナの高さを制限する場面では特に、片方のブロックのほうが縦の空間に "しっくり" 収まります。

## 実アプリでこれが効いてくる場所

この細部は、ピクセル単位で整え続けるのが特に難しい部分の Flutter アプリで顔を出しがちです。

-   **ボタンとチップ**: ラベルテキストがコンテナに対して低すぎたり高すぎたりして見えます。
-   **コンテンツが混在するカード**: 見出しと小見出しのスタックが、均等な間隔に感じられません。
-   **カスタムフォント**: ascent/descent の指標は書体によって大きく変わります。
-   **国際化**: 異なるグリフ指標を持つスクリプトが、暗黙の余白の前提をあぶり出します。

修正の方向性は "とにかく `leadingDistribution` を設定する" ではありません。修正の方向性は: タイポグラフィを整理するときに、`fontSize` と `height` だけでなく `TextHeightBehavior` も自分のメンタルモデルに含めることです。

Flutter 3.x の UI が 95 パーセントは仕上がっているのにどこかわずかに違和感が残るとき、これは私が最初に確認するノブのひとつです。
