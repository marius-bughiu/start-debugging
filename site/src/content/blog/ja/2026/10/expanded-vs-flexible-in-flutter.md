---
title: "Flutter の Expanded と Flexible の違い: FlexFit.tight と FlexFit.loose を解説"
description: "子ウィジェットが Row や Column 内の自分の割り当て分を埋める必要があるなら Expanded、割り当て分より小さくてもよいなら Flexible を使います。Flutter 3.44 での実測レイアウトで、余った領域の行き先、loose な子が兄弟に領域を譲らない理由、無制限の制約下で Flexible だけが使える場面を確認します。"
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "flutter"
  - "dart"
  - "layout"
  - "constraints"
lang: "ja"
translationOf: "2026/10/expanded-vs-flexible-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-22
---

**結論:** `Expanded` は文字どおり `Flexible(fit: FlexFit.tight)` です。子が `Row` や `Column` 内の自分の割り当て分を埋める必要がある場合(リスト、パネル、背景を持つもの全般)は `Expanded` を使います。子が割り当て分より小さくてもよい場合は `Flexible`(デフォルトの `FlexFit.loose`)を使います。典型例は、長いときは省略表示され、短いときは内容に合わせて縮む `Text` です。どちらも最大サイズは同じで、子をそのサイズに強制するのは `Expanded` だけです。以下はすべて Flutter 3.44.8 / Dart 3.12.2 の `flutter test` で計測した結果です。

混乱するのも無理はありません。最も一般的なレイアウトでは、2 つは同じに見えるからです。子を持たない `ListView` や `Container` は使えるだけ領域を取ろうとするため、どちらのウィジェットで包んでも同じピクセルになります。違いが現れるのは、子が小さいままでよいときだけです。そしてまさにそこで、引き伸ばされたチップ、行の端に追いやられたアイコン、原因のわからない隙間が発生します。

## 比較の一覧

| 挙動 (Flutter 3.44)                                         | `Expanded`                         | `Flexible` (デフォルト)                |
| ----------------------------------------------------------- | ---------------------------------- | -------------------------------------- |
| フィット                                                    | `FlexFit.tight`                    | `FlexFit.loose`                        |
| 主軸に渡される制約                                          | min = max = 割り当て分             | min = 0, max = 割り当て分              |
| 子が割り当て分より小さい場合                                | 割り当て分まで引き伸ばされる       | 自身のサイズを保つ                     |
| 割り当て分の未使用部分                                      | なし                               | 空き領域になり、兄弟には渡されない     |
| `mainAxisAlignment` が効くか                                | 効かない (空き領域が残らない)      | 効く                                   |
| `Row(mainAxisSize: MainAxisSize.min)` が縮むか              | 縮まない。行が全幅を取る           | 縮む                                   |
| 主軸が無制限の場合 (スクロールビュー内)                     | 常にアサーションエラー             | `mainAxisSize: MainAxisSize.min` なら可 |
| `fit` を設定できるか                                        | できない                           | できる                                 |

1 行だけ覚えるなら 3 行目です。tight は引き伸ばし、loose は引き伸ばしません。

## フレームワークが 2 種類のフィットで実際に行うこと

ソースは引用できるほど短いものです。3.44.8 の `packages/flutter/lib/src/widgets/basic.dart` は次のとおりです。

```dart
// Flutter 3.44.8, widgets/basic.dart
class Flexible extends ParentDataWidget<FlexParentData> {
  const Flexible({super.key, this.flex = 1, this.fit = FlexFit.loose, required super.child});
  // ...
}

class Expanded extends Flexible {
  const Expanded({super.key, super.flex, required super.child}) : super(fit: FlexFit.tight);
}
```

どちらのウィジェットもレイアウトは行いません。`flex` と `fit` を子の `FlexParentData` に書き込む `ParentDataWidget` であり、それをレイアウト時に読み取るのが `RenderFlex` (`Row`、`Column`、`Flex` の背後にあるレンダーオブジェクト) です。flex ではない親の下に置くと、どちらも同じ "must be placed inside Flex widgets" エラーになるのもこのためです。

`rendering/flex.dart` の `RenderFlex._computeSizes` は 2 パスで動作します。

