---
title: "解決策: Flutter の Container で Cannot provide both a color and a decoration"
description: "色を decoration の中に移動します。color と decoration を同じ Container に渡すのではなく、decoration: BoxDecoration(color: ...) を使います。"
pubDate: 2026-07-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "layout"
  - "container"
lang: "ja"
translationOf: "2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container"
translatedBy: "claude"
translationDate: 2026-07-05
---

一行での解決策は、`Container` の `color:` 引数を削除し、その色を `BoxDecoration` の中に `decoration: BoxDecoration(color: Colors.blue, ...)` として置くことです。このアサーションが発生するのは、`Container` の `color` パラメーターが `decoration: BoxDecoration(color: color)` の短縮形にすぎないためです。したがって両方を渡すと、ウィジェットに背景の定義が2つ競合して与えられることになり、Flutter はどちらが勝つのかを推測することを拒否します。

```text
Cannot provide both a color and a decoration
The color argument is just a shorthand for "decoration: BoxDecoration(color: color)".

'package:flutter/src/widgets/container.dart':
Failed assertion: line 273 pos 15: 'color == null || decoration == null'
```

この記事は Flutter 3.x（3.44 で検証）と Dart 3.x を対象に書かれています。`Container` のアサーションは 1.x の時代から同じ内容で読めるため、ここに書かれている内容は 3.x のライン全体にきれいに当てはまり、2.x まで遡って適用できます。このチェックは `package:flutter/src/widgets/container.dart` にあります。スタックトレースの行番号は SDK のバージョンによって数行ずれることがありますが、アサーションの式 `color == null || decoration == null` は安定しています。

## なぜ Container は color と decoration の併用を禁止するのか

`Container` は利便性のためのウィジェットです。それ自体は何も描画せず、渡された引数に基づいて、より単純なウィジェット（`Padding`、`DecoratedBox`、`ConstrainedBox`、`Transform` など）のスタックを組み立てます。`color` 引数は、その構成の中で最小の一片です。これを設定すると、`Container` は内部的に `BoxDecoration(color: color)` を持つ `DecoratedBox` を構築します。それが `color` の意味のすべてです。糖衣構文にすぎません。

`decoration` は、同じものの全機能版です。`BoxDecoration` は、背景色、境界線、角丸、グラデーション、影、背景画像を一度にすべて保持できます。`BoxDecoration` は既に自身の `color` フィールドを持っているため、トップレベルの `color` も渡せるようにすると、あいまいなウィジェットが生まれてしまいます。`Container` の色と `BoxDecoration` の色のどちらが描画されるのでしょうか。フレームワークは、勝者を黙って選ぶ（そしてコミュニティの半数に反対のルールを想定させる）代わりに、構築時にアサーションを発生させ、明示的であることを強制します。コンストラクターには単純な `assert(color == null || decoration == null, ...)` が含まれており、そのためこれはアサーションが実行されるデバッグビルドとプロファイルビルドでのみ発生します。

フレームワーク自身の言葉には、2つ目の、より微妙な理由もあります。`decoration` は背景色の上に描画できるのです。`DecorationImage` やグラデーションを持つ `BoxDecoration` はボックスの塗りつぶし全体にわたって描画するため、その下にある別個の `color` は、decoration の不透明度によって見えたり見えなかったりします。両方を1つの `BoxDecoration` にまとめることで、「なぜ色が表示されないのか」という類の混乱をまるごと取り除けます。

## それを引き起こす最小の再現コード

背景の塗りつぶしと境界線の両方が欲しい `Container` は、いずれもすぐにこれに突き当たります。これは典型的なケースです。自然な最初の試みが、塗りつぶしに `color`、境界線に `decoration` を使うことだからです。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: DecorationDemo()));

class DecorationDemo extends StatelessWidget {
  const DecorationDemo({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Container(
          width: 200,
          height: 120,
          // Both set at once -> assertion throws before the first frame.
          color: Colors.blue,
          decoration: BoxDecoration(
            border: Border.all(color: Colors.black, width: 2),
            borderRadius: BorderRadius.circular(12),
          ),
          child: const Center(child: Text('Card')),
        ),
      ),
    );
  }
}
```

実行すると、アプリは1フレームも描画しません。アサーションは `Container` のコンストラクター内で発生するため、エラーはレイアウトの後ではなく `build` が実行された時点で表面化します。このタイミングは有用な手がかりです。レイアウトのフェーズで起きる `RenderFlex overflowed` や `RenderBox was not laid out` とは異なり、これは構築時の契約違反です。

## 解決策、必要になる頻度の高い順

### 解決策1: 色を BoxDecoration の中に移動する

これはほぼ毎回正しい方法です。`decoration` を渡しているなら、`color` 引数を削除し、代わりに `BoxDecoration.color` を設定します。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  width: 200,
  height: 120,
  decoration: BoxDecoration(
    color: Colors.blue,               // was the top-level `color:`
    border: Border.all(color: Colors.black, width: 2),
    borderRadius: BorderRadius.circular(12),
  ),
  child: const Center(child: Text('Card')),
)
```

