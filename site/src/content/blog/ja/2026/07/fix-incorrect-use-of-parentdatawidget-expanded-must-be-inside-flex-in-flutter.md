---
title: "修正: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets (Flutter)"
description: "このエラーは、Expanded または Flexible が Row、Column、Flex の直接の子でないことを意味します。flex ウィジェットの直下に移動するか、親が flex でないなら Expanded を外してください。"
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
lang: "ja"
translationOf: "2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-05
---

`Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets` は、`Expanded`（または `Flexible`）が `Row`、`Column`、`Flex` の直接の子ではないことを意味します。両者の間に別のウィジェット -- `Container`、`SizedBox`、`Padding`、`Center`、`Stack`、`Wrap` など -- が挟まっています。`Expanded` を flex の直接の子にするか、親が flex でないなら `Expanded` を完全に外すことで修正できます。Flutter 3.x（3.44）、Dart 3.x で確認しました。

## エラーの全体像

Flutter はこれを build フェーズ中に、レイアウトが実行される前のアサーションとしてスローします。短い要約行はみんなが検索するものですが、現行の Flutter の完全なメッセージは、どのウィジェットが誤っていて、それが何の中に誤ってネストされているかを正確に教えてくれます。

```
Incorrect use of ParentDataWidget.

The ParentDataWidget Expanded(flex: 1) wants to apply ParentData of type
FlexParentData to a RenderObject, which has been set up to accept ParentData of
incompatible type BoxParentData.

Usually, this means that the Expanded widget has the wrong ancestor
RenderObjectWidget. Typically, Expanded widgets are placed directly inside Flex
widgets.
The offending Expanded is currently placed inside a SizedBox widget.

The ownership chain for the RenderObject that received the incompatible parent data
was:
  SizedBox ← Expanded ← Column ← ...
```

2 つの行がすべての情報を担っています。"wants to apply ParentData of type `FlexParentData` to a RenderObject, which has been set up to accept ParentData of incompatible type `BoxParentData`" が型の不一致です。"The offending Expanded is currently placed inside a `SizedBox` widget" が誤った親をウィジェットの型で名指ししています。古い Flutter リリースでは、全体があなたがおそらく検索バーに打ち込んだ要約に縮約されます: `Expanded widgets must be placed inside Flex widgets`。

## なぜ Flex の親が推奨ではなく必須なのか

`Expanded` は何も描画しません。これは `ParentDataWidget` です。その唯一の仕事は、親の render object がその子をどう配置すべきかを知れるよう、子に設定の断片を付与することです。`Expanded` の場合、その設定は flex ファクターであり、`FlexParentData` 型のオブジェクトの中に存在します。

仕組みは次のとおりです。`Row`、`Column`、`Flex` は `RenderFlex` に支えられています。`RenderFlex` が子を受け入れると、flex 値と fit を保持するための `FlexParentData` スロットをその子にセットアップします。`Expanded` は自身の親の render object まで上がり、`applyParentData` を呼び出して、そのスロットに `flex` と `fit` を書き込みます。`RenderFlex` はレイアウト中にそのスロットを読みます。flex ファクターを持つ子は、余った主軸方向のスペースを自分たちのファクターに比例して分け合います。このやり取りこそが `Expanded` が機能する唯一の理由です。

他のあらゆる render object は別の `ParentData` 型をセットアップします。`SizedBox`、`Container`、`Padding` は唯一の子に `BoxParentData` を与えます。`Stack` は子に `StackParentData` を与えます。`Wrap` は子に `WrapParentData` を与えます。そのいずれにも `flex` フィールドはなく、`FlexParentData` を `BoxParentData` のスロットに書き込むことはできません。そのため `Expanded` が flex でない親で `applyParentData` を試みると、フレームワークの `debugIsValidRenderObject` チェックが型の不一致を最初に捕らえてエラーをスローします。flex ファクターを黙って無視したり、後からレイアウト中にクラッシュしたりする代わりに、です。このメッセージはウィジェットの `debugTypicalAncestorWidgetDescription` から生成され、`Expanded` の場合それは "Flex widgets" です -- ここから "must be placed inside Flex widgets" という表現が来ています。

これは [RenderFlex のオーバーフロー](/ja/2026/05/fix-renderflex-overflowed-in-flutter/) とは別の失敗です。あちらは `Row` や `Column` がレイアウト時にスペースを使い果たしたときに起きます。こちらはもっと早く、build 時に発火し、型のエラーです。flex の設定に、正しく着地できる場所がないのです。

## 最小の再現