1. `flex == 0` のすべての子 (通常のウィジェット) を本来のサイズでレイアウトし、主軸方向の長さを合計します。
2. `spacePerFlex = (maxMainSize - usedByNonFlexChildren) / totalFlex` を**一度だけ**計算し、各 flex の子を最大 `spacePerFlex * flex` でレイアウトします。`FlexFit.tight` では最小値が最大値と等しくなります。`FlexFit.loose` では最小値は `0` です。

重要なのは"一度だけ"という点です。割り当て分は、どの flexible な子が測定されるよりも前に決まります。loose な子が割り当て分より少ない領域しか使わなくても、残りは兄弟に渡されません。その分は `mainAxisAlignment` のための空き領域になり、これが"なぜ隙間があるのか"という疑問の大半の原因です。

## 実測: 同じ子を 2 つのフィットで比較

以下の数値はすべて、`Row` を 400 論理ピクセル幅のボックスに固定し、`tester.getSize` と `tester.getTopLeft` で読み取ったウィジェットテストの結果です。テストハーネスと最初のケースは次のとおりです。

```dart
// Flutter 3.44.8, Dart 3.12.2, flutter_test
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(Widget child) => Directionality(
      textDirection: TextDirection.ltr,
      child: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(width: 400, height: 100, child: child),
      ),
    );

const a = Key('a'), b = Key('b');

void main() {
  testWidgets('tight vs loose with a small child', (t) async {
    await t.pumpWidget(host(Row(children: [
      Expanded(child: SizedBox(key: a, width: 50, height: 10)),
      Flexible(child: SizedBox(key: b, width: 50, height: 10)),
    ])));
    print('Expanded=${t.getSize(find.byKey(a))} '
        'Flexible=${t.getSize(find.byKey(b))}');
  });
}
```

出力: `Expanded=Size(200.0, 10.0) Flexible=Size(50.0, 10.0)`。どちらの子にも 200 ピクセルが提示されました (400 を合計 flex 2 で分割)。`Expanded` の下の `SizedBox(width: 50)` は tight な制約で上書きされ、幅 200 になりました。`Flexible` の下では 50 のままでした。`width: 50` はあくまで要求であり、親からの tight な制約が常に優先されます。

同じ 400 px の行での全プローブの結果は次のとおりです。

| レイアウト (Flutter 3.44.8)                                                    | 結果                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------- |
| `Expanded(SizedBox(w: 50))` + `Flexible(SizedBox(w: 50))`                      | 200 と 50                                           |
| `Flexible(SizedBox(w: 50))` + `Flexible(SizedBox(w: 1000))`                    | 50 と 200、末尾に 150 px の未使用領域               |
| `SizedBox(w: 100)` + `Expanded(flex: 2)` + `Flexible(flex: 1, SizedBox(w: 40))` | 200 と 40、60 px が未使用                          |
| `Flexible(fit: FlexFit.tight, SizedBox(w: 50))` + `SizedBox(w: 100)`           | 300、`Expanded` と同一                              |
| `Flexible(Container(color: ...))` + `SizedBox(w: 100)`                         | 300 x 100、loose フィットでも変化なし               |

2 行目が最も重要です。兄弟が 50 しか使わなくても、1000 ピクセルの子は 200 に制限されました。兄弟の未使用分 150 が再配分されることはないからです。"小さい方は必要な分だけ取り、大きい方が残りを取る"ようにしたいなら、小さい方は flexible にしてはいけません。通常の子にして、大きい方だけを `Expanded` にします。

最後の行は、多くの人が"Flexible と Expanded は同じもの"と結論づける理由を説明しています。子も幅も配置も持たない `Container` は、制約が許す最大サイズに自分を合わせます。loose な最大値 300 を与えれば 300 になります。`ListView`、`TextField` (幅いっぱいに広がります)、その他デフォルトで広がるものも同様です。貪欲な子の場合、フィットの違いは見えません。

## Expanded を選ぶ場面