これで1つの `BoxDecoration` が見た目のすべて、すなわち塗りつぶし、境界線、角の半径を所有します。これがカード、チップ、バッジ、ボタンの背景に対して欲しい形です。境界線や角丸が必要になった時点で、どのみち `BoxDecoration` に行き着くからです。

### 解決策2: フラットな色だけが必要なら、color を残して decoration を削除する

角丸や境界線を追加するためだけに `decoration` を使ったのなら、それは意図的なものであり、解決策1が正解です。しかし `decoration` がコピー&ペーストで紛れ込んだだけで、本当に必要なのが境界線もグラデーションも半径もない単なる塗りつぶしなら、逆のことをします。トップレベルの `color` を残し、`decoration` を完全に削除します。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  width: 200,
  height: 120,
  color: Colors.blue,   // fine on its own; no decoration present
  child: const Center(child: Text('Card')),
)
```

`color` の短縮形は、フラットな塗りつぶしのケースでは非推奨でも忌避すべきものでもありません。単一の色を `BoxDecoration` で包むよりも読みやすく、内部では同じ `DecoratedBox` を生成します。追加機能の1つが必要なときにだけ、フルの `BoxDecoration` に手を伸ばしてください。

### 解決策3: 単純な色付きボックスには Container をやめる

`Container` にパディングがなく、サイズ以外の制約もなく、変換もなく、色の長方形だけが欲しいなら、`ColoredBox` の方が軽量なウィジェットであり、必須の `color` を取り decoration を取らないため、このあいまいさが決して起きません。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
const ColoredBox(
  color: Colors.blue,
  child: SizedBox(
    width: 200,
    height: 120,
    child: Center(child: Text('Card')),
  ),
)
```

`ColoredBox` は子が `const` のとき `const` にでき、Flutter がその再構築と再描画をスキップできます。これは多数の静的なタイルからなるリストにおいて、小さいながらも実際の利得です。境界線や半径を伴うものには、解決策1に戻ってください。`ColoredBox` はそれらを描画できません。

## 実際のコードでどこが問題になるのか

### 共有の decoration を展開してウィジェットにテーマを適用する

デザインシステムはしばしば共有の `BoxDecoration` を保持し、そのうえでインスタンスごとに色だけを上書きしようとします。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG: passes both the reused decoration AND a color override.
Container(
  color: theme.colorScheme.surfaceContainerHigh,
  decoration: cardDecoration, // already a BoxDecoration
  child: content,
)
```

既存の `BoxDecoration` の上にトップレベルの `color` を重ねることはできません。代わりに decoration に対して `copyWith` を使ってください。まさにそのためにあるものです。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
Container(
  decoration: cardDecoration.copyWith(
    color: theme.colorScheme.surfaceContainerHigh,
  ),
  child: content,
)
```

ここで Material 3 の `ColorScheme` から色を取り出しているなら、ロール（`surface`、`surfaceContainerHigh`、`primaryContainer`）はライトモードとダークモードの両方でのコントラストにとって重要です。どのロールに手を伸ばすべきかは [Material 3 の ColorScheme で Flutter アプリのアクセントカラーを設定する方法](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) を参照してください。

### AnimatedContainer にも全く同じルールがある

`AnimatedContainer` は `Container` のコンストラクター契約を共有するため、同一のアサーションがそこでも発生します。この罠はより厄介です。静的な `decoration` が境界線を提供する一方で、トップレベルの `color` を補間して色をアニメーションさせるからです。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG: AnimatedContainer with both color and decoration.
AnimatedContainer(
  duration: const Duration(milliseconds: 200),
  color: _selected ? Colors.blue : Colors.grey,
  decoration: BoxDecoration(border: Border.all()),
)
```

色を `BoxDecoration` の中でアニメーションさせれば、`AnimatedContainer` は境界線も含めて decoration 全体を補間してくれます。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
AnimatedContainer(
  duration: const Duration(milliseconds: 200),
  decoration: BoxDecoration(
    color: _selected ? Colors.blue : Colors.grey,
    border: Border.all(),
  ),
)
```

`BoxDecoration` は境界線と色が一緒にアニメーションするために必要な lerp を実装しています。2引数版には決してできないことです。

### 両方を設定したままにする条件分岐

最も厄介なバージョンは、問題なくコンパイルされ、一方の分岐でのみ発生します。誰かが境界線を条件付きで追加したものの、色を移動し忘れるのです。

```dart
// Flutter 3.x (tested 3.44), Dart 3.x
// WRONG on the highlighted branch only.
Container(
  color: Colors.white,
  decoration: isHighlighted
      ? BoxDecoration(border: Border.all(color: Colors.amber, width: 2))
      : null,
  child: child,
)
```

`isHighlighted` が false のとき `decoration` は `null` でありアサーションは通過するため、ユーザーが行をハイライトするまで、コードはどのスクリーンショットでも正しく見えます。色を両方の分岐に（あるいは条件付きの境界線とともに構築した1つの `BoxDecoration` に）押し込み、両方が非 null になる状態がないようにしてください。