最小のバージョンは、単一の子を持つ任意のウィジェットにラップされた `Expanded` です。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
class Sidebar extends StatelessWidget {
  const Sidebar({super.key});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 200,
      child: Expanded(          // wrong: SizedBox is not a Flex
        child: ListView(
          children: const [Text('a'), Text('b')],
        ),
      ),
    );
  }
}
```

`SizedBox` は子に `BoxParentData` を与えます。`Expanded` は `FlexParentData` を書き込もうとします。build が失敗します。`SizedBox` を `Container`、`Padding`、`Center`、`Align`、`Card`、`Wrap`、`Stack` に置き換えても -- `Row`、`Column`、`Flex` でないもの何であれ -- 同一の失敗が現れます。

## 修正 1: Expanded を Row、Column、Flex の直接の子にする

flex の親が実際にあって、間に別のウィジェットが紛れ込んだ場合、修正は `Expanded` が flex の直下に来るよう並べ替えることです。これは圧倒的に多いケースです。誰かがスタイリングのために flex の子を `Padding` や `Container` でラップし、`Expanded` が間違った側に来てしまったのです。

誤り -- `Expanded` が `Padding` の中にあり、`Padding` は box です。

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Header'),
    Padding(
      padding: const EdgeInsets.all(8),
      child: Expanded(child: content),   // throws: parent is Padding
    ),
  ],
)
```

正しい -- `Expanded` が `Column` の直接の子であり、`Padding` はその中に入ります。

```dart
// Flutter 3.x (tested 3.44)
Column(
  children: [
    const Text('Header'),
    Expanded(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: content,
      ),
    ),
  ],
)
```

身につけるべきルール: `Expanded` は `children` リストのそのスロットで最も外側のウィジェットでなければなりません。装飾したい、余白を付けたい、サイズを与えたいものはすべて、その周りではなく `child` の中に入れます。

## 修正 2: 親がそもそも flex でないなら Expanded を外す

ウィジェットの上に `Row`、`Column`、`Flex` が本当にひとつもないなら、`Expanded` は間違ったツールであり、どれだけネストしても正当にはなりません。スペースを埋める別の方法が必要です。

- **親の幅または高さを埋めるには**、子を直接サイズ指定します。`SizedBox(width: double.infinity)`、`SizedBox.expand`、または `Container` の制約で `double.infinity` を使います。

```dart
// Flutter 3.x (tested 3.44)
// Was: Container(child: Expanded(child: button))  -- illegal
SizedBox(
  width: double.infinity,
  child: button,
)
```

- **親の一部分を埋めるには**、`FractionallySizedBox` を使います。

```dart
// Flutter 3.x (tested 3.44)
FractionallySizedBox(
  widthFactor: 0.5,
  child: button,
)
```

- **本当は比例配分が欲しかった場合**、正しい理由で `Expanded` に手を伸ばしたものの、flex の親を忘れています。ひとつ導入しましょう。グループを `Row` や `Column` でラップし、`Expanded` の子をその直下に置きます。

```dart
// Flutter 3.x (tested 3.44)
Row(
  children: [
    Expanded(flex: 2, child: leftPane),
    Expanded(flex: 1, child: rightPane),
  ],
)
```

意図で選びましょう。子が常にひとつだけなら、flex はまったく不要です -- box にサイズを与えてください。兄弟間でスペースを分割しているなら、本物の flex の親が必要です。

## 修正 3: 経路に隠れた RenderObjectWidget に注意する

`Expanded` の契約は「Column の下のどこか」よりも厳しいものです。ドキュメントは、`Expanded` から上にたどってそれを囲む `Row`、`Column`、`Flex` までの経路には `StatelessWidget` か `StatefulWidget` のみが含まれなければならない、と述べています。その経路に `RenderObjectWidget` が現れた瞬間、それが parent data を受け取る親となり、不一致がエラーをスローします。

これは 2 つの巧妙な形で噛みついてきます。

**特定のプロパティを持つ `Container` は render ウィジェットを挿入します。** `Container` は合成物です。`padding` を与えると子を `Padding` でラップし、`color` や `decoration` を与えると `DecoratedBox` を追加し、`alignment` を与えると `Align` を追加します。したがって `Container(padding: ..., child: Expanded(...))` は、あなたが `Padding` と書いていなくても、`Padding`（`RenderObjectWidget`）をあなたの `Expanded` の直上に置きます。これは修正 1 の再現が姿を変えたものです。

**経路上のあなた自身の `RenderObjectWidget`。** 子が `Column` に届く前にそれらをラップする独自の render ウィジェットがあるなら、同じルールが適用されます。独自の `StatelessWidget` と `StatefulWidget` のラッパーは問題ありません。独自の `RenderObjectWidget` はだめです。