- **`Column` 内のスクロール可能なウィジェット。** `Column(children: [Header(), Expanded(child: ListView(...))])` が定番のレイアウトです。リストには有限の高さが必要で、スクロール範囲を正しくするために残りの高さちょうどであるべきです。これが [Column 内に ListView を置くガイド](/ja/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/)の最初の解決策であり、[長いリストで `shrinkWrap` よりこちらが優れている理由](/ja/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/)は、リストが子を遅延構築し続けられることです。
- **背景、枠線、ヒット領域を持つパネル。** 色付きのサイドバーとコンテンツ領域を 1:3 で分割する場合は、内容の大きさにかかわらず色が端から端まで届くよう、`Expanded(flex: 1)` と `Expanded(flex: 3)` を使います。
- **`Row` で作る比例グリッド。** 3 つのセルを次の行の 3 つのセルと揃えたい場合、tight フィットなら同じ幅が保証されます。loose フィットでは各行が内容に応じてずれます。
- **要素を離して配置する。** `Spacer()` は `Expanded(flex: flex, child: SizedBox.shrink())` です。プローブでは、`SizedBox(w: 50)`、`Spacer()`、`SizedBox(w: 50)` の組み合わせで 2 つ目のボックスが x = 350 に置かれ、右端にぴったり揃いました。

## Flexible を選ぶ場面

- **必要なときだけ省略表示するテキスト。** 実際のアプリで最も重要なケースです。ラベルの後にアイコンが続く例を比較します。

```dart
// Flutter 3.44.8: label that hugs its text but ellipsizes when long
Row(
  children: [
    Flexible(
      child: Text(
        userName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    ),
    const Icon(Icons.verified, size: 16),
  ],
)
```

`Scaffold` 内の 400 px の行で、`userName = 'Short'` として計測しました。`Flexible` ではテキスト幅は 71.25 px で、アイコンは x = 71.25、つまり名前のすぐ隣に置かれます。`Expanded` に替えるとテキスト幅は 376 px になり、アイコンは行の右端である x = 376 に追いやられます。長い名前の場合は、どちらの版もテキストを 376 px に制限して省略記号を表示するため、オーバーフローの対処は同じですが、短い場合に見た目が正しいのは `Flexible` だけです。黄色と黒の縞模様が原因でここに来た場合は、[RenderFlex overflowed のガイド](/ja/2026/05/fix-renderflex-overflowed-in-flutter/)でほかの原因を扱っています。

- **本来のサイズを保ちたいが、狭い画面や大きなアクセシビリティ用テキストでオーバーフローしてはならないチップ、バッジ、ボタン。** tight フィットではヒット領域が行全体に広がってしまいます。
- **`mainAxisAlignment` を機能させたい場合。** 50 px の loose な子を 2 つ置いて `MainAxisAlignment.spaceBetween` を指定すると、2 つ目の子は x = 350 に置かれます。`Expanded` の子が 2 つの場合、tight なレイアウトには分配すべき空き領域がゼロのため、配置指定は無視され、2 つ目は x = 200 に置かれます。
- **内容に合わせてサイズが決まる Row。** `Row(mainAxisSize: MainAxisSize.min, children: [Flexible(child: SizedBox(width: 50)), SizedBox(width: 20)])` の幅は 70 px と計測されました。同じ行を `Expanded` にすると全幅の 400 px になりました。tight な子は親が提示する領域をすべて消費するため、`MainAxisSize.min` が縮める余地が残らないからです。ラベルを包むはずのピル型コンテナを作るときに、これがつまずきの原因になります。

## 選択を決めてしまう落とし穴: 無制限の主軸

`Column` を `SingleChildScrollView` の中に (または `Row` を水平方向の `ListView` の中に) 置くと、flex は主軸に無限の制約を受け取ります。`RenderFlex` は無限大を分割できないため、`_computeSizes` で `canFlex = false` に設定し、すべての子を flex がないものとしてレイアウトします。

その後の動作はフィットによって異なります。デバッグ用のチェック `_debugCheckConstraints` は、子が 0 でない flex を持ち、**かつ** flex が `MainAxisSize.max` を使うか、子が `FlexFit.tight` の場合にエラーを投げます。

```dart
// Flutter 3.44.8: throws in debug
SingleChildScrollView(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Expanded(child: SizedBox(height: 50)),
    ],
  ),
)
// RenderFlex children have non-zero flex but incoming height constraints are unbounded.
```

```dart
// Flutter 3.44.8: lays out fine, child is 50 px tall
SingleChildScrollView(
  child: Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Flexible(child: SizedBox(height: 50)),
    ],
  ),
)
```