## 大きなツリーの中でどの Container が原因かを見つける

アサーションのメッセージは、あなたのウィジェットではなく `container.dart` 内のファイルと行を示します。原因となっている `Container` を見つけるには次のようにします。

1. アサーションの下のスタックトレースを読みます。あなた自身のコード（`lib/` 配下のファイル）内の最初のフレームが、問題のある `Container` を作成した `build` メソッドです。ほとんどのバージョンで、Flutter は "The relevant error-causing widget was" に続けてあなたのウィジェットとそのソース位置を出力します。
2. `Container` がループ内や共有ビルダー内で構築されていてトレースが役に立たない場合は、`color:` と `decoration:` が近くに現れる箇所をプロジェクト全体で grep します。正規表現 `Container\([^)]*color:[^)]*decoration:` はほとんどの1行のケースを捕捉します。複数行のものは、共有のカードやタイルを手動で走査する必要があります。
3. これは構築時に発生するため、ホットリロードで即座に表面化します。境界線または decoration を追加して保存し、フレームが赤くなれば、画面上に正しいウィジェットがあります。

この構築時の挙動は、[RenderBox was not laid out](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) のようなレイアウトのアサーションとは正反対です。それらはレイアウトのパイプラインが実行されて初めて現れ、しばしば本当の原因からいくつも離れたウィジェットを指し示します。

## 落とし穴とよく似たエラー

- **`BoxDecoration.color` と `Container.color` の描画順序。** これらはすべてのケースで同一ではありません。`Container.color` は子の後ろに描画しますが、もし `decoration` が許されていればその後ろにも描画します。`BoxDecoration.color` は decoration の一部として描画され、それは `foregroundDecoration` の後ろに位置します。フラットな塗りつぶしなら結果は同じピクセルですが、`foregroundDecoration` も使う場合は重なり順が重要になります。
- **色付きの Container の上で `Ink` と `InkWell` のスプラッシュが消える。** `Container` に `color` を与えたうえで子を `InkWell` で包むと、波紋は `Container` の色の後ろに描画されて消えてしまいます。解決策は同じ動きです。`Container.color` を削除し、`decoration` を持つ `Ink` ウィジェットか、色を持つ `Material` を使い、インクのレイヤーが塗りつぶしの上に位置するようにします。
- **別のメッセージの `The following assertion was thrown building`。** エラーが color と decoration ではなく `Incorrect use of ParentDataWidget` に言及している場合、それは別のレイアウト契約のバグです。[Incorrect use of ParentDataWidget: Expanded は Flex の中に置く必要がある](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) を参照してください。
- **リリースビルドはこれを隠すだけで、直しはしません。** このチェックは `assert` なので、リリースビルドはそれを取り除き、コンストラクターが保存した方の引数を使って描画します。「リリースでは動く」という前提で出荷しないでください。それは偶然動いているだけで、次の SDK の更新でどちらの引数が勝つかが変わる可能性があります。
- **`DecoratedBox` は同じ概念のエラーを別の形で発生させます。** `DecoratedBox` には `color` 引数がまったくなく `decoration` だけなので、そこでこのアサーションに突き当たることはありません。`DecoratedBox` を使っていて色が欲しかったのなら、それは常に `BoxDecoration` に入れます。

## 関連記事

- [解決策: Flutter で A RenderFlex overflowed](/2026/05/fix-renderflex-overflowed-in-flutter/) は、カードや行のレイアウトを構築する際に初心者が最初に突き当たるもう1つのアサーションです。
- [解決策: Flutter で RenderBox was not laid out](/2026/06/fix-renderbox-was-not-laid-out-in-flutter/) は、この記事とは異なり本当の原因から離れた場所を指すレイアウト時のエラーを扱います。
- [解決策: Incorrect use of ParentDataWidget: Expanded は Flex の中に置く必要がある](/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/) は、認識しておく価値のある兄弟的な構築契約のアサーションです。
- [Material 3 の ColorScheme で Flutter アプリのアクセントカラーを設定する方法](/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/) は、どの `ColorScheme` のロールを `BoxDecoration.color` に供給すべきかを説明します。

## 出典

- [Container.new コンストラクター（Flutter API）](https://api.flutter.dev/flutter/widgets/Container/Container.html)。`color` の短縮形と「cannot provide both」のルールを文字どおり文書化しています。
- [BoxDecoration クラスリファレンス](https://api.flutter.dev/flutter/painting/BoxDecoration-class.html)。`color`、`border`、`borderRadius`、`gradient`、`boxShadow` を所有する decoration です。
- [flutter/flutter issue #119484](https://github.com/flutter/flutter/issues/119484)。エラーメッセージをより明確にできないかを議論しているトラッキング issue です。
- [flutter/flutter issue #31312](https://github.com/flutter/flutter/issues/31312)。`container.dart` からの正確なアサーションとスタックトレースを示す元の報告です。