要点: `Flex` が祖先であるだけでは不十分です。`Expanded` は単純な合成ウィジェットだけを通じてそれに到達しなければなりません。

## 落とし穴とよく似たケース

**`flex: 0` でもエラーはスローされます。** `Expanded(flex: 0)` はフレームワークが見逃してくれる no-op だと考えたくなります。そうではありません。parent data の型チェックは flex の値に関係なく走るので、`Wrap` の中の `Expanded(flex: 0)` はまったく同じエラーで失敗し、`WrapParentData` を非互換の型として名指しします。これは [flutter/flutter の issue 154950](https://github.com/flutter/flutter/issues/154950) で意図された挙動として確認されています。固定幅で `Wrap` に参加する子が欲しいなら、`Expanded` ではなく `SizedBox` を与えてください。

**`Flexible` も同一のルールを持ちます。** `Expanded` は単に `fit: FlexFit.tight` の `Flexible` です。`Flexible` も `ParentDataWidget<FlexParentData>` なので、`Flexible` を flex でない親の中に置くと、同じ "Flexible widgets must be placed inside Flex widgets" エラーをスローします。`Expanded` を `Flexible` に置き換えてもこのエラーは決して直りません -- メッセージ中のウィジェット名が変わるだけです。

**`Stack` の外の `Positioned` も同じ形のバグです。** `Incorrect use of ParentDataWidget. Positioned widgets must be placed directly inside Stack widgets` を見たら、それは型が違うだけでまったく同じ仕組みです。`Positioned` は `StackParentData` を書き込み、親として `Stack`（`RenderStack` に支えられている）を必要とします。修正のパターンは同一です -- それを `Stack` の直接の子にするか、位置指定を使わないレイアウトを使ってください。

**トップレベルで `Expanded` を生む条件式や spread。** ヘルパー、`...[]` の spread、三項演算子で子を組み立てると、テストしていない分岐が選ばれたときに、うっかり `Expanded` を flex でない親に渡してしまうことがあります。エラーは実行時の親を名指しするので、ソースコードの一見の見た目よりも "currently placed inside a X widget" を信用してください。

**このエラーは debug ビルドでのみアサートされます。** `debugIsValidRenderObject` チェックは debug モードのアサーションです。release ビルドではアサーションはコンパイル時に除去され、flex データは黙って捨てられ、クラッシュの代わりに微妙に誤ったレイアウトになります -- こちらのほうが診断しにくいのです。出荷前に必ず debug で解決してください。「見た目は問題ない」release ビルドが正しいと決めつけないでください。

## 関連

- [修正: Flutter で A RenderFlex overflowed](/ja/2026/05/fix-renderflex-overflowed-in-flutter/)：もう 1 つの `Row`／`Column` エラーで、flex の子が存在する以上のスペースを要求したときにレイアウト時にスローされます。
- [修正: Flutter で RenderBox was not laid out](/ja/2026/06/fix-renderbox-was-not-laid-out-in-flutter/)：同じスクロールと flex の配管でしばしば出会う、レイアウト時のアサーション。
- [修正: Flutter の CustomScrollView で A RenderViewport expected a RenderSliver](/ja/2026/07/fix-renderviewport-expected-a-rendersliver-in-a-flutter-customscrollview/)：同じ「間違ったプロトコル」の考え方ですが、flex 対 box の parent data ではなく sliver 対 box についてのものです。
- [無制限の高さエラーなしで ListView を Column の中にネストする方法](/ja/2026/07/how-to-nest-a-listview-inside-a-column-in-flutter-without-an-unbounded-height-error/)：`Column` の中で `ListView` に有界の高さを与える、`Expanded` が正しい答えとなる場面。

## 参照元

- [Expanded クラス、Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/Expanded-class.html)：`Expanded` は `Row`、`Column`、`Flex` の子孫でなければならず、経路には Stateless／Stateful ウィジェットのみが許されると述べています。
- [ParentDataWidget クラス、Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/ParentDataWidget-class.html)：`applyParentData`、`debugTypicalAncestorWidgetDescription`、およびこのメッセージを生成する妥当性チェック。
- [Flexible クラス、Flutter API リファレンス](https://api.flutter.dev/flutter/widgets/Flexible-class.html)：`Expanded` の基底クラスで、同じ flex の親の要件に従います。
- [flutter/flutter の issue 154950](https://github.com/flutter/flutter/issues/154950)：flex でない親の中の `Expanded(flex: 0)` に対して、エラーが設計上いまだ発火することを確認しています。