どちらもプローブで検証済みです。`Expanded` 版ではアサーションが発生し、`Flexible` 版では例外なく 10 x 50 の子がレイアウトされました。これは再利用可能なウィジェットにとって重要です。コンポーネントが自身の一部を `Expanded` で包んでいると、スクロール可能な Column には決して置けません。`Flexible` を使い、Column が `MainAxisSize.min` なら、うまく縮退します。親が有限なら伸縮し、無限なら本来のサイズを取ります。ただし、無制限の場合の `Flexible` は事実上何もしないため、その下にある貪欲な子 (`ListView`) は、やはり自身の "unbounded height" エラーを投げます。

## その他の落とし穴とバリエーション

**`flex: 0` はウィジェットの効果を無効にします。** `RenderFlex` は子を flexible として扱う前に `flex > 0` を確認します。`Flexible(flex: 0, ...)` は通常の子と同じようにレイアウトされます。`Spacer` は誤ってこうならないよう、`flex > 0` をアサートします。

**`Flexible(fit: FlexFit.tight)` と `Expanded` は交換可能です。** プローブでは同一のサイズになりました。可読性のために `Expanded` を優先し、明示的な `fit` は、たとえば `Flexible(fit: isCompact ? FlexFit.loose : FlexFit.tight, child: ...)` のように計算で決まる場合にだけ使ってください。

**交差軸には影響しません。** どちらのウィジェットも主軸だけを制約します。子に交差軸も埋めさせたい場合は、別の flex ウィジェットではなく、`Row` または `Column` の `crossAxisAlignment: CrossAxisAlignment.stretch` を使います。

**`spacing` が先に差し引かれます。** Flutter 3.27 以降、`Row` と `Column` には `spacing` パラメーターがあります。`_computeSizes` は分割の前に、使用済み領域を `spacing * (childCount - 1)` で初期化するため、隙間はどの flex の割り当て分が計算されるよりも先に差し引かれます。

**連鎖させないでください。** `Expanded(child: Flexible(...))` は、内側の親が flex ではないため ParentDataWidget エラーを投げます。原因となるラッパーの全一覧は、["Expanded widgets must be placed inside Flex widgets"の修正](/ja/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/)を参照してください。

## 推奨と、その背景

デフォルトは `Expanded` にします。実際のアプリの flexible な子の多くは、もともと領域をすべて欲しがるスクロール可能なウィジェット、パネル、フィールドであり、tight フィットなら空き領域に悩まされることなく、予測しやすく整ったレイアウトが得られます。

`Flexible` に切り替えるのは、次の 3 つの場合だけです。子に保ちたい本来のサイズがある場合 (アイコンの隣のテキスト、チップ)、`mainAxisAlignment` や `MainAxisSize.min` を機能させ続ける必要がある場合、またはスクロールビュー内に置かれる可能性のある再利用可能なウィジェットを書いている場合です。そして、2 つの兄弟に `Flexible` を付けて、小さい方が大きい方に領域を譲ってくれると期待していることに気づいたら、そこで立ち止まってください。小さい方を通常の子にし、大きい方を `Expanded` にします。`RenderFlex` は loose な子の未使用の割り当て分を決して再配分しないからです。

## 関連記事

- [Flutter で "A RenderFlex overflowed by N pixels" を修正する](/ja/2026/05/fix-renderflex-overflowed-in-flutter/): この 2 つの選択が修正そのものになるオーバーフローのケースを扱っています。
- [Column 内の ListView が unbounded-height エラーを投げる理由](/ja/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/): 有限にする 4 つの方法も紹介しています。
- [長いリストでの shrinkWrap、Expanded、スリバーの比較](/ja/2026/07/shrinkwrap-vs-expanded-vs-slivers-for-long-lists-in-flutter/): flexible な子がスクロール可能なウィジェットの場合の参考になります。
- ["Incorrect use of ParentDataWidget" の修正](/ja/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/): `Expanded` や `Flexible` が flex の直接の子ではない場合に参照してください。

## 参考資料

- [Flexible class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Flexible-class.html)
- [Expanded class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Expanded-class.html)
- [FlexFit enum, Flutter API reference](https://api.flutter.dev/flutter/rendering/FlexFit.html)
- [Spacer class, Flutter API reference](https://api.flutter.dev/flutter/widgets/Spacer-class.html)
- [RenderFlex source, flutter/flutter `rendering/flex.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/rendering/flex.dart)
- [Understanding constraints, Flutter docs](https://docs.flutter.dev/ui/layout/constraints)
