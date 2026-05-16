---
title: "修正: A RenderFlex overflowed by N pixels (Flutter)"
description: "30 秒でできる修正: あふれた子ウィジェットを Expanded または Flexible でラップします。その後、Row と Column が黙ってクリッピングしない理由、制約なしの constraints の意味、どのレイアウトにどの修正が合うかを残りで解説します。"
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "renderflex"
lang: "ja"
translationOf: "2026/05/fix-renderflex-overflowed-in-flutter"
translatedBy: "claude"
translationDate: 2026-05-16
---

一文で言う修正方法: 横幅 (または高さ) があふれた子ウィジェットを `Expanded` または `Flexible` でラップする、囲んでいる `Row` または `Column` に `mainAxisSize: MainAxisSize.min` を設定する、あるいは本当にスクロールさせたいコンテンツであれば全体を `SingleChildScrollView` でラップします。黄色と黒の縞模様はレンダリングのバグではなく、`Row`、`Column`、`Flex` の中にいる制約のない子が親が渡せる以上のスペースを要求した、と Flutter が知らせているサインです。

```text
A RenderFlex overflowed by 124 pixels on the right.

The overflowing RenderFlex has an orientation of Axis.horizontal.
The edge of the RenderFlex that is overflowing has been marked in the rendering
with a yellow and black striped pattern. This is usually caused by the contents
being too big for the RenderFlex.

The relevant error-causing widget was:
  Row  lib/widgets/profile_header.dart:42
```

本ガイドは Flutter 3.27.1、Dart 3.11、安定チャンネルで配布されている Material 3 ウィジェットを対象にしています。ここで紹介する内容は Flutter 3.10 以降、3.x 系列全体でそのまま適用できます。`Row`、`Column`、`Expanded`、`Flexible`、`Flex` のウィジェット API は何年も変わっていません。下層の `RenderFlex` は `package:flutter/src/rendering/flex.dart` にあり、アサーションはそこで投げられます。

## なぜ Row と Column は黙ってクリッピングしないのか

Flutter のレイアウトは 1 回のパスで行われます。各親は `BoxConstraints` オブジェクトを子に渡し、子はその制約を満たすサイズを選び、親が子を配置します。多くのウィジェットは子が選んだサイズをそのまま受け入れますが、`Row`、`Column`、下層の `Flex` ウィジェットは違います。まず非フレキシブルな子を本来のサイズでレイアウトし、その後で残りのスペースを `Expanded` と `Flexible` の子の間に分配します。非フレキシブルな子の合計が、親から flex に渡された主軸方向のスペースを超えていれば、分けるものは残らず、レイアウトは予算超過になります。

`RenderFlex` は黙ってあふれをクリッピングすることもできますが、それでは社内で最も小さい端末でしか出ないレイアウトのバグが見えなくなります。そこで Flutter は debug モードではアサーションを表示し、あふれている辺に縞模様の警告矩形を描画したうえでレンダリングを続けます。release モードでは縞は消えますが、レイアウトは依然として壊れたままです。テキストが切れたり、タップ領域が画面外に出たり、スクリーンリーダーが見えていないコンテンツを読み上げたりします。これは [Common Flutter errors のページ](https://docs.flutter.dev/testing/common-errors) に記載されており、[Flutter SDK の flex.dart](https://github.com/flutter/flutter/blob/3.27.1/packages/flutter/lib/src/rendering/flex.dart) 冒頭のコメントとも一致します。

## まっさらなアプリに貼り付けられる最小再現コード

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: OverflowDemo()));

class OverflowDemo extends StatelessWidget {
  const OverflowDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            const Icon(Icons.message),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Title', style: Theme.of(context).textTheme.headlineMedium),
                const Text(
                  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, '
                  'sed do eiusmod tempor incididunt ut labore et dolore '
                  'magna aliqua.',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
```

これが典型的なケースです。外側の `Row` は `Scaffold` から幅の制約を受けており、`Icon` と `SizedBox` は非フレキシブルで小さいですが、内側の `Column` も非フレキシブルで、段落全体を 1 行に並べたいだけの幅を要求する `Text` を抱えています。スマートフォンサイズのレイアウトで実行すると、右端であふれます。

## 正しい修正を選ぶ: Expanded、Flexible、スクロール可能のいずれか

正しい修正は 3 種類あり、互いに置き換え可能ではありません。

### 修正 1: 大食いの子を `Expanded` でラップする

子が主軸の残り全部を取るべき場合に使います。再現コードでは、大食いの子は `Column` です。

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    const Icon(Icons.message),
    const SizedBox(width: 8),
    Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('Title', style: Theme.of(context).textTheme.headlineMedium),
          const Text(
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit, '
            'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
          ),
        ],
      ),
    ),
  ],
)
```

`Expanded` は `Flexible` の `flex: 1`、`fit: FlexFit.tight` 版です。tight は「割り当てられたスペースをきっちり埋めなければならない」という意味です。`Row` の中ではこれにより内側の `Text` の幅が有限になり、テキストエンジンが複数行に折り返せるようになります。`Text` の本来の幅が `Row` の幅計算に逆流しなくなるので、あふれは消えます。

正解である確率が 8 割の修正です。行の先頭にアイコンがあって本文が続くケース、列の先頭にヘッダーがあってスクロール可能な本体が続くケースなどで使ってください。正式な仕様は [Expanded クラスのリファレンス](https://api.flutter.dev/flutter/widgets/Expanded-class.html) を参照してください。

### 修正 2: 自分の取り分より小さくてもよい子は `Flexible` でラップする

`Flexible` の `fit` はデフォルトで `FlexFit.loose`、すなわち「このスペースまで使ってよいが、使い切る必要はない」です。残りのスペースを比例配分で 2 つの子で分け合いたいが、いずれも割り当てを使い切る必要はない場合に使います。典型例は、行を半分ずつ占めるべき同等に重要な 2 つの `TextField` を横並びにする場合です。

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    Flexible(child: TextField(decoration: const InputDecoration(labelText: 'First'))),
    const SizedBox(width: 8),
    Flexible(child: TextField(decoration: const InputDecoration(labelText: 'Last'))),
  ],
)
```

ここで `Expanded` を使ってもフィールドは 50/50 で行を分けますが、一方が `TextField` でなく `Chip` だった場合、`Expanded` はチップのヒット領域を行幅いっぱいまで引き伸ばし、見た目が壊れます。`Flexible` でチップ本来の幅を保てば、見た目を保ったままあふれも解消できます。

経験則: `Expanded` は「残りを埋める」、`Flexible` は「残りまで伸びてよい」。両者を取り違えても普通はあふれにはならず、不格好に伸びたウィジェットになるだけです。

### 修正 3: 内容が本当に収まらないなら軸をスクロール可能にする

スマートフォンの画面に収めた `Column` の下端でのあふれは、ほとんどの場合「ユーザーがスクロールするはずの画面」というサインです。修正は `Expanded` ではなく、`Column` を `SingleChildScrollView` の中に入れる (もしくは `ListView` に置き換える) ことです。

```dart
// Flutter 3.27.1, Dart 3.11
Scaffold(
  body: SingleChildScrollView(
    padding: const EdgeInsets.all(16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final section in sections) SectionCard(section),
      ],
    ),
  ),
)
```

アイテム数が分かっていて、同種の子が並ぶ長いリストでは `ListView.builder` を選びましょう。画面に出ているアイテムだけを遅延構築します。`SingleChildScrollView` + `Column` は毎フレームすべての子を構築するので、8 行の設定画面なら問題ありませんが、1000 行のフィードでは破滅的です。[Flutter のスクロールに関するドキュメント](https://docs.flutter.dev/ui/layout/scrolling) がこの境界線を明確に示しています。

## 原因別: このエラーが忍び込む 4 つの経路

### 幅の制約がない `Row` の中の `Text` ウィジェット

最も多い原因で、上の再現コードと同じです。長い文字列、長い商品名、ローカライズした UI 文字列 (ドイツ語は英語より幅が広いことで有名です) は、開発者の手元では動いていた `Row` を壊します。`Row` の中にユーザー入力やローカライズされたテキストがある場合は、必ず `Expanded` または `Flexible` でラップしてください。折り返しではなく切り詰めたい場合は、`Text` ウィジェット自体に `overflow: TextOverflow.ellipsis` と `maxLines: 1` を追加します。

```dart
// Flutter 3.27.1, Dart 3.11
Row(
  children: [
    const Icon(Icons.person),
    const SizedBox(width: 8),
    Expanded(
      child: Text(
        user.fullName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    ),
  ],
)
```

### 主軸が無制限: `Column` の中の `Column`、`Row` の中の `Row`

`Column` が別の `Column` の子になっていると、内側の `Column` は無制限の高さを受け取ります。その中で「好きなだけ取りたい」と要求するものは無限大を受け取り、それに RenderFlex が文句を言います。修正は、内側の `Column` を `Expanded` でラップするか、`mainAxisSize: MainAxisSize.min` を設定したうえで全体をスクロール可能要素に入れることです。

`Row` の中の `Row`、`Column` の中の `ListView`、その他主軸が無制限になる組み合わせでも同じです。[Understanding constraints](https://docs.flutter.dev/ui/layout/constraints) を一度読めば、残りはもう驚きではなくなります。レイアウトシステム全体の土台である「constraints go down, sizes go up, parent sets position」のマントラが説明されています。同じ制約伝播はリサイズ嵐で発生する jank の原因でもあり、これは [Flutter アプリの jank を DevTools でプロファイルする方法](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) で取り上げています。

### SizedBox や Container でハードコードされた `width` や `height`

スマートフォン幅の `Row` の中の `SizedBox(width: 400)` は、右側に `400 - rowWidth + remaining children` ピクセル分あふれます。これは修正が `Expanded` ではなく「幅をハードコードしない」になる唯一のケースです。`Expanded`、`Flexible`、`FractionallySizedBox(widthFactor: 0.5)`、または `MediaQuery.sizeOf(context)` からサイズを計算するなど、適応するレイアウトを使ってください。

画像でも同じです。`width` の制約を渡さない `Image.network` は本来のサイズを返しますが、サーバー側のアセットなら 2000 ピクセルになることもあります。`Image` に有限の幅を与える (`Image.network(url, width: 64)`) か、`Expanded` でラップしてください。

### ローカライズ、フォントスケーリング、アクセシビリティ用テキストサイズ

デフォルトのフォントスケールでぴったり収まっていた `Row` も、テキストスケールが 1.4 倍や 2 倍になるとあふれます。これは App Store までたどり着いて、大きなフォントを有効にしたユーザーから星 1 つをもらうバグです。`MediaQuery` のオーバーライドで、アクセシビリティ向けのスケールで全画面をテストしてください。

```dart
// Flutter 3.27.1, Dart 3.11
MaterialApp(
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(1.5)),
    child: child!,
  ),
  home: const MyHomePage(),
)
```

`TextScaler` は Flutter 3.16 以降、古い `textScaleFactor` API を置き換えるもので、テキストスケーリングをテストする際の公式の方法です。この `MediaQuery` ラッパーの下でレイアウトがあふれるなら、実機でもあふれます。修正方法は同じで、`Expanded`、`Flexible`、またはスクロール可能化です。

## どのウィジェットがあふれているかをデバッグする

アサーションは常にウィジェット名とソース位置を示しますが、その位置はあふれた `Row` または `Column` を指しており、原因となった子を指してはいません。3 つのツールで絞り込みます。

1. debug モードの黄色と黒の縞は、あふれている辺 (右、下など) を教えてくれます。これだけでも探索範囲がかなり狭まります。
2. Flutter Inspector の "Debug Paint" をオンにします (`main` で `debugPaintSizeEnabled = true;` を設定しても同じ)。各 render box の輪郭が見えるので、大食いの子は親をはみ出していることが大抵見て取れます。
3. Inspector のウィジェット選択モードで、シミュレーター上の問題箇所をクリックします。選択されたウィジェットの `RenderObject` パネルにサイズと constraints が表示されるので、親と比較してください。

さらに踏み込みたい場合、パフォーマンス調査で使うのと同じ DevTools セッションの Layout Explorer タブでレイアウトをデバッグできます。この使い方に馴染みがない方は、[Flutter アプリの jank を DevTools でプロファイルする方法](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) で実機に対して profile モードで DevTools を開く手順を説明しています。

## 落とし穴と似たエラー

- `Vertical viewport was given unbounded height` は、`Expanded` のない `Column` の中に `ListView` を置いたときに出る兄弟エラーです。修正の形は同じです。子を制約するか、親をスクロール可能にしてください。`ListView` に `shrinkWrap: true` を設定して「直す」のは避けてください。遅延レンダリングが切れ、スクロール位置が深くなったところで元のあふれが再発します。
- `RenderBox was not laid out` は、`RenderFlex` のあふれアサーションが先に投げられ、レイアウトパイプラインが paint ジオメトリを計算するところまで到達できなかった、という意味です。エラーログをさかのぼって最初のあふれメッセージを探してください。真のバグはそこにあります。
- `Text` が投げる `BoxConstraints forces an infinite width` は、`Text` が主軸無制限の何か (典型例は水平 `ListView` の中の `Row`) の内側にあるという意味です。`Text` を固定幅のコンテナでラップするか、`Flexible` を使ってください。
- `A RenderFlex overflowed by Infinity pixels` は制約なし版です。修正は決して「数字を小さくする」ではなく、「親に有限の制約を与える」です。通常はもっと上の階層に `Expanded` を追加します。
- `Row` や `Column` に `clipBehavior: Clip.hardEdge` を付けて警告を消すと縞は消えますが、レイアウトのバグはそのままです。意図的なあふれ (たとえば意図的に切り取られたマーキー) を確認できたとき以外、クリッピングに頼らないでください。

## 関連

- [Flutter アプリの jank を DevTools でプロファイルする方法](/ja/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) では、最速のレイアウトデバッガでもある DevTools のセットアップを扱います。
- [Flutter アプリで Material 3 ColorScheme を使ってアクセントカラーを設定する方法](/ja/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) は、初心者がレイアウト時のあふれに最初にぶつかる場所です。M3 ウィジェットに切り替えると本来のサイズが変わるためです。
- [プラグインを使わずに Flutter にプラットフォーム固有コードを追加する方法](/ja/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) は、小さなフォームファクタで行を非表示にするようになってから関係してきます。
- [1 つの CI パイプラインから複数の Flutter バージョンをターゲットにする方法](/ja/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) は、SDK のバージョン間でテキストメトリクスが変わるとあふれメッセージの正確なピクセル数が変わるため、重要です。

## 出典

- [Common Flutter errors -- A RenderFlex overflowed](https://docs.flutter.dev/testing/common-errors)。Flutter 公式ドキュメントで、このエラーと標準的な修正方法を定義しているセクション。
- [Understanding constraints](https://docs.flutter.dev/ui/layout/constraints)。本記事のすべての flex レイアウト判断の背景にあるレイアウトプロトコルの説明。
- [Expanded クラスのリファレンス](https://api.flutter.dev/flutter/widgets/Expanded-class.html)。`Expanded` が `Flexible(flex: 1, fit: FlexFit.tight)` と定義されていることを示す API ドキュメント。
- [Flexible クラスのリファレンス](https://api.flutter.dev/flutter/widgets/Flexible-class.html)。`FlexFit.loose` と `FlexFit.tight` の違いを説明する API ドキュメント。
- [Row クラスのリファレンス](https://api.flutter.dev/flutter/widgets/Row-class.html) と [Column クラスのリファレンス](https://api.flutter.dev/flutter/widgets/Column-class.html)。主軸方向のサイジングアルゴリズムを逐語的に説明しています。
- [タグ 3.27.1 の flex.dart](https://github.com/flutter/flutter/blob/3.27.1/packages/flutter/lib/src/rendering/flex.dart)。あふれアサーションが投げられているソース。
